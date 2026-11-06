// Spending (DB spending). Totals follow the app's /api/stats rule exactly:
// SUM(amount) over status='active' rows, excluding rows whose primary tag or
// any ancestor tag is excluded_from_spending. Charges are positive, credits
// and refunds negative.
import { round, delta } from '../stats.js';

const EXCLUDED = `
  (t.primary_tag_id IS NULL OR NOT EXISTS (
    WITH RECURSIVE chain AS (
      SELECT t.primary_tag_id AS cid
      UNION ALL
      SELECT tg.group_tag_id FROM tags tg JOIN chain c ON tg.id = c.cid
      WHERE tg.group_tag_id IS NOT NULL
    )
    SELECT 1 FROM chain JOIN tags x ON x.id = chain.cid WHERE x.excluded_from_spending
  ))`;

// Top-level ancestor of the primary tag, or 'Untagged'.
const ROOT_TAG = `
  COALESCE((
    WITH RECURSIVE up AS (
      SELECT id, name, group_tag_id FROM tags WHERE id = t.primary_tag_id
      UNION ALL
      SELECT g.id, g.name, g.group_tag_id FROM tags g JOIN up ON g.id = up.group_tag_id
    )
    SELECT name FROM up WHERE group_tag_id IS NULL LIMIT 1
  ), 'Untagged')`;

async function findUserId(db, email) {
  const { rows } = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0]?.id ?? null;
}

async function totalBetween(db, uid, start, end) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(t.amount), 0)::float8 AS total, COUNT(*)::int AS count
       FROM transactions t
      WHERE t.user_id = $1 AND t.status = 'active'
        AND t.date BETWEEN $2::date AND $3::date AND ${EXCLUDED}`,
    [uid, start, end],
  );
  return rows[0];
}

export async function collectSpending(db, { email, ownerEmail, week, prev, addDays }) {
  const uid = await findUserId(db, ownerEmail || email);
  if (!uid) return { status: 'no-account' };

  const [current, previous] = await Promise.all([
    totalBetween(db, uid, week.start, week.end),
    totalBetween(db, uid, prev.start, prev.end),
  ]);
  // Weekly spend is noisy; give an 8-week baseline (the 8 weeks before this one).
  const baselineStart = addDays(week.start, -56);
  const baseline = await totalBetween(db, uid, baselineStart, addDays(week.start, -1));

  const categories = await db.query(
    `SELECT ${ROOT_TAG} AS category,
            SUM(t.amount) FILTER (WHERE t.date >= $2::date)::float8 AS this_week,
            SUM(t.amount) FILTER (WHERE t.date < $2::date)::float8 AS baseline
       FROM transactions t
      WHERE t.user_id = $1 AND t.status = 'active'
        AND t.date BETWEEN $4::date AND $3::date AND ${EXCLUDED}
      GROUP BY 1`,
    [uid, week.start, week.end, baselineStart],
  );
  const largest = await db.query(
    `SELECT to_char(t.date, 'YYYY-MM-DD') AS date, t.description, t.amount::float8 AS amount,
            ${ROOT_TAG} AS category
       FROM transactions t
      WHERE t.user_id = $1 AND t.status = 'active'
        AND t.date BETWEEN $2::date AND $3::date AND ${EXCLUDED}
      ORDER BY t.amount DESC LIMIT 3`,
    [uid, week.start, week.end],
  );
  const review = await db.query(
    `SELECT COUNT(*)::int AS n FROM transactions t
      WHERE t.user_id = $1 AND t.status = 'active'
        AND (t.needs_review OR t.transaction_type IS NULL)
        AND t.date BETWEEN $2::date AND $3::date`,
    [uid, week.start, week.end],
  );
  const latest = await db.query(
    `SELECT to_char(MAX(date), 'YYYY-MM-DD') AS d FROM transactions WHERE user_id = $1 AND status = 'active'`,
    [uid],
  );

  const byCategory = categories.rows
    .map((r) => ({
      category: r.category,
      total: round(r.this_week ?? 0, 2),
      weeklyBaseline: round((r.baseline ?? 0) / 8, 2),
    }))
    .filter((r) => r.total !== 0)
    .sort((a, b) => b.total - a.total);

  return {
    status: 'ok',
    // Imports are manual; if the newest transaction predates the week's end,
    // the week is probably incomplete rather than cheap.
    latestTransactionDate: latest.rows[0]?.d ?? null,
    // Imports trail by a day or so normally; more than two days means the
    // week is missing transactions.
    importsLagging: !latest.rows[0]?.d || latest.rows[0].d < addDays(week.end, -2),
    current: { total: round(current.total, 2), count: current.count },
    previous: { total: round(previous.total, 2), count: previous.count },
    weeklyBaseline: round(baseline.total / 8, 2),
    byCategory: byCategory.slice(0, 6),
    largest: largest.rows.filter((r) => r.amount > 0).map((r) => ({ ...r, amount: round(r.amount, 2) })),
    needsReview: review.rows[0].n,
    change: { total: delta(current.total, previous.total, 2) },
  };
}
