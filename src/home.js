// The owner's home page, behind the same Google sign-in as /summaries
// (src/summaries.js owns the sign-in routes and the session cookie):
//
//   GET  /home                 this week's and next week's commitments with
//                              accept / decline, follow-through, the latest
//                              review, pulse, month and Claude Code summary,
//                              upcoming decisions, and the full archive
//   POST /home/commitments     accept, decline or undo one commitment
//   GET  /decisions            the decision register
//   GET  /decisions/new, /decisions/<id>    add or edit one
//   POST /decisions/new, /decisions/<id>    save it
//
// Every POST needs the session cookie (SameSite=Lax) and a form token derived
// from it, and refuses a cross-site Origin.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, parseCookies, readSession, sessionKey, summariesEnabled } from './summaries.js';
import { CommitmentConflict } from './commitments.js';
import { DECISION_ID_RE, MAX_DECISIONS, validateDecisions } from './decisions.js';
import { InvalidReview } from './ingest.js';
import { archiveUrl, postUrl, reviewUrl } from './links.js';
import { renderDecisionForm, renderDecisions, renderHome, weekLabel } from './render.js';
import { addDays, currentWeek, localDate, weekRange } from './week.js';

const MAX_FORM_BYTES = 16 * 1024;
const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

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

/** A URL-safe id from a title, unique among `taken`. */
export function decisionId(title, taken) {
  let base = String(title).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!DECISION_ID_RE.test(base)) base = 'decision';
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function createHome(config, { store, commitments, posts, decisions, notes }, { now = Date.now } = {}) {
  const enabled = summariesEnabled(config);
  const key = enabled ? sessionKey(config.linkSecret) : null;
  const allowed = config.summariesAllowedEmails ?? [];
  const origin = (() => { try { return new URL(config.publicUrl).origin; } catch { return null; } })();

  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...HEADERS, ...headers });
    res.end(body);
  };
  const plain = (res, status, body) => reply(res, status, body, { 'Content-Type': 'text/plain' });
  const redirect = (res, location) => reply(res, 303, '', { Location: location });
  const formToken = (cookie) => createHmac('sha256', key).update(`form:${cookie}`).digest('base64url');
  const tokenOk = (cookie, given) => {
    if (typeof given !== 'string' || !given) return false;
    const a = Buffer.from(formToken(cookie));
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // One change to the register at a time: the page edits one entry of a list
  // that is stored whole.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function homeData() {
    const today = localDate(new Date(now()), config.timezone || 'America/New_York');
    const week = currentWeek(new Date(now()), config.timezone || 'America/New_York');
    const reviews = await store.list();
    const list = async (kind) => Promise.all((await posts.list(kind)).map(async (k) => {
      const post = await posts.load(kind, k);
      return { href: postUrl(config, kind, k), title: post.title, subtitle: post.subtitle, generatedAt: post.generatedAt };
    }));
    const briefed = new Set(await posts.list('decision'));
    const all = await decisions.load();
    const summaryWeeks = await notes.listWeeks('claude-code');
    return {
      today,
      thisWeek: await commitments.load(week.start),
      nextWeek: await commitments.load(addDays(week.start, 7)),
      history: (await commitments.history(addDays(week.start, 7), 8)).map((h) => ({ ...h, label: weekLabel(weekRange(h.week)) })),
      reviews: reviews.map((w) => ({ href: reviewUrl(config, w), label: weekLabel(weekRange(w)) })),
      months: await list('monthly'),
      pulses: await list('pulse'),
      checkins: await list('checkin'),
      briefs: await list('decision'),
      upcoming: all.filter((d) => d.status === 'open' && d.date >= today).slice(0, 3)
        .map((d) => ({ ...d, briefHref: briefed.has(d.id) ? postUrl(config, 'decision', d.id) : null })),
      openDecisions: all.filter((d) => d.status === 'open').length,
      summaries: summaryWeeks.map((w) => ({ href: `/summaries/${w}`, label: weekLabel(weekRange(w)) })),
      archiveHref: archiveUrl(config),
    };
  }

  // Form fields -> one register entry (validated with the whole list on save).
  const fromForm = (form, id) => ({
    id,
    date: (form.get('date') ?? '').trim(),
    title: form.get('title') ?? '',
    question: form.get('question') ?? '',
    options: (form.get('options') ?? '').split(/\r?\n/).map((o) => o.trim()).filter(Boolean),
    context: (form.get('context') ?? '').replace(/\r\n/g, '\n'),
    status: form.get('status') ?? 'open',
    outcome: (form.get('outcome') ?? '').replace(/\r\n/g, '\n'),
  });

  return async function handle(req, res, url) {
    if (!enabled) return plain(res, 404, 'Not found');
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const email = readSession(key, cookie, allowed, now());
    const path = url.pathname;
    if (!email) return req.method === 'GET' ? redirect(res, '/summaries/login') : plain(res, 403, 'Forbidden');
    const csrf = formToken(cookie);

    let form = null;
    if (req.method === 'POST') {
      const from = req.headers.origin;
      if (from && from !== 'null' && from !== origin) return plain(res, 403, 'Forbidden');
      form = await readForm(req);
      if (!form || !tokenOk(cookie, form.get('csrf'))) return plain(res, 403, 'Forbidden');
    } else if (req.method !== 'GET') return plain(res, 405, 'Method not allowed');

    if (path === '/home') {
      if (form) return plain(res, 405, 'Method not allowed');
      return reply(res, 200, renderHome(await homeData(), { email, csrf }));
    }

    if (path === '/home/commitments') {
      if (!form) return plain(res, 405, 'Method not allowed');
      const decision = { accept: 'accepted', decline: 'declined', undo: null }[form.get('decision')];
      let week;
      try { week = weekRange(form.get('week')).start; } catch { return plain(res, 400, 'Bad request'); }
      if (decision === undefined) return plain(res, 400, 'Bad request');
      try {
        await commitments.decide(week, form.get('id') ?? '', decision);
      } catch (error) {
        if (!(error instanceof CommitmentConflict)) throw error; // unknown id or a scored week: show the page as it is
      }
      return redirect(res, '/home#commitments');
    }

    if (path === '/decisions') {
      if (form) return plain(res, 405, 'Method not allowed');
      const briefed = new Set(await posts.list('decision'));
      const list = (await decisions.load()).map((d) => ({ ...d, briefHref: briefed.has(d.id) ? postUrl(config, 'decision', d.id) : null }));
      return reply(res, 200, renderDecisions(list, { email, today: localDate(new Date(now()), config.timezone || 'America/New_York') }));
    }

    const one = path.match(/^\/decisions\/([a-z0-9-]{3,50})$/);
    if (one) {
      const isNew = one[1] === 'new';
      if (!form) {
        const existing = isNew ? null : await decisions.find(one[1]);
        if (!isNew && !existing) return plain(res, 404, 'Not found');
        return reply(res, 200, renderDecisionForm(existing, { email, csrf, isNew }));
      }
      const outcome = await serial(async () => {
        const all = await decisions.load();
        const index = isNew ? -1 : all.findIndex((d) => d.id === one[1]);
        if (!isNew && index < 0) return { status: 404 };
        if (isNew && all.length >= MAX_DECISIONS) return { status: 400, entry: fromForm(form, 'new'), error: `The register is full (${MAX_DECISIONS} decisions).` };
        const entry = fromForm(form, isNew ? decisionId(form.get('title') ?? '', [...all.map((d) => d.id), 'new']) : one[1]);
        const next = isNew ? [...all, entry] : all.map((d, i) => (i === index ? entry : d));
        try {
          await decisions.save(validateDecisions({ decisions: next }));
          return { status: 303 };
        } catch (error) {
          if (!(error instanceof InvalidReview)) throw error;
          // "decisions[3].title is required" -> "title is required"
          return { status: 400, entry, error: error.message.replace(/^decisions\[\d+\]\./, '') };
        }
      });
      if (outcome.status === 404) return plain(res, 404, 'Not found');
      if (outcome.status === 400) return reply(res, 400, renderDecisionForm(outcome.entry, { email, csrf, isNew, error: outcome.error }));
      return redirect(res, '/decisions');
    }

    return plain(res, 404, 'Not found');
  };
}

