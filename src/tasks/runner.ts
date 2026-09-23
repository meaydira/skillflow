import { loadWorkflow, buildWorkflow } from '../workflow/load.js';
import { workflowSchema } from '../workflow/schema.js';
import { executeRun, newRunId } from '../engine/run.js';
import { addComment, getTask, listComments, saveTask } from './store.js';
import { parseMcpTool } from '../engine/permissions.js';
import type { Task } from './types.js';

/**
 * Run the work a task describes.
 *
 * A task assigned to an agent or a skill becomes a one-node workflow, so it goes
 * through exactly the same engine as everything else: same working directory,
 * same output contract, same ledger, same resume. A task assigned to a workflow
 * runs that workflow. There is deliberately no second execution path.
 */

export interface RunTaskResult {
  runId: string;
  ok: boolean;
  error?: string;
}

const active = new Map<string, Promise<RunTaskResult>>();

export function isRunning(taskId: string): boolean {
  return active.has(taskId);
}

/**
 * Compose the instruction from the task and everything said about it since.
 *
 * Prior results and the feedback on them are what make the second attempt
 * better than the first. Leaving them out is how an agent cheerfully reproduces
 * the work you just rejected.
 */
function composePrompt(baseDir: string, task: Task): string {
  const parts: string[] = [`# ${task.title}`, ''];
  if (task.description.trim()) parts.push(task.description.trim(), '');

  const history = listComments(baseDir, task.id).filter(
    (c) => c.kind === 'result' || c.kind === 'feedback' || c.kind === 'comment',
  );

  if (history.length > 0) {
    parts.push('## What has happened on this task so far', '');
    parts.push(
      'You have worked on this before, or a person has said something about it.',
      'Read this before starting. Where feedback asks for a change, make that',
      'change rather than repeating what was rejected.',
      '',
    );
    for (const entry of history.slice(-12)) {
      const who =
        entry.kind === 'result'
          ? 'You previously reported'
          : entry.kind === 'feedback'
            ? `${entry.author} sent it back`
            : `${entry.author} said`;
      parts.push(`**${who}:**`, '', entry.body.trim(), '');
    }
  }
  return parts.join('\n');
}

function buildTaskWorkflow(baseDir: string, task: Task) {
  const assignee = task.assignee;
  const spec = workflowSchema.parse({
    name: `task-${task.id}`,
    description: task.title,
    concurrency: 1,
    defaults: { permissionMode: 'acceptEdits', maxTurns: 40, idleTimeoutSec: 900 },
    nodes: [
      {
        id: 'work',
        name: task.title,
        ...(assignee?.kind === 'skill' ? { skill: assignee.name } : {}),
        ...(assignee?.kind === 'agent' ? { agent: assignee.name } : {}),
        resources: task.resources ?? [],
        connectors: task.connectors ?? [],
        writes: task.writes ?? 'ask',
        prompt: composePrompt(baseDir, task),
        outputs: [
          {
            name: 'result',
            kind: 'note',
            description: 'What you did, what you produced, and anything a human needs to decide',
            required: true,
          },
        ],
      },
    ],
  });
  return buildWorkflow(spec, `task:${task.id}`);
}

