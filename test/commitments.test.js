import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommitmentsStore, validateCommitments, tally, forRoutine, CommitmentConflict, InvalidCommitments } from '../src/commitments.js';
import { createPublisher, validateSubmission } from '../src/ingest.js';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { sign } from '../src/links.js';
import { renderEmail, renderPage } from '../src/render.js';
import { collectCommitments } from '../src/sources.js';
import { loadConfig } from '../src/config.js';
import { weekRange } from '../src/week.js';

const WEEK = weekRange('2026-11-02'); // the review week
const NEXT = '2026-11-09'; // the week its commitments are for
const TOKEN = 'routine-token-0123456789abcdef';
const SHA = createHash('sha256').update(TOKEN).digest('hex');
const SECRET = 'x'.repeat(40);

const sources = () => ({
  macros: { status: 'disabled' }, workouts: { status: 'disabled' }, spending: { status: 'disabled' },
  checklist: { status: 'disabled' }, planner: { status: 'disabled' },
});
const review = (start = WEEK.start) => ({ week: { start, end: weekRange(start).end }, generatedAt: '2026-11-08T23:00:00Z', sources: sources() });
const proposals = () => [
  { text: 'Protein at least 140 g on 6 days', measure: 'Macrovana: 6+ Complete days at 140 g or more', area: 'nutrition' },
  { text: 'Wine on at most 2 nights', area: 'nutrition' },
  { text: 'Finish all 4 lifting sessions', measure: 'Rep, Mix, Burn: 4 finished sessions', area: 'training' },
];
const tmp = () => mkdtemp(path.join(tmpdir(), 'wr-commit-'));

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ?? ''; resolve(this); } };
    handler(req, res);
  });
}

test('commitments: validation cleans text and rejects bad shapes', () => {
  const clean = validateCommitments({
    results: [{ id: 'c1', outcome: 'hit', note: ' 6 of 7\ndays ' }],
    next: [{ text: '  Walk 8k\tsteps  ', extra: 1 }],
  });
  assert.deepEqual(clean.results, [{ id: 'c1', outcome: 'hit', note: '6 of 7 days' }]);
  assert.deepEqual(clean.next, [{ text: 'Walk 8k steps', measure: null, area: 'other' }]);
  assert.deepEqual(validateCommitments({}), { results: [], next: [] });

  const bad = (body, re) => assert.throws(() => validateCommitments(body), (e) => e instanceof InvalidCommitments && re.test(e.message));
  bad([], /object/);
  bad({ next: 'x' }, /list/);
  bad({ next: Array.from({ length: 6 }, (_, i) => ({ text: `t${i}` })) }, /more than 5/);
  bad({ next: [{ text: '' }] }, /text is required/);
  bad({ next: [{ text: 'x'.repeat(201) }] }, /over 200/);
  bad({ next: [{ text: 'a' }, { text: 'A' }] }, /repeats/);
  bad({ next: [{ text: 'a', area: 'sleep' }] }, /area/);
  bad({ results: [{ id: 'x1', outcome: 'hit' }] }, /c1-c9/);
  bad({ results: [{ id: 'c1', outcome: 'won' }] }, /outcome/);
  bad({ results: [{ id: 'c1', outcome: 'hit' }, { id: 'c1', outcome: 'miss' }] }, /repeated/);
  assert.throws(() => validateSubmission({ review: review(), commitments: { next: [{ text: '' }] } }), /text is required/);
  assert.equal(validateSubmission({ review: review() }).commitments, null);
});

