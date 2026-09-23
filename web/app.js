'use strict';

/* ------------------------------------------------------------------ helpers */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Minimal inline markdown: bold and code. Enough for agent summaries, no more. */
const fmt = (s) => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code class="mono">$1</code>');

const api = async (path, method, body) => {
  const res = await fetch('/api' + path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
};

const COLUMNS = [
  ['backlog', 'Backlog', '#9b968d'],
  ['todo', 'Todo', '#5c7cfa'],
  ['in_progress', 'In Progress', '#e8590c'],
  ['in_review', 'In Review', '#2b8a3e'],
  ['done', 'Done', '#3b5bdb'],
];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const initials = (n) => String(n || '?').replace(/[^a-z0-9]/gi, ' ').trim()
  .split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

/* -------------------------------------------------------------------- modal */

/**
 * Electron does not implement window.prompt(), so anything built on it works in
 * a browser and silently does nothing in the app. Everything that asks the user
 * for something goes through here instead.
 */
function modal({ title, body, confirmLabel, onConfirm, width }) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-scrim';
    host.innerHTML =
      '<div class="modal"' + (width ? ' style="width:min(' + width + 'px,100%)"' : '') + '>' +
        '<header><h3>' + esc(title) + '</h3></header>' +
        '<div class="mbody"></div>' +
        '<footer><span class="err" id="m-err"></span>' +
          '<button class="btn" id="m-cancel">Cancel</button>' +
          '<button class="btn primary" id="m-ok">' + esc(confirmLabel || 'Save') + '</button>' +
        '</footer>' +
      '</div>';
    host.querySelector('.mbody').innerHTML = body;
    document.body.appendChild(host);

    const close = (value) => { host.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    host.addEventListener('mousedown', (e) => { if (e.target === host) close(null); });
    host.querySelector('#m-cancel').onclick = () => close(null);

    host.querySelector('#m-ok').onclick = async () => {
      const ok = host.querySelector('#m-ok');
      const err = host.querySelector('#m-err');
      err.textContent = '';
      ok.disabled = true;
      try {
        const value = await onConfirm(host);
        if (value === undefined) { ok.disabled = false; return; }
        close(value);
      } catch (e) {
        err.textContent = e.message || String(e);
        ok.disabled = false;
      }
    };

    const first = host.querySelector('input, textarea, select');
    if (first) first.focus();
  });
}

/**
 * Which connectors a task or step may touch. Unchecked ones are refused
 * outright, reads included. None checked means every connected one, which is
 * the forgiving default; narrowing it is what you do for a task that should
 * never be able to see your inbox.
 */
function connectorChecks(prefix, selected) {
  selected = selected || [];
  if (state.connectors.length === 0) {
    return '<div class="hint">Looking up your connectors...</div>';
  }
  return '<div class="checks">' + state.connectors.map((c) => {
    const on = selected.includes(c.name) || selected.includes(c.key);
    const off = c.status !== 'connected';
    return '<label class="' + (off ? 'off' : '') + '" title="' + esc(c.url) + '">' +
      '<input type="checkbox" class="' + prefix + '-conn" value="' + esc(c.name) + '"' +
      (on ? ' checked' : '') + (off ? ' disabled' : '') + '> ' + esc(c.name) +
      (off ? ' <span class="st">(' + (c.status === 'needs-auth' ? 'sign in' : c.status) + ')</span>' : '') +
    '</label>';
  }).join('') + '</div>' +
  '<div class="hint" style="margin-top:5px">None ticked means any connected one.</div>';
}

function writesSelect(id, selected) {
  return '<select id="' + id + '">' + WRITE_POLICIES.map(([v, label]) =>
    '<option value="' + v + '"' + ((selected || 'ask') === v ? ' selected' : '') + '>' + label + '</option>').join('') +
  '</select>';
}

const checked = (host, cls) => [...host.querySelectorAll('input.' + cls + ':checked')].map((i) => i.value);

function runnerOptions(selected) {
  const sel = (v) => (v === selected ? ' selected' : '');
  return '<option value="claude:Claude"' + sel('claude:Claude') + '>Claude (prompt only)</option>' +
    '<optgroup label="Agents">' + state.agents.map((a) =>
      '<option value="agent:' + esc(a.name) + '"' + sel('agent:' + a.name) + '>' + esc(a.name) + '</option>').join('') +
    '</optgroup>' +
    '<optgroup label="Skills">' + state.skills.map((a) =>
      '<option value="skill:' + esc(a.name) + '"' + sel('skill:' + a.name) + '>' + esc(a.name) + '</option>').join('') +
    '</optgroup>';
}

