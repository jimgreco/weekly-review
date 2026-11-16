// Google sign-in protected pages for the owner's Claude Code summaries
// (DATA_DIR/notes/<week>/claude-code.json). Off (404) unless GOOGLE_CLIENT_ID
// and SUMMARIES_ALLOWED_EMAILS are both set. The session cookie is an HMAC
// with a key derived from LINK_SECRET, so no new secret is needed; rotating
// LINK_SECRET signs everyone out.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createJwks, verifyIdToken, InvalidIdToken } from './google.js';
import { renderSummariesLogin, renderSummariesList, renderSummary, renderSummariesDenied, weekLabel } from './render.js';
import { weekRange } from './week.js';

export const SESSION_COOKIE = '__Host-wr_summaries';
const SESSION_DAYS = 30;
const MAX_FORM_BYTES = 16 * 1024;

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// Only the login page loads Google Identity Services.
const LOGIN_CSP = "default-src 'none'; script-src https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; "
  + "connect-src https://accounts.google.com/gsi/; style-src 'unsafe-inline' https://accounts.google.com/gsi/style; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function summariesEnabled(config) {
  return Boolean(config.googleClientId && config.summariesAllowedEmails?.length && config.linkSecret?.length >= 32);
}

export function sessionKey(linkSecret) {
  return createHmac('sha256', linkSecret).update('summaries-session-v1').digest();
}

export function signSession(key, email, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ email, iat, exp: iat + SESSION_DAYS * 86400 })).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** Returns the session email, or null. */
export function readSession(key, value, allowed, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const [payload, mac, extra] = value.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(createHmac('sha256', key).update(payload).digest('base64url'));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { email, iat, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const t = Math.floor(nowMs / 1000);
    if (typeof email !== 'string' || typeof exp !== 'number' || typeof iat !== 'number') return null;
    if (exp <= t || iat > t + 300) return null;
    // Removing an address from the allow-list revokes its session too.
    return allowed.includes(email.toLowerCase()) ? email : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded\b/.test(req.headers['content-type'] || '')) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createSummaries(config, notes, { fetchImpl = fetch, now = Date.now } = {}) {
  const enabled = summariesEnabled(config);
  const key = enabled ? sessionKey(config.linkSecret) : null;
  const allowed = config.summariesAllowedEmails ?? [];
  const jwks = createJwks({ fetchImpl, now });
  const origin = (() => { try { return new URL(config.publicUrl).origin; } catch { return null; } })();

  const reply = (res, status, body, { csp = PAGE_CSP, headers = {} } = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...BASE_HEADERS, 'Content-Security-Policy': csp, ...headers });
    res.end(body);
  };
  const redirect = (res, location, headers = {}) => reply(res, 303, '', { headers: { Location: location, ...headers } });
  const cookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  const denied = (res, reason) => {
    console.warn(`[summaries] sign-in rejected: ${reason}`);
    return reply(res, 403, renderSummariesDenied());
  };

  return async function handle(req, res, url) {
    if (!enabled) return reply(res, 404, 'Not found', { headers: { 'Content-Type': 'text/plain' } });
    const cookies = parseCookies(req.headers.cookie);
    const session = readSession(key, cookies[SESSION_COOKIE], allowed, now());
    const path = url.pathname;

    if (path === '/summaries/login') {
      if (req.method !== 'GET') return reply(res, 405, 'Method not allowed');
      if (session) return redirect(res, '/summaries');
      // GIS needs the page origin in the Referer to check the client's
      // authorized origins, so this page sends the origin only (no path).
      return reply(res, 200, renderSummariesLogin({ clientId: config.googleClientId, loginUri: `${config.publicUrl}/summaries/auth` }),
        { csp: LOGIN_CSP, headers: { 'Referrer-Policy': 'strict-origin' } });
    }

    if (path === '/summaries/auth') {
      if (req.method !== 'POST') return reply(res, 405, 'Method not allowed');
      const form = await readForm(req);
      if (!form) return denied(res, 'bad form body');
      if (!safeEqual(form.get('g_csrf_token'), cookies.g_csrf_token)) return denied(res, 'csrf mismatch');
      let claims;
      try {
        claims = await verifyIdToken(form.get('credential'), { clientId: config.googleClientId, jwks, now });
      } catch (error) {
        if (error instanceof InvalidIdToken) return denied(res, error.message);
        throw error;
      }
      if (!allowed.includes(claims.email.toLowerCase())) return denied(res, 'email not allowed');
      return redirect(res, '/summaries', { 'Set-Cookie': cookie(signSession(key, claims.email.toLowerCase(), now()), SESSION_DAYS * 86400) });
    }

    if (path === '/summaries/logout') {
      if (req.method !== 'POST') return reply(res, 405, 'Method not allowed');
      if (!origin || req.headers.origin !== origin) return reply(res, 403, 'Forbidden', { headers: { 'Content-Type': 'text/plain' } });
      return redirect(res, '/summaries/login', { 'Set-Cookie': cookie('', 0) });
    }

    if (path === '/summaries' || /^\/summaries\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      if (req.method !== 'GET') return reply(res, 405, 'Method not allowed');
      if (!session) return redirect(res, '/summaries/login');
      const weeks = await notes.listWeeks('claude-code');
      if (path === '/summaries') {
        return reply(res, 200, renderSummariesList(weeks.map((w) => ({ href: `/summaries/${w}`, label: weekLabel(weekRange(w)) })), { email: session }));
      }
      const week = path.slice('/summaries/'.length);
      const i = weeks.indexOf(week); // weeks are newest first; only real Mondays are listed
      const note = i >= 0 ? await notes.load(week, 'claude-code') : null;
      if (!note) return reply(res, 404, 'Not found', { headers: { 'Content-Type': 'text/plain' } });
      const link = (w) => (w ? { href: `/summaries/${w}`, label: weekLabel(weekRange(w)) } : null);
      return reply(res, 200, renderSummary({ week: weekRange(week), note, newer: link(weeks[i - 1]), older: link(weeks[i + 1]), email: session }));
    }

    return reply(res, 404, 'Not found', { headers: { 'Content-Type': 'text/plain' } });
  };
}
