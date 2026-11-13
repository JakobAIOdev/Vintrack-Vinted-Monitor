# Vintrack Browser Sync Privacy Policy

Effective date: November 12, 2026

Vintrack Browser Sync links a Vinted account that the user is already signed in
to with the Vintrack service. The extension runs only on the public Vintrack
application and the explicitly supported Vinted regional domains.

## Data handled by the extension

When the user connects or refreshes a linked account, the extension sends these
values to the configured public Vintrack service:

- the Vinted `access_token_web` access token;
- the selected Vinted regional domain;
- the Vinted account ID and display name, used to prevent linking a different
  account by mistake; and
- the browser user-agent string, only when the Firefox user has granted the
  optional technical-data permission.

**Sync server checkout context** is a separate, optional action in Account.
Its confirmation names the configured Vintrack origin and the additional data:
Vinted's `datadome`, `anon_id`, `_vinted_fr_session` and `v_udt` cookies, the
page's CSRF token, and the browser user-agent. The extension checks that the
current Vinted page and access token identify the same account before sending
this context. Without this confirmation, token sync and automatic renewal do
not collect these cookies.

After the user confirms once, the extension keeps this context in sync. It
sends the same four cookies, the CSRF token and the user-agent again each time
it delivers a renewed Vinted access token to Vintrack, and when the user starts
a sync by hand. It does so only while the consent still matches the connected
Vintrack instance, the linked Vinted account and the Vinted region, only for
the browser's regular profile (not a private window or container), and only
when a Vinted tab of that region is already open to read the CSRF token. The
extension never opens or reloads a tab for this. If the context cannot be
read, or Vintrack does not accept it, the ordinary token-only sync runs
instead. On Firefox the optional technical-data permission is also required;
without it only the token is synced.

Vintrack stores the context encrypted with the linked session on the user's
Vintrack server. The extension stores only the consent itself: its version,
the Vintrack origin, the Vinted account ID, the regional domain and the time
it was given. Cookie and CSRF values are not written to extension storage,
response messages or checkout history.

The user stops this with **Stop keeping checkout context in sync** in Account.
The consent also ends when the extension is connected with another link or
Vintrack instance, when its local state is cleared or the extension is removed,
when the Vinted account is unlinked, and when the browser or the linked session
changes to another Vinted account or region. Stopping prevents further copies.
The context already stored stays with the encrypted linked session until a
later sync replaces it or the Vinted account is unlinked.

This context can help server checkout requests use an already linked session
without a running browser. It does not extend the session lifetime or guarantee
that Vinted will accept checkout. An expired or rejected session still needs
normal reauthentication. No browser refresh token, password, unrelated cookie
or payment-card data is included in this optional context.

When the user opens the companion on a supported Vinted catalog or item page,
the extension sends that active page URL to Vintrack. Vintrack validates the
regional Vinted domain, removes tracking and sensitive parameters, and uses the
remaining item ID or catalog filters only to show existing Vintrack state and
prepare a form handoff. No monitor or Price Watch is created by inspecting a
page.

After authenticating the locally stored browser-link token, Vintrack may return
the linked-account status, six recent monitor finds, and the user's Price Watch
list for display in the popup or inline drawer. The inline companion is enabled
by default on supported Vinted pages and can be disabled in the popup. Pausing,
resuming, and deleting a Price Watch requires a deliberate click; deletion also
requires confirmation. Recent finds refresh every 12 seconds only while the
Feed tab is open.

Inline mode can also add Vintrack context to supported Vinted pages: badges on
listings, an insights panel on item pages, and toasts for new monitor finds.
For this, Vintrack returns a snapshot of the user's own data after
authenticating the browser-link token: the IDs of listings their monitors
found in the last seven days with the monitor name, and their Price Watches
with status and prices. The extension requests it at most once a minute while
a Vinted page with listings is visible and compares listings with it inside
the browser. The pages and listings a user views are not sent to Vintrack for
these badges. While toasts are enabled and a Vinted tab is visible, recent
monitor finds are requested about every 20 seconds. These features only read
the page that is already open; they send no requests to Vinted.

To mark listings as seen and show a price change since the last visit, the
extension stores the IDs of up to 2,000 opened Vinted listings together with
the first and last visit time and the price shown on the page. This history,
the user's fade and highlight keywords, and the per-feature switches stay in
local extension storage and are never transmitted. The history can be deleted
with **Clear seen history** in the companion's On Vinted tab; clearing
extension state or removing the extension deletes all of it.