/* -------------------------------------------------------------------- state */
let state = { tasks: [], skills: [], agents: [], workflows: [], connectors: [], runs: [] };
const WRITE_POLICIES = [
  ['ask', 'Ask me before any change'],
  ['allow', 'Allow changes without asking'],
  ['deny', 'Never change anything'],
];
let view = 'board';
let openTask = null;      // task id whose sheet is open
let openDetail = null;    // its fetched detail
let lastBoardKey = '';
let lastViewKey = '';
let lastSheetKey = '';
let dragId = null;

/* --------------------------------------------------------------------- load */
async function refresh() {
  try {
    state = await api('/state');
  } catch {
    return; // server restarting; the next poll will pick it up
  }
  $('#foot').textContent = state.skills.length + ' skills  ' + state.agents.length + ' agents';
  render();
  if (openTask) refreshSheet();
}

function render() {
  const el = $('#view');
  if (view === 'board') { lastViewKey = ''; return renderBoard(el); }

  lastBoardKey = '';
  $('#title').textContent = { runs: 'Runs', workflows: 'Workflows', agents: 'Agents', skills: 'Skills' }[view];
  $('#count').textContent = '';
  $('#new').style.display = 'none';

  // Same rule as the board: re-rendering on every poll destroys the element
  // under the cursor, so a click that lands between a poll and its re-render
  // hits a node that no longer exists. Only redraw when the data moved.
  const data = view === 'runs' ? state.runs
    : view === 'workflows' ? state.workflows
    : view === 'agents' ? state.agents : state.skills;
  const key = view + '|' + JSON.stringify(data);
  if (key === lastViewKey) return;
  lastViewKey = key;

  if (view === 'runs') return renderRuns(el);
  if (view === 'workflows') return renderWorkflows(el);
  return renderLibrary(el, view === 'agents' ? state.agents : state.skills, view === 'agents' ? 'agent' : 'skill');
}

/* -------------------------------------------------------------------- board */
function renderBoard(el) {
  $('#title').textContent = 'Board';
  $('#new').style.display = '';
  const live = state.tasks.filter((t) => t.status !== 'cancelled');
  $('#count').textContent = live.length + (live.length === 1 ? ' task' : ' tasks');

  const key = JSON.stringify(live.map((t) => [t.id, t.status, t.order, t.title, t.priority,
    t.assignee && t.assignee.name, t.activeRun, t.needsYou]));
  if (key === lastBoardKey && el.querySelector('.board')) return;
  lastBoardKey = key;

  el.className = '';
  el.innerHTML = '<div class="board">' + COLUMNS.map(([id, label, colour]) => {
    const cards = live.filter((t) => t.status === id).sort((a, b) => a.order - b.order);
    return '<section class="col" data-col="' + id + '">' +
      '<div class="col-head"><span class="dot" style="background:' + colour + '"></span>' +
      esc(label) + ' <span class="n">' + cards.length + '</span>' +
      '<button class="add" data-add="' + id + '" title="New task here">+</button></div>' +
      '<div class="col-body" data-body="' + id + '">' + cards.map(cardHtml).join('') + '</div>' +
    '</section>';
  }).join('') + '</div>';

  wireBoard();
}

/** A workflow assignee is stored as a path; show the name a human gave it. */
function assigneeLabel(a) {
  if (!a) return 'unassigned';
  if (a.kind !== 'workflow') return a.name;
  const wf = state.workflows.find((w) => w.path === a.name);
  return wf ? wf.name : a.name.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
}

