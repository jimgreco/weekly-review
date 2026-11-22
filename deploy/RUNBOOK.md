# Turning on Weekly Review

There are four parts, all done by the owner:

1. Each app's weekly-summary endpoint.
2. The review site on the shared EC2 host.
3. The cloud routine.
4. Optional: the Mac task that adds the Claude Code summary.

GitHub changes the server only through the main-branch release described in 2c, which replaces this one container. Other server steps run over the existing pinned SSH connection, under the shared `~/deploy/.app-release.lock`, and never print a secret.

## 0. Generate the tokens on your Mac

Each token exists in plaintext in only one place: the routine's cloud environment. The apps and the site store only its SHA-256.

```bash
umask 077; mkdir -p ~/.weekly-review-tokens; cd ~/.weekly-review-tokens
for name in macros workouts spending checklist planner ingest; do
  openssl rand -base64 32 | tr -d '=+/\n' | cut -c1-40 > "$name.token"
  printf %s "$(cat "$name.token")" | shasum -a 256 | cut -d' ' -f1 > "$name.sha256"
done
ls
```

The `.sha256` files are not secret. Copy each one to the host when its step needs it. Delete the folder once the routine environment holds the tokens.

## 1. App endpoints

Each app's `weekly-summary-endpoint` branch adds `GET /api/weekly-summary`. Merging deploys it through that app's normal release. The route is a 404 until its two variables are set, so the code can ship first.

| App | Public origin | Compose service | Where its env lives |
|---|---|---|---|
| Macrovana | `https://macrovana.com` | `macros` | live compose env; `safe-compose-release.py` checks drift |
| Rep, Mix, Burn | `https://repmixburn.com` | `workout_api` | live `.env`/override; `safe-compose-release.py` checks drift |
| Spending | `https://spending-analyzer.jim-greco.com` | spending | production Compose, via `docs/release-runtime-cutover.md` |
| Ritual Cue | `https://ritualcue.com` | `daily` | live compose env; `deploy-service.py` checks drift |
| Week of Us | `https://weekofus.com` | `common-week` | `.github/deploy/common-week-apple.yml` env layer plus host `.env` |

For each app:

1. Add two variables to that service's live environment:
   - `WEEKLY_SUMMARY_TOKEN_SHA256` = the contents of `<app>.sha256`;
   - `WEEKLY_SUMMARY_EMAIL=jgreco@gmail.com`.
2. Recreate only that service, e.g. `docker-compose up -d --no-deps <service>`. Make this a configuration change of its own, not part of a release, because the release helpers refuse to deploy while the running environment differs from the configured one.
3. Check it from your Mac. The first command should print `404`; the second should print a JSON envelope with `"app":"<app>"`.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "https://<origin>/api/weekly-summary?week=2026-11-02"
   curl -s -H "Authorization: Bearer $(cat ~/.weekly-review-tokens/<app>.token)" "https://<origin>/api/weekly-summary?week=2026-11-02" | head -c 300; echo
   ```

## 2. Review site

Prerequisites:

- The consolidated-deploy change adding the `weekly-review` service is merged and staged under its normal review.
- `ghcr.io/jimgreco/weekly-review:<sha>` exists. This repo's CI publishes it on every push to `main`.

### 2a. Headroom

```bash
free -m; df -h /
```

The site is capped at 160 MB. Stop if available memory is under about 250 MB or free disk is under 1 GB.

### 2b. `~/deploy/weekly-review.env` (mode 600)

```bash
cd ~/deploy && umask 077
LINK_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
cat > weekly-review.env <<EOF
REVIEW_EMAIL=jgreco@gmail.com
PUBLIC_URL=https://review.jim-greco.com
LINK_SECRET=$LINK_SECRET
INGEST_TOKEN_SHA256=<contents of ingest.sha256>
REVIEW_EMAIL_FROM=Weekly Review <notifications@weekofus.com>
RESEND_API_KEY=
EOF
unset LINK_SECRET
```

Then set the Resend key from Week of Us's key without printing it. The host's compose `.env` holds it as `COMMON_WEEK_RESEND_API_KEY`:

```bash
key="$(sed -n 's/^COMMON_WEEK_RESEND_API_KEY=//p' ~/deploy/.env)"
[ -n "$key" ] && sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=$key|" weekly-review.env && echo set || echo "not found; paste a key with an editor"
unset key
```

The From address must be on a domain verified in that Resend account.

### 2c. Data directory and start

```bash
mkdir -p ~/deploy/weekly-review-data && sudo chown 1000:1000 ~/deploy/weekly-review-data && chmod 700 ~/deploy/weekly-review-data
cd ~/deploy
export WEEKLY_REVIEW_IMAGE=ghcr.io/jimgreco/weekly-review:<sha>
docker-compose --profile weekly-review pull weekly-review
docker-compose --profile weekly-review up -d --no-deps weekly-review
docker-compose --profile weekly-review ps weekly-review   # healthy within ~30s
```

Persist `WEEKLY_REVIEW_IMAGE=...` in `~/deploy/.env`, the way `COMMON_WEEK_IMAGE` is kept.

This first start is the only manual one. After it, every push to `main` deploys itself through the shared [`jimgreco/release-tools`](https://github.com/jimgreco/release-tools) server-release workflow, pinned by commit and configured by `.github/release/server.json`. It publishes the image, then runs `server/release.py` on the host over the pinned SSH connection. It takes the shared release locks, refuses if the configured service no longer hashes like the running one, writes `~/deploy/releases/weekly-review-image-<sha>.json` (which sets only the image), recreates only `weekly-review`, health-checks it, and rolls back to the previous image on failure. Before the first start, the release step just reports that the service isn't running.

It needs a GitHub environment named `production` in `jimgreco/weekly-review` with four secrets, the same values the other apps use: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` and `EC2_SSH_KNOWN_HOSTS`. The released image is pinned by the override file in `~/deploy/releases/`, which the running container records in its Compose labels; a later manual `up` should reuse the running container's recorded `-f` files, or it will fall back to whatever `~/deploy/.env` says.

