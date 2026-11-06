// Reviews are stored as one JSON file per week on a volume. They are small
// and written once a week, so no database is needed.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createStore(dataDir) {
  const dir = path.resolve(dataDir, 'reviews');
  const file = (weekStart) => {
    if (!WEEK_RE.test(weekStart)) throw new Error(`Bad week id ${weekStart}`);
    return path.join(dir, `${weekStart}.json`);
  };
  return {
    async save(review) {
      await mkdir(dir, { recursive: true });
      const target = file(review.week.start);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(review, null, 2), { mode: 0o600 });
      await rename(tmp, target);
    },
    async load(weekStart) {
      try {
        return JSON.parse(await readFile(file(weekStart), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async list() {
      try {
        return (await readdir(dir))
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -5))
          .filter((w) => WEEK_RE.test(w))
          .sort()
          .reverse();
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
