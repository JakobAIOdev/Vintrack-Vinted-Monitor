#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${VINTRACK_ENV_FILE:-$ROOT_DIR/.env}"
EXAMPLE_FILE="$ROOT_DIR/.env.example"
PROXY_FILE="${VINTRACK_PROXY_FILE:-$ROOT_DIR/apps/worker/proxies.txt}"
GENERATED_KEYS=""

if [ ! -f "$EXAMPLE_FILE" ]; then
    echo "Missing environment template: $EXAMPLE_FILE" >&2
    exit 1
fi

if [ ! -e "$ENV_FILE" ]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "Created ${ENV_FILE#"$ROOT_DIR/"} from .env.example."
elif [ ! -f "$ENV_FILE" ]; then
    echo "Environment path exists but is not a regular file: $ENV_FILE" >&2
    exit 1
else
    echo "Preserving existing ${ENV_FILE#"$ROOT_DIR/"}."
fi

. "$ROOT_DIR/scripts/env-file.sh"

needs_generated_value() {
    value="$(read_value "$1")"
    case "$value" in
        ""|your_random_secret_here|your_random_session_encryption_key_here)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

for key in AUTH_SECRET VINTED_SESSION_ENCRYPTION_KEY; do
    if needs_generated_value "$key"; then
        if ! command -v openssl >/dev/null 2>&1; then
            echo "OpenSSL is required to generate $key." >&2
            echo "Install OpenSSL or set a secure value manually in $ENV_FILE." >&2
            exit 1
        fi
        set_value "$key" "$(openssl rand -base64 32)"
        GENERATED_KEYS="${GENERATED_KEYS}${GENERATED_KEYS:+, }$key"
    fi
done

# Telegram only accepts A-Z, a-z, 0-9, _ and - in a webhook secret, so this one
# is hex rather than base64. It is generated up front because the webhook
# rejects every update while the secret is empty.
if [ -z "$(read_value TELEGRAM_WEBHOOK_SECRET)" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
        echo "OpenSSL is required to generate TELEGRAM_WEBHOOK_SECRET." >&2
        exit 1
    fi
    set_value TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
    GENERATED_KEYS="${GENERATED_KEYS}${GENERATED_KEYS:+, }TELEGRAM_WEBHOOK_SECRET"
fi

chmod 600 "$ENV_FILE"

if [ ! -e "$PROXY_FILE" ]; then
    : > "$PROXY_FILE"
    chmod 600 "$PROXY_FILE"
    echo "Created ${PROXY_FILE#"$ROOT_DIR/"}."
elif [ ! -f "$PROXY_FILE" ]; then
    echo "Proxy path exists but is not a regular file: $PROXY_FILE" >&2
    exit 1
else
    echo "Preserving existing ${PROXY_FILE#"$ROOT_DIR/"}."
fi

if [ -n "$GENERATED_KEYS" ]; then
    echo "Generated: $GENERATED_KEYS."
fi

if [ "${VINTRACK_INIT_QUIET_NEXT_STEPS:-}" != "1" ]; then
    echo "Next: run 'make setup' to enter your URL and login provider,"
    echo "or edit .env by hand and start with 'make up' (public) or 'make local'."
fi
