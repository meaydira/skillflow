import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Artifact, NodeResult, NodeStatus } from '../types.js';
import type { LoadedWorkflow } from '../workflow/load.js';
import { render, type TemplateScope } from '../workflow/template.js';
import { Ledger } from './ledger.js';
import { ResourceLock } from './locks.js';
import { loadPersistedArtifacts } from './artifacts.js';
import { decideApproval, pendingApprovals, readApproval, requestApproval } from './approvals.js';
import { runNode } from './node.js';
import { runRoot, statePath } from './paths.js';

export interface RunOptions {
  baseDir: string;
  workflow: LoadedWorkflow;
  inputs: Record<string, string>;
  runId?: string;
  resume?: boolean;
  dryRun?: boolean;
  onLog?: (line: string) => void;
}

export interface RunSummary {
  runId: string;
  workflow: string;
  statuses: Map<string, NodeStatus>;
  results: NodeResult[];
  pending: string[];
  /** Nodes that never ran, because an ancestor failed, was rejected, or stalled. */
  blocked: string[];
  totalCostUsd: number;
  outcome: 'completed' | 'paused' | 'failed';
}

interface PersistedState {
  runId: string;
  workflow: string;
  workflowPath: string;
  inputs: Record<string, string>;
  startedAt: string;
  /** Persisted so a resume of a dry run stays a dry run rather than suddenly spending money. */
  dryRun?: boolean;
}

export function newRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * The scheduler.
 *
 * It is a loop rather than a wave-by-wave walk, because waves stall the whole
 * pipeline on their slowest member. A node becomes eligible the moment its own
 * dependencies clear, which is what makes the parallel branches in these
 * workflows actually parallel.
 */