function cardHtml(t) {
  const who = t.assignee
    ? '<span class="who"><span class="av' + (t.assignee.kind === 'human' ? ' human' : '') + '">' +
      esc(initials(assigneeLabel(t.assignee))) + '</span>' + esc(assigneeLabel(t.assignee)) + '</span>'
    : '<span class="who">unassigned</span>';
  return '<article class="card' + (t.needsYou ? ' needs-you' : '') + '" draggable="true" data-id="' + esc(t.id) + '">' +
    '<div class="cid mono">' + esc(t.id) +
      (t.needsYou ? ' <span class="badge">needs you</span>' : '') + '</div>' +
    '<div class="ct">' + esc(t.title) + '</div>' +
    (t.description ? '<div class="cd">' + esc(t.description) + '</div>' : '') +
    '<div class="foot">' + who +
      (t.priority !== 'none' ? '<span class="pri ' + t.priority + '">' + t.priority + '</span>' : '') +
      (t.activeRun ? '<span class="spin" title="running"></span>' : '') +
    '</div></article>';
}

function wireBoard() {
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('click', () => showTask(card.dataset.id));
    card.addEventListener('dragstart', (e) => {
      dragId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragId = null;
      clearIndicator();
    });
  }

  for (const body of document.querySelectorAll('.col-body')) {
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.closest('.col').classList.add('over');
      showIndicator(body, e.clientY);
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) body.closest('.col').classList.remove('over');
    });
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      body.closest('.col').classList.remove('over');
      const id = dragId || e.dataTransfer.getData('text/plain');
      const index = indicatorIndex(body, e.clientY);
      clearIndicator();
      if (!id) return;
      await api('/tasks/' + encodeURIComponent(id) + '/move', 'POST',
        { status: body.dataset.body, index });
      lastBoardKey = '';
      refresh();
    });
  }

  for (const add of document.querySelectorAll('.add')) {
    add.addEventListener('click', (e) => { e.stopPropagation(); newTask(add.dataset.add); });
  }
}

/** Where a drop would land, counting only the cards not being dragged. */
function indicatorIndex(body, y) {
  const cards = [...body.querySelectorAll('.card:not(.dragging)')];
  for (let i = 0; i < cards.length; i += 1) {
    const box = cards[i].getBoundingClientRect();
    if (y < box.top + box.height / 2) return i;
  }
  return cards.length;
}

function showIndicator(body, y) {
  clearIndicator();
  const line = document.createElement('div');
  line.className = 'drop-line';
  const cards = [...body.querySelectorAll('.card:not(.dragging)')];
  const at = indicatorIndex(body, y);
  if (at >= cards.length) body.appendChild(line);
  else body.insertBefore(line, cards[at]);
}

const clearIndicator = () => document.querySelectorAll('.drop-line').forEach((n) => n.remove());

/* ------------------------------------------------------------------ library */
function renderLibrary(el, items, kind) {
  el.className = 'pad';
  el.innerHTML = items.length === 0
    ? '<div class="empty">None found on this machine.</div>'
    : '<table class="lib">' + items.map((i) =>
        '<tr><td class="mono">' + esc(i.name) + '</td>' +
        '<td><span class="chip">' + esc(i.source) + '</span></td>' +
        '<td class="d">' + esc((i.description || '').slice(0, 220)) + '</td></tr>').join('') +
      '</table>';
}

function renderWorkflows(el) {
  el.className = 'pad';
  el.innerHTML =
    '<div style="display:flex;align-items:center;margin-bottom:14px">' +
      '<div style="color:var(--muted);font-size:13px">' +
        'A workflow is a chain of steps. Each step is one agent with one prompt, ' +
        'and hands what it produced to the next.' +
      '</div>' +
      '<div style="flex:1"></div>' +
      '<button class="btn primary" id="wf-new">New workflow</button>' +
    '</div>' +
    (state.workflows.length === 0
      ? '<div class="empty">No workflows yet. Build one.</div>'
      : '<table class="lib">' + state.workflows.map((w) =>
          '<tr><td class="mono">' + esc(w.name) + '</td>' +
          '<td class="d">' + esc(w.description || '') +
            '<br><span class="chip">' + w.nodes + ' steps</span> ' +
            '<span class="chip mono">' + esc(w.path) + '</span></td>' +
          '<td style="white-space:nowrap;text-align:right">' +
            '<button class="btn" data-edit="' + esc(w.path) + '">Edit</button> ' +
            '<button class="btn primary" data-run="' + esc(w.path) + '">Run</button>' +
          '</td></tr>').join('') + '</table>');

  $('#wf-new').onclick = () => workflowBuilder(null);
  for (const b of el.querySelectorAll('[data-edit]')) {
    b.onclick = async () => {
      const detail = await api('/workflows/detail?path=' + encodeURIComponent(b.dataset.edit));
      workflowBuilder(detail);
    };
  }
  for (const b of el.querySelectorAll('[data-run]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await api('/workflows/run', 'POST', { path: b.dataset.run });
        view = 'board';
        document.querySelectorAll('.nav-item').forEach((n) =>
          n.classList.toggle('on', n.dataset.view === 'board'));
        lastBoardKey = '';
        await refresh();
        showTask(res.taskId);
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    };
  }
}

