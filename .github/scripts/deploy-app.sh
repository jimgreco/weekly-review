#!/usr/bin/env bash
# Run on the host by the CI workflow on every push to main, over the pinned
# SSH connection: `bash -s -- <40-char sha> < deploy-app.sh`.
# Replaces only the weekly-review container with the exact-commit image and
# keeps every other Compose setting as it is live. No credentials are sent.
set -euo pipefail

release_build="${1:-}"
[[ "$release_build" =~ ^[0-9a-f]{40}$ ]] || { echo 'Exact release SHA required.'; exit 1; }
release_image="ghcr.io/jimgreco/weekly-review:$release_build"
service=weekly-review

# All shared-host app coordinators use this same lock.
exec 9>"$HOME/deploy/.app-release.lock"
flock -w 600 9 || { echo 'Another app release holds the shared-host lock.'; exit 1; }

running=()
while IFS= read -r id; do [ -n "$id" ] && running+=("$id"); done < <(
  docker ps -q --filter label=com.docker.compose.project=deploy --filter "label=com.docker.compose.service=$service")
if [ "${#running[@]}" -eq 0 ]; then
  # First activation is the owner's reviewed step (deploy/RUNBOOK.md §2).
  echo "weekly-review is not running yet; nothing to deploy. Image $release_image is published."
  exit 0
fi
[ "${#running[@]}" -eq 1 ] || { echo 'Expected exactly one running weekly-review container.'; exit 1; }

container="$(docker inspect --format '{{.Id}}' "${running[0]}")"
inspect() { docker inspect --format "$1" "$container"; }
previous_image="$(inspect '{{.Config.Image}}')"
previous_hash="$(inspect '{{index .Config.Labels "com.docker.compose.config-hash"}}')"
project="$(inspect '{{index .Config.Labels "com.docker.compose.project"}}')"
working_directory="$(inspect '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
config_files="$(inspect '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
[ "$project" = deploy ] && [ -n "$working_directory" ] && [ -n "$config_files" ] || {
  echo 'Running container is missing its Compose labels.'; exit 1; }

compose_args=(-p "$project" --project-directory "$working_directory" --profile "$service")
IFS=, read -r -a files <<< "$config_files"
for config in "${files[@]}"; do
  [ -f "$config" ] || { echo 'A Compose file recorded by the running container is missing.'; exit 1; }
  compose_args+=(-f "$config")
done
compose() { docker-compose "${compose_args[@]}" "$@"; }

# Drift check: with the live image, the configured service must hash exactly
# like the running one. Anything else was changed by hand and needs reconciling.
export WEEKLY_REVIEW_IMAGE="$previous_image"
reconstructed_hash="$(compose config --hash "$service" | awk -v s="$service" '$1 == s {print $2}')"
[ -n "$previous_hash" ] && [ "$reconstructed_hash" = "$previous_hash" ] || {
  echo 'Configured weekly-review differs from the running container; reconcile before release.'; exit 1; }

if [ "$previous_image" = "$release_image" ]; then
  echo "weekly-review already runs $release_build."
  exit 0
fi

healthy() {
  for _ in $(seq 1 30); do
    if compose exec -T "$service" node -e '
      fetch("http://127.0.0.1:8790/health").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));' </dev/null 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

export WEEKLY_REVIEW_IMAGE="$release_image"
compose pull -q "$service"
compose up -d --force-recreate --no-deps --no-build "$service"
current="$(compose ps -q "$service")"
if [ "$(docker inspect --format '{{.Config.Image}}' "$current")" = "$release_image" ] && healthy; then
  echo "weekly-review is healthy at $release_build (previous: $previous_image)."
  exit 0
fi

echo 'weekly-review failed its health check; rolling back to the previous image.'
export WEEKLY_REVIEW_IMAGE="$previous_image"
compose up -d --force-recreate --no-deps --no-build "$service"
healthy && echo 'Rolled back; previous image is healthy.' || echo 'Rollback also failed its health check.'
exit 1
