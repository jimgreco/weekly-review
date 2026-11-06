import http from 'node:http';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { verify, reviewUrl, archiveUrl } from './links.js';
import { renderPage, renderArchive, weekLabel } from './render.js';
import { runReview } from './run.js';
import { currentWeek, previousWeek, localParts, weekRange } from './week.js';

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

export function createHandler(config, store) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
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

/**
 * Which week, if any, is due to be reviewed now: the current week once the
 * send day/hour has arrived, or last week on Monday morning if the Sunday run
 * was missed (for example the host was down).
 */
export async function dueWeek(config, store, now = new Date()) {
  const { weekday, hour } = localParts(now, config.timezone);
  const week = currentWeek(now, config.timezone);
  const isSendDay = weekday === config.sendDay;
  if (isSendDay && hour >= config.sendHour) {
    const saved = await store.load(week.start);
    if (!saved?.sentAt) return week;
  }
  // Catch-up applies only for the default Sunday schedule.
  if (config.sendDay === 0 && weekday === 1 && hour < 12) {
    const last = previousWeek(week);
    const saved = await store.load(last.start);
    if (!saved?.sentAt) return last;
  }
  return null;
}

function startScheduler(config, store) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const week = await dueWeek(config, store);
      if (week) {
        console.log(`[scheduler] building review for ${week.start}`);
        await runReview(config, store, week, { send: true });
        console.log(`[scheduler] sent review for ${week.start}`);
      }
    } catch (error) {
      // The next tick retries; the email's idempotency key prevents duplicates.
      console.error('[scheduler]', error);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 5000).unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  for (const name of ['REVIEW_EMAIL', 'LINK_SECRET']) {
    if (!process.env[name]) throw new Error(`Missing required environment variable ${name}`);
  }
  const store = createStore(config.dataDir);
  http.createServer(createHandler(config, store)).listen(config.port, () => {
    console.log(`[http] listening on ${config.port}`);
  });
  if (process.env.SCHEDULER_ENABLED !== 'false') startScheduler(config, store);
}
