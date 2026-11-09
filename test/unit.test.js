import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekRange, currentWeek, mondayOf, previousWeek, localParts } from '../src/week.js';
import { sign, verify } from '../src/links.js';
import { esc, renderPage, renderEmail } from '../src/render.js';
import { createHandler } from '../src/server.js';
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


test('render: an "ok" source with a broken shape costs only its own section', () => {
  const review = sampleReview();
  review.sources.macros = { status: 'ok' }; // no .current
  review.sources.spending = { status: 'ok', current: null };
  const html = renderPage(review);
  assert.ok(html.includes("Couldn&#39;t display Macrovana this week."));
  assert.ok(html.includes("Couldn&#39;t display Spending this week."));
  assert.ok(html.includes('&lt;script&gt;'), 'other sections still render');
  const email = renderEmail(review, 'https://x/r/1?t=a');
  assert.ok(email.text.includes('Habits: 3 check-offs'));
  assert.ok(!email.text.includes('Nutrition:'));
});
