# Weekly Review

Every Sunday evening, a Claude Code cloud routine does three things:

1. Asks each of your apps for its week.
2. Writes a short reading of it.
3. Posts the result to a small review site, which emails you a private link to the full page.

```
 cloud routine (Sunday 23:00 UTC)                         review site (EC2)
 ┌──────────────────────────────────┐   POST /api/reviews  ┌───────────────────────┐
 │ cli.js collect ──► 5 × GET        │ ───────────────────► │ store JSON, email link│
 │ Claude writes the narrative       │   (ingest token)     │ serve /r/<week>?t=…   │
 │ cli.js publish                    │                      └───────────────────────┘
 └──────────────────────────────────┘
          │ GET /api/weekly-summary?week=<monday>  (one read-only token per app)
          ▼
 Macrovana · Rep, Mix, Burn · Spending · Ritual Cue · Week of Us
```

| Source | What the endpoint returns |
|---|---|
| Macrovana | daily calories/protein, Complete days, targets, weight, waist. Oura fields are always null, because Oura's API terms keep its data out of AI models. |
| Rep, Mix, Burn | finished sessions, working sets by muscle group, PBs, active program and phase |
| Spending | weekly total (same exclusion rule as `/api/stats`), top categories against the 8-week average, largest charges |
| Ritual Cue | check-offs, misses, and habits that dropped off since last week |
| Week of Us | tasks done, stuck (carried over at least twice) and overdue; next week's tasks and priorities, meals and logistics |

`docs/weekly-summary-contract.md` defines the endpoint each app exposes. Each app checks its own token (stored as a SHA-256 hash, bound to one user's email), returns 404 for anything else, and only reads.

Each source fails on its own. A broken, slow or unconfigured app shows a short note, and the rest of the review still goes out. The same holds for a response marked "ok" whose shape is wrong: only that section is left out.

## Pieces

- `src/sources.js` calls the five endpoints. It never follows redirects with a token.
- `src/cli.js` has four commands:
  - `collect` writes the review JSON;
  - `publish` posts it with the narrative (`--send` emails once per week; `--resend` deliberately emails again);
  - `render` previews the page locally;
  - `link` prints a week's private link on the site.
- `routine/WEEKLY_REVIEW.md` holds the routine's steps and the narrative rules. The routine's prompt just points at it.
- `src/server.js` is the review site:
  - `POST /api/reviews` takes the ingest token, validates the review and stores it. It emails at most once per week, even if two posts race.
  - `GET /r/<monday>?t=…` and `GET /archive?t=…` serve HMAC-signed private pages.
  - `GET /health`.

The site has no database access and no Claude key. The cloud routine has no database access either, and holds no tokens: they are network secrets on its cloud environment, added to requests by the agent proxy outside the session.

## Run locally

```bash
cp .env.example .env   # fill in the routine section
node --env-file=.env src/cli.js collect --week 2026-11-02 --out /tmp/review.json
node --env-file=.env src/cli.js render --in /tmp/review.json --out /tmp/review.html
```

The default week is the current week on a Sunday, and the last finished week on any other day.

## Tests

```bash
npm test
```

There are no dependencies to install. Each app's endpoint is tested in its own repository.

## Deploy

Every push to `main` tests, then calls the shared `jimgreco/release-tools` server-release workflow (pinned by commit), which publishes `ghcr.io/jimgreco/weekly-review:<sha>` and releases it to the running site with `release.py`, driven by `.github/release/server.json` (only that container; drift-checked, rolled back on a failed health check). See `deploy/RUNBOOK.md`. It covers:

- the site container;
- the five app tokens;
- the cloud environment and the routine.

## Links and privacy

Page links carry an HMAC token. There's no login, so anyone holding the link from the email can open that week's page. Pages send `Referrer-Policy: no-referrer`, `noindex` and `no-store`. Rotating `LINK_SECRET` invalidates every link. Reviews are stored as JSON files (mode 600) under `DATA_DIR/reviews`. The `publish` response never includes the private link, so it stays out of the routine's transcript.
