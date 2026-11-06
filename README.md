# Weekly Review

Every Sunday at 6 PM it pulls the week from your other apps, has Claude write a short read of it, and emails you a summary with a private link to the full page.

| Source | What it reads | How |
|---|---|---|
| Macrovana | daily calories/protein, Complete days, targets, weight, waist, Oura sleep & readiness | `macro_tracker`, read-only role |
| Rep, Mix, Burn | finished sessions, working sets by muscle group, PBs, active program/phase | DynamoDB `GetItem`/`Query` only |
| Spending | weekly total (same exclusion rule as `/api/stats`), top categories vs 8-week average, largest charges | `spending`, read-only role |
| Ritual Cue | check-offs, missed, habits that dropped off | `daily_checklist`, read-only role |
| Week of Us | tasks done, stuck (carried ≥2×), overdue, next week's tasks and priorities/meals/logistics | `common_week`, read-only role |

Each source fails on its own: a broken or missing source shows a short note and the rest of the review still goes out. If the Claude call fails or is declined, the email goes out without the narrative.

## What it deliberately doesn't do

- **Calendar events.** Week of Us fetches them live from Google with encrypted tokens; the review doesn't decrypt those.
- **Checklist "due vs done" rates.** Ritual Cue's schedule rules live in the Swift app; re-implementing them here would drift. The review reports what was done, missed, and what dropped off since last week.
- **Writes.** Postgres access is a SELECT-only role with `default_transaction_read_only=on`, and the pool sets it again per session. DynamoDB-local has no permissions, so read-only there is only enforced by the code (`src/sources/workouts.js` issues only `GetItem` and `Query`).

## Run locally

```bash
cp .env.example .env   # fill in
npm install
node --env-file=.env src/cli.js --week 2026-10-26 --no-send --out /tmp/review.html
```

Flags: `--week <monday>` (default: last finished week), `--no-send`, `--no-narrative`, `--json` (print the collected data), `--link` (print the private links for a week).

`npm start` runs the web server plus the scheduler (`SCHEDULER_ENABLED=false` to turn the scheduler off).

## Tests

```bash
npm test
```

The SQL tests run only when `TEST_PG_BASE` points at a disposable Postgres with each app's schema and `test/fixtures/seed.mjs` data:

```bash
initdb -D /tmp/wr-pg -U admin --auth=trust && pg_ctl -D /tmp/wr-pg -o "-p 55433" start
for d in macro_tracker spending daily_checklist common_week; do createdb -h 127.0.0.1 -p 55433 -U admin $d; done
# create schemas with each app's own setup code (macros initDb, spending init_db, planner migrate.mjs),
# plus: CREATE TABLE daily_app_state (id int PRIMARY KEY CHECK (id=1), data jsonb NOT NULL, updated_at timestamptz)
node test/fixtures/seed.mjs postgresql://admin@127.0.0.1:55433
psql postgresql://admin@127.0.0.1:55433/postgres -v ro_password="'test'" < sql/readonly-role.sql
TEST_PG_BASE=postgresql://weekly_review_ro:test@127.0.0.1:55433 npm test
```

## Deploy

1. Create the role on the shared Postgres (once): see the header of `sql/readonly-role.sql`.
2. Add the service to `deploy/docker-compose.yml` behind a profile, on the same network as `db` and `dynamodb`, with a volume for `/data` and an `env_file`. See `deploy/compose-snippet.yml`.
3. Point a proxy host (Nginx Proxy Manager) at port 8790 and set `PUBLIC_URL` to it.
4. Send yourself last week's review to check: `docker compose exec weekly-review node src/cli.js`.

## Links and privacy

Page links carry an HMAC token. There's no login, so anyone holding the link from the email can open that week's page. Pages send `Referrer-Policy: no-referrer`, `noindex` and `no-store`. Rotating `LINK_SECRET` invalidates every link. Reviews are stored as JSON files (mode 600) under `DATA_DIR/reviews`.
