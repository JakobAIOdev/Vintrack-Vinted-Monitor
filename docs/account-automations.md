# Auto-Offer and Auto-Message

## Set up an automation

1. Link your Vinted account in **Account**. Its region must match your monitor.
2. Open the monitor and choose **Automations** beside **Edit**.
3. Choose **Auto-Offer** or **Auto-Message** and configure the action.
4. Choose **Save & enable**. Both modules start disabled.

Turn an enabled switch off to disable that module immediately. Editing and
saving an enabled module applies the new settings to matches found after saving.
Your administrator can restrict either feature independently.

## Auto-Offer

Choose a discount from 1–50% and a maximum listing price in the monitor's
currency. The offer is rounded to the currency's smallest unit. Shipping and
buyer fees are excluded from the listing-price limit.

## Auto-Message

Write a message and check its example preview. Available placeholders are
`{title}`, `{price}`, `{currency}`, `{seller}`, `{url}` and `{monitor}`.
Placeholder buttons insert at the cursor or replace selected text.

## Activity and limits

The **Activity** tab shows recent attempts and their status. Reload the page to
update it. Only new, eligible monitor matches can trigger an action. Initial
scan results, older matches, banned sellers, your own items, inactive monitors,
and account or region mismatches are excluded. Discord and Telegram settings do
not control these account actions.

Each linked account has a shared minimum interval of five seconds and a limit
of 500 attempts per module per UTC day across its monitors. Expired matches are
skipped. An uncertain result pauses both modules for 15 minutes; check Vinted
before continuing. Vintrack does not automatically retry an uncertain action.

Unlinking or changing the Vinted identity or region disables the modules.
After linking again, enable them explicitly.

## Self-hosted setup

Apply pending migrations with `npx prisma migrate deploy` in
`apps/control-center`, then rebuild the dashboard and Vinted service. No
additional environment variables are needed. See [Getting Started](getting-started.md)
for the standard deployment and update procedure.