export function runTask(
  baseDir: string,
  taskId: string,
  actor: string,
  onChange?: () => void,
): RunTaskResult | Promise<RunTaskResult> {
  const existing = active.get(taskId);
  if (existing) return existing;

  const task = getTask(baseDir, taskId);
  if (!task) return { runId: '', ok: false, error: 'no such task' };
  if (!task.assignee || task.assignee.kind === 'human') {
    return { runId: '', ok: false, error: 'assign this to an agent, a skill or a workflow first' };
  }

  const runId = newRunId();
  const assignee = task.assignee;

  let workflow;
  try {
    workflow =
      assignee.kind === 'workflow'
        ? loadWorkflow(assignee.name)
        : buildTaskWorkflow(baseDir, task);
  } catch (err) {
    const error = (err as Error).message;
    addComment(baseDir, taskId, 'skillflow', 'system', `Could not start: ${error}`);
    return { runId: '', ok: false, error };
  }

  saveTask(baseDir, {
    ...task,
    status: 'in_progress',
    activeRun: runId,
    runs: [...task.runs, runId],
  });
  addComment(
    baseDir,
    taskId,
    'skillflow',
    'system',
    `${assignee.name} picked this up. Run \`${runId}\`.`,
    runId,
  );
  onChange?.();

  let posted = 0;
  const promise = executeRun({
    baseDir,
    workflow,
    inputs: { task_id: task.id, task_title: task.title },
    runId,
    onActivity: (event) => {
      // The agent's own sentences become progress; tool calls do not. A board
      // that narrates every Write is noise, and the tool history is in the
      // ledger for anyone who wants it.
      if (event.kind !== 'text' || posted >= 10) return;
      const text = event.text.trim();
      if (text.length < 40) return;
      posted += 1;
      addComment(baseDir, taskId, assignee.name, 'progress', text, runId);
      onChange?.();
    },
    onPermission: (request) => {
      const mcp = parseMcpTool(request.tool);
      const where = mcp ? `${mcp.connector.replace(/^claude_ai_/, '').replace(/_/g, ' ')}` : '';
      addComment(
        baseDir,
        taskId,
        assignee.name,
        'permission',
        `Wants to run **${mcp?.tool ?? request.tool}**${where ? ` on ${where}` : ''}. Waiting for you.`,
        runId,
      );
      onChange?.();
    },
    onPermissionDecided: (request) => {
      const mcp = parseMcpTool(request.tool);
      const verb = request.status === 'allowed'
        ? (request.scope === 'run' ? 'allowed, and every later call to it in this run' : 'allowed')
        : 'denied';
      addComment(
        baseDir,
        taskId,
        request.by ?? 'skillflow',
        'system',
        `${mcp?.tool ?? request.tool} ${verb}${request.note ? `: ${request.note}` : '.'}`,
        runId,
      );
      onChange?.();
    },
  })
    .then((summary) => {
      const current = getTask(baseDir, taskId) ?? task;
      const artifacts = summary.results.flatMap((r) => r.artifacts);

      if (summary.outcome === 'failed') {
        const failure = summary.results.find((r) => r.status === 'failed');
        addComment(
          baseDir,
          taskId,
          assignee.name,
          'system',
          `Run failed: ${failure?.error ?? 'unknown error'}`,
          runId,
        );
        saveTask(baseDir, { ...current, status: 'todo', activeRun: null });
        onChange?.();
        return { runId, ok: false, error: failure?.error };
      }

      if (summary.outcome === 'paused') {
        addComment(
          baseDir,
          taskId,
          'skillflow',
          'system',
          `Waiting for your approval on: ${summary.pending.join(', ')}.`,
          runId,
        );
        saveTask(baseDir, { ...current, status: 'in_review', activeRun: null });
        onChange?.();
        return { runId, ok: true };
      }

      const body =
        artifacts.length > 0
          ? artifacts.map((a) => `**${a.name}** (${a.kind})\n\n${a.summary}`).join('\n\n')
          : 'Finished, but produced no artifacts.';
      addComment(baseDir, taskId, assignee.name, 'result', body, runId);
      saveTask(baseDir, { ...current, status: 'in_review', activeRun: null });
      onChange?.();
      return { runId, ok: true };
    })
    .catch((err: Error) => {
      const current = getTask(baseDir, taskId) ?? task;
      addComment(baseDir, taskId, 'skillflow', 'system', `Run crashed: ${err.message}`, runId);
      saveTask(baseDir, { ...current, status: 'todo', activeRun: null });
      onChange?.();
      return { runId, ok: false, error: err.message };
    })
    .finally(() => {
      active.delete(taskId);
    });

  active.set(taskId, promise);
  return promise;
}

/** Send a reviewed task back with changes requested, and start again. */
export function sendBack(
  baseDir: string,
  taskId: string,
  actor: string,
  feedback: string,
  onChange?: () => void,
): { ok: boolean; error?: string } {
  const task = getTask(baseDir, taskId);
  if (!task) return { ok: false, error: 'no such task' };
  if (!feedback.trim()) return { ok: false, error: 'say what needs to change' };

  addComment(baseDir, taskId, actor, 'feedback', feedback.trim());
  saveTask(baseDir, { ...task, status: 'todo' });
  onChange?.();
  void runTask(baseDir, taskId, actor, onChange);
  return { ok: true };
}
