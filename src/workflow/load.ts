import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { workflowSchema, type ParsedWorkflow } from './schema.js';
import { referencedPaths } from './template.js';

export interface LoadedWorkflow {
  spec: ParsedWorkflow;
  path: string;
  /** Node ids in a valid execution order. */
  order: string[];
  /** Nodes grouped into waves; every node in a wave can run in parallel. */
  waves: string[][];
  byId: Map<string, ParsedWorkflow['nodes'][number]>;
}

export class WorkflowError extends Error {}

export function loadWorkflow(file: string): LoadedWorkflow {
  const path = resolve(file);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new WorkflowError(`could not parse ${path}: ${(err as Error).message}`);
  }

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new WorkflowError(`invalid workflow ${path}:\n${lines.join('\n')}`);
  }
  const spec = parsed.data;

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  if (byId.size !== spec.nodes.length) {
    const seen = new Set<string>();
    const dupes = spec.nodes.map((n) => n.id).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    throw new WorkflowError(`duplicate node ids: ${[...new Set(dupes)].join(', ')}`);
  }

  for (const node of spec.nodes) {
    for (const dep of node.needs) {
      if (!byId.has(dep)) {
        throw new WorkflowError(`node "${node.id}" needs "${dep}", which is not defined`);
      }
      if (dep === node.id) {
        throw new WorkflowError(`node "${node.id}" depends on itself`);
      }
    }
    for (const conn of node.connectors) {
      if (!(conn in spec.connectors)) {
        throw new WorkflowError(
          `node "${node.id}" wants connector "${conn}", which is not defined in the workflow's connectors block`,
        );
      }
    }
  }

  const { order, waves } = topoSort(spec);
  return { spec, path, order, waves, byId };
}

/**
 * Kahn's algorithm, grouped into waves. Waves matter because they are what the
 * scheduler parallelises over and what `skillflow graph` renders, so a reader
 * can see at a glance which parts of their pipeline are actually sequential.
 */
function topoSort(spec: ParsedWorkflow): { order: string[]; waves: string[][] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of spec.nodes) {
    indegree.set(node.id, node.needs.length);
    for (const dep of node.needs) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
    }
  }

  const order: string[] = [];
  const waves: string[][] = [];
  let frontier = spec.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);

  while (frontier.length > 0) {
    waves.push([...frontier]);
    order.push(...frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    frontier = next;
  }

  if (order.length !== spec.nodes.length) {
    const stuck = spec.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    throw new WorkflowError(
      `dependency cycle detected; these nodes can never run: ${stuck.join(', ')}`,
    );
  }
  return { order, waves };
}

export interface Warning {
  node?: string;
  message: string;
}

/**
 * Static checks that do not stop a run but almost always mean a mistake. Kept
 * separate from hard validation so `run` can print them and continue while
 * `validate` can treat them as a checklist.
 */
export function lintWorkflow(wf: LoadedWorkflow, providedInputs: Record<string, string> = {}): Warning[] {
  const warnings: Warning[] = [];
  const { spec } = wf;

  const producedBy = new Map<string, Set<string>>();
  for (const node of spec.nodes) {
    producedBy.set(node.id, new Set(node.outputs.map((o) => o.name)));
  }

  for (const node of spec.nodes) {
    const ancestors = collectAncestors(wf, node.id);

    for (const path of referencedPaths(node.prompt)) {
      const parts = path.split('.').map((p) => p.trim());
      if (parts[0] === 'inputs') {
        const key = parts[1];
        if (key && !(key in spec.inputs)) {
          warnings.push({ node: node.id, message: `references undeclared input "${key}"` });
        } else if (key && spec.inputs[key]?.required && !(key in providedInputs) && spec.inputs[key]?.default === undefined) {
          warnings.push({ node: node.id, message: `required input "${key}" has no value` });
        }
      } else if (parts[0] === 'nodes') {
        const [, upstream, , artifact] = parts;
        if (upstream && !wf.byId.has(upstream)) {
          warnings.push({ node: node.id, message: `references unknown node "${upstream}"` });
        } else if (upstream && !ancestors.has(upstream)) {
          warnings.push({
            node: node.id,
            message: `references "${upstream}" but does not list it in needs, so ordering is not guaranteed`,
          });
        } else if (upstream && artifact && !producedBy.get(upstream)?.has(artifact)) {
          warnings.push({
            node: node.id,
            message: `references ${upstream}.outputs.${artifact}, which "${upstream}" does not declare`,
          });
        }
      }
    }

    // A node that writes to a shared system and declares no resource is the
    // single most likely cause of two runs colliding. Worth a nudge.
    const writesSomewhere = /salesforce|airtable|gmail|slack|lemlist|sheet/i.test(
      `${node.skill ?? ''} ${node.prompt}`,
    );
    if (writesSomewhere && !node.readonly && node.resources.length === 0) {
      warnings.push({
        node: node.id,
        message:
          'touches an external system but declares no `resources` lock (add one, or mark the node `readonly: true`)',
      });
    }

    if (node.permissionMode === 'bypassPermissions' && !node.approval) {
      warnings.push({
        node: node.id,
        message: 'runs with bypassPermissions and has no approval gate',
      });
    }
  }
  return warnings;
}

export function collectAncestors(wf: LoadedWorkflow, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(wf.byId.get(id)?.needs ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(wf.byId.get(current)?.needs ?? []));
  }
  return seen;
}
