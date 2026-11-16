// Commands. The weekly routine runs collect, writes the narrative, then publish.
//
//   node src/cli.js collect [--week 2026-11-02 | --current | --month [2026-11]] [--history N] [--out review.json]
//       Call every app's weekly-summary endpoint and write the review JSON.
//       Default week: the current one on Sunday, otherwise the last finished week.
//       --current is the week in progress (the midweek routine). --month is the
//       last week of that month (default: last month) with enough history to
//       cover it and the month before, listed under `month`.
//   node src/cli.js post --kind pulse|decision|monthly --key <Monday|decision id|YYYY-MM> --text post.md [--model id] [--send]
//       Post a midweek pulse, decision brief or monthly roll-up to the site (src/posts.js).
//   node src/cli.js decisions pull [--out decisions.json] | push --file decisions.json
//       On the owner's Mac: read or replace the decision register on the site (notes token).
//   node src/cli.js publish --in review.json [--narrative narrative.md] [--commitments commitments.json] [--model id] [--send]
//       Post the review (and narrative) to the review site. --send emails the
//       link, at most once per week. --commitments scores this week's accepted
//       commitments and proposes next week's ({results, next}; src/commitments.js).
//   node src/cli.js render --in review.json [--narrative narrative.md] [--commitments commitments.json] --out page.html
//       Write the page locally, to check it before publishing.
//   node src/cli.js link [--week 2026-11-02]
//       On the review site: print the private links for a week and the archive.
//   node src/cli.js post-notes --week 2026-11-02 --file summary.md [--token-file path]
//       On the owner's Mac: store the week's Claude Code summary on the site.
//       Token from NOTES_TOKEN, else --token-file (default ~/.config/weekly-review/notes.token).
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { APPS, loadConfig } from './config.js';
import { collectCommitments, collectDecisions, collectHistory, collectNotes, collectWeek } from './sources.js';
import { POST_KINDS, validPostKey } from './posts.js';
import { validateDecisions } from './decisions.js';
import { validateCommitments } from './commitments.js';
import { MAX_NOTE_CHARS } from './notes.js';
import { renderPage } from './render.js';
import { reviewUrl, archiveUrl } from './links.js';
import { currentWeek, localDate, localParts, monthWeeks, previousMonth, previousWeek, weekRange } from './week.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = loadConfig();

export function defaultWeek(now, timezone) {
  const week = currentWeek(now, timezone);
  return localParts(now, timezone).weekday === 0 ? week : previousWeek(week);
}

async function loadSubmission() {
  const input = option('--in');
  if (!input) throw new Error('--in <review.json> is required');
  const review = JSON.parse(await readFile(input, 'utf8'));
  const narrativeFile = option('--narrative');
  const text = narrativeFile ? (await readFile(narrativeFile, 'utf8')).trim() : '';
  // Checked here too, so a mistake in the file is reported before anything is posted.
  const commitmentsFile = option('--commitments');
  const commitments = commitmentsFile ? validateCommitments(JSON.parse(await readFile(commitmentsFile, 'utf8'))) : null;
  return { review, narrative: text ? { text, model: option('--model') ?? null } : null, commitments };
}

export const DEFAULT_NOTES_TOKEN_FILE = path.join(homedir(), '.config', 'weekly-review', 'notes.token');

/** The notes token, from NOTES_TOKEN or a file. Never logged. */
export async function readNotesToken(envToken, tokenFile = DEFAULT_NOTES_TOKEN_FILE) {
  let token = envToken;
  if (!token) {
    try {
      token = (await readFile(tokenFile, 'utf8')).trim();
    } catch (error) {
      throw new Error(`No NOTES_TOKEN and no readable token file at ${tokenFile} (${error.code ?? 'error'})`);
    }
    const { mode } = await stat(tokenFile);
    if (mode & 0o077) console.error(`Warning: ${tokenFile} is readable by others; chmod 600 it`);
  }
  if (!/^\S{20,256}$/.test(token)) throw new Error('The notes token is malformed (expected 20-256 non-space characters)');
  return token;
}