test('commitments: propose, decide, score, and the follow-through history', async () => {
  const store = createCommitmentsStore(await tmp());
  assert.equal(await store.load(NEXT), null);
  const record = await store.propose(NEXT, validateCommitments({ next: proposals() }).next);
  assert.deepEqual(record.items.map((c) => [c.id, c.decision]), [['c1', null], ['c2', null], ['c3', null]]);
  assert.equal(record.proposedIn, WEEK.start);

  await store.decide(NEXT, 'c1', 'accepted');
  await store.decide(NEXT, 'c2', 'declined');
  await store.decide(NEXT, 'c3', 'accepted');
  await store.decide(NEXT, 'c3', null); // undo
  await store.decide(NEXT, 'c3', 'accepted');
  await assert.rejects(store.decide(NEXT, 'c9', 'accepted'), CommitmentConflict);
  await assert.rejects(store.decide(NEXT, 'c1', 'maybe'), CommitmentConflict);
  await assert.rejects(store.decide('2026-11-10', 'c1', 'accepted'), /not a Monday/);

  // A re-publish keeps decisions for unchanged text and renumbers the rest.
  const again = await store.propose(NEXT, [{ text: 'A new one', area: 'home' }, ...proposals().slice(0, 2)]);
  assert.deepEqual(again.items.map((c) => [c.id, c.text.slice(0, 7), c.decision]),
    [['c1', 'A new o', null], ['c2', 'Protein', 'accepted'], ['c3', 'Wine on', 'declined']]);
  await store.propose(NEXT, proposals());
  await store.decide(NEXT, 'c1', 'accepted');
  await store.decide(NEXT, 'c3', 'accepted');

  // Scoring: only accepted ids count; an accepted one with no result is "unknown".
  const scored = await store.score(NEXT, [{ id: 'c1', outcome: 'hit', note: '6 days' }, { id: 'c2', outcome: 'hit' }, { id: 'c7', outcome: 'miss' }]);
  assert.deepEqual(scored, { scored: 1, ignored: 2 });
  const after = await store.load(NEXT);
  assert.deepEqual(after.items.map((c) => c.outcome), ['hit', null, 'unknown']);
  assert.deepEqual(tally(after), { proposed: 3, accepted: 2, declined: 1, scored: true, hit: 1, partial: 0, miss: 0, unknown: 1 });
  assert.deepEqual(Object.keys(forRoutine(after).items[0]), ['id', 'text', 'measure', 'area', 'decision', 'outcome', 'note']);

  // A scored week is closed: no more decisions, and a re-propose leaves it alone.
  await assert.rejects(store.decide(NEXT, 'c2', 'accepted'), /already been scored/);
  assert.equal((await store.propose(NEXT, [{ text: 'Different' }])).items.length, 3);
  // A re-publish can re-score.
  await store.score(NEXT, [{ id: 'c1', outcome: 'partial' }, { id: 'c3', outcome: 'miss' }]);
  assert.deepEqual((await store.load(NEXT)).items.map((c) => c.outcome), ['partial', null, 'miss']);

  assert.deepEqual(await store.score('2026-11-16', [{ id: 'c1', outcome: 'hit' }]), { scored: 0, ignored: 1 });
  assert.deepEqual(await store.history('2026-11-16', 8), [{ week: NEXT, proposed: 3, accepted: 2, declined: 1, scored: true, hit: 0, partial: 1, miss: 1, unknown: 0 }]);
  assert.deepEqual(await store.history(NEXT, 8), [], 'history excludes the week itself');
});

test('commitments: publish scores this week and proposes next, and survives a re-publish', async () => {
  const dir = await tmp();
  const store = createStore(dir);
  const commitments = createCommitmentsStore(dir);
  const sent = [];
  const config = { linkSecret: SECRET, publicUrl: 'https://review.example', reviewEmail: 'me@example.com', resendApiKey: 'k', emailFrom: 'R <r@example.com>' };
  const publish = createPublisher(config, store, { commitments, sendImpl: async (m) => { sent.push(m); return {}; } });

  const first = await publish(validateSubmission({ review: review(), commitments: { next: proposals() }, send: true }));
  assert.deepEqual(first.commitments, { scored: 0, ignored: 0, proposed: 3 });
  assert.match(sent[0].html, /choose your commitments/);
  assert.ok(!('commitments' in (await store.load(WEEK.start))), 'commitments are not copied into the stored review');

  await commitments.decide(NEXT, 'c1', 'accepted');
  await publish(validateSubmission({ review: review(), commitments: { next: proposals() } })); // routine retry
  assert.equal((await commitments.load(NEXT)).items[0].decision, 'accepted');

  // The following Sunday: score NEXT, propose the week after.
  const second = await publish(validateSubmission({ review: review(NEXT),
    commitments: { results: [{ id: 'c1', outcome: 'hit' }, { id: 'c2', outcome: 'miss' }], next: [{ text: 'Keep it going' }] } }));
  assert.deepEqual(second.commitments, { scored: 1, ignored: 1, proposed: 1 });
  assert.equal((await commitments.load('2026-11-16')).proposedIn, NEXT);

  // Without commitments in the submission nothing is touched.
  const plain = await publish(validateSubmission({ review: review(NEXT) }));
  assert.ok(!('commitments' in plain));
  assert.equal((await commitments.load('2026-11-16')).items.length, 1);
  assert.doesNotMatch(renderEmail(review(), 'https://x').html, /choose your commitments/);
});