The extension stores the Vintrack light or dark theme locally and mirrors that
preference between the approved Vintrack page and supported Vinted pages. It
also stores a random, revocable Vintrack browser-link token and local sync state
required to maintain the connection, plus the user's popup-only or inline
companion preference. Local maintenance state also includes the linked regional
domain and cookie-store ID, retry times, and a SHA-256 fingerprint of the last
successfully synced access token and browser-link token; token fingerprints are
not sent to Vintrack.

Session renewal uses an existing matching Vinted tab or background requests to
the supported Vinted origin. Browser-managed cookies accompany those requests;
the extension does not read the refresh token or transmit it to Vintrack. It
never opens or reloads tabs for automatic renewal. A login or security challenge
is left for the user to handle in Vinted.

The extension does **not** transmit the complete browser cookie jar, the Vinted
browser refresh token, the Vinted password, payment-card data, or browsing
history outside the supported Vintrack and Vinted pages.

The companion does not automate checkout, purchase confirmation, likes, offers,
or messages.

When the user clicks Open Checkout in Vintrack or opens a checkout notification
link in a visible browser tab, Vintrack automatically asks the
extension to prepare a checkout in the matching signed-in Vinted account.
The extension verifies the current Vinted account before creating a buy
transaction, building checkout, and requesting saved delivery/payment defaults.
Normal Oneclick opens Vinted for the user to review and confirm the purchase
and does not initiate payment. Users can separately enable PayPal auto-checkout
in supported regions after accepting a payment warning and setting a maximum
EUR order total. A buy-link click can then submit one Vinted payment request
and open the returned PayPal checkout. Missing or ambiguous prices, applied
wallet funds, unavailable PayPal or a total above the limit require manual
review. New monitor matches do not initiate purchases without a click.
The local preparation checkpoint stores item, seller and account IDs, regional domain,
start time and a generated checkout link for up to ten minutes of reuse; it
prevents repeated starts after lost responses. Auto-checkout attempt records,
including the selected preferences and limit, remain locally until extension
state is cleared or the extension is removed. Vintrack retains a server-side
identity/item attempt marker without automatic expiry in its database,
preventing repeated automatic payment starts across browser changes, relinking
and cache loss. An attempt that Vinted refused before anything was
created is released so the buy link can be used again, at most twice per item
within ten minutes; every other marker is kept. Completed links are also kept
in a local history of up to twenty links. Clearing extension state removes
both histories. Account tokens and payment-card data are not part of these
checkout histories. PayPal redirect URLs can contain payment tokens. The
extension uses them only for immediate navigation and does not store them in
those histories. For request checkout, the Vintrack server keeps a started
PayPal approval link encrypted in Redis for about ten minutes, scoped to the
member, linked account and item, so the same member can reopen it; it is not
written to durable results or history. The immediate response is transmitted
between the matching Vinted tab, extension and Vintrack page to finish the
handoff.

### Request checkout payment replay protection

Vintrack retains a minimal claim keyed by Vinted account identity and item to
prevent repeating an automatic payment across browser/server checkout, member
changes, relinking or Redis loss. These claims do not expire with the session.
Associated checkout result state is application-encrypted. Payment redirect tokens,
card numbers and CVV are not stored in these claims. Choosing a request
checkout method does not itself grant permission to copy additional browser
cookies; the separate checkout-context confirmation remains required.

### Optional local checkout agent

Members may separately pair their own computer for explicitly clicked checkout
jobs. Pairing grants a scoped device credential for 30 days, revocable in Account;
pairing a replacement revokes the former device. Vintrack sends the existing
saved access token, the `datadome`, `anon_id`, `_vinted_fr_session` and `v_udt`
cookies, CSRF token and User-Agent to that agent over HTTPS when it claims an
authorized job. Refresh tokens and unrelated cookies are excluded. The agent keeps Vinted session values only in memory,
performs requests through the member's network, and stores only its separate
device credential in the user's OS config directory. PostgreSQL stores its hash.
Normal browser sync does not authorize this extra context transfer or pairing;
both have separate disclosures. See [local checkout agent](local-checkout-agent.md).

## Purpose, storage, and deletion

The data is used only to create and maintain the linked Vinted session, validate
that reconnects belong to the expected Vinted account, and support user-requested
Vintrack account actions. Linked-session data is stored by Vintrack using its
encrypted session persistence until the account is unlinked or the stored data
is deleted. Local extension state remains in the browser until the user clears
it, removes the extension, or connects it again.

Vintrack does not sell extension data. Data is shared only with the Vintrack
service selected by this public build and with Vinted when the user requests a
linked-account action.

## Contact

Questions, privacy requests, and security reports can be submitted through the
[Vintrack GitHub issue tracker](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/issues).
