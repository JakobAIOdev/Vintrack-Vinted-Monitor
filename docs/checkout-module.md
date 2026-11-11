# Set up Oneclick checkout

## Enable checkout

1. Install the [browser extension](browser-extension.md) and link your Vinted
   account in **Account**.
2. Under **Account → Oneclick checkout**, turn on **Enable checkout module**.
3. Read and accept the [checkout risk warning](checkout-risk-warning.md).
4. Choose delivery and payment preferences, then save them.

The module starts disabled. Your administrator's feature policies and an active
linked account are required. Preferences are bound to your linked account and
Vinted region.

Normal Oneclick prepares the Vinted checkout for your review. It stops before
payment. Review the final item, shipping, fees and payment method in Vinted.
Missing or unavailable choices require manual completion.

## Optional automatic payment

Automatic payment is a separate opt-in. Choose a supported
[saved card](checkout-auto-card.md) or [PayPal](checkout-auto-paypal.md), accept
its payment warning and save a maximum order total in an explicit currency.
The limit includes shipping and fees. A checkout click can then start a real
payment; new monitor matches alone do not buy anything.

See [payment methods](checkout-payment-regions.md) and
[pickup points and currencies](checkout-pickup-gbp.md) for available choices.

## Disable checkout

Turning the master switch off saves immediately and removes the saved automatic
payment opt-in. Delivery and payment preferences remain stored but inactive.
Turning checkout back on does not re-enable automatic payment.

While checkout is disabled, dashboard checkout buttons are unavailable and new
Discord/Telegram alerts omit the checkout link. Existing links also check the
current setting. The extension remains available for session sync and other
account tools.

Disabling checkout cannot cancel a request or payment already in progress.
Check Vinted for its outcome.

## Self-hosted setup

Run the standard migrations before starting updated services. Configure a public
dashboard URL for checkout links in alerts. Follow
[Getting Started](getting-started.md) and the [extension setup guide](browser-extension.md).