/* -------------------------------------------------------- workflow builder */

/**
 * Build a chain by adding steps. Each step is a prompt plus the agent that runs
 * it, and by default follows the one above, which is what someone writing a
 * chain top to bottom means. It saves to a real workflow file.
 */
function workflowBuilder(existing) {
  let steps = existing && existing.steps.length > 0
    ? existing.steps.map((s) => ({ ...s }))
    : [{ name: '', prompt: '', runner: '', approval: null }];

  const stepHtml = (step, i) =>
    (i > 0 ? '<div class="arrow">passes its result down to</div>' : '') +
    '<div class="step" data-i="' + i + '">' +
      '<div class="step-head">' +
        '<span class="n">' + (i + 1) + '</span>' +
        '<input type="text" class="s-name" placeholder="Step name, e.g. Create accounts" value="' +
          esc(step.name || '') + '">' +
        (steps.length > 1 ? '<button class="rm" title="Remove step">&times;</button>' : '') +
      '</div>' +
      '<div class="field"><label>Who runs it</label>' +
        '<select class="s-runner">' + runnerOptions(step.runner || '') + '</select></div>' +
      '<div class="field"><label>Prompt <span class="hint">' +
        (i > 0 ? 'it will already have been handed the previous step\'s result' : 'this step starts the chain') +
        '</span></label>' +
        '<textarea class="s-prompt" placeholder="What this step should do, and what it should hand on.">' +
          esc(step.prompt || '') + '</textarea></div>' +
      '<div class="row2">' +
        '<div class="field"><label>Connectors it may use</label>' + connectorChecks('s' + i, step.connectors || []) + '</div>' +
        '<div class="field"><label>On changes</label>' + writesSelect('s-writes-' + i, step.writes || 'ask') + '</div>' +
      '</div>' +
      '<label class="toggle"><input type="checkbox" class="s-gate"' +
        (step.approval ? ' checked' : '') + '> Ask me to approve before the next step runs</label>' +
    '</div>';

  const render = (host) => {
    host.querySelector('#wf-steps').innerHTML = steps.map(stepHtml).join('');
    for (const el of host.querySelectorAll('.step')) {
      const i = Number(el.dataset.i);
      const rm = el.querySelector('.rm');
      if (rm) rm.onclick = () => { collect(host); steps.splice(i, 1); render(host); };
    }
  };

  const collect = (host) => {
    host.querySelectorAll('.step').forEach((el, i) => {
      steps[i] = {
        ...steps[i],
        name: el.querySelector('.s-name').value,
        runner: el.querySelector('.s-runner').value,
        prompt: el.querySelector('.s-prompt').value,
        connectors: checked(el, 's' + i + '-conn'),
        writes: el.querySelector('#s-writes-' + i).value,
        approval: el.querySelector('.s-gate').checked
          ? { when: 'after', prompt: 'Check this step before the next one runs.' }
          : null,
      };
    });
  };

  const body =
    '<div class="field"><label>Workflow name</label>' +
      '<input type="text" id="wf-name" placeholder="weekly-intake" value="' +
        esc(existing ? existing.name : '') + '"></div>' +
    '<div class="field"><label>What it is for <span class="hint">optional</span></label>' +
      '<input type="text" id="wf-desc" value="' + esc(existing ? existing.description || '' : '') + '"></div>' +
    '<div id="wf-steps"></div>' +
    '<button class="btn" id="wf-add" style="width:100%">Add a step</button>';

  modal({
    title: existing ? 'Edit workflow' : 'New workflow',
    body,
    width: 860,
    confirmLabel: existing ? 'Save changes' : 'Create workflow',
    onConfirm: async (host) => {
      collect(host);
      const name = host.querySelector('#wf-name').value.trim();
      if (!name) throw new Error('Give the workflow a name.');
      if (steps.some((s) => !s.prompt.trim())) throw new Error('Every step needs a prompt.');
      return api('/workflows', 'POST', {
        name,
        description: host.querySelector('#wf-desc').value,
        steps,
        path: existing ? existing.path : undefined,
      });
    },
  }).then((saved) => { if (saved) { lastBoardKey = ''; refresh(); } });

  // The modal is in the DOM by now; wire the dynamic parts.
  const host = document.querySelector('.modal-scrim');
  render(host);
  host.querySelector('#wf-add').onclick = () => {
    collect(host);
    steps.push({ name: '', prompt: '', runner: '', approval: null });
    render(host);
    // After the next paint, or the container has not grown yet and the scroll
    // lands short of the step that was just added.
    requestAnimationFrame(() => {
      const body = host.querySelector('.mbody');
      body.scrollTop = body.scrollHeight;
    });
  };
}

