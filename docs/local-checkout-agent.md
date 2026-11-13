# Local checkout agent (experimental)

The local checkout agent is a small program that runs on your own computer. When
you tap a buy link, Vintrack queues one checkout job for it and the agent sends
the Vinted checkout requests from your own network. The existing browser
checkout remains the default method.

The agent does not open or automate a browser, does not listen on any port, does
not buy monitor matches on its own, does not rotate IP addresses and does not
solve security checks. Your computer must be on and the agent must be running
when you tap a buy link. Vinted can still ask for a new sign-in, a security
check, PayPal approval or bank authentication. Using the agent is no guarantee
against account restrictions.

## Setup

1. Get the agent for your operating system from your Vintrack administrator.
   Builds exist for macOS (arm64, amd64), Windows (amd64) and Linux (arm64,
   amd64), each with a `SHA256SUMS` file. Administrators build them with
   `scripts/build-checkout-agent.sh` in `apps/vinted-service`; the service needs
   the migrations `20261019190000_durable_checkout_payment_attempts` and
   `20261019200000_local_checkout_agent`.
2. In Account, enable checkout and sync the checkout session context with the
   browser extension. See [checkout module](checkout-module.md) for what that
   sync contains and how the extension keeps it current.
3. In the **Local checkout agent** section, select **Create pairing code** and
   read the disclosure. The code is secret, works once and expires after five
   minutes. Only one code is valid at a time: creating a new code replaces the
   previous one, and **Revoke agent** withdraws a code that was not used yet.
4. Run `checkout-agent pair --server https://YOUR-VINTRACK-ORIGIN` (on Windows
   `checkout-agent.exe`) and paste the code at its prompt. Never pass the code or
   the device credential as a command-line argument and never share them in logs
   or support chats.
5. Run `checkout-agent run` and leave it running. Account shows the agent as
   **Online** while it has been in contact within the last 30 seconds.
6. Select **Full checkout via local agent** as the checkout method and save.
   Switching methods turns automatic payment off, so enable Full checkout with
   its warning and spending limit again and save once more. Agent jobs require
   that explicit choice.
7. To withdraw access, select **Revoke agent** in Account. Running
   `checkout-agent forget` only deletes the credential on your computer; revoke
   it in Account as well.

The agent starts neither with your computer nor on its own. Start it again
after a restart. Pairing another computer replaces the previous one.

## What happens when you tap a buy link

- Vintrack checks your checkout settings, your linked account and that the
  agent is online, then queues one job for the item. A job waits at most two
  minutes for the agent.
- The agent claims the job once. A claimed job is never delivered again, also
  not after a crash or a lost connection.
- The agent first confirms that Vinted answers for your linked account, then
  runs the checkout steps. Vintrack must acknowledge every step before the
  agent sends it to Vinted, and re-checks your saved settings immediately
  before the payment request.
- The buy page shows the result. You may close the page; the job still
  finishes. Reopening the same buy link shows the same job and never starts a
  second checkout.

Monitor matches never trigger a purchase. Only a buy link you open does.

## Credential handling

The agent accepts only an HTTPS address for Vintrack; plain HTTP is accepted
only for `localhost` and loopback addresses during development. It refuses
redirects, so its credential is never forwarded to another host.

Pairing gives your computer a device credential that is valid for 30 days and is
separate from the browser extension's link. It only allows claiming the checkout
jobs you queued and reporting their progress. It cannot select another member,
account or item. Vintrack stores only a hash of it. On your computer it is saved
in your operating system's user configuration directory as
`vintrack/checkout-agent.json`, readable only by your user on macOS and Linux;
on Windows it relies on your user profile's access controls. Pair only a
computer you trust with access to your Vinted account.

Your Vinted session stays in Vintrack's encrypted session store. A claimed job
receives, over HTTPS:

- the Vinted access token;
- the four checkout-context cookies you chose to sync: `datadome`, `anon_id`,
  `_vinted_fr_session` and `v_udt`;
- the CSRF token and the browser User-Agent.

Refresh tokens, refresh cookies, every other cookie, and phone or card data are
never sent. The agent keeps these values in memory for the duration of one job
and does not write them to disk or print them.

A PayPal approval link is kept encrypted for at most ten minutes, scoped to you
and the job, so the buy page can open it again if the first attempt was lost.
It is never written to the job result or to your checkout history. Opening it
again sends nothing to Vinted and starts no second payment.

## Limits

- **One job per item.** A job that reached Vinted, or may have, stays the
  answer for its item. Tapping the link again shows that job. A new job is
  queued only when the earlier one provably never reached Vinted: it was not
  picked up within two minutes, it was queued for a computer you have since
  replaced, or it ended before its first checkout request without holding a
  payment authorization.
