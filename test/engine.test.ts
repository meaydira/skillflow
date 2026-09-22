import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWorkflow, lintWorkflow, WorkflowError } from '../src/workflow/load.js';
import { render } from '../src/workflow/template.js';
import { collectOutputs, stageInput, ArtifactError } from '../src/engine/artifacts.js';
import { prepareNode } from '../src/engine/handoff.js';
import { requestApproval, decideApproval, pendingApprovals, readApproval } from '../src/engine/approvals.js';
import { ResourceLock } from '../src/engine/locks.js';
import { Ledger } from '../src/engine/ledger.js';
import { nodeDir } from '../src/engine/paths.js';
import type { Artifact, NodeSpec } from '../src/types.js';

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'skillflow-test-'));
}

function writeWorkflow(dir: string, yaml: string): string {
  const file = join(dir, 'wf.yaml');
  writeFileSync(file, yaml, 'utf8');
  return file;
}

test('topological order respects dependencies', () => {
  const dir = sandbox();
  const file = writeWorkflow(
    dir,
    `
name: t
nodes:
  - id: c
    prompt: c
    needs: [a, b]
  - id: a
    prompt: a
  - id: b
    prompt: b
    needs: [a]
`,
  );
  const wf = loadWorkflow(file);
  assert.deepEqual(wf.order, ['a', 'b', 'c']);
  assert.equal(wf.waves.length, 3);
});

test('independent nodes land in the same wave', () => {
  const dir = sandbox();
  const wf = loadWorkflow(
    writeWorkflow(
      dir,
      `
name: t
nodes:
  - id: root
    prompt: r
  - id: left
    prompt: l
    needs: [root]
  - id: right
    prompt: r2
    needs: [root]
`,
    ),
  );
  assert.deepEqual(wf.waves[1].sort(), ['left', 'right']);
});

test('a dependency cycle is rejected rather than run', () => {
  const dir = sandbox();
  const file = writeWorkflow(
    dir,
    `
name: t
nodes:
  - id: a
    prompt: a
    needs: [b]
  - id: b
    prompt: b
    needs: [a]
`,
  );
  assert.throws(() => loadWorkflow(file), WorkflowError);
});

test('a reference to an undefined node is rejected', () => {
  const dir = sandbox();
  const file = writeWorkflow(dir, `name: t\nnodes:\n  - id: a\n    prompt: a\n    needs: [ghost]\n`);
  assert.throws(() => loadWorkflow(file), /needs "ghost"/);
});

test('lint flags an external write with no resource lock', () => {
  const dir = sandbox();
  const wf = loadWorkflow(
    writeWorkflow(dir, `name: t\nnodes:\n  - id: a\n    prompt: update salesforce deals\n`),
  );
  const warnings = lintWorkflow(wf);
  assert.ok(warnings.some((w) => /resources/.test(w.message)));
});

test('lint flags bypassPermissions without an approval gate', () => {
  const dir = sandbox();
  const wf = loadWorkflow(
    writeWorkflow(
      dir,
      `name: t\nnodes:\n  - id: a\n    prompt: do it\n    permissionMode: bypassPermissions\n`,
    ),
  );
  assert.ok(lintWorkflow(wf).some((w) => /bypassPermissions/.test(w.message)));
});

test('lint flags a cross-node reference that is not declared in needs', () => {
  const dir = sandbox();
  const wf = loadWorkflow(
    writeWorkflow(
      dir,
      `
name: t
nodes:
  - id: a
    prompt: a
    outputs:
      - name: thing
        kind: note
  - id: b
    prompt: "use \${{ nodes.a.outputs.thing }}"
`,
    ),
  );
  assert.ok(lintWorkflow(wf).some((w) => /does not list it in needs/.test(w.message)));
});

test('templates resolve inputs, run metadata and upstream artifacts', () => {
  const { out, unresolved } = render('${{ inputs.week }} / ${{ run.workflow }} / ${{ nodes.a.outputs.x.summary }}', {
    inputs: { week: '2026-W38' },
    run: { id: 'r1', date: '2026-09-21', workflow: 'wf' },
    env: {},
    nodes: { a: { outputs: { x: { summary: 'forty rows' } } } },
  });
  assert.equal(out, '2026-W38 / wf / forty rows');
  assert.deepEqual(unresolved, []);
});

test('an unknown template path is reported rather than silently dropped', () => {
  const { unresolved } = render('${{ inputs.nope }}', {
    inputs: {},
    run: { id: 'r', date: 'd', workflow: 'w' },
    env: {},
    nodes: {},
  });
  assert.deepEqual(unresolved, ['inputs.nope']);
});