function renderRuns(el) {
  el.className = 'pad';
  el.innerHTML = state.runs.length === 0
    ? '<div class="empty">No runs yet.</div>'
    : '<table class="lib">' + state.runs.map((r) =>
        '<tr><td class="mono">' + esc(r.runId) + '</td>' +
        '<td><span class="chip">' + esc(r.outcome) + '</span></td>' +
        '<td class="d">' + esc(r.workflow) + '  ' + esc(String(r.startedAt).slice(0, 16).replace('T', ' ')) +
        '</td></tr>').join('') + '</table>';
}

/* -------------------------------------------------------------------- sheet */
async function showTask(id) {
  openTask = id;
  lastSheetKey = '';
  // A task is linkable, so you can paste one at someone or reopen what you were
  // reading after a restart.
  if (location.hash.slice(1) !== id) location.hash = id;
  await refreshSheet();
}

async function refreshSheet() {
  if (!openTask) return;
  let detail;
  try {
    detail = await api('/tasks/' + encodeURIComponent(openTask));
  } catch {
    return closeSheet();
  }
  const key = JSON.stringify(detail);
  // Never re-render while the person is typing into the sheet.
  const typing = document.activeElement &&
    ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName) &&
    document.activeElement.closest('.sheet');
  if (key === lastSheetKey || typing) return;
  lastSheetKey = key;
  openDetail = detail;
  drawSheet(detail);
}

function closeSheet() {
  openTask = null; openDetail = null; lastSheetKey = '';
  $('#overlay').innerHTML = '';
  if (location.hash) history.replaceState(null, '', location.pathname);
}

