import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRoot } from './paths.js';

/**
 * What an agent may do with the tools it has been given.
 *
 * Every claude.ai connector you have signed in to is visible to a headless
 * run. That is convenient and also the whole danger: an unattended agent with
 * your Salesforce, Gmail and Slack is one bad inference away from a customer
 * email. So instead of bypassing permissions (which is what makes coding agents
 * run unattended, and is safe there only because git can undo anything), this
 * module classifies each MCP call and applies a policy:
 *
 *   reads   -> allowed, on any connector the node is permitted to use
 *   writes  -> `allow`, `deny`, or `ask`, and `ask` stops the agent until a
 *              person decides on the board. Async permission callbacks make
 *              that possible; the agent simply waits.
 */

export type WritePolicy = 'allow' | 'deny' | 'ask';

export interface ToolPolicy {
  /** Connector names the node may use. Empty means every connected one. */
  connectors: string[];
  writes: WritePolicy;
}

export interface PermissionRequest {
  id: string;
  runId: string;
  node: string;
  tool: string;
  connector: string;
  input: unknown;
  status: 'pending' | 'allowed' | 'denied';
  /** 'run' remembers the decision for every later call to the same tool in this run. */
  scope?: 'once' | 'run';
  requestedAt: string;
  decidedAt?: string;
  by?: string;
  note?: string;
}

const MCP = /^mcp__([A-Za-z0-9_]+?)__(.+)$/;

/** Split "mcp__claude_ai_Airtable__update_records" into its connector and tool. */
export function parseMcpTool(toolName: string): { connector: string; tool: string } | null {
  const match = MCP.exec(toolName);
  if (!match) return null;
  return { connector: match[1], tool: match[2] };
}

/**
 * A connector as `claude mcp list` names it ("CData Connect AI") maps to the
 * prefix its tools carry ("claude_ai_CData_Connect_AI"). Both spellings are
 * accepted wherever a policy names a connector, so a workflow can say
 * "Airtable" and mean it.
 */
export function connectorKey(name: string): string {
  const flat = name.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return flat.startsWith('claude_ai_') ? flat : `claude_ai_${flat}`;
}

export function connectorAllowed(policy: ToolPolicy, connector: string): boolean {
  if (policy.connectors.length === 0) return true;
  const wanted = new Set(policy.connectors.flatMap((c) => [c, connectorKey(c), c.replace(/^claude_ai_/, '')]));
  return wanted.has(connector) || wanted.has(connector.replace(/^claude_ai_/, ''));
}

/**
 * Is this tool one that changes something?
 *
 * Judged by name because that is all a generic layer has. It is deliberately
 * broad: the cost of gating a read is one click, the cost of waving through a
 * write is a customer email. Anything not recognisably a read is treated as a
 * write.
 */
const READ_HINTS = /^(get|list|search|read|query(?!_?(insert|update|delete))|find|fetch|describe|show|lookup|check|count|analy[sz]e|preview|suggest|entity_lookup|display|ping|validate|load_skill|recall|getCatalogs|getSchemas|getTables|getColumns|getProcedures|getProcedureParameters|getInstructions|getStarted|queryData)/i;
const WRITE_HINTS = /(create|update|delete|insert|upsert|send|merge|execute_(update|insert)|executeProcedure|write|remove|trash|move|publish|post|add_|set_|patch|put|launch|push|submit|reply|forward|schedule|share|unsubscribe|mark|label|archive|cancel|approve|reject|assign|invite|purchase|buy|transfer|provision|configure|disconnect|connect_)/i;

export function isWrite(tool: string): boolean {
  if (WRITE_HINTS.test(tool)) return true;
  if (READ_HINTS.test(tool)) return false;
  return true;
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask' };

export function decide(policy: ToolPolicy, toolName: string): Decision {
  const mcp = parseMcpTool(toolName);
  // Everything that is not an MCP call is a local tool the node already had
  // under the previous behaviour (Read, Bash, Write in its own directory).
  if (!mcp) return { kind: 'allow' };

  if (!connectorAllowed(policy, mcp.connector)) {
    return {
      kind: 'deny',
      reason: `This task is not allowed to use the ${mcp.connector.replace(/^claude_ai_/, '')} connector. Add it to the task's connectors if it should be.`,
    };
  }
  if (!isWrite(mcp.tool)) return { kind: 'allow' };

  if (policy.writes === 'allow') return { kind: 'allow' };
  if (policy.writes === 'deny') {
    return {
      kind: 'deny',
      reason: `Writes are disabled for this task, so ${mcp.tool} was not run. Report what you would have changed instead.`,
    };
  }
  return { kind: 'ask' };
}

/* ------------------------------------------------------- pending requests */

function dir(baseDir: string, runId: string): string {
  return join(runRoot(baseDir, runId), 'permissions');
}

export function requestPermission(
  baseDir: string,
  runId: string,
  node: string,
  toolName: string,
  input: unknown,
): PermissionRequest {
  const mcp = parseMcpTool(toolName);
  mkdirSync(dir(baseDir, runId), { recursive: true });
  const request: PermissionRequest = {
    id: randomUUID().slice(0, 8),
    runId,
    node,
    tool: toolName,
    connector: mcp?.connector ?? '',
    input,
    status: 'pending',
    requestedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir(baseDir, runId), `${request.id}.json`), JSON.stringify(request, null, 2), 'utf8');
  return request;
}

export function readPermission(baseDir: string, runId: string, id: string): PermissionRequest | null {
  const file = join(dir(baseDir, runId), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PermissionRequest;
  } catch {
    return null;
  }
}

export function listPermissions(baseDir: string, runId: string): PermissionRequest[] {
  const d = dir(baseDir, runId);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), 'utf8')) as PermissionRequest;
      } catch {
        return null;
      }
    })
    .filter((r): r is PermissionRequest => r !== null)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function pendingPermissions(baseDir: string, runId: string): PermissionRequest[] {
  return listPermissions(baseDir, runId).filter((r) => r.status === 'pending');
}

export function decidePermission(
  baseDir: string,
  runId: string,
  id: string,
  status: 'allowed' | 'denied',
  by: string,
  scope: 'once' | 'run' = 'once',
  note?: string,
): PermissionRequest {
  const current = readPermission(baseDir, runId, id);
  if (!current) throw new Error(`no permission request ${id} in run ${runId}`);
  if (current.status !== 'pending') throw new Error(`that request was already ${current.status}`);
  const next: PermissionRequest = { ...current, status, scope, by, note, decidedAt: new Date().toISOString() };
  writeFileSync(join(dir(baseDir, runId), `${id}.json`), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Block until a person decides, the run is aborted, or the wait expires.
 *
 * Polling a file rather than holding an in-memory promise is what lets the
 * decision come from anywhere: the board, the CLI, or a colleague editing the
 * JSON by hand. `pollMs` is injectable so tests do not have to wait.
 */
export async function awaitDecision(
  baseDir: string,
  runId: string,
  id: string,
  signal: AbortSignal,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<PermissionRequest> {
  const pollMs = options.pollMs ?? 1000;
  const deadline = Date.now() + (options.timeoutMs ?? 24 * 60 * 60 * 1000);

  while (true) {
    const current = readPermission(baseDir, runId, id);
    if (current && current.status !== 'pending') return current;
    if (signal.aborted) {
      return { ...(current as PermissionRequest), status: 'denied', note: 'run was cancelled' };
    }
    if (Date.now() > deadline) {
      return decidePermission(baseDir, runId, id, 'denied', 'skillflow', 'once', 'nobody answered in time');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
