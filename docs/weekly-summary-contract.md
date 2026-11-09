# Weekly summary endpoint contract

Each app (Macrovana, Rep Mix Burn, Spending, Ritual Cue, Week of Us) exposes one read-only endpoint. The weekly-review routine calls all five every Sunday evening, then writes the analysis.

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
  "app": "macros" | "workouts" | "spending" | "checklist" | "planner",
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

- Rounding follows `src/stats.js`: `round(v, d) = Math.round(v * 10**d) / 10**d`, which rounds half up and is not banker's rounding. Python ports must reproduce this.
- When the user is unknown, `data` is `{"status": "no-account"}` with HTTP 200. That way a misconfigured email shows up in the review instead of looking like an outage.
- Internal errors return `500 {"error":"internal"}`, with no stack traces or SQL in the body.

## Deployment notes

- The two variables are added to the app's production environment by the owner. Until then the route is a 404, so shipping the code is inert.
- Generate the token with `openssl rand -base64 32 | tr -d '=+/' | cut -c1-40`. Set `WEEKLY_SUMMARY_TOKEN_SHA256=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)` in the app, and store `$TOKEN` only in the routine's environment.
