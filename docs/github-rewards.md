# GitHub Login and Rewards

Vintrack uses a verified GitHub star or Sponsorship to raise the running Free
Proxy Pool monitor limit. GitHub is connected to an existing membership from
**Account**; it is never a sign-in method of its own. The default policy is
`3 / 5 / 15`; enforcement is disabled by the migration so operators can backfill
and preview before rollout.

## Member behavior

| Member state                                                  | Running Free Proxy Pool limit |
| ------------------------------------------------------------- | ----------------------------: |
| Free member, no reward                                        |                             3 |
| Current verified repository star                              |                             5 |
| Any verified personal or assigned organization donation       |                15 permanently |
| Premium or admin with the default eligible-role configuration |                     Unlimited |
| Per-member admin override                                     |                Override value |

Only active monitors with `proxy_source = "free"` count. Personal proxy groups,
server proxies, and other sources are not affected. Removing a star immediately
returns a non-donor to the default limit. A verified donation remains valid
after a recurring Sponsorship ends; only an explicit admin revocation with a
reason removes it. An upgrade never starts paused monitors automatically.

At 3/3 the member is shown the GitHub star upgrade once per policy version. A
member without GitHub sees **Connect GitHub**; a linked non-stargazer sees
**Star Vintrack** and **I've starred — check again**. At 5/5 the CTA changes to
GitHub Sponsors. At 15/15 no further upsell appears. Every later blocked action
still produces a short limit toast.

When a limit falls, Vintrack pauses only the newest excess active Free Pool
monitors (`created_at DESC, id DESC`). Monitor settings and notification targets
are retained. Dashboard links, status notifications, and audit events identify
the affected monitors.

## Login and safe account linking

Set both `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` to enable GitHub. The callback
is:

```text
https://vintrack.example.com/api/auth/callback/github
```

GitHub is a reward identity, not a sign-in method. Every member signs in with
Discord or OIDC and then selects **Connect GitHub** on **Account**. A GitHub
OAuth flow that does not resolve to an existing Vintrack member is rejected, so
it can never create a second, empty account that would permanently reserve the
member's GitHub identity. Vintrack never merges accounts merely because email
addresses match, and Auth.js dangerous email linking remains disabled. The
numeric GitHub account ID is the stable identity and can be reserved by only one
Vintrack member.

GitHub can be disconnected only while another login provider remains. The
reservation stays attached to the Vintrack member, preventing the GitHub
identity and historical donations from being claimed by a different account.
OAuth access, refresh, and ID tokens and `session_state` are removed by the
adapter before the GitHub `Account` row is stored.

## GitHub setup

Create a GitHub OAuth App with the callback above. Configure two separate
webhooks:

| Webhook          | URL                                       | Event        | Secret                             |
| ---------------- | ----------------------------------------- | ------------ | ---------------------------------- |
| Repository       | `/api/github-rewards/webhooks/repository` | Stars        | `GITHUB_REPOSITORY_WEBHOOK_SECRET` |
| Sponsors account | `/api/github-rewards/webhooks/sponsors`   | Sponsorships | `GITHUB_SPONSORS_WEBHOOK_SECRET`   |

Generate independent random secrets. Vintrack validates HMAC-SHA256 against the
unmodified body with a timing-safe comparison, checks repository or Sponsors
recipient, and uses `X-GitHub-Delivery` as an idempotency key. Full raw webhook
payloads are not stored.

Set `GITHUB_REWARDS_MAINTAINER_TOKEN` to a token owned by the configured
repository/Sponsors maintainer. It must be able to query all Sponsorships,
including private and historical entries; the sync uses `activeOnly: false` and
`includePrivate: true`. A classic token with `public_repo` additionally unlocks
the cheaper stargazer snapshot — see the reconciliation section. Set a random
`GITHUB_REWARDS_SYNC_SECRET` for the private scheduler endpoint.

```env
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
GITHUB_REPOSITORY_WEBHOOK_SECRET=
GITHUB_SPONSORS_WEBHOOK_SECRET=
GITHUB_REWARDS_MAINTAINER_TOKEN=
GITHUB_REWARDS_SYNC_SECRET=
```

