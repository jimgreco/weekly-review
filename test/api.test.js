import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectWeek, stripOura } from '../src/sources.js';
import { loadConfig } from '../src/config.js';
import { createPublisher, tokenMatches, validateSubmission } from '../src/ingest.js';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { weekRange } from '../src/week.js';
import { defaultWeek } from '../src/cli.js';

const WEEK = weekRange('2026-11-02');
const TOKEN = 'routine-token-0123456789abcdef';
const SHA = createHash('sha256').update(TOKEN).digest('hex');
const SECRET = 'x'.repeat(40);

const ok = (app, data = { status: 'ok' }) => ({
  ok: true, status: 200, json: async () => ({ version: 1, app, week: { start: WEEK.start, end: WEEK.end }, generatedAt: 'x', data }),
});

const sources = () => ({
  macros: { status: 'ok' }, workouts: { status: 'ok' }, spending: { status: 'disabled' },
  checklist: { status: 'error', error: 'HTTP 500' }, planner: { status: 'no-account' },
});
const submission = (overrides = {}) => ({
  review: { week: { start: WEEK.start, end: WEEK.end }, generatedAt: '2026-11-08T23:00:00Z', sources: sources() },
  narrative: { text: 'A steady week.', model: 'claude-opus-5-5' },
  send: true,
  ...overrides,
});

test('config: reads one URL and token per app', () => {
  const config = loadConfig({ MACROS_API_URL: 'https://m.example/', MACROS_SUMMARY_TOKEN: 't' });
  assert.deepEqual(config.sources.macros, { url: 'https://m.example', token: 't' });
  assert.deepEqual(config.sources.planner, { url: null, token: null });
});

test('sources: calls each app with its own token and isolates failures', async () => {
  const calls = [];
  const config = loadConfig({
    MACROS_API_URL: 'https://m', MACROS_SUMMARY_TOKEN: 'tm',
    WORKOUTS_API_URL: 'https://w', WORKOUTS_SUMMARY_TOKEN: 'tw',
    SPENDING_API_URL: 'https://s', SPENDING_SUMMARY_TOKEN: 'ts',
    CHECKLIST_API_URL: 'https://c', CHECKLIST_SUMMARY_TOKEN: 'tc',
    // planner left unconfigured
  });
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Authorization, init.redirect]);
    if (url.startsWith('https://m')) return ok('macros', { status: 'ok', current: { calories: 2050 } });
    if (url.startsWith('https://w')) return { ok: false, status: 404 };
    if (url.startsWith('https://s')) return ok('macros'); // wrong app in envelope
    throw new Error('ECONNREFUSED');
  };
  const review = await collectWeek(config, WEEK, { fetchImpl });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['https://m/api/weekly-summary?week=2026-11-02', 'Bearer tm'],
    ['https://w/api/weekly-summary?week=2026-11-02', 'Bearer tw'],
    ['https://s/api/weekly-summary?week=2026-11-02', 'Bearer ts'],
    ['https://c/api/weekly-summary?week=2026-11-02', 'Bearer tc'],
  ]);
  assert.ok(calls.every((c) => c[2] === 'error'), 'never follows redirects with a token');
  assert.equal(review.sources.macros.status, 'ok');
  assert.equal(review.sources.macros.current.calories, 2050);
  assert.match(review.sources.workouts.error, /HTTP 404/);
  assert.equal(review.sources.spending.error, 'unexpected response shape');
  assert.equal(review.sources.checklist.error, 'ECONNREFUSED');
  assert.deepEqual(review.sources.planner, { status: 'disabled' });
  assert.deepEqual(review.week, { start: '2026-11-02', end: '2026-11-08' });
});

test('cli: default week is the current one on Sunday, else the last finished one', () => {
  // Sunday Nov 8, 6 pm New York.
  assert.equal(defaultWeek(new Date('2026-11-08T23:00:00Z'), 'America/New_York').start, '2026-11-02');
  // Monday Nov 9, 9 am New York.
  assert.equal(defaultWeek(new Date('2026-11-09T14:00:00Z'), 'America/New_York').start, '2026-11-02');
  // 1 am UTC Monday is still Sunday evening in New York.
  assert.equal(defaultWeek(new Date('2026-11-09T01:00:00Z'), 'America/New_York').start, '2026-11-02');
});

test('ingest: token must match the stored hash exactly', () => {
  assert.ok(tokenMatches(SHA, `Bearer ${TOKEN}`));
  assert.ok(!tokenMatches(SHA, `Bearer ${TOKEN}x`));
  assert.ok(!tokenMatches(SHA, TOKEN));
  assert.ok(!tokenMatches(null, `Bearer ${TOKEN}`));
  assert.ok(!tokenMatches('not-hex', `Bearer ${TOKEN}`));
});

