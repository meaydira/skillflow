import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { Ledger } from '../engine/ledger.js';
import { decideApproval, pendingApprovals, readApproval } from '../engine/approvals.js';
import { loadRunState } from '../engine/run.js';
import { listRuns } from './status.js';
import { runRoot } from '../engine/paths.js';
import type { Artifact, NodeStatus } from '../types.js';

/**
 * A local web view of the run directory.
 *
 * Deliberately small and read-mostly. The run directory stays the source of
 * truth; this reads it and adds the one thing a terminal is genuinely bad at,
 * which is reading a proposed changeset carefully and then deciding on it.
 *
 * It binds to loopback only and has no auth, because it is a window onto files
 * you already own on a machine you are already sitting at.
 */

interface NodeView {
  id: string;
  status: NodeStatus | 'running';
  costUsd: number;
  turns: number;
  artifacts: Artifact[];
  error?: string;
  tools: number;
}

function buildRunView(baseDir: string, runId: string) {
  const state = loadRunState(baseDir, runId);
  const events = new Ledger(baseDir, runId).read();

  const nodes = new Map<string, NodeView>();
  const ensure = (id: string): NodeView => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, status: 'running', costUsd: 0, turns: 0, artifacts: [], tools: 0 });
    }
    return nodes.get(id) as NodeView;
  };

  let outcome = 'running';
  for (const event of events) {
    if (event.type === 'run.completed') outcome = 'completed';
    else if (event.type === 'run.paused') outcome = 'paused';
    else if (event.type === 'run.failed') outcome = 'failed';
    if (!('node' in event)) continue;

    const view = ensure(event.node);
    if (event.type === 'node.completed') {
      view.status = 'completed';
      view.costUsd = event.costUsd;
      view.turns = event.turns;
    } else if (event.type === 'node.failed') {
      view.status = 'failed';
      view.error = event.error;
    } else if (event.type === 'node.skipped') {
      view.status = 'skipped';
    } else if (event.type === 'node.artifact') {
      view.artifacts.push(event.artifact);
    } else if (event.type === 'node.tool') {
      view.tools += 1;
    }
  }

  const waiting = pendingApprovals(baseDir, runId);
  for (const approval of waiting) ensure(approval.node).status = 'awaiting-approval';

  return {
    runId,
    workflow: state?.workflow ?? 'unknown',
    startedAt: state?.startedAt ?? '',
    inputs: state?.inputs ?? {},
    dryRun: state?.dryRun ?? false,
    outcome,
    totalCostUsd: [...nodes.values()].reduce((sum, n) => sum + n.costUsd, 0),
    nodes: [...nodes.values()],
    approvals: waiting,
    root: runRoot(baseDir, runId),
  };
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function startUi(baseDir: string, port: number): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (url.pathname === '/api/runs') {
      json(res, 200, listRuns(baseDir));
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      if (!existsSync(runRoot(baseDir, runId))) {
        json(res, 404, { error: 'no such run' });
        return;
      }
      json(res, 200, buildRunView(baseDir, runId));
      return;
    }

    const fileMatch = /^\/api\/runs\/([^/]+)\/file$/.exec(url.pathname);
    if (fileMatch) {
      const runId = decodeURIComponent(fileMatch[1]);
      const rel = url.searchParams.get('path') ?? '';
      const root = runRoot(baseDir, runId);
      const target = join(root, rel);
      // Never serve outside the run: the path comes from a query string.
      if (!target.startsWith(root) || !existsSync(target)) {
        json(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(target, 'utf8'));
      return;
    }

    const decideMatch = /^\/api\/runs\/([^/]+)\/decide$/.exec(url.pathname);
    if (decideMatch && req.method === 'POST') {
      const runId = decodeURIComponent(decideMatch[1]);
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const { node, decision, note } = JSON.parse(body) as {
            node: string;
            decision: 'granted' | 'rejected';
            note?: string;
          };
          if (decision !== 'granted' && decision !== 'rejected') {
            json(res, 400, { error: 'decision must be granted or rejected' });
            return;
          }
          decideApproval(baseDir, runId, node, decision, userInfo().username, note);
          new Ledger(baseDir, runId).append(
            decision === 'granted'
              ? { type: 'approval.granted', node, by: userInfo().username, note }
              : { type: 'approval.rejected', node, by: userInfo().username, note },
          );
          json(res, 200, { ok: true, approval: readApproval(baseDir, runId, node) });
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`));
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skillflow</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #ffffff; --line: #e4e2dd; --ink: #1c1b19;
    --muted: #6f6b64; --accent: #3b5bdb; --ok: #2b8a3e; --warn: #b8860b;
    --bad: #c92a2a; --skip: #868e96; --code: #f4f3f0;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #171614; --panel: #1f1e1b; --line: #33312c; --ink: #eceae5;
      --muted: #9c968c; --accent: #91a7ff; --ok: #69db7c; --warn: #ffd43b;
      --bad: #ff8787; --skip: #868e96; --code: #26241f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px;
    padding: 18px 24px; border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  header .sub { color: var(--muted); font-size: 13px; }
  .wrap { display: grid; grid-template-columns: 270px 1fr; min-height: calc(100vh - 61px); }
  @media (max-width: 760px) { .wrap { grid-template-columns: 1fr; } aside { border-right: 0 !important; } }
  aside { border-right: 1px solid var(--line); padding: 14px; }
  aside h2, main h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  .run { padding: 9px 11px; border-radius: 7px; cursor: pointer; margin-bottom: 3px; border: 1px solid transparent; }
  .run:hover { background: var(--panel); }
  .run.on { background: var(--panel); border-color: var(--line); }
  .run .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .run .meta { color: var(--muted); font-size: 12px; }
  main { padding: 20px 24px; max-width: 900px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 600; border: 1px solid currentColor; }
  .completed { color: var(--ok); } .paused { color: var(--warn); }
  .failed { color: var(--bad); } .running { color: var(--accent); }
  .skipped { color: var(--skip); } .awaiting-approval { color: var(--warn); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 12px; }
  .node { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .node .name { font-weight: 600; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  .node .stat { color: var(--muted); font-size: 12px; margin-left: auto; }
  .art { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); font-size: 13px; }
  .art .k { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--muted); }
  .gate { border-color: var(--warn); }
  .gate h3 { margin: 0 0 4px; font-size: 14px; }
  pre { background: var(--code); padding: 11px; border-radius: 7px; overflow-y: auto;
    font-size: 12px; line-height: 1.45; max-height: 340px;
    white-space: pre-wrap; word-break: break-word; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 7px 15px;
    border-radius: 7px; border: 1px solid var(--line); background: var(--panel);
    color: var(--ink); cursor: pointer; }
  button.go { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.no { color: var(--bad); border-color: var(--bad); }
  button:hover { filter: brightness(1.06); }
  .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
  input[type=text] { flex: 1; font: inherit; font-size: 13px; padding: 7px 10px;
    border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .empty { color: var(--muted); padding: 32px 0; }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>skillflow</h1>
  <span class="sub" id="sub">reading the run directory</span>
</header>
<div class="wrap">
  <aside><h2>Runs</h2><div id="runs"></div></aside>
  <main id="main"><div class="empty">Pick a run on the left.</div></main>
</div>
<script>
// The run id lives in the location hash, so a run is linkable: you can paste one
// at a colleague, or reopen the thing you were reviewing after a restart.
let current = decodeURIComponent(location.hash.slice(1)) || null;
// Re-rendering on every poll destroys the element under the user's cursor and
// wipes whatever they were typing. So each pane re-renders only when its data
// actually changed, and the note field's value is carried across a re-render.
let lastRuns = '';
let lastRun = '';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function loadRuns() {
  const runs = await (await fetch('/api/runs')).json();
  if (!current && runs.length > 0) current = runs[0].runId;

  const key = JSON.stringify(runs) + '|' + current;
  if (key === lastRuns) return;
  lastRuns = key;

  document.getElementById('sub').textContent =
    runs.length + (runs.length === 1 ? ' run' : ' runs');
  document.getElementById('runs').innerHTML = runs.map((r) =>
    '<div class="run' + (r.runId === current ? ' on' : '') + '" data-id="' + esc(r.runId) + '">' +
      '<div class="id">' + esc(r.runId) + '</div>' +
      '<div class="meta"><span class="pill ' + esc(r.outcome) + '">' + esc(r.outcome) + '</span> ' +
      esc(r.workflow) + '</div>' +
    '</div>').join('') || '<div class="empty">No runs yet.</div>';

  for (const el of document.querySelectorAll('.run')) {
    el.onclick = () => {
      current = el.dataset.id;
      location.hash = encodeURIComponent(current);
      lastRun = '';
      loadRuns();
      loadRun();
    };
  }
}

async function loadRun() {
  if (!current) return;
  const r = await (await fetch('/api/runs/' + encodeURIComponent(current))).json();
  const key = JSON.stringify(r);
  if (key === lastRun) return;
  lastRun = key;

  const main = document.getElementById('main');
  // Carry across anything half-typed, so a poll cannot eat a note mid-sentence.
  const drafts = {};
  for (const input of main.querySelectorAll('input[id^="note-"]')) drafts[input.id] = input.value;
  const focused = document.activeElement && document.activeElement.id;

  const gates = r.approvals.map((a) =>
    '<div class="card gate">' +
      '<h3>Waiting on you: <code>' + esc(a.node) + '</code></h3>' +
      '<div style="color:var(--muted);font-size:13px">' +
        (a.when === 'before' ? 'Held before it runs. Nothing has been written yet.'
                             : 'It ran. Its outputs are held until you decide.') +
      '</div>' +
      '<p style="margin:9px 0 0">' + esc(a.prompt) + '</p>' +
      '<pre>' + esc(a.preview || '(nothing to preview)') + '</pre>' +
      '<div class="row">' +
        '<input type="text" id="note-' + esc(a.node) + '" placeholder="note (optional)">' +
        '<button class="go" data-node="' + esc(a.node) + '" data-d="granted">Approve</button>' +
        '<button class="no" data-node="' + esc(a.node) + '" data-d="rejected">Reject</button>' +
      '</div>' +
    '</div>').join('');

  const nodes = r.nodes.map((n) => {
    const arts = n.artifacts.map((a) =>
      '<div class="art"><span class="k">' + esc(a.name) + ' [' + esc(a.kind) + ']</span><br>' +
      esc(a.summary) + '</div>').join('');
    const stat = [
      n.turns ? n.turns + ' turns' : '',
      n.costUsd ? '$' + n.costUsd.toFixed(2) : '',
      n.tools ? n.tools + ' tools' : '',
    ].filter(Boolean).join('  ');
    return '<div class="card">' +
      '<div class="node"><span class="pill ' + esc(n.status) + '">' + esc(n.status) + '</span>' +
      '<span class="name">' + esc(n.id) + '</span>' +
      '<span class="stat">' + esc(stat) + '</span></div>' +
      (n.error ? '<div class="art" style="color:var(--bad)">' + esc(n.error) + '</div>' : '') +
      arts + '</div>';
  }).join('');

  const inputs = Object.entries(r.inputs)
    .map(([k, v]) => '<code>' + esc(k) + ' = ' + esc(v) + '</code>').join(' ');

  main.innerHTML =
    '<h2>' + esc(r.workflow) + (r.dryRun ? ' (dry run)' : '') + '</h2>' +
    '<p style="margin:0 0 6px"><span class="pill ' + esc(r.outcome) + '">' + esc(r.outcome) +
      '</span> &nbsp;<span style="color:var(--muted);font-size:13px">' +
      esc(r.runId) + ' &nbsp; $' + r.totalCostUsd.toFixed(2) + '</span></p>' +
    (inputs ? '<p style="margin:0 0 16px">' + inputs + '</p>' : '<div style="height:10px"></div>') +
    gates +
    '<h2 style="margin-top:18px">Nodes</h2>' + (nodes || '<div class="empty">Nothing yet.</div>');

  for (const [id, value] of Object.entries(drafts)) {
    const input = document.getElementById(id);
    if (input) input.value = value;
  }
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus();

  for (const b of main.querySelectorAll('button[data-node]')) {
    b.onclick = async () => {
      const node = b.dataset.node;
      const note = (document.getElementById('note-' + node) || {}).value || undefined;
      b.disabled = true;
      await fetch('/api/runs/' + encodeURIComponent(current) + '/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node, decision: b.dataset.d, note }),
      });
      lastRun = '';
      loadRun();
    };
  }
}

window.addEventListener('hashchange', () => {
  const next = decodeURIComponent(location.hash.slice(1)) || null;
  if (next !== current) { current = next; lastRun = ''; loadRuns(); loadRun(); }
});

loadRuns().then(loadRun);
setInterval(() => { loadRuns(); loadRun(); }, 2500);
</script>
</body>
</html>`;
