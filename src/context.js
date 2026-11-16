// Private standing context for a routine, such as the check-in's goals,
// phase, macro targets and load conventions. It is personal, so it lives only
// on the site (DATA_DIR/context/<name>.md), never in this public repository:
// the owner's Mac replaces it with the notes token, and the routines read it
// with the ingest token.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidReview } from './ingest.js';

export const CONTEXT_NAMES = ['checkin'];
export const MAX_CONTEXT_CHARS = 12000;

/** Returns clean {text}, or throws InvalidReview. */
export function validateContext(body) {
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') throw new InvalidReview('text must be a string');
  // eslint-disable-next-line no-control-regex
  const text = body.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim();
  if (!text) throw new InvalidReview('text is empty');
  if (text.length > MAX_CONTEXT_CHARS) throw new InvalidReview(`text is over ${MAX_CONTEXT_CHARS} characters`);
  return { text };
}

export function createContextStore(dataDir) {
  const file = (name) => {
    if (!CONTEXT_NAMES.includes(name)) throw new Error(`Bad context ${name}`);
    return path.resolve(dataDir, 'context', `${name}.json`);
  };
  return {
    async load(name) {
      try {
        return JSON.parse(await readFile(file(name), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async save(name, { text }) {
      const target = file(name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ text, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await rename(tmp, target);
    },
  };
}
