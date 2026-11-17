import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createCommitmentsStore } from '../src/commitments.js';
import { createPostsStore } from '../src/posts.js';
import { createDecisionsStore } from '../src/decisions.js';
import { createNotesStore } from '../src/notes.js';
import { decisionId } from '../src/home.js';
import { sessionKey, signSession, SESSION_COOKIE } from '../src/summaries.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'x'.repeat(40);
const ORIGIN = 'https://review.example';
const NOW = Date.parse('2026-11-18T17:00:00Z'); // Wednesday of the week of Nov 16
const WEEK = '2026-11-16';
const NEXT = '2026-11-23';

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ?? ''; resolve(this); } };
    handler(req, res);
  });
}

async function site(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wr-home-'));
  const config = loadConfig({ LINK_SECRET: SECRET, PUBLIC_URL: ORIGIN, DATA_DIR: dataDir, GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    SUMMARIES_ALLOWED_EMAILS: 'owner@example.com', ...env });
  const stores = { store: createStore(dataDir), commitments: createCommitmentsStore(dataDir), posts: createPostsStore(dataDir),
    decisions: createDecisionsStore(dataDir), notes: createNotesStore(dataDir) };
  const { store, ...rest } = stores;
  const handler = createHandler(config, store, { ...rest, now: () => NOW });
  const cookie = signSession(sessionKey(SECRET), 'owner@example.com', NOW);
  const csrf = createHmac('sha256', sessionKey(SECRET)).update(`form:${cookie}`).digest('base64url');
  const headers = { cookie: `${SESSION_COOKIE}=${cookie}` };
  const post = (url, fields, extra = {}) => call(handler, { method: 'POST', url,
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ csrf, ...fields }).toString() });
  return { ...stores, config, handler, headers, csrf, post, get: (url) => call(handler, { url, headers }) };
}
const proposals = [{ text: 'Protein on 6 days', measure: 'App: 6 days', area: 'nutrition' }, { text: 'Four sessions', area: 'training' }];
const fields = (over = {}) => ({ title: 'Spring plan', date: '2026-12-13', question: 'Start early or hold?', options: 'Start early\r\n\r\n Hold ', context: 'Line one.\r\nLine two.', status: 'open', outcome: '', ...over });

