#!/usr/bin/env sh
# Grants the admin role to an account on this instance. New accounts, including
# the first one, start with the free role and there is no default admin.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"
target="${1:-}"

run_sql() {
    docker compose exec -T postgres psql -U vinuser -d vintrack -v ON_ERROR_STOP=1 "$@"
}

if ! run_sql -Atc 'SELECT 1' >/dev/null 2>&1; then
    echo "The database is not reachable. Start Vintrack first (make up or make local)." >&2
    exit 1
fi

if [ -z "$target" ]; then
    count="$(run_sql -Atc 'SELECT COUNT(*) FROM "User"')"
    if [ "$count" = "0" ]; then
        echo "No account exists yet. Sign in once in the browser, then run make admin again." >&2
        exit 1
    fi
    if [ "$count" != "1" ]; then
        echo "Several accounts exist. Choose one:"
        echo
        run_sql -c 'SELECT id, name, email, role FROM "User" ORDER BY "createdAt"'
        echo "Then run:  make admin ACCOUNT=<id or email>"
        exit 1
    fi
    target="$(run_sql -Atc 'SELECT id FROM "User"')"
fi

# The account is passed as a psql variable and quoted by psql, never spliced
# into the statement.
result="$(run_sql -qAt -F ' | ' -v target="$target" <<'SQL'
UPDATE "User"
SET role = 'admin'
WHERE id = :'target' OR email = :'target'
RETURNING COALESCE(name, '(no name)'), COALESCE(email, '(no email)'), role;
SQL
)"

if [ -z "$result" ]; then
    echo "No account matches \"$target\". Run make admin without ACCOUNT to list accounts." >&2
    exit 1
fi

echo "Admin role granted:"
echo "  $result"
echo "Reload the dashboard, or sign out and back in, to see the Admin menu."
