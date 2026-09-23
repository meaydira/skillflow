import { z } from 'zod';

const artifactKind = z.enum(['document', 'records', 'note', 'ref', 'changeset']);

const writePolicy = z.enum(['allow', 'deny', 'ask']);

const permissionMode = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);

const outputSpec = z.object({
  name: z.string().min(1),
  kind: artifactKind,
  description: z.string().optional(),
  required: z.boolean().default(true),
});

const approvalSpec = z.object({
  prompt: z.string().min(1),
  when: z.enum(['before', 'after']).default('after'),
});

const nodeSpec = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'node id must be alphanumeric with - or _'),
  name: z.string().optional(),
  skill: z.string().optional(),
  agent: z.string().optional(),
  prompt: z.string().min(1),
  needs: z.array(z.string()).default([]),
  outputs: z.array(outputSpec).default([]),
  approval: approvalSpec.optional(),
  resources: z.array(z.string()).default([]),
  readonly: z.boolean().default(false),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  permissionMode: permissionMode.optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  connectors: z.array(z.string()).default([]),
  writes: writePolicy.optional(),
  timeoutSec: z.number().int().positive().optional(),
  idleTimeoutSec: z.number().int().positive().optional(),
  retries: z.number().int().min(0).default(0),
  if: z.string().optional(),
});

export const workflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        required: z.boolean().default(false),
        default: z.string().optional(),
      }),
    )
    .default({}),
  connectors: z.record(z.string(), z.unknown()).default({}),
  defaults: z
    .object({
      model: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
      permissionMode: permissionMode.optional(),
      timeoutSec: z.number().int().positive().optional(),
      idleTimeoutSec: z.number().int().positive().optional(),
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      writes: writePolicy.optional(),
    })
    .default({}),
  concurrency: z.number().int().positive().default(3),
  nodes: z.array(nodeSpec).min(1),
});

export type ParsedWorkflow = z.infer<typeof workflowSchema>;
