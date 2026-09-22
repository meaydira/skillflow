/**
 * Tasks: the unit a human manages.
 *
 * The engine already runs workflows. A workflow is the right shape when you know
 * the steps in advance. A task is the right shape when work arrives the way work
 * actually arrives: someone wants a thing done, an agent picks it up, a human
 * looks at the result and either accepts it or sends it back.
 *
 * A task can also be backed by a workflow, which is how a chain of agents
 * (create the accounts, then match interactions) shows up as one thing on the
 * board rather than as five things a person has to sequence by hand.
 */

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';

export const TASK_STATUSES: TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

/**
 * Who owns the task. An agent or a skill runs one Claude session; a workflow
 * runs the whole graph; a human means nobody automated is going to touch it.
 */
export interface Assignee {
  kind: 'agent' | 'skill' | 'workflow' | 'human';
  name: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee: Assignee | null;
  labels: string[];
  /** Logical resources this task's work touches, passed to the run as locks. */
  resources: string[];
  /** Run ids this task has produced, oldest first. */
  runs: string[];
  createdAt: string;
  updatedAt: string;
  /** Set while a run is in flight, so the board can show it working. */
  activeRun?: string | null;
  /** Ordering within a column, so drag and drop can reorder as well as move. */
  order: number;
}

export type CommentKind =
  /** A person talking. */
  | 'comment'
  /** A person sending work back with changes requested. */
  | 'feedback'
  /** The agent reporting as it goes. */
  | 'progress'
  /** The agent's final answer for a run. */
  | 'result'
  /** The system recording something that happened. */
  | 'system';

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  kind: CommentKind;
  body: string;
  createdAt: string;
  /** The run this comment belongs to, when it came from one. */
  runId?: string;
}
