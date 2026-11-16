import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { Readable } from 'node:stream';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createPublisher, validateSubmission } from '../src/ingest.js';
import { createNotesStore } from '../src/notes.js';
import { collectNotes } from '../src/sources.js';
import { loadConfig } from '../src/config.js';
import { weekRange } from '../src/week.js';
import { buildDigest, fitDigest, redact, renderJson, renderText } from '../scripts/claude-code-digest.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEEK = '2026-11-02';
const INGEST = 'routine-token-0123456789abcdef';
const NOTES = 'notes-token-abcdefghijklmnop0123';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const tmp = () => mkdtemp(path.join(tmpdir(), 'wr-notes-'));

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; resolve(this); } };
    handler(req, res);
  });
}

async function site({ notesTokenSha256 = sha(NOTES) } = {}) {
  const dataDir = await tmp();
  const config = { linkSecret: 'x'.repeat(40), publicUrl: 'http://x', dataDir, ingestTokenSha256: sha(INGEST), notesTokenSha256 };
  const store = createStore(dataDir);
  return { dataDir, config, store, handler: createHandler(config, store) };
}

const json = { 'content-type': 'application/json' };
const notesAuth = { ...json, authorization: `Bearer ${NOTES}` };
const ingestAuth = { authorization: `Bearer ${INGEST}` };
const note = (text = '- Shipped the protein chart') => ({ text, generatedAt: '2026-11-08T22:30:00Z' });
const put = (handler, { week = WEEK, headers = notesAuth, body = note(), method = 'PUT' } = {}) =>
  call(handler, { method, url: `/api/notes/claude-code?week=${week}`, headers, body });

test('notes PUT: needs the notes token; 404 when unset, wrong or the ingest token', async () => {
  const { handler } = await site();
  assert.equal((await put(handler, { headers: json })).status, 404);
  assert.equal((await put(handler, { headers: { ...json, authorization: 'Bearer wrong-token-wrong-token' } })).status, 404);
  assert.equal((await put(handler, { headers: { ...json, ...ingestAuth } })).status, 404, 'the ingest token cannot write notes');
  assert.equal((await put(handler, { method: 'POST' })).status, 405);
  const good = await put(handler);
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(good.body), { week: WEEK, stored: true });

  const off = (await site({ notesTokenSha256: null })).handler;
  assert.equal((await put(off)).status, 404);
  const same = (await site({ notesTokenSha256: sha(INGEST) })).handler;
  assert.equal((await put(same, { headers: { ...json, ...ingestAuth } })).status, 404, 'a notes hash equal to the ingest hash is treated as off');
});

test('notes PUT: validates week, text, content type and size', async () => {
  const { handler } = await site();
  const status = async (opts) => (await put(handler, opts)).status;
  assert.equal(await status({ week: '2026-11-03' }), 400);
  assert.equal(await status({ week: 'nope' }), 400);
  assert.equal(await status({ body: note('   ') }), 400);
  assert.equal(await status({ body: note('x'.repeat(6001)) }), 400);
  assert.equal(await status({ body: { text: 'ok' } }), 400, 'generatedAt is required');
  assert.equal(await status({ body: '{nope' }), 400);
  assert.equal(await status({ headers: { authorization: notesAuth.authorization } }), 415);
  assert.equal(await status({ body: 'x'.repeat(100 * 1024) }), 413);
  assert.equal(await status({ body: note(`  ${'x'.repeat(6000)}  `) }), 200, '6000 chars after trim is fine');
});

