// Accepts a finished review from the weekly routine, stores it, and emails the
// link once per week.
import { createHash, timingSafeEqual } from 'node:crypto';
import { APPS } from './config.js';
import { renderEmail } from './render.js';
import { sendEmail } from './email.js';
import { reviewUrl } from './links.js';
import { addDays, weekRange } from './week.js';

export const MAX_BODY_BYTES = 512 * 1024;
const MAX_NARRATIVE_CHARS = 4000;

export function tokenMatches(expectedSha256, header) {
  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) return false;
  const match = /^Bearer (\S{20,256})$/.exec(header || '');
  if (!match) return false;
  const actual = createHash('sha256').update(match[1]).digest();
  return timingSafeEqual(actual, Buffer.from(expectedSha256, 'hex'));
}

class InvalidReview extends Error {}

/** Returns a clean {review, send, resend}, or throws InvalidReview. */
export function validateSubmission(body) {
  const fail = (msg) => { throw new InvalidReview(msg); };
  if (!body || typeof body !== 'object') fail('body must be a JSON object');
  const { review, narrative = null, send = false, resend = false } = body;
  if (!review || typeof review !== 'object') fail('review is required');

  let week;
  try { week = weekRange(review.week?.start); } catch { fail('review.week.start must be a Monday'); }
  if (review.week.end !== addDays(week.start, 6)) fail('review.week.end must be the Sunday after start');
  if (Number.isNaN(Date.parse(review.generatedAt))) fail('review.generatedAt must be a timestamp');

  const sources = review.sources;
  if (!sources || typeof sources !== 'object') fail('review.sources is required');
  for (const app of APPS) {
    if (typeof sources[app]?.status !== 'string') fail(`review.sources.${app}.status is required`);
  }
  const unknown = Object.keys(sources).filter((k) => !APPS.includes(k));
  if (unknown.length) fail(`unknown sources: ${unknown.join(', ')}`);

  let cleanNarrative = null;
  if (narrative != null) {
    if (typeof narrative.text !== 'string' || !narrative.text.trim()) fail('narrative.text must be a non-empty string');
    if (narrative.text.length > MAX_NARRATIVE_CHARS) fail(`narrative.text is over ${MAX_NARRATIVE_CHARS} characters`);
    cleanNarrative = {
      text: narrative.text.trim(),
      model: typeof narrative.model === 'string' ? narrative.model.slice(0, 80) : null,
    };
  }
  if (typeof send !== 'boolean') fail('send must be true or false');
  if (typeof resend !== 'boolean') fail('resend must be true or false');
  if (resend && !send) fail('resend requires send');

  return {
    review: {
      week: { start: week.start, end: week.end },
      generatedAt: new Date(review.generatedAt).toISOString(),
      sources: Object.fromEntries(APPS.map((app) => [app, sources[app]])),
      narrative: cleanNarrative,
    },
    send,
    resend,
  };
}

/**
 * Save the review (replacing any earlier version of that week) and, if asked,
 * email it — at most once per week, whatever the routine retries. An explicit
 * `resend` emails again (a deliberate, owner-requested repeat).
 */
export function createPublisher(config, store, { sendImpl = sendEmail } = {}) {
  let queue = Promise.resolve(); // one publish at a time, so two retries can't both send
  const publish = async ({ review, send, resend = false }) => {
    const existing = await store.load(review.week.start);
    review.receivedAt = new Date().toISOString();
    review.sentAt = existing?.sentAt ?? null;
    await store.save(review);

    const result = (sent) => ({ week: review.week.start, sentAt: review.sentAt, sent });
    if (!send || (review.sentAt && !resend)) return result(false);
    if (!config.resendApiKey || !config.reviewEmail) {
      const error = new Error('email is not configured on the review site');
      error.status = 503;
      throw error;
    }
    await sendImpl({
      apiKey: config.resendApiKey,
      from: config.emailFrom,
      to: config.reviewEmail,
      ...renderEmail(review, reviewUrl(config, review.week.start)),
      // A resend needs its own key, or Resend would treat it as the first send.
      idempotencyKey: resend ? `weekly-review-${review.week.start}-resend-${review.receivedAt}` : `weekly-review-${review.week.start}`,
    });
    review.sentAt = new Date().toISOString();
    await store.save(review);
    return result(true);
  };
  return (submission) => {
    const run = queue.then(() => publish(submission));
    queue = run.catch(() => {});
    return run;
  };
}

export { InvalidReview };
