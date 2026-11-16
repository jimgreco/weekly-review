// Posts: the shorter pieces other routines write between the Sunday reviews.
//   pulse    - midweek check on the week's accepted commitments (key: the Monday)
//   decision - evidence brief ahead of a dated decision (key: the decision's id)
//   monthly  - month roll-up (key: YYYY-MM)
//   checkin  - nutrition & training check-in (key: the review date, YYYY-MM-DD)
// Each is Markdown in the narrative subset, stored as one JSON file under
// DATA_DIR/posts/<kind>/<key>.json, emailed at most once, and readable at a
// private HMAC link like the reviews.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidReview } from './ingest.js';
import { DECISION_ID_RE } from './decisions.js';
import { weekRange } from './week.js';

export const POST_KINDS = {
  pulse: { maxChars: 1500 },
  decision: { maxChars: 9000 },
  monthly: { maxChars: 9000 },
  checkin: { maxChars: 30000 },
};
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validPostKey(kind, key) {
  if (typeof key !== 'string') return false;
  if (kind === 'pulse') { try { return weekRange(key).start === key; } catch { return false; } }
  if (kind === 'monthly') return MONTH_RE.test(key);
  if (kind === 'decision') return DECISION_ID_RE.test(key);
  if (kind === 'checkin') return DATE_RE.test(key) && !Number.isNaN(Date.parse(`${key}T12:00:00Z`)) && new Date(`${key}T12:00:00Z`).toISOString().slice(0, 10) === key;
  return false;
}

/** Returns a clean {post, send, resend}, or throws InvalidReview. */
export function validatePost(body) {
  const fail = (msg) => { throw new InvalidReview(msg); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body must be a JSON object');
  const { kind, key, text, model = null, generatedAt, send = false, resend = false } = body;
  if (!Object.hasOwn(POST_KINDS, kind)) fail(`kind must be one of ${Object.keys(POST_KINDS).join(', ')}`);
  if (!validPostKey(kind, key)) fail({ pulse: 'key must be a Monday (YYYY-MM-DD)', monthly: 'key must be a month (YYYY-MM)', decision: 'key must be a decision id', checkin: 'key must be a date (YYYY-MM-DD)' }[kind]);
  if (typeof text !== 'string' || !text.trim()) fail('text must be a non-empty string');
  if (text.length > POST_KINDS[kind].maxChars) fail(`text is over ${POST_KINDS[kind].maxChars} characters`);
  if (Number.isNaN(Date.parse(generatedAt))) fail('generatedAt must be a timestamp');
  if (typeof send !== 'boolean') fail('send must be true or false');
  if (typeof resend !== 'boolean') fail('resend must be true or false');
  if (resend && !send) fail('resend requires send');
  return {
    post: { kind, key, text: text.trim(), model: typeof model === 'string' ? model.slice(0, 80) : null, generatedAt: new Date(generatedAt).toISOString() },
    send,
    resend,
  };
}

export function createPostsStore(dataDir) {
  const root = path.resolve(dataDir, 'posts');
  const file = (kind, key) => {
    if (!Object.hasOwn(POST_KINDS, kind) || !validPostKey(kind, key)) throw new Error(`Bad post ${kind}/${key}`);
    return path.join(root, kind, `${key}.json`);
  };
  return {
    async save(post) {
      const target = file(post.kind, post.key);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(post, null, 2), { mode: 0o600 });
      await rename(tmp, target);
    },
    async load(kind, key) {
      try {
        return JSON.parse(await readFile(file(kind, key), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    /** Keys of this kind that have a post, newest first. */
    async list(kind) {
      try {
        return (await readdir(path.join(root, kind)))
          .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
          .filter((key) => validPostKey(kind, key)).sort().reverse();
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

/**
 * Save the post (replacing an earlier version) and, if asked, email it: at
 * most once per post unless `resend`. `describe(post)` gives {title, subtitle}
 * or null when the post has nothing to hang on (an unknown decision).
 */
export function createPostPublisher(config, posts, { sendImpl, describe, renderEmail, urlFor }) {
  let queue = Promise.resolve();
  const publish = async ({ post, send, resend = false }) => {
    const heading = await describe(post);
    if (!heading) throw new InvalidReview(`no ${post.kind} with key ${post.key}`);
    const existing = await posts.load(post.kind, post.key);
    const record = { ...post, ...heading, receivedAt: new Date().toISOString(), sentAt: existing?.sentAt ?? null };
    await posts.save(record);
    const result = (sent) => ({ kind: record.kind, key: record.key, sentAt: record.sentAt, sent });
    if (!send || (record.sentAt && !resend)) return result(false);
    if (!config.resendApiKey || !config.reviewEmail) throw Object.assign(new Error('email is not configured on the review site'), { status: 503 });
    await sendImpl({
      apiKey: config.resendApiKey, from: config.emailFrom, to: config.reviewEmail,
      ...renderEmail(record, urlFor(record)),
      idempotencyKey: resend ? `weekly-review-${record.kind}-${record.key}-resend-${record.receivedAt}` : `weekly-review-${record.kind}-${record.key}`,
    });
    record.sentAt = new Date().toISOString();
    await posts.save(record);
    return result(true);
  };
  return (submission) => {
    const run = queue.then(() => publish(submission));
    queue = run.catch(() => {});
    return run;
  };
}
