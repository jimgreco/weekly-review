import http from 'node:http';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { verify, reviewUrl, archiveUrl } from './links.js';
import { renderPage, renderArchive, weekLabel } from './render.js';
import { weekRange } from './week.js';
import { MAX_BODY_BYTES, InvalidReview, createPublisher, tokenMatches, validateSubmission } from './ingest.js';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer', // keep the token out of Referer headers
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
};

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

const sendJson = (res, status, body) => send(res, status, JSON.stringify(body), 'application/json');

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    throw Object.assign(new InvalidReview('Content-Type must be application/json'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new InvalidReview('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InvalidReview('body is not valid JSON');
  }
}

export function createHandler(config, store, { publish = createPublisher(config, store) } = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api/reviews') {
        // Same 404 for "ingest off", "no token" and "wrong token".
        if (!tokenMatches(config.ingestTokenSha256, req.headers.authorization)) return sendJson(res, 404, { error: 'not found' });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        try {
          const submission = validateSubmission(await readJson(req));
          return sendJson(res, 200, await publish(submission));
        } catch (error) {
          if (error instanceof InvalidReview) return sendJson(res, error.status ?? 400, { error: error.message });
          if (error.status === 503) return sendJson(res, 503, { error: error.message });
          throw error;
        }
      }

      if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
      if (url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');

      const token = url.searchParams.get('t');
      const review = url.pathname.match(/^\/r\/(\d{4}-\d{2}-\d{2})$/);
      if (review) {
        const week = review[1];
        if (!verify(config.linkSecret, `review:${week}`, token)) return send(res, 404, 'Not found', 'text/plain');
        const data = await store.load(week);
        if (!data) return send(res, 404, 'Not found', 'text/plain');
        return send(res, 200, renderPage(data, { archiveHref: archiveUrl(config) }));
      }
      if (url.pathname === '/archive') {
        if (!verify(config.linkSecret, 'archive', token)) return send(res, 404, 'Not found', 'text/plain');
        const weeks = await store.list();
        return send(res, 200, renderArchive(weeks.map((w) => ({
          href: reviewUrl(config, w), label: weekLabel(weekRange(w)),
        }))));
      }
      return send(res, 404, 'Not found', 'text/plain');
    } catch (error) {
      console.error('[http]', error);
      return send(res, 500, 'Something went wrong', 'text/plain');
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  if (!config.linkSecret) throw new Error('Missing required environment variable LINK_SECRET');
  if (!config.ingestTokenSha256) console.warn('[http] INGEST_TOKEN_SHA256 is unset; the routine cannot post reviews');
  const store = createStore(config.dataDir);
  http.createServer(createHandler(config, store)).listen(config.port, () => {
    console.log(`[http] listening on ${config.port}`);
  });
}
