# Troubleshooting

Start with service state and recent, scoped logs:

```bash
docker compose ps
docker compose logs --since=10m control-center-migrate control-center worker vinted-service
```

Redact session tokens, OAuth secrets, webhook URLs, bot tokens, proxy
credentials, and personal data before sharing any output.

## Compose configuration does not render

Validate without printing resolved secrets:

```bash
docker compose config --quiet
```

If it fails:

1. confirm `.env` exists;
2. compare variable names with `.env.example`;
3. look for unquoted values containing shell-sensitive characters;
4. run `make init` only if you understand that it fills missing placeholder
   secrets but does not replace an existing `.env`.

## A required secret is missing

Vintrack needs both:

```env
AUTH_SECRET=...
VINTED_SESSION_ENCRYPTION_KEY=...
```

Generate a missing value with:

```bash
openssl rand -base64 32
```

Do not rotate `VINTED_SESSION_ENCRYPTION_KEY` on an established database merely
to fix startup. Existing linked sessions were encrypted with the original key.
Restore the original value from the deployment's secret backup.

## Migration container fails

Inspect only the migration logs:

```bash
docker compose logs control-center-migrate
```

Confirm PostgreSQL is healthy:

```bash
docker compose ps postgres
```

The supported production path is `prisma migrate deploy`. Do not use
`prisma db push --accept-data-loss` and do not delete the Postgres volume as a
generic fix.

After resolving connectivity or configuration:

```bash
docker compose up --force-recreate control-center-migrate
```

## Login callback error

Confirm all three locations use the same scheme and hostname:

- `AUTH_URL`;
- the Caddy `VINTRACK_SITE_ADDRESS`;
- the OAuth/OIDC callback registered with the identity provider.

Discord callback:

```text
https://vintrack.example.com/api/auth/callback/discord
```

OIDC callback:

```text
https://vintrack.example.com/api/auth/callback/oidc
```

GitHub callback:

```text
https://vintrack.example.com/api/auth/callback/github
```

When OIDC is partially configured, remove the incomplete values or set issuer,
client ID, and client secret together.

If GitHub reports `OAuthAccountNotLinked`, do not enable automatic email
linking. Sign in with the member's existing Discord/OIDC provider and connect
GitHub from **Account**. For star, Sponsors, webhook, or sync failures, see the
[GitHub rewards troubleshooting section](github-rewards.md#troubleshooting).

## Caddy does not obtain a certificate

Check:

- public DNS resolves to the host;
- ports 80 and 443 reach Caddy;
- no other service occupies those ports;
- `VINTRACK_SITE_ADDRESS` is a hostname, not an HTTPS URL with a path;
- Caddy logs show the exact ACME error.

```bash
docker compose logs --since=10m caddy
```

For local development use `VINTRACK_SITE_ADDRESS=http://localhost`, or connect
directly to `http://localhost:3000`.

## Worker reports no usable proxies

Check the monitor's Vinted region and selected proxy source. For a static file:

```bash
test -f apps/worker/proxies.txt
```

Accepted formats include HTTP(S), SOCKS4/5, `host:port:user:pass`, and
`host:port`. UK catalog monitoring requires IPv4 proxies.

The shared free pool is intentionally health-gated and can be unavailable for a
region. Use a personal proxy group for dedicated capacity. Do not reduce
validation thresholds blindly; inspect regional health and worker logs first.

## Catalog requests return 401

A regional Vinted catalog session may need an initial homepage request to
establish cookies before the JSON catalog endpoint succeeds. The worker owns
this session lifecycle.

Check:

- the monitor's region matches the catalog host;
- the proxy stays stable for the client session;
- the configured TLS profile is supported;
- system time is correct;
- recent upstream responses are not a challenge or access-denial page.

Do not copy browser cookies or bearer tokens into source or issue reports. Do
not add CAPTCHA or authentication bypass logic.

## Telegram connects but alerts do not arrive

Verify:

- bot token and public username are correct;
- `DASHBOARD_URL` is public HTTPS;
- the webhook targets `/api/telegram/webhook`;
- the registered webhook secret matches `TELEGRAM_WEBHOOK_SECRET`;
- Telegram notifications are enabled for the monitor;
- worker logs show no redacted delivery error.

After changing Telegram variables, recreate affected services:

```bash
docker compose up -d --force-recreate control-center worker
```

## Live feed is stale

Confirm the control center and Redis are healthy:

```bash
docker compose ps control-center redis
docker compose logs --since=10m control-center redis
```

Then verify the worker is storing new detections. A working dashboard with no
new events can simply mean no listing matched the active filters.

## Requesting help

If the problem remains:

1. record the Vintrack release or commit;
2. note the deployment method and affected component;
3. capture a short, redacted log excerpt;
4. describe reproducible steps;
5. open a GitHub bug report or ask in the
   [Vintrack Discord](https://discord.gg/WbEpEjaWjP).

Security vulnerabilities belong in
the [repository security policy](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/security/policy),
not a public issue.
