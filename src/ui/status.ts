import { existsSync, readdirSync } from 'node:fs';
import { Ledger } from '../engine/ledger.js';
import { pendingApprovals } from '../engine/approvals.js';
import { loadRunState } from '../engine/run.js';
import { runsDir } from '../engine/paths.js';

export function listRuns(baseDir: string): Array<{ runId: string; workflow: string; startedAt: string; outcome: string }> {
  const dir = runsDir(baseDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((runId) => {
      const state = loadRunState(baseDir, runId);
      const events = new Ledger(baseDir, runId).read();
      const last = [...events].reverse().find((e) => e.type.startsWith('run.'));
      return {
        runId,
        workflow: state?.workflow ?? '(unknown)',
        startedAt: state?.startedAt ?? '',
        outcome: last?.type.replace('run.', '') ?? 'running',
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function describeRun(baseDir: string, runId: string): string {
  const state = loadRunState(baseDir, runId);
  if (!state) return `no run ${runId}`;

  const events = new Ledger(baseDir, runId).read();
  const lines = [
    `run      ${runId}`,
    `workflow ${state.workflow}`,
    `started  ${state.startedAt}`,
    '',
  ];

  if (Object.keys(state.inputs).length > 0) {
    lines.push('inputs');
    for (const [k, v] of Object.entries(state.inputs)) lines.push(`  ${k} = ${v}`);
    lines.push('');
  }

  const perNode = new Map<string, { status: string; cost: number; artifacts: string[]; error?: string }>();
  for (const event of events) {
    if (!('node' in event)) continue;
    const current = perNode.get(event.node) ?? { status: 'running', cost: 0, artifacts: [] };
    if (event.type === 'node.completed') {
      current.status = 'completed';
      current.cost = event.costUsd;
    } else if (event.type === 'node.failed') {
      current.status = 'failed';
      current.error = event.error;
    } else if (event.type === 'node.skipped') {
      current.status = 'skipped';
    } else if (event.type === 'node.artifact') {
      current.artifacts.push(`${event.artifact.name} (${event.artifact.kind})`);
    }
    perNode.set(event.node, current);
  }

  lines.push('nodes');
  let total = 0;
  for (const [node, info] of perNode) {
    total += info.cost;
    const cost = info.cost ? `  $${info.cost.toFixed(2)}` : '';
    lines.push(`  ${info.status.padEnd(10)} ${node}${cost}`);
    for (const artifact of info.artifacts) lines.push(`             -> ${artifact}`);
    if (info.error) lines.push(`             !  ${info.error}`);
  }
  lines.push('', `total cost  $${total.toFixed(2)}`);

  const waiting = pendingApprovals(baseDir, runId);
  if (waiting.length > 0) {
    lines.push('', 'awaiting approval');
    for (const approval of waiting) {
      lines.push(`  ${approval.node}  (${approval.when})  ${approval.prompt}`);
      lines.push(`     skillflow approve ${runId} ${approval.node}`);
    }
  }
  return lines.join('\n');
}
