import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerEvent, LedgerInput } from '../types.js';
import { ledgerPath } from './paths.js';

/**
 * An append-only event log per run.
 *
 * This is the piece that makes resume possible and makes a failed overnight run
 * explainable the next morning. It is deliberately JSONL on disk rather than a
 * database: a run should be greppable with the tools you already have, and a
 * corrupt final line should cost you one event, not the whole history.
 */
export class Ledger {
  private readonly file: string;

  constructor(baseDir: string, runId: string) {
    this.file = ledgerPath(baseDir, runId);
    mkdirSync(dirname(this.file), { recursive: true });
  }

  append(event: LedgerInput): void {
    const withTs = { ts: new Date().toISOString(), ...event } as LedgerEvent;
    appendFileSync(this.file, `${JSON.stringify(withTs)}\n`, 'utf8');
  }

  read(): LedgerEvent[] {
    if (!existsSync(this.file)) return [];
    const events: LedgerEvent[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as LedgerEvent);
      } catch {
        // A torn final line from a killed process. Skipping it is correct:
        // the event it described never completed either.
      }
    }
    return events;
  }

  /**
   * Which nodes already finished, so a resume does not re-run them. This is the
   * whole safety story for work that writes to Salesforce: a node that
   * completed must never be executed twice by a resume.
   */
  completedNodes(): Set<string> {
    const done = new Set<string>();
    for (const event of this.read()) {
      if (event.type === 'node.completed') done.add(event.node);
      if (event.type === 'node.skipped') done.add(event.node);
    }
    return done;
  }

  failedNodes(): Set<string> {
    const failed = new Set<string>();
    for (const event of this.read()) {
      if (event.type === 'node.failed') failed.add(event.node);
      if (event.type === 'node.completed') failed.delete(event.node);
    }
    return failed;
  }
}
