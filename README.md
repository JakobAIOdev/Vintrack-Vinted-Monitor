<p align="center">
  <img src="https://cdn-icons-png.flaticon.com/512/8266/8266540.png" width="90" alt="Vintrack" />
</p>

<h1 align="center">Vintrack</h1>

<p align="center">
  <b>Open-source Vinted monitoring platform for resellers.</b><br/>
  Real-time scraping · Health-checked free starter proxies · Discord & Telegram alerts · Account linking · Dashboard
</p>

<p align="center">
  <a href="#features"><img src="https://img.shields.io/badge/monitors-unlimited-22c55e?style=flat-square" alt="Monitors" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Next.js-16-000?style=flat-square&logo=next.js" alt="Next.js" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Go-1.25-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
  <a href="#self-hosting"><img src="https://img.shields.io/badge/deploy-one_command-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" /></a>
  <a href="#free-starter-proxy-pools"><img src="https://img.shields.io/badge/free_proxy_pools-health_checked-10b981?style=flat-square" alt="Health-checked free proxy pools" /></a>
</p>

<p align="center">
  <b>⭐ If you find Vintrack useful, please consider giving it a star on GitHub! It helps the project grow and reach more people. ⭐</b>
</p>

<p align="center">
  <a href="https://github.com/sponsors/JakobAIOdev">
    <img src="https://img.shields.io/badge/Sponsor-Vintrack-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Sponsor Vintrack" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/topic-vinted-blue?style=flat-square" alt="Vinted" />
  <img src="https://img.shields.io/badge/topic-bot-blue?style=flat-square" alt="Bot" />
  <img src="https://img.shields.io/badge/topic-scraper-blue?style=flat-square" alt="Scraper" />
  <img src="https://img.shields.io/badge/topic-reselling-blue?style=flat-square" alt="Reselling" />
  <img src="https://img.shields.io/badge/topic-monitor-blue?style=flat-square" alt="Monitor" />
</p>

<p align="center">
  <a href="#live-demo">Live Demo</a> •
  <a href="#browser-extension">Browser Extension</a> •
  <a href="#self-hosting">Self-Hosting</a> •
  <a href="#features">Features</a> •
  <a href="#community--support">Community</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#api-contracts">API Contracts</a> •
  <a href="#screenshots">Screenshots</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## Live Demo

You can try Vintrack without hosting anything yourself:

- **URL:** https://vintrack.jakobaio.dev
- **Login:** sign up with Discord OAuth
- **Default role:** new accounts start as **Free**
- **Free Proxy Pool:** ready regions can be tested without purchasing proxies first
- **Browser extension:** download the latest Chrome ZIP or Firefox XPI from GitHub releases
- **Support:** join the Discord server if you need help: https://discord.gg/WbEpEjaWjP

### Demo Quick Start

1. Open https://vintrack.jakobaio.dev and sign in with Discord.
2. Create a monitor and select **Free Proxy Pool** when its Vinted region is marked **Ready**. If the region is degraded or unavailable, add your own proxy group under **Proxies**.
3. Open **Monitors** or the dashboard and create a monitor with your Vinted search, region, price, size, brand, and country filters.
4. Enable notifications:
   - **Discord:** paste your Discord webhook URL in the monitor notification dialog.
   - **Telegram:** click **Connect Telegram**, send the generated `/connect ...` command to the bot shown in the dialog, then enable Telegram for the monitor.
5. Watch new items in the dashboard, live feed, Discord, or Telegram.
6. Optional: install the browser extension and link your Vinted account from the **Account** page to like items, send offers, message sellers, and keep your Vinted session synced.

### Demo Notes

- The Free Proxy Pool is shared, best-effort starter infrastructure. Availability, latency, and supported regions change with live pool health.
- Free proxies are used only for catalog monitoring. Linked-account actions such as likes, offers, messages, and checkout never use the free pool.
- Server proxies are not guaranteed for free accounts. Personal proxy groups remain the reliable fallback for dedicated capacity.
- The demo is shared infrastructure, so monitoring reliability can vary.
- Telegram users never need a bot token or chat ID. The public demo shows the bot username during the connect flow.
- Discord notifications require your own Discord webhook URL.
- Vinted account linking is optional, but it is required for actions such as liking items, sending offers, sending messages, and checkout-link tools.

