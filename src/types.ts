/**
 * Core domain types.
 *
 * The central idea: a workflow is a graph of nodes, each node is one headless
 * Claude run, and the edges carry *artifacts* rather than raw text. An artifact
 * is the unit of handoff. Everything else in this codebase exists to move
 * artifacts between nodes safely and to make the movement auditable.
 */

/**
 * The five shapes a handoff can take. Deliberately small: every extra kind is a
 * new case every downstream node has to understand, and the three chains this
 * was designed against (record writes, outbound approvals, document assembly)
 * are covered by these.
 */
export type ArtifactKind =
  /** Files a human or a later node opens: decks, spreadsheets, PDFs, reports. */
  | 'document'
  /** Structured rows or IDs. The Salesforce Account IDs an intake just created. */
  | 'records'
  /** Prose. A finding, a recommendation, a summary that is itself the product. */
  | 'note'
  /** A pointer to something living in an external system. An Airtable tab, a URL. */
  | 'ref'
  /**
   * Proposed mutations that have NOT been applied. This is the one that makes
   * ops work reviewable: a node computes what it wants to write, a human reads
   * it, and only then does a downstream node commit it. The diff equivalent for
   * work that has no diff.
   */
  | 'changeset';

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  /** Node that produced it. */
  node: string;
  /**
   * Prose the *next agent* reads. Required for every artifact, including file
   * ones, because a downstream agent that has to open three PDFs to learn what
   * it was handed has already lost the plot.
   */
  summary: string;
  description?: string;
  /** Structured payload for records / ref / changeset. */
  data?: unknown;
  /** Paths relative to the run root, for document artifacts. */
  files?: string[];
  createdAt: string;
}

export interface OutputSpec {
  name: string;
  kind: ArtifactKind;
  description?: string;
  /** A missing required output fails the node. Default true. */
  required?: boolean;
}

export type ApprovalWhen = 'before' | 'after';

export interface ApprovalSpec {
  /** Why a human is being asked. Shown in the CLI and written to the request file. */
  prompt: string;
  /**
   * 'before' gates the node itself (do not let it run unattended at all).
   * 'after' gates its *outputs* (it ran, it proposed, a human signs off before
   * anything downstream consumes the result). 'after' is the default because it
   * is the one that fits changesets.
   */
  when?: ApprovalWhen;
}

export interface NodeSpec {
  id: string;
  /** Human-facing name for logs and the graph. */
  name?: string;
  /** Skill to invoke, e.g. "crm-sync". Optional: a node can be pure prompt. */
  skill?: string;
  /**
   * A Claude Code subagent to run this node as, by name, from ~/.claude/agents
   * or a plugin. Its system prompt, tool restrictions and model apply to the
   * whole node. `skillflow list` prints the names available on this machine.
   */
  agent?: string;
  /** The instruction. Supports ${{ }} templating. */
  prompt: string;
  /** Upstream node ids. Their artifacts are handed to this node automatically. */
  needs?: string[];
  outputs?: OutputSpec[];
  approval?: ApprovalSpec;
  /**
   * Logical resources this node writes. Two nodes holding the same resource
   * never run at the same time, even across concurrent runs. This is what
   * worktrees give coding agents for free and ops agents do not get.
   */
  resources?: string[];
  /**
   * Declares that this node only reads. It suppresses the "no resource lock"
   * lint, and more usefully it states the intent in the file: a reviewer can see
   * which steps of a pipeline can never change anything.
   */
  readonly?: boolean;
  model?: string;
  maxTurns?: number;
  /** Defaults to the workflow-level value, then to 'acceptEdits'. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  allowedTools?: string[];
  disallowedTools?: string[];
  /** MCP server names (from the workflow's `connectors` block) this node needs. */
  connectors?: string[];
  /** Per-node timeouts in seconds. Fall back to workflow defaults. */
  timeoutSec?: number;
  idleTimeoutSec?: number;
  /** Retries on failure. Default 0: ops work that half-applied should not blindly retry. */
  retries?: number;
  /** Skip the node when this template resolves to a falsy string. */
  if?: string;
}

export interface WorkflowSpec {
  name: string;
  description?: string;
  /** Declared run inputs, referenced as ${{ inputs.key }}. */
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  /** MCP servers available to nodes that opt in via `connectors`. */
  connectors?: Record<string, unknown>;
  defaults?: {
    model?: string;
    maxTurns?: number;
    permissionMode?: NodeSpec['permissionMode'];
    timeoutSec?: number;
    idleTimeoutSec?: number;
    allowedTools?: string[];
    disallowedTools?: string[];
  };
  /** Max nodes in flight. Default 3. */
  concurrency?: number;
  nodes: NodeSpec[];
}

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'awaiting-approval'
  | 'blocked';

export interface NodeResult {
  node: string;
  status: NodeStatus;
  artifacts: Artifact[];
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  sessionId?: string;
  error?: string;
}

export type LedgerEvent =
  | { ts: string; type: 'run.started'; runId: string; workflow: string; inputs: Record<string, string> }
  | { ts: string; type: 'run.completed'; runId: string }
  | { ts: string; type: 'run.paused'; runId: string; reason: string }
  | { ts: string; type: 'run.failed'; runId: string; error: string }
  | { ts: string; type: 'node.started'; node: string; attempt: number }
  | { ts: string; type: 'node.tool'; node: string; tool: string; detail?: string }
  | { ts: string; type: 'node.text'; node: string; text: string }
  | { ts: string; type: 'node.artifact'; node: string; artifact: Artifact }
  | { ts: string; type: 'node.completed'; node: string; costUsd: number; turns: number; durationMs: number; sessionId?: string }
  | { ts: string; type: 'node.failed'; node: string; error: string }
  | { ts: string; type: 'node.skipped'; node: string; reason: string }
  | { ts: string; type: 'approval.requested'; node: string; prompt: string; when: ApprovalWhen }
  | { ts: string; type: 'approval.granted'; node: string; by: string; note?: string }
  | { ts: string; type: 'approval.rejected'; node: string; by: string; note?: string };

export interface ApprovalRecord {
  runId: string;
  node: string;
  when: ApprovalWhen;
  prompt: string;
  status: 'pending' | 'granted' | 'rejected';
  requestedAt: string;
  decidedAt?: string;
  by?: string;
  note?: string;
  /** Rendered preview of what is being approved. */
  preview?: string;
}

/**
 * `Omit` over a union collapses it to the keys every member shares, which would
 * quietly erase the discriminated payloads. The conditional type distributes
 * instead, so each variant keeps its own fields.
 */
export type LedgerInput = LedgerEvent extends infer T
  ? T extends { ts: string }
    ? Omit<T, 'ts'> & { ts?: string }
    : never
  : never;
