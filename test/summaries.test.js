import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createNotesStore } from '../src/notes.js';
import { createSummaries, sessionKey, signSession, SESSION_COOKIE } from '../src/summaries.js';
import { loadConfig } from '../src/config.js';
import { reviewUrl, archiveUrl } from '../src/links.js';

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const SECRET = 'x'.repeat(40);
const ORIGIN = 'https://review.example';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const T = Math.floor(NOW / 1000);
const CSRF = 'csrf-abc123';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function jwt(claims = {}, { header = {}, key = privateKey, sign = true } = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const p = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'Owner@Example.com',
    email_verified: true, iat: T - 10, exp: T + 3600, ...claims });
  const s = sign ? createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url') : '';
  return `${h}.${p}.${s}`;
}

function fakeGoogle(keys = [jwk(publicKey, 'k1')]) {
  const g = { calls: 0, keys };
  g.fetchImpl = async (url, init) => {
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
    assert.equal(init.redirect, 'error');
    g.calls += 1;
    return { ok: true, status: 200, headers: new Headers({ 'cache-control': 'public, max-age=3600' }), json: async () => ({ keys: g.keys }) };
  };
  return g;
}

function call(handler, { method = 'GET', url, headers = {}, body } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, body: '',
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ?? ''; resolve(this); } };
    handler(req, res);
  });
}

async function site({ env = {}, google = fakeGoogle(), clock = { now: NOW } } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wr-sum-'));
  const config = loadConfig({ LINK_SECRET: SECRET, PUBLIC_URL: ORIGIN, DATA_DIR: dataDir, GOOGLE_CLIENT_ID: CLIENT_ID,
    SUMMARIES_ALLOWED_EMAILS: ' other@example.com , owner@example.com', ...env });
  const store = createStore(dataDir);
  const notes = createNotesStore(dataDir);
  const summaries = createSummaries(config, notes, { fetchImpl: google.fetchImpl, now: () => clock.now });
  return { config, store, notes, google, clock, handler: createHandler(config, store, { notes, summaries }) };
}

const form = (fields) => new URLSearchParams(fields).toString();
const signIn = (handler, credential, { csrfBody = CSRF, csrfCookie = CSRF, contentType = 'application/x-www-form-urlencoded' } = {}) =>
  call(handler, { method: 'POST', url: '/summaries/auth', headers: { 'content-type': contentType, cookie: `g_csrf_token=${csrfCookie}` },
    body: form({ credential, g_csrf_token: csrfBody }) });
const sessionCookie = (res) => /^__Host-wr_summaries=([^;]+);/.exec(res.headers['Set-Cookie'])?.[1];
const withSession = (value) => ({ cookie: `${SESSION_COOKIE}=${value}` });

// Quiet the expected rejection logs, but check they never carry the token.
const logged = [];
console.warn = (...args) => logged.push(args.join(' '));