### 2d. Public route

1. **DNS:** an `A` record for `review.jim-greco.com` pointing to the host's public IP.
2. **Nginx Proxy Manager:** a proxy host for `review.jim-greco.com`. Forward to `weekly-review` on port `8790` over `http`, and turn on Let's Encrypt with Force SSL.
3. **Check:** run `curl -fsS https://review.jim-greco.com/health` (prints `ok`). Then post without a token; this should print `404`:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://review.jim-greco.com/api/reviews
   ```

## 3. Cloud routine

The routine's session never holds a token. Each one is a **network secret** on the cloud environment: Anthropic's agent proxy adds `Authorization: Bearer <token>` to requests for that host after they leave the session, so even a prompt injection in the data can't read them.

1. At claude.ai/code, open the environment selector under the message box → **New environment**, named `weekly-review`:
   - **Network access:** Limited (the network-secret hosts are reachable without adding them).
   - **Environment variables:**

     ```text
     MACROS_API_URL=https://macrovana.com
     WORKOUTS_API_URL=https://repmixburn.com
     SPENDING_API_URL=https://spending-analyzer.jim-greco.com
     CHECKLIST_API_URL=https://ritualcue.com
     PLANNER_API_URL=https://weekofus.com
     REVIEW_SITE_URL=https://review.jim-greco.com
     AUTH_VIA_PROXY=1
     NODE_USE_ENV_PROXY=1
     ```
   - Save with **Add environment**, then edit it again → **Network secrets** → **Add secret**, six times, type **Bearer**, header `Authorization`, prefix `Bearer`:

     | Allowed website | Value |
     |---|---|
     | `macrovana.com` | `macros.token` |
     | `repmixburn.com` | `workouts.token` |
     | `spending-analyzer.jim-greco.com` | `spending.token` |
     | `ritualcue.com` | `checklist.token` |
     | `weekofus.com` | `planner.token` |
     | `review.jim-greco.com` | `ingest.token` |

     Copy each value with `pbcopy < ~/.weekly-review-tokens/<name>.token` and paste it; it can't be viewed again after saving.
2. Create the routine with that environment:
   - repository: `jimgreco/weekly-review`
   - cron: `0 23 * * 0`, i.e. Sunday 23:00 UTC, which is 6 pm EST or 7 pm EDT
   - prompt: "Follow routine/WEEKLY_REVIEW.md in this repository exactly."
   - tools: Bash, Read, Write
3. Dry run on your Mac, with the URLs and tokens in a local `.env` (mode 600; no `AUTH_VIA_PROXY`). Open the page and check the numbers against each app:

   ```bash
   node --env-file=.env src/cli.js collect --out /tmp/review.json
   node --env-file=.env src/cli.js render --in /tmp/review.json --out /tmp/review.html
   ```
4. Run the routine once now, then confirm you received the email and every app shows `ok`.

## 4. Claude Code summary (Mac task, optional)

The Mac summarises the week's Claude Code sessions and posts only the summary (`routine/CLAUDE_CODE_SUMMARY.md`). Its notes token lives only on the Mac; the site stores its SHA-256. It must differ from the ingest token.

1. **Token, on the Mac:**

   ```bash
   umask 077; mkdir -p ~/.config/weekly-review
   openssl rand -base64 32 | tr -d '=+/\n' | cut -c1-40 > ~/.config/weekly-review/notes.token
   chmod 600 ~/.config/weekly-review/notes.token
   printf %s "$(cat ~/.config/weekly-review/notes.token)" | shasum -a 256 | cut -d' ' -f1   # not secret
   ```
2. **Site:** over the pinned SSH connection, under `~/deploy/.app-release.lock`, add `NOTES_TOKEN_SHA256=<that hash>` to `~/deploy/weekly-review.env` (mode 600). Then recreate `weekly-review` straight away with the running container's recorded Compose chain (the `-f` files in its `com.docker.compose.project.config_files` label, which include the `~/deploy/releases/weekly-review-image-<sha>.json` override), e.g. `docker-compose -f <each recorded file> --profile weekly-review up -d --no-deps weekly-review`. Do it right after the edit: the CI release's drift check (`deploy-app.sh` / `release.py`) hashes the resolved service model, env_file values included, so an edited but not-yet-applied env file makes the next release refuse. The site must already run a build that has the notes routes.
3. **Check from the Mac** (first prints `404`, second `{"week":"…","stored":true}`):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X PUT "https://review.jim-greco.com/api/notes/claude-code?week=2026-11-02"
   printf -- '- Test note, replaced on Sunday.\n' > /tmp/note.md
   REVIEW_SITE_URL=https://review.jim-greco.com node ~/code/weekly-review/src/cli.js post-notes --week 2026-11-02 --file /tmp/note.md; rm /tmp/note.md
   ```
