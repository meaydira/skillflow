import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact, NodeSpec } from '../types.js';
import { nodeDir } from './paths.js';
import { stageInput } from './artifacts.js';

export interface PreparedNode {
  dir: string;
  outputsDir: string;
  workspaceDir: string;
  handoffPath: string;
}

/**
 * Build the working directory a node runs in.
 *
 * Multica taught me one thing worth copying outright: deliver the brief as a
 * file in the working directory rather than as an inline system prompt. The
 * agent picks it up the way it picks up any CLAUDE.md, it survives a resume, and
 * it is right there on disk when you are trying to work out what the agent was
 * told three hours ago.
 */
export function prepareNode(
  baseDir: string,
  runId: string,
  node: NodeSpec,
  renderedPrompt: string,
  upstream: Artifact[],
  runInputs: Record<string, string>,
): PreparedNode {
  const dir = nodeDir(baseDir, runId, node.id);
  const outputsDir = join(dir, 'outputs');
  const workspaceDir = join(dir, 'workspace');

  mkdirSync(outputsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(dir, 'inputs'), { recursive: true });

  for (const artifact of upstream) stageInput(baseDir, runId, node.id, artifact);

  const handoffPath = join(dir, 'HANDOFF.md');
  writeFileSync(handoffPath, renderHandoff(node, upstream, runInputs), 'utf8');
  writeFileSync(join(dir, 'CLAUDE.md'), renderBrief(node, renderedPrompt, upstream), 'utf8');

  return { dir, outputsDir, workspaceDir, handoffPath };
}

function renderHandoff(
  node: NodeSpec,
  upstream: Artifact[],
  runInputs: Record<string, string>,
): string {
  const lines: string[] = [`# Handoff to \`${node.id}\``, ''];

  if (Object.keys(runInputs).length > 0) {
    lines.push('## Run inputs', '');
    for (const [key, value] of Object.entries(runInputs)) lines.push(`- **${key}**: ${value}`);
    lines.push('');
  }

  if (upstream.length === 0) {
    lines.push('## Upstream', '', 'Nothing ran before this node. You are the start of the chain.', '');
    return lines.join('\n');
  }

  lines.push('## What upstream nodes produced', '');
  lines.push(
    'Each item below is staged on disk under `inputs/<node>/<artifact>/`, with a',
    '`summary.md`, a `data.json` when it carries structured data, and a `files/`',
    'directory when it carries documents. Read what you need rather than assuming.',
    '',
  );

  const byNode = new Map<string, Artifact[]>();
  for (const artifact of upstream) {
    byNode.set(artifact.node, [...(byNode.get(artifact.node) ?? []), artifact]);
  }

  for (const [producer, artifacts] of byNode) {
    lines.push(`### From \`${producer}\``, '');
    for (const artifact of artifacts) {
      lines.push(`#### ${artifact.name} (${artifact.kind})`, '');
      lines.push(artifact.summary, '');
      lines.push(`Staged at: \`inputs/${producer}/${artifact.name}/\``);
      if (artifact.files && artifact.files.length > 0) {
        lines.push('', 'Files:');
        for (const file of artifact.files) lines.push(`- \`${file.split('/').pop()}\``);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderBrief(node: NodeSpec, renderedPrompt: string, upstream: Artifact[]): string {
  const outputs = node.outputs ?? [];

  const contract =
    outputs.length === 0
      ? [
          'This node declares no outputs, so nothing downstream depends on what you',
          'produce. You do not need to write a manifest.',
        ].join('\n')
      : [
          'When your work is done, write `outputs/manifest.json` describing what you',
          'produced. This is how the next node receives your work: a node that skips',
          'the manifest has, as far as the pipeline is concerned, produced nothing.',
          '',
          'Required shape:',
          '',
          '```json',
          '{',
          '  "artifacts": [',
          '    {',
          '      "name": "<one of the declared names below>",',
          '      "kind": "<the declared kind>",',
          '      "summary": "Prose for the next agent. What you produced, what is in it, and anything it needs to know that is not obvious from the data.",',
          '      "data": { },',
          '      "files": ["<name>/report.pdf"]',
          '    }',
          '  ]',
          '}',
          '```',
          '',
          'Rules for the manifest:',
          '',
          '- `summary` is required on every artifact and is the single most useful',
          '  thing you write. The next agent reads it before it reads anything else.',
          '- `data` carries structured payloads: ids, rows, counts, lookups.',
          '- `files` lists paths relative to `outputs/`. Write the actual files there',
          '  first. Do not reference anything outside this run directory.',
          '- Emit every required output below, or the node fails.',
          '- Write the manifest once and move on. skillflow parses it, checks it',
          '  against the contract above, and fails the node with a specific error if',
          '  anything is wrong. Re-reading it, re-validating the JSON, or counting',
          '  your own output back only spends turns on a check that already runs.',
          '',
          'Declared outputs:',
          '',
          ...outputs.map(
            (o) =>
              `- **${o.name}** (\`${o.kind}\`)${o.required === false ? ' _optional_' : ''}${o.description ? ` — ${o.description}` : ''}`,
          ),
        ].join('\n');

  const changesetNote = outputs.some((o) => o.kind === 'changeset')
    ? [
        '',
        '## This node proposes, it does not apply',
        '',
        'One of your declared outputs is a `changeset`. That means you must compute',
        'the changes and write them down, and you must NOT apply them. A human reads',
        'your changeset and approves it, and a later node commits it. If you apply the',
        'writes yourself you have removed the only review step in this pipeline.',
        '',
        'Put enough in `data` that a reader can judge it without re-deriving your work:',
        'the target record, the current value, the proposed value, and why.',
      ].join('\n')
    : '';

  const approvalNote = node.approval
    ? [
        '',
        '## A human reviews this node',
        '',
        `Reason given: ${node.approval.prompt}`,
        '',
        node.approval.when === 'before'
          ? 'Approval was granted before you started. Proceed as instructed.'
          : 'Your outputs will be held for review before anything downstream runs. Write your summary for a reader deciding whether to let this proceed.',
      ].join('\n')
    : '';

  return [
    `# Node: ${node.name ?? node.id}`,
    '',
    'You are one step in a larger pipeline, running unattended. Another agent ran',
    'before you, another will run after you, and a human may be reading your output',
    'tomorrow morning to work out what happened.',
    '',
    '## Your working directory',
    '',
    '- `HANDOFF.md` — what the nodes before you produced. Read it first.',
    '- `inputs/` — their artifacts, staged as files.',
    '- `outputs/` — where your results go, including `manifest.json`.',
    '- `workspace/` — scratch space. Nothing here is handed on.',
    '',
    upstream.length > 0
      ? 'Read `HANDOFF.md` before doing anything else. It tells you what you were given.'
      : 'You are the first node in this run. Nothing was handed to you.',
    '',
    '## Your task',
    '',
    renderedPrompt,
    '',
    '## Output contract',
    '',
    contract,
    changesetNote,
    approvalNote,
    '',
    '## Operating rules',
    '',
    '- Nobody is watching this run. You cannot ask a question and wait for an',
    '  answer. If you hit a genuine blocker, stop, and say plainly in your summary',
    '  what you needed and why you could not continue. A clear failure is worth far',
    '  more here than a confident guess.',
    '- Report what actually happened. If you completed four of five steps, say so',
    '  and name the fifth. The next node and the human both act on your summary.',
    '- Do not invent data to satisfy the output contract. An empty result with an',
    '  honest summary is a valid outcome; a fabricated one corrupts everything',
    '  downstream of you.',
    '',
  ].join('\n');
}
