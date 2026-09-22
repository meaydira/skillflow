import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything a run owns lives under one directory, so a run is inspectable, archivable, and deletable as a unit. */
export function runRoot(baseDir: string, runId: string): string {
  return join(baseDir, '.skillflow', 'runs', runId);
}

export function runsDir(baseDir: string): string {
  return join(baseDir, '.skillflow', 'runs');
}

export function nodeDir(baseDir: string, runId: string, nodeId: string): string {
  return join(runRoot(baseDir, runId), 'nodes', nodeId);
}

export function approvalsDir(baseDir: string, runId: string): string {
  return join(runRoot(baseDir, runId), 'approvals');
}

export function ledgerPath(baseDir: string, runId: string): string {
  return join(runRoot(baseDir, runId), 'ledger.jsonl');
}

export function statePath(baseDir: string, runId: string): string {
  return join(runRoot(baseDir, runId), 'run.json');
}

/** Locks are global, not per-run: the whole point is to stop two *runs* colliding. */
export function lockDir(): string {
  return join(homedir(), '.skillflow', 'locks');
}