4. **Scheduled task:** in Claude Desktop → Scheduled → New task, weekly on Sunday at 5:30 pm, working folder `~/code/weekly-review`, prompt "Follow routine/CLAUDE_CODE_SUMMARY.md in ~/code/weekly-review exactly." Allow Bash, Read and Write. Run it once now and check the report says the post worked; the next cloud review then shows `notes=ok` and a `## Beyond the apps` section.

The cloud routine needs nothing new: it reads notes with the ingest token, which is already its network secret for the site.

## 5. Summaries page (Google sign-in, optional)

`https://review.jim-greco.com/summaries` shows the stored Claude Code summaries to allow-listed Google accounts. It needs a public OAuth client ID and an allow-list; no new secret (the cookie key is derived from `LINK_SECRET`). The site must already run a build that has the `/summaries` routes; until both values are set they are a 404.

1. **OAuth consent screen** (Google Cloud Console, any project you own, e.g. a new one named "Weekly Review"): APIs & Services → OAuth consent screen (in the newer console: Google Auth Platform → Branding / Audience).
   - User type **External**.
   - App name **Weekly Review**; user support email and developer contact `jgreco@gmail.com`.
   - Scopes: none to add (sign-in only uses `openid`, `email`, `profile`).
   - Publishing status **Testing**, with test user `jgreco@gmail.com`. That's enough: no verification is needed for these scopes, and only test users can sign in.
2. **Client ID:** APIs & Services → Credentials → Create credentials → OAuth client ID.
   - Application type **Web application**, name "Weekly Review summaries".
   - Authorized JavaScript origins: `https://review.jim-greco.com`.
   - Authorized redirect URIs: `https://review.jim-greco.com/summaries/auth`.
   - Create, and copy the **Client ID** (`….apps.googleusercontent.com`). The client secret isn't used; don't put it anywhere.
3. **Site:** over the pinned SSH connection, under `~/deploy/.app-release.lock`, add to `~/deploy/weekly-review.env` (mode 600):

   ```
   GOOGLE_CLIENT_ID=<the client ID>
   SUMMARIES_ALLOWED_EMAILS=jgreco@gmail.com
   ```

   Then recreate `weekly-review` straight away with the running container's recorded Compose chain, exactly as in §4 step 2 (`docker-compose -f <each recorded file> --profile weekly-review up -d --no-deps weekly-review`), so the next release's drift check doesn't refuse.
