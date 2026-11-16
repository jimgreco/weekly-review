// The owner's register of dated decisions (e.g. "decide whether to start the
// cut early" on a check-in date). The midweek routine writes an evidence brief
// for each open decision a few days before its date. The register is personal,
// so it lives only on the site (DATA_DIR/decisions.json), never in this
// repository: the owner's Mac replaces it with the notes token, and the
// routines read it with the ingest token.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidReview } from './ingest.js';
import { addDays } from './week.js';

export const DECISION_ID_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
export const MAX_DECISIONS = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { title: 120, question: 400, context: 2000, option: 200, outcome: 600 };

function text(value, max, name, { required = true, multiline = false } = {}) {
  const fail = (msg) => { throw new InvalidReview(msg); };
  if (value == null || value === '') return required ? fail(`${name} is required`) : null;
  if (typeof value !== 'string') fail(`${name} must be a string`);
  // eslint-disable-next-line no-control-regex
  const clean = (multiline ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ') : value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ')).trim();
  if (!clean) return required ? fail(`${name} is required`) : null;
  if (clean.length > max) fail(`${name} is over ${max} characters`);
  return clean;
}

/** Returns a clean list of decisions (sorted by date), or throws InvalidReview. */
export function validateDecisions(body) {
  const fail = (msg) => { throw new InvalidReview(msg); };
  const list = body?.decisions;
  if (!Array.isArray(list)) fail('decisions must be a list');
  if (list.length > MAX_DECISIONS) fail(`more than ${MAX_DECISIONS} decisions`);
  const ids = new Set();
  const clean = list.map((d, i) => {
    const at = `decisions[${i}]`;
    if (!d || typeof d !== 'object') fail(`${at} must be an object`);
    if (typeof d.id !== 'string' || !DECISION_ID_RE.test(d.id)) fail(`${at}.id must be 3-50 lowercase letters, digits or hyphens`);
    if (ids.has(d.id)) fail(`${at}.id ${d.id} is repeated`);
    ids.add(d.id);
    if (typeof d.date !== 'string' || !DATE_RE.test(d.date) || Number.isNaN(Date.parse(`${d.date}T00:00:00Z`)) || addDays(d.date, 0) !== d.date) fail(`${at}.date must be YYYY-MM-DD`);
    const status = d.status ?? 'open';
    if (!['open', 'decided', 'dropped'].includes(status)) fail(`${at}.status must be open, decided or dropped`);
    const options = d.options ?? [];
    if (!Array.isArray(options) || options.length > 6) fail(`${at}.options must be a list of at most 6`);
    return {
      id: d.id, date: d.date, status,
      title: text(d.title, LIMITS.title, `${at}.title`),
      question: text(d.question, LIMITS.question, `${at}.question`),
      options: options.map((o, j) => text(o, LIMITS.option, `${at}.options[${j}]`)),
      context: text(d.context, LIMITS.context, `${at}.context`, { required: false, multiline: true }),
      outcome: text(d.outcome, LIMITS.outcome, `${at}.outcome`, { required: false, multiline: true }),
    };
  });
  return clean.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function createDecisionsStore(dataDir) {
  const file = path.resolve(dataDir, 'decisions.json');
  const load = async () => {
    try {
      return JSON.parse(await readFile(file, 'utf8')).decisions ?? [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    load,
    async find(id) {
      return (await load()).find((d) => d.id === id) ?? null;
    },
    async save(decisions) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ decisions, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

/** Open decisions dated from `from` through `from + days`, soonest first. */
export function upcoming(decisions, from, days) {
  const until = addDays(from, days);
  return decisions.filter((d) => d.status === 'open' && d.date >= from && d.date <= until);
}