Stars and personal donations are applied immediately from verified member
checks and GitHub webhooks. The Compose scheduler checks whether a fallback
reconciliation is due every five minutes; the configured interval never delays
a member upgrade. Failed fallback jobs wait at least one hour (or the longer
configured interval) before retrying, while admins can retry manually after
fixing the integration. Jobs are single-flight, stale running jobs expire after
one hour, and job/delivery results appear in **Admin → Rewards**.

## Star and donation reconciliation

Stars are updated from login/linking checks, repository webhooks, and a
fallback reconciliation. The fallback picks one of two paths automatically:

| Path           | Endpoint                            | Cost                     | Token |
| -------------- | ----------------------------------- | ------------------------ | ----- |
| Snapshot       | `/repos/{owner}/{repo}/stargazers`  | `stars / 100` per run    | Classic only |
| Per member     | `/users/{login}/starred`            | `stars / 100` per member | Any, and anonymous |

GitHub rejects the stargazers endpoint for **fine-grained** personal access
tokens (403), and since it began requiring authentication on public listings it
also rejects anonymous callers (401). The sync therefore probes the snapshot
first and silently falls back to per-member checks, which fine-grained tokens
may read. **Integration health** reports which path is active. A classic token
with `public_repo` enables the cheaper snapshot; with a fine-grained token
everything still works, just with more requests.

The manual **check again** button always uses the per-member path — for a
single member that is cheaper than a full snapshot. The starred list is ordered
most-recently-starred first, so a star the member just added is found on the
first page.

A member is marked unstarred only after their list was read to the end; if
pagination cannot be completed the previous state is preserved. Fallback data
never overwrites a newer webhook event, and a failure affecting a single member
is counted in the job's `failed` column instead of aborting the run.

Sponsors webhooks record new or changed Sponsorships. The GraphQL backfill
captures personal and organization sponsors, one-time and recurring payments,
active and ended Sponsorships, and tier amount when GitHub exposes it. A later
GitHub link automatically claims stored personal donations. Organization
donations remain in the admin review queue until assigned.

Vintrack stores GitHub identity, reward state, timestamps, tier/amount metadata,
job health, and prompt telemetry. It does not store GitHub invoices, donor email
addresses, payment credentials, or complete webhook payloads.

## Admin operation and rollout

**Admin → Rewards** provides policy values, eligible roles, prompt and
announcement copy, desktop/mobile previews, integration secret status, sync
jobs, webhook deliveries, member search, unmatched organization donations,
revocation with a required reason, and enforcement preview. A limit-reducing
save with affected monitors requires reviewing the preview and confirming the
save a second time.

Recommended rollout:

1. Deploy the migration and application with enforcement disabled.
2. Configure OAuth, both webhooks, the maintainer token, and scheduler secret.
3. Run **Sync now** and resolve unmatched organization donations.
4. Enable the GitHub login/linking flow and publish the member announcement.
5. Run **Preview enforcement** and export or record the affected members and
   exact monitor IDs.
6. Enable enforcement and watch reconciliation, webhook delivery, sync job,
   notification, and audit health.

Rollback by disabling enforcement. Authentication and reward collection can
remain enabled. Vintrack deliberately does not restart monitors that were
already paused.

## Troubleshooting

- **Connect GitHub missing:** both OAuth variables must be non-empty and the
  control center must be recreated. GitHub never appears on the login page.
- **Account conflict:** the GitHub identity is reserved by another member. Sign
  in with the original Discord/OIDC provider and link GitHub from Account. Do
  not enable automatic email linking.
- **Star remains unknown:** use **I've starred — check again**, inspect the
  OAuth scope and repository name, then inspect recent webhook deliveries.
- **Historical/private donation missing:** verify the maintainer token belongs
  to the Sponsors recipient and supports the GraphQL backfill; run **Sync now**.
- **Webhook 401:** verify the correct dedicated secret and that the sender signs
  the exact raw request body.
- **Incomplete snapshot:** retry the failed job. Existing star state is retained
  until a full snapshot succeeds.
- **Too many monitors paused:** disable enforcement, inspect the audit event and
  preview, correct the policy or identity assignment, and let the member choose
  which monitors to restart after the corrected limit is active.
