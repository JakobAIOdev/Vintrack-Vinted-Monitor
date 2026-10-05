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

## Automatic session refresh

Session maintenance never opens, focuses, navigates, or reloads a Vinted tab.
It reuses the most recent matching tab's page bridge when available, otherwise
it makes a bounded background request using the browser-managed default cookie
store and Vinted's existing CSRF/refresh endpoint. Refresh cookies stay in the
browser and are never read or sent to Vintrack.

A one-minute alarm checks token expiry, with a two-minute refresh margin.
Successful syncs of an unchanged token are reused for up to ten minutes to avoid
repeated server validation. Concurrent alarms, cookie changes and tab events
share a serialized lifecycle. Retry state is stored per regional domain and
cookie store, including a lease for interrupted service-worker requests.
Temporary failures back off from one minute to one hour; login/security failures
wait six hours and appear in the companion. An explicit sync can retry a login
failure immediately; rate limits always honor `Retry-After`.

Firefox containers and private windows use an existing matching tab only; their
cookies are never copied into the default store. If that context is closed, or
Vinted requires login/security interaction, the companion asks the user to open
Vinted and sync again. Browser sleep, cookie privacy settings, or an upstream
security challenge can prevent silent renewal. Updating the extension does not
unlink an existing account, but the browser must be running to maintain it.

## Public downloads

- Chrome ZIP: <https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip>
- Firefox Add-ons: <https://addons.mozilla.org/firefox/addon/vintrack-browser-sync/>

The Firefox listing URL can be overridden for deployments with
`BROWSER_EXTENSION_FIREFOX_URL`. GitHub releases intentionally do not contain
an unsigned `.xpi`: Firefox Stable and Beta reject unsigned add-ons, while AMO
handles signing, review, installation, and updates for the public build.

## Checkout handoff

Version 0.2.6 advertises checkout preparation protocol 5 to Vintrack. The
dashboard's Open Checkout action verifies that the Vinted browser account
matches the linked account, applies the delivery/payment preferences selected
in Vintrack Account, and opens its checkout page. Home delivery and available
PayPal are preselected; Vinted applies wallet funds automatically. Normal
Oneclick never submits checkout/payment or confirms the purchase. Missing or unavailable
delivery/payment choices remain for the user on Vinted. Home delivery with
confirmed selections has been tested on the DE site; wallet-only readiness and
mobile/in-app browser handoff have not been live verified.

Vintrack Account shows payment presets for the linked regional domain: PayPal
in DE/AT/BE, Tink and Klarna in DE, Bancontact in BE, iDEAL/Wero in NL, and
BLIK/Przelewy24 in PL, plus Wallet, a saved card, Google Pay and the saved
Vinted payment choice. Apple Pay is not offered for this web flow.
New provider choices require this extension version; protocol 2 still works
for the original Wallet/PayPal/saved-choice preferences.

The page bridge takes provider values from the actual checkout's offered
methods. Disabled or unrecognized options remain for review; there is no
automatic substitution. A card requires either Vinted's selected saved card
or exactly one saved card. Ambiguous cards/provider variants are left for
the user. Normal preparation still ends before checkout/payment. Other than PayPal,
new provider preselection has synthetic coverage, not a live regional test.

Preparation uses HTTP requests in an existing same-region Vinted tab without
loading the product page first. A new attempt verifies identity once in the
page bridge, before any POST; reopening a cached link verifies identity in the
background. Delivery and PayPal are combined into one update when the build
response offers PayPal. An already selected PayPal method needs no extra update.
The final checkout page is then opened for the user's payment confirmation.
When no Vinted tab exists, one must be opened to obtain the browser context.

The server-only TLS flow was tested on the explicitly authorized DE account and
item on 2026-10-05. Vinted returned a security check (HTTP 409 from Vintrack),
so it is not a verified browser-free replacement for this session. No retry or
security-check workaround was performed.

Concurrent clicks share one attempt. A local checkpoint survives worker restarts
and prevents replay for ten minutes after an uncertain result. Checkouts are
never automatically retried on another regional domain. Older extensions use
the service handoff instead of the new browser protocol. The Companion does
not expose a purchase action.

### Optional PayPal auto-checkout

Account settings can explicitly enable auto-checkout for PayPal in DE/AT/BE
after accepting the payment warning and setting a maximum EUR order total,
including shipping and fees. It remains off by default. Dashboard and
notification buy-link clicks use the same flow; monitor matches do not buy
anything without a click. Protocol 5 is required for extension auto-checkout.

Before consuming the server payment-intent claim, protocol 5 checks the local
Vinted receiver without account or checkout requests. Existing complete tabs
are probed concurrently with a 750 ms bound; disconnected receivers fail with
a reload instruction instead of a 20-second polling loop. A ready same-region
tab is preferred over a disconnected one. Browser authorization reads the
linked session and Redis claim only, without a server-side Vinted warmup or
refresh. History saving does not hold the completed dashboard handoff open.
Runtime failures retain their request ID so Vintrack can display them immediately
instead of waiting for the 90-second response timeout. Reload existing Vintrack
and Vinted pages after reloading the development extension.

