import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lockDir } from './paths.js';

interface LockFile {
  pid: number;
  runId: string;
  node: string;
  resource: string;
  acquiredAt: string;
}

/**
 * Cross-process locks on *logical* resources, not file paths.
 *
 * A coding agent gets isolation free, because a git worktree is a private copy
 * of the world. An agent writing to a Salesforce org has no such thing: two runs
 * that both decide to create the same Account will both create it. So a node
 * declares what it writes ("crm:main", "airtable:appXYZ") and the engine
 * refuses to run two holders of the same string at once, across every run on
 * this machine.
 */
export class ResourceLock {
  private held: string[] = [];

  private static file(resource: string): string {
    const digest = createHash('sha256').update(resource).digest('hex').slice(0, 16);
    return join(lockDir(), `${digest}.lock`);
  }

  private static isStale(file: string): boolean {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as LockFile;
      // Signal 0 tests for existence without touching the process.
      process.kill(data.pid, 0);
      return false;
    } catch (err) {
      // ESRCH means the holder is gone and the lock outlived it. Anything else
      // (unreadable, malformed) also means we cannot trust it.
      return (err as NodeJS.ErrnoException).code !== 'EPERM';
    }
  }

  static holder(resource: string): LockFile | null {
    const file = ResourceLock.file(resource);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as LockFile;
    } catch {
      return null;
    }
  }

  /** Try to take every resource atomically. All or nothing, to avoid deadlock by partial acquisition. */
  tryAcquire(resources: string[], runId: string, node: string): boolean {
    if (resources.length === 0) return true;
    mkdirSync(lockDir(), { recursive: true });

    const taken: string[] = [];
    // Sorting gives every process the same acquisition order, which is what
    // turns "two runs want A and B" from a deadlock into one clean loser.
    for (const resource of [...resources].sort()) {
      const file = ResourceLock.file(resource);
      if (existsSync(file) && ResourceLock.isStale(file)) rmSync(file, { force: true });

      try {
        // wx fails if the file exists: that is the atomic test-and-set.
        const fd = openSync(file, 'wx');
        closeSync(fd);
        const payload: LockFile = {
          pid: process.pid,
          runId,
          node,
          resource,
          acquiredAt: new Date().toISOString(),
        };
        writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
        taken.push(resource);
      } catch {
        for (const rollback of taken) rmSync(ResourceLock.file(rollback), { force: true });
        return false;
      }
    }
    this.held.push(...taken);
    return true;
  }

  release(resources: string[]): void {
    for (const resource of resources) {
      rmSync(ResourceLock.file(resource), { force: true });
      this.held = this.held.filter((r) => r !== resource);
    }
  }

  releaseAll(): void {
    this.release([...this.held]);
  }
}