---

## Why Vintrack?

Vinted doesn't have a proper notification system — you either refresh manually or miss the deal. Vintrack solves this by monitoring listings and sending alerts to Discord or Telegram **before anyone else** can see the item.

Built for resellers who need speed. Open-sourced for the community.

- **Sub-2s detection** — catch items faster than any other tool
- **Anti-detection** — TLS fingerprint rotation with proxy support
- **Free starter proxy pools** — try ready Vinted regions before buying a proxy plan
- **Granular filters** — price, size, category, brand, color, and country/region
- **Direct Interaction** — Like items, send offers, and message sellers from the dashboard
- **Browser session sync** — Chrome extension keeps linked Vinted sessions fresh without copying tokens manually
- **Experimental checkout tooling** — browser-assisted checkout link creation with checkout-link history
- **Full dashboard** — no CLI needed, everything from the browser
- **One-command deploy** — `docker compose up` and you're live

---

## Features

### Real-Time Monitoring

Create unlimited monitors with custom search queries. Each monitor keeps its canonical Vinted search and can also join an optional query-free discovery feed that applies the same catalog filters and matches keywords locally. Catalog requests use health-scored proxy sessions and delayed hedging; Redis atomically deduplicates both paths.

See [Worker speed and hybrid discovery](docs/worker-speed.md) for rollout, proxy capacity, metrics, and tuning controls.
The optional bounded ID experiment is documented in [Pre-index shadow scanner](docs/preindex-shadow.md).

### Advanced Filters

Fine-tune every monitor with:

- **Search query** — keyword-based filtering
- **Price range** — min/max price boundaries
- **Categories** — over 900+ Vinted categories supported
- **Brands** — filter by specific brands
- **Colors** — filter by item colors
- **Sizes** — clothing size filtering
- **Seller Origin** — filter by seller country (e.g. only show items from France or Italy)
- **Region** — choose the Vinted market per monitor (e.g. `vinted.de`, `vinted.hu`, `vinted.fr`)

### Vinted Account Linking & Interactions

Link your Vinted account directly in the dashboard to interact with listings without leaving Vintrack:

- **Like / Unlike items** — one-click like/unlike from the feed or monitor view
- **Send Offers** — make price offers directly to sellers (with built-in 60% minimum price validation)
- **Message Sellers** — start a conversation or ask questions instantly
- **Browser-assisted checkout** — Vintrack opens the native Vinted checkout flow in your browser and stores checkout links for recovery
- **Multi-Image Preview** — view extra images and high-res gallery directly in the dashboard
- **Account management** — link/unlink with region selection (12 EU markets)
- **Browser Sync Extension** — automatically refreshes the linked session when you log in to Vinted in the same browser
- **Status monitoring** — see your linked account status, username, and domain at a glance

The recommended linking flow is the browser extension. Install it once, sign in to Vinted in the same browser, then connect it from the Vintrack Account page. Manual token linking still exists as a fallback, but normal users should not need it.

### API Contracts

Internal service contracts live in [`docs/openapi`](./docs/openapi). The first documented contract is the Vinted Service API used by the control center and browser extension.

### Browser Extension

The extension is the easiest way to use linked Vinted accounts on the live demo and in self-hosted installs.

- Chrome download: [vintrack-browser-sync-extension.zip](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip)
- Firefox download: [vintrack-browser-sync-extension-firefox.xpi](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension-firefox.xpi)
- Source: `apps/vintrack-browser-sync-extension`
- Install in Chrome: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extracted extension folder
- Install in Firefox: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select the Firefox build during development. For normal users, publish a Mozilla-signed `.xpi`.
- Connect in Vintrack: open **Account**, click **Download Extension** if needed, then **Link With Installed Extension**
- What it syncs: `access_token_web`, Vinted domain, browser user agent, and the Vintrack light/dark theme
- What it does not sync: the full cookie header or full cookie jar
- Version enforcement: set `BROWSER_EXTENSION_LATEST_VERSION` for the update notice and `BROWSER_EXTENSION_MIN_VERSION` to block outdated or legacy extensions until they are replaced

