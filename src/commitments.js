// The commitments loop. Each review proposes a few concrete actions for the
// week after it; the owner accepts or declines each one on the review page;
// the next review scores the accepted ones and the follow-through becomes
// part of the history.
//
// One JSON file per week under DATA_DIR/commitments, named for the week the
// commitments are FOR (the Monday after the review that proposed them). They
// live apart from the stored review, so re-publishing a review never loses
// the owner's decisions.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addDays, weekRange } from './week.js';

export const AREAS = ['nutrition', 'training', 'activity', 'money', 'habits', 'home', 'other'];
export const OUTCOMES = ['hit', 'partial', 'miss', 'unknown'];
export const DECISIONS = ['accepted', 'declined'];
export const MAX_COMMITMENTS = 5;
const MAX_TEXT = 200;
const MAX_MEASURE = 200;
const MAX_NOTE = 240;
const ID_RE = /^c[1-9]$/;

export class InvalidCommitments extends Error {}
/** A decision the page can't apply: unknown id, or the week is already scored. */
export class CommitmentConflict extends Error {}

// One line of plain text: no control characters or line breaks.
function line(value, max, name, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) throw new InvalidCommitments(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new InvalidCommitments(`${name} must be a string`);
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) {
    if (required) throw new InvalidCommitments(`${name} is required`);
    return null;
  }
  if (clean.length > max) throw new InvalidCommitments(`${name} is over ${max} characters`);
  return clean;
}

/**
 * Checks the `commitments` part of a submission: `results` scores the
 * commitments that were for the review week, `next` proposes the following
 * week's. Returns a clean {results, next}, or throws InvalidCommitments.
 */
export function validateCommitments(body) {
  const fail = (msg) => { throw new InvalidCommitments(msg); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('commitments must be an object');
  const { results = [], next = [] } = body;
  if (!Array.isArray(results)) fail('commitments.results must be a list');
  if (!Array.isArray(next)) fail('commitments.next must be a list');
  if (results.length > MAX_COMMITMENTS) fail(`commitments.results has more than ${MAX_COMMITMENTS} entries`);
  if (next.length > MAX_COMMITMENTS) fail(`commitments.next has more than ${MAX_COMMITMENTS} entries`);

  const seen = new Set();
  const cleanResults = results.map((r, i) => {
    const at = `commitments.results[${i}]`;
    if (!r || typeof r !== 'object') fail(`${at} must be an object`);
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) fail(`${at}.id must be c1-c9`);
    if (seen.has(r.id)) fail(`${at}.id ${r.id} is repeated`);
    seen.add(r.id);
    if (!OUTCOMES.includes(r.outcome)) fail(`${at}.outcome must be one of ${OUTCOMES.join(', ')}`);
    return { id: r.id, outcome: r.outcome, note: line(r.note, MAX_NOTE, `${at}.note`, { required: false }) };
  });

  const texts = new Set();
  const cleanNext = next.map((c, i) => {
    const at = `commitments.next[${i}]`;
    if (!c || typeof c !== 'object') fail(`${at} must be an object`);
    const text = line(c.text, MAX_TEXT, `${at}.text`);
    if (texts.has(text.toLowerCase())) fail(`${at}.text repeats another commitment`);
    texts.add(text.toLowerCase());
    const area = c.area ?? 'other';
    if (!AREAS.includes(area)) fail(`${at}.area must be one of ${AREAS.join(', ')}`);
    return { text, measure: line(c.measure, MAX_MEASURE, `${at}.measure`, { required: false }), area };
  });
  return { results: cleanResults, next: cleanNext };
}

/** Counts for one week's file: what was proposed, accepted and how it went. */
export function tally(record) {
  const items = record?.items ?? [];
  const accepted = items.filter((c) => c.decision === 'accepted');
  const count = (outcome) => accepted.filter((c) => c.outcome === outcome).length;
  return {
    proposed: items.length,
    accepted: accepted.length,
    declined: items.filter((c) => c.decision === 'declined').length,
    scored: Boolean(record?.scoredAt),
    hit: count('hit'), partial: count('partial'), miss: count('miss'), unknown: count('unknown'),
  };
}

/**
 * `onChange(record)` is called after every stored change to a week (proposals,
 * a decision, a score), without being waited for. The site uses it to keep the
 * owner's reminders in step (src/tasks.js).
 */
