import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Artifact, NodeSpec, NodeResult } from '../types.js';
import type { ParsedWorkflow } from '../workflow/schema.js';
import { collectOutputs } from './artifacts.js';
import { prepareNode } from './handoff.js';
import type { Ledger } from './ledger.js';

export interface RunNodeArgs {
  baseDir: string;
  runId: string;
  node: NodeSpec;
  spec: ParsedWorkflow;
  renderedPrompt: string;
  upstream: Artifact[];
  runInputs: Record<string, string>;
  ledger: Ledger;
  onEvent?: (line: string) => void;
}

/**
 * Execute one node: build its working directory, run Claude headless inside it,
 * stream events to the ledger, then validate what it produced.
 */
export async function runNode(args: RunNodeArgs): Promise<NodeResult> {
  const { baseDir, runId, node, spec, renderedPrompt, upstream, runInputs, ledger, onEvent } = args;
  const started = Date.now();

  const prepared = prepareNode(baseDir, runId, node, renderedPrompt, upstream, runInputs);

  const defaults = spec.defaults ?? {};
  const timeoutMs = (node.timeoutSec ?? defaults.timeoutSec ?? 3600) * 1000;
  const idleMs = (node.idleTimeoutSec ?? defaults.idleTimeoutSec ?? 600) * 1000;

  const abort = new AbortController();
  let timedOutReason: string | null = null;

  const hardTimer = setTimeout(() => {
    timedOutReason = `exceeded its ${Math.round(timeoutMs / 1000)}s wall-clock budget`;
    abort.abort();
  }, timeoutMs);

  // The idle watchdog answers a different question from the wall-clock one:
  // "has this gone quiet?" rather than "has this run long?". A node that keeps
  // emitting is working, however long it takes, and killing it for duration
  // alone is how you lose an hour of real progress.
  let idleTimer: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOutReason = `produced no output for ${Math.round(idleMs / 1000)}s`;
      abort.abort();
    }, idleMs);
  };
  resetIdle();

  const connectors = buildConnectors(spec, node);

  const options: Options = {
    cwd: prepared.dir,
    abortController: abort,
    permissionMode: node.permissionMode ?? defaults.permissionMode ?? 'acceptEdits',
    model: node.model ?? defaults.model,
    maxTurns: node.maxTurns ?? defaults.maxTurns ?? 60,
    // 'user' picks up the skills already installed in ~/.claude/skills, which is
    // the whole point: your existing skill library is the node library.
    settingSources: ['user'],
    skills: node.skill ? [node.skill] : 'all',
    allowedTools: node.allowedTools ?? defaults.allowedTools,
    disallowedTools: [
      // Unattended runs have nobody to answer. Leaving this enabled turns a
      // clarifying question into a silent stall that only the idle watchdog ends.
      'AskUserQuestion',
      ...(node.disallowedTools ?? defaults.disallowedTools ?? []),
    ],
    ...(Object.keys(connectors).length > 0 ? { mcpServers: connectors } : {}),
  };

  const artifactsOut: Artifact[] = [];
  let costUsd = 0;
  let turns = 0;
  let sessionId: string | undefined;
  let resultText = '';
  let hadError: string | null = null;

  try {
    const prompt = [
      `Read HANDOFF.md and CLAUDE.md in your working directory, then carry out your task.`,
      node.skill ? `Use the "${node.skill}" skill.` : '',
      '',
      renderedPrompt,
    ]
      .filter(Boolean)
      .join('\n');

    for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      resetIdle();

      if (message.type === 'assistant') {
        for (const block of message.message.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            const text = block.text.trim();
            ledger.append({ type: 'node.text', node: node.id, text: text.slice(0, 2000) });
            onEvent?.(text.length > 160 ? `${text.slice(0, 160)}...` : text);
          } else if (block.type === 'tool_use') {
            const detail = summariseToolInput(block.input);
            ledger.append({ type: 'node.tool', node: node.id, tool: block.name, detail });
            onEvent?.(`  ${block.name}${detail ? ` ${detail}` : ''}`);
          }
        }
      } else if (message.type === 'result') {
        sessionId = message.session_id;
        costUsd = message.total_cost_usd ?? 0;
        turns = message.num_turns ?? 0;
        if (message.subtype === 'success') {
          resultText = message.result ?? '';
        } else {
          hadError = `agent ended with ${message.subtype}`;
        }
      }
    }
  } catch (err) {
    hadError = timedOutReason ? `node ${timedOutReason}` : (err as Error).message;
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer!);
  }

  const durationMs = Date.now() - started;

  if (hadError) {
    ledger.append({ type: 'node.failed', node: node.id, error: hadError });
    return { node: node.id, status: 'failed', artifacts: [], error: hadError, costUsd, turns, durationMs, sessionId };
  }

  // Output validation is where a vague run becomes a hard failure. A node that
  // finished talking but produced nothing it promised has not succeeded.
  try {
    artifactsOut.push(...collectOutputs(baseDir, runId, node.id, node.outputs ?? []));
  } catch (err) {
    const error = (err as Error).message;
    ledger.append({ type: 'node.failed', node: node.id, error });
    return { node: node.id, status: 'failed', artifacts: [], error, costUsd, turns, durationMs, sessionId };
  }

  for (const artifact of artifactsOut) {
    ledger.append({ type: 'node.artifact', node: node.id, artifact });
  }
  ledger.append({ type: 'node.completed', node: node.id, costUsd, turns, durationMs, sessionId });

  return {
    node: node.id,
    status: 'completed',
    artifacts: artifactsOut,
    costUsd,
    turns,
    durationMs,
    sessionId,
    error: resultText ? undefined : undefined,
  };
}

/** Narrow the workflow's connector map down to the servers this node asked for. */
function buildConnectors(spec: ParsedWorkflow, node: NodeSpec): Record<string, any> {
  const out: Record<string, any> = {};
  for (const name of node.connectors ?? []) {
    const config = spec.connectors?.[name];
    if (config) out[name] = config;
  }
  return out;
}

function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['description', 'file_path', 'command', 'pattern', 'query', 'url', 'skill']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > 80 ? `${flat.slice(0, 80)}...` : flat;
    }
  }
  return '';
}
