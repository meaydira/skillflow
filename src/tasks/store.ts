import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Assignee, Comment, CommentKind, Priority, Task, TaskStatus } from './types.js';

/**
 * File-backed task storage.
 *
 * One JSON file per task and one JSONL file of its comments, under
 * `.skillflow/tasks/`. No database, for the same reason the ledger is JSONL:
 * the whole state of your board should be greppable, diffable, and committable
 * with the tools you already have, and losing one file should cost you one task
 * rather than everything.
 */

export function tasksDir(baseDir: string): string {
  return join(baseDir, '.skillflow', 'tasks');
}

function taskPath(baseDir: string, id: string): string {
  return join(tasksDir(baseDir), `${id}.json`);
}

function commentsPath(baseDir: string, id: string): string {
  return join(tasksDir(baseDir), `${id}.comments.jsonl`);
}

/** Writes through a temp file so a crash mid-write cannot leave a half task. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, file);
}

export function listTasks(baseDir: string): Task[] {
  const dir = tasksDir(baseDir);
  if (!existsSync(dir)) return [];
  const tasks: Task[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    try {
      tasks.push(withDefaults(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Task));
    } catch {
      // A task we cannot parse is reported by its absence rather than crashing
      // the board. The file is still on disk for a human to look at.
    }
  }
  return tasks.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getTask(baseDir: string, id: string): Task | null {
  const file = taskPath(baseDir, id);
  if (!existsSync(file)) return null;
  try {
    return withDefaults(JSON.parse(readFileSync(file, 'utf8')) as Task);
  } catch {
    return null;
  }
}

/** Tasks written before a field existed read as if it had its default. */
function withDefaults(task: Task): Task {
  return {
    ...task,
    connectors: task.connectors ?? [],
    writes: task.writes ?? 'ask',
    resources: task.resources ?? [],
    labels: task.labels ?? [],
  };
}

export function saveTask(baseDir: string, task: Task): Task {
  mkdirSync(tasksDir(baseDir), { recursive: true });
  const next = { ...task, updatedAt: new Date().toISOString() };
  writeAtomic(taskPath(baseDir, task.id), JSON.stringify(next, null, 2));
  return next;
}

/**
 * Sequential, human-readable ids. They show up in conversation ("did SF-12
 * land?"), so a uuid would be the wrong choice even though it is easier.
 */
function nextId(baseDir: string, prefix: string): string {
  const existing = listTasks(baseDir)
    .map((t) => Number(new RegExp(`^${prefix}-(\\d+)$`).exec(t.id)?.[1] ?? 0))
    .filter((n) => Number.isFinite(n));
  return `${prefix}-${Math.max(0, ...existing) + 1}`;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: Priority;
  assignee?: Assignee | null;
  labels?: string[];
  resources?: string[];
  connectors?: string[];
  writes?: 'allow' | 'deny' | 'ask';
  prefix?: string;
}

export function createTask(baseDir: string, input: CreateTaskInput): Task {
  mkdirSync(tasksDir(baseDir), { recursive: true });
  const now = new Date().toISOString();
  const status = input.status ?? 'backlog';
  const siblings = listTasks(baseDir).filter((t) => t.status === status);

  const task: Task = {
    id: nextId(baseDir, input.prefix ?? 'TASK'),
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    status,
    priority: input.priority ?? 'none',
    assignee: input.assignee ?? null,
    labels: input.labels ?? [],
    resources: input.resources ?? [],
    connectors: input.connectors ?? [],
    writes: input.writes ?? 'ask',
    runs: [],
    createdAt: now,
    updatedAt: now,
    activeRun: null,
    order: siblings.length > 0 ? Math.max(...siblings.map((t) => t.order)) + 1 : 0,
  };
  writeAtomic(taskPath(baseDir, task.id), JSON.stringify(task, null, 2));
  return task;
}

/**
 * Move a task, optionally to a specific slot in its new column.
 *
 * Dragging is the main way status changes here, and a drag carries a position
 * as well as a column, so this takes both rather than making the caller
 * renumber afterwards.
 */
export function moveTask(
  baseDir: string,
  id: string,
  status: TaskStatus,
  index?: number,
): Task | null {
  const task = getTask(baseDir, id);
  if (!task) return null;

  const column = listTasks(baseDir)
    .filter((t) => t.status === status && t.id !== id)
    .sort((a, b) => a.order - b.order);

  const at = index === undefined ? column.length : Math.max(0, Math.min(index, column.length));
  column.splice(at, 0, { ...task, status });

  let moved = task;
  column.forEach((entry, position) => {
    const current = entry.id === id ? { ...task, status } : entry;
    if (current.order !== position || current.status !== status) {
      const saved = saveTask(baseDir, { ...current, order: position, status });
      if (saved.id === id) moved = saved;
    } else if (current.id === id) {
      moved = saveTask(baseDir, { ...current, order: position, status });
    }
  });
  return moved;
}

export function addComment(
  baseDir: string,
  taskId: string,
  author: string,
  kind: CommentKind,
  body: string,
  runId?: string,
): Comment {
  mkdirSync(tasksDir(baseDir), { recursive: true });
  const comment: Comment = {
    id: randomUUID().slice(0, 8),
    taskId,
    author,
    kind,
    body,
    createdAt: new Date().toISOString(),
    runId,
  };
  appendFileSync(commentsPath(baseDir, taskId), `${JSON.stringify(comment)}\n`, 'utf8');
  return comment;
}

export function listComments(baseDir: string, taskId: string): Comment[] {
  const file = commentsPath(baseDir, taskId);
  if (!existsSync(file)) return [];
  const out: Comment[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Comment);
    } catch {
      // Torn final line from a killed process; the event it described did not
      // complete either.
    }
  }
  return out;
}

export function deleteTask(baseDir: string, id: string): boolean {
  const file = taskPath(baseDir, id);
  if (!existsSync(file)) return false;
  // Cancelled rather than removed: a board that silently loses things is worse
  // than one with a column you ignore.
  const task = getTask(baseDir, id);
  if (!task) return false;
  saveTask(baseDir, { ...task, status: 'cancelled' });
  return true;
}