function seedManifest(base: string, runId: string, nodeId: string, manifest: unknown): void {
  const out = join(nodeDir(base, runId, nodeId), 'outputs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

test('a missing required output fails the node', () => {
  const base = sandbox();
  seedManifest(base, 'r1', 'n1', { artifacts: [] });
  assert.throws(
    () => collectOutputs(base, 'r1', 'n1', [{ name: 'deals', kind: 'records', required: true }]),
    /did not emit required output/,
  );
});

test('a node that declares outputs but writes no manifest fails', () => {
  const base = sandbox();
  mkdirSync(join(nodeDir(base, 'r1', 'n1'), 'outputs'), { recursive: true });
  assert.throws(
    () => collectOutputs(base, 'r1', 'n1', [{ name: 'deals', kind: 'records' }]),
    /wrote no outputs\/manifest.json/,
  );
});

test('an artifact emitted with the wrong kind fails', () => {
  const base = sandbox();
  seedManifest(base, 'r1', 'n1', {
    artifacts: [{ name: 'deals', kind: 'note', summary: 's' }],
  });
  assert.throws(
    () => collectOutputs(base, 'r1', 'n1', [{ name: 'deals', kind: 'records' }]),
    /declared output "deals" as records but emitted note/,
  );
});

test('a document artifact with no files fails', () => {
  const base = sandbox();
  seedManifest(base, 'r1', 'n1', {
    artifacts: [{ name: 'deck', kind: 'document', summary: 's', files: [] }],
  });
  assert.throws(() => collectOutputs(base, 'r1', 'n1', [{ name: 'deck', kind: 'document' }]), /with no files/);
});

test('a file outside the run directory is refused', () => {
  const base = sandbox();
  seedManifest(base, 'r1', 'n1', {
    artifacts: [{ name: 'deck', kind: 'document', summary: 's', files: ['/etc/hosts'] }],
  });
  assert.throws(() => collectOutputs(base, 'r1', 'n1', [{ name: 'deck', kind: 'document' }]), /outside the run directory/);
});

test('a valid manifest produces artifacts and persists them for resume', () => {
  const base = sandbox();
  const out = join(nodeDir(base, 'r1', 'n1'), 'outputs');
  mkdirSync(join(out, 'report'), { recursive: true });
  writeFileSync(join(out, 'report', 'r.md'), '# hi', 'utf8');
  seedManifest(base, 'r1', 'n1', {
    artifacts: [
      { name: 'report', kind: 'document', summary: 'a report', files: ['report/r.md'] },
      { name: 'ids', kind: 'records', summary: 'three ids', data: { ids: [1, 2, 3] } },
    ],
  });

  const artifacts = collectOutputs(base, 'r1', 'n1', [
    { name: 'report', kind: 'document' },
    { name: 'ids', kind: 'records' },
  ]);

  assert.equal(artifacts.length, 2);
  assert.deepEqual((artifacts[1].data as { ids: number[] }).ids, [1, 2, 3]);
  assert.ok(existsSync(join(nodeDir(base, 'r1', 'n1'), 'artifacts.json')));
});

test('staging an input writes a summary, the data and the files', () => {
  const base = sandbox();
  const src = join(nodeDir(base, 'r1', 'up'), 'outputs', 'deck');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'deck.pdf'), 'pdf bytes', 'utf8');

  const artifact: Artifact = {
    name: 'deck',
    kind: 'document',
    node: 'up',
    summary: 'the deck',
    files: ['nodes/up/outputs/deck/deck.pdf'],
    createdAt: new Date().toISOString(),
    data: { pages: 12 },
  };

  const dest = stageInput(base, 'r1', 'down', artifact);
  assert.match(readFileSync(join(dest, 'summary.md'), 'utf8'), /the deck/);
  assert.equal(JSON.parse(readFileSync(join(dest, 'data.json'), 'utf8')).pages, 12);
  assert.ok(existsSync(join(dest, 'files', 'deck.pdf')));
});