function drawSheet(d) {
  const t = d.task;
  const options = [
    '<option value="">Unassigned</option>',
    // A select with no option matching the stored value falls back to its
    // first one, and the next save would write that back. So every kind that
    // can be stored must be offerable here.
    '<option value="claude:Claude"' + (t.assignee && t.assignee.kind === 'claude' ? ' selected' : '') +
      '>Claude (prompt only)</option>',
    '<optgroup label="Agents">' + state.agents.map((a) =>
      '<option value="agent:' + esc(a.name) + '"' +
      (t.assignee && t.assignee.kind === 'agent' && t.assignee.name === a.name ? ' selected' : '') +
      '>' + esc(a.name) + '</option>').join('') + '</optgroup>',
    '<optgroup label="Skills">' + state.skills.map((s) =>
      '<option value="skill:' + esc(s.name) + '"' +
      (t.assignee && t.assignee.kind === 'skill' && t.assignee.name === s.name ? ' selected' : '') +
      '>' + esc(s.name) + '</option>').join('') + '</optgroup>',
    '<optgroup label="Workflows">' + state.workflows.map((w) =>
      '<option value="workflow:' + esc(w.path) + '"' +
      (t.assignee && t.assignee.kind === 'workflow' && t.assignee.name === w.path ? ' selected' : '') +
      '>' + esc(w.name) + '</option>').join('') + '</optgroup>',
    '<option value="human:me"' + (t.assignee && t.assignee.kind === 'human' ? ' selected' : '') +
      '>Me (no agent)</option>',
  ].join('');

  const perms = (d.permissions || []).map((p) =>
    '<div class="perm"><div class="ph"><span class="badge">needs you</span>' +
      '<b>' + esc((p.tool.match(/^mcp__[A-Za-z0-9_]+?__(.+)$/) || [, p.tool])[1]) + '</b>' +
      '<span class="conn">on ' + esc(p.connector.replace(/^claude_ai_/, '').replace(/_/g, ' ')) + '</span></div>' +
      '<div style="font-size:13px;color:var(--muted)">The agent wants to make this change. It is paused until you decide.</div>' +
      '<pre>' + esc(JSON.stringify(p.input, null, 2)) + '</pre>' +
      '<div class="actions">' +
        '<button class="btn primary" data-perm="' + esc(p.runId) + '|' + esc(p.id) + '|allowed|once">Allow once</button>' +
        '<button class="btn" data-perm="' + esc(p.runId) + '|' + esc(p.id) + '|allowed|run">Allow every ' +
          esc((p.tool.match(/^mcp__[A-Za-z0-9_]+?__(.+)$/) || [, p.tool])[1]) + ' this run</button>' +
        '<button class="btn danger" data-perm="' + esc(p.runId) + '|' + esc(p.id) + '|denied|once">Deny</button>' +
      '</div></div>').join('');

  const gates = (d.approvals || []).map((a) =>
    '<div class="gate"><b>Waiting on you: <span class="mono">' + esc(a.node) + '</span></b>' +
    '<p style="margin:6px 0">' + esc(a.prompt) + '</p>' +
    '<pre>' + esc(a.preview || '(nothing to preview)') + '</pre>' +
    '<div class="actions">' +
      '<button class="btn primary" data-gate="' + esc(a.runId) + '|' + esc(a.node) + '|granted">Approve</button>' +
      '<button class="btn danger" data-gate="' + esc(a.runId) + '|' + esc(a.node) + '|rejected">Reject</button>' +
    '</div></div>').join('');

  // The chain, when this task ran one: what each step made and what the next
  // step was handed. This is the difference between "five agents ran" and
  // knowing what actually moved between them.
  const flow = (d.graph || []).length > 1
    ? '<div class="sec">Steps</div><div class="flow">' + d.graph.map((n, i) =>
        (i > 0 && n.needs.length > 0
          ? '<div class="flow-edge">hands ' +
            (n.received.length > 0
              ? n.received.map((a) => '<span class="mono">' + esc(a.name) + '</span>').join(', ')
              : 'nothing yet') +
            ' to <span class="mono">' + esc(n.id) + '</span></div>'
          : '') +
        '<div class="flow-node ' + esc(n.status) + '">' +
          '<div class="fh"><span class="pri ' +
            (n.status === 'completed' ? 'low' : n.status === 'failed' ? 'urgent' : 'medium') +
            '">' + esc(n.status) + '</span>' +
            '<span class="name">' + esc(n.id) + '</span>' +
            '<span class="stat">' + (n.turns ? n.turns + ' turns  ' : '') +
              (n.costUsd ? '$' + n.costUsd.toFixed(2) : '') + '</span></div>' +
          (n.error ? '<div class="flow-out" style="color:var(--bad)">' + esc(n.error) + '</div>' : '') +
          n.produced.map((a) =>
            '<div class="flow-out"><span class="k">' + esc(a.name) + ' [' + esc(a.kind) + ']</span><br>' +
            esc(a.summary) + '</div>').join('') +
        '</div>').join('') + '</div>'
    : '';

  const thread = d.comments.length === 0
    ? '<div class="empty">Nothing yet.</div>'
    : d.comments.map((c) =>
        '<div class="msg ' + c.kind + '"><div class="mh"><b>' + esc(c.author) + '</b>' +
        '<span class="chip">' + c.kind + '</span>' +
        '<span>' + esc(String(c.createdAt).slice(11, 16)) + '</span></div>' +
        '<div class="mb">' + fmt(c.body) + '</div></div>').join('');

  const running = !!t.activeRun;
  $('#overlay').innerHTML =
    '<div class="scrim" id="scrim"></div><aside class="sheet">' +
    '<header><span class="mono" style="color:var(--muted)">' + esc(t.id) + '</span>' +
      '<div class="spacer" style="flex:1"></div>' +
      '<button class="btn" id="close">Close</button></header>' +
    '<div class="body">' +
      '<h2>' + esc(t.title) + '</h2>' +
      '<div class="meta">' +
        '<label>Status</label><select id="f-status">' + COLUMNS.map(([id, label]) =>
          '<option value="' + id + '"' + (t.status === id ? ' selected' : '') + '>' + label + '</option>').join('') +
        '</select>' +
        '<label>Assignee</label><select id="f-assignee">' + options + '</select>' +
        '<label>Priority</label><select id="f-priority">' + PRIORITIES.map((p) =>
          '<option value="' + p + '"' + (t.priority === p ? ' selected' : '') + '>' + p + '</option>').join('') +
        '</select>' +
        '<label>Locks</label><input type="text" id="f-resources" value="' +
          esc((t.resources || []).join(', ')) + '" placeholder="crm:main, airtable:appXYZ">' +
        '<label>On changes</label>' + writesSelect('f-writes', t.writes) +
      '</div>' +
      '<div class="sec">Connectors it may use</div>' + connectorChecks('f', t.connectors) +
      (perms ? '<div class="sec">Waiting on you</div>' + perms : '') +
      (gates ? '<div class="sec">Approval</div>' + gates : '') +
      '<div class="sec">Description</div>' +
      '<textarea id="f-description" placeholder="What needs doing, and what done looks like.">' +
        esc(t.description) + '</textarea>' +
      '<div class="actions">' +
        '<button class="btn primary" id="run"' + (running ? ' disabled' : '') + '>' +
          (running ? 'Running...' : 'Run with agent') + '</button>' +
        (t.status === 'in_review' ? '<button class="btn" id="done">Accept and finish</button>' : '') +
        '<button class="btn" id="save">Save</button>' +
      '</div>' +
      flow +
      '<div class="sec">Activity</div>' +
      '<div class="thread">' + thread + '</div>' +
      '<div class="sec">' + (t.status === 'in_review' ? 'Feedback' : 'Comment') + '</div>' +
      '<textarea id="f-say" placeholder="' +
        (t.status === 'in_review'
          ? 'What needs changing? Sending this back re-runs the agent with your feedback.'
          : 'Add a note for yourself or for the agent.') + '"></textarea>' +
      '<div class="actions">' +
        (t.status === 'in_review'
          ? '<button class="btn primary" id="sendback">Send back with feedback</button>'
          : '') +
        '<button class="btn" id="comment">Comment</button>' +
      '</div>' +
    '</div></aside>';

  wireSheet(t);
}

