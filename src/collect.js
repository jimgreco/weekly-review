import pg from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { collectMacros } from './sources/macros.js';
import { collectWorkouts } from './sources/workouts.js';
import { collectSpending } from './sources/spending.js';
import { collectChecklist } from './sources/checklist.js';
import { collectPlanner } from './sources/planner.js';
import { addDays, previousWeek, nextWeek } from './week.js';

function pool(url, ssl) {
  return new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 2,
    // Belt and braces on top of the SELECT-only role: every session is read-only.
    options: '-c default_transaction_read_only=on -c statement_timeout=15000',
  });
}

async function attempt(name, enabled, fn) {
  if (!enabled) return { status: 'disabled' };
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, ms: Date.now() - started };
  } catch (error) {
    console.error(`[collect] ${name} failed:`, error);
    return { status: 'error', error: error.message };
  }
}

export async function collectWeek(config, week) {
  const prev = previousWeek(week);
  const next = nextWeek(week);
  const email = config.reviewEmail;
  if (!email) throw new Error('REVIEW_EMAIL is not set');

  const pools = {};
  const withPool = async (key, fn) => {
    pools[key] ??= pool(config.db[key], config.db.ssl);
    return fn(pools[key]);
  };

  try {
    const [macros, workouts, spending, checklist, planner] = await Promise.all([
      attempt('macros', Boolean(config.db.macros),
        () => withPool('macros', (db) => collectMacros(db, { email, week, prev }))),
      attempt('workouts', config.dynamo.enabled, () => {
        const client = new DynamoDBClient({ region: config.dynamo.region, endpoint: config.dynamo.endpoint });
        return collectWorkouts(DynamoDBDocumentClient.from(client), {
          email, table: config.dynamo.table, week, prev,
        });
      }),
      attempt('spending', Boolean(config.db.spending),
        () => withPool('spending', (db) => collectSpending(db, {
          email, ownerEmail: config.spendingOwnerEmail, week, prev, addDays,
        }))),
      attempt('checklist', Boolean(config.db.checklist),
        () => withPool('checklist', (db) => collectChecklist(db, { email, week, prev }))),
      attempt('planner', Boolean(config.db.planner),
        () => withPool('planner', (db) => collectPlanner(db, { email, week, next }))),
    ]);
    return {
      week: { start: week.start, end: week.end },
      generatedAt: new Date().toISOString(),
      sources: { macros, workouts, spending, checklist, planner },
    };
  } finally {
    await Promise.all(Object.values(pools).map((p) => p.end()));
  }
}
