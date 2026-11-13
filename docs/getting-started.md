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

Open **Guide** in the app for detailed, task-based instructions covering
monitors, notification channels, Price Watches, account linking, and common
problems. The same instructions are available without signing in in the
[public Vintrack guides](https://vintrack.jakobaio.dev/guides).

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
- Git, `make` and OpenSSL;
- a Discord OAuth application or an OIDC provider for sign-in;
- reliable proxies for sustained live monitoring;
- for a public instance: a domain pointed at the host, with ports 80 and 443 open.

The containers provide the application runtimes. Node.js and Go are required
only when running components directly on the host. Building a custom browser
extension additionally requires Node.js and `zip` on the machine doing that build.
The extension itself is installed on your desktop browser, not on the server.

If `make dev` is running in this checkout, run `make dev-down` before starting
the live stack. Both modes use the same container names and host ports, although
their database and Redis volumes are separate.

### Quick path

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor.git vintrack
cd vintrack
make setup    # creates .env, generates secrets, asks for your URL and Discord login
make up       # public domain with HTTPS; use `make local` on your own computer
make admin    # after signing in once: gives your account the admin role
```

The numbered steps below explain what each command does and what to enter.
Run `make help` for the full list of commands.

### 1. Clone and run the guided setup

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor.git vintrack
cd vintrack
make setup
```

`make setup`:

- copies `.env.example` to `.env` when `.env` does not exist;
- generates `AUTH_SECRET`, `VINTED_SESSION_ENCRYPTION_KEY` and
  `TELEGRAM_WEBHOOK_SECRET`;
- creates `apps/worker/proxies.txt` when it is missing;
- asks where Vintrack will be reachable and writes `AUTH_URL` and
  `VINTRACK_SITE_ADDRESS` to match;
- asks for your Discord client ID and secret (see step 3; you can skip this and
  run `make setup` again later);
- prints the exact redirect URL to register and the command to start with.

An existing `.env` is never replaced. Secrets that are already set stay
unchanged, and you can run `make setup` again to change the URL or login.

To edit `.env` by hand instead, run `make init`. It does the first three items
without asking questions.

### 2. Choose where Vintrack is reachable

`make setup` offers two choices.

**On a public domain with HTTPS.** Point the domain's DNS A record (and AAAA
record if using IPv6) at the server and allow incoming TCP ports 80 and 443.
The bundled Caddy obtains and renews the certificate. The setup writes:

```env
AUTH_URL=https://vintrack.example.com
VINTRACK_SITE_ADDRESS=vintrack.example.com
```

`AUTH_URL` is the full public origin; `VINTRACK_SITE_ADDRESS` is the same
hostname without a scheme or path. Start this variant with `make up`.

**Only on this computer.** The setup writes:

```env
AUTH_URL=http://localhost:3000
VINTRACK_SITE_ADDRESS=http://localhost
```

Start this variant with `make local`. It runs the same stack without Caddy, so
it does not need ports 80 and 443, and the dashboard is served on
`http://localhost:3000`. The localhost extension build supports port 3000 only.

**Behind your own reverse proxy.** Choose the public domain in the setup, start
with `make local`, and forward your proxy to `127.0.0.1:3000`. The proxy must
terminate HTTPS for the hostname in `AUTH_URL` and pass long-lived responses
through unbuffered for the live feed.

In every variant the application and database ports stay private: Compose binds
3000, 4000, 5435 and 6379 to loopback. Keep `SEO_INDEXING_ENABLED=false` unless
you intend to index the public marketing pages.

### 3. Configure sign-in

For Discord:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and create an application.
2. Open its **OAuth2** settings and copy the client ID and client secret. Enter
   them when `make setup` asks, or set them in the root `.env`:

   ```env
   AUTH_DISCORD_ID=your-client-id
   AUTH_DISCORD_SECRET=your-client-secret
   ```

