# Turning on Weekly Review

There are three parts, all done by the owner:

1. Each app's weekly-summary endpoint.
2. The review site on the shared EC2 host.
3. The cloud routine.

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

## Rotating or revoking

- **One app:** replace its `~/deploy/weekly-summary-<service>.yml` hash (then recreate that service with its recorded files) and its network secret in the cloud environment. Clearing the variable turns that app's endpoint off; the review then shows the app as unavailable.
- **Ingest:** replace `INGEST_TOKEN_SHA256` in `weekly-review.env` and recreate the container.

## Rollback

```bash
docker-compose --profile weekly-review stop weekly-review
docker-compose --profile weekly-review rm -f weekly-review
```

This touches nothing else. Turn off the routine at claude.ai/code/routines.