export function createCommitmentsStore(dataDir, { now = () => new Date(), onChange = null } = {}) {
  const dir = path.resolve(dataDir, 'commitments');
  const file = (week) => path.join(dir, `${weekRange(week).start}.json`); // throws unless a Monday

  async function load(week) {
    try {
      return JSON.parse(await readFile(file(week), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function save(record) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = file(record.week);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(tmp, target);
    if (onChange) {
      try {
        Promise.resolve(onChange(structuredClone(record))).catch(() => {});
      } catch { /* a listener never breaks a save */ }
    }
  }

  // One read-modify-write at a time, so a decision on the page and a publish
  // from the routine can't overwrite each other.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  return {
    load,

    /**
     * Store the proposals for `week`, made by the review of the week before.
     * A re-publish replaces them, keeping the decision on any item whose text
     * is unchanged. Once the week has been scored it is closed and left alone.
     */
    propose(week, items) {
      return serial(async () => {
        const existing = await load(week);
        if (existing?.scoredAt) return existing;
        if (!items.length && !existing) return null;
        const kept = new Map((existing?.items ?? []).map((c) => [c.text.toLowerCase(), c]));
        const record = {
          week: weekRange(week).start,
          proposedIn: addDays(week, -7),
          proposedAt: now().toISOString(),
          scoredAt: null,
          items: items.map((c, i) => {
            const before = kept.get(c.text.toLowerCase());
            return {
              id: `c${i + 1}`, text: c.text, measure: c.measure ?? null, area: c.area ?? 'other',
              decision: before?.decision ?? null, decidedAt: before?.decidedAt ?? null,
              outcome: null, note: null,
            };
          }),
        };
        await save(record);
        return record;
      });
    },

    /** The owner's choice on the review page: 'accepted', 'declined' or null (undo). */
    decide(week, id, decision) {
      return serial(async () => {
        if (decision !== null && !DECISIONS.includes(decision)) throw new CommitmentConflict('unknown decision');
        const record = await load(week);
        const item = record?.items.find((c) => c.id === id);
        if (!item) throw new CommitmentConflict('no such commitment');
        if (record.scoredAt) throw new CommitmentConflict('that week has already been scored');
        item.decision = decision;
        item.decidedAt = decision ? now().toISOString() : null;
        await save(record);
        return record;
      });
    },

    /**
     * Record how the accepted commitments for `week` went. Results for ids
     * that don't exist or weren't accepted are dropped. Scoring closes the
     * week to further decisions; a re-publish may score it again.
     */
    score(week, results) {
      return serial(async () => {
        const record = await load(week);
        if (!record) return { scored: 0, ignored: results.length };
        const accepted = new Map(record.items.filter((c) => c.decision === 'accepted').map((c) => [c.id, c]));
        if (!accepted.size) return { scored: 0, ignored: results.length };
        let scored = 0;
        for (const item of accepted.values()) { item.outcome = null; item.note = null; }
        for (const result of results) {
          const item = accepted.get(result.id);
          if (!item) continue;
          item.outcome = result.outcome;
          item.note = result.note ?? null;
          scored += 1;
        }
        // An accepted commitment the routine said nothing about still counts.
        for (const item of accepted.values()) if (!item.outcome) item.outcome = 'unknown';
        record.scoredAt = now().toISOString();
        await save(record);
        return { scored, ignored: results.length - scored };
      });
    },

    /** Follow-through for the `weeks` weeks before `week`, oldest first; weeks with nothing proposed are left out. */
    async history(week, weeks) {
      const out = [];
      for (let i = weeks; i >= 1; i -= 1) {
        const start = addDays(weekRange(week).start, -7 * i);
        const record = await load(start);
        if (record?.items.length) out.push({ week: start, ...tally(record) });
      }
      return out;
    },
  };
}

/** What the routine sees for a week: text and state, no timestamps it doesn't need. */
export function forRoutine(record) {
  if (!record) return null;
  return {
    week: record.week,
    proposedIn: record.proposedIn,
    scored: Boolean(record.scoredAt),
    items: record.items.map(({ id, text, measure, area, decision, outcome, note }) => ({ id, text, measure, area, decision, outcome, note })),
  };
}