test('the brief tells the agent what it was handed and what it owes', () => {
  const base = sandbox();
  const node: NodeSpec = {
    id: 'apply',
    prompt: 'apply the changes',
    needs: ['propose'],
    outputs: [{ name: 'result', kind: 'records' }],
    approval: { prompt: 'check before applying', when: 'after' },
  };
  const upstream: Artifact[] = [
    { name: 'plan', kind: 'changeset', node: 'propose', summary: 'twelve deals move stage', createdAt: 'x' },
  ];
  const prepared = prepareNode(base, 'r1', node, 'apply the changes', upstream, { week: 'W38' });

  const handoff = readFileSync(prepared.handoffPath, 'utf8');
  assert.match(handoff, /twelve deals move stage/);
  assert.match(handoff, /inputs\/propose\/plan/);
  assert.match(handoff, /W38/);

  const brief = readFileSync(join(prepared.dir, 'CLAUDE.md'), 'utf8');
  assert.match(brief, /outputs\/manifest.json/);
  assert.match(brief, /\*\*result\*\*/);
  assert.match(brief, /A human reviews this node/);
});

test('a changeset producer is told to propose and not apply', () => {
  const base = sandbox();
  const node: NodeSpec = {
    id: 'propose',
    prompt: 'work out what to change',
    outputs: [{ name: 'plan', kind: 'changeset' }],
  };
  const prepared = prepareNode(base, 'r1', node, 'work out what to change', [], {});
  const brief = readFileSync(join(prepared.dir, 'CLAUDE.md'), 'utf8');
  assert.match(brief, /This node proposes, it does not apply/);
});

test('an approval moves from pending to granted and is recorded', () => {
  const base = sandbox();
  requestApproval(base, 'r1', 'commit', 'check the writes', 'after', [
    { name: 'plan', kind: 'changeset', node: 'propose', summary: 's', data: { a: 1 }, createdAt: 'x' },
  ]);
  assert.equal(pendingApprovals(base, 'r1').length, 1);
  assert.match(readApproval(base, 'r1', 'commit')!.preview!, /"a": 1/);

  decideApproval(base, 'r1', 'commit', 'granted', 'reviewer', 'looks right');
  assert.equal(pendingApprovals(base, 'r1').length, 0);
  assert.equal(readApproval(base, 'r1', 'commit')!.status, 'granted');
});

test('the same approval cannot be decided twice', () => {
  const base = sandbox();
  requestApproval(base, 'r1', 'commit', 'check', 'after');
  decideApproval(base, 'r1', 'commit', 'granted', 'reviewer');
  assert.throws(() => decideApproval(base, 'r1', 'commit', 'rejected', 'reviewer'), /already granted/);
});

test('a resource cannot be held twice at once', () => {
  const resource = `test:${Math.random().toString(36).slice(2)}`;
  const first = new ResourceLock();
  const second = new ResourceLock();

  assert.equal(first.tryAcquire([resource], 'r1', 'a'), true);
  assert.equal(second.tryAcquire([resource], 'r2', 'b'), false);

  first.releaseAll();
  assert.equal(second.tryAcquire([resource], 'r2', 'b'), true);
  second.releaseAll();
});

test('a partial multi-resource acquisition rolls back fully', () => {
  const held = `test:${Math.random().toString(36).slice(2)}`;
  const free = `test:${Math.random().toString(36).slice(2)}`;
  const holder = new ResourceLock();
  holder.tryAcquire([held], 'r1', 'a');

  const contender = new ResourceLock();
  assert.equal(contender.tryAcquire([free, held], 'r2', 'b'), false);

  // If rollback leaked, this third party could not take the free resource.
  const third = new ResourceLock();
  assert.equal(third.tryAcquire([free], 'r3', 'c'), true);

  holder.releaseAll();
  third.releaseAll();
});

test('the ledger reports which nodes a resume must not re-run', () => {
  const base = sandbox();
  const ledger = new Ledger(base, 'r1');
  ledger.append({ type: 'node.completed', node: 'a', costUsd: 1, turns: 2, durationMs: 3 });
  ledger.append({ type: 'node.failed', node: 'b', error: 'boom' });
  ledger.append({ type: 'node.skipped', node: 'c', reason: 'condition' });

  assert.deepEqual([...ledger.completedNodes()].sort(), ['a', 'c']);
  assert.deepEqual([...ledger.failedNodes()], ['b']);
});

test('a torn final ledger line does not destroy the history', () => {
  const base = sandbox();
  const ledger = new Ledger(base, 'r1');
  ledger.append({ type: 'node.completed', node: 'a', costUsd: 0, turns: 1, durationMs: 1 });
  writeFileSync(join(base, '.skillflow', 'runs', 'r1', 'ledger.jsonl'), readFileSync(join(base, '.skillflow', 'runs', 'r1', 'ledger.jsonl'), 'utf8') + '{"ts":"broken', 'utf8');
  assert.deepEqual([...ledger.completedNodes()], ['a']);
});