- **One automatic payment per item.** A buy job reserves the item's payment
  authorization when it is delivered to the agent. If that job stops for any
  reason afterwards, the item is not bought automatically again by any checkout
  method. Finish it in Vinted.
- **Nothing is retried.** A failed or uncertain step is not sent again. A
  security check, a rejected session or a rate limit stops the job; the agent
  does not try another route, profile or address.
- **Stopping the agent.** Stopping it (Ctrl+C or a normal termination) ends
  the current job before its next step. If the payment request was already
  sent, the agent still reports the outcome before it exits.
- **Unknown payment outcome.** If the agent stops responding after Vintrack
  acknowledged the payment step, the job is reported as *payment outcome
  unknown* after 90 seconds. A payment request may have been sent. Check Vinted
  and do not start the payment again.
- **Interrupted jobs.** A claimed job that reports nothing for 90 seconds
  before the payment step is shown as interrupted. Check Vinted before
  continuing.
- **Notifications.** A Discord or Telegram checkout notification is queued when
  the buy page reads the finished job. If you close the page before the job
  finishes, no notification is sent; check Vinted or reopen the buy link.
- **Device credential.** It expires 30 days after pairing and is not renewed.
  Pair again afterwards. Linking another Vinted account or region also requires
  a new pairing.
- **Vinted session.** The agent uses the session and checkout context that the
  browser extension synced. When that session has expired or the context is
  missing, sign in to Vinted in your browser and sync again.
- **Validation.** Opening `/checkout/MONITOR/ITEM?validate=1` runs a job up to
  the payment step and cannot send a payment request.

## Troubleshooting

Update the agent whenever Vintrack is updated. An agent and a Vintrack service
from different versions can refuse each other's job steps.

| What you see | What it means | What to do |
| --- | --- | --- |
| `invalid coordinator origin` when pairing or starting | The server address is not an HTTPS origin, or contains a path | Use `https://your-vintrack` without a path. Plain HTTP works only for `localhost` |
| `pair this device first`, `pair this device again` | No usable device credential on this computer | Create a pairing code in Account and pair again |
| `agent config permissions must be 0600` | The credential file is readable by other users | Run `chmod 600` on `vintrack/checkout-agent.json` in your user configuration directory, or pair again |
| `Device credential expired or was revoked. Pair this device again.` | The 30 days are over, the agent was revoked or another computer was paired | Pair again |
| `The linked Vinted account changed. Pair this device again.` | You linked another Vinted account or region | Pair again |
| `Checkout is switched off or its risk warning is not accepted` | Checkout is disabled for your account or the risk warning is open | Enable checkout and accept the warning in Account. The agent keeps waiting |
| `Coordinator unavailable. Waiting` | Vintrack could not be reached or is temporarily unavailable | Nothing; the agent keeps polling |
| `verify the Vinted session and sync checkout context before restarting the agent` | Vinted rejected the session or asked for a security check. The agent stopped | Open Vinted in your browser, complete any check there, sync the checkout context in Account, then start the agent again |
| Buy page: `start your paired checkout agent before opening a buy link` | The agent is not paired or has not been in contact for 30 seconds | Start `checkout-agent run` and open the link again |
| Buy page: `sync fresh local checkout context before restarting the agent` | Vinted rejected this checkout context earlier | Sync the checkout context again in Account |
| Buy page: `sync fresh checkout session context in Account first` | The synced Vinted session expired or has no checkout context | Sign in to Vinted in your browser and sync |
| Result: `queued checkout expired; no payment started` | The agent did not pick the job up within two minutes | Make sure the agent is running, then open the link again |
| Result: `Local checkout stopped at <step> (...)` | The named step failed. The bracket holds a fixed class: `network: ...`, `invalid response` or `Vinted HTTP <status>` | Check the item in Vinted. The job is not retried |
| Result: `The agent could not verify the Vinted session from this computer (...)` | Vinted did not give a usable answer before any checkout step, for example a timeout | Check your connection. The agent keeps running |
| Result: `Vinted asks this account to accept its updated terms and conditions` | Vinted refuses purchases until you accept its new terms | Open Vinted and accept them |
| Result: `Payment was not acknowledged by Vintrack; no payment request was sent.` | Your settings changed or Vintrack was unreachable at the payment step | Review the prepared checkout in Vinted |
| Result: `The agent rejected this job before contacting Vinted.` | The job did not pass the agent's own checks, usually because agent and Vintrack versions differ | Update the agent |
| Result: `A PayPal payment was started for this item, but its PayPal link is no longer available.` | The ten minutes for the approval link are over | Finish or cancel the payment in Vinted |

The agent never prints session values, credentials or Vinted responses. If you
ask for help, share only the messages above, never the pairing code or the
contents of `checkout-agent.json`.
