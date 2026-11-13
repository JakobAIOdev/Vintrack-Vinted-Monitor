# Vintrack Browser Sync Extension

The extension links a Vinted account you control with Vintrack. It provides
session sync, a Companion with monitor finds and Price Watches, and optional
checkout preparation using your saved preferences.

For demo, localhost and self-hosted installations, follow the
[step-by-step setup guide](../../docs/browser-extension.md).

## Install in Chrome

1. Download and unzip `vintrack-browser-sync-extension.zip` from the release.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder.
4. Open **Vintrack → Account → Link With Installed Extension**.

The public package connects to `vintrack.jakobaio.dev`. For localhost or your
own domain, use the [matching build instructions](../../docs/browser-extension.md).

## Install in Firefox

Use the signed add-on from the AMO listing for a permanent installation.
For a temporary test installation:

1. Build the packages using the command below.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select `dist/firefox/manifest.json`.

Temporary add-ons are removed on browser restart. The public Firefox build
contains no localhost permissions.

## Use the Companion

Open the extension popup, or use **Alt + Shift + V** on Vinted
(**Option + Shift + V** on macOS) to open its drawer.

- **Overview** shows connection status and actions for the current Vinted search
  or item. Creation opens a prefilled Vintrack form for review.
- **Feed** shows recent monitor finds and updates while its tab is open.
- **Watches** lets you view and manage Price Watches.
- **On Vinted** switches the features below on or off and holds your keywords.
- **Show actions inside Vinted** controls everything Vintrack adds to Vinted
  pages.

If linking or sync fails, check your Vinted login, reload existing Vintrack and
Vinted pages, then use **Sync linked account now** under **Connection actions**.

## Inside Vinted

With **Show actions inside Vinted** on, the extension adds read-only context to
the Vinted pages you browse:

- **Vintrack badges** mark listings in any Vinted grid that one of your
  monitors found in the last seven days or that have a Price Watch, including
  the tracked price change or that the listing was sold.
- **Seen marker and price memory** dims listings you already opened and shows
  `↓ was …` when a listing is cheaper than at your last visit.
- **Listing insights** adds a panel below the Track price button on item pages
  with the monitor that found the listing, its Price Watch and the price change
  since your last look.
- **Live find toasts** announce new monitor finds while a Vinted tab is
  visible. Clicking one opens the listing.
- **Keywords** fade out or highlight listings whose title or brand contains one
  of your words.

These features send no requests to Vinted and never act on your account.
Monitor badges and toasts follow the Live Feed feature policy, Price Watch
badges the Price Watch policy.

## Optional checkout

Checkout starts disabled. Configure it under **Vintrack → Account → Oneclick
checkout**, read the warning and save your preferences. Normal Oneclick prepares
Vinted's checkout and stops before payment. Automatic payment requires a separate
opt-in, payment warning and maximum order total.

- [Checkout setup](../../docs/checkout-module.md)
- [Payment methods](../../docs/checkout-payment-regions.md)
- [Saved cards](../../docs/checkout-auto-card.md)
- [PayPal](../../docs/checkout-auto-paypal.md)
- [Pickup points and currencies](../../docs/checkout-pickup-gbp.md)
- [Checkout risk warning](../../docs/checkout-risk-warning.md)

### Checkout context for request checkout

**Sync server checkout context** in Account is optional and needs a separate
confirmation. It sends Vinted's `datadome`, `anon_id`, `_vinted_fr_session` and
`v_udt` cookies, the current page's CSRF token and the browser's User-Agent to
the connected Vintrack instance, which stores them encrypted with the linked
session. Without that confirmation, sync stays token-only.

After the confirmation the extension keeps the context in sync: it sends it
again each time it delivers a renewed Vinted access token, and on a manual
sync. This happens only while the stored consent matches the connected Vintrack
origin, the linked Vinted account and the region, only for the browser's
regular profile, and only when a Vinted tab of that region is already open. The
extension never opens or reloads a tab for it; if the context cannot be read,
the token-only sync runs instead.

The extension stores only the consent itself (version, Vintrack origin, Vinted
account ID, region and time), never the cookie or CSRF values. **Stop keeping
checkout context in sync** in Account ends it, as does connecting another
instance, clearing the extension, unlinking the account or changing account or
region. Refresh-token cookies are never sent.

## Build the packages

```sh
node apps/vintrack-browser-sync-extension/scripts/validate-extension.mjs
apps/vintrack-browser-sync-extension/scripts/build-packages.sh
```

The build produces the Chrome release ZIP, unpacked Chrome production and
localhost-development builds, and an unsigned Firefox source directory under
`dist/`. Chrome and Firefox must use the same manifest version. Keep
`BROWSER_EXTENSION_LATEST_VERSION` in `.env.example`, Compose and the dashboard
fallback aligned with that version.

## Publish to AMO

1. Create an AMO developer account and API credentials.
2. Configure GitHub Actions secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.
3. Review `amo-metadata.json` and configure the
   [privacy policy](../../docs/browser-extension-privacy.md) on the listing.
4. Bump both manifests together and run **Prepare Release**.

If the repository variable `BROWSER_EXTENSION_LATEST_VERSION` is set, it must
match the manifest version. The release workflow validates the package and
submits new extension versions to AMO. Review continues asynchronously.

## Privacy

The extension handles limited Vinted session information and account identity
for linking and account-mismatch protection. On supported Vinted pages, the
Companion sends the current page URL to Vintrack for context actions. Preferences
are stored locally. It does not upload the complete cookie jar, browser refresh
token, Vinted password or payment-card data. If you allow the optional checkout
context sync, four named Vinted cookies and the CSRF token are sent as described
under [Optional checkout](#optional-checkout).

Listing badges are matched in the browser against a snapshot of your own
Vintrack data, so the pages you view are not sent to Vintrack for them. The
seen history of up to 2,000 opened listings and your keyword lists stay in
extension storage and can be cleared from the **On Vinted** tab.

Read the [privacy policy](../../docs/browser-extension-privacy.md) for data use,
storage, deletion and contact information.
