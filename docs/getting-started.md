# Getting Started

This guide covers the shared demo and a complete self-hosted deployment.
All shell commands below run from the repository root unless stated otherwise.
Replace `vintrack.example.com` with your own hostname.

To try the UI locally without OAuth or real Vinted requests, follow the
[mock development workflow](development.md#low-power-local-stack). It uses an
automatic admin and separate data; it is not a public hosting configuration.

## Try the live demo

1. Open [vintrack.jakobaio.dev](https://vintrack.jakobaio.dev).
2. Sign in with Discord. Link GitHub for rewards later from **Account**;
   GitHub is not a separate login method.
3. Open **Monitors** and create a monitor with a Vinted region, query, and any
   price, category, brand, color, size, or seller-country filters.
4. Select a personal proxy group, or choose **Free Proxy Pool** when the region
   is marked ready.
5. Configure one or both notification channels:
   - paste a Discord webhook URL into the monitor notification dialog;
   - select **Connect Telegram** and send the generated one-time command to the
     bot shown in the dialog.
6. Open **Dashboard settings** to choose `Rich` or `Compact` item alerts
   independently for Discord and Telegram.
7. Watch results in the monitor view, live feed, Discord, or Telegram.

The public demo is shared, best-effort infrastructure. Free proxy health,
latency, and region availability change over time. Use a personal proxy group
for dedicated capacity.

Account linking is optional. Install the
[browser extension](../apps/vintrack-browser-sync-extension/README.md) only if
you want to perform actions with a Vinted account you control.

## Self-host Vintrack

### Requirements

Prepare:

- Docker Engine and Docker Compose v2;
- Git;
- `make` and OpenSSL for the guided initializer;
- a Discord OAuth application or an OIDC provider;
- reliable proxies for sustained live monitoring;
- a domain pointed at the host and ports 80/443 for production.

The containers provide the application runtimes. Node.js and Go are required
only when running components directly on the host. Building a custom browser
extension additionally requires Node.js and `zip` on the machine doing that build.
The extension itself is installed on your desktop browser, not on the server.

If `make dev` is running in this checkout, run `make dev-down` before starting
the live stack. Both modes use the same container names and host ports, although
their database and Redis volumes are separate.

### 1. Clone and initialize

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor.git vintrack
cd vintrack
make init
```

The initializer:

- copies `.env.example` to `.env` when `.env` does not exist;
- generates `AUTH_SECRET`;
- generates `VINTED_SESSION_ENCRYPTION_KEY`;
- creates `apps/worker/proxies.txt` when it is missing.

An existing `.env` is never replaced. Only missing or template secret values are
generated; configured non-placeholder secrets remain unchanged.

### 2. Set your public URL and HTTPS hostname

Point your domain's DNS A record (and AAAA record if using IPv6) at the server.
Allow incoming TCP ports 80 and 443 to Caddy. Keep application and database
ports private; Compose binds ports 3000, 4000, 5435 and 6379 to loopback.

Edit the root `.env`:

```env
AUTH_URL=https://vintrack.example.com
VINTRACK_SITE_ADDRESS=vintrack.example.com
```

`AUTH_URL` is the full public origin; `VINTRACK_SITE_ADDRESS` is the hostname.
Keep `SEO_INDEXING_ENABLED=false` unless you intend to index the public marketing
pages. The initializer already generated both required encryption secrets.

For a live stack used only on your own computer, keep the example defaults
`AUTH_URL=http://localhost:3000` and `VINTRACK_SITE_ADDRESS=http://localhost`,
and use that localhost origin in the callbacks below. Caddy exposes
`http://localhost` only in the full stack; changing the canonical origin also
requires changing your callbacks. The localhost extension build supports port
3000 only.

### 3. Configure authentication

For Discord:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and create an application.
2. Open its **OAuth2** settings, copy the client ID and client secret, and set
   these values in the root `.env`:

   ```env
   AUTH_DISCORD_ID=your-client-id
   AUTH_DISCORD_SECRET=your-client-secret
   ```

3. Add and save this exact OAuth redirect in the same application:

   ```text
   https://vintrack.example.com/api/auth/callback/discord
   ```

To use OIDC instead, configure the issuer, client ID, and client secret described
in [Configuration](configuration.md#authentication). When all required OIDC
variables are set, OIDC replaces Discord on the login page.

Optionally enable GitHub account linking for rewards. Register
`https://vintrack.example.com/api/auth/callback/github`, set both `AUTH_GITHUB_ID`
and `AUTH_GITHUB_SECRET`, and follow [GitHub Login and Rewards](github-rewards.md).
Users still sign in with Discord or OIDC first. Reward enforcement starts disabled.

### 4. Validate and start the stack

Validate the configuration without printing secrets:

```bash
docker compose config --quiet
```

Choose one installation method. Published images avoid compiling on the server:

```bash
docker compose pull
docker compose up -d --no-build
```

Alternatively, build the checked-out source:

```bash
docker compose up -d --build
```

The first startup can take several minutes. Caddy obtains and renews certificates
automatically when DNS and the public ports are correct. Open your `AUTH_URL`,
for example `https://vintrack.example.com`, and sign in.

Check service state and migrations:

```bash
docker compose ps --all
docker compose logs --tail=50 control-center-migrate
```

`control-center-migrate` should show `Exited (0)` after applying migrations;
it is a one-shot job. The other default services should be running, with
PostgreSQL and Redis healthy. The experimental `id-scanner` is not required.

### 5. Grant your first account admin access

New accounts, including the first account, have the `free` role. There is no
automatic production admin or default admin password. Sign in once to create
your user, then open the database shell on your own server:

```bash
docker compose exec postgres psql -U vinuser -d vintrack
```

Inside `psql`, identify your own user:

```sql
SELECT id, name, email, role FROM "User" ORDER BY "createdAt";
```

Copy that user's exact `id`, replace `YOUR_USER_ID` below, and run:

```sql
UPDATE "User" SET role = 'admin' WHERE id = 'YOUR_USER_ID' RETURNING id, role;
```

Expect exactly one updated row (`UPDATE 1`). Exit with `\q`, reload the dashboard
or sign out and back in, and confirm **Admin** is visible. Manage subsequent
members through **Admin → Members**. Do not promote every user or use the
development authentication bypass to obtain admin access on a public instance.

### 6. Add proxies and create your first monitor

For a predictable first test, open **Proxies**, create a personal proxy group,
add your proxies, and check that they work for the intended Vinted region.
Then open **Monitors**, create a monitor, choose that group and the matching
region, add a query and filters, and enable it with a conservative interval.
Check the monitor view and live feed for new matches.

For operator-managed server capacity, the worker also accepts one proxy per
line in `apps/worker/proxies.txt`:

```text
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass
host:port
```

The **Admin → System** server-proxy setting takes precedence when it exists,
including when it is empty. Prefer managing server capacity there. When using
the file fallback, restart the worker after editing the file:

```bash
docker compose restart worker
```

The file is separate from a user's personal proxy group. The optional shared
starter pool requires admin configuration and healthy regional capacity; it
is not guaranteed to be ready on a fresh installation. See
[proxy configuration](configuration.md#proxy-sources).

### 7. Enable alerts and optional account linking

For Discord alerts, create a webhook in a server/channel you manage and paste
its URL into the monitor's notification dialog. Discord login credentials and
Discord alert webhooks serve different purposes.

For Telegram, first complete the operator's [bot and webhook setup](configuration.md#telegram),
then use **Connect Telegram** in the dashboard. Select `Rich` or `Compact`
alerts in **Dashboard settings**.

To link your Vinted account, follow the [self-hosted browser extension guide](browser-extension.md#self-hosted-domain).
The public extension downloads do not connect to custom domains. Linking is
optional for monitoring and required for account actions such as likes and messages.

### 8. Inspect logs

```bash
docker compose logs -f control-center worker vinted-service
```

See [Troubleshooting](troubleshooting.md) before changing database state or
deleting Docker volumes.

## Updating production

Keep `.env` owner-readable only (`chmod 600 .env`). Before updating, create a
database dump and keep a secure copy of `.env` and any proxy files. For example:

```bash
umask 077
mkdir -p ../vintrack-backups
docker compose exec -T postgres pg_dump -U vinuser -d vintrack -Fc > "../vintrack-backups/vintrack-$(date +%Y%m%d-%H%M%S).dump"
```

Check that the dump command succeeded and store backups outside the server too.
Back up Redis and Caddy volumes as part of a full recovery plan; the database
dump alone does not preserve every coordination record or HTTPS certificate.
The original `VINTED_SESSION_ENCRYPTION_KEY` is required to read restored sessions.

For published images, update the checkout and fetch the images:

```bash
git pull --ff-only
docker compose pull
docker compose config --quiet
```

For a source-built deployment, use `docker compose build` instead of
`docker compose pull`. Review release notes and any new `.env.example` settings.
The default image tags are `latest`; they are not pinned to your checkout.

With PostgreSQL and Redis still running, apply migrations and wait for success:

```bash
docker compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from control-center-migrate control-center-migrate
```

Continue only if that command exits successfully. Then recreate the full stack,
including the proxy maintainer and GitHub rewards scheduler:

```bash
docker compose up -d --no-build --pull never
```

The migration service runs `prisma migrate deploy` using the control-center
image. Never use `prisma db push --accept-data-loss` against production.

After an update:

```bash
docker compose ps --all
docker compose logs --since=10m control-center-migrate control-center worker vinted-service
```

## Next steps

- [Configuration](configuration.md)
- [Browser extension](browser-extension.md)
- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [Development](development.md)
