#!/usr/bin/env sh
# Updates a running instance: backup, new code, new images, migrations, restart.
# Pass --build to build the images from the checked-out source instead of
# pulling the published ones. Stops at the first step that fails.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

build=false
for arg in "$@"; do
    case "$arg" in
        --build) build=true ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Usage: sh scripts/update.sh [--build]" >&2
            exit 1
            ;;
    esac
done

# Keep whichever services are running now: an instance started without Caddy
# (make local, or behind another reverse proxy) stays without it.
scale=""
if [ -z "$(docker compose ps --quiet caddy 2>/dev/null)" ]; then
    scale="--scale caddy=0"
fi

echo "==> 1/5 Database backup"
sh "$ROOT_DIR/scripts/backup.sh"

echo "==> 2/5 Fetch the new version"
git pull --ff-only

echo "==> 3/5 Get the images"
docker compose config --quiet
if [ "$build" = true ]; then
    docker compose build
else
    docker compose pull
fi

echo "==> 4/5 Apply database migrations"
docker compose up --no-deps --force-recreate --abort-on-container-exit \
    --exit-code-from control-center-migrate control-center-migrate

echo "==> 5/5 Restart the services"
# shellcheck disable=SC2086
docker compose up -d --no-build --pull never $scale

docker compose ps --all
echo "Update finished. Compare .env.example with your .env for new settings."