function wireSheet(t) {
  const id = encodeURIComponent(t.id);
  $('#close').onclick = closeSheet;
  $('#scrim').onclick = closeSheet;

  const save = async () => {
    await api('/tasks/' + id, 'PATCH', {
      description: $('#f-description').value,
      priority: $('#f-priority').value,
      assignee: $('#f-assignee').value,
      resources: $('#f-resources').value.split(',').map((s) => s.trim()).filter(Boolean),
      connectors: checked(document, 'f-conn'),
      writes: $('#f-writes').value,
    });
    const status = $('#f-status').value;
    if (status !== t.status) await api('/tasks/' + id + '/move', 'POST', { status });
    lastBoardKey = ''; lastSheetKey = '';
    refresh();
  };

  $('#save').onclick = save;
  $('#f-status').onchange = save;
  $('#f-assignee').onchange = save;
  $('#f-priority').onchange = save;
  $('#f-writes').onchange = save;
  for (const c of document.querySelectorAll('input.f-conn')) c.onchange = save;

  for (const b of document.querySelectorAll('[data-perm]')) {
    b.onclick = async () => {
      const [runId, id, status, scope] = b.dataset.perm.split('|');
      for (const x of b.parentElement.querySelectorAll('button')) x.disabled = true;
      await api('/runs/' + encodeURIComponent(runId) + '/permission', 'POST', { id, status, scope });
      lastSheetKey = ''; lastBoardKey = '';
      refresh();
    };
  }

  $('#run').onclick = async () => {
    $('#run').disabled = true;
    $('#run').textContent = 'Starting...';
    await save();
    try {
      await api('/tasks/' + id + '/run', 'POST', {});
    } catch (err) {
      alert(err.message);
    }
    lastSheetKey = ''; lastBoardKey = '';
    refresh();
  };

  const done = $('#done');
  if (done) done.onclick = async () => {
    await api('/tasks/' + id + '/move', 'POST', { status: 'done' });
    lastBoardKey = ''; lastSheetKey = '';
    closeSheet(); refresh();
  };

  $('#comment').onclick = async () => {
    const body = $('#f-say').value.trim();
    if (!body) return;
    await api('/tasks/' + id + '/comment', 'POST', { body });
    lastSheetKey = ''; refreshSheet();
  };

  const back = $('#sendback');
  if (back) back.onclick = async () => {
    const feedback = $('#f-say').value.trim();
    if (!feedback) return alert('Say what needs to change.');
    back.disabled = true;
    await api('/tasks/' + id + '/sendback', 'POST', { feedback });
    lastSheetKey = ''; lastBoardKey = '';
    refresh();
  };

  for (const b of document.querySelectorAll('[data-gate]')) {
    b.onclick = async () => {
      const [runId, node, decision] = b.dataset.gate.split('|');
      b.disabled = true;
      await api('/runs/' + encodeURIComponent(runId) + '/decide', 'POST', { node, decision });
      lastSheetKey = ''; refreshSheet();
    };
  }
}

