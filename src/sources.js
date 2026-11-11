// Calls each app's GET /api/weekly-summary (docs/weekly-summary-contract.md).
// Every source fails on its own: a missing, slow or broken app becomes a
// {status: 'error' | 'disabled'} entry and the rest of the review still goes out.
import { APPS } from './config.js';
import { addDays, weekRange } from './week.js';

// Oura's API agreement forbids passing Oura data, or anything derived from it,
// to an AI model, and the routine hands this review to Claude. Macrovana's
// endpoint already sends these as null; enforce it here too.
const OURA_FIELDS = ['sleepScore', 'readinessScore', 'avgSteps'];
export function stripOura(macros) {
  if (macros?.status !== 'ok') return macros;
  const clean = structuredClone(macros);
  for (const period of ['current', 'previous', 'change']) {
    if (clean[period] && typeof clean[period] === 'object') {
      for (const field of OURA_FIELDS) if (field in clean[period]) clean[period][field] = null;
    }
  }
  return clean;
}

async function fetchSource(app, { url, token }, week, { timeoutMs, fetchImpl, authViaProxy }) {
  if (!url || (!token && !authViaProxy)) return { status: 'disabled' };
  const started = Date.now();
  try {
    const response = await fetchImpl(`${url}/api/weekly-summary?week=${encodeURIComponent(week.start)}`, {
      // With authViaProxy and no token, the agent proxy adds Authorization.
      headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
      redirect: 'error', // never forward the token somewhere else
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // 404 is what the apps return for a missing/wrong token or unset env, by design.
      const hint = response.status === 404 ? ' (endpoint off, or token mismatch)' : '';
      return { status: 'error', error: `HTTP ${response.status}${hint}` };
    }
    const body = await response.json();
    if (body?.version !== 1 || body.app !== app || body.week?.start !== week.start
        || typeof body.data?.status !== 'string') {
      return { status: 'error', error: 'unexpected response shape' };
    }
    const data = app === 'macros' ? stripOura(body.data) : body.data;
    return { ...data, ms: Date.now() - started };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : error.message;
    return { status: 'error', error: reason };
  }
}

export async function collectWeek(config, week, { fetchImpl = fetch } = {}) {
  const results = await Promise.all(APPS.map((app) =>
    fetchSource(app, config.sources[app], week, { timeoutMs: config.fetchTimeoutMs, fetchImpl, authViaProxy: config.authViaProxy })));
  return {
    week: { start: week.start, end: week.end },
    generatedAt: new Date().toISOString(),
    sources: Object.fromEntries(APPS.map((app, i) => [app, results[i]])),
  };
}

// Earlier weeks for trend context, oldest first, excluding `week` itself. Each
// entry is that week's summary without its own previous/change comparison.
// Weeks are fetched one after another (apps in parallel) to stay well inside
// the apps' rate limits.
export async function collectHistory(config, week, weeks, { fetchImpl = fetch } = {}) {
  const starts = Array.from({ length: weeks }, (_, i) => addDays(week.start, -7 * (weeks - i)));
  const sources = Object.fromEntries(APPS.map((app) => [app, []]));
  for (const start of starts) {
    const { sources: got } = await collectWeek(config, weekRange(start), { fetchImpl });
    for (const app of APPS) {
      const { previous: _p, change: _c, ms: _ms, ...rest } = got[app];
      sources[app].push({ week: start, ...rest });
    }
  }
  return { weeks: starts, sources };
}
