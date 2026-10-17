#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${1:-$EXTENSION_DIR/dist/safari-ios-project}"

if [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [project-directory]" >&2
  exit 1
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "Xcode with the iOS SDK is required to package the Safari preview." >&2
  exit 1
fi
if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  PACKAGER=safari-web-extension-packager
elif xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  PACKAGER=safari-web-extension-converter
else
  echo "Safari extension packager unavailable. Install full Xcode and select it with xcode-select." >&2
  exit 1
fi
if [[ -e "$PROJECT_DIR" ]]; then
  echo "Project directory already exists. Choose a new directory to preserve signing settings and local edits." >&2
  exit 1
fi

bash "$SCRIPT_DIR/build-packages.sh" --safari-preview
xcrun "$PACKAGER" "$EXTENSION_DIR/dist/safari" \
  --project-location "$PROJECT_DIR" \
  --app-name "Vintrack Mobile" \
  --bundle-identifier dev.jakobaio.vintrack.mobile \
  --swift --ios-only --copy-resources --no-open --no-prompt

echo "Created iOS project: $PROJECT_DIR"
echo "Open it in Xcode, select your signing team, and run on an iPhone with iOS 18 or newer."
