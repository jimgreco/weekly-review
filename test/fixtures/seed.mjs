// Seeds a disposable local Postgres (schemas created by each app's own
// setup code) with two weeks of synthetic data for one user.
// Usage: node test/fixtures/seed.mjs postgresql://admin@127.0.0.1:55433
import pg from 'pg';

const base = process.argv[2];
const EMAIL = 'tester@example.com';
const days = (start, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10);
});
const PREV = days('2026-10-19', 7);
const WEEK = days('2026-10-26', 7);

async function withDb(name, fn) {
  const client = new pg.Client({ connectionString: `${base}/${name}` });
  await client.connect();
  try { await fn(client); } finally { await client.end(); }
}

await withDb('macro_tracker', async (db) => {
  for (const t of ['entries', 'nutrition_day_completeness', 'oura_documents', 'macro_targets', 'weight_entries', 'waist_entries']) await db.query(`DELETE FROM ${t} WHERE user_id = 'u1'`);
  await db.query(`DELETE FROM users WHERE id = 'u1'`);
  await db.query(`INSERT INTO users (id, email, timezone) VALUES ('u1', $1, 'America/New_York')`, [EMAIL]);
  for (const [i, day] of [...PREV, ...WEEK].entries()) {
    const thisWeek = i >= 7;
    // 13:00 local = 17:00Z (EDT) / 18:00Z (EST); use noon UTC+5 to stay inside the day.
    const at = `${day}T17:00:00Z`;
    await db.query(
      `INSERT INTO entries (user_id, item_name, quantity, calories, protein, carbs, fat, fiber, consumed_at)
       VALUES ('u1', 'lunch', 1, $1, $2, 200, 60, $3, $4), ('u1', 'dinner', 1, 900, 50, 90, 30, NULL, $5)`,
      [thisWeek ? 1150 : 1050, thisWeek ? 75 : 60, 12, at, `${day}T23:30:00Z`],
    );
    if (i % 7 !== 3) {
      await db.query(
        `INSERT INTO nutrition_day_completeness (user_id, local_date, state, timezone) VALUES ('u1', $1, 'complete', 'America/New_York')`,
        [day],
      );
    }
    await db.query(
      `INSERT INTO oura_documents (user_id, data_type, provider_document_id, day, normalized_data)
       VALUES ('u1', 'daily_sleep', $1, $2, $3), ('u1', 'daily_readiness', $4, $2, $5)`,
      [`s-${day}`, day, { score: thisWeek ? 82 : 76 }, `r-${day}`, { score: thisWeek ? 80 : 74 }],
    );
  }
  // An entry at 01:00 local on Nov 2 (05:00Z, EST) must NOT land in the week.
  await db.query(`INSERT INTO entries (user_id, item_name, quantity, calories, protein, carbs, fat, consumed_at)
                  VALUES ('u1', 'late', 1, 5000, 0, 0, 0, '2026-11-02T06:00:00Z')`);
  // A deleted entry must not count.
  await db.query(`INSERT INTO entries (user_id, item_name, quantity, calories, protein, carbs, fat, consumed_at, deleted_at)
                  VALUES ('u1', 'oops', 1, 9999, 0, 0, 0, '2026-10-27T17:00:00Z', now())`);
  await db.query(`INSERT INTO macro_targets (user_id, macro, effective_date, target) VALUES
                  ('u1','calories','2026-09-01',2000), ('u1','protein','2026-09-01',130), ('u1','protein','2026-10-28',140)`);
  await db.query(`INSERT INTO weight_entries (user_id, weight, logged_at) VALUES
                  ('u1', 181.0, '2026-10-20T12:00:00Z'), ('u1', 180.2, '2026-10-22T12:00:00Z'),
                  ('u1', 179.6, '2026-10-27T12:00:00Z'), ('u1', 179.2, '2026-10-30T12:00:00Z')`);
  await db.query(`INSERT INTO waist_entries (user_id, value_cm, unit, method, readings, logged_at) VALUES
                  ('u1', 85.725, 'in', 'navel_relaxed', '[85.725]', '2026-10-31T12:00:00Z')`);
});

