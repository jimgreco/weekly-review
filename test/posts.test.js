import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePost, validPostKey, createPostsStore } from '../src/posts.js';
import { validateDecisions, upcoming } from '../src/decisions.js';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { archiveUrl, postUrl, sign } from '../src/links.js';
import { collectDecisions } from '../src/sources.js';
import { loadConfig } from '../src/config.js';
import { monthWeeks, previousMonth } from '../src/week.js';

const TOKEN = 'routine-token-0123456789abcdef';
const NOTES = 'notes-token-0123456789abcdefgh';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const SECRET = 'x'.repeat(40);
const tmp = () => mkdtemp(path.join(tmpdir(), 'wr-posts-'));
const decision = (over = {}) => ({ id: 'spring-plan', date: '2026-12-13', title: 'Spring plan', question: 'Start early or hold?', options: ['Start early', 'Hold'], context: 'Line one.\nLine two.', ...over });
const post = (over = {}) => ({ kind: 'pulse', key: '2026-11-16', text: '- **On track** 3 of 3 days', generatedAt: '2026-11-18T17:00:00Z', send: true, ...over });

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ?? ''; resolve(this); } };
    handler(req, res);
  });
}

async function site() {
  const dir = await tmp();
  const sent = [];
  const config = { linkSecret: SECRET, publicUrl: 'https://review.example', dataDir: dir, ingestTokenSha256: sha(TOKEN), notesTokenSha256: sha(NOTES),
    reviewEmail: 'me@example.com', resendApiKey: 'k', emailFrom: 'R <r@example.com>' };
  const store = createStore(dir);
  const handler = createHandler(config, store, { sendImpl: async (m) => { sent.push(m); return {}; } });
  const json = { 'content-type': 'application/json' };
  return { dir, config, store, handler, sent, routine: { ...json, authorization: `Bearer ${TOKEN}` }, owner: { ...json, authorization: `Bearer ${NOTES}` } };
}
const local = (url) => new URL(url).pathname + new URL(url).search;