test('ingest: validates the submission and drops unknown fields', () => {
  const clean = validateSubmission({ ...submission(), extra: 1 });
  assert.deepEqual(Object.keys(clean.review).sort(), ['generatedAt', 'narrative', 'sources', 'week']);
  assert.equal(clean.review.generatedAt, '2026-11-08T23:00:00.000Z');
  assert.equal(clean.send, true);
  const bad = (patch, re) => assert.throws(() => validateSubmission({ ...submission(), ...patch }), re);
  bad({ review: { ...submission().review, week: { start: '2026-11-03', end: '2026-11-09' } } }, /Monday/);
  bad({ review: { ...submission().review, week: { start: '2026-11-02', end: '2026-11-09' } } }, /Sunday/);
  bad({ review: { ...submission().review, sources: { ...sources(), planner: undefined } } }, /planner/);
  bad({ review: { ...submission().review, sources: { ...sources(), other: { status: 'ok' } } } }, /unknown/);
  bad({ narrative: { text: 'x'.repeat(4001) } }, /4000/);
  bad({ narrative: { text: '   ' } }, /non-empty/);
  bad({ send: 'yes' }, /send/);
  assert.equal(validateSubmission({ ...submission(), narrative: null }).review.narrative, null);
});

test('ingest: emails once per week, keeps the newest version', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'wr-')));
  const sent = [];
  const config = { linkSecret: SECRET, publicUrl: 'https://review.example', reviewEmail: 'me@example.com',
    resendApiKey: 'k', emailFrom: 'R <r@example.com>' };
  const publish = createPublisher(config, store, { sendImpl: async (m) => { sent.push(m); return {}; } });

  const first = await publish(validateSubmission(submission({ send: false })));
  assert.equal(first.sent, false);
  assert.equal(sent.length, 0);

  // Two concurrent retries: exactly one email.
  const [a, b] = await Promise.all([
    publish(validateSubmission(submission())), publish(validateSubmission(submission())),
  ]);
  assert.deepEqual([a.sent, b.sent].sort(), [false, true]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'me@example.com');
  assert.equal(sent[0].idempotencyKey, 'weekly-review-2026-11-02');
  assert.match(sent[0].text, /https:\/\/review\.example\/r\/2026-11-02\?t=/);
  assert.ok(!('url' in a), 'the private link is only sent by email');

  const updated = submission();
  updated.narrative.text = 'Revised.';
  await publish(validateSubmission(updated));
  const saved = await store.load('2026-11-02');
  assert.equal(saved.narrative.text, 'Revised.');
  assert.ok(saved.sentAt);
  assert.equal(sent.length, 1);
});

test('ingest: refuses to mark a week sent when email is not configured', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'wr-')));
  const publish = createPublisher({ linkSecret: SECRET, publicUrl: 'http://x' }, store);
  await assert.rejects(publish(validateSubmission(submission())), /not configured/);
  const saved = await store.load('2026-11-02');
  assert.equal(saved.sentAt, null, 'saved, but not marked as sent');
});

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; resolve(this); } };
    handler(req, res);
  });
}

test('http: POST /api/reviews needs the ingest token and valid JSON', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'wr-')));
  const published = [];
  const config = { linkSecret: SECRET, publicUrl: 'http://x', ingestTokenSha256: SHA };
  const handler = createHandler(config, store, { publish: async (s) => { published.push(s); return { week: s.review.week.start, sent: s.send, sentAt: null }; } });
  const json = { 'content-type': 'application/json' };
  const auth = { ...json, authorization: `Bearer ${TOKEN}` };

  assert.equal((await call(handler, { method: 'POST', url: '/api/reviews', headers: json, body: submission() })).status, 404);
  assert.equal((await call(handler, { method: 'POST', url: '/api/reviews', headers: { ...json, authorization: 'Bearer wrong-token-wrong-token' }, body: submission() })).status, 404);
  assert.equal((await call(handler, { method: 'GET', url: '/api/reviews', headers: auth })).status, 405);
  assert.equal((await call(handler, { method: 'POST', url: '/api/reviews', headers: { authorization: auth.authorization }, body: submission() })).status, 415);
  assert.equal((await call(handler, { method: 'POST', url: '/api/reviews', headers: auth, body: '{nope' })).status, 400);
  assert.equal((await call(handler, { method: 'POST', url: '/api/reviews', headers: auth, body: 'x'.repeat(600 * 1024) })).status, 413);
  const bad = await call(handler, { method: 'POST', url: '/api/reviews', headers: auth, body: { review: {} } });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /Monday/);
  assert.equal(published.length, 0);

  const good = await call(handler, { method: 'POST', url: '/api/reviews', headers: auth, body: submission() });
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(good.body), { week: '2026-11-02', sent: true, sentAt: null });
  assert.equal(published.length, 1);

  // With ingest unset, the route doesn't exist even with a token.
  const off = createHandler({ ...config, ingestTokenSha256: null }, store);
  assert.equal((await call(off, { method: 'POST', url: '/api/reviews', headers: auth, body: submission() })).status, 404);
});