test('notes: stored mode 600 in a 700 dir, atomically replaced, read back with the ingest token only', async () => {
  const { handler, dataDir } = await site();
  assert.equal((await put(handler, { body: note('first') })).status, 200);
  assert.equal((await put(handler, { body: note('  second  ') })).status, 200);
  const dir = path.join(dataDir, 'notes', WEEK);
  assert.deepEqual(await readdir(dir), ['claude-code.json'], 'no temp files left behind');
  assert.equal((await stat(path.join(dir, 'claude-code.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dataDir, 'notes'))).mode & 0o777, 0o700);

  const get = (headers, week = WEEK) => call(handler, { url: `/api/notes?week=${week}`, headers });
  assert.equal((await get({})).status, 404);
  assert.equal((await get({ authorization: `Bearer ${NOTES}` })).status, 404, 'the notes token cannot read');
  assert.equal((await call(handler, { method: 'PUT', url: `/api/notes?week=${WEEK}`, headers: ingestAuth })).status, 405);
  assert.equal((await get(ingestAuth, '2026-11-04')).status, 400);
  const res = await get(ingestAuth);
  assert.equal(res.status, 200);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.deepEqual(JSON.parse(res.body), { week: WEEK, notes: { 'claude-code': { text: 'second', generatedAt: '2026-11-08T22:30:00.000Z' } } });
  assert.deepEqual(JSON.parse((await get(ingestAuth, '2026-11-09')).body), { week: '2026-11-09', notes: { 'claude-code': null } });
});

test('notes never reach the stored review or the page', async () => {
  const { handler, store, config } = await site();
  await put(handler, { body: note('PRIVATE_NOTE_TEXT') });
  const sources = { macros: { status: 'ok' }, workouts: { status: 'ok' }, spending: { status: 'ok' }, checklist: { status: 'ok' }, planner: { status: 'ok' } };
  const body = { review: { week: weekRange(WEEK), generatedAt: '2026-11-08T23:00:00Z', sources, notes: { claudeCode: note('PRIVATE_NOTE_TEXT') } }, narrative: null, send: false };
  const clean = validateSubmission(body);
  assert.ok(!('notes' in clean.review));
  await createPublisher(config, store)(clean);
  assert.doesNotMatch(JSON.stringify(await store.load(WEEK)), /PRIVATE_NOTE_TEXT/);
});

test('collectNotes: ok, none, error and disabled never throw', async () => {
  const config = loadConfig({ REVIEW_SITE_URL: 'https://review.example', AUTH_VIA_PROXY: '1' });
  const week = weekRange(WEEK);
  const reply = (body, status = 200) => async (url, init) => {
    assert.equal(url, `https://review.example/api/notes?week=${WEEK}`);
    assert.equal(init.redirect, 'error');
    assert.ok(!init.headers.Authorization, 'the proxy adds auth');
    return { ok: status === 200, status, json: async () => body };
  };
  assert.deepEqual(await collectNotes(config, week, { fetchImpl: reply({ week: WEEK, notes: { 'claude-code': note() } }) }),
    { notes: { claudeCode: note() }, status: 'ok' });
  assert.deepEqual(await collectNotes(config, week, { fetchImpl: reply({ week: WEEK, notes: { 'claude-code': null } }) }),
    { notes: { claudeCode: null }, status: 'none' });
  assert.deepEqual(await collectNotes(config, week, { fetchImpl: reply({}, 500) }), { notes: null, status: 'error', error: 'HTTP 500' });
  assert.equal((await collectNotes(config, week, { fetchImpl: reply({ week: '2026-11-09', notes: {} }) })).error, 'unexpected response shape');
  assert.equal((await collectNotes(config, week, { fetchImpl: async () => { throw new Error('ECONNRESET'); } })).status, 'error');
  assert.deepEqual(await collectNotes(loadConfig({}), week), { notes: null, status: 'disabled' });
  const withToken = loadConfig({ REVIEW_SITE_URL: 'https://r', REVIEW_INGEST_TOKEN: INGEST });
  await collectNotes(withToken, week, { fetchImpl: async (_u, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${INGEST}`);
    return { ok: true, status: 200, json: async () => ({ week: WEEK, notes: {} }) };
  } });
});

// End to end through the real CLI and a real HTTP server.
async function liveSite() {
  const s = await site();
  const server = http.createServer(s.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const home = await tmp();
  const env = { PATH: process.env.PATH, HOME: home, REVIEW_SITE_URL: url };
  const cli = (args, extra = {}) => run(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], { env: { ...env, ...extra }, cwd: home });
  return { ...s, server, url, home, cli };
}

test('cli: post-notes reads the default token file, never prints the token; collect and publish handle notes', async (t) => {
  const live = await liveSite();
  t.after(() => live.server.close());
  const { cli, home } = live;
  const summary = path.join(home, 'summary.md');
  await writeFile(summary, '- Shipped the protein chart\n');

  // No token anywhere.
  await assert.rejects(cli(['post-notes', '--week', WEEK, '--file', summary]), (e) => /no readable token file/.test(e.stderr));

  await mkdir(path.join(home, '.config', 'weekly-review'), { recursive: true });
  const tokenFile = path.join(home, '.config', 'weekly-review', 'notes.token');
  await writeFile(tokenFile, `${NOTES}\n`, { mode: 0o600 });
  const posted = await cli(['post-notes', '--week', WEEK, '--file', summary]);
  assert.match(posted.stdout, /Stored the Claude Code notes for 2026-11-02/);
  assert.ok(!(posted.stdout + posted.stderr).includes(NOTES), 'token never printed');
  assert.deepEqual(await createNotesStore(live.dataDir).load(WEEK, 'claude-code').then((n) => n.text), '- Shipped the protein chart');

  // A wrong token, from --token-file: 404, and still never printed.
  const wrong = path.join(home, 'wrong.token');
  await writeFile(wrong, 'wrong-token-wrong-token-123', { mode: 0o644 });
  await assert.rejects(cli(['post-notes', '--week', WEEK, '--file', summary, '--token-file', wrong]), (e) => {
    assert.match(e.stderr, /404/);
    assert.match(e.stderr, /readable by others/);
    assert.ok(!e.stderr.includes('wrong-token-wrong-token-123'));
    return true;
  });
  await assert.rejects(cli(['post-notes', '--week', '2026-11-03', '--file', summary]), /not a Monday/);
  await assert.rejects(cli(['post-notes', '--week', WEEK, '--file', summary], { REVIEW_SITE_URL: 'http://review.example' }), /must be https/);

  // collect: notes present.
  const out = path.join(home, 'review.json');
  const collected = await cli(['collect', '--week', WEEK, '--out', out], { REVIEW_INGEST_TOKEN: INGEST });
  assert.match(collected.stderr, /notes=ok/);
  const review = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(review.notes.claudeCode.text, '- Shipped the protein chart');

  // collect: no notes that week, and a failure that must not fail collect.
  const none = await cli(['collect', '--week', '2026-11-09'], { REVIEW_INGEST_TOKEN: INGEST });
  assert.deepEqual(JSON.parse(none.stdout).notes, { claudeCode: null });
  assert.match(none.stderr, /notes=none/);
  const failed = await cli(['collect', '--week', WEEK], { REVIEW_INGEST_TOKEN: 'wrong-token-wrong-token-123' });
  assert.equal(JSON.parse(failed.stdout).notes, null);
  assert.match(failed.stderr, /notes=error \(HTTP 404\)/);

  // publish strips notes before posting.
  await cli(['publish', '--in', out], { REVIEW_INGEST_TOKEN: INGEST });
  const stored = await live.store.load(WEEK);
  assert.ok(stored, 'published');
  assert.ok(!('notes' in stored));
  assert.doesNotMatch(JSON.stringify(stored), /protein chart/);
});

// ---- Digest script ----

// Secrets are assembled here, not stored in the fixture, so scanners don't flag the repo.
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-'),
};

async function fixtureRoot() {
  const root = await tmp();
  await cp(path.join(ROOT, 'test/fixtures/claude-projects'), root, { recursive: true });
  const file = path.join(root, '-Users-me-code-macros', 'sess-a.jsonl');
  await writeFile(file, (await readFile(file, 'utf8')).replace('__ANTHROPIC__', FAKE.anthropic));
  return root;
}

test('digest: picks the week in the given timezone and keeps only typed messages and final replies', async () => {
  const root = await fixtureRoot();
  const d = await buildDigest({ root, week: WEEK, tz: 'America/New_York', home: '/Users/me' });
  assert.deepEqual(d.sessions.map((s) => s.project), ['code/macros', 'code/weekly-review']);
  const [a, b] = d.sessions;
  assert.equal(a.title, 'Protein chart');
  assert.deepEqual(a.prs, ['me/macros#42']);
  assert.equal(a.userTurns, 5);
  assert.equal(a.userMessages[0], 'Add a protein chart, key [redacted]');
  assert.equal(a.userMessages[1], 'Second ask [1 image]');
  assert.equal(a.userMessages[2].length, 300);
  assert.ok(a.userMessages[2].endsWith('…'));
  assert.deepEqual(a.userMessages.slice(3), ['Fourth ask', 'Next day ask']);
  assert.equal(a.assistantReplies.length, 3, 'last three final replies');
  assert.ok(a.assistantReplies[0].startsWith('Reply three '));
  assert.equal(a.assistantReplies[0].length, 500);
  assert.deepEqual(a.assistantReplies.slice(1), ['Reply four.', 'Reply five.']);
  assert.equal(a.activeMinutes, 23, 'the overnight gap is not active time');
  assert.equal(a.spanMinutes, 23 * 60 + 10);
  assert.equal(a.startLocal, 'Mon 2026-11-02 09:00');
  assert.equal(b.startLocal, 'Sun 2026-11-08 23:30', 'Sunday 23:30 New York is still this week');
  assert.deepEqual(d.totals, { sessions: 2, activeMinutes: 33, userTurns: 6 });

  const text = renderText(d) + renderJson(d);
  for (const hidden of ['THINKING_TEXT', 'SECRET_TOOL_INPUT', 'TOOL_OUTPUT_TEXT', 'REMINDER_TEXT', 'INLINE_REMINDER', 'TASK_NOTE',
    '/clear', 'SIDECHAIN_TEXT', 'SUBAGENT_PROMPT', 'OLD_WEEK', 'BEFORE_WEEK_MESSAGE', FAKE.anthropic, 'Reply one', 'Reply two', '/Users/me']) {
    assert.ok(!text.includes(hidden), `${hidden} must not be output`);
  }

  // In UTC the late-Sunday session falls in the next week and the early one moves in.
  const utc = await buildDigest({ root, week: WEEK, tz: 'UTC', home: '/Users/me' });
  assert.deepEqual(utc.sessions.map((s) => s.project), ['code/macros']);
  assert.equal(utc.sessions[0].userMessages[0], 'BEFORE_WEEK_MESSAGE');
});

test('digest: redacts every secret pattern', () => {
  const cases = {
    anthropic: FAKE.anthropic,
    github: ['ghp', 'B'.repeat(36)].join('_'),
    githubPat: ['github', 'pat', '11AAAAAAA0', 'C'.repeat(40)].join('_'),
    aws: `AKIA${'D'.repeat(16)}`,
    bearer: `Bearer ${'e'.repeat(10)}.${'f'.repeat(20)}`,
    ip: '10.20.30.40',
    hex: 'a1'.repeat(16),
    email: 'someone@example.com',
    assignment: 'API_KEY=supersecretvalue1',
  };
  for (const [name, secret] of Object.entries(cases)) {
    const out = redact(`before ${secret} after`, '/Users/me');
    assert.ok(!out.includes(secret.split(/[=\s]/).at(-1)), `${name} redacted: ${out}`);
    assert.match(out, /^before .+ after$/);
  }
  const key = `x -----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY----- y`;
  assert.equal(redact(key), 'x [redacted key] y');
  assert.equal(redact('z -----BEGIN RSA PRIVATE KEY-----\nunterminated'), 'z [redacted key]');
  assert.equal(redact('see /Users/me/code/x', '/Users/me'), 'see ~/code/x');
  const prose = 'Decided to move the 401k rollover to March; the password manager stays. Token: rotation is next week. '
    + 'Ran 5k at 7:30, weight 182.4 lb, budget 1,250 per month, flight AA 1234 on 12.15.2026, version 1.2.3.';
  assert.equal(redact(prose, '/Users/me'), prose, 'ordinary prose, numbers and dates survive');
});

test('digest: caps output, dropping the oldest and longest content first', () => {
  const session = (i) => ({
    project: `code/p${i}`, title: null, start: `2026-11-0${2 + i}T10:00:00.000Z`, end: '', startLocal: `day ${i}`, endLocal: '',
    spanMinutes: 60, activeMinutes: 60, userTurns: 40, prs: [],
    userMessages: Array.from({ length: 40 }, (_, j) => `${i}:${j} ${'u'.repeat(j * 7)}`),
    assistantReplies: [`${i} ${'a'.repeat(499)}`],
  });
  const digest = { week: { start: WEEK, end: '2026-11-08' }, timezone: 'UTC', totals: { sessions: 3, activeMinutes: 180, userTurns: 120 },
    projects: [], sessions: [0, 1, 2].map(session), trimmed: { droppedMessages: 0, droppedSessions: 0 } };
  const full = renderText(digest).length;
  assert.ok(full > 12000);
  const { digest: fit, text } = fitDigest(digest, renderText, 9000);
  assert.ok(text.length <= 9000, `${text.length}`);
  assert.equal(fit.sessions.length, 3, 'headers stay');
  assert.ok(fit.sessions[0].userMessages.length < fit.sessions[2].userMessages.length, 'oldest session trimmed first');
  assert.equal(fit.sessions[2].userMessages.length, 40, 'newest session intact');
  assert.ok(fit.trimmed.droppedMessages > 0);
  assert.match(text, /Trimmed to fit/);
  assert.equal(digest.sessions[0].userMessages.length, 40, 'input untouched');
  const tiny = fitDigest(digest, renderJson, 1200);
  assert.ok(tiny.text.length <= 1200);
  assert.ok(tiny.digest.trimmed.droppedSessions > 0);
  assert.equal(fitDigest(digest, renderText, full).text, renderText(digest), 'nothing changes under the cap');
});

test('digest: the script runs on a root and prints JSON', async () => {
  const root = await fixtureRoot();
  const { stdout } = await run(process.execPath, [path.join(ROOT, 'scripts/claude-code-digest.mjs'), '--root', root, '--week', WEEK, '--json'],
    { env: { PATH: process.env.PATH, HOME: '/Users/me' } });
  const d = JSON.parse(stdout);
  assert.equal(d.totals.sessions, 2);
  assert.ok(!stdout.includes(FAKE.anthropic));
  const text = await run(process.execPath, [path.join(ROOT, 'scripts/claude-code-digest.mjs'), '--root', root, '--week', WEEK, '--tz', 'UTC'],
    { env: { PATH: process.env.PATH, HOME: '/Users/me' } });
  assert.match(text.stdout, /^Claude Code digest, week 2026-11-02 to 2026-11-08 \(UTC\)/);
  await assert.rejects(run(process.execPath, [path.join(ROOT, 'scripts/claude-code-digest.mjs'), '--week', '2026-11-03', '--root', root]), /not a Monday/);
  const printed = await run(process.execPath, [path.join(ROOT, 'scripts/claude-code-digest.mjs'), '--print-week', '--week', WEEK]);
  assert.equal(printed.stdout, `${WEEK}\n`);
});