test('commitments: the routine reads due commitments and history with the ingest token', async () => {
  const dir = await tmp();
  const commitments = createCommitmentsStore(dir);
  const handler = createHandler({ linkSecret: SECRET, publicUrl: 'https://review.example', ingestTokenSha256: SHA, dataDir: dir }, createStore(dir), { commitments });
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await call(handler, { url: `/api/commitments?week=${NEXT}` })).status, 404);
  assert.equal((await call(handler, { method: 'POST', url: `/api/commitments?week=${NEXT}`, headers: auth })).status, 405);
  assert.equal((await call(handler, { url: '/api/commitments?week=2026-11-10', headers: auth })).status, 400);
  assert.deepEqual(JSON.parse((await call(handler, { url: `/api/commitments?week=${NEXT}`, headers: auth })).body), { week: NEXT, due: null, history: [] });

  await commitments.propose(NEXT, proposals());
  await commitments.decide(NEXT, 'c2', 'accepted');
  const body = JSON.parse((await call(handler, { url: `/api/commitments?week=${NEXT}`, headers: auth })).body);
  assert.equal(body.due.items[1].decision, 'accepted');
  assert.equal(body.due.scored, false);
  assert.ok(!('decidedAt' in body.due.items[1]));

  const config = loadConfig({ REVIEW_SITE_URL: 'https://review.example', REVIEW_INGEST_TOKEN: TOKEN });
  const seen = [];
  const got = await collectCommitments(config, weekRange(NEXT), { fetchImpl: async (url, init) => {
    seen.push([url, init.headers.Authorization, init.redirect]);
    return { ok: true, status: 200, json: async () => body };
  } });
  assert.deepEqual(seen, [[`https://review.example/api/commitments?week=${NEXT}`, `Bearer ${TOKEN}`, 'error']]);
  assert.equal(got.status, 'ok');
  assert.equal(got.summary, '1 accepted of 3 proposed');
  assert.equal(got.commitments.due.items.length, 3);
  assert.equal((await collectCommitments(config, weekRange(NEXT), { fetchImpl: async () => ({ ok: false, status: 404 }) })).status, 'error');
  assert.equal((await collectCommitments(config, weekRange(NEXT), { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ week: NEXT, due: null, history: [] }) }) })).status, 'none');
  assert.deepEqual(await collectCommitments(loadConfig({}), weekRange(NEXT)), { commitments: null, status: 'disabled' });
});