test('months are the whole weeks that end in them', () => {
  assert.deepEqual(monthWeeks('2026-11').weeks, ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
  assert.deepEqual(monthWeeks('2027-02').weeks, ['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22']);
  assert.equal(monthWeeks('2026-11').label, 'November 2026');
  assert.equal(previousMonth('2027-01'), '2026-12');
  assert.throws(() => monthWeeks('2026-13'), /not a month/);
});

test('posts: keys and bodies are validated per kind', () => {
  assert.ok(validPostKey('pulse', '2026-11-16'));
  assert.ok(!validPostKey('pulse', '2026-11-17'));
  assert.ok(validPostKey('monthly', '2026-11'));
  assert.ok(!validPostKey('monthly', '2026-00'));
  assert.ok(validPostKey('decision', 'spring-plan'));
  assert.ok(!validPostKey('decision', '../etc'));
  assert.ok(!validPostKey('toString', 'x'));
  const clean = validatePost({ ...post(), extra: 1, model: 'm' });
  assert.deepEqual(Object.keys(clean.post).sort(), ['generatedAt', 'key', 'kind', 'model', 'text']);
  const bad = (over, re) => assert.throws(() => validatePost(post(over)), re);
  bad({ kind: 'constructor' }, /kind must be/);
  bad({ key: '2026-11-17' }, /Monday/);
  bad({ kind: 'monthly' }, /YYYY-MM/);
  bad({ text: ' ' }, /non-empty/);
  bad({ text: 'x'.repeat(1501) }, /over 1500/);
  bad({ generatedAt: 'soon' }, /timestamp/);
  bad({ send: false, resend: true }, /resend requires send/);
  assert.equal(validatePost(post({ kind: 'monthly', key: '2026-11', text: 'x'.repeat(8000) })).post.kind, 'monthly');
});

test('decisions: validation, order and the upcoming window', () => {
  const clean = validateDecisions({ decisions: [decision({ id: 'later', date: '2027-04-04', options: undefined }), decision()] });
  assert.deepEqual(clean.map((d) => d.id), ['spring-plan', 'later']);
  assert.deepEqual(clean[1].options, []);
  assert.equal(clean[0].status, 'open');
  assert.equal(clean[0].context, 'Line one.\nLine two.', 'context keeps its line breaks');
  const bad = (list, re) => assert.throws(() => validateDecisions({ decisions: list }), re);
  bad('x', /list/);
  bad([decision({ id: 'A' })], /id must be/);
  bad([decision(), decision()], /repeated/);
  bad([decision({ date: '2026-02-30' })], /YYYY-MM-DD/);
  bad([decision({ title: '' })], /title is required/);
  bad([decision({ status: 'maybe' })], /status/);
  bad([decision({ question: 'x'.repeat(401) })], /over 400/);
  assert.deepEqual(upcoming(clean, '2026-12-09', 7).map((d) => d.id), ['spring-plan']);
  assert.deepEqual(upcoming(clean, '2026-12-14', 7), []);
  assert.deepEqual(upcoming([{ ...clean[0], status: 'decided' }], '2026-12-09', 7), []);
});

test('decisions: the Mac writes, both tokens read, and briefed follows the posts', async () => {
  const { handler, routine, owner, config } = await site();
  assert.equal((await call(handler, { url: '/api/decisions' })).status, 404);
  assert.deepEqual(JSON.parse((await call(handler, { url: '/api/decisions', headers: routine })).body), { decisions: [] });
  assert.equal((await call(handler, { method: 'PUT', url: '/api/decisions', headers: routine, body: { decisions: [decision()] } })).status, 405, 'the routine cannot write');
  assert.equal((await call(handler, { method: 'PUT', url: '/api/decisions', headers: owner, body: { decisions: [decision({ id: 'X' })] } })).status, 400);
  assert.deepEqual(JSON.parse((await call(handler, { method: 'PUT', url: '/api/decisions', headers: owner, body: { decisions: [decision()] } })).body), { stored: 1 });
  const read = JSON.parse((await call(handler, { url: '/api/decisions', headers: owner })).body);
  assert.equal(read.decisions[0].briefed, false);

  // A brief for an unknown decision is refused; for a known one it is stored and emailed once.
  const brief = post({ kind: 'decision', key: 'spring-plan', text: 'The question.\n\n## What the data says\n- **Up** 1 lb' });
  assert.equal((await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: { ...brief, key: 'nope-nope' } })).status, 400);
  assert.equal((await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: brief })).status, 200);
  assert.equal(JSON.parse((await call(handler, { url: '/api/decisions', headers: routine })).body).decisions[0].briefed, true);

  const cfg = loadConfig({ REVIEW_SITE_URL: 'https://review.example', REVIEW_INGEST_TOKEN: TOKEN });
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error');
    return { ok: true, status: 200, json: async () => JSON.parse((await call(handler, { url: new URL(url).pathname, headers: { authorization: init.headers.Authorization } })).body) };
  };
  const got = await collectDecisions(cfg, '2026-12-09', 14, { fetchImpl });
  assert.equal(got.status, 'ok');
  assert.deepEqual(got.decisions.upcoming.map((d) => [d.id, d.briefed]), [['spring-plan', true]]);
  assert.equal((await collectDecisions(cfg, '2026-12-20', 14, { fetchImpl })).status, 'none');
  assert.equal((await collectDecisions(cfg, '2026-12-09', 14, { fetchImpl: async () => ({ ok: false, status: 404 }) })).status, 'error');
  assert.deepEqual(await collectDecisions(loadConfig({}), '2026-12-09', 14), { decisions: null, status: 'disabled' });
  // With the notes token unset or equal to the ingest token, the owner side is off.
  const same = createHandler({ ...config, notesTokenSha256: sha(TOKEN) }, createStore(config.dataDir));
  assert.equal((await call(same, { method: 'PUT', url: '/api/decisions', headers: routine, body: { decisions: [] } })).status, 405);
});

