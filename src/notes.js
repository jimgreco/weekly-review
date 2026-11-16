// Owner-only notes for a week, posted from the owner's Mac (today only the
// Claude Code "what you built" summary). The cloud routine reads them as extra
// narrative context. They are never shown on the review page and never copied
// into the stored review.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidReview } from './ingest.js';
import { weekRange } from './week.js';

export const NOTE_KINDS = ['claude-code'];
export const MAX_NOTE_CHARS = 6000;

/** Returns the Monday, or throws InvalidReview. */
export function noteWeek(value) {
  try {
    return weekRange(value).start;
  } catch {
    throw new InvalidReview('week must be a Monday (YYYY-MM-DD)');
  }
}

/** Returns a clean {text, generatedAt}, or throws InvalidReview. */
export function validateNote(body) {
  const fail = (msg) => { throw new InvalidReview(msg); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body must be a JSON object');
  if (typeof body.text !== 'string') fail('text must be a string');
  const text = body.text.trim();
  if (!text) fail('text must be non-empty');
  if (text.length > MAX_NOTE_CHARS) fail(`text is over ${MAX_NOTE_CHARS} characters`);
  if (Number.isNaN(Date.parse(body.generatedAt))) fail('generatedAt must be a timestamp');
  return { text, generatedAt: new Date(body.generatedAt).toISOString() };
}

export function createNotesStore(dataDir) {
  const root = path.resolve(dataDir, 'notes');
  const file = (week, kind) => {
    if (!NOTE_KINDS.includes(kind)) throw new Error(`Unknown note kind ${kind}`);
    return path.join(root, noteWeek(week), `${kind}.json`);
  };
  return {
    async save(week, kind, note) {
      const target = file(week, kind);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...note, receivedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await rename(tmp, target);
    },
    async load(week, kind) {
      try {
        const { text, generatedAt } = JSON.parse(await readFile(file(week, kind), 'utf8'));
        return { text, generatedAt };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async loadAll(week) {
      const entries = await Promise.all(NOTE_KINDS.map(async (kind) => [kind, await this.load(week, kind)]));
      return Object.fromEntries(entries);
    },
  };
}
