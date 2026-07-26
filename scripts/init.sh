#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${VINTRACK_ENV_FILE:-$ROOT_DIR/.env}"
EXAMPLE_FILE="$ROOT_DIR/.env.example"
PROXY_FILE="${VINTRACK_PROXY_FILE:-$ROOT_DIR/apps/worker/proxies.txt}"
ENV_CREATED=false
GENERATED_KEYS=""

if [ ! -f "$EXAMPLE_FILE" ]; then
    echo "Missing environment template: $EXAMPLE_FILE" >&2
    exit 1
fi

if [ ! -e "$ENV_FILE" ]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    ENV_CREATED=true
    echo "Created ${ENV_FILE#"$ROOT_DIR/"} from .env.example."
elif [ ! -f "$ENV_FILE" ]; then
    echo "Environment path exists but is not a regular file: $ENV_FILE" >&2
    exit 1
else
    echo "Preserving existing ${ENV_FILE#"$ROOT_DIR/"}."
fi

read_value() {
    key="$1"
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

set_value() {
    key="$1"
    value="$2"
    temp_file="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
    awk -v key="$key" -v value="$value" '
        BEGIN { found = 0 }
        index($0, key "=") == 1 {
            print key "=" value
            found = 1
            next
        }
        { print }
        END {
            if (!found) {
                print key "=" value
            }
        }
    ' "$ENV_FILE" > "$temp_file"
    chmod 600 "$temp_file"
    mv "$temp_file" "$ENV_FILE"
}

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

if [ "$ENV_CREATED" = true ]; then
    echo "Next: add Discord OAuth or OIDC credentials to .env."
else
    echo "Review .env and confirm authentication and public URL settings."
fi

echo "Then run: docker compose up -d --build"
