import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekRange, currentWeek, mondayOf, previousWeek, localParts } from '../src/week.js';
import { outcomesByDate, summarizeChecklist } from '../src/sources/checklist.js';
import { summarizeSessions, _emailKey } from '../src/sources/workouts.js';
import { sign, verify } from '../src/links.js';
import { esc, renderPage, renderEmail } from '../src/render.js';
import { dueWeek, createHandler } from '../src/server.js';
import { writeNarrative } from '../src/narrative.js';
import { createStore } from '../src/store.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WEEK = weekRange('2026-10-26');
const PREV = previousWeek(WEEK);
const SECRET = 'x'.repeat(40);

test('weeks run Monday to Sunday in the review timezone', () => {
  assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // Sunday
  assert.equal(mondayOf('2026-10-26'), '2026-10-26');
  assert.deepEqual(WEEK.days.at(-1), '2026-11-01');
  // 03:00Z Monday Nov 2 is still Sunday evening in New York.
  assert.equal(currentWeek(new Date('2026-11-02T03:00:00Z'), 'America/New_York').start, '2026-10-26');
  assert.throws(() => weekRange('2026-10-27'));
  assert.deepEqual(localParts(new Date('2026-11-01T23:30:00Z'), 'America/New_York'), { date: '2026-11-01', weekday: 0, hour: 18 });
});

test('checklist: newer schedule revision wins over legacy completion', () => {
  const record = {
    completions: { '2026-10-27': { value: true }, '2026-10-28': { value: true } },
    occurrences: {
      a: { value: { scheduledDate: '2026-10-27', outcome: 'done', scheduleRevision: 0 }, stamp: 9, deviceID: 'a' },
      b: { value: { scheduledDate: '2026-10-27', outcome: 'missed', scheduleRevision: 1 }, stamp: 1, deviceID: 'a' },
      c: { value: { scheduledDate: '2026-10-29', outcome: 'skipped', scheduleRevision: 0 }, stamp: 1, deviceID: 'a' },
    },
  };
  assert.deepEqual(outcomesByDate(record), { '2026-10-27': 'missed', '2026-10-28': 'done', '2026-10-29': 'skipped' });
});

test('checklist: same revision falls back to newest stamp, then device', () => {
  const occ = (outcome, stamp, deviceID) => ({ value: { scheduledDate: '2026-10-27', outcome }, stamp, deviceID });
  assert.equal(outcomesByDate({ occurrences: { a: occ('done', 1, 'z'), b: occ('missed', 2, 'a') } })['2026-10-27'], 'missed');
  assert.equal(outcomesByDate({ occurrences: { a: occ('done', 2, 'b'), b: occ('missed', 2, 'a') } })['2026-10-27'], 'done');
});

test('checklist summary skips deleted items and flags slipping habits', () => {
  const done = (dates) => Object.fromEntries(dates.map((d) => [d, { value: true }]));
  const item = (title, dates, extra = {}) => ({ fields: { title: { value: title } }, completions: done(dates), ...extra });
  const s = summarizeChecklist({
    a: item('Read', [...PREV.days.slice(0, 3)]),
    b: item('Walk', WEEK.days),
    c: item('Gone', WEEK.days, { deleted: { stamp: 1 } }),
  }, {}, WEEK, PREV);
  assert.equal(s.doneCount, 7);
  assert.deepEqual(s.slipping, ['Read']);
  assert.equal(s.mostConsistent[0].title, 'Walk');
});

test('workouts: counts working sets, skips warmups, resolves names and groups', () => {
  const logs = [
    { date: '2026-10-27', status: 'finished', name: 'Upper A', startTime: '2026-10-27T10:00:00Z', endTime: '2026-10-27T11:10:00Z', pausedDurationMs: 600000,
      pbExerciseIds: ['e1'], exerciseItems: [{ exerciseId: 'e1', sets: [
        { reps: '8', setType: 'warmup' }, { reps: '8', completion: 'recorded' }, { reps: '', completion: 'skipped' }, { reps: '6' },
      ] }] },
    { date: '2026-10-29', status: 'skipped', exerciseItems: [] },
    { date: '2026-10-20', status: 'finished', exerciseItems: [{ exerciseId: 'e2', sets: [{ reps: '5' }] }] },
  ];
  const s = summarizeSessions(logs, { e1: { name: 'Bench', muscleGroup: 'Chest' } }, WEEK);
  assert.equal(s.sessionCount, 1);
  assert.equal(s.skippedCount, 1);
  assert.equal(s.workingSets, 2);
  assert.equal(s.sessions[0].minutes, 60);
  assert.deepEqual(s.sessions[0].personalBests, ['Bench']);
  assert.deepEqual(s.setsByMuscleGroup, { Chest: 2 });
});

