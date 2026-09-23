import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitDecision,
  connectorKey,
  decide,
  decidePermission,
  isWrite,
  parseMcpTool,
  pendingPermissions,
  requestPermission,
} from '../src/engine/permissions.js';
import { parseMcpList } from '../src/discover.js';

const sandbox = () => mkdtempSync(join(tmpdir(), 'skillflow-perm-'));

test('an MCP tool name splits into connector and tool', () => {
  assert.deepEqual(parseMcpTool('mcp__claude_ai_CData_Connect_AI__queryData'), {
    connector: 'claude_ai_CData_Connect_AI',
    tool: 'queryData',
  });
  assert.equal(parseMcpTool('Bash'), null);
});

test('a connector name maps to the prefix its tools carry', () => {
  assert.equal(connectorKey('CData Connect AI'), 'claude_ai_CData_Connect_AI');
  assert.equal(connectorKey('Airtable'), 'claude_ai_Airtable');
  assert.equal(connectorKey('claude_ai_Airtable'), 'claude_ai_Airtable');
});

test('reads are reads and everything else is a write', () => {
  for (const read of ['list_records_for_table', 'get_table_schema', 'queryData', 'search_threads', 'getTables', 'query_email_and_calendar']) {
    assert.equal(isWrite(read), false, `${read} should be a read`);
  }
  for (const write of ['update_records_for_table', 'execute_insert', 'send_message', 'create_record', 'trash_thread', 'merge_contacts', 'do_something_unknown']) {
    assert.equal(isWrite(write), true, `${write} should be a write`);
  }
});

test('local tools are always allowed', () => {
  assert.deepEqual(decide({ connectors: [], writes: 'deny' }, 'Bash'), { kind: 'allow' });
  assert.deepEqual(decide({ connectors: [], writes: 'deny' }, 'Write'), { kind: 'allow' });
});

test('a read on any connector is allowed when none are named', () => {
  assert.deepEqual(decide({ connectors: [], writes: 'ask' }, 'mcp__claude_ai_Gmail__search_threads'), { kind: 'allow' });
});

test('a connector the task did not name is denied, even for a read', () => {
  const verdict = decide({ connectors: ['Airtable'], writes: 'allow' }, 'mcp__claude_ai_Gmail__search_threads');
  assert.equal(verdict.kind, 'deny');
});

test('a named connector is accepted in either spelling', () => {
  assert.equal(decide({ connectors: ['CData Connect AI'], writes: 'ask' }, 'mcp__claude_ai_CData_Connect_AI__queryData').kind, 'allow');
  assert.equal(decide({ connectors: ['claude_ai_CData_Connect_AI'], writes: 'ask' }, 'mcp__claude_ai_CData_Connect_AI__queryData').kind, 'allow');
});

test('a write asks, is allowed, or is denied according to policy', () => {
  const tool = 'mcp__claude_ai_Airtable__update_records_for_table';
  assert.equal(decide({ connectors: [], writes: 'ask' }, tool).kind, 'ask');
  assert.equal(decide({ connectors: [], writes: 'allow' }, tool).kind, 'allow');
  assert.equal(decide({ connectors: [], writes: 'deny' }, tool).kind, 'deny');
});

test('a pending request blocks until a person decides', async () => {
  const base = sandbox();
  const request = requestPermission(base, 'r1', 'work', 'mcp__claude_ai_Airtable__update_records_for_table', { a: 1 });
  assert.equal(pendingPermissions(base, 'r1').length, 1);

  const waiting = awaitDecision(base, 'r1', request.id, new AbortController().signal, { pollMs: 10 });
  setTimeout(() => decidePermission(base, 'r1', request.id, 'allowed', 'dilara', 'run'), 40);

  const decided = await waiting;
  assert.equal(decided.status, 'allowed');
  assert.equal(decided.scope, 'run');
  assert.equal(pendingPermissions(base, 'r1').length, 0);
});

test('cancelling the run releases a waiting request as denied', async () => {
  const base = sandbox();
  const request = requestPermission(base, 'r1', 'work', 'mcp__x__create', {});
  const abort = new AbortController();
  const waiting = awaitDecision(base, 'r1', request.id, abort.signal, { pollMs: 10 });
  setTimeout(() => abort.abort(), 30);
  assert.equal((await waiting).status, 'denied');
});

test('nobody answering in time is a denial, not a hang', async () => {
  const base = sandbox();
  const request = requestPermission(base, 'r1', 'work', 'mcp__x__create', {});
  const decided = await awaitDecision(base, 'r1', request.id, new AbortController().signal, { pollMs: 10, timeoutMs: 50 });
  assert.equal(decided.status, 'denied');
  assert.match(decided.note ?? '', /nobody answered/);
});

test('a request cannot be decided twice', () => {
  const base = sandbox();
  const request = requestPermission(base, 'r1', 'work', 'mcp__x__create', {});
  decidePermission(base, 'r1', request.id, 'denied', 'dilara');
  assert.throws(() => decidePermission(base, 'r1', request.id, 'allowed', 'dilara'), /already denied/);
});

test('claude mcp list output parses into connectors with the right keys', () => {
  const parsed = parseMcpList([
    'Checking MCP server health…',
    '[mcp-sdk] some warning line',
    'claude.ai Airtable: https://mcp.airtable.com/mcp - ✔ Connected',
    'claude.ai CData Connect AI: https://mcp.cloud.cdata.com/mcp - ✔ Connected',
    'claude.ai Harmonic: https://mcp.api.harmonic.ai - ! Needs authentication',
    'claude.ai Broken: https://x.example - ✘ Failed to connect — HTTP 404',
  ].join('\n'));
  assert.deepEqual(parsed.map((c) => [c.name, c.key, c.status]), [
    ['Airtable', 'claude_ai_Airtable', 'connected'],
    ['Broken', 'claude_ai_Broken', 'failed'],
    ['CData Connect AI', 'claude_ai_CData_Connect_AI', 'connected'],
    ['Harmonic', 'claude_ai_Harmonic', 'needs-auth'],
  ]);
});
