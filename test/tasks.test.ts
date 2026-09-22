import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addComment,
  createTask,
  getTask,
  listComments,
  listTasks,
  moveTask,
  saveTask,
} from '../src/tasks/store.js';

const sandbox = () => mkdtempSync(join(tmpdir(), 'skillflow-tasks-'));

test('ids are sequential and human readable', () => {
  const base = sandbox();
  assert.equal(createTask(base, { title: 'first' }).id, 'TASK-1');
  assert.equal(createTask(base, { title: 'second' }).id, 'TASK-2');
  assert.equal(createTask(base, { title: 'third' }).id, 'TASK-3');
});

test('a new task lands at the bottom of its column', () => {
  const base = sandbox();
  createTask(base, { title: 'a', status: 'todo' });
  createTask(base, { title: 'b', status: 'todo' });
  const third = createTask(base, { title: 'c', status: 'todo' });
  assert.equal(third.order, 2);
});

test('moving to another column appends there by default', () => {
  const base = sandbox();
  createTask(base, { title: 'a', status: 'todo' });
  const mover = createTask(base, { title: 'b', status: 'backlog' });
  createTask(base, { title: 'c', status: 'todo' });

  const moved = moveTask(base, mover.id, 'todo');
  assert.equal(moved?.status, 'todo');
  assert.equal(moved?.order, 2, 'should land after the two already there');
});

test('dropping at an index reorders the column and renumbers cleanly', () => {
  const base = sandbox();
  const a = createTask(base, { title: 'a', status: 'todo' });
  const b = createTask(base, { title: 'b', status: 'todo' });
  const c = createTask(base, { title: 'c', status: 'todo' });

  // Drag c to the very top.
  moveTask(base, c.id, 'todo', 0);
  const column = listTasks(base)
    .filter((t) => t.status === 'todo')
    .sort((x, y) => x.order - y.order)
    .map((t) => t.id);

  assert.deepEqual(column, [c.id, a.id, b.id]);
  // Orders must be a clean 0..n, or the next drop computes the wrong slot.
  assert.deepEqual(
    listTasks(base).filter((t) => t.status === 'todo').map((t) => t.order).sort(),
    [0, 1, 2],
  );
});

test('dropping into the middle of another column puts it in that slot', () => {
  const base = sandbox();
  createTask(base, { title: 'a', status: 'todo' });
  createTask(base, { title: 'b', status: 'todo' });
  const mover = createTask(base, { title: 'x', status: 'backlog' });

  moveTask(base, mover.id, 'todo', 1);
  const column = listTasks(base)
    .filter((t) => t.status === 'todo')
    .sort((x, y) => x.order - y.order)
    .map((t) => t.title);
  assert.deepEqual(column, ['a', 'x', 'b']);
});

test('an out of range index is clamped rather than leaving a gap', () => {
  const base = sandbox();
  createTask(base, { title: 'a', status: 'todo' });
  const mover = createTask(base, { title: 'b', status: 'backlog' });
  const moved = moveTask(base, mover.id, 'todo', 99);
  assert.equal(moved?.order, 1);
});

test('moving a task that does not exist returns null instead of throwing', () => {
  assert.equal(moveTask(sandbox(), 'TASK-404', 'done'), null);
});

test('comments are appended in order and survive a reread', () => {
  const base = sandbox();
  const task = createTask(base, { title: 'a' });
  addComment(base, task.id, 'dilara', 'comment', 'first');
  addComment(base, task.id, 'agent-x', 'result', 'second');
  addComment(base, task.id, 'dilara', 'feedback', 'third');

  const comments = listComments(base, task.id);
  assert.deepEqual(comments.map((c) => c.kind), ['comment', 'result', 'feedback']);
  assert.deepEqual(comments.map((c) => c.body), ['first', 'second', 'third']);
});

test('a task with no comments reads as empty rather than failing', () => {
  const base = sandbox();
  assert.deepEqual(listComments(base, createTask(base, { title: 'a' }).id), []);
});

test('saving a task updates its timestamp and persists the assignee', () => {
  const base = sandbox();
  const task = createTask(base, { title: 'a' });
  const saved = saveTask(base, { ...task, assignee: { kind: 'skill', name: 'my-skill' } });

  assert.equal(saved.assignee?.name, 'my-skill');
  assert.ok(saved.updatedAt >= task.updatedAt);
  assert.equal(getTask(base, task.id)?.assignee?.kind, 'skill');
});

test('an unknown task reads as null', () => {
  assert.equal(getTask(sandbox(), 'TASK-1'), null);
});

test('listing an empty board returns nothing rather than throwing', () => {
  assert.deepEqual(listTasks(sandbox()), []);
});