test('sources: Oura-derived macros fields never reach the review', () => {
  const clean = stripOura({ status: 'ok', current: { avgCalories: 2000, sleepScore: 80, readinessScore: 70, avgSteps: 9000 },
    previous: { sleepScore: 75 }, change: { sleepScore: 5, avgCalories: -10 } });
  assert.deepEqual(clean.current, { avgCalories: 2000, sleepScore: null, readinessScore: null, avgSteps: null });
  assert.equal(clean.previous.sleepScore, null);
  assert.deepEqual(clean.change, { sleepScore: null, avgCalories: -10 });
  assert.deepEqual(stripOura({ status: 'error' }), { status: 'error' });
});

test('macros: Apple Health sleep survives the Oura strip and shows on the page', async () => {
  const { renderPage } = await import('../src/render.js');
  const day = (date) => ({ date, state: 'complete', calories: 2000, protein: 140, carbs: 200, fat: 70, fiber: 30 });
  const current = { days: WEEK.days.map(day), loggedDays: 7, completeDays: 7, avgCalories: 2000, avgProtein: 140,
    avgFiber: 30, weight: { count: 0, avg: null }, waistIn: null, sleepNights: 6, avgSleepHours: 7.2,
    sleepScore: 81, readinessScore: 77, avgSteps: 9000 };
  const macros = stripOura({ status: 'ok', targets: { calories: 2100, protein: 150, fiber: null, sleepHours: 8 },
    current, previous: { ...current, avgSleepHours: 6.8 }, change: { avgSleepHours: 0.4, sleepScore: 3 } });
  assert.equal(macros.current.avgSleepHours, 7.2);
  assert.equal(macros.current.sleepNights, 6);
  assert.equal(macros.change.avgSleepHours, 0.4);
  assert.equal(macros.current.sleepScore, null);
  assert.equal(macros.change.sleepScore, null);
  const html = renderPage({ week: WEEK, generatedAt: '2026-11-08T23:00:00Z', narrative: null,
    sources: { ...sources(), macros } });
  assert.match(html, /Sleep \/ night/);
  assert.match(html, /7\.2 h/);
  assert.match(html, /6 nights · target 8\.0 h · \+0\.4 h/);
  assert.doesNotMatch(html, /Sleep score|readiness/i);
});

test('sources: with AUTH_VIA_PROXY a URL alone is enough and no Authorization is sent', async () => {
  const config = loadConfig({ AUTH_VIA_PROXY: '1', MACROS_API_URL: 'https://m', WORKOUTS_SUMMARY_TOKEN: 'only-a-token' });
  const seen = [];
  const review = await collectWeek(config, WEEK, { fetchImpl: async (url, init) => { seen.push([url, init.headers]); return ok('macros'); } });
  assert.deepEqual(seen, [['https://m/api/weekly-summary?week=2026-11-02', { Accept: 'application/json' }]]);
  assert.equal(review.sources.macros.status, 'ok');
  assert.deepEqual(review.sources.workouts, { status: 'disabled' }, 'a token without a URL is still disabled');
  assert.equal(loadConfig({}).authViaProxy, false);
});

test('ingest: an explicit resend emails again with its own idempotency key', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'wr-')));
  const sent = [];
  const config = { linkSecret: SECRET, publicUrl: 'https://review.example', reviewEmail: 'me@example.com',
    resendApiKey: 'k', emailFrom: 'R <r@example.com>' };
  const publish = createPublisher(config, store, { sendImpl: async (m) => { sent.push(m); return {}; } });
  await publish(validateSubmission(submission()));
  assert.equal((await publish(validateSubmission(submission()))).sent, false, 'a plain retry never re-emails');
  const again = await publish(validateSubmission(submission({ resend: true })));
  assert.equal(again.sent, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].idempotencyKey, 'weekly-review-2026-11-02');
  assert.match(sent[1].idempotencyKey, /^weekly-review-2026-11-02-resend-/);
  assert.throws(() => validateSubmission(submission({ send: false, resend: true })), /resend requires send/);
  assert.throws(() => validateSubmission(submission({ resend: 'yes' })), /resend must be/);
});
