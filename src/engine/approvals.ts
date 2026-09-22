import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalRecord, ApprovalWhen, Artifact } from '../types.js';
import { approvalsDir } from './paths.js';

/**
 * Human gates.
 *
 * A run does not block on a prompt. It writes a request, stops that branch, and
 * exits when nothing else can proceed. That is what lets these workflows run
 * from cron at 6am and still have a human in the loop at 9am, which is the only
 * shape that actually works for scheduled ops work.
 */
export function requestApproval(
  baseDir: string,
  runId: string,
  node: string,
  prompt: string,
  when: ApprovalWhen,
  artifacts: Artifact[] = [],
): ApprovalRecord {
  const dir = approvalsDir(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${node}.json`);

  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, 'utf8')) as ApprovalRecord;
    if (existing.status !== 'pending') return existing;
  }

  const record: ApprovalRecord = {
    runId,
    node,
    when,
    prompt,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    preview: renderPreview(artifacts),
  };
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function readApproval(baseDir: string, runId: string, node: string): ApprovalRecord | null {
  const file = join(approvalsDir(baseDir, runId), `${node}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ApprovalRecord;
  } catch {
    return null;
  }
}

export function decideApproval(
  baseDir: string,
  runId: string,
  node: string,
  decision: 'granted' | 'rejected',
  by: string,
  note?: string,
): ApprovalRecord {
  const record = readApproval(baseDir, runId, node);
  if (!record) throw new Error(`no approval request for node "${node}" in run ${runId}`);
  if (record.status !== 'pending') {
    throw new Error(`approval for "${node}" was already ${record.status}`);
  }
  const updated: ApprovalRecord = {
    ...record,
    status: decision,
    decidedAt: new Date().toISOString(),
    by,
    note,
  };
  writeFileSync(join(approvalsDir(baseDir, runId), `${node}.json`), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function pendingApprovals(baseDir: string, runId: string): ApprovalRecord[] {
  const dir = approvalsDir(baseDir, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ApprovalRecord)
    .filter((r) => r.status === 'pending');
}

/**
 * What the human actually reads. A changeset gets rendered in full because it is
 * the thing being authorised; everything else gets its summary, because the
 * point of the gate is a decision, not a document review.
 */
function renderPreview(artifacts: Artifact[]): string {
  if (artifacts.length === 0) return '(no outputs produced yet)';
  const blocks: string[] = [];
  for (const artifact of artifacts) {
    blocks.push(`## ${artifact.name}  [${artifact.kind}]\n\n${artifact.summary}`);
    if (artifact.kind === 'changeset' && artifact.data !== undefined) {
      blocks.push('```json\n' + JSON.stringify(artifact.data, null, 2) + '\n```');
    }
    if (artifact.files && artifact.files.length > 0) {
      blocks.push(artifact.files.map((f) => `- ${f}`).join('\n'));
    }
  }
  return blocks.join('\n\n');
}
