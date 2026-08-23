# Vintrack Browser Sync Extension

Browser extension for automatic Vintrack/Vinted session sync. Chrome and
Firefox use the same source and must always carry the same manifest version.

The popup also provides a Vintrack companion with linked-account status, recent
monitor finds, and Price Watch controls. Inline Vinted actions are enabled by
default. New installations show native Vintrack buttons on catalog and item
pages; users who explicitly select popup-only mode keep that preference.
Buttons open an isolated companion drawer. `Option + Shift + V` toggles it on
Apple devices and `Alt + Shift + V` on other platforms. Context actions can
copy a server-normalized clean Vinted link. The platform-aware shortcut is shown
in the Companion footer and in the Vintrack header button tooltip.
While the Feed tab is open, recent finds refresh every 12 seconds. Monitor and
Price Watch handoffs still require a separate confirmation in the Vintrack
form.

## Public downloads

- Chrome ZIP: <https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip>
- Firefox Add-ons: <https://addons.mozilla.org/firefox/addon/vintrack-browser-sync/>

The Firefox listing URL can be overridden for deployments with
`BROWSER_EXTENSION_FIREFOX_URL`. GitHub releases intentionally do not contain
an unsigned `.xpi`: Firefox Stable and Beta reject unsigned add-ons, while AMO
handles signing, review, installation, and updates for the public build.

## Build and validate

```sh
node apps/vintrack-browser-sync-extension/scripts/validate-extension.mjs
apps/vintrack-browser-sync-extension/scripts/build-packages.sh
npx --yes web-ext@10 lint \
  --source-dir apps/vintrack-browser-sync-extension/dist/firefox
```

The build writes:

- `dist/vintrack-browser-sync-extension.zip`, the Chrome/Chromium release asset;
- `dist/chrome`, the unpacked Chrome build;
- `dist/chrome-development`, the unpacked localhost development build; and
- `dist/firefox`, the unsigned Firefox source directory used by `web-ext` and AMO.

## Install in Chrome

1. Download and unzip `vintrack-browser-sync-extension.zip`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted extension folder.
6. Open Vintrack, go to **Account**, and click **Link With Installed Extension**.

For local development on `http://localhost:3000`, run the build script and
select `apps/vintrack-browser-sync-extension/dist/chrome-development` in step 5. The public ZIP intentionally cannot connect to localhost.

## Install in Firefox

Public users install the signed extension from the AMO listing. This works in
Firefox Stable and Developer Edition and remains installed after a restart.

For local development only:

1. Run `apps/vintrack-browser-sync-extension/scripts/build-packages.sh`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on**.
4. Select `apps/vintrack-browser-sync-extension/dist/firefox/manifest.json`.

Temporary extensions are removed by Firefox on restart by design.

## Publish to AMO

1. Create an AMO developer account and API credentials.
2. Add the JWT issuer and secret as GitHub Actions secrets named
   `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.
3. Confirm the listing metadata in `amo-metadata.json` and the public
   [privacy policy](../../docs/browser-extension-privacy.md). Add that policy to
   the AMO listing's privacy-policy field during the initial developer setup.
4. Bump both manifests to the same new version and run the normal
   **Prepare Release** workflow.

When the prepared release PR is merged, **Release and Deploy** compares the
manifest version with marker tags such as `extension-v0.2`. A missing tag
causes the workflow to validate and lint the extension, submit the listed build
with `web-ext sign --channel=listed --approval-timeout=0`, and create the marker
tag after AMO accepts the upload and validation. AMO review then continues
asynchronously and never blocks the production deployment. An unchanged
extension version is skipped. After AMO approves the first version, set
`BROWSER_EXTENSION_FIREFOX_URL` to the final listing URL if it differs from the
configured slug.

## Data disclosure

The extension transmits the Vinted web access token, selected Vinted domain,
and Vinted account ID/display name needed for account-mismatch protection. On
Firefox, the browser user-agent is transmitted only with the optional technical
data permission. When the companion is opened on a supported Vinted page, that
page URL is sent to Vintrack to identify an existing monitor or Price Watch and
to build a sanitized form handoff. Vintrack account status, recent monitor
finds, and Price Watches are returned only after authenticating the stored
browser-link token. The theme and inline-mode preference are stored locally.

It does not transmit the complete cookie jar, browser refresh token, Vinted
password, or payment-card data. See the
[extension privacy policy](../../docs/browser-extension-privacy.md).