For distribution, attach `vintrack-browser-sync-extension.zip` and the Mozilla-signed `vintrack-browser-sync-extension-firefox.xpi` to every GitHub release. The live demo and documentation can point to `/releases/latest/download/...`, so users do not need to browse the repo.

### Experimental Buy Disclaimer

Vintrack includes an experimental buy module for controlled checkout tests. It is intentionally separated from the normal monitoring workflow.

- The buy module is experimental and may break when Vinted changes authentication or checkout protection.
- Use a dedicated buy account for this module, not your main personal Vinted account.
- The browser-assisted checkout flow uses the shipping address and checkout context already stored on your linked Vinted account.
- Vintrack opens the native Vinted checkout link; the user chooses the payment method and completes payment manually.
- Vintrack does not replace or override your delivery address or payment method in this flow.
- The extension is strongly recommended, otherwise automatic session recovery may fail.
- Use experimental buy actions only if you understand that Vinted may reserve an item before payment is completed.

### Discord & Telegram Notifications

Rich alerts sent instantly when a new item is found:

- Item image, title, price (including fees), size, condition
- Seller region & rating (enriched via HTML scraping)
- Direct buy link + app deep link + dashboard link
- Discord webhooks per monitor
- Telegram account connection via one-time bot code — users never see the bot token or chat ID
- Per-monitor notification toggles

### Live Feed

Server-Sent Events (SSE) stream items directly to the dashboard in real-time. See every new listing appear the moment it's detected — no manual refresh needed.

### Free Starter Proxy Pools

New users can select **Free Proxy Pool** for Vinted regions currently marked **Ready** in the monitor form. Vintrack manages this pool continuously:

- Imports candidates from configured public proxy sources
- Creates separate health state for each Vinted region
- Validates candidates against Vinted before they enter rotation
- Requires repeated successful checks before activation
- Moves failing proxies into cooldown or marks them dead
- Exposes regional pool health to normal users during monitor creation
- Keeps account actions off the shared pool

The pool is intended for onboarding and short tests, not guaranteed production capacity. Public proxies can disappear or become blocked without notice. For sustained monitoring, use a personal proxy group or configured server proxies.

### Proxy System

Three proxy sources are available:

- **Free Proxy Pool** — shared, health-checked starter capacity for ready regions
- **Server proxies** — shared managed pool for premium users
- **User proxy groups** — BYOP (Bring Your Own Proxies) for dedicated capacity
- Automatic rotation with `tls-client` TLS fingerprint spoofing
- Input validation — garbage lines are silently skipped
- Supports `http://`, `https://`, `socks4://`, `socks5://`, and `host:port:user:pass` formats
- Note: `vinted.co.uk` does not support IPv6 proxies. Use IPv4 proxies for UK monitors.

### Multi-User & Roles

Built-in role system with Discord or OIDC authentication:
| Role | Free Pool* | Server Proxies | Own Proxies | Admin Panel |
|------|:-:|:-:|:-:|:-:|
| **Free** | ✅ | ❌ | ✅ | ❌ |
| **Premium** | ✅ | ✅ | ✅ | ❌ |
| **Admin** | ✅ | ✅ | ✅ | ✅ |

\* Only while the pool is enabled and the selected region is healthy.

---

## Community & Support

Need help, want to exchange setups with other users, or report a bug?

- Join the Vintrack Discord server: https://discord.gg/WbEpEjaWjP
- Use the server for community support, feature feedback, setup questions, and bug reports
- For reproducible code issues, GitHub issues and PRs are still welcome

---

## Screenshots

<p align="center">
  <img src="docs/screenshots/preview.gif" width="720" alt="Preview" />
</p>

<p align="center">
  <img src="docs/screenshots/overview.webp" width="49%" alt="Dashboard" />
  <img src="docs/screenshots/live-feed.webp" width="49%" alt="Live Feed" />
