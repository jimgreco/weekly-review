import { collectWeek } from './collect.js';
import { writeNarrative } from './narrative.js';
import { renderEmail } from './render.js';
import { sendEmail } from './email.js';
import { reviewUrl } from './links.js';

/**
 * Build (or rebuild) the review for `week`, save it, and email it unless
 * `send` is false. Returns the saved review.
 */
export async function runReview(config, store, week, { send = true, narrative = config.narrativeEnabled } = {}) {
  const review = await collectWeek(config, week);
  review.narrative = narrative ? await writeNarrative(review, { model: config.anthropicModel }) : null;

  const existing = await store.load(week.start);
  review.sentAt = existing?.sentAt ?? null;
  await store.save(review);

  if (send) {
    if (!config.resendApiKey) throw new Error('RESEND_API_KEY is not set; use --no-send to build without emailing');
    const url = reviewUrl(config, week.start);
    const email = renderEmail(review, url);
    await sendEmail({
      apiKey: config.resendApiKey,
      from: config.emailFrom,
      to: config.reviewEmail,
      ...email,
      // Resend drops a repeat with the same key, so a retry can't double-send.
      idempotencyKey: `weekly-review-${week.start}-${review.generatedAt.slice(0, 10)}`,
    });
    review.sentAt = new Date().toISOString();
    await store.save(review);
  }
  return review;
}
