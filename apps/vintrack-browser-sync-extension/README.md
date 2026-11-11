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
- **Show actions inside Vinted** controls the inline Vinted buttons.

If linking or sync fails, check your Vinted login, reload existing Vintrack and
Vinted pages, then use **Sync linked account now** under **Connection actions**.

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
token, Vinted password or payment-card data.

Read the [privacy policy](../../docs/browser-extension-privacy.md) for data use,
storage, deletion and contact information.