test('commitments: accept and decline from the review page with the link token', async () => {
  const dir = await tmp();
  const store = createStore(dir);
  const commitments = createCommitmentsStore(dir);
  const config = { linkSecret: SECRET, publicUrl: 'https://review.example', dataDir: dir };
  const handler = createHandler(config, store, { commitments });
  await store.save(review());
  await commitments.propose(NEXT, proposals());
  const t = sign(SECRET, `review:${WEEK.start}`);
  const page = `/r/${WEEK.start}?t=${t}`;
  const action = `/r/${WEEK.start}/commitments?t=${t}`;
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const post = (body, headers = {}, url = action) => call(handler, { method: 'POST', url, headers: { ...form, ...headers }, body });

  let html = (await call(handler, { url: page })).body;
  assert.match(html, /Commitments for the coming week/);
  assert.ok(html.includes(`action="/r/${WEEK.start}/commitments?t=${t}"`));
  assert.equal(html.match(/>Accept</g).length, 3);
  assert.doesNotMatch(html, /Last week(&#39;|')s commitments/);

  const ok = await post('id=c1&decision=accept', { origin: 'null' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.Location, `https://review.example${page}#commitments`);
  assert.equal((await post('id=c2&decision=decline', { origin: 'https://review.example' })).status, 303);
  assert.deepEqual((await commitments.load(NEXT)).items.map((c) => c.decision), ['accepted', 'declined', null]);
  html = (await call(handler, { url: page })).body;
  assert.equal(html.match(/>Accept</g).length, 1);
  assert.equal(html.match(/>Change</g).length, 2);
  assert.match(html, /1 accepted\./);

  assert.equal((await post('id=c1&decision=undo')).status, 303);
  assert.equal((await commitments.load(NEXT)).items[0].decision, null);

  // Refusals: wrong or missing token, another origin, bad bodies, wrong method.
  assert.equal((await post('id=c1&decision=accept', {}, `/r/${WEEK.start}/commitments?t=nope`)).status, 404);
  assert.equal((await post('id=c1&decision=accept', {}, `/r/${WEEK.start}/commitments`)).status, 404);
  assert.equal((await post('id=c1&decision=accept', {}, `/r/${NEXT}/commitments?t=${t}`)).status, 404);
  assert.equal((await post('id=c1&decision=accept', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('id=c1&decision=maybe')).status, 400);
  assert.equal((await call(handler, { method: 'POST', url: action, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await post(`id=c1&decision=accept&pad=${'x'.repeat(5000)}`)).status, 400);
  assert.equal((await call(handler, { url: action })).status, 405);
  assert.equal((await post('id=c9&decision=accept')).status, 303, 'an unknown id just returns to the page');
  assert.deepEqual((await commitments.load(NEXT)).items.map((c) => c.decision), [null, 'declined', null]);
  // A valid token for a week with no stored review.
  assert.equal((await post('id=c1&decision=accept', {}, `/r/2026-10-26/commitments?t=${sign(SECRET, 'review:2026-10-26')}`)).status, 404);

  // Once scored, the week is closed and the next review shows the scorecard.
  await commitments.decide(NEXT, 'c1', 'accepted');
  await commitments.decide(NEXT, 'c3', 'accepted');
  await commitments.score(NEXT, [{ id: 'c1', outcome: 'hit', note: '6 of 7 days <ok>' }, { id: 'c3', outcome: 'miss' }]);
  assert.equal((await post('id=c2&decision=accept')).status, 303);
  assert.equal((await commitments.load(NEXT)).items[1].decision, 'declined');
  html = (await call(handler, { url: page })).body;
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /This week has been scored/);

  await store.save(review(NEXT));
  html = (await call(handler, { url: `/r/${NEXT}?t=${sign(SECRET, `review:${NEXT}`)}` })).body;
  assert.match(html, /Last week(&#39;|')s commitments/);
  assert.match(html, /1\/2/);
  assert.match(html, /6 of 7 days &lt;ok&gt;/);
  assert.match(html, /class="badge miss">Missed/);
  assert.doesNotMatch(html, /Wine on at most/, 'declined commitments are not on the scorecard');
  assert.doesNotMatch(html, /Commitments for the coming week/);

  assert.deepEqual((await readdir(path.join(dir, 'commitments'))).sort(), [`${NEXT}.json`]);
});

test('commitments: text is escaped and a bad record costs only its own section', () => {
  const base = { ...review(), narrative: null };
  const html = renderPage(base, { decideHref: '/r/x/commitments?t="><script>',
    commitments: { next: { items: [{ id: 'c1', text: '<img src=x>', measure: '"q"', area: 'nope', decision: null }] } } });
  assert.match(html, /&lt;img src=x&gt;/);
  assert.ok(!html.includes('<img src=x>') && !html.toLowerCase().includes('<script'), 'no markup from the data or the href');
  assert.match(html, /Other<\/span>/);
  const broken = renderPage(base, { commitments: { due: { items: [{ decision: 'accepted' }, null] } } });
  assert.match(broken, /Nutrition &amp; recovery/);
  assert.match(renderPage(base), /Nutrition &amp; recovery/);
});