</p>
<p align="center">
  <img src="docs/screenshots/create-monitor.webp" width="49%" alt="Create Monitor" />
  <img src="docs/screenshots/user-management.webp" width="49%" alt="Admin Panel" />
</p>
<p align="center">
  <img src="docs/screenshots/send-message.webp" width="49%" alt="Send Message Dialog" />
  <img src="docs/screenshots/send-offer.webp" width="49%" alt="Send Offer Dialog" />
</p>
<p align="center">
  <img src="docs/screenshots/account.webp" width="49%" alt="Account Page" />
  <img src="docs/screenshots/discord-embed.webp" width="49%" alt="Discord Alert" />
</p>

---

## Architecture

```
                         ┌──────────────────┐
                         │     Internet     │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │      Caddy       │
                         │  (Auto HTTPS)    │
                         └────────┬─────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │      Control Center        │
                    │  Next.js 16 · React 19     │
                    │  Prisma · NextAuth · SSE   │
                    └──┬──────────┬──────────┬───┘
                       │          │          │
          ┌────────────▼──┐  ┌────▼────────┐ │
          │  PostgreSQL   │  │    Redis    │ │
          │   (Storage)   │  │(Cache+Dedup)│ │
          └────────────▲──┘  └──▲────────▲─┘ │
                       │        │        │   │
              ┌────────┴────────┴──┐  ┌──┴───▼──────────┐
              │     Go Worker      │  │ Vinted Service  │
              │ tls-client · proxy │  │ Account linking │
              │  rotation · scrape │  │ Likes · Offers  │
              └──────┬──────────┬──┘  └────────┬────────┘
                     │          │              │
            ┌────────▼──┐  ┌───▼───────┐  ┌───▼────────┐
            │ Vinted API │ │ Alerts    │  │ Vinted API │
            │ (Proxied)  │ │Discord/TG │  │  (Authed)  │
            └────────────  └───────────┘  └────────────┘
```

**Data flow:**

1. User creates a monitor via the dashboard
2. Go Worker detects the new monitor within 5s and starts a goroutine
3. Goroutine polls Vinted API through rotating proxies
4. New items are deduplicated via Redis, stored in PostgreSQL, published via SSE
5. Discord and Telegram notifications fire immediately for configured monitors
6. Users with a linked Vinted account can like items, send offers, and message sellers directly via the Vinted Service

---

## Tech Stack

| Layer              | Technology                                      | Purpose                        |
| ------------------ | ----------------------------------------------- | ------------------------------ |
| **Frontend**       | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui | Dashboard & UI                 |
| **Backend**        | Next.js Server Actions, API Routes              | API & auth                     |
| **Worker**         | Go 1.25, tls-client, goroutines                 | High-perf scraping             |
| **Vinted Service** | Go 1.25, TLS client, Redis sessions             | Account linking & item actions |
| **Database**       | PostgreSQL 15 + Prisma ORM                      | Persistent storage             |
| **Cache**          | Redis 7                                         | Deduplication & SSE pub/sub    |
| **Auth**           | NextAuth.js v5 (Discord + OIDC)                 | Authentication                 |
| **Proxy**          | tls-client with SOCKS4/5 & HTTP(S)              | Anti-detection                 |
| **Reverse Proxy**  | Caddy 2                                         | Auto HTTPS via Let's Encrypt   |
| **Deployment**     | Docker Compose                                  | One-command orchestration      |

---

## Self-Hosting

Use this section if you want to run your own Vintrack instance instead of using the public demo.

### What You Need