test('workouts: email alias key matches the app (sha256 of trimmed lowercase email)', () => {
  assert.equal(_emailKey(' A@B.com '), _emailKey('a@b.com'));
  assert.match(_emailKey('a@b.com'), /^EMAIL#[0-9a-f]{64}$/);
});

test('links: tokens are bound to their subject', () => {
  const t = sign(SECRET, 'review:2026-10-26');
  assert.ok(verify(SECRET, 'review:2026-10-26', t));
  assert.ok(!verify(SECRET, 'review:2026-10-19', t));
  assert.ok(!verify(SECRET, 'archive', t));
  assert.ok(!verify(SECRET, 'review:2026-10-26', undefined));
  assert.throws(() => sign('short', 'x'));
});

const sampleReview = () => ({
  week: { start: WEEK.start, end: WEEK.end },
  generatedAt: '2026-11-01T23:00:00Z',
  narrative: { text: 'First <b>para</b>.\n\nSecond.' },
  sources: {
    macros: { status: 'error', error: 'boom' },
    workouts: { status: 'no-account' },
    spending: { status: 'disabled' },
    checklist: { status: 'ok', trackedItems: 1, doneCount: 3, doneCountPrev: 1, missedCount: 0, perDayDone: [],
      mostConsistent: [{ title: '<script>alert(1)</script>', done: 3 }], slipping: [], mostMissed: [] },
    planner: { status: 'ok', household: 'H', current: { taskCount: 0, doneCount: 0, openCount: 0, done: [], stuck: [], notes: null },
      nextWeek: { tasks: [], notes: null }, overdue: [] },
  },
});

test('render: escapes data and degrades per source', () => {
  const html = renderPage(sampleReview());
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<p>First &lt;b&gt;para&lt;/b&gt;.</p><p>Second.</p>'));
  assert.ok(html.includes("Couldn&#39;t read Macrovana"));
  assert.ok(!html.includes('boom')); // internal errors stay in logs
  const email = renderEmail(sampleReview(), 'https://x/r/1?t=a');
  assert.match(email.subject, /Oct 26 – Nov 1/);
  assert.ok(email.text.includes('Habits: 3 check-offs'));
  assert.equal(esc(`"'&`), '&quot;&#39;&amp;');
});

test('scheduler: due on Sunday after the send hour, once; Monday catch-up', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'wr-')));
  const config = { timezone: 'America/New_York', sendDay: 0, sendHour: 18 };
  // Sunday 17:00 New York (EST): not yet.
  assert.equal(await dueWeek(config, store, new Date('2026-11-01T22:00:00Z')), null);
  // Sunday 18:30: due for the week ending today.
  assert.equal((await dueWeek(config, store, new Date('2026-11-01T23:30:00Z'))).start, '2026-10-26');
  await store.save({ ...sampleReview(), sentAt: '2026-11-01T23:31:00Z' });
  assert.equal(await dueWeek(config, store, new Date('2026-11-02T00:30:00Z')), null);
  // Monday 9am with last week unsent: catch up.
  assert.equal((await dueWeek(config, store, new Date('2026-11-09T14:00:00Z'))).start, '2026-11-02');
  // Monday afternoon: give up on catch-up.
  assert.equal(await dueWeek(config, store, new Date('2026-11-09T18:00:00Z')), null);
});

test('http: review pages require a matching token', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'wr-')));
  await store.save(sampleReview());
  const handler = createHandler({ linkSecret: SECRET, publicUrl: 'http://x' }, store);
  const call = (url) => new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; resolve(this); } };
    handler({ method: 'GET', url }, res);
  });
  const good = await call(`/r/2026-10-26?t=${sign(SECRET, 'review:2026-10-26')}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers['Referrer-Policy'], 'no-referrer');
  assert.equal((await call('/r/2026-10-26?t=nope')).status, 404);
  assert.equal((await call(`/r/2026-10-19?t=${sign(SECRET, 'review:2026-10-19')}`)).status, 404);
  assert.equal((await call(`/r/..%2f..%2fetc?t=x`)).status, 404);
  assert.equal((await call(`/archive?t=${sign(SECRET, 'archive')}`)).status, 200);
});

test('narrative: returns text, and null on refusal or error', async () => {
  const fake = (response) => ({ beta: { messages: { create: async (params) => {
    assert.equal(params.fallbacks, 'default');
    if (response instanceof Error) throw response;
    return response;
  } } } });
  const ok = await writeNarrative(sampleReview(), { model: 'm', client: fake({
    stop_reason: 'end_turn', model: 'm', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Hi. ' }],
  }) });
  assert.deepEqual(ok, { text: 'Hi.', model: 'm' });
  assert.equal(await writeNarrative(sampleReview(), { model: 'm', client: fake({ stop_reason: 'refusal', content: [] }) }), null);
  assert.equal(await writeNarrative(sampleReview(), { model: 'm', client: fake(new Error('down')) }), null);
});
