#!/usr/bin/env sh
# Guided first-time configuration: creates .env, generates the secrets, and asks
# for the two things only the operator knows — where the instance is reachable
# and which Discord application signs members in.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${VINTRACK_ENV_FILE:-$ROOT_DIR/.env}"

VINTRACK_INIT_QUIET_NEXT_STEPS=1 sh "$ROOT_DIR/scripts/init.sh"
. "$ROOT_DIR/scripts/env-file.sh"

if [ ! -t 0 ]; then
    echo "make setup asks questions and needs a terminal." >&2
    echo "Edit .env by hand instead; see docs/getting-started.md." >&2
    exit 1
fi

ask() {
    printf '%s' "$1" >&2
    IFS= read -r answer || answer=""
    printf '%s' "$answer"
}

ask_secret() {
    # Echo is switched off before the prompt appears, so nothing typed early
    # is shown.
    stty -echo 2>/dev/null || true
    printf '%s' "$1" >&2
    IFS= read -r answer || answer=""
    stty echo 2>/dev/null || true
    printf '\n' >&2
    printf '%s' "$answer"
}

echo
echo "Where will you open Vintrack?"
echo "  1) Only on this computer (http://localhost:3000)"
echo "  2) On a public domain with HTTPS"
current_url="$(read_value AUTH_URL)"
default_choice=1
case "$current_url" in
    https://*) default_choice=2 ;;
esac

while :; do
    choice="$(ask "Choose 1 or 2 [$default_choice]: ")"
    choice="${choice:-$default_choice}"
    case "$choice" in
        1)
            set_value AUTH_URL "http://localhost:3000"
            set_value VINTRACK_SITE_ADDRESS "http://localhost"
            start_command="make local"
            break
            ;;
        2)
            current_domain="${current_url#https://}"
            case "$current_url" in
                https://*) domain_hint=" [$current_domain]" ;;
                *) current_domain=""; domain_hint="" ;;
            esac
            while :; do
                domain="$(ask "Domain, for example vintrack.example.com$domain_hint: ")"
                domain="${domain:-$current_domain}"
                # Accept a pasted URL and keep the hostname only.
                domain="${domain#http://}"
                domain="${domain#https://}"
                domain="${domain%%/*}"
                domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"
                case "$domain" in
                    *[!a-z0-9.-]*|""|.*|*.|*..*|-*)
                        echo "That is not a hostname. Enter it without a path or port." >&2
                        ;;
                    *.*)
                        break
                        ;;
                    *)
                        echo "A public domain needs at least one dot." >&2
                        ;;
                esac
            done
            set_value AUTH_URL "https://$domain"
            set_value VINTRACK_SITE_ADDRESS "$domain"
            start_command="make up"
            break
            ;;
        *)
            echo "Enter 1 or 2." >&2
            ;;
    esac
done

auth_url="$(read_value AUTH_URL)"
login_note=""
if [ -n "$(read_value AUTH_OIDC_ISSUER)" ]; then
    echo
    echo "OIDC is configured in .env, so Discord login is not needed."
    callback="$auth_url/api/auth/callback/oidc"
else
    callback="$auth_url/api/auth/callback/discord"
    echo
    echo "Sign-in uses a Discord application:"
    echo "  https://discord.com/developers/applications -> New Application -> OAuth2"
    while :; do
        client_id="$(ask "Discord client ID (Enter to skip for now): ")"
        case "$client_id" in
            "")
                login_note="Add AUTH_DISCORD_ID and AUTH_DISCORD_SECRET to .env before starting."
                break
                ;;
            *[!0-9]*)
                echo "A Discord client ID contains digits only." >&2
                ;;
            *)
                client_secret="$(ask_secret "Discord client secret (hidden): ")"
                if [ -z "$client_secret" ]; then
                    echo "The client secret is empty." >&2
                    continue
                fi
                set_value AUTH_DISCORD_ID "$client_id"
                set_value AUTH_DISCORD_SECRET "$client_secret"
                break
                ;;
        esac
    done
fi

chmod 600 "$ENV_FILE"

echo
echo "Saved to .env. Remaining steps:"
echo "  1. Register this exact redirect URL with your login provider:"
echo "       $callback"
if [ -n "$login_note" ]; then
    echo "     $login_note"
fi
if [ "$start_command" = "make up" ]; then
    echo "  2. Point the domain's DNS at this server and open ports 80 and 443."
    echo "  3. Start Vintrack:  make up"
    echo "  4. Sign in once at $auth_url, then run:  make admin"
else
    echo "  2. Start Vintrack:  make local"
    echo "  3. Sign in once at $auth_url, then run:  make admin"
fi
