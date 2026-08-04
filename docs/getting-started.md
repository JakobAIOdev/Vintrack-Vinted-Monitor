# Getting Started

This guide covers the shared demo, a local Docker installation, and the
additional checks required before a public deployment.

## Try the live demo

1. Open [vintrack.jakobaio.dev](https://vintrack.jakobaio.dev).
2. Sign in with Discord.
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
- optional proxies for sustained monitoring;
- a domain pointed at the host and ports 80/443 for production.

The containers provide the application runtimes. Node.js and Go are required
only when running components directly on the host.

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

### 2. Configure authentication

For Discord, create an application in the
[Discord Developer Portal](https://discord.com/developers/applications), then
set:

```env
AUTH_DISCORD_ID=your-client-id
AUTH_DISCORD_SECRET=your-client-secret
```

Add this OAuth redirect:

```text
http://localhost:3000/api/auth/callback/discord
```

To use OIDC instead, configure the issuer, client ID, and client secret described
in [Configuration](configuration.md#authentication). When all required OIDC
variables are set, OIDC replaces Discord on the login page.

### 3. Start the stack

```bash
docker compose up -d --build
```

Check service state:

```bash
docker compose ps
```

Open [http://localhost:3000](http://localhost:3000) by default. It matches the
example `AUTH_URL` and the callback configured above.

Caddy also exposes [http://localhost](http://localhost). To use that as the
canonical origin, set `AUTH_URL` and `DASHBOARD_URL` to `http://localhost` and
register the matching identity-provider callback without port `3000`.

The first startup can take several minutes while images are built and the
database migration container completes.

### 4. Add proxies

The worker accepts one proxy per line in `apps/worker/proxies.txt`:

```text
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass
host:port
```

You can also create personal proxy groups in the dashboard. The optional shared
starter pool is enabled and managed from **Admin → Settings**.

### 5. Inspect logs

```bash
docker compose logs -f control-center worker vinted-service
```

See [Troubleshooting](troubleshooting.md) before changing database state or
deleting Docker volumes.

## Production deployment

Do not expose a local configuration unchanged. Before deployment:

1. Set `AUTH_URL` and `DASHBOARD_URL` to the public HTTPS URL.
2. Set `VINTRACK_SITE_ADDRESS` to the public hostname.
3. Add the production OAuth/OIDC callback URL.
4. Store `.env` with owner-only permissions and back it up securely.
5. Use strong, unique values for both required secrets.
6. Confirm the host firewall exposes only intended ports.
7. Configure reliable proxy capacity and conservative monitor intervals.
8. Run `docker compose config --quiet` and review the service status after
   startup.

Example:

```env
AUTH_URL=https://vintrack.example.com
DASHBOARD_URL=https://vintrack.example.com
VINTRACK_SITE_ADDRESS=vintrack.example.com
```

Caddy obtains and renews certificates automatically when DNS points to the host
and ports 80 and 443 are reachable.

Start from published images:

```bash
docker compose pull
docker compose up -d
```

Or build from the checked-out source:

```bash
docker compose up -d --build
```

### Updating production

Back up the database and `.env`, then:

```bash
git pull --ff-only
docker compose pull
docker compose up --force-recreate control-center-migrate
docker compose up -d --force-recreate control-center worker vinted-service caddy
```

The migration service runs `prisma migrate deploy` using the control-center
image. Never use `prisma db push --accept-data-loss` against production.

After an update:

```bash
docker compose ps
docker compose logs --since=10m control-center-migrate control-center worker vinted-service
```

## Next steps

- [Configuration](configuration.md)
- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [Development](development.md)
