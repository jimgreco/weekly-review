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

 owner's Mac (Sunday ~17:30, Claude Desktop task)
   digest of the week's Claude Code transcripts ──► Claude writes a short summary
   cli.js post-notes ── PUT /api/notes/claude-code (notes token) ──► review site
   (the cloud routine's collect reads it back with GET /api/notes)
```

The Mac step adds a `## Beyond the apps` section: what the owner built in Claude Code that week, and the important decisions and plans made in those sessions. Transcripts never leave the Mac; only the summary is posted. It's optional: without it the review just skips that section.

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
  - `link` prints a week's private link on the site;
  - `post-notes` (on the owner's Mac) stores the week's Claude Code summary on the site.
- `routine/WEEKLY_REVIEW.md` holds the routine's steps and the narrative rules. The routine's prompt just points at it.
- `routine/CLAUDE_CODE_SUMMARY.md` holds the Mac task's steps and summary rules; `scripts/claude-code-digest.mjs` builds the local digest it summarises (typed messages and final replies only, secrets redacted, capped at ~60k chars; never tool inputs or outputs).
- `src/server.js` is the review site:
  - `POST /api/reviews` takes the ingest token, validates the review and stores it. It emails at most once per week, even if two posts race.
  - `GET /r/<monday>?t=…` and `GET /archive?t=…` serve HMAC-signed private pages.
  - `PUT /api/notes/claude-code?week=<monday>` takes the notes token (`NOTES_TOKEN_SHA256`) and stores the Mac's summary as `DATA_DIR/notes/<monday>/claude-code.json`, replacing any earlier one. `GET /api/notes?week=<monday>` returns it to the routine with the ingest token. Notes are never shown on the review page or copied into the stored review.
  - `/summaries` (`src/summaries.js`, `src/google.js`) lets the owner read the stored Claude Code summaries behind Google sign-in. `GET /summaries/login` shows the Google Identity Services button; `POST /summaries/auth` checks the GIS double-submit CSRF token and verifies the ID token locally (RS256 against Google's cached JWKS; issuer, audience = `GOOGLE_CLIENT_ID`, expiry, `email_verified`, and the email on `SUMMARIES_ALLOWED_EMAILS`), then sets a 30-day `__Host-wr_summaries` cookie (HMAC with a key derived from `LINK_SECRET`; `HttpOnly; Secure; SameSite=Lax`). `GET /summaries` lists weeks with a summary, newest first; `GET /summaries/<monday>` shows one with links to the next older and newer. `POST /summaries/logout` needs a same-origin `Origin`. Unset `GOOGLE_CLIENT_ID` or allow-list = every `/summaries` route is a 404.
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

`.github/workflows/release.yml` (the standard release-tools template) runs `verify.yml` (`npm test`) on pull requests, pushes to `main` and manual runs. Every push to `main` then calls the shared `jimgreco/release-tools` server-release workflow (pinned by commit), which publishes `ghcr.io/jimgreco/weekly-review:<sha>` and releases it to the running site with `release.py`, driven by `.github/release/server.json` (only that container; drift-checked, rolled back on a failed health check). A manual run on `main` can release the server again. See `deploy/RUNBOOK.md`. It covers:

- the site container;
- the five app tokens;
- the cloud environment and the routine.

## Links and privacy

Page links carry an HMAC token. There's no login, so anyone holding the link from the email can open that week's page. Pages send `Referrer-Policy: no-referrer`, `noindex` and `no-store`. Rotating `LINK_SECRET` invalidates every link. Reviews are stored as JSON files (mode 600) under `DATA_DIR/reviews`, and Mac notes under `DATA_DIR/notes` (files 600, folders 700). The `publish` response never includes the private link, so it stays out of the routine's transcript.

The `/summaries` pages are the only ones with a login. They send `no-store`, `X-Robots-Tag: noindex`, `X-Frame-Options: DENY` and a CSP with `frame-ancestors 'none'`. Only the login page's CSP allows `https://accounts.google.com/gsi/` (script, frame, connect, style), and it sends `Referrer-Policy: strict-origin` because GIS checks the page origin; the other summaries pages send `no-referrer`. Removing an address from `SUMMARIES_ALLOWED_EMAILS` ends its session; rotating `LINK_SECRET` ends every session (and every review link). Failed sign-ins show only "This account can't view summaries." and log a short reason, never the token.
