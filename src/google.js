// Local verification of Google Identity Services ID tokens (RS256 JWTs).
// Google's public keys come from its JWKS endpoint and are cached for the
// response's Cache-Control max-age. An unknown kid triggers a refetch, at most
// once a minute, so a stream of junk tokens can't hammer Google.
import { createPublicKey, verify as verifySignature } from 'node:crypto';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW_S = 5 * 60;
const REFETCH_MIN_MS = 60 * 1000;
const DEFAULT_MAX_AGE_S = 60 * 60;

export class InvalidIdToken extends Error {}

const fail = (reason) => { throw new InvalidIdToken(reason); };

function decodeJson(part) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    return fail('malformed token');
  }
}

export function createJwks({ fetchImpl = fetch, now = Date.now, url = GOOGLE_JWKS_URL, timeoutMs = 10000 } = {}) {
  let keys = new Map();
  let expiresAt = 0;
  let lastFetch = -Infinity;
  let inflight = null;

  async function refresh() {
    lastFetch = now();
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch { /* skip a key we can't parse */ }
    }
    const cc = typeof res.headers?.get === 'function' ? res.headers.get('cache-control') || '' : '';
    const maxAge = Number(/max-age=(\d+)/i.exec(cc)?.[1] ?? DEFAULT_MAX_AGE_S);
    keys = next;
    expiresAt = now() + maxAge * 1000;
  }

  return {
    async get(kid) {
      const stale = now() >= expiresAt;
      const missing = !keys.has(kid) && now() - lastFetch >= REFETCH_MIN_MS;
      if (stale || missing) {
        inflight ??= refresh().finally(() => { inflight = null; });
        try {
          await inflight;
        } catch (error) {
          console.error('[summaries] could not fetch Google keys:', error.message);
        }
      }
      return keys.get(kid) ?? null;
    },
  };
}

/** Returns the verified claims, or throws InvalidIdToken with a short reason. */
export async function verifyIdToken(token, { clientId, jwks, now = Date.now }) {
  if (typeof token !== 'string' || token.length > 8192) fail('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail('malformed token');
  const [h, p, s] = parts;
  const header = decodeJson(h);
  if (header.alg !== 'RS256') fail('unsupported alg');
  if (typeof header.kid !== 'string' || !header.kid) fail('missing kid');
  const key = await jwks.get(header.kid);
  if (!key) fail('unknown kid');
  if (!verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) fail('bad signature');

  const claims = decodeJson(p);
  const t = Math.floor(now() / 1000);
  if (!GOOGLE_ISSUERS.includes(claims.iss)) fail('wrong issuer');
  if (!clientId || claims.aud !== clientId) fail('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S <= t) fail('expired');
  if (typeof claims.iat !== 'number' || claims.iat - SKEW_S > t) fail('issued in the future');
  if (claims.email_verified !== true) fail('email not verified');
  if (typeof claims.email !== 'string' || !claims.email) fail('no email');
  return claims;
}
