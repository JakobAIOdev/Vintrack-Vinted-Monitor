#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
INCLUDE_DASHBOARD=false
SKIP_BUILD=false
START_SERVICES=true

for arg in "$@"; do
    case "$arg" in
        --dashboard)
            INCLUDE_DASHBOARD=true
            ;;
        --skip-build)
            SKIP_BUILD=true
            ;;
        --no-start-services)
            START_SERVICES=false
            ;;
        -h|--help)
            cat <<'EOF'
Usage: sh scripts/test-all.sh [--dashboard] [--skip-build] [--no-start-services]

Runs the fast local validation suite:
  - worker Go tests
  - vinted-service Go tests
  - control-center lint
  - control-center build, unless --skip-build is passed
  - control-center public Playwright e2e

Options:
  --dashboard          Also run the seeded /feed dashboard e2e test.
  --skip-build         Skip npm run build for faster iteration.
  --no-start-services  Do not auto-start Docker Postgres/Redis for --dashboard.
EOF
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Run with --help for usage." >&2
            exit 2
            ;;
    esac
done

run() {
    printf '\n==> %s\n' "$*"
    "$@"
}

run_in() {
    dir="$1"
    shift
    printf '\n==> (%s) %s\n' "$dir" "$*"
    (cd "$ROOT_DIR/$dir" && "$@")
}

cleanup_test_artifacts() {
    rm -rf \
        "$ROOT_DIR/apps/control-center/.next-e2e-3100" \
        "$ROOT_DIR/apps/control-center/.next-e2e-3101" \
        "$ROOT_DIR/apps/control-center/test-results" \
        "$ROOT_DIR/apps/control-center/playwright-report"
}

ensure_dashboard_services() {
    if [ "$START_SERVICES" = false ]; then
        return
    fi

    if ! command -v docker >/dev/null 2>&1; then
        echo "Docker is required for --dashboard unless services are already running." >&2
        echo "Install Docker or rerun with --no-start-services after starting Postgres manually." >&2
        exit 1
    fi

    run docker compose up -d postgres redis control-center-migrate
    run docker wait vintrack_migrate
}

trap cleanup_test_artifacts EXIT INT TERM
cleanup_test_artifacts

if [ "$INCLUDE_DASHBOARD" = true ]; then
    ensure_dashboard_services
fi

run node --test "$ROOT_DIR/scripts/config-check.test.mjs"
run_in apps/worker go test ./...
run_in apps/vinted-service go test ./...

run_in apps/control-center npm run test:unit
run_in apps/control-center npm run lint

if [ "$SKIP_BUILD" = false ]; then
    run_in apps/control-center npm run build
fi

run_in apps/control-center npm run test:e2e

if [ "$INCLUDE_DASHBOARD" = true ]; then
    run_in apps/control-center npm run test:e2e:dashboard
fi

printf '\nAll requested checks passed.\n'
