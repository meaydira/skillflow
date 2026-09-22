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

/* -------------------------------------------------------------------- state */
let state = { tasks: [], skills: [], agents: [], workflows: [], runs: [] };
let view = 'board';
let openTask = null;      // task id whose sheet is open
let openDetail = null;    // its fetched detail
let lastBoardKey = '';
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
  if (view === 'board') return renderBoard(el);

  lastBoardKey = '';
  $('#title').textContent = { runs: 'Runs', workflows: 'Workflows', agents: 'Agents', skills: 'Skills' }[view];
  $('#count').textContent = '';
  $('#new').style.display = view === 'board' ? '' : 'none';

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
    t.assignee && t.assignee.name, t.activeRun]));
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
  return '<article class="card" draggable="true" data-id="' + esc(t.id) + '">' +
    '<div class="cid mono">' + esc(t.id) + '</div>' +
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
  el.innerHTML = state.workflows.length === 0
    ? '<div class="empty">No workflow files found in ./workflows or ./examples.</div>'
    : '<table class="lib">' + state.workflows.map((w) =>
        '<tr><td class="mono">' + esc(w.name) + '</td>' +
        '<td class="d">' + esc(w.description || '') + '<br><span class="chip">' +
        w.nodes + ' nodes</span> <span class="chip mono">' + esc(w.path) + '</span></td></tr>').join('') +
      '</table>';
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

  const gates = (d.approvals || []).map((a) =>
    '<div class="gate"><b>Waiting on you: <span class="mono">' + esc(a.node) + '</span></b>' +
    '<p style="margin:6px 0">' + esc(a.prompt) + '</p>' +
    '<pre>' + esc(a.preview || '(nothing to preview)') + '</pre>' +
    '<div class="actions">' +
      '<button class="btn primary" data-gate="' + esc(a.runId) + '|' + esc(a.node) + '|granted">Approve</button>' +
      '<button class="btn danger" data-gate="' + esc(a.runId) + '|' + esc(a.node) + '|rejected">Reject</button>' +
    '</div></div>').join('');

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
      '</div>' +
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
  const title = prompt('What needs doing?');
  if (!title || !title.trim()) return;
  const task = await api('/tasks', 'POST', { title: title.trim(), status: status || 'backlog' });
  lastBoardKey = '';
  await refresh();
  showTask(task.id);
}

/* -------------------------------------------------------------------- start */
for (const item of document.querySelectorAll('.nav-item')) {
  item.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('on'));
    item.classList.add('on');
    view = item.dataset.view;
    lastBoardKey = '';
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
