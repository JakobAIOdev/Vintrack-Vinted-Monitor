# Set up admin checkout notifications

## Connect Discord

1. Open **Admin → Integrations → Checkout notifications**.
2. Enter a Discord channel webhook you are authorized to use.
3. Choose the fields and event filter, enable notifications and save.
4. Use the test button to send a synthetic message with the saved settings.

Notifications start disabled. A blank webhook replacement keeps the existing
URL; the saved URL is not returned to the browser.

## Choose the information to include

**Anonymized** includes checkout method, payment method, region and status.
**All details** also includes item title/link/image, listing price, Vintrack
member name/ID and Vinted username. Optional fields can be toggled independently.

Status is always included. A prepared checkout is not a confirmed purchase.
The item price is the catalog price, excluding final shipping and fees.
Notifications do not include email, address, card/bank details, checkout URLs,
payment redirect tokens or session credentials.

## Choose the events

**Usage and confirmed purchases** reports preparation, manual review, payment
redirects, pending payments, authentication challenges, failures and unknown
outcomes with separate labels.

**Confirmed purchases only** reports only an explicit confirmed card-payment
result. Browser results come from the linked extension. Later completion in
PayPal, a bank confirmation or Vinted is not tracked automatically by this flow.

## Delivery and retries

The admin view shows recent outcomes, delivery status, attempt counts, sanitized
errors and delivery totals for the past 24 hours. Failed or pending deliveries
can be retried with the admin retry button, up to ten at a time.

An uncertain delivery may already exist in Discord; retrying it can create a
duplicate. Notification failures do not repeat a checkout or payment. Current
field and event restrictions also apply when retrying.

## Self-hosted setup

Apply pending migrations before serving the updated Integrations page:

```sh
cd apps/control-center
npx prisma migrate deploy
npx prisma generate
```

No additional environment variables are required.