4. **Check:** open `https://review.jim-greco.com/summaries` on the phone and on the Mac. It redirects to the sign-in page; sign in with `jgreco@gmail.com` and the list of weeks appears. Another Google account gets "This account can't view summaries." Sign out clears the session.

## 6. Reminders for accepted commitments (Task Sidekick, optional)

Accepted commitments become reminders on the iPhone, and their check-offs come back for scoring (`src/tasks.js`). The site calls Task Sidekick; the cloud routines need no change.

1. **Task Sidekick first:** follow `deploy/RUNBOOK.md` §7 in `jimgreco/reminders-ai` (migration, token, its two variables). It makes `~/wr-tokens/tasks-commitments.token`.
2. **Site:** over the pinned SSH connection, under `~/deploy/.app-release.lock`, add to `~/deploy/weekly-review.env` (mode 600), without printing the token:

   ```
   TASKS_API_URL=https://tasks.jim-greco.com
   TASKS_COMMITMENTS_TOKEN=<contents of tasks-commitments.token>
   ```

   Then recreate `weekly-review` with the running container's recorded Compose chain, exactly as in §4 step 2.
3. **Check:** on `/home`, accept one of the week's commitments, then open Task Sidekick on the iPhone (version with "Weekly Commitments" support). The reminder appears in the "Weekly Commitments" list, due Sunday. Un-accept it with **Change** and it goes away on the next sync. `docker logs` for `weekly-review` shows a `[tasks]` line only when a send fails.

## Rotating or revoking

- **Task Sidekick link:** make a new token (reminders-ai `deploy/RUNBOOK.md` §7), replace `COMMITMENTS_TOKEN_SHA256` there and `TASKS_COMMITMENTS_TOKEN` in `weekly-review.env`, and recreate both containers. Clearing either of the site's two variables turns the link off; reminders already made stay in Reminders.
- **One app:** replace its `~/deploy/weekly-summary-<service>.yml` hash (then recreate that service with its recorded files) and its network secret in the cloud environment. Clearing the variable turns that app's endpoint off; the review then shows the app as unavailable.
- **Ingest:** replace `INGEST_TOKEN_SHA256` in `weekly-review.env` and recreate the container.
- **Midweek and monthly routines:** two more cloud routines in the weekly routine's environment, with no connectors: "Midweek Pulse" (Wednesday 12:47 pm America/New_York, prompt "Follow routine/MIDWEEK.md in this repository exactly.") and "Monthly Review" (1st of the month 5:46 pm, prompt "Follow routine/MONTHLY.md in this repository exactly."). To stop either, disable its routine. Posts are stored under `weekly-review-data/posts/<kind>/<key>.json`; delete a file to withdraw one.
- **Decision register:** `weekly-review-data/decisions.json`, written only from the Mac with the notes token (`node src/cli.js decisions push`). It needs `NOTES_TOKEN_SHA256` set (§4); without it the register can't be written and no briefs are produced.
- **Home and decisions pages:** `/home` and `/decisions` use the `/summaries` sign-in (§5) and need nothing else: same OAuth client, same redirect URI, same allow-list. Removing an address from `SUMMARIES_ALLOWED_EMAILS` locks it out of all three.
- **Commitments:** need no configuration. They are stored under `weekly-review-data/commitments/<monday>.json` (the week they are for), on the same volume as reviews and notes. To withdraw a week's proposals, delete its file; to stop the loop, remove steps 5 and `--commitments` from `routine/WEEKLY_REVIEW.md`.
- **Notes:** write a new `~/.config/weekly-review/notes.token`, replace `NOTES_TOKEN_SHA256` in `weekly-review.env` and recreate the container with its recorded files. Removing the variable turns notes posting off; stored notes stay under `weekly-review-data/notes` until deleted. To stop the summary, also turn off the Desktop task.
- **Summaries page:** remove an address from `SUMMARIES_ALLOWED_EMAILS` (ends its session at once) or clear either variable (page off), then recreate the container. Rotating `LINK_SECRET` signs everyone out but also breaks every emailed review link. To stop Google sign-in entirely, also delete the OAuth client in the Cloud Console.

## Rollback

```bash
docker-compose --profile weekly-review stop weekly-review
docker-compose --profile weekly-review rm -f weekly-review
```

This touches nothing else. Turn off the routine at claude.ai/code/routines.