test('home: needs the sign-in session, and is off when sign-in is off', async () => {
  const { handler, headers, post } = await site();
  for (const url of ['/home', '/decisions', '/decisions/new', '/decisions/spring-plan']) {
    const res = await call(handler, { url });
    assert.equal(res.status, 303, url);
    assert.equal(res.headers.Location, '/summaries/login');
  }
  assert.equal((await call(handler, { url: '/' })).headers.Location, '/home');
  assert.equal((await call(handler, { method: 'POST', url: '/home/commitments', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'id=c1' })).status, 403);
  assert.equal((await call(handler, { url: '/home', headers: { cookie: `${SESSION_COOKIE}=forged.value` } })).status, 303);
  // Signed in, but no form token, a wrong one, or another site's Origin.
  assert.equal((await call(handler, { method: 'POST', url: '/decisions/new', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' })).status, 403);
  assert.equal((await post('/decisions/new', { ...fields(), csrf: 'nope' })).status, 403);
  assert.equal((await post('/decisions/new', fields(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(handler, { method: 'PUT', url: '/home', headers })).status, 405);
  assert.equal((await post('/home', {})).status, 405);
  const page = await call(handler, { url: '/home', headers });
  assert.equal(page.status, 200);
  assert.match(page.headers['Content-Security-Policy'], /form-action 'self'/);
  assert.equal(page.headers['Cache-Control'], 'no-store');

  const off = await site({ GOOGLE_CLIENT_ID: '' });
  assert.equal((await off.get('/home')).status, 404);
  assert.equal((await off.post('/decisions/new', fields())).status, 404);
});

test('home: shows and decides commitments, follow-through, latest pieces and the archive', async () => {
  const s = await site();
  let html = (await s.get('/home')).body;
  assert.match(html, /None yet\. The next Sunday review proposes them/);
  assert.match(html, /No open decisions ahead/);

  await s.store.save({ week: { start: '2026-11-09', end: '2026-11-15' }, generatedAt: '2026-11-15T23:00:00Z', narrative: null, sources: {} });
  await s.commitments.propose('2026-11-09', proposals);
  await s.commitments.decide('2026-11-09', 'c1', 'accepted');
  await s.commitments.decide('2026-11-09', 'c2', 'accepted');
  await s.commitments.score('2026-11-09', [{ id: 'c1', outcome: 'hit' }, { id: 'c2', outcome: 'miss' }]);
  await s.commitments.propose(WEEK, proposals);
  await s.posts.save({ kind: 'pulse', key: WEEK, title: 'Midweek check', subtitle: 'Week of Nov 16 – Nov 22', text: 'x', generatedAt: '2026-11-18T17:00:00Z' });
  await s.posts.save({ kind: 'monthly', key: '2026-10', title: 'October 2026', subtitle: 'Your month in review', text: 'x', generatedAt: '2026-11-01T22:00:00Z' });
  await s.posts.save({ kind: 'checkin', key: '2026-11-14', title: 'Nutrition & training check-in', subtitle: 'Week ending Friday, November 13, 2026', text: 'x', generatedAt: '2026-11-14T14:00:00Z' });
  await s.notes.save('2026-11-09', 'claude-code', { text: 'Built things', generatedAt: '2026-11-15T22:00:00Z' });
  await s.decisions.save([{ id: 'old-one', date: '2026-11-01', title: 'Old <one>', question: 'Q?', options: [], context: null, status: 'open', outcome: null },
    { id: 'spring-plan', date: '2026-12-13', title: 'Spring plan', question: 'Start early or hold?', options: [], context: null, status: 'open', outcome: null }]);

  html = (await s.get('/home')).body;
  assert.match(html, /This week&#39;s commitments · Nov 16 – Nov 22/);
  assert.equal(html.match(/>Accept</g).length, 2);
  assert.ok(html.includes(`name="week" value="${WEEK}"`) && html.includes(`name="csrf" value="${s.csrf}"`));
  assert.match(html, /Kept<\/div><div class="value">1\/2/);
  assert.match(html, /Nov 9 – Nov 15<\/span><span class="muted">1 hit · 1 missed of 2/);
  assert.match(html, /Nov 16 – Nov 22<\/span><span class="muted">2 proposed, none accepted/);
  assert.match(html, /Week of Nov 9 – Nov 15<\/a><span class="muted">Weekly review/);
  assert.match(html, /October 2026<\/a><span class="muted">Month/);
  assert.match(html, /href="\/summaries\/2026-11-09"/);
  assert.match(html, /Spring plan<\/span><span class="muted">Sun, Dec 13, 2026/);
  assert.doesNotMatch(html, /Old &lt;one&gt;<\/span><span class="muted">Sun, Nov 1/, 'a decision past its date is not "coming up"');
  assert.match(html, /All decisions \(2 open\)/);
  assert.match(html, /Midweek checks \(1\)/);
  assert.match(html, /Week ending Friday, November 13, 2026<\/a><span class="muted">Nutrition &amp; training check-in/);
  assert.match(html, /Nutrition &amp; training check-ins \(1\)/);

  const accepted = await s.post('/home/commitments', { week: WEEK, id: 'c1', decision: 'accept' }, { origin: ORIGIN });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.Location, '/home#commitments');
  await s.post('/home/commitments', { week: WEEK, id: 'c2', decision: 'decline' });
  assert.deepEqual((await s.commitments.load(WEEK)).items.map((c) => c.decision), ['accepted', 'declined']);
  await s.post('/home/commitments', { week: WEEK, id: 'c2', decision: 'undo' });
  assert.equal((await s.commitments.load(WEEK)).items[1].decision, null);
  assert.equal((await s.post('/home/commitments', { week: '2026-11-17', id: 'c1', decision: 'accept' })).status, 400);
  assert.equal((await s.post('/home/commitments', { week: WEEK, id: 'c1', decision: 'maybe' })).status, 400);
  assert.equal((await s.post('/home/commitments', { week: '2026-11-09', id: 'c1', decision: 'decline' })).status, 303, 'a scored week is left alone');
  assert.equal((await s.commitments.load('2026-11-09')).items[0].decision, 'accepted');

  // After Sunday's review proposes the following week, both show; the scored one becomes a scorecard.
  await s.commitments.propose(NEXT, [{ text: 'Walk daily' }]);
  await s.commitments.score(WEEK, [{ id: 'c1', outcome: 'hit', note: '6 of 7' }]);
  html = (await s.get('/home')).body;
  assert.match(html, /id="commitments"><h2>Next week&#39;s commitments · Nov 23 – Nov 29/);
  assert.match(html, /id="this-week"><h2>This week&#39;s commitments · Nov 16 – Nov 22/);
  assert.match(html, /6 of 7/);
  assert.ok(html.includes(`name="week" value="${NEXT}"`) && !html.includes(`name="week" value="${WEEK}"`));
});

test('decisions: add, edit and record an outcome from the page', async () => {
  const s = await site();
  assert.match((await s.get('/decisions')).body, /No open decisions/);
  const blank = (await s.get('/decisions/new')).body;
  assert.match(blank, /action="\/decisions\/new"/);
  assert.ok(blank.includes(`name="csrf" value="${s.csrf}"`));

  const created = await s.post('/decisions/new', fields());
  assert.equal(created.status, 303);
  assert.equal(created.headers.Location, '/decisions');
  assert.deepEqual(await s.decisions.load(), [{ id: 'spring-plan', date: '2026-12-13', status: 'open', title: 'Spring plan', question: 'Start early or hold?',
    options: ['Start early', 'Hold'], context: 'Line one.\nLine two.', outcome: null }]);
  await s.post('/decisions/new', fields({ date: '2026-12-01' }));
  assert.deepEqual((await s.decisions.load()).map((d) => d.id), ['spring-plan-2', 'spring-plan'], 'same title gets its own id; kept in date order');

  // A bad entry comes back with the message and what was typed, and nothing is saved.
  const bad = await s.post('/decisions/new', fields({ title: 'Bad <date>', date: '2026-02-30' }));
  assert.equal(bad.status, 400);
  assert.match(bad.body, /Not saved: date must be YYYY-MM-DD/);
  assert.match(bad.body, /value="Bad &lt;date&gt;"/);
  assert.equal((await s.decisions.load()).length, 2);

  const edit = (await s.get('/decisions/spring-plan')).body;
  assert.match(edit, /action="\/decisions\/spring-plan"/);
  assert.match(edit, />Start early\nHold<\/textarea>/);
  assert.equal((await s.get('/decisions/nope-nope')).status, 404);
  assert.equal((await s.post('/decisions/nope-nope', fields())).status, 404);

  await s.posts.save({ kind: 'decision', key: 'spring-plan', title: 'Spring plan', subtitle: 'Decision brief', text: 'x', generatedAt: '2026-12-09T17:00:00Z' });
  assert.equal((await s.post('/decisions/spring-plan', fields({ status: 'decided', outcome: 'Starting early.' }))).status, 303);
  const list = (await s.get('/decisions')).body;
  assert.match(list, /<h2>Decided<\/h2>.*Spring plan.*<strong>Decided:<\/strong> Starting early\..*Read the brief/s);
  assert.match(list, /<h2>Open<\/h2>.*Spring plan.*Edit or record the outcome/s);
  assert.equal((await s.decisions.find('spring-plan')).status, 'decided');

  assert.equal(decisionId('  Été: plan #2! ', []), 'ete-plan-2');
  assert.equal(decisionId('!!', []), 'decision');
  assert.equal(decisionId('New', ['new']), 'new-2');
});
