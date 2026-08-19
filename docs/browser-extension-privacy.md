# Vintrack Browser Sync Privacy Policy

Effective date: August 18, 2026

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

The extension stores the Vintrack light or dark theme locally and mirrors that
preference between the approved Vintrack page and supported Vinted pages. It
also stores the short-lived Vintrack link token and local sync state required
to maintain the connection.

The extension does **not** transmit the complete browser cookie jar, the Vinted
browser refresh token, the Vinted password, payment-card data, or browsing
history outside the supported Vintrack and Vinted pages.

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
