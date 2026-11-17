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

// Journal entry text is for the narrative only. It never leaves the routine
// session: the review site stores and shows only the journal's counts, and the
// 8-week history keeps counts too (the week under review carries the text).
export function journalCountsOnly(journal) {
  if (!journal || typeof journal !== 'object') return journal;
  const { entries: _entries, truncated: _truncated, ...counts } = journal;
  return counts;
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
      const { previous: _p, change: _c, ms: _ms, ...rest } = app === 'journal' ? journalCountsOnly(got[app]) : got[app];
      sources[app].push({ week: start, ...rest });
    }
  }
  return { weeks: starts, sources };
}

// Owner notes the Mac posted for this week (GET /api/notes, ingest token or the
// proxy). Optional context: a failure, or no site configured, gives
// notes = null and a reason, never a failed collect.
export async function collectNotes(config, week, { fetchImpl = fetch } = {}) {
  if (!config.siteUrl || (!config.ingestToken && !config.authViaProxy)) return { notes: null, status: 'disabled' };
  try {
    const response = await fetchImpl(`${config.siteUrl}/api/notes?week=${encodeURIComponent(week.start)}`, {
      headers: config.ingestToken ? { Authorization: `Bearer ${config.ingestToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.fetchTimeoutMs ?? 20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.week !== week.start || !body.notes || typeof body.notes !== 'object') throw new Error('unexpected response shape');
    const note = body.notes['claude-code'];
    const claudeCode = note && typeof note.text === 'string' && note.text.trim()
      ? { text: note.text, generatedAt: typeof note.generatedAt === 'string' ? note.generatedAt : null }
      : null;
    return { notes: { claudeCode }, status: claudeCode ? 'ok' : 'none' };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : error.message;
    return { notes: null, status: 'error', error: reason };
  }
}

// The commitments loop (src/commitments.js): the accepted commitments that
// were for this week, so the routine can score them, and the follow-through
// of the weeks before. Optional context, like notes: a failure gives
// commitments = null and a reason, never a failed collect.
export async function collectCommitments(config, week, { fetchImpl = fetch } = {}) {
  if (!config.siteUrl || (!config.ingestToken && !config.authViaProxy)) return { commitments: null, status: 'disabled' };
  try {
    const response = await fetchImpl(`${config.siteUrl}/api/commitments?week=${encodeURIComponent(week.start)}`, {
      headers: config.ingestToken ? { Authorization: `Bearer ${config.ingestToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.fetchTimeoutMs ?? 20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.week !== week.start || !Array.isArray(body.history) || (body.due != null && !Array.isArray(body.due.items))) {
      throw new Error('unexpected response shape');
    }
    const accepted = body.due ? body.due.items.filter((c) => c.decision === 'accepted').length : 0;
    return {
      commitments: { due: body.due ?? null, history: body.history },
      status: body.due ? 'ok' : 'none',
      summary: body.due ? `${accepted} accepted of ${body.due.items.length} proposed` : null,
    };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : error.message;
    return { commitments: null, status: 'error', error: reason };
  }
}

// The owner's open decisions dated within the next `days` days (GET
// /api/decisions, ingest token or the proxy; src/decisions.js). Optional
// context, like notes: a failure gives decisions = null and a reason.
export async function collectDecisions(config, today, days, { fetchImpl = fetch } = {}) {
  if (!config.siteUrl || (!config.ingestToken && !config.authViaProxy)) return { decisions: null, status: 'disabled' };
  try {
    const response = await fetchImpl(`${config.siteUrl}/api/decisions`, {
      headers: config.ingestToken ? { Authorization: `Bearer ${config.ingestToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.fetchTimeoutMs ?? 20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.decisions)) throw new Error('unexpected response shape');
    const until = addDays(today, days);
    const upcoming = body.decisions
      .filter((d) => d && d.status === 'open' && typeof d.date === 'string' && d.date >= today && d.date <= until)
      .map(({ id, date, title, question, options, context, briefed }) => ({ id, date, title, question, options: options ?? [], context: context ?? null, briefed: Boolean(briefed) }));
    return { decisions: { upcoming }, status: upcoming.length ? 'ok' : 'none', summary: upcoming.length ? `${upcoming.length} in the next ${days} days` : null };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : error.message;
    return { decisions: null, status: 'error', error: reason };
  }
}
