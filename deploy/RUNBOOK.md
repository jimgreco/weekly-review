# Activating Weekly Review on the shared EC2 host

This runbook follows `consolidated-deploy`'s rules: GitHub never changes the server. Each step below is run by the owner over the existing pinned SSH connection (`ec2-user@` the host pinned in `~/.ssh/known_hosts`). Take the shared `~/deploy/.app-release.lock` for steps 3–5. Nothing here restarts other services, and no secret is printed.

Prerequisites:
- The consolidated-deploy PR adding the `weekly-review` service is merged.
- That main SHA has been staged with the repo's manual dispatch, and the active `docker-compose.yml` has been updated from it under its normal review.
- `ghcr.io/jimgreco/weekly-review:<sha>` exists. It's published by this repo's CI on push to `main`.

## 1. Check headroom

```bash
free -m; df -h /
```

The service is capped at 160 MB. Stop if available memory is under ~250 MB (the last audit saw ~342 MB) or if disk has less than 1 GB free.

## 2. Create the read-only database role

```bash
cd ~/deploy
umask 077
RO_PW="$(openssl rand -hex 24)"
docker exec -i shared_db psql -U admin -d postgres -v ro_password="'$RO_PW'" < /path/to/weekly-review/sql/readonly-role.sql
```

Copy `sql/readonly-role.sql` to the host first, for example with `scp`. The script can be re-run safely; re-running it rotates the password.

Verify the role, which should print one row and then a permission error:

```bash
docker exec -e PGPASSWORD="$RO_PW" shared_db psql -h 127.0.0.1 -U weekly_review_ro -d spending -Atc "SELECT count(*) FROM tags"
docker exec -e PGPASSWORD="$RO_PW" shared_db psql -h 127.0.0.1 -U weekly_review_ro -d spending -c "SET default_transaction_read_only=off" -c "DELETE FROM tags"
```

If `pg_hba.conf` rejects the new login, stop. Changing it is a separate, reviewed database change.

## 3. Write `~/deploy/weekly-review.env` (mode 600)

```bash
cd ~/deploy
umask 077
LINK_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
cat > weekly-review.env <<EOF
REVIEW_EMAIL=jgreco@gmail.com
REVIEW_TIMEZONE=America/New_York
REVIEW_SEND_DAY=0
REVIEW_SEND_HOUR=18
PUBLIC_URL=https://review.jim-greco.com
LINK_SECRET=$LINK_SECRET
MACROS_DATABASE_URL=postgresql://weekly_review_ro:$RO_PW@db:5432/macro_tracker
SPENDING_DATABASE_URL=postgresql://weekly_review_ro:$RO_PW@db:5432/spending
DAILY_DATABASE_URL=postgresql://weekly_review_ro:$RO_PW@db:5432/daily_checklist
PLANNER_DATABASE_URL=postgresql://weekly_review_ro:$RO_PW@db:5432/common_week
PGSSL=false
REVIEW_MODEL=claude-opus-5-5
REVIEW_EMAIL_FROM=Weekly Review <notifications@weekofus.com>
ANTHROPIC_API_KEY=
RESEND_API_KEY=
EOF
unset RO_PW LINK_SECRET
```

**Resend key.** The live Compose file does not pass `RESEND_API_KEY` to Week of Us, so there may be no planner key on the host to reuse. Check without printing it:

```bash
grep -l '^RESEND_API_KEY=.\+' ~/deploy/*.env ~/deploy/.env 2>/dev/null
```

If a file is listed, copy the line across:

```bash
grep '^RESEND_API_KEY=' <that file> | sed -i "s|^RESEND_API_KEY=.*|$(cat)|" weekly-review.env
```

If nothing is listed, paste a Resend key yourself with an editor. Its From domain must be verified in Resend.

Add `ANTHROPIC_API_KEY` with an editor. Leave it blank to send numbers only.

## 4. Data directory

The container runs as uid 1000 with a read-only root filesystem.

```bash
mkdir -p ~/deploy/weekly-review-data && sudo chown 1000:1000 ~/deploy/weekly-review-data && chmod 700 ~/deploy/weekly-review-data
```

## 5. Start only this service

```bash
cd ~/deploy
export WEEKLY_REVIEW_IMAGE=ghcr.io/jimgreco/weekly-review:<sha>
docker-compose --profile weekly-review pull weekly-review
docker-compose --profile weekly-review up -d --no-deps weekly-review
docker-compose --profile weekly-review ps weekly-review   # healthy within ~30s
```

Persist `WEEKLY_REVIEW_IMAGE=...` in `~/deploy/.env`, the same way `COMMON_WEEK_IMAGE` is kept, so a later `up` doesn't fall back to `:unconfigured`.

## 6. Public route

1. **DNS:** add an `A` record for `review.jim-greco.com` pointing to the host's public IP.
2. **Nginx Proxy Manager:** add a proxy host with these settings:
   - domain `review.jim-greco.com`
   - forward to `weekly-review`, port `8790`, scheme `http`
   - request a Let's Encrypt certificate and turn on Force SSL
3. **Check:** `curl -fsS https://review.jim-greco.com/health` should print `ok`.

## 7. First review

Build last week's review without emailing it, then print its private link:

```bash
docker-compose --profile weekly-review exec weekly-review node src/cli.js --no-send
docker-compose --profile weekly-review exec weekly-review node src/cli.js --link
```

Open the link and check the numbers against each app. Then send one:

```bash
docker-compose --profile weekly-review exec weekly-review node src/cli.js
```

After that, the scheduler sends every Sunday at 18:00 America/New_York.

## Rollback

```bash
docker-compose --profile weekly-review stop weekly-review
docker-compose --profile weekly-review rm -f weekly-review
```

This touches nothing else. To revoke database access:

```bash
docker exec -i shared_db psql -U admin -d postgres -c "ALTER ROLE weekly_review_ro NOLOGIN"
```
