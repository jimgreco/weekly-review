import http from 'node:http';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { verify, reviewUrl, archiveUrl, postUrl } from './links.js';
import { renderPage, renderArchive, renderPost, renderPostEmail, describePost, weekLabel } from './render.js';
import { POST_KINDS, createPostPublisher, createPostsStore, validPostKey, validatePost } from './posts.js';
import { createDecisionsStore, validateDecisions } from './decisions.js';
import { sendEmail } from './email.js';
import { addDays, weekRange } from './week.js';
import { MAX_BODY_BYTES, InvalidReview, createPublisher, tokenMatches, validateSubmission } from './ingest.js';
import { createNotesStore, noteWeek, validateNote } from './notes.js';
import { createSummaries } from './summaries.js';
import { CommitmentConflict, createCommitmentsStore, forRoutine } from './commitments.js';

const MAX_NOTE_BODY_BYTES = 64 * 1024;
const MAX_FORM_BYTES = 4 * 1024;
const HISTORY_WEEKS = 8;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer', // keep the token out of Referer headers
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
};

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

const sendJson = (res, status, body) => send(res, status, JSON.stringify(body), 'application/json');

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    throw Object.assign(new InvalidReview('Content-Type must be application/json'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new InvalidReview('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InvalidReview('body is not valid JSON');
  }
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

export function createHandler(config, store, {
  commitments = createCommitmentsStore(config.dataDir || './data'),
  publish = createPublisher(config, store, { commitments }),
  notes = createNotesStore(config.dataDir || './data'),
  summaries = createSummaries(config, notes),
  posts = createPostsStore(config.dataDir || './data'),
  decisions = createDecisionsStore(config.dataDir || './data'),
  sendImpl = sendEmail,
} = {}) {
  // Where a post's email button and page link lead: a pulse points at the
  // review that proposed the week's commitments; the others at their own page.
  const pulseReview = (post) => reviewUrl(config, addDays(post.key, -7));
  const publishPost = createPostPublisher(config, posts, {
    sendImpl,
    describe: async (post) => describePost(post, post.kind === 'decision' ? await decisions.find(post.key) : null),
    renderEmail: renderPostEmail,
    urlFor: (post) => (post.kind === 'pulse'
      ? { href: `${pulseReview(post)}#commitments`, label: "Open this week's commitments" }
      : { href: postUrl(config, post.kind, post.key), label: 'Open the full page' }),
  });
  const notesOn = config.notesTokenSha256 && config.notesTokenSha256 !== config.ingestTokenSha256;
  const origin = (() => { try { return new URL(config.publicUrl).origin; } catch { return null; } })();
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      // Claude Code summaries behind Google sign-in; their own headers and CSP.
      if (url.pathname === '/summaries' || url.pathname.startsWith('/summaries/')) return await summaries(req, res, url);

      // Owner notes from the Mac. Its own token, so the Mac never holds the
      // ingest token and the cloud routine can't write notes. Same 404 rules.
      if (url.pathname === '/api/notes/claude-code') {
        if (!notesOn || !tokenMatches(config.notesTokenSha256, req.headers.authorization)) return sendJson(res, 404, { error: 'not found' });
        if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
        try {
          const week = noteWeek(url.searchParams.get('week'));
          await notes.save(week, 'claude-code', validateNote(await readJson(req, MAX_NOTE_BODY_BYTES)));
          return sendJson(res, 200, { week, stored: true });
        } catch (error) {
          if (error instanceof InvalidReview) return sendJson(res, error.status ?? 400, { error: error.message });
          throw error;
        }
      }

      // The routine reads notes with the ingest token (a network secret for this host).
      if (url.pathname === '/api/notes') {
        if (!tokenMatches(config.ingestTokenSha256, req.headers.authorization)) return sendJson(res, 404, { error: 'not found' });
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        let week;
        try { week = noteWeek(url.searchParams.get('week')); } catch (error) { return sendJson(res, 400, { error: error.message }); }
        return sendJson(res, 200, { week, notes: await notes.loadAll(week) });
      }

      // The routine reads the commitments that were for the review week (to
      // score them) and the follow-through of the weeks before. Ingest token.
      if (url.pathname === '/api/commitments') {
        if (!tokenMatches(config.ingestTokenSha256, req.headers.authorization)) return sendJson(res, 404, { error: 'not found' });
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        let week;
        try { week = noteWeek(url.searchParams.get('week')); } catch (error) { return sendJson(res, 400, { error: error.message }); }
        return sendJson(res, 200, {
          week,
          due: forRoutine(await commitments.load(week)),
          history: await commitments.history(week, HISTORY_WEEKS),
        });
      }

      // Accept, decline or undo one of next week's commitments from the review
      // page. The page's private link token is the credential, as for reading.
      const decide = url.pathname.match(/^\/r\/(\d{4}-\d{2}-\d{2})\/commitments$/);
      if (decide) {
        const week = decide[1];
        if (!verify(config.linkSecret, `review:${week}`, url.searchParams.get('t'))) return send(res, 404, 'Not found', 'text/plain');
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
        // The token in the URL already stops cross-site posts; this is a second
        // check. Browsers send "null" here because of the no-referrer policy.
        const from = req.headers.origin;
        if (from && from !== 'null' && from !== origin) return send(res, 403, 'Forbidden', 'text/plain');
        const form = await readForm(req);
        const decision = { accept: 'accepted', decline: 'declined', undo: null }[form?.get('decision')];
        if (!form || decision === undefined) return send(res, 400, 'Bad request', 'text/plain');
        if (!(await store.load(week))) return send(res, 404, 'Not found', 'text/plain');
        try {
          await commitments.decide(addDays(week, 7), form.get('id') ?? '', decision);
        } catch (error) {
          // Unknown id, or a week the next review has already scored: just show the page as it is.
          if (!(error instanceof CommitmentConflict)) throw error;
        }
        res.writeHead(303, { Location: `${reviewUrl(config, week)}#commitments`, ...SECURITY_HEADERS });
        return res.end();
      }

      // Pulses, decision briefs and monthly roll-ups from the other routines.
      if (url.pathname === '/api/posts') {
        if (!tokenMatches(config.ingestTokenSha256, req.headers.authorization)) return sendJson(res, 404, { error: 'not found' });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        try {
          return sendJson(res, 200, await publishPost(validatePost(await readJson(req, MAX_NOTE_BODY_BYTES))));
        } catch (error) {
          if (error instanceof InvalidReview) return sendJson(res, error.status ?? 400, { error: error.message });
          if (error.status === 503) return sendJson(res, 503, { error: error.message });
          throw error;
        }
      }

      // The owner's decision register. The Mac replaces it (notes token) and
      // reads it back; the routines read it (ingest token). `briefed` says
      // whether a brief has already been posted for that decision.
      if (url.pathname === '/api/decisions') {
        const asRoutine = tokenMatches(config.ingestTokenSha256, req.headers.authorization);
        const asOwner = notesOn && tokenMatches(config.notesTokenSha256, req.headers.authorization);
        if (!asRoutine && !asOwner) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const briefed = new Set(await posts.list('decision'));
          return sendJson(res, 200, { decisions: (await decisions.load()).map((d) => ({ ...d, briefed: briefed.has(d.id) })) });
        }
        if (req.method !== 'PUT' || !asOwner) return sendJson(res, 405, { error: 'method not allowed' });
        try {
          const clean = validateDecisions(await readJson(req, MAX_NOTE_BODY_BYTES));
          await decisions.save(clean);
          return sendJson(res, 200, { stored: clean.length });
        } catch (error) {
          if (error instanceof InvalidReview) return sendJson(res, error.status ?? 400, { error: error.message });
          throw error;
        }
      }

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
        return send(res, 200, renderPage(data, {
          archiveHref: archiveUrl(config),
          commitments: { due: await commitments.load(week), next: await commitments.load(addDays(week, 7)) },
          decideHref: `/r/${week}/commitments?t=${encodeURIComponent(token)}`,
        }));
      }
      const postPage = url.pathname.match(/^\/p\/([a-z]+)\/([a-z0-9-]{3,50})$/);
      if (postPage) {
        const [, kind, key] = postPage;
        if (!Object.hasOwn(POST_KINDS, kind) || !validPostKey(kind, key) || !verify(config.linkSecret, `post:${kind}:${key}`, token)) return send(res, 404, 'Not found', 'text/plain');
        const post = await posts.load(kind, key);
        if (!post) return send(res, 404, 'Not found', 'text/plain');
        const back = kind === 'pulse' && (await store.load(addDays(key, -7)))
          ? { backHref: `${pulseReview(post)}#commitments`, backLabel: "This week's commitments" } : {};
        return send(res, 200, renderPost(post, { archiveHref: archiveUrl(config), ...back }));
      }
      if (url.pathname === '/archive') {
        if (!verify(config.linkSecret, 'archive', token)) return send(res, 404, 'Not found', 'text/plain');
        const weeks = await store.list();
        const group = async (kind, title) => ({ title, entries: await Promise.all((await posts.list(kind)).map(async (key) => {
          const post = await posts.load(kind, key);
          return { href: postUrl(config, kind, key), label: kind === 'pulse' ? post.subtitle : post.title };
        })) });
        return send(res, 200, renderArchive(weeks.map((w) => ({
          href: reviewUrl(config, w), label: weekLabel(weekRange(w)),
        })), [await group('monthly', 'Months'), await group('decision', 'Decision briefs'), await group('pulse', 'Midweek checks')]));
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
  if (!config.googleClientId || !config.summariesAllowedEmails.length) console.log('[http] GOOGLE_CLIENT_ID or SUMMARIES_ALLOWED_EMAILS is unset; /summaries is off');
  const store = createStore(config.dataDir);
  http.createServer(createHandler(config, store)).listen(config.port, () => {
    console.log(`[http] listening on ${config.port}`);
  });
}
