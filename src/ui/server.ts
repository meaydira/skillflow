import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { Ledger } from '../engine/ledger.js';
import { decideApproval, pendingApprovals, readApproval } from '../engine/approvals.js';
import { loadRunState } from '../engine/run.js';
import { listRuns } from './status.js';
import { runRoot } from '../engine/paths.js';
import { cachedConnectors, findAgents, findConnectors, findSkills } from '../discover.js';
import { decidePermission, pendingPermissions } from '../engine/permissions.js';
import { loadWorkflow } from '../workflow/load.js';
import {
  addComment,
  createTask,
  getTask,
  listComments,
  listTasks,
  moveTask,
  saveTask,
} from '../tasks/store.js';
import { runTask, sendBack } from '../tasks/runner.js';
import { AuthoringError, saveWorkflow, workflowToInput } from '../tasks/authoring.js';
import type { Assignee, Priority, TaskStatus } from '../tasks/types.js';
import { PRIORITIES, TASK_STATUSES } from '../tasks/types.js';
import type { Artifact } from '../types.js';

/**
 * The board.
 *
 * Everything it shows lives in `.skillflow/`, so the server holds no state of
 * its own and can be restarted underneath an open tab. It binds to loopback and
 * has no login, because it is a window onto files you already own on a machine
 * you are already sitting at.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolves whether running from src/ via tsx or from dist/ after a build.
const WEB = [join(HERE, '..', '..', 'web'), join(HERE, '..', '..', '..', 'web')].find((p) =>
  existsSync(join(p, 'index.html')),
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** "agent:name" from the picker back into the stored shape. */
function parseAssignee(value: unknown): Assignee | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const at = value.indexOf(':');
  if (at === -1) return null;
  const kind = value.slice(0, at);
  const name = value.slice(at + 1);
  if (!['agent', 'skill', 'workflow', 'claude', 'human'].includes(kind) || !name) return null;
  return { kind: kind as Assignee['kind'], name };
}

