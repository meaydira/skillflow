import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadWorkflow } from '../workflow/load.js';

/**
 * Turn a workflow built in the UI into a workflow file on disk.
 *
 * The file stays the source of truth rather than a database row, so a workflow
 * you build by clicking is the same object as one you write by hand: editable in
 * an editor, diffable in git, and runnable from the terminal.
 */

export interface StepInput {
  id?: string;
  name?: string;
  prompt: string;
  /** "agent:name", "skill:name", or empty for a plain prompt. */
  runner?: string;
  needs?: string[];
  outputName?: string;
  outputKind?: 'document' | 'records' | 'note' | 'ref' | 'changeset';
  readonly?: boolean;
  resources?: string[];
  connectors?: string[];
  writes?: 'allow' | 'deny' | 'ask';
  approval?: { when: 'before' | 'after'; prompt: string } | null;
}

export interface WorkflowInput {
  name: string;
  description?: string;
  inputs?: Array<{ key: string; description?: string; required?: boolean; default?: string }>;
  steps: StepInput[];
}

export class AuthoringError extends Error {}

const slug = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';

/** Node ids must be stable and safe; a renamed step keeps whatever id it had. */
function stepId(step: StepInput, index: number): string {
  const raw = step.id?.trim() || step.name?.trim() || `step_${index + 1}`;
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_|_$/g, '') || `step_${index + 1}`;
}

export function buildWorkflowYaml(input: WorkflowInput): string {
  if (!input.name.trim()) throw new AuthoringError('the workflow needs a name');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new AuthoringError('add at least one step');
  }

  const ids = input.steps.map(stepId);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new AuthoringError(`two steps are both called "${id}"`);
    seen.add(id);
  }

  const doc: Record<string, unknown> = {
    name: slug(input.name),
    description: input.description?.trim() || undefined,
  };

  if (input.inputs && input.inputs.length > 0) {
    const inputs: Record<string, unknown> = {};
    for (const entry of input.inputs) {
      if (!entry.key?.trim()) continue;
      inputs[entry.key.trim()] = {
        description: entry.description?.trim() || undefined,
        required: entry.required ? true : undefined,
        default: entry.default?.trim() || undefined,
      };
    }
    if (Object.keys(inputs).length > 0) doc.inputs = inputs;
  }

  doc.connectors = {};
  doc.defaults = { permissionMode: 'acceptEdits', maxTurns: 40, idleTimeoutSec: 900 };
  doc.concurrency = 2;

  doc.nodes = input.steps.map((step, index) => {
    if (!step.prompt?.trim()) throw new AuthoringError(`step "${ids[index]}" has no prompt`);

    const runner = (step.runner ?? '').trim();
    const [kind, ...rest] = runner.split(':');
    const runnerName = rest.join(':');

    // A step with no explicit dependency follows the one before it. That is
    // what someone building a chain top to bottom means, and making them wire
    // every edge by hand to express it would be busywork.
    const needs =
      step.needs && step.needs.length > 0
        ? step.needs.filter((n) => ids.includes(n))
        : index > 0
          ? [ids[index - 1]]
          : [];

    const node: Record<string, unknown> = {
      id: ids[index],
      name: step.name?.trim() || undefined,
      ...(kind === 'skill' && runnerName ? { skill: runnerName } : {}),
      ...(kind === 'agent' && runnerName ? { agent: runnerName } : {}),
      ...(needs.length > 0 ? { needs } : {}),
      ...(step.readonly ? { readonly: true } : {}),
      ...(step.resources && step.resources.length > 0 ? { resources: step.resources } : {}),
      ...(step.connectors && step.connectors.length > 0 ? { connectors: step.connectors } : {}),
      ...(step.writes && step.writes !== 'ask' ? { writes: step.writes } : {}),
      ...(step.approval ? { approval: { when: step.approval.when, prompt: step.approval.prompt } } : {}),
      prompt: step.prompt.trim(),
      outputs: [
        {
          name: step.outputName?.trim() || 'result',
          kind: step.outputKind || 'note',
          description: 'What this step hands to the next one',
        },
      ],
    };
    return node;
  });

  // Strip the undefined values YAML would otherwise render as nulls.
  return YAML.stringify(JSON.parse(JSON.stringify(doc)), { lineWidth: 0 });
}

export function saveWorkflow(baseDir: string, input: WorkflowInput, existingPath?: string): string {
  const dir = join(baseDir, 'workflows');
  mkdirSync(dir, { recursive: true });

  const relative = existingPath?.trim() || join('workflows', `${slug(input.name)}.yaml`);
  const absolute = join(baseDir, relative);

  if (!existingPath && existsSync(absolute)) {
    throw new AuthoringError(`a workflow file called ${relative} already exists`);
  }

  const yaml = buildWorkflowYaml(input);
  writeFileSync(absolute, yaml, 'utf8');

  // Parse it back before reporting success. A file that cannot be loaded is a
  // broken workflow however good the form that produced it looked.
  try {
    loadWorkflow(absolute);
  } catch (err) {
    throw new AuthoringError(`saved, but it does not load: ${(err as Error).message}`);
  }
  return relative;
}

/** Read a workflow file back into the shape the builder edits. */
export function workflowToInput(baseDir: string, relative: string): WorkflowInput & { path: string } {
  const wf = loadWorkflow(join(baseDir, relative));
  return {
    path: relative,
    name: wf.spec.name,
    description: wf.spec.description ?? '',
    inputs: Object.entries(wf.spec.inputs ?? {}).map(([key, def]) => ({
      key,
      description: def.description,
      required: def.required,
      default: def.default,
    })),
    steps: wf.spec.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      prompt: node.prompt,
      runner: node.skill ? `skill:${node.skill}` : node.agent ? `agent:${node.agent}` : '',
      needs: node.needs,
      outputName: node.outputs[0]?.name ?? 'result',
      outputKind: node.outputs[0]?.kind ?? 'note',
      readonly: node.readonly,
      resources: node.resources,
      connectors: node.connectors,
      writes: node.writes ?? 'ask',
      approval: node.approval ? { when: node.approval.when ?? 'after', prompt: node.approval.prompt } : null,
    })),
  };
}