/* ----------------------------------------------------------------- new task */
async function newTask(status) {
  const body =
    '<div class="field"><label>What needs doing?</label>' +
      '<input type="text" id="t-title" placeholder="Create Salesforce accounts from this week\'s intake"></div>' +
    '<div class="field"><label>Details <span class="hint">what done looks like, and anything the agent needs to know</span></label>' +
      '<textarea id="t-desc" placeholder="Be specific about what you want back, and what should happen if it cannot be done."></textarea></div>' +
    '<div class="row2">' +
      '<div class="field"><label>Assign to</label><select id="t-assignee">' +
        runnerOptions('') +
        '<optgroup label="Workflows">' + state.workflows.map((w) =>
          '<option value="workflow:' + esc(w.path) + '">' + esc(w.name) + ' (' + w.nodes + ' steps)</option>').join('') +
        '</optgroup>' +
        '<option value="human:me">Me (no agent)</option>' +
      '</select></div>' +
      '<div class="field"><label>Priority</label><select id="t-priority">' +
        PRIORITIES.map((p) => '<option value="' + p + '"' + (p === 'none' ? ' selected' : '') + '>' + p + '</option>').join('') +
      '</select></div>' +
    '</div>' +
    '<div class="field"><label>Connectors it may use</label>' + connectorChecks('t', []) + '</div>' +
    '<div class="field"><label>When it wants to change something</label>' + writesSelect('t-writes', 'ask') + '</div>' +
    '<label class="toggle"><input type="checkbox" id="t-run"> Start it straight away</label>';

  const created = await modal({
    title: 'New task',
    body,
    confirmLabel: 'Create',
    onConfirm: async (host) => {
      const title = host.querySelector('#t-title').value.trim();
      if (!title) throw new Error('Give it a title.');
      const assignee = host.querySelector('#t-assignee').value;
      const startNow = host.querySelector('#t-run').checked;
      if (startNow && (!assignee || assignee.startsWith('human:'))) {
        throw new Error('Pick an agent, a skill or a workflow to start it.');
      }

      const task = await api('/tasks', 'POST', {
        title,
        description: host.querySelector('#t-desc').value,
        status: startNow ? 'todo' : (status || 'backlog'),
        connectors: checked(host, 't-conn'),
        writes: host.querySelector('#t-writes').value,
      });
      await api('/tasks/' + encodeURIComponent(task.id), 'PATCH', {
        assignee,
        priority: host.querySelector('#t-priority').value,
      });
      if (startNow) await api('/tasks/' + encodeURIComponent(task.id) + '/run', 'POST', {});
      return task;
    },
  });

  if (!created) return;
  lastBoardKey = '';
  await refresh();
  showTask(created.id);
}

/* -------------------------------------------------------------------- start */
for (const item of document.querySelectorAll('.nav-item')) {
  item.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('on'));
    item.classList.add('on');
    view = item.dataset.view;
    lastBoardKey = '';
    lastViewKey = '';
    render();
  };
}
$('#new').onclick = () => newTask('backlog');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && id !== openTask) showTask(id);
  else if (!id && openTask) closeSheet();
});

refresh().then(() => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) showTask(id);
});
setInterval(refresh, 2500);