test('summaries: a valid Google token sets the session cookie and opens /summaries', async () => {
  const { handler, notes } = await site();
  await notes.save('2026-11-02', 'claude-code', { text: '- Built the <script> page', generatedAt: '2026-11-08T22:30:00Z' });
  const res = await signIn(handler, jwt());
  assert.equal(res.status, 303);
  assert.equal(res.headers.Location, '/summaries');
  const set = res.headers['Set-Cookie'];
  assert.match(set, /^__Host-wr_summaries=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  const payload = JSON.parse(Buffer.from(sessionCookie(res).split('.')[0], 'base64url').toString());
  assert.deepEqual(payload, { email: 'owner@example.com', iat: T, exp: T + 30 * 86400 });

  const list = await call(handler, { url: '/summaries', headers: withSession(sessionCookie(res)) });
  assert.equal(list.status, 200);
  assert.match(list.body, /href="\/summaries\/2026-11-02">Week of Nov 2 – Nov 8/);
  assert.match(list.body, /action="\/summaries\/logout"/);
  assert.equal(list.headers['Cache-Control'], 'no-store');
  assert.equal(list.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(list.headers['X-Robots-Tag'], 'noindex');
  assert.equal(list.headers['X-Frame-Options'], 'DENY');
  assert.match(list.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(list.headers['Content-Security-Policy'], /google/);
});

test('summaries: every bad token is a 403 with no detail, and nothing is set', async () => {
  const { handler } = await site();
  const cases = {
    'wrong aud': jwt({ aud: 'someone-else.apps.googleusercontent.com' }),
    'wrong iss': jwt({ iss: 'https://evil.example' }),
    expired: jwt({ exp: T - 301 }),
    'iat in the future': jwt({ iat: T + 301 }),
    'unverified email': jwt({ email_verified: false }),
    'string email_verified': jwt({ email_verified: 'true' }),
    'not allowed': jwt({ email: 'stranger@example.com' }),
    'bad signature': jwt({}, { key: other.privateKey }),
    'alg none': jwt({}, { header: { alg: 'none' }, sign: false }),
    'alg HS256': (() => {
      const h = b64({ alg: 'HS256', kid: 'k1' });
      const p = b64({ iss: 'accounts.google.com', aud: CLIENT_ID, email: 'owner@example.com', email_verified: true, iat: T, exp: T + 60 });
      return `${h}.${p}.${createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' })).update(`${h}.${p}`).digest('base64url')}`;
    })(),
    'no kid': jwt({}, { header: { kid: undefined } }),
    garbage: 'not.a.jwt',
    empty: '',
  };
  for (const [name, token] of Object.entries(cases)) {
    const res = await signIn(handler, token);
    assert.equal(res.status, 403, name);
    assert.equal(res.headers['Set-Cookie'], undefined, name);
    assert.match(res.body, /This account can't view summaries\./, name);
    assert.doesNotMatch(res.body, /expired|audience|issuer|signature|alg/i, name);
  }
  assert.ok(logged.length >= Object.keys(cases).length);
  assert.ok(logged.every((l) => !l.includes('eyJ')), 'logs never include a token');
  // Within skew is fine.
  assert.equal((await signIn(handler, jwt({ exp: T - 200, iss: 'accounts.google.com' }))).status, 303);
});

test('summaries: CSRF double-submit must match', async () => {
  const { handler } = await site();
  assert.equal((await signIn(handler, jwt(), { csrfBody: 'other' })).status, 403);
  assert.equal((await signIn(handler, jwt(), { csrfCookie: '' })).status, 403);
  assert.equal((await call(handler, { method: 'POST', url: '/summaries/auth', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ credential: jwt(), g_csrf_token: CSRF }) })).status, 403, 'no cookie');
  assert.equal((await signIn(handler, jwt(), { contentType: 'application/json' })).status, 403);
  assert.equal((await call(handler, { url: '/summaries/auth' })).status, 405);
});

test('summaries: unknown kid refetches the JWKS once, then is rate limited; keys are cached', async () => {
  const google = fakeGoogle();
  const clock = { now: NOW };
  const { handler } = await site({ google, clock });
  assert.equal((await signIn(handler, jwt())).status, 303);
  assert.equal((await signIn(handler, jwt())).status, 303);
  assert.equal(google.calls, 1, 'cached per max-age');

  // Google rotates to k2: the first k2 token triggers one refetch.
  google.keys = [jwk(publicKey, 'k1'), jwk(other.publicKey, 'k2')];
  clock.now += 61 * 1000;
  assert.equal((await signIn(handler, jwt({}, { header: { kid: 'k2' }, key: other.privateKey }))).status, 303);
  assert.equal(google.calls, 2);
  // Unknown kids within a minute don't refetch.
  assert.equal((await signIn(handler, jwt({}, { header: { kid: 'nope' } }))).status, 403);
  assert.equal((await signIn(handler, jwt({}, { header: { kid: 'nope2' } }))).status, 403);
  assert.equal(google.calls, 2);
  clock.now += 61 * 1000;
  assert.equal((await signIn(handler, jwt({}, { header: { kid: 'nope' } }))).status, 403);
  assert.equal(google.calls, 3, 'one more refetch after a minute');
  // After max-age the keys are refetched even for a known kid.
  clock.now += 3600 * 1000;
  assert.equal((await signIn(handler, jwt({ iat: Math.floor(clock.now / 1000), exp: Math.floor(clock.now / 1000) + 60 }))).status, 303);
  assert.equal(google.calls, 4);
});

test('summaries: tampered, foreign or expired session cookies redirect to login', async () => {
  const { handler, config } = await site();
  const key = sessionKey(config.linkSecret);
  const good = signSession(key, 'owner@example.com', NOW);
  assert.equal((await call(handler, { url: '/summaries', headers: withSession(good) })).status, 200);

  const [payload, mac] = good.split('.');
  const forged = b64({ email: 'owner@example.com', iat: T, exp: T + 999999999 });
  const bad = {
    none: {},
    tampered: withSession(`${forged}.${mac}`),
    'bad mac': withSession(`${payload}.${mac.slice(0, -2)}xx`),
    'link-secret key': withSession(`${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`),
    expired: withSession(signSession(key, 'owner@example.com', NOW - 31 * 86400 * 1000)),
    'no longer allowed': withSession(signSession(key, 'gone@example.com', NOW)),
    junk: withSession('abc'),
  };
  for (const [name, headers] of Object.entries(bad)) {
    for (const url of ['/summaries', '/summaries/2026-11-02']) {
      const res = await call(handler, { url, headers });
      assert.equal(res.status, 303, `${name} ${url}`);
      assert.equal(res.headers.Location, '/summaries/login', `${name} ${url}`);
    }
  }
});

test('summaries: unset config is a 404 for every /summaries route', async () => {
  for (const env of [{ GOOGLE_CLIENT_ID: '' }, { SUMMARIES_ALLOWED_EMAILS: '' }, { SUMMARIES_ALLOWED_EMAILS: ' , ' }]) {
    const { handler } = await site({ env });
    for (const [method, url] of [['GET', '/summaries'], ['GET', '/summaries/login'], ['POST', '/summaries/auth'], ['POST', '/summaries/logout'], ['GET', '/summaries/2026-11-02']]) {
      assert.equal((await call(handler, { method, url })).status, 404, `${JSON.stringify(env)} ${method} ${url}`);
    }
  }
  assert.deepEqual(loadConfig({}).summariesAllowedEmails, []);
  assert.equal(loadConfig({}).googleClientId, null);
});

test('summaries: login page loads GIS with its own CSP; signed-in users skip it', async () => {
  const { handler, config } = await site();
  const res = await call(handler, { url: '/summaries/login' });
  assert.equal(res.status, 200);
  assert.match(res.body, /<script src="https:\/\/accounts\.google\.com\/gsi\/client" async><\/script>/);
  assert.match(res.body, new RegExp(`data-client_id="${CLIENT_ID}"`));
  assert.match(res.body, /data-login_uri="https:\/\/review\.example\/summaries\/auth"/);
  assert.match(res.body, /class="g_id_signin"/);
  const csp = res.headers['Content-Security-Policy'];
  assert.match(csp, /script-src https:\/\/accounts\.google\.com\/gsi\/client;/);
  assert.match(csp, /frame-src https:\/\/accounts\.google\.com\/gsi\/;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|\*/);
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const signedIn = await call(handler, { url: '/summaries/login', headers: withSession(signSession(sessionKey(config.linkSecret), 'owner@example.com', NOW)) });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.Location, '/summaries');
});

test('summaries: logout needs the same Origin and clears the cookie', async () => {
  const { handler, config } = await site();
  const headers = withSession(signSession(sessionKey(config.linkSecret), 'owner@example.com', NOW));
  for (const origin of [undefined, 'https://evil.example', 'null', 'http://review.example']) {
    const res = await call(handler, { method: 'POST', url: '/summaries/logout', headers: { ...headers, ...(origin ? { origin } : {}) } });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers['Set-Cookie'], undefined);
  }
  const res = await call(handler, { method: 'POST', url: '/summaries/logout', headers: { ...headers, origin: ORIGIN } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.Location, '/summaries/login');
  assert.match(res.headers['Set-Cookie'], /^__Host-wr_summaries=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal((await call(handler, { url: '/summaries/logout' })).status, 405);
});

test('summaries: list and detail show only weeks with notes, escaped, with prev/next', async () => {
  const { handler, config, notes, store } = await site();
  const headers = withSession(signSession(sessionKey(config.linkSecret), 'owner@example.com', NOW));
  const empty = await call(handler, { url: '/summaries', headers });
  assert.match(empty.body, /No summaries yet/);

  await notes.save('2026-10-19', 'claude-code', { text: 'Oldest', generatedAt: '2026-10-25T22:30:00Z' });
  await notes.save('2026-11-02', 'claude-code', { text: '## Built\n- **Protein** chart <img src=x onerror=alert(1)>\n- "quotes" & more\n\nA <b>para</b>', generatedAt: '2026-11-08T22:30:00Z' });
  await notes.save('2026-11-09', 'claude-code', { text: 'Newest', generatedAt: '2026-11-15T22:30:00Z' });
  // A review without a note and stray directories don't appear.
  await store.save({ week: { start: '2026-10-26', end: '2026-11-01' }, generatedAt: 'x', sources: {} });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(config.dataDir, 'notes', '2026-10-26'), { recursive: true });
  await mkdir(path.join(config.dataDir, 'notes', 'junk'), { recursive: true });
  await mkdir(path.join(config.dataDir, 'notes', '2026-11-03'), { recursive: true });

  const list = await call(handler, { url: '/summaries', headers });
  const weeks = [...list.body.matchAll(/href="\/summaries\/([\d-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(weeks, ['2026-11-09', '2026-11-02', '2026-10-19']);

  const page = await call(handler, { url: '/summaries/2026-11-02', headers });
  assert.equal(page.status, 200);
  assert.match(page.body, /<h3>Built<\/h3><ul><li><strong>Protein<\/strong> chart &lt;img src=x onerror=alert\(1\)&gt;<\/li><li>&quot;quotes&quot; &amp; more<\/li><\/ul><p>A &lt;b&gt;para&lt;\/b&gt;<\/p>/);
  assert.doesNotMatch(page.body, /<img|<b>/);
  assert.match(page.body, /generated Nov 8, 2026, 5:30 PM/);
  assert.match(page.body, /href="\/summaries\/2026-10-19">← Oct 19 – Oct 25/);
  assert.match(page.body, /href="\/summaries\/2026-11-09">Nov 9 – Nov 15 →/);
  assert.equal(page.headers['Cache-Control'], 'no-store');

  const oldest = await call(handler, { url: '/summaries/2026-10-19', headers });
  assert.doesNotMatch(oldest.body, /←/);
  assert.match(oldest.body, /href="\/summaries\/2026-11-02">Nov 2 – Nov 8 →/);

  for (const url of ['/summaries/2026-10-26', '/summaries/2026-11-03', '/summaries/2026-13-01', '/summaries/junk', '/summaries/../reviews']) {
    assert.equal((await call(handler, { url, headers })).status, 404, url);
  }
  assert.equal((await call(handler, { method: 'POST', url: '/summaries', headers })).status, 405);
});

test('summaries: existing review routes and their CSP are unchanged', async () => {
  const { handler, config, store } = await site();
  await store.save({ week: { start: '2026-11-02', end: '2026-11-08' }, generatedAt: '2026-11-08T23:00:00Z', narrative: null,
    sources: { macros: { status: 'disabled' }, workouts: { status: 'disabled' }, spending: { status: 'disabled' }, checklist: { status: 'disabled' }, planner: { status: 'disabled' } } });
  const review = await call(handler, { url: new URL(reviewUrl(config, '2026-11-02')).pathname + new URL(reviewUrl(config, '2026-11-02')).search });
  assert.equal(review.status, 200);
  assert.equal(review.headers['Content-Security-Policy'], "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.doesNotMatch(review.body, /summaries|Claude Code/);
  const archive = new URL(archiveUrl(config));
  assert.equal((await call(handler, { url: archive.pathname + archive.search })).status, 200);
  assert.equal((await call(handler, { url: '/r/2026-11-02' })).status, 404);
  assert.equal((await call(handler, { url: '/health' })).body, 'ok');
  assert.equal((await call(handler, { url: '/summariesx' })).status, 404);
});
