# Shared helpers for reading and writing KEY=value lines in the Vintrack .env
# file. Source this file after setting ENV_FILE.

read_value() {
    key="$1"
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

# The value travels through the environment rather than `awk -v`, which would
# interpret backslash escapes inside it.
set_value() {
    key="$1"
    temp_file="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
    VINTRACK_ENV_VALUE="$2" awk -v key="$key" '
        BEGIN { found = 0; value = ENVIRON["VINTRACK_ENV_VALUE"] }
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
