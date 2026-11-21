import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommitmentsStore } from '../src/commitments.js';
import { acceptedFor, createTasksLink, withChecks } from '../src/tasks.js';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { sign } from '../src/links.js';
import { loadConfig } from '../src/config.js';

const WEEK = '2026-11-23';
const TOKEN = 'routine-token-0123456789abcdef';
const SECRET = 'x'.repeat(40);
const quiet = { error() {} };
const config = { tasksUrl: 'https://tasks.example.com', tasksToken: 'site-to-tasks-token-0123456789' };
const record = (items, extra = {}) => ({ week: WEEK, scoredAt: null, items, ...extra });
const item = (id, decision, text = `Do ${id}`) => ({ id, text, measure: null, area: 'other', decision });

// Stands in for Task Sidekick: records each request and answers from `reply`.
function fakeTasks(reply = () => ({ status: 200, body: { week: WEEK, items: [] } })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, method: init.method ?? 'GET', auth: init.headers.Authorization, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status, body } = await reply(call, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('tasks: only accepted commitments are sent, and none once the week is scored', () => {
  const items = [item('c1', 'accepted'), item('c2', 'declined'), item('c3', null), { ...item('c4', 'accepted'), measure: 'Macrovana: 6 days', area: 'nutrition' }];
  assert.deepEqual(acceptedFor(record(items)), [
    { id: 'c1', text: 'Do c1', measure: null, area: 'other' },
    { id: 'c4', text: 'Do c4', measure: 'Macrovana: 6 days', area: 'nutrition' },
  ]);
  assert.deepEqual(acceptedFor(record(items, { scoredAt: '2026-11-29T23:00:00Z' })), []);
  assert.deepEqual(acceptedFor(null), []);
});

test('tasks: unconfigured, the link does nothing', async () => {
  const { calls, fetchImpl } = fakeTasks();
  for (const off of [{}, { tasksUrl: config.tasksUrl }, { tasksToken: config.tasksToken }]) {
    const link = createTasksLink(off, { fetchImpl });
    assert.equal(link.enabled, false);
    await link.sync(record([item('c1', 'accepted')]));
    assert.equal(await link.checks(WEEK), null);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(loadConfig({}).tasksUrl, null);
  assert.equal(loadConfig({ TASKS_API_URL: 'https://tasks.example.com/', TASKS_COMMITMENTS_TOKEN: 't' }).tasksUrl, 'https://tasks.example.com');
});

test('tasks: a change is sent with the token, retried on failure, and the newest record wins', async () => {
  let link;
  const { calls, fetchImpl } = fakeTasks((call, n) => {
    if (n > 1) return { status: 200, body: {} };
    // A second decision lands while the first send is failing: the retry takes the newest set.
    link.sync(record([item('c1', 'accepted'), item('c2', 'accepted')]));
    return { status: 502, body: null };
  });
  link = createTasksLink(config, { fetchImpl, log: quiet, retryDelaysMs: [5, 5] });
  await link.sync(record([item('c1', 'accepted')]));
  await link.sync(record([]));
  assert.equal(calls[0].url, `https://tasks.example.com/api/commitments?week=${WEEK}`);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].auth, `Bearer ${config.tasksToken}`);
  assert.equal(calls[0].redirect, 'error');
  assert.deepEqual(calls.map((c) => c.body.items.map((i) => i.id)), [['c1'], ['c1', 'c2'], []]);
});

test('tasks: a refusal is not retried, and repeated failures are given up on without throwing', async () => {
  const refused = fakeTasks(() => ({ status: 404, body: null }));
  await createTasksLink(config, { fetchImpl: refused.fetchImpl, log: quiet, retryDelaysMs: [1, 1] }).sync(record([item('c1', 'accepted')]));
  assert.equal(refused.calls.length, 1);

  const down = fakeTasks(() => { throw new Error('connect ECONNREFUSED'); });
  const errors = [];
  const link = createTasksLink(config, { fetchImpl: down.fetchImpl, log: { error: (m) => errors.push(m) }, retryDelaysMs: [1, 1] });
  await link.sync(record([item('c1', 'accepted')]));
  assert.equal(down.calls.length, 3);
  assert.match(errors.at(-1), /gave up/);
  assert.equal(await link.checks(WEEK), null);
});