3. Add and save the redirect URL that `make setup` printed in the same
   application. It is your `AUTH_URL` followed by `/api/auth/callback/discord`:

   ```text
   https://vintrack.example.com/api/auth/callback/discord
   http://localhost:3000/api/auth/callback/discord
   ```

   Use the first form for a public domain and the second for a local instance.
   The value must match exactly, including the scheme and port.

To use OIDC instead, configure the issuer, client ID, and client secret described
in [Configuration](configuration.md#authentication). When all required OIDC
variables are set, OIDC replaces Discord on the login page, and the redirect
ends in `/api/auth/callback/oidc`.

Optionally enable GitHub account linking for rewards. Register
`https://vintrack.example.com/api/auth/callback/github`, set both `AUTH_GITHUB_ID`
and `AUTH_GITHUB_SECRET`, and follow [GitHub Login and Rewards](github-rewards.md).
Users still sign in with Discord or OIDC first. Reward enforcement starts disabled.

### 4. Start the stack

If Node.js is installed on the host, check `.env` first. The check never prints
secret values:

```bash
make config-check
```

Then start the variant from step 2. Both build the images from the checked-out
source:

```bash
make up       # public domain, with Caddy and HTTPS
make local    # this computer or your own reverse proxy, without Caddy
```

To use the published images instead of compiling on the server:

```bash
docker compose pull
docker compose up -d --no-build                  # with Caddy
docker compose up -d --no-build --scale caddy=0  # without Caddy
```

The first startup can take several minutes. Open your `AUTH_URL` and sign in.

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
automatic production admin or default admin password. Sign in once in the
browser to create your account, then run:

```bash
make admin
```

When your account is the only one, it becomes admin. When several accounts
exist, the command lists them and you choose one by ID or email:

```bash
make admin ACCOUNT=you@example.com
```

Reload the dashboard or sign out and back in, and confirm **Admin** is visible.
Manage subsequent members through **Admin → Members**. Do not promote every
user or use the development authentication bypass to obtain admin access on a
public instance.

To revoke a member's access, open their details under **Admin → Members** and
choose **Ban member**. This revokes their sessions and extension access, pauses
their monitors and Price Watches, disables account automations, and cancels
queued alerts. **Unban member** restores sign-in access without restarting
those jobs. Admin accounts must have their role changed before they can be banned.

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
its URL into the monitor's notification dialog. Vintrack remembers saved webhooks
for your account, so you can select them when creating or editing monitors and
Price Watches. Existing destinations are imported automatically on upgrade.
The list shows the name of the first monitor or Price Watch that used each
webhook and its Discord webhook ID. Deleting a monitor does not remove its saved
webhook. Discord login credentials and Discord alert webhooks serve different
purposes.

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

Keep `.env` owner-readable only (`chmod 600 .env`). One command updates a
running instance:

```bash
make update            # published images
make update BUILD=1    # build the images from the checked-out source
```

It stops at the first step that fails and runs, in order:

1. `make backup`, which writes a database dump to `../vintrack-backups`;
2. `git pull --ff-only`;
3. `docker compose pull`, or `docker compose build` with `BUILD=1`;
4. the one-shot migration service, which runs `prisma migrate deploy`;
5. `docker compose up -d` for the full stack. An instance that runs without
   Caddy stays without it.

Afterwards, review the release notes and compare `.env.example` with your
`.env` for new settings. The default image tags are `latest`; they are not
pinned to your checkout. Never use `prisma db push --accept-data-loss` against
production.

Take a backup at any other time with:

```bash
make backup
```

Store backups outside the server too, together with a secure copy of `.env` and
any proxy files. Back up the Redis and Caddy volumes as part of a full recovery
plan; the database dump alone does not preserve every coordination record or
HTTPS certificate. The original `VINTED_SESSION_ENCRYPTION_KEY` is required to
read restored sessions.

After an update:

```bash
docker compose ps --all
docker compose logs --since=10m control-center-migrate control-center worker vinted-service
```

## Next steps

- [Configuration](configuration.md)
- [Browser extension](browser-extension.md)
- [Troubleshooting](troubleshooting.md)
- [Development](development.md)
