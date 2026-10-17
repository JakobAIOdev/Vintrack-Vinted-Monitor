#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$EXTENSION_DIR/dist"
CHROME_DIR="$DIST_DIR/chrome"
CHROME_DEVELOPMENT_DIR="$DIST_DIR/chrome-development"
FIREFOX_DIR="$DIST_DIR/firefox"
FIREFOX_ANDROID_DIR="$DIST_DIR/firefox-android"
SAFARI_DIR="$DIST_DIR/safari"
ANDROID_PREVIEW=false
SAFARI_PREVIEW=false

if [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [--android-preview|--safari-preview|--mobile-previews]" >&2
  exit 1
fi
case "${1:-}" in
  --android-preview) ANDROID_PREVIEW=true ;;
  --safari-preview) SAFARI_PREVIEW=true ;;
  --mobile-previews) ANDROID_PREVIEW=true; SAFARI_PREVIEW=true ;;
  "") ;;
  *) echo "Usage: $0 [--android-preview|--safari-preview|--mobile-previews]" >&2; exit 1 ;;
esac

COMMON_FILES=(
  background.js
  companion.css
  companion.js
  content-script.js
  page-bridge.js
  popup.html
  popup.js
)

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to build extension packages" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to build extension packages" >&2
  exit 1
fi

prepare_target() {
  local target_dir="$1"
  local manifest_file="$2"

  rm -rf "$target_dir"
  mkdir -p "$target_dir"

  for file in "${COMMON_FILES[@]}"; do
    cp "$EXTENSION_DIR/$file" "$target_dir/$file"
  done

  cp -R "$EXTENSION_DIR/icons" "$target_dir/icons"
  cp "$EXTENSION_DIR/$manifest_file" "$target_dir/manifest.json"
}

mkdir -p "$DIST_DIR"
prepare_target "$CHROME_DIR" manifest.json
prepare_target "$CHROME_DEVELOPMENT_DIR" manifest.json
prepare_target "$FIREFOX_DIR" manifest.firefox.json
node "$SCRIPT_DIR/create-development-manifest.mjs" \
  "$CHROME_DEVELOPMENT_DIR/manifest.json"
VALIDATION_ARGS=(--development-manifest "$CHROME_DEVELOPMENT_DIR/manifest.json")
if [[ "$ANDROID_PREVIEW" == true ]]; then
  prepare_target "$FIREFOX_ANDROID_DIR" manifest.firefox.json
  node "$SCRIPT_DIR/create-android-manifest.mjs" "$FIREFOX_ANDROID_DIR/manifest.json"
  VALIDATION_ARGS+=(--android-manifest "$FIREFOX_ANDROID_DIR/manifest.json")
fi
if [[ "$SAFARI_PREVIEW" == true ]]; then
  prepare_target "$SAFARI_DIR" manifest.firefox.json
  node "$SCRIPT_DIR/create-safari-manifest.mjs" "$SAFARI_DIR/manifest.json"
  VALIDATION_ARGS+=(--safari-manifest "$SAFARI_DIR/manifest.json")
fi
node "$SCRIPT_DIR/validate-extension.mjs" \
  "${VALIDATION_ARGS[@]}"

rm -f "$DIST_DIR/vintrack-browser-sync-extension.zip"

(
  cd "$CHROME_DIR"
  zip -qr "$DIST_DIR/vintrack-browser-sync-extension.zip" .
)

echo "Built:"
echo "  $DIST_DIR/vintrack-browser-sync-extension.zip"
echo "  $CHROME_DEVELOPMENT_DIR (unpacked localhost development build)"
echo "  $FIREFOX_DIR (unsigned AMO submission source)"
if [[ "$ANDROID_PREVIEW" == true ]]; then
  echo "  $FIREFOX_ANDROID_DIR (unsigned Android preview; device validation required)"
fi
if [[ "$SAFARI_PREVIEW" == true ]]; then
  echo "  $SAFARI_DIR (Safari preview source; Xcode packaging and device validation required)"
fi
