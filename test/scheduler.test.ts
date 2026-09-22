import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWorkflow } from '../src/workflow/load.js';
import { executeRun } from '../src/engine/run.js';
import { decideApproval, pendingApprovals } from '../src/engine/approvals.js';
import { Ledger } from '../src/engine/ledger.js';

/**
 * These run in dryRun mode, which walks the real scheduler, the real gates, the
 * real ledger and the real resume path, and only stubs the model call. That is
 * the part worth testing: the bug this suite was written after was a scheduler
 * bug that reported "completed" over five nodes that never ran.
 */

function fixture(yaml: string): { base: string; wf: ReturnType<typeof loadWorkflow> } {
  const base = mkdtempSync(join(tmpdir(), 'skillflow-sched-'));
  const file = join(base, 'wf.yaml');
  writeFileSync(file, yaml, 'utf8');
  return { base, wf: loadWorkflow(file) };
}

const GATED = `
name: gated
nodes:
  - id: first
    prompt: do the thing
    approval:
      when: after
      prompt: check it
  - id: second
    prompt: build on it
    needs: [first]
  - id: third
    prompt: and again
    needs: [second]
`;

test('a run pauses at an after-gate instead of reporting completed', async () => {
  const { base, wf } = fixture(GATED);
  const summary = await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });

  assert.equal(summary.outcome, 'paused');
  assert.deepEqual(summary.pending, ['first']);
  assert.equal(summary.statuses.get('first'), 'completed');
  // The downstream nodes are waiting, not blocked: a resume will run them.
  assert.equal(summary.statuses.get('second'), 'pending');
  assert.deepEqual(summary.blocked, []);
});

test('approving the gate lets a resume finish the run', async () => {
  const { base, wf } = fixture(GATED);
  await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });

  decideApproval(base, 'r1', 'first', 'granted', 'tester');
  const resumed = await executeRun({
    baseDir: base,
    workflow: wf,
    inputs: {},
    runId: 'r1',
    dryRun: true,
    resume: true,
  });

  assert.equal(resumed.outcome, 'completed');
  assert.equal(resumed.statuses.get('third'), 'completed');
});

test('a resume does not re-run a node that already completed', async () => {
  const { base, wf } = fixture(GATED);
  await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });
  decideApproval(base, 'r1', 'first', 'granted', 'tester');
  await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true, resume: true });

  const starts = new Ledger(base, 'r1')
    .read()
    .filter((e) => e.type === 'node.started' && e.node === 'first');
  assert.equal(starts.length, 1, 'first should have started exactly once across both passes');
});

test('rejecting a gate blocks everything downstream and fails the run', async () => {
  const { base, wf } = fixture(GATED);
  await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });

  decideApproval(base, 'r1', 'first', 'rejected', 'tester', 'wrong batch');
  const resumed = await executeRun({
    baseDir: base,
    workflow: wf,
    inputs: {},
    runId: 'r1',
    dryRun: true,
    resume: true,
  });

  assert.equal(resumed.outcome, 'failed');
  assert.deepEqual(resumed.blocked.sort(), ['second', 'third']);
  assert.equal(pendingApprovals(base, 'r1').length, 0);
});

test('a before-gate stops the node running at all', async () => {
  const { base, wf } = fixture(`
name: pre
nodes:
  - id: apply
    prompt: write to the system of record
    approval:
      when: before
      prompt: are you sure
`);
  const summary = await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });

  assert.equal(summary.outcome, 'paused');
  assert.equal(summary.statuses.get('apply'), 'awaiting-approval');
  const started = new Ledger(base, 'r1').read().filter((e) => e.type === 'node.started');
  assert.equal(started.length, 0, 'a before-gated node must not start before approval');
});

test('a skip propagates to dependents rather than stalling them', async () => {
  const { base, wf } = fixture(`
name: cond
inputs:
  enabled:
    default: ""
nodes:
  - id: maybe
    prompt: optional step
    if: "\${{ inputs.enabled }}"
  - id: after
    prompt: runs anyway
    needs: [maybe]
`);
  const summary = await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });
  assert.equal(summary.statuses.get('maybe'), 'skipped');
  // The dependent skips too: it would otherwise run with the input it needed missing.
  assert.equal(summary.statuses.get('after'), 'skipped');
  assert.equal(summary.outcome, 'completed');
  assert.deepEqual(summary.blocked, []);
});

test('a truthy condition runs the node and its dependents normally', async () => {
  const { base, wf } = fixture(`
name: cond2
inputs:
  enabled:
    default: "yes"
nodes:
  - id: maybe
    prompt: optional step
    if: "\${{ inputs.enabled }}"
  - id: after
    prompt: runs too
    needs: [maybe]
`);
  const summary = await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });
  assert.equal(summary.statuses.get('maybe'), 'completed');
  assert.equal(summary.statuses.get('after'), 'completed');
  assert.equal(summary.outcome, 'completed');
});

test('independent branches both run', async () => {
  const { base, wf } = fixture(`
name: fan
concurrency: 3
nodes:
  - id: root
    prompt: r
  - id: a
    prompt: a
    needs: [root]
  - id: b
    prompt: b
    needs: [root]
  - id: join
    prompt: j
    needs: [a, b]
`);
  const summary = await executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true });
  assert.equal(summary.outcome, 'completed');
  for (const id of ['root', 'a', 'b', 'join']) {
    assert.equal(summary.statuses.get(id), 'completed', `${id} should have run`);
  }
});

test('a missing required input is refused before anything runs', async () => {
  const { base, wf } = fixture(`
name: needsinput
inputs:
  week:
    required: true
nodes:
  - id: a
    prompt: "\${{ inputs.week }}"
`);
  await assert.rejects(
    () => executeRun({ baseDir: base, workflow: wf, inputs: {}, runId: 'r1', dryRun: true }),
    /missing required input "week"/,
  );
});
