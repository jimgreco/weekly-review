// Macrovana (DB macro_tracker). Mirrors the app's own day boundaries:
// local day = (consumed_at AT TIME ZONE users.timezone)::date, and only
// rows with deleted_at IS NULL count. "Complete" days come from
// nutrition_day_completeness; days without a row are "unknown".
import { mean, round, delta } from '../stats.js';

const CM_PER_IN = 2.54;

async function findUser(db, email) {
  const { rows } = await db.query(
    `SELECT id, timezone FROM users WHERE lower(email) = lower($1)
     ORDER BY created_at LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

async function dailyTotals(db, userId, tz, start, end) {
  const { rows } = await db.query(
    `SELECT to_char((consumed_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
            SUM(calories)::float8 AS calories, SUM(protein)::float8 AS protein,
            SUM(carbs)::float8 AS carbs, SUM(fat)::float8 AS fat,
            SUM(fiber)::float8 AS fiber, COUNT(fiber)::int AS fiber_known,
            COUNT(*)::int AS entries
       FROM entries
      WHERE user_id = $1 AND deleted_at IS NULL
        AND (consumed_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
      GROUP BY 1`,
    [userId, tz, start, end],
  );
  return rows;
}

async function completeness(db, userId, start, end) {
  const { rows } = await db.query(
    `SELECT to_char(local_date, 'YYYY-MM-DD') AS day, state
       FROM nutrition_day_completeness
      WHERE user_id = $1 AND local_date BETWEEN $2::date AND $3::date`,
    [userId, start, end],
  );
  return Object.fromEntries(rows.map((r) => [r.day, r.state]));
}

async function targetsAsOf(db, userId, day) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (macro) macro, target::float8 AS target
       FROM macro_targets
      WHERE user_id = $1 AND effective_date <= $2::date
      ORDER BY macro, effective_date DESC, updated_at DESC`,
    [userId, day],
  );
  return Object.fromEntries(rows.map((r) => [r.macro, r.target]));
}

async function bodyMetrics(db, userId, tz, start, end) {
  const weights = await db.query(
    `SELECT to_char((logged_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, weight::float8 AS weight
       FROM weight_entries
      WHERE user_id = $1 AND deleted_at IS NULL
        AND (logged_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
      ORDER BY logged_at`,
    [userId, tz, start, end],
  );
  const waists = await db.query(
    `SELECT to_char((logged_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
            value_cm::float8 AS value_cm, method
       FROM waist_entries
      WHERE user_id = $1 AND deleted_at IS NULL
        AND (logged_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
      ORDER BY logged_at`,
    [userId, tz, start, end],
  );
  return { weights: weights.rows, waists: waists.rows };
}

async function ouraDaily(db, userId, start, end) {
  const { rows } = await db.query(
    `SELECT data_type, to_char(day, 'YYYY-MM-DD') AS day,
            (normalized_data->>'score')::float8 AS score,
            (normalized_data->>'steps')::float8 AS steps
       FROM oura_documents
      WHERE user_id = $1 AND deleted_at IS NULL AND ignored_at IS NULL
        AND data_type IN ('daily_sleep', 'daily_readiness', 'daily_activity')
        AND day BETWEEN $2::date AND $3::date`,
    [userId, start, end],
  );
  return rows;
}

function summarizeWeek(week, totals, states, body, oura) {
  const byDay = Object.fromEntries(totals.map((t) => [t.day, t]));
  const days = week.days.map((day) => {
    const t = byDay[day];
    return {
      date: day,
      state: states[day] ?? (t ? 'unknown' : 'unlogged'),
      calories: t ? round(t.calories) : null,
      protein: t ? round(t.protein) : null,
      carbs: t ? round(t.carbs) : null,
      fat: t ? round(t.fat) : null,
      // Same rule as the app: only show fiber when every entry has it.
      fiber: t && t.fiber_known === t.entries ? round(t.fiber) : null,
    };
  });
  const complete = days.filter((d) => d.state === 'complete' && d.calories != null);
  const inWeek = (rows) => rows.filter((r) => r.day >= week.start && r.day <= week.end);
  const weights = inWeek(body.weights);
  const waists = inWeek(body.waists);
  const ouraIn = inWeek(oura);
  const ouraMean = (type, field) =>
    round(mean(ouraIn.filter((r) => r.data_type === type).map((r) => r[field])));

  return {
    days,
    loggedDays: days.filter((d) => d.calories != null).length,
    completeDays: complete.length,
    // Averages use Complete days only, matching the manual check-ins.
    avgCalories: round(mean(complete.map((d) => d.calories))),
    avgProtein: round(mean(complete.map((d) => d.protein))),
    avgFiber: round(mean(complete.map((d) => d.fiber))),
    weight: {
      count: weights.length,
      avg: round(mean(weights.map((w) => w.weight)), 1),
    },
    waistIn: waists.length
      ? { latest: round(waists.at(-1).value_cm / CM_PER_IN, 2), method: waists.at(-1).method, day: waists.at(-1).day }
      : null,
    sleepScore: ouraMean('daily_sleep', 'score'),
    readinessScore: ouraMean('daily_readiness', 'score'),
    avgSteps: ouraMean('daily_activity', 'steps'),
  };
}

export async function collectMacros(db, { email, week, prev }) {
  const user = await findUser(db, email);
  if (!user) return { status: 'no-account' };
  const tz = user.timezone || 'America/New_York';
  const [totals, states, body, oura, targets] = await Promise.all([
    dailyTotals(db, user.id, tz, prev.start, week.end),
    completeness(db, user.id, prev.start, week.end),
    bodyMetrics(db, user.id, tz, prev.start, week.end),
    ouraDaily(db, user.id, prev.start, week.end),
    targetsAsOf(db, user.id, week.end),
  ]);
  const current = summarizeWeek(week, totals, states, body, oura);
  const previous = summarizeWeek(prev, totals, states, body, oura);
  return {
    status: 'ok',
    targets: {
      calories: targets.calories ?? null,
      protein: targets.protein ?? null,
      fiber: targets.fiber ?? null,
      sleepHours: targets.sleep_hours ?? null,
    },
    current,
    previous: { ...previous, days: undefined },
    change: {
      avgCalories: delta(current.avgCalories, previous.avgCalories),
      avgProtein: delta(current.avgProtein, previous.avgProtein),
      weight: delta(current.weight.avg, previous.weight.avg, 1),
      sleepScore: delta(current.sleepScore, previous.sleepScore),
    },
  };
}

export { summarizeWeek as _summarizeMacrosWeek };