await withDb('spending', async (db) => {
  await db.query(`DELETE FROM transactions; DELETE FROM tags; DELETE FROM users`);
  const { rows: [u] } = await db.query(`INSERT INTO users (email, google_id) VALUES ($1, 'g1') RETURNING id`, [EMAIL]);
  const tag = async (name, parent = null, excluded = false) => (await db.query(
    `INSERT INTO tags (user_id, name, group_tag_id, excluded_from_spending) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, name, parent, excluded],
  )).rows[0].id;
  const food = await tag('Food');
  const groceries = await tag('Groceries', food);
  const dining = await tag('Dining', food);
  const home = await tag('Home');
  const transfers = await tag('Transfers', null, true);
  const cc = await tag('Card payment', transfers);
  const tx = (date, description, amount, tagId, status = 'active') => db.query(
    `INSERT INTO transactions (user_id, date, description, amount, original_amount, dedup_key, source, primary_tag_id, status, transaction_type)
     VALUES ($1,$2,$3,$4,$4,$7,'visa',$5,$6,'expense')`, [u.id, date, description, amount, tagId, status, `${date}|${description}|${amount}|${status}`],
  );
  await tx('2026-10-27', 'Whole Foods', 182.40, groceries);
  await tx('2026-10-29', 'Via Carota', 146.00, dining);
  await tx('2026-10-30', 'Hardware store', 64.25, home);
  await tx('2026-10-31', 'Refund: hardware', -20.00, home);
  await tx('2026-10-31', 'Card autopay', 2500.00, cc); // excluded via parent tag
  await tx('2026-10-28', 'Duplicate', 182.40, groceries, 'deduped');
  await tx('2026-10-21', 'Whole Foods', 140.00, groceries);
  await tx('2026-10-23', 'Pizza', 38.00, dining);
  await tx('2026-09-15', 'Old groceries', 400.00, groceries);
});

await withDb('daily_checklist', async (db) => {
  const done = (dates) => Object.fromEntries(dates.map((d) => [d, { value: true, count: 1, stamp: 1, deviceID: 'a' }]));
  const item = (title, completions, occurrences = {}) => ({
    id: title, fields: { title: { value: title, stamp: 1, deviceID: 'a' } }, completions, occurrences,
  });
  const data = {
    users: { 'user-1': { id: 'user-1', email: EMAIL } },
    accounts: {
      'user-1': {
        items: {
          stretch: item('Stretch', done([...PREV.slice(0, 5), ...WEEK.slice(0, 6)])),
          vitamins: item('Vitamins', done([...PREV, ...WEEK])),
          journal: item('Journal', done(PREV.slice(0, 4))), // slipping
          // Legacy completion says done, but a newer-revision occurrence says missed.
          floss: item('Floss', done([WEEK[1]]), {
            'floss:0:x': { value: { scheduledDate: WEEK[1], outcome: 'done', scheduleRevision: 0 }, stamp: 5, deviceID: 'a' },
            'floss:1:x': { value: { scheduledDate: WEEK[1], outcome: 'missed', scheduleRevision: 1 }, stamp: 2, deviceID: 'a' },
          }),
          gone: { ...item('Deleted', done(WEEK)), deleted: { stamp: 3, deviceID: 'a' } },
        },
        groups: {},
      },
    },
  };
  await db.query(`INSERT INTO daily_app_state (id, data) VALUES (1, $1)
                  ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [data]);
});

await withDb('common_week', async (db) => {
  await db.query(`DELETE FROM planning_items; DELETE FROM weekly_reviews; DELETE FROM household_members; DELETE FROM households; DELETE FROM users`);
  const { rows: [u] } = await db.query(`INSERT INTO users (email, display_name) VALUES ($1, 'Tester') RETURNING id`, [EMAIL]);
  const { rows: [h] } = await db.query(`INSERT INTO households (name) VALUES ('Test home') RETURNING id`);
  await db.query(`INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, 'owner')`, [h.id, u.id]);
  const task = (text, week, done, extra = {}) => db.query(
    `INSERT INTO planning_items (household_id, created_by, type, text, week_start_date, original_week_start_date,
       is_completed, carryover_count, deadline, responsible_member_id, planning_date)
     VALUES ($1,$2,'task',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [h.id, u.id, text, week, extra.original ?? week, done, extra.carry ?? 0, extra.deadline ?? null,
      extra.mine ? u.id : null, extra.date ?? null],
  );
  await task('Book pediatrician', '2026-10-26', true, { mine: true, date: '2026-10-27' });
  await task('Return library books', '2026-10-26', true);
  await task('Fix bathroom fan', '2026-10-26', false, { carry: 3, original: '2026-10-05' });
  await task('Renew passport', '2026-10-26', false, { deadline: '2026-10-30' });
  await task('Order Halloween costume', '2026-11-02', false, { deadline: '2026-11-04', mine: true });
  await task('Schedule HVAC service', '2026-11-02', false);
  await db.query(`INSERT INTO weekly_reviews (household_id, week_start_date, priorities, meals, logistics)
                  VALUES ($1, '2026-11-02', 'Finish passport renewal', 'Tacos Tue, pasta Thu', 'Grandparents visit Sat')`, [h.id]);
});

console.log('seeded');
