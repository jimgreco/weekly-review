// Private links without a login: each link carries an HMAC of its path.
// Anyone holding the email link can open that page, so the email itself is
// the credential. Rotating LINK_SECRET invalidates every link.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret, subject) {
  if (!secret || secret.length < 32) throw new Error('LINK_SECRET must be at least 32 characters');
  return createHmac('sha256', secret).update(subject).digest('base64url');
}

export function verify(secret, subject, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = Buffer.from(sign(secret, subject));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function reviewUrl(config, weekStart) {
  return `${config.publicUrl}/r/${weekStart}?t=${sign(config.linkSecret, `review:${weekStart}`)}`;
}

export function archiveUrl(config) {
  return `${config.publicUrl}/archive?t=${sign(config.linkSecret, 'archive')}`;
}
