// Runs the real SQL against a disposable Postgres whose schemas were created
// by each app's own setup code and seeded by test/fixtures/seed.mjs.
// Skipped unless TEST_PG_BASE is set, e.g.
//   TEST_PG_BASE=postgresql://weekly_review_ro@127.0.0.1:55433 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { collectMacros } from '../src/sources/macros.js';
import { collectSpending } from '../src/sources/spending.js';
import { collectChecklist } from '../src/sources/checklist.js';
import { collectPlanner } from '../src/sources/planner.js';
import { weekRange, previousWeek, nextWeek, addDays } from '../src/week.js';

const base = process.env.TEST_PG_BASE;
const opts = { skip: !base && 'TEST_PG_BASE not set' };
const email = 'tester@example.com';
const week = weekRange('2026-10-26');
const prev = previousWeek(week);
const next = nextWeek(week);

async function withDb(name, fn) {
  const client = new pg.Client({ connectionString: `${base}/${name}`, options: '-c default_transaction_read_only=on' });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

test('macros: local-day boundaries, deleted rows, complete-day averages, targets', opts, async () => {
  const r = await withDb('macro_tracker', (db) => collectMacros(db, { email, week, prev }));
  assert.equal(r.status, 'ok');
  assert.equal(r.current.days[1].calories, 2050); // deleted 9999 excluded
  assert.equal(r.current.days[6].calories, 2050); // 01:00 Nov 2 entry excluded
  assert.equal(r.current.completeDays, 6);
  assert.equal(r.current.avgProtein, 125);
  assert.equal(r.targets.protein, 140); // latest effective target as of week end
  assert.equal(r.current.waistIn.latest, 33.75);
  assert.equal(r.change.weight, -1.2);
  assert.equal(r.current.sleepScore, 82);
});

test('spending: matches /api/stats exclusion rule and baseline', opts, async () => {
  const r = await withDb('spending', (db) => collectSpending(db, { email, week, prev, addDays }));
  assert.equal(r.current.total, 372.65); // excluded-parent and deduped rows dropped, refund nets
  assert.equal(r.previous.total, 178);
  assert.equal(r.weeklyBaseline, 72.25);
  assert.equal(r.byCategory[0].category, 'Food'); // rolled up to root tag
  assert.equal(r.importsLagging, false);
});

test('checklist and planner', opts, async () => {
  const c = await withDb('daily_checklist', (db) => collectChecklist(db, { email, week, prev }));
  assert.equal(c.doneCount, 13);
  assert.deepEqual(c.slipping, ['Journal']);
  const p = await withDb('common_week', (db) => collectPlanner(db, { email, week, next }));
  assert.equal(p.current.doneCount, 2);
  assert.equal(p.current.stuck[0].text, 'Fix bathroom fan');
  assert.equal(p.overdue[0].text, 'Renew passport');
  assert.equal(p.nextWeek.notes.meals, 'Tacos Tue, pasta Thu');
});

test('unknown email returns no-account, not an error', opts, async () => {
  const r = await withDb('macro_tracker', (db) => collectMacros(db, { email: 'nobody@example.com', week, prev }));
  assert.equal(r.status, 'no-account');
});
