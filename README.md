# Weekly Review

Every Sunday evening, a Claude Code cloud routine does three things:

1. Asks each of your apps for its week.
2. Writes a short reading of it.
3. Posts the result to a small review site, which emails you a private link to the full page.

```
 cloud routine (Sunday 23:00 UTC)                         review site (EC2)
 ┌──────────────────────────────────┐   POST /api/reviews  ┌───────────────────────┐
 │ cli.js collect ──► 6 × GET        │ ───────────────────► │ store JSON, email link│
 │ Claude writes the narrative       │   (ingest token)     │ serve /r/<week>?t=…   │
 │ cli.js publish                    │                      └───────────────────────┘
 └──────────────────────────────────┘
          │ GET /api/weekly-summary?week=<monday>  (one read-only token per app)
          ▼
 Macrovana · Rep, Mix, Burn · Spending · Ritual Cue · Week of Us · Journal

 owner's Mac (Sunday ~17:30, Claude Desktop task)
   digest of the week's Claude Code transcripts ──► Claude writes a short summary
   cli.js post-notes ── PUT /api/notes/claude-code (notes token) ──► review site
   (the cloud routine's collect reads it back with GET /api/notes)
```

The review also closes its own loop. Each one proposes three to five commitments for the coming week; you accept or decline each on the review page; the next review scores the ones you accepted. See [Commitments](#commitments).

The Mac step adds a `## Beyond the apps` section: what the owner built in Claude Code that week, and the important decisions and plans made in those sessions. Transcripts never leave the Mac; only the summary is posted. It's optional: without it the review just skips that section.

| Source | What the endpoint returns |
|---|---|
| Macrovana | daily calories/protein, Complete days, targets, weight, waist. Oura fields are always null, because Oura's API terms keep its data out of AI models. |
| Rep, Mix, Burn | finished sessions, working sets by muscle group, PBs, active program and phase |
| Spending | weekly total (same exclusion rule as `/api/stats`), top categories against the 8-week average, largest charges |
| Ritual Cue | check-offs, misses, and habits that dropped off since last week |
| Week of Us | tasks done, stuck (carried over at least twice) and overdue; next week's tasks and priorities, meals and logistics |
| Journal | counts, mood and tags, plus the text of the week's non-private entries. The text is for the narrative only: the site stores and shows counts, and the 8-week history carries counts only. |

`docs/weekly-summary-contract.md` defines the endpoint each app exposes. Each app checks its own token (stored as a SHA-256 hash, bound to one user's email), returns 404 for anything else, and only reads.

Each source fails on its own. A broken, slow or unconfigured app shows a short note, and the rest of the review still goes out. The same holds for a response marked "ok" whose shape is wrong: only that section is left out.

## Commitments

1. **Propose.** Alongside the narrative the routine writes `commitments.json` with `next`: the `## Next week` actions as data, each with a `text`, a `measure` (how it will be judged, naming the app and threshold) and an `area`. `publish --commitments` posts it with the review.
2. **Decide.** The review page lists them under "Commitments for the coming week" with Accept and Decline buttons (plain form posts, no script; `Change` undoes a choice). Only accepted ones count. The private link is the credential, as it is for reading the page.
3. **Score.** Next Sunday `collect` reads them back (`GET /api/commitments`) into `review.commitments.due`, with the follow-through of the eight weeks before in `commitments.history`. The routine judges each accepted one against the week's data, writes `## Last week's commitments`, and posts the outcomes as `results` (`hit`, `partial`, `miss`, or `unknown` when the data to judge it is missing). That page then shows the scorecard, and the week is closed to further changes.

Commitments are stored one file per week in `DATA_DIR/commitments/<monday>.json`, named for the week they are for, apart from the stored review: re-publishing a review keeps your decisions (matched by unchanged text). Declined and unanswered proposals are never scored.

**Reminders.** With `TASKS_API_URL` and `TASKS_COMMITMENTS_TOKEN` set, every change to a week's commitments is sent to Task Sidekick (`jimgreco/reminders-ai`, `PUT /api/commitments?week=<monday>`): the accepted ones, or none once the week is scored. The owner's iPhone makes a reminder for each in a "Weekly Commitments" list, due that Sunday, removes the reminder of one he un-accepts, and clears the still-open ones when the week is scored. `GET /api/commitments` on this site then carries `checkedOff` and `checkedOffAt` on each item, read from Task Sidekick at that moment, so the routines can use a check-off as evidence for a commitment no app measures. Sending is best effort (retried three times over about a minute, then dropped until the next change) and never holds up the page; with the variables unset, or Task Sidekick down, everything else works as before. Nothing is pushed into Ritual Cue or Week of Us yet.

## Between the reviews

Three more cloud routines post pieces to the same site. Each is stored, emailed at most once and readable at its own private link (`/p/<kind>/<key>?t=…`); the archive page lists them.

| Routine | When | What it posts |
|---|---|---|
| `routine/MIDWEEK.md` | Wednesday around midday | **Pulse** (`pulse`, keyed by the week's Monday): a few lines on how the week's accepted commitments are going, from the week so far. If commitments were proposed but none accepted, a two-line nudge; if none were proposed, nothing. |
| | | **Decision brief** (`decision`, keyed by the decision's id): for each open decision in the register dated within 7 days and not yet briefed, the evidence in one page: what you set out, what 12 weeks of data say, what the data can't tell you, and where it points. |
| `routine/CHECKIN.md` | Saturday morning | **Nutrition & training check-in** (`checkin`, keyed by the review date): a detailed coaching review of the Saturday–Friday week from Macrovana's and Rep, Mix, Burn's `GET /api/checkin-evidence` (per-day food entries, per-set logs with their historical prescriptions), set against the whole program since it started. It reads the owner's private standing context (`/api/context/checkin`) and the last check-in, which it scores. |
| `routine/MONTHLY.md` | 1st of the month | **Monthly roll-up** (`monthly`, keyed `YYYY-MM`): the month just ended against the one before, by area, plus commitment follow-through. A month is the whole Monday–Sunday weeks that end in it. |

None of them uses connectors. All run in the weekly routine's cloud environment and reach the site with the same ingest token. `checkin-evidence` accepts the same per-app token as `weekly-summary`, so the environment needs no extra secrets.

The check-in's standing context (goals, phase, targets, load conventions) is personal, so it lives only on the site, like the decision register. Edit it from the Mac with the notes token: `node src/cli.js context pull --name checkin --out checkin.md`, then `context push --name checkin --file checkin.md`. To discuss a check-in in a Claude Code session on the Mac, run `node src/cli.js posts get --kind checkin --latest --owner` (or `--key YYYY-MM-DD`); the cloud run's own session can also be continued, with the week's evidence still in `/tmp`.

**The decision register** is your own list of dated decisions: `id`, `date`, `title`, `question`, optional `options`, `context` (the plan and criteria the brief should judge against), `status` (`open`, `decided`, `dropped`) and `outcome`. It is personal, so it lives only on the site (`DATA_DIR/decisions.json`), never in this repository. Edit it from the Mac, which already holds the notes token:

```bash
node src/cli.js decisions pull --out /tmp/decisions.json   # edit the file
node src/cli.js decisions push --file /tmp/decisions.json  # replaces the whole list
```

The Sunday review also sees decisions in the next 14 days and names one that falls in the coming week.

## Home

`/home` ties it together behind the Google sign-in that protects `/summaries` (same allow-list, same session; signing in lands here, and `/` redirects here). It shows:

- this week's commitments, and next week's once Sunday's review has proposed them, with the same Accept / Decline buttons as the review page (a scored week shows as a scorecard);
- follow-through for the last eight weeks;
- the latest review, nutrition & training check-in, midweek check, month and Claude Code summary;
- the next open decisions, with a link to each brief once it exists;
- the whole archive.

`/decisions` is the decision register as a page: add a decision, edit it, and record the outcome (`/decisions/new`, `/decisions/<id>`). An id is made from the title and never changes. The CLI's `decisions pull` / `push` still work and replace the whole list.

Every form post needs the session cookie (`SameSite=Lax`) plus a token derived from it, and a cross-site `Origin` is refused. With `GOOGLE_CLIENT_ID` or `SUMMARIES_ALLOWED_EMAILS` unset these routes are a 404, like `/summaries`.

## Pieces

- `src/sources.js` calls the six endpoints. It never follows redirects with a token.
- `src/cli.js` has these commands:
  - `collect` writes the review JSON;
  - `publish` posts it with the narrative (`--send` emails once per week; `--resend` deliberately emails again; `--commitments` adds the scores and next week's proposals);
  - `render` previews the page locally;
  - `link` prints a week's private link on the site;
  - `post-notes` (on the owner's Mac) stores the week's Claude Code summary on the site;
  - `post` posts a pulse, decision brief or monthly roll-up (`--send` emails it once);
  - `decisions pull` / `decisions push` (on the owner's Mac) read and replace the decision register.
  `collect --current` collects the week in progress, and `collect --month` the last week of last month with the history to cover that month and the one before.
- `routine/WEEKLY_REVIEW.md` holds the routine's steps and the narrative rules. The routine also has **read-only** Gmail, Google Calendar and Drive/Docs/Sheets/Slides connectors (write tools are excluded in the routine's connector settings) for week context in `## Beyond the apps` and `## Next week`. The routine's prompt just points at it.
- `routine/CLAUDE_CODE_SUMMARY.md` holds the Mac task's steps and summary rules; `scripts/claude-code-digest.mjs` builds the local digest it summarises (typed messages and final replies only, secrets redacted, capped at ~60k chars; never tool inputs or outputs).
- `src/commitments.js` validates and stores the commitments loop (propose, decide, score, history).
- `src/tasks.js` sends accepted commitments to Task Sidekick and reads the check-offs back.
- `src/posts.js` validates, stores and emails the posts; `src/decisions.js` validates and stores the decision register.
- `routine/MIDWEEK.md`, `routine/MONTHLY.md` and `routine/CHECKIN.md` hold the other routines' steps and writing rules.
- `src/home.js` serves `/home` and `/decisions` for the signed-in owner.
- `src/server.js` is the review site:
  - `POST /api/reviews` takes the ingest token, validates the review and stores it. It emails at most once per week, even if two posts race.
  - `GET /r/<monday>?t=…` and `GET /archive?t=…` serve HMAC-signed private pages.
  - `POST /r/<monday>/commitments?t=…` (form fields `id`, `decision` = `accept`, `decline` or `undo`) records a choice on one of the commitments that review proposed and redirects back to the page. It takes the page's own link token and refuses a cross-site `Origin`.
  - `POST /api/posts` takes the ingest token and a `{kind, key, text}` post, stores it and emails it at most once. A decision brief must name a decision in the register. `GET /p/<kind>/<key>?t=…` serves it.
  - `GET /api/decisions` returns the register (ingest or notes token) with a `briefed` flag per decision; `PUT /api/decisions` replaces it (notes token only, so the cloud routines can read but never write it).
  - `GET /api/commitments?week=<monday>` returns that week's commitments and the earlier weeks' follow-through counts to the routine, with the ingest token. Each item carries `checkedOff` (true, false, or null when unknown) from Task Sidekick.
  - `PUT /api/notes/claude-code?week=<monday>` takes the notes token (`NOTES_TOKEN_SHA256`) and stores the Mac's summary as `DATA_DIR/notes/<monday>/claude-code.json`, replacing any earlier one. `GET /api/notes?week=<monday>` returns it to the routine with the ingest token. Notes are never shown on the review page or copied into the stored review.
  - `/summaries` (`src/summaries.js`, `src/google.js`) lets the owner read the stored Claude Code summaries behind Google sign-in. `GET /summaries/login` shows the Google Identity Services button; `POST /summaries/auth` checks the GIS double-submit CSRF token and verifies the ID token locally (RS256 against Google's cached JWKS; issuer, audience = `GOOGLE_CLIENT_ID`, expiry, `email_verified`, and the email on `SUMMARIES_ALLOWED_EMAILS`), then sets a 30-day `__Host-wr_summaries` cookie (HMAC with a key derived from `LINK_SECRET`; `HttpOnly; Secure; SameSite=Lax`). `GET /summaries` lists weeks with a summary, newest first; `GET /summaries/<monday>` shows one with links to the next older and newer. `POST /summaries/logout` needs a same-origin `Origin`. Unset `GOOGLE_CLIENT_ID` or allow-list = every `/summaries` route is a 404.
  - `GET /health`.

The site has no database access and no Claude key. The one token it holds in plaintext is `TASKS_COMMITMENTS_TOKEN`, which works only on Task Sidekick's `/api/commitments`. The cloud routine has no database access either, and holds no tokens: they are network secrets on its cloud environment, added to requests by the agent proxy outside the session.

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