Before starting, prepare:

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2
- [Discord Developer App](https://discord.com/developers/applications) (for OAuth2 login) **or** an OIDC provider (e.g. Authentik, Google, Keycloak)
- Optional dedicated proxies for sustained Vinted monitoring (residential recommended). The managed Free Proxy Pool can cover initial tests in ready regions.
- A public HTTPS domain for production
- Optional: a Telegram bot from [@BotFather](https://t.me/BotFather) if you want Telegram notifications

### Proxy Recommendation (Referral)

If you need proxies, I currently recommend **Webshare Proxy Server** as the better option. Webshare also offers a small amount of free proxies, which can be enough for short initial tests.

- Referral link: https://www.webshare.io/?referral_code=qhu9q567qrqp
- You can check your proxies here to see whether they work with Vinted: https://proxy6.net/checker

### 1. Clone the Repository

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor
cd vintrack
```

### 2. Create the Environment File

```bash
cp .env.example .env
```

Edit `.env` and configure at least the required auth values:

```env
# Generate with: openssl rand -base64 32
AUTH_SECRET=your-random-secret

# From Discord Developer Portal
AUTH_DISCORD_ID=your-discord-client-id
AUTH_DISCORD_SECRET=your-discord-client-secret

# Local development
AUTH_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:3000
```

For production, both URLs must use your public HTTPS domain:

```env
AUTH_URL=https://your-domain.com
DASHBOARD_URL=https://your-domain.com
```

`DASHBOARD_URL` is used for dashboard links in notifications. If it is missing or set to `localhost`, Telegram item alerts still send, but the Telegram dashboard button is omitted because Telegram rejects local URLs.

### 3. Configure Discord OAuth

In the Discord Developer Portal:

1. Create an application.
2. Open **OAuth2**.
3. Add your redirect URL:
   - Local: `http://localhost:3000/api/auth/callback/discord`
   - Production: `https://your-domain.com/api/auth/callback/discord`
4. Copy the client ID and client secret into `.env`.

### 3b. Configure OIDC (Optional)

If you want to use an OIDC-compliant identity provider (Authentik, Google, Keycloak, etc.) instead of Discord:

1. Create an application in your OIDC provider.
2. Set the callback URL:
   - Local: `http://localhost:3000/api/auth/callback/oidc`
   - Production: `https://your-domain.com/api/auth/callback/oidc`
3. Add the following to your `.env` file:

```env
AUTH_OIDC_ISSUER=https://your-oidc-provider.com/application/o/your-app/
AUTH_OIDC_CLIENT_ID=your-oidc-client-id
AUTH_OIDC_CLIENT_SECRET=your-oidc-client-secret
AUTH_OIDC_NAME=Authentik
```

The `AUTH_OIDC_NAME` value is the display name shown on the login button (defaults to "SSO"). When all three OIDC variables are set, OIDC replaces Discord as the login method — the Discord button is hidden and Discord env vars are ignored. Existing Discord-only installations are unaffected as long as the OIDC variables are not set.

If you switch an existing installation from Discord to OIDC, existing Discord accounts are not automatically linked to OIDC accounts. Make sure at least one administrator can sign in through the new provider, or update the relevant user role in the database after the first OIDC login.

### 4. Configure Proxy Sources

After the first admin login, open **Admin Panel → Settings** to enable the Free Proxy Pool, choose import sources and starter regions, and set validation thresholds. The worker continuously imports, validates, cools down, and rotates candidates.

For dedicated capacity, add one proxy per line:

```bash
nano apps/worker/proxies.txt
```

Example:

```txt
http://user:pass@host:port
```

Users can add personal proxy groups from the dashboard. Premium and admin users can use server proxies when configured. Any user can select the Free Proxy Pool when the feature is enabled and the monitor region is healthy.

### 5. Start Vintrack

```bash
docker compose up -d --build
```

Open:

```txt
http://localhost:3000
```

### Environment Variables Reference

The most important variables are:

```env
# Required — generate with: openssl rand -base64 32
AUTH_SECRET=your-random-secret

# Required — from Discord Developer Portal
AUTH_DISCORD_ID=your-discord-client-id
AUTH_DISCORD_SECRET=your-discord-client-secret

# Required in production — public app URL used by auth and dashboard links
AUTH_URL=https://your-domain.com
DASHBOARD_URL=https://your-domain.com

# Optional — OIDC authentication (replaces Discord, e.g. Authentik, Google, Keycloak)
# Uncomment and set all three required values to use OIDC instead of Discord.
# AUTH_OIDC_ISSUER=https://your-oidc-provider.com/application/o/your-app/
# AUTH_OIDC_CLIENT_ID=your-oidc-client-id
# AUTH_OIDC_CLIENT_SECRET=your-oidc-client-secret
# AUTH_OIDC_NAME=Authentik

# Optional — Telegram notifications
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_BOT_USERNAME=your_bot_username_without_at
TELEGRAM_WEBHOOK_SECRET=your-random-webhook-secret

# Optional — bounded operational telemetry retention
MONITOR_RUN_RETENTION_HOURS=24
MONITOR_RUN_STATS_RETENTION_DAYS=90
```

### Telegram Setup for Self-Hosted Instances

Telegram support uses a secure connect-code flow. The bot token stays on the server; users connect from the dashboard by sending a generated `/connect VT-...` command to your bot.

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. Set these variables in the root `.env`:

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_BOT_USERNAME=your_bot_username_without_at
TELEGRAM_WEBHOOK_SECRET=your-random-webhook-secret
```

3. Make sure `DASHBOARD_URL` points to your public HTTPS dashboard:

```env
DASHBOARD_URL=https://your-domain.com
```

4. After deploying Vintrack on HTTPS, register the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://your-domain.com/api/telegram/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

5. Verify delivery:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

6. In Vintrack, open a monitor's notification dialog, click **Connect Telegram**, send the generated command to the bot shown in the dialog, then enable Telegram for that monitor.

Users do not need to know the bot token or chat ID. They only need the bot username shown in Vintrack and the one-time connect command.

### Local Telegram Testing

Telegram webhooks require a public HTTPS URL. For local testing, expose `localhost:3000` with ngrok or Cloudflare Tunnel.

Example with an ngrok URL:

```env
AUTH_URL=http://localhost:3000
DASHBOARD_URL=https://your-ngrok-subdomain.ngrok-free.dev
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_BOT_USERNAME=your_bot_username_without_at
TELEGRAM_WEBHOOK_SECRET=your-random-webhook-secret
```

Then register the webhook against the tunnel URL:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://your-ngrok-subdomain.ngrok-free.dev/api/telegram/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Recreate the services after changing `.env`:

```bash
docker compose up -d --force-recreate control-center worker
```

### Production Deployment

For a first production deployment from the published images:

```bash
docker compose pull
docker compose up -d
```

If you want to build the images directly on the server instead:

```bash
docker compose up -d --build
```

Make sure your domain points to the server and ports `80` and `443` are available for Caddy.

### Production Updates & Database Migrations

For release updates on a server, pull the new images and run the migration service before recreating the app services:

```bash
git pull
docker compose pull
docker compose up --force-recreate control-center-migrate
docker compose up -d --force-recreate control-center worker vinted-service caddy
```

The `control-center-migrate` service uses the same pulled `control-center` image and runs `npx prisma migrate deploy`, so new Prisma migrations are applied even when deploying with `docker compose pull`.

Do not use `prisma db push --accept-data-loss` in production. Schema changes should be represented as committed Prisma migrations.

### Proxy Formats

Vintrack accepts multiple proxy formats (one per line in `apps/worker/proxies.txt`):

```
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass
host:port
```

Invalid lines are automatically skipped with a warning in logs.

---

## Roadmap

- [x] Vinted Account Linking
- [x] Like / Unlike items
- [x] Send offers to sellers
- [x] Send messages to sellers
- [x] One-click buy
- [ ] Auto-buy with price rules
- [ ] Auto Chat Module
- [ ] Price history tracking & charts
- [ ] Saved searches / favorites
- [ ] Rate limiting per user
- [ ] API tokens for external integrations
- [ ] Mobile app (React Native)

---

## Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please make sure to:

- Follow existing code style
- Test your changes with `docker compose up --build`
- Update documentation if needed

---

## Acknowledgements

- [vinted-dataset](https://github.com/teddy-vltn/vinted-dataset) by [@teddy-vltn](https://github.com/teddy-vltn) — Categories, brands, and sizes data used in the filter system

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  <sub>Built with ❤️ for the reselling community</sub><br/>
  <sub>If Vintrack helped you catch a deal, consider giving it a ⭐</sub>
</p>