The latest checkout response must confirm the delivery choice, enabled PayPal,
a fresh checksum, a positive EUR total within the limit, and no applied wallet
funds or currency conversion. Missing or ambiguous fields leave native checkout
for review. One additional payment request is sent, without following redirects
inside that request, refresh, retry or payment polling. Only Vinted's verified
PayPal redirect action is opened; other results ask the user to check Vinted.
An external confirmation window and item reservation are not guaranteed.

A shared server claim prevents another automatic attempt for the same member,
Vinted identity, domain and item, including after extension restarts, relinking
or preparation-cache expiry. It has no expiry while Redis retains its data.
Local auto-checkout attempts are retained too. PayPal URLs may contain payment
tokens: they are used only for immediate navigation, never stored in checkout
history, Redis preparation records or extension attempt records.

The live DE test on 2026-10-05 confirmed PayPal selection and the displayed EUR
total but stopped before payment. Payment requests and redirects have synthetic
coverage; live upstream acceptance of the new payment request remains unverified.
See [PayPal auto-checkout evidence and limits](../../docs/checkout-auto-paypal.md).

## Build and validate

```sh
node apps/vintrack-browser-sync-extension/scripts/validate-extension.mjs
# Validation also runs the synthetic session lifecycle regression tests.
apps/vintrack-browser-sync-extension/scripts/build-packages.sh
npx --yes web-ext@10 lint \
  --source-dir apps/vintrack-browser-sync-extension/dist/firefox
```

The build writes:

- `dist/vintrack-browser-sync-extension.zip`, the Chrome/Chromium release asset;
- `dist/chrome`, the unpacked Chrome build;
- `dist/chrome-development`, the unpacked localhost development build; and
- `dist/firefox`, the unsigned Firefox source directory used by `web-ext` and AMO.

## Native browser validation

After building the packages, run the production extension in disposable browser
profiles against an isolated HTTPS fixture:

```sh
# Requires control-center dependencies and Playwright's Chromium.
node apps/vintrack-browser-sync-extension/scripts/test-browser-session-refresh.mjs --browser=chromium

# Run Chromium and installed Firefox; web-ext supplies the Firefox debugger.
npx --yes --package=web-ext@10.7.0 -c 'node apps/vintrack-browser-sync-extension/scripts/test-browser-session-refresh.mjs'
```

The runner uses actual extension background APIs, scheduled alarms, and browser-managed
HttpOnly/SameSite cookies. It verifies automatic renewal, cookie rotation, CSRF from current
Next.js Flight markup, concurrency, 401 handling, 429 cooldowns, unchanged-token
failure, and an existing tab's real content/page bridge. Chromium also restarts
its browser/worker to verify persisted cooldowns. Firefox additionally verifies
open and closed container isolation.

All test traffic is restricted by a local proxy to a local HTTPS server; no
personal profile or real Vinted/Vintrack credentials are used. A generated test
CA is trusted only inside the temporary Firefox profile. Profiles, certificates,
and servers are removed after the run. Chromium's certificate exception applies
only to its disposable test process.

`VINTRACK_FIREFOX_BINARY` overrides the default macOS Firefox path.
`VINTRACK_WEB_EXT_DIR` can point to an installed web-ext package when its
executable is not on PATH. These tests prove browser integration with the fixture;
a signed-in Vinted account is still required to validate upstream acceptance of
a live refresh.

## Manual live verification

Load a built extension in a signed-in browser, ensure only that Vintrack extension
is enabled, and link the intended account through Vintrack. Reload any Vinted or
Vintrack pages that were already open before installing the build.

In Chrome, open the extension's service-worker console from `chrome://extensions`.
In Firefox, inspect the temporary add-on from `about:debugging#/runtime/this-firefox`.
With exactly one session linked, run:

```js
void (async () => {
  const { vintrackSyncedSessions: sessions = [] } =
    await extensionApi.storage.local.get("vintrackSyncedSessions");
  if (sessions.length !== 1) {
    throw new Error("Link exactly one session for this test.");
  }
  const refresh = await refreshVintedBrowserSessions(sessions, {
    bypassAutoRecoveryCooldown: true,
  });
  await persistSyncState(refresh);
  const sync = refresh.some((result) => result.ok)
    ? await syncAndPersistAllDomains()
    : [];
  const status = (results) => results.map(({ ok, status, reason, error }) =>
    ({ ok, status, reason, error }));
  console.log(JSON.stringify({ refresh: status(refresh), sync: status(sync) }, null, 2));
})().catch((error) => console.error(error.message));
```

First test with a matching Vinted tab open, then close all Vinted tabs and test
the default cookie store again. `refresh.ok: true` confirms a changed access token
that is not expiring soon; `sync.ok: true` confirms Vintrack accepted it. Neither
test should open, focus, navigate, or reload a Vinted tab. Containers and private
windows require their matching tab to remain open. A rate-limit cooldown still
applies to this explicit test.

To check normal maintenance, leave the browser running with Vinted tabs closed
until token expiry approaches. Dashboard browser-sync and validation timestamps
can also advance for ordinary syncs and do not independently prove token rotation.
The dashboard's current `Last refresh` field records service-side refreshes, while
`Browser refresh: not copied` means the refresh credential stays in the browser.

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