test('posts: stored, emailed once, and served at a private link', async () => {
  const { handler, routine, sent, config, store, dir } = await site();
  assert.equal((await call(handler, { method: 'POST', url: '/api/posts', headers: { 'content-type': 'application/json' }, body: post() })).status, 404);
  assert.equal((await call(handler, { url: '/api/posts', headers: routine })).status, 405);
  assert.equal((await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post({ key: 'x' }) })).status, 400);

  const first = JSON.parse((await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post() })).body);
  assert.equal(first.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Midweek check: Nov 16 – Nov 22');
  assert.equal(sent[0].idempotencyKey, 'weekly-review-pulse-2026-11-16');
  assert.match(sent[0].html, /<strong>On track<\/strong>/);
  // The pulse's button opens the commitments on the review that proposed them.
  assert.ok(sent[0].html.includes(`/r/2026-11-09?t=${sign(SECRET, 'review:2026-11-09')}#commitments`));

  const again = JSON.parse((await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post({ text: 'Revised <b>' }) })).body);
  assert.equal(again.sent, false);
  assert.equal(sent.length, 1);
  await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post({ resend: true }) });
  assert.equal(sent.length, 2);

  await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post({ text: 'Revised <b>', send: false }) });
  const page = await call(handler, { url: local(postUrl(config, 'pulse', '2026-11-16')) });
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Midweek check<\/h1><p>Week of Nov 16 – Nov 22<\/p>/);
  assert.match(page.body, /Revised &lt;b&gt;/);
  assert.doesNotMatch(page.body, /This week's commitments/, 'no link back when that review is not stored');
  await store.save({ week: { start: '2026-11-09', end: '2026-11-15' }, generatedAt: '2026-11-15T23:00:00Z', narrative: null, sources: {} });
  assert.match((await call(handler, { url: local(postUrl(config, 'pulse', '2026-11-16')) })).body, /This week&#39;s commitments/);

  assert.equal((await call(handler, { url: '/p/pulse/2026-11-16' })).status, 404);
  assert.equal((await call(handler, { url: `/p/pulse/2026-11-16?t=${sign(SECRET, 'post:monthly:2026-11')}` })).status, 404);
  assert.equal((await call(handler, { url: `/p/monthly/2026-11?t=${sign(SECRET, 'post:monthly:2026-11')}` })).status, 404, 'no such post yet');
  assert.equal((await call(handler, { url: `/p/constructor/2026-11?t=${sign(SECRET, 'post:constructor:2026-11')}` })).status, 404);

  await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post({ kind: 'monthly', key: '2026-10', text: 'A steady month.', send: true }) });
  assert.equal(sent.at(-1).subject, 'Your month: October 2026');
  assert.ok(sent.at(-1).html.includes(postUrl(config, 'monthly', '2026-10').replace(/&/g, '&amp;')));
  const archive = (await call(handler, { url: local(archiveUrl(config)) })).body;
  assert.match(archive, /Months<\/h2>.*October 2026/s);
  assert.match(archive, /Midweek checks<\/h2>.*Week of Nov 16 – Nov 22/s);
  assert.doesNotMatch(archive, /Decision briefs/);
  assert.deepEqual(await createPostsStore(dir).list('pulse'), ['2026-11-16']);
});

test('posts: email not configured is a 503 and the post is still stored unsent', async () => {
  const { config, routine, dir } = await site();
  const handler = createHandler({ ...config, resendApiKey: null }, createStore(dir));
  assert.equal((await call(handler, { method: 'POST', url: '/api/posts', headers: routine, body: post() })).status, 503);
  assert.equal((await createPostsStore(dir).load('pulse', '2026-11-16')).sentAt, null);
});