function checkSiteUrl(siteUrl) {
  const url = new URL(siteUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('REVIEW_SITE_URL must be https');
}

async function main() {
  if (command === 'post-notes') {
    if (!option('--week')) throw new Error('--week <Monday> is required');
    const week = weekRange(option('--week')).start;
    const file = option('--file');
    if (!file) throw new Error('--file <summary.md> is required');
    if (!config.siteUrl) throw new Error('REVIEW_SITE_URL is required');
    checkSiteUrl(config.siteUrl);
    const text = (await readFile(file, 'utf8')).trim();
    if (!text) throw new Error(`${file} is empty`);
    if (text.length > MAX_NOTE_CHARS) throw new Error(`${file} is over ${MAX_NOTE_CHARS} characters`);
    const token = await readNotesToken(config.notesToken, option('--token-file') ?? DEFAULT_NOTES_TOKEN_FILE);
    const response = await fetch(`${config.siteUrl}/api/notes/claude-code?week=${encodeURIComponent(week)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, generatedAt: new Date().toISOString() }),
      redirect: 'error', // never send the token anywhere else
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    if (response.status === 404) throw new Error('Review site returned 404 (notes off, or token mismatch)');
    if (!response.ok) throw new Error(`Review site returned ${response.status}: ${body.slice(0, 300)}`);
    console.log(`Stored the Claude Code notes for ${JSON.parse(body).week} (${text.length} chars)`);
    return;
  }

  if (command === 'decisions') {
    const action = args[0];
    if (!config.siteUrl) throw new Error('REVIEW_SITE_URL is required');
    checkSiteUrl(config.siteUrl);
    const token = await readNotesToken(config.notesToken, option('--token-file') ?? DEFAULT_NOTES_TOKEN_FILE);
    const request = async (init = {}) => {
      const response = await fetch(`${config.siteUrl}/api/decisions`, {
        ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      const body = await response.text();
      if (response.status === 404) throw new Error('Review site returned 404 (notes token off, or token mismatch)');
      if (!response.ok) throw new Error(`Review site returned ${response.status}: ${body.slice(0, 300)}`);
      return JSON.parse(body);
    };
    if (action === 'pull') {
      const { decisions } = await request();
      const json = JSON.stringify({ decisions: decisions.map(({ briefed: _briefed, ...d }) => d) }, null, 2);
      const out = option('--out');
      if (out) await writeFile(out, json, { mode: 0o600 });
      else console.log(json);
      console.error(`${decisions.length} decisions (${decisions.filter((d) => d.status === 'open').length} open, ${decisions.filter((d) => d.briefed).length} briefed)`);
      return;
    }
    if (action === 'push') {
      const file = option('--file');
      if (!file) throw new Error('--file <decisions.json> is required');
      const decisions = validateDecisions(JSON.parse(await readFile(file, 'utf8')));
      console.log(`Stored ${(await request({ method: 'PUT', body: JSON.stringify({ decisions }) })).stored} decisions`);
      return;
    }
    throw new Error('Usage: node src/cli.js decisions <pull [--out file] | push --file file>');
  }

  if (command === 'post') {
    const kind = option('--kind');
    const key = option('--key');
    if (!Object.hasOwn(POST_KINDS, kind ?? '')) throw new Error(`--kind must be one of ${Object.keys(POST_KINDS).join(', ')}`);
    if (!validPostKey(kind, key)) throw new Error('--key must be a Monday for a pulse, a decision id for a decision, or YYYY-MM for a monthly');
    if (!option('--text')) throw new Error('--text <post.md> is required');
    if (!config.siteUrl || (!config.ingestToken && !config.authViaProxy)) throw new Error('REVIEW_SITE_URL and REVIEW_INGEST_TOKEN (or AUTH_VIA_PROXY=1) are required');
    const text = (await readFile(option('--text'), 'utf8')).trim();
    if (!text) throw new Error(`${option('--text')} is empty`);
    if (text.length > POST_KINDS[kind].maxChars) throw new Error(`${option('--text')} is over ${POST_KINDS[kind].maxChars} characters`);
    const response = await fetch(`${config.siteUrl}/api/posts`, {
      method: 'POST',
      headers: config.ingestToken
        ? { Authorization: `Bearer ${config.ingestToken}`, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key, text, model: option('--model') ?? null, generatedAt: new Date().toISOString(), send: flag('--send') || flag('--resend'), resend: flag('--resend') }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Review site returned ${response.status}: ${body.slice(0, 300)}`);
    const result = JSON.parse(body);
    console.log(`Posted ${result.kind} ${result.key}; ${result.sent ? 'emailed now' : result.sentAt ? `already emailed at ${result.sentAt}` : 'not emailed'}`);
    return;
  }

  const today = localDate(new Date(), config.timezone);
  let month = null;
  let week;
  if (flag('--month')) {
    const given = option('--month');
    const key = given && !given.startsWith('--') ? given : previousMonth(today.slice(0, 7));
    const previous = monthWeeks(previousMonth(key));
    month = { ...monthWeeks(key), previous: { key: previous.key, label: previous.label, weeks: previous.weeks } };
    week = weekRange(month.weeks.at(-1));
    if (week.end >= today) throw new Error(`${month.label} is not over yet`);
  } else if (flag('--current')) week = currentWeek(new Date(), config.timezone);
  else week = option('--week') ? weekRange(option('--week')) : defaultWeek(new Date(), config.timezone);

  if (command === 'collect') {
    const review = await collectWeek(config, week);
    // A month needs its own weeks and the month before: 8 or 9 earlier weeks.
    const weeks = month ? month.weeks.length + month.previous.weeks.length - 1 : Number(option('--history') ?? 0);
    if (!Number.isInteger(weeks) || weeks < 0 || weeks > 12) throw new Error('--history must be 0-12 weeks');
    review.asOf = { date: today, weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][localParts(new Date(), config.timezone).weekday] };
    if (month) review.month = month;
    if (weeks) review.history = await collectHistory(config, week, weeks);
    const notes = await collectNotes(config, week);
    review.notes = notes.notes;
    const commitments = await collectCommitments(config, week);
    review.commitments = commitments.commitments;
    const decisions = await collectDecisions(config, today, 14);
    review.decisions = decisions.decisions;
    const json = JSON.stringify(review, null, 2);
    const out = option('--out');
    if (out) await writeFile(out, json, { mode: 0o600 });
    else console.log(json);
    const statuses = Object.entries(review.sources).map(([k, v]) => `${k}=${v.status}${v.error ? ` (${v.error})` : ''}`);
    console.error(`Week ${week.start}: ${statuses.join(', ')}`);
    if (review.history) {
      const gaps = APPS.flatMap((app) => review.history.sources[app].filter((w) => w.status !== 'ok').map((w) => `${app}@${w.week}=${w.status}`));
      console.error(`History: ${review.history.weeks.length} weeks${gaps.length ? `; not ok: ${gaps.join(', ')}` : ', all ok'}`);
    }
    console.error(`Notes: notes=${notes.status}${notes.error ? ` (${notes.error})` : ''}`);
    console.error(`Decisions: decisions=${decisions.status}${decisions.error ? ` (${decisions.error})` : ''}${decisions.summary ? ` (${decisions.summary})` : ''}`);
    console.error(`Commitments: commitments=${commitments.status}${commitments.error ? ` (${commitments.error})` : ''}${commitments.summary ? ` (${commitments.summary})` : ''}`);
    return;
  }

  if (command === 'publish') {
    if (!config.siteUrl || (!config.ingestToken && !config.authViaProxy)) {
      throw new Error('REVIEW_SITE_URL and REVIEW_INGEST_TOKEN (or AUTH_VIA_PROXY=1) are required');
    }
    // history, notes and the commitments read back from the site are narrative
    // context only; they never reach the stored review.
    const { review: { history: _history, notes: _notes, commitments: _due, decisions: _decisions, asOf: _asOf, month: _month, ...review }, narrative, commitments } = await loadSubmission();
    const response = await fetch(`${config.siteUrl}/api/reviews`, {
      method: 'POST',
      headers: config.ingestToken
        ? { Authorization: `Bearer ${config.ingestToken}`, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review, narrative, ...(commitments ? { commitments } : {}), send: flag('--send') || flag('--resend'), resend: flag('--resend') }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Review site returned ${response.status}: ${body.slice(0, 300)}`);
    const result = JSON.parse(body);
    console.log(`Published ${result.week}; ${result.sent ? 'emailed now' : result.sentAt ? `already emailed at ${result.sentAt}` : 'not emailed'}`);
    if (result.commitments) {
      const { scored, ignored, proposed } = result.commitments;
      console.log(`Commitments: ${scored} scored${ignored ? ` (${ignored} ignored: not accepted, or unknown id)` : ''}, ${proposed} proposed for next week`);
    }
    return;
  }

  if (command === 'render') {
    const { review: { notes: _notes, decisions: _decisions, commitments: read, ...review }, narrative, commitments } = await loadSubmission();
    const out = option('--out');
    if (!out) throw new Error('--out <page.html> is required');
    // Preview: last week's commitments with the outcomes from the file, and the
    // new proposals as they look before any decision (no buttons locally).
    const outcomes = new Map((commitments?.results ?? []).map((r) => [r.id, r]));
    const due = read?.due ? { ...read.due, scoredAt: commitments ? review.generatedAt : null,
      items: read.due.items.map((c) => ({ ...c, ...(c.decision === 'accepted' && outcomes.get(c.id) ? outcomes.get(c.id) : {}) })) } : null;
    const next = commitments?.next.length ? { items: commitments.next.map((c, i) => ({ id: `c${i + 1}`, ...c, decision: null })) } : null;
    await writeFile(out, renderPage({ ...review, narrative }, { commitments: { due, next } }));
    console.log(`Wrote ${out}`);
    return;
  }

  if (command === 'link') {
    console.log(reviewUrl(config, week.start));
    console.log(archiveUrl(config));
    return;
  }

  console.error('Usage: node src/cli.js <collect|publish|render|link|post|decisions|post-notes> [options]; see the top of src/cli.js');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
