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

## Request checkout and mobile buy links

Request checkout performs the Vinted checkout from Vintrack instead of your
browser, so a buy link in a Discord or Telegram alert also works on a phone. It
is available only as **Full checkout**: with automatic payment enabled, your
warning accepted and a maximum order total saved. Normal Oneclick keeps using
the browser extension.

1. Add a personal proxy group under **Proxies**. Request checkout uses its first
   entry for every step; prefer a dedicated proxy with a stable address.
2. In **Account**, use **Sync server checkout context** once and confirm the
   dialog.
3. Under **Checkout method**, select **Full checkout via my proxy** and your
   **Checkout proxy group**, then save with automatic payment off.
4. Enable **Full checkout** with a saved card or PayPal, accept the payment
   warning, set your maximum order total and save again.

Changing the method or the proxy group turns automatic payment off until you
enable it again. There is no fallback to the server's own address and no
automatic switch to another proxy or method.

On a phone, sign in to Vintrack once in the browser that opens the link. Apps
such as Discord and Telegram may open links in their own built-in browser, which
is signed out at first. Alerts need a public dashboard URL; a `localhost`
address only works on the computer running Vintrack.

### Checkout context

The context sync sends Vinted's `datadome`, `anon_id`, `_vinted_fr_session` and
`v_udt` cookies, the page's CSRF token and your browser's User-Agent to your
Vintrack instance, where they are stored encrypted with your linked session.
The browser refresh token and all other cookies stay in the browser.

After you allow it once, the extension sends the same context again whenever it
delivers a renewed Vinted session while a Vinted tab is open, so buy links keep
working after your browser renews its login. Turn this off with **Stop keeping
checkout context in sync** in Account. It also ends when you disconnect the
extension or switch account or region. See the
[extension privacy policy](browser-extension-privacy.md).

### What a buy link reports

A buy link shows its result on the Vintrack checkout page. It starts by itself
only when you open it directly, for example by tapping it in an alert. Reloading
the page, reopening it later, returning to it, or being sent to it by another
website never starts a purchase on its own; the page shows a **Buy now** button
instead.

- **Pay with PayPal.** A PayPal payment was started and needs your approval in
  PayPal. The page opens PayPal automatically; if your browser blocks that, use
  the button. Opening the same buy link again within about ten minutes shows the
  same PayPal link and never starts a second payment. After that, finish or
  cancel the payment in Vinted.
- **Continue in Vinted / Finish this checkout in Vinted.** Your bank asks for
  authentication, or Full checkout stopped before payment because the total is
  above your limit or delivery or payment could not be verified. The prepared
  checkout is waiting in Vinted.
- **Your proxy could not be used.** The message says whether the first proxy of
  your checkout proxy group could not be reached, rejected its username or
  password, or belongs to an unpaid plan. Nothing was sent to Vinted and the buy
  link can be used again once the proxy works.
- **Vinted asks this account to accept its updated terms and conditions.** Open
  Vinted, accept them there, then use the buy link again.
- **Vinted limited requests.** Request checkout pauses for one minute for all of
  your buy links. Nothing is sent to Vinted during that minute.
- **Vinted rejected this checkout request / requires a security check.** Request
  checkout stops for this session. Vintrack does not retry and does not try
  another proxy or method. Your browser may still work; you can select the
  browser extension method in Account.
- **The connection was interrupted while checkout was running.** A purchase may
  have been started. Check Vinted first; opening the buy link again shows the
  stored result.

When Vinted refused the very first request and created nothing, the same buy
link can be used again, at most twice per item within ten minutes. An attempt
that got further is never repeated automatically, and an uncertain payment is
never sent again.

### Local checkout agent

Instead of a proxy, you can run the experimental
[local checkout agent](local-checkout-agent.md) on your own computer. It
performs the same Full checkout from your own network while that computer is
running.

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

Request checkout and the local agent need the migrations
`20261019190000_durable_checkout_payment_attempts` and
`20261019200000_local_checkout_agent`; `vinted-service` keeps automatic payment
unavailable until the first one is applied. For development without a proxy, see
`CHECKOUT_DEV_DIRECT_CONNECTION` in [Configuration](configuration.md).