export async function executeRun(options: RunOptions): Promise<RunSummary> {
  const { baseDir, workflow, inputs, onLog } = options;
  const { spec } = workflow;
  const runId = options.runId ?? newRunId();
  const log = onLog ?? (() => {});

  mkdirSync(runRoot(baseDir, runId), { recursive: true });
  const ledger = new Ledger(baseDir, runId);
  const locks = new ResourceLock();

  const resolvedInputs = resolveInputs(workflow, inputs);

  if (!options.resume) {
    const state: PersistedState = {
      runId,
      workflow: spec.name,
      workflowPath: workflow.path,
      inputs: resolvedInputs,
      startedAt: new Date().toISOString(),
      dryRun: options.dryRun ?? false,
    };
    writeFileSync(statePath(baseDir, runId), JSON.stringify(state, null, 2), 'utf8');
    ledger.append({ type: 'run.started', runId, workflow: spec.name, inputs: resolvedInputs });
  }

  const statuses = new Map<string, NodeStatus>(spec.nodes.map((n) => [n.id, 'pending' as NodeStatus]));
  const artifactsByNode = new Map<string, Artifact[]>();
  const results: NodeResult[] = [];

  // Resume: anything the ledger says finished is finished. Re-running a node
  // that already wrote to Salesforce is the worst thing this tool could do.
  if (options.resume) {
    for (const id of ledger.completedNodes()) {
      statuses.set(id, 'completed');
      artifactsByNode.set(id, loadPersistedArtifacts(baseDir, runId, id));
    }
    log(`resuming ${runId}: ${ledger.completedNodes().size} node(s) already done`);
  }

  const inFlight = new Map<string, Promise<void>>();
  let totalCostUsd = 0;

  const upstreamArtifacts = (id: string): Artifact[] => {
    const node = workflow.byId.get(id);
    if (!node) return [];
    return node.needs.flatMap((dep) => artifactsByNode.get(dep) ?? []);
  };

  const scope = (): TemplateScope => ({
    inputs: resolvedInputs,
    run: { id: runId, date: new Date().toISOString().slice(0, 10), workflow: spec.name },
    env: process.env,
    nodes: Object.fromEntries(
      [...artifactsByNode.entries()].map(([nodeId, artifacts]) => [
        nodeId,
        {
          outputs: Object.fromEntries(
            artifacts.map((a) => [a.name, { summary: a.summary, data: a.data }]),
          ),
        },
      ]),
    ),
  });

  /** A node is eligible when every dependency has completed AND cleared its gate. */
  const eligible = (id: string): boolean => {
    if (statuses.get(id) !== 'pending') return false;
    const node = workflow.byId.get(id);
    if (!node) return false;
    for (const dep of node.needs) {
      if (statuses.get(dep) !== 'completed') return false;
      const depNode = workflow.byId.get(dep);
      if (depNode?.approval && (depNode.approval.when ?? 'after') === 'after') {
        if (readApproval(baseDir, runId, dep)?.status !== 'granted') return false;
      }
    }
    return true;
  };

  /**
   * Propagate the states that decide a node's fate before it is ever eligible.
   *
   * A skip propagates as a skip, not as a block: if a conditional step did not
   * run, the step that consumes its output must not run either. Letting it
   * proceed with a missing input is how an agent ends up improvising over a gap
   * it cannot see, which is the failure this whole design is trying to avoid.
   */
  const markUnreachable = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of spec.nodes) {
        if (statuses.get(node.id) !== 'pending') continue;
        for (const dep of node.needs) {
          const depStatus = statuses.get(dep);
          if (depStatus === 'skipped') {
            statuses.set(node.id, 'skipped');
            ledger.append({ type: 'node.skipped', node: node.id, reason: `upstream "${dep}" was skipped` });
            log(`skip  ${node.id}  (upstream ${dep} was skipped)`);
            changed = true;
            break;
          }
          if (depStatus === 'failed' || depStatus === 'blocked') {
            statuses.set(node.id, 'blocked');
            changed = true;
            break;
          }
          const depNode = workflow.byId.get(dep);
          if (depNode?.approval && readApproval(baseDir, runId, dep)?.status === 'rejected') {
            statuses.set(node.id, 'blocked');
            changed = true;
            break;
          }
        }
      }
    }
  };

  while (true) {
    markUnreachable();

    const ready = spec.nodes.map((n) => n.id).filter(eligible);
    const capacity = (spec.concurrency ?? 3) - inFlight.size;

    let launched = 0;
    for (const id of ready) {
      if (launched >= capacity) break;
      const node = workflow.byId.get(id);
      if (!node) continue;

      // `if:` is evaluated here, not at load time, because it usually depends on
      // what an upstream node actually produced.
      if (node.if) {
        const { out } = render(node.if, scope());
        const value = out.trim().toLowerCase();
        if (value === '' || value === 'false' || value === '0' || value === 'no') {
          statuses.set(id, 'skipped');
          ledger.append({ type: 'node.skipped', node: id, reason: `condition "${node.if}" was falsy` });
          log(`skip  ${id}  (condition not met)`);
          continue;
        }
      }

      // A 'before' gate stops the node existing at all until a human says go.
      if (node.approval && (node.approval.when ?? 'after') === 'before') {
        const existing = readApproval(baseDir, runId, id);
        if (!existing || existing.status === 'pending') {
          if (!existing) {
            requestApproval(baseDir, runId, id, node.approval.prompt, 'before', upstreamArtifacts(id));
            ledger.append({ type: 'approval.requested', node: id, prompt: node.approval.prompt, when: 'before' });
            log(`hold  ${id}  awaiting approval before it runs`);
          }
          statuses.set(id, 'awaiting-approval');
          continue;
        }
        if (existing.status === 'rejected') {
          statuses.set(id, 'blocked');
          log(`stop  ${id}  approval rejected`);
          continue;
        }
      }

      if (!locks.tryAcquire(node.resources ?? [], runId, id)) {
        const blockedBy = (node.resources ?? [])
          .map((r) => ResourceLock.holder(r))
          .find((h) => h !== null);
        log(`wait  ${id}  resource held by ${blockedBy?.runId ?? 'another run'}/${blockedBy?.node ?? '?'}`);
        continue;
      }

      const { out: renderedPrompt } = render(node.prompt, scope());
      statuses.set(id, 'running');
      ledger.append({ type: 'node.started', node: id, attempt: 1 });
      log(`run   ${id}${node.skill ? `  [skill: ${node.skill}]` : ''}`);

      const openAfterGate = (artifacts: Artifact[]): void => {
        if (!node.approval || (node.approval.when ?? 'after') !== 'after') return;
        requestApproval(baseDir, runId, id, node.approval.prompt, 'after', artifacts);
        ledger.append({ type: 'approval.requested', node: id, prompt: node.approval.prompt, when: 'after' });
        log(`hold  ${id}  outputs awaiting review before anything downstream runs`);
      };

      if (options.dryRun) {
        statuses.set(id, 'completed');
        artifactsByNode.set(id, []);
        // Write the same completion event a real run writes, so a dry run is an
        // honest rehearsal of resume as well as of ordering.
        ledger.append({ type: 'node.completed', node: id, costUsd: 0, turns: 0, durationMs: 0 });
        // A dry run models the gates too. Its whole job is to show you where the
        // pipeline stops, and a gate is the most common place it will.
        openAfterGate([]);
        locks.release(node.resources ?? []);
        launched += 1;
        continue;
      }

      const task = runNode({
        baseDir,
        runId,
        node,
        spec,
        renderedPrompt,
        upstream: upstreamArtifacts(id),
        runInputs: resolvedInputs,
        ledger,
        onEvent: (line) => log(`      ${line}`),
      })
        .then((result) => {
          results.push(result);
          totalCostUsd += result.costUsd ?? 0;
          artifactsByNode.set(id, result.artifacts);
          statuses.set(id, result.status);

          if (result.status === 'completed') {
            const cost = result.costUsd ? ` $${result.costUsd.toFixed(2)}` : '';
            log(`done  ${id}  ${result.artifacts.length} artifact(s)${cost}`);
            openAfterGate(result.artifacts);
          } else {
            log(`FAIL  ${id}  ${result.error ?? 'unknown error'}`);
          }
        })
        .catch((err: Error) => {
          statuses.set(id, 'failed');
          ledger.append({ type: 'node.failed', node: id, error: err.message });
          log(`FAIL  ${id}  ${err.message}`);
        })
        .finally(() => {
          locks.release(node.resources ?? []);
          inFlight.delete(id);
        });

      inFlight.set(id, task);
      launched += 1;
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight.values());
      continue;
    }
    // Nothing running and nothing launched means no further progress is possible.
    if (launched === 0) break;
  }

  locks.releaseAll();
  markUnreachable();

  const pending = pendingApprovals(baseDir, runId).map((a) => a.node);

  // A node left 'pending' means one of two very different things, and conflating
  // them is how a scheduler ends up lying to you.
  //
  //   A gate is open  -> it is waiting, legitimately, and a resume will run it.
  //   No gate is open -> nothing can ever start it. That is a stall, and it has
  //                      to be visible rather than rounded up to 'completed'.
  const waiting = [...statuses.entries()]
    .filter(([, status]) => status === 'pending')
    .map(([id]) => id);

  const stalled = pending.length > 0 ? [] : waiting;
  for (const id of stalled) statuses.set(id, 'blocked');
  if (stalled.length > 0) {
    log(`stall ${stalled.join(', ')} cannot run and nothing is waiting on you`);
  }

  const blocked = [...statuses.entries()]
    .filter(([, status]) => status === 'blocked')
    .map(([id]) => id);
  const anyFailed = [...statuses.values()].some((status) => status === 'failed');

  const outcome: RunSummary['outcome'] = anyFailed
    ? 'failed'
    : pending.length > 0
      ? 'paused'
      : blocked.length > 0
        ? 'failed'
        : 'completed';

  ledger.append(
    outcome === 'completed'
      ? { type: 'run.completed', runId }
      : outcome === 'paused'
        ? { type: 'run.paused', runId, reason: `${pending.length} approval(s) pending` }
        : { type: 'run.failed', runId, error: 'one or more nodes failed' },
  );

  return { runId, workflow: spec.name, statuses, results, pending, totalCostUsd, outcome, blocked };
}

function resolveInputs(workflow: LoadedWorkflow, provided: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, def] of Object.entries(workflow.spec.inputs ?? {})) {
    const value = provided[key] ?? def.default;
    if (value === undefined) {
      if (def.required) throw new Error(`missing required input "${key}"`);
      continue;
    }
    resolved[key] = value;
  }
  // Extra inputs are kept rather than rejected: a shared workflow should tolerate
  // a caller passing something its author did not think to declare.
  for (const [key, value] of Object.entries(provided)) {
    if (!(key in resolved)) resolved[key] = value;
  }
  return resolved;
}

export function loadRunState(baseDir: string, runId: string): PersistedState | null {
  const file = statePath(baseDir, runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
  } catch {
    return null;
  }
}

export { decideApproval, pendingApprovals };
