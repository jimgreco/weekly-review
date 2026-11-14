# Weekly summary endpoint contract

Each app (Macrovana, Rep Mix Burn, Spending, Ritual Cue, Week of Us, Journal) exposes one read-only endpoint. The weekly-review routine calls all six every Sunday evening, then writes the analysis.

## Request

```
GET /api/weekly-summary?week=YYYY-MM-DD
Authorization: Bearer <token>
```

- `week` must be a valid calendar date that is a **Monday**. Anything else returns `400 {"error":"week must be a Monday (YYYY-MM-DD)"}`.
- The week covers Monday through Sunday. `prev` is the Monday 7 days earlier, `next` the Monday 7 days later. Every date is a plain local date. No instants are compared across timezones, except where an app already converts timestamps to the user's local day (Macrovana's `consumed_at` does).

## Auth

The app reads two environment variables:

| Variable | Meaning |
|---|---|
| `WEEKLY_SUMMARY_TOKEN_SHA256` | Lowercase hex SHA-256 of the bearer token. The plaintext token is never stored in the app. |
| `WEEKLY_SUMMARY_EMAIL` | Whose data the endpoint reports, matched case-insensitively. The token cannot choose a different user. |

- If either variable is unset or empty, the endpoint returns **404**, as if the route does not exist.
- A missing or wrong token also returns **404**. Hash the presented token with SHA-256 and compare it to the stored hash with a constant-time comparison.
- The token is checked **only** on this route, before or instead of the app's normal session or bearer auth. It must never be accepted anywhere else, and the app's normal user tokens must not be accepted on this route.
- Apply the app's rate limiter to this route where one exists.

## Read-only

The handler performs reads only:

- No inserts, updates or deletes.
- No `last_used_at` touches.
- No seeding, carry-over or materialization side effects.
- No audit-log writes.

Where the app has a read path (`store.read()`, a plain `SELECT`), use it.

## Response

```
200 Content-Type: application/json, Cache-Control: no-store
{
  "version": 1,
  "app": "macros" | "workouts" | "spending" | "checklist" | "planner" | "journal",
  "week": {"start": "2026-11-02", "end": "2026-11-08"},
  "generatedAt": "<ISO-8601>",
  "data": { ... }
}
```

`data` is **exactly** the object the matching module of weekly-review's earlier direct-database version returned: same keys, nesting, rounding and status values (`ok`, `no-account`, ...). Those modules are at commit `14eada5`, `src/sources/*.js`. Each app's port is now the authoritative version. `src/render.js` here reads these shapes.

| App | Spec |
|---|---|
| macros | `src/sources/macros.js` → `collectMacros` |
| workouts | `src/sources/workouts.js` → `collectWorkouts` |
| spending | `src/sources/spending.js` → `collectSpending` |
| checklist | `src/sources/checklist.js` → `collectChecklist` |
| planner | `src/sources/planner.js` → `collectPlanner` |
| journal | `jimgreco/journal` README, "Weekly summary" (new; no earlier direct-database version) |

- **Macrovana:** `sleepScore`, `readinessScore`, `avgSteps` and `change.sleepScore` are always `null`, and `oura_documents` is never read. Oura's API agreement forbids passing Oura data, or values derived from it, to any AI/ML model, and the routine hands this payload to Claude. See macros `AGENTS.md`.
- **Macrovana sleep (additive, 2026-11):** `current/previous.sleepNights` (nights with logged sleep) and `avgSleepHours` (mean hours on those nights, 1 dp), plus `change.avgSleepHours`. They come only from live `sleep_entries` with source `healthkit` or `manual` and no Oura document link: Apple Health and manual sleep, which Macrovana already treats as AI-eligible. When direct Oura is connected, Macrovana drops Oura-app sleep that arrives through Apple Health, so these reflect other sources (Apple Watch, manual) unless Oura is disconnected.
- **Macrovana Apple Health metrics (additive, 2026-11):** `current/previous.health` = `{ daysWithData, avgSteps, avgActiveEnergyKcal, avgExerciseMinutes, avgRestingHeartRate, avgHrvMs, latestVo2Max, avgDistanceMiles, avgFlightsClimbed, avgWalkingSpeedMph, avgHeartRateBpm, avgLowestHeartRateBpm, avgRespiratoryRate, avgOxygenSaturationPct }` from Apple Health daily values (`health_daily_metrics`, source `healthkit`), plus `change.health = { avgSteps, avgRestingHeartRate, avgHrvMs, avgDistanceMiles, avgHeartRateBpm }`. `health` is null when the account hasn't turned on Activity/Heart read access. The top-level `avgSteps` stays the always-null Oura slot.
- Rounding follows `src/stats.js`: `round(v, d) = Math.round(v * 10**d) / 10**d`, which rounds half up and is not banker's rounding. Python ports must reproduce this.
- When the user is unknown, `data` is `{"status": "no-account"}` with HTTP 200. That way a misconfigured email shows up in the review instead of looking like an outage.
- Internal errors return `500 {"error":"internal"}`, with no stack traces or SQL in the body.

## Deployment notes

- The two variables are added to the app's production environment by the owner. Until then the route is a 404, so shipping the code is inert.
- Generate the token with `openssl rand -base64 32 | tr -d '=+/' | cut -c1-40`. Set `WEEKLY_SUMMARY_TOKEN_SHA256=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)` in the app, and store `$TOKEN` only in the routine's environment.

## Check-in evidence (Macrovana and Rep, Mix, Burn only)

```
GET /api/checkin-evidence?start=YYYY-MM-DD&end=YYYY-MM-DD
Authorization: Bearer <the same weekly-summary token>
```

The detailed companion used by the Saturday check-in routine (`routine/CHECKIN.md`, `node src/cli.js evidence`). It deliberately accepts the **same token and env vars** as `weekly-summary` (`WEEKLY_SUMMARY_TOKEN_SHA256`, `WEEKLY_SUMMARY_EMAIL`), with the same 404 rules, constant-time check and rate limiter, so the cloud environment's existing network secret for each host covers it. The token opens these two read-only routes and nothing else.

- `start` <= `end`, 1–31 calendar days inclusive; otherwise `400`. Longer ranges are split by the caller.
- Read-only, like `weekly-summary`. Unknown user: `data = {"status": "no-account"}`.
- Response: `{version: 1, app, range: {start, end}, timezone, generatedAt, data}` with `Cache-Control: no-store`.
- **macros** `data`: `entries` (per food entry with macros, `consumed_at`, `localDate`, meal), `nutritionDays` (`complete`/`partial`; a missing day is unknown), `macroTargets` and `weightTargets` (full history up to `end`), `weights`, `waists`, `checkins` (notes), `photos` (metadata only, never keys or URLs), `sleep` (Apple Health and manual only: `localDate`, `logged_at`, `durationHours`, `wakeUps`, `source`). Never reads `oura_documents`; rows whose provenance mentions Oura are excluded. More than 5,000 rows of a kind is `500 {"error":"too-many-rows"}`: request a shorter range.
- **workouts** `data`: `logs` (each with its day in the user's timezone by `startTime`, `status`, `notes`, `exerciseItems` with setup profile and raw sets, and the immutable historical `prescription`) and `programs` (schedule and phases). Only projected fields; raw entered loads, side reps and null RIR are kept as stored; no computed totals or 1RM. Deleted and imported/provider logs are excluded.