test('tasks: check-offs are read back and attached to the routine\'s view', async () => {
  const { fetchImpl } = fakeTasks(() => ({ status: 200, body: { week: WEEK, items: [
    { id: 'c1', active: true, reminder: true, done: true, completedAt: '2026-11-25T14:00:00.000Z' },
    { id: 'c2', active: true, reminder: true, done: false, completedAt: null },
    { id: 'c3', active: true, reminder: false, done: false, completedAt: null },
  ] } }));
  const checks = await createTasksLink(config, { fetchImpl, log: quiet }).checks(WEEK);
  const due = { week: WEEK, items: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }] };
  assert.deepEqual(withChecks(due, checks).items, [
    { id: 'c1', checkedOff: true, checkedOffAt: '2026-11-25T14:00:00.000Z' },
    { id: 'c2', checkedOff: false, checkedOffAt: null },
    { id: 'c3', checkedOff: null, checkedOffAt: null }, // no reminder was made
    { id: 'c4', checkedOff: null, checkedOffAt: null }, // Task Sidekick has never heard of it
  ]);
  assert.deepEqual(withChecks(due, null).items.map((c) => c.checkedOff), [null, null, null, null]);
  assert.equal(withChecks(null, checks), null);

  const wrongWeek = fakeTasks(() => ({ status: 200, body: { week: '2026-11-16', items: [] } }));
  assert.equal(await createTasksLink(config, { fetchImpl: wrongWeek.fetchImpl, log: quiet }).checks(WEEK), null);
});

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ?? ''; resolve(this); } };
    handler(req, res);
  });
}

test('tasks: the site sends every change to a week and gives the routine the check-offs', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wr-tasks-'));
  const siteConfig = { ...config, dataDir, linkSecret: SECRET, publicUrl: 'https://review.example.com',
    ingestTokenSha256: createHash('sha256').update(TOKEN).digest('hex') };
  const { calls, fetchImpl } = fakeTasks((c) => (c.method === 'GET'
    ? { status: 200, body: { week: WEEK, items: [{ id: 'c1', reminder: true, done: true, completedAt: '2026-11-26T09:00:00.000Z' }] } }
    : { status: 200, body: {} }));
  const tasks = createTasksLink(siteConfig, { fetchImpl, log: quiet });
  const store = createStore(dataDir);
  const handler = createHandler(siteConfig, store, { tasks });
  const reviewWeek = '2026-11-16';
  await store.save({ week: { start: reviewWeek, end: '2026-11-22' }, generatedAt: '2026-11-22T23:00:00Z', sources: {} });

  // The same store the handler built by default would be wired this way.
  const commitments = createCommitmentsStore(dataDir, { onChange: (r) => tasks.sync(r) });
  await commitments.propose(WEEK, [{ text: 'Walk after dinner on 4 days', area: 'activity' }, { text: 'Book the dentist', area: 'home' }]);
  const decide = (id, decision) => call(handler, {
    method: 'POST', url: `/r/${reviewWeek}/commitments?t=${sign(SECRET, `review:${reviewWeek}`)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${id}&decision=${decision}`,
  });
  assert.equal((await decide('c1', 'accept')).status, 303);
  assert.equal((await decide('c2', 'accept')).status, 303);
  assert.equal((await decide('c2', 'undo')).status, 303);
  await tasks.sync(null); // nothing to send; waits for the queue
  const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.body.items.map((i) => i.text));
  assert.deepEqual(puts.at(-1), ['Walk after dinner on 4 days']);
  assert.deepEqual(puts[0], [], 'proposals alone send nothing to make');
  assert.ok(puts.some((p) => p.length === 2));

  const read = await call(handler, { url: `/api/commitments?week=${WEEK}`, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(read.status, 200);
  const due = JSON.parse(read.body).due.items;
  assert.deepEqual(due.map((c) => [c.id, c.decision, c.checkedOff, c.checkedOffAt]), [
    ['c1', 'accepted', true, '2026-11-26T09:00:00.000Z'], ['c2', null, null, null],
  ]);

  // Scoring closes the week: Task Sidekick is told to keep none.
  await commitments.score(WEEK, [{ id: 'c1', outcome: 'hit', note: null }]);
  await tasks.sync(null);
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').at(-1).body.items, []);
});
