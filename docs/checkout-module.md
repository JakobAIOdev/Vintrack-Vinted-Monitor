# Per-user checkout module

Account → Oneclick checkout → **Enable checkout module** is a persistent master
switch for both normal Oneclick and saved PayPal/card auto-checkout. The module
starts **off for all existing and new users**. Enabling it opens the mandatory
risk dialog, requires server-recorded acceptance, and respects administrator
feature policies and the linked-account requirement.

Turning it off keeps delivery and payment choices but removes the saved
`autoCheckout` opt-in. Turning it back on leaves auto-payment off; the user must
explicitly enable it again, accept its warnings and save a spending limit.
The switch saves immediately; the separate Save button saves checkout choices.

Telegram item alerts show **⚡ Oneclick checkout** in a separate first button
row in both compact and rich styles, including photo-to-text fallback. It opens
the same `/checkout/{monitorId}/{itemId}` handoff as Discord. The button requires
an enabled checkout module, a linked Vinted account, allowed feature policies
and a public dashboard URL. The handoff checks access again when opened.

When off:

- Dashboard cart buttons are disabled.
- New Discord/Telegram alerts omit the checkout link.
- Existing links and legacy buy/warm/history routes fail closed.
- Vinted service checkout routes independently enforce the persisted switch.
- A concurrently saving preferences request cannot rearm a disabled module.

An already running checkout or payment cannot be undone by this switch. Check
Vinted for the outcome of a request that started before disabling the module.
The extension itself remains available for session sync and other account tools.

## Deployment

Apply Prisma migration `20261006120000_add_user_checkout_switch` **before**
starting the updated control-center, worker and vinted-service. It adds
`User.checkout_enabled BOOLEAN NOT NULL DEFAULT false`; there is no automatic
opt-in or consent backfill. No extension release is needed for this change.

The switch is read alongside existing user policy/preferences queries. The
handoff reads current access when it becomes visible or is retried,
so an old hidden tab cannot use stale enabled settings. The ordinary flow still
loads the target once, in parallel with extension detection; there are no added
Vinted requests.

## Validation

Frontend unit tests cover opt-in/auth/admin/consent enforcement, disabling,
auto-payment reset, stale settings writes and notification target denial.
The optional Go integration test checks default-off and repeated transitions
against PostgreSQL using a temporary synthetic member, without contacting Vinted:

```sh
cd apps/vinted-service
CHECKOUT_MODULE_INTEGRATION_DATABASE_URL=... go test ./internal/session -run TestCheckoutModuleAccessAgainstPostgres -v
```

Local Account UI: the enable switch opens the risk modal; cancelling leaves the
module off. No real member consent, auto-payment or Vinted checkout was submitted.

![Checkout module off in Account](screenshots/checkout-module-toggle.png)

## Clear disabled state and faster handoff (extension 0.3.2)

The account card displays the saved state of Oneclick and auto-checkout
separately. When the module is off, payment/delivery controls and the Save
button are hidden. Stored choices appear as inactive text. Auto-checkout draft
changes do not change the saved Enabled/Disabled badge; an unsaved-change notice
explains whether the existing automatic-payment setting is still active. Turning
the module off also discards local unsaved choices from the inactive summary.

The extension probes existing Vinted receivers concurrently and uses the first
ready receiver instead of waiting for all probes. A silent tab no longer imposes
its 750 ms timeout when another tab answers. This applies to both auto-checkout
preflight and checkout preparation. Account identity is still checked before the
first Vinted mutation, and durable payment claims/checkpoints are unchanged.
User/policy reads and item/linked-account metadata reads also run concurrently.
No additional Vinted requests or retries were introduced. Vinted's dependent
conversation → checkout build → quote update → optional payment requests still
run in order; a new live end-to-end timing has not been measured.

Chrome/Firefox packages and the latest-version defaults are 0.3.2; preparation
protocol stays 6. Reload the unpacked development extension to apply the receiver
change. Before a production release, a configured GitHub
`BROWSER_EXTENSION_LATEST_VERSION` variable must match 0.3.2.

Validation: production dashboard build and lint passed, as did 53 dashboard
unit tests, 40 checkout browser tests and 60 extension tests. Synthetic component
browser checks covered hidden inputs while off, unsaved auto-disable changes,
failed-save status retention, successful-save status updates and mobile layout
without horizontal overflow. These checks mocked preference actions; no real
member preferences, consent or Vinted payments were changed.

![Disabled checkout settings with synthetic preferences](screenshots/checkout-module-disabled.png)
![Disabled checkout settings on mobile](screenshots/checkout-module-disabled-mobile.png)