function discoverWorkflows(baseDir: string) {
  const out: Array<{ name: string; description: string; path: string; nodes: number }> = [];
  for (const dir of ['workflows', 'examples']) {
    const full = join(baseDir, dir);
    if (!existsSync(full)) continue;
    for (const file of readdirSync(full)) {
      if (!/\.ya?ml$/.test(file)) continue;
      const path = join(dir, file);
      try {
        const wf = loadWorkflow(join(baseDir, path));
        out.push({
          name: wf.spec.name,
          description: wf.spec.description ?? '',
          path,
          nodes: wf.spec.nodes.length,
        });
      } catch {
        // A workflow that does not parse is left out of the picker rather than
        // breaking the board. `skillflow validate` is where you find out why.
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every gate still waiting across a task's runs, tagged with which run it is on. */
function taskApprovals(baseDir: string, runIds: string[]) {
  return runIds.flatMap((runId) =>
    pendingApprovals(baseDir, runId).map((a) => ({ ...a, runId })),
  );
}

/**
 * What each step of a run produced and what it was handed.
 *
 * This is the view that makes a chain legible: not just that five agents ran,
 * but what the third one actually received from the second.
 */
function runGraph(baseDir: string, runId: string) {
  const state = loadRunState(baseDir, runId);
  const events = new Ledger(baseDir, runId).read();

  const nodes = new Map<string, {
    id: string;
    status: string;
    costUsd: number;
    turns: number;
    produced: Artifact[];
    error?: string;
  }>();

  const ensure = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, status: 'running', costUsd: 0, turns: 0, produced: [] });
    return nodes.get(id)!;
  };

  for (const event of events) {
    if (!('node' in event)) continue;
    const node = ensure(event.node);
    if (event.type === 'node.completed') {
      node.status = 'completed';
      node.costUsd = event.costUsd;
      node.turns = event.turns;
    } else if (event.type === 'node.failed') {
      node.status = 'failed';
      node.error = event.error;
    } else if (event.type === 'node.skipped') {
      node.status = 'skipped';
    } else if (event.type === 'node.artifact') {
      node.produced.push(event.artifact);
    }
  }

  // Resolve the edges from the workflow file when it is still readable, so the
  // UI can say "this step received X from Y" rather than just listing outputs.
  let needs: Record<string, string[]> = {};
  try {
    if (state?.workflowPath && !state.workflowPath.startsWith('task:')) {
      const wf = loadWorkflow(state.workflowPath);
      needs = Object.fromEntries(wf.spec.nodes.map((n) => [n.id, n.needs]));
    }
  } catch {
    // The file moved or stopped parsing since the run. The outputs still tell
    // the story; only the arrows are missing.
  }

  return [...nodes.values()].map((node) => ({
    ...node,
    needs: needs[node.id] ?? [],
    received: (needs[node.id] ?? []).flatMap((dep) => nodes.get(dep)?.produced ?? []),
  }));
}

function runArtifacts(baseDir: string, runId: string): Artifact[] {
  return new Ledger(baseDir, runId)
    .read()
    .flatMap((e) => (e.type === 'node.artifact' ? [e.artifact] : []));
}

export function startUi(baseDir: string, port: number): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    /* ---------------------------------------------------------- static */
    if (!path.startsWith('/api/')) {
      if (!WEB) {
        json(res, 500, { error: 'web assets not found next to the installed package' });
        return;
      }
      const name = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const file = join(WEB, name);
      if (!file.startsWith(WEB) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
      return;
    }

    /* ------------------------------------------------------------ state */
    if (path === '/api/state') {
      // Kick a refresh but answer from cache: discovery health-checks every
      // server and takes seconds, and the board asks every few seconds.
      void findConnectors();
      const tasks = listTasks(baseDir).map((task) => ({
        ...task,
        needsYou: task.runs.reduce(
          (n, runId) => n + pendingPermissions(baseDir, runId).length + pendingApprovals(baseDir, runId).length,
          0,
        ),
      }));
      json(res, 200, {
        tasks,
        skills: findSkills(baseDir),
        agents: findAgents(baseDir),
        workflows: discoverWorkflows(baseDir),
        connectors: cachedConnectors(),
        runs: listRuns(baseDir).slice(0, 60),
      });
      return;
    }

    if (path === '/api/connectors') {
      findConnectors({ maxAgeMs: url.searchParams.has('refresh') ? 0 : undefined })
        .then((connectors) => json(res, 200, connectors))
        .catch((err) => json(res, 500, { error: (err as Error).message }));
      return;
    }

    /* ------------------------------------------------------------ tasks */
    if (path === '/api/tasks' && req.method === 'POST') {
      readBody(req)
        .then((body) => {
          const title = String(body.title ?? '').trim();
          if (!title) return json(res, 400, { error: 'a task needs a title' });
          json(
            res,
            200,
            createTask(baseDir, {
              title,
              description: String(body.description ?? ''),
              status: TASK_STATUSES.includes(body.status as TaskStatus)
                ? (body.status as TaskStatus)
                : 'backlog',
              connectors: Array.isArray(body.connectors) ? body.connectors.map(String) : [],
              writes: ['allow', 'deny', 'ask'].includes(body.writes as string) ? (body.writes as never) : 'ask',
            }),
          );
        })
        .catch(() => json(res, 400, { error: 'bad request body' }));
      return;
    }

    const taskMatch = /^\/api\/tasks\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const action = taskMatch[2];
      const task = getTask(baseDir, id);
      if (!task) {
        json(res, 404, { error: 'no such task' });
        return;
      }

      if (!action && req.method === 'GET') {
        json(res, 200, {
          task,
          comments: listComments(baseDir, id),
          approvals: taskApprovals(baseDir, task.runs),
          permissions: task.runs.flatMap((runId) => pendingPermissions(baseDir, runId)),
          artifacts: task.runs.flatMap((runId) => runArtifacts(baseDir, runId)),
          graph: task.runs.length > 0
            ? runGraph(baseDir, task.runs[task.runs.length - 1])
            : [],
        });
        return;
      }

      if (!action && req.method === 'PATCH') {
        readBody(req)
          .then((body) => {
            const next = { ...task };
            if (typeof body.title === 'string' && body.title.trim()) next.title = body.title.trim();
            if (typeof body.description === 'string') next.description = body.description;
            if (PRIORITIES.includes(body.priority as Priority)) next.priority = body.priority as Priority;
            if ('assignee' in body) next.assignee = parseAssignee(body.assignee);
            if (Array.isArray(body.resources)) next.resources = body.resources.map(String);
            if (Array.isArray(body.connectors)) next.connectors = body.connectors.map(String);
            if (['allow', 'deny', 'ask'].includes(body.writes as string)) next.writes = body.writes as never;
            if (Array.isArray(body.labels)) next.labels = body.labels.map(String);
            json(res, 200, saveTask(baseDir, next));
          })
          .catch(() => json(res, 400, { error: 'bad request body' }));
        return;
      }

      if (action === '/move' && req.method === 'POST') {
        readBody(req)
          .then((body) => {
            const status = body.status as TaskStatus;
            if (!TASK_STATUSES.includes(status)) return json(res, 400, { error: 'unknown status' });
            const index = typeof body.index === 'number' ? body.index : undefined;
            const moved = moveTask(baseDir, id, status, index);
            if (moved && status !== task.status) {
              addComment(baseDir, id, userInfo().username, 'system', `Moved to ${status.replace('_', ' ')}.`);
            }
            json(res, 200, moved);
          })
          .catch(() => json(res, 400, { error: 'bad request body' }));
        return;
      }

      if (action === '/run' && req.method === 'POST') {
        const started = runTask(baseDir, id, userInfo().username);
        if (started instanceof Promise) {
          // Deliberately not awaited: the board polls, and a long run must not
          // hold the request open.
          json(res, 200, { ok: true, started: true });
        } else {
          json(res, started.ok ? 200 : 400, started);
        }
        return;
      }

      if (action === '/comment' && req.method === 'POST') {
        readBody(req)
          .then((body) => {
            const text = String(body.body ?? '').trim();
            if (!text) return json(res, 400, { error: 'empty comment' });
            json(res, 200, addComment(baseDir, id, userInfo().username, 'comment', text));
          })
          .catch(() => json(res, 400, { error: 'bad request body' }));
        return;
      }

      if (action === '/sendback' && req.method === 'POST') {
        readBody(req)
          .then((body) => {
            const result = sendBack(baseDir, id, userInfo().username, String(body.feedback ?? ''));
            json(res, result.ok ? 200 : 400, result);
          })
          .catch(() => json(res, 400, { error: 'bad request body' }));
        return;
      }
    }

    /* -------------------------------------------------------- workflows */
    if (path === '/api/workflows' && req.method === 'POST') {
      readBody(req)
        .then((body) => {
          try {
            const saved = saveWorkflow(
              baseDir,
              body as never,
              typeof body.path === 'string' ? body.path : undefined,
            );
            json(res, 200, { ok: true, path: saved });
          } catch (err) {
            json(res, err instanceof AuthoringError ? 400 : 500, { error: (err as Error).message });
          }
        })
        .catch(() => json(res, 400, { error: 'bad request body' }));
      return;
    }

    if (path === '/api/workflows/detail' && req.method === 'GET') {
      const relative = url.searchParams.get('path') ?? '';
      try {
        json(res, 200, workflowToInput(baseDir, relative));
      } catch (err) {
        json(res, 404, { error: (err as Error).message });
      }
      return;
    }

    // Running a workflow creates a task for it, so a chain shows up on the board
    // as one card with one conversation instead of somewhere separate.
    if (path === '/api/workflows/run' && req.method === 'POST') {
      readBody(req)
        .then((body) => {
          const relative = String(body.path ?? '');
          if (!relative) return json(res, 400, { error: 'which workflow?' });
          let title = String(body.title ?? '').trim();
          try {
            const wf = loadWorkflow(join(baseDir, relative));
            if (!title) title = wf.spec.name;
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
          const task = createTask(baseDir, {
            title,
            description: String(body.description ?? ''),
            status: 'todo',
            assignee: { kind: 'workflow', name: relative },
          });
          runTask(baseDir, task.id, userInfo().username);
          json(res, 200, { ok: true, taskId: task.id });
        })
        .catch(() => json(res, 400, { error: 'bad request body' }));
      return;
    }

    /* ------------------------------------------------------------- runs */
    if (path === '/api/runs') {
      json(res, 200, listRuns(baseDir));
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const action = runMatch[2];

      if (!existsSync(runRoot(baseDir, runId))) {
        json(res, 404, { error: 'no such run' });
        return;
      }

      if (!action && req.method === 'GET') {
        json(res, 200, {
          runId,
          state: loadRunState(baseDir, runId),
          artifacts: runArtifacts(baseDir, runId),
          approvals: pendingApprovals(baseDir, runId),
          events: new Ledger(baseDir, runId).read().slice(-400),
        });
        return;
      }

      if (action === '/permission' && req.method === 'POST') {
        readBody(req)
          .then((body) => {
            const id = String(body.id ?? '');
            const status = body.status as 'allowed' | 'denied';
            if (status !== 'allowed' && status !== 'denied') {
              return json(res, 400, { error: 'status must be allowed or denied' });
            }
            const scope = body.scope === 'run' ? 'run' : 'once';
            try {
              json(res, 200, decidePermission(baseDir, runId, id, status, userInfo().username, scope, body.note as string | undefined));
            } catch (err) {
              json(res, 400, { error: (err as Error).message });
            }
          })
          .catch(() => json(res, 400, { error: 'bad request body' }));
        return;
      }

      if (action === '/decide' && req.method === 'POST') {
        readBody(req)
          .then((body) => {
            const node = String(body.node ?? '');
            const decision = body.decision as 'granted' | 'rejected';
            if (decision !== 'granted' && decision !== 'rejected') {
              return json(res, 400, { error: 'decision must be granted or rejected' });
            }
            decideApproval(baseDir, runId, node, decision, userInfo().username, body.note as string);
            new Ledger(baseDir, runId).append(
              decision === 'granted'
                ? { type: 'approval.granted', node, by: userInfo().username }
                : { type: 'approval.rejected', node, by: userInfo().username },
            );
            json(res, 200, { ok: true, approval: readApproval(baseDir, runId, node) });
          })
          .catch(() => json(res, 400, { error: 'bad request body' }));
        return;
      }
    }

    json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`));
  });
}
