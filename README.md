<p align="center">
  <img src="https://cdn-icons-png.flaticon.com/512/8266/8266540.png" width="90" alt="Vintrack" />
</p>

<h1 align="center">Vintrack</h1>

<p align="center">
  <strong>Catch the right Vinted listings before the feed moves on.</strong>
  <br />
  A self-hosted monitoring stack with fast Go workers, a live dashboard, regional proxy health,
  Discord and Telegram alerts, and optional linked-account actions.
</p>

<p align="center">
  <a href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JakobAIOdev/Vintrack-Vinted-Monitor/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI status" /></a>
  <a href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest"><img src="https://img.shields.io/github/v/release/JakobAIOdev/Vintrack-Vinted-Monitor?display_name=tag&style=for-the-badge&logo=github" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/JakobAIOdev/Vintrack-Vinted-Monitor?style=for-the-badge&color=22c55e" alt="MIT license" /></a>
  <a href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/stargazers"><img src="https://img.shields.io/github/stars/JakobAIOdev/Vintrack-Vinted-Monitor?style=for-the-badge&logo=github&color=fbbf24" alt="GitHub stars" /></a>
  <a href="https://discord.gg/WbEpEjaWjP"><img src="https://img.shields.io/badge/Discord-join%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord community" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/Go-workers-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go workers" />
  <img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL 15" />
  <img src="https://img.shields.io/badge/Redis-7-FF4438?style=flat-square&logo=redis&logoColor=white" alt="Redis 7" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Compose" />
</p>

<p align="center">
  <a href="https://vintrack.jakobaio.dev"><strong>Live demo</strong></a>
  ·
  <a href="#self-host-in-five-minutes"><strong>Self-host</strong></a>
  ·
  <a href="docs/getting-started.md"><strong>Documentation</strong></a>
  ·
  <a href="https://discord.gg/WbEpEjaWjP"><strong>Community</strong></a>
  ·
  <a href="https://github.com/sponsors/JakobAIOdev"><strong>Sponsor</strong></a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/JakobAIOdev">
    <img src="https://img.shields.io/badge/Sponsor-Vintrack-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Sponsor Vintrack" />
  </a>
</p>

---

<p align="center">
  <a href="docs/screenshots/product-preview.mp4">
    <img src="docs/screenshots/product-preview.webp" width="900" alt="Animated Vintrack live feed product preview" />
  </a>
  <br />
  <sub>Product tour preview · click to open the MP4</sub>
</p>

## At a glance

- **⚡ Fast monitoring** — run isolated regional catalog sessions with bounded
  attempts, delayed hedging, and Redis-backed deduplication.
- **🎯 Precise filters** — target query, price, category, brand, color, size,
  condition, seller country, and Vinted market.
- **🔔 Alerts where you are** — send rich matches to the live dashboard,
  Discord webhooks, or connected Telegram chats.
- **🌍 Observable proxy pools** — use personal, server-managed, or optional
  health-scored starter pools with regional readiness.
- **🛍️ Optional account actions** — link an account you control to like items,
  send offers, message sellers, and open native checkout.
- **🏠 Built to self-host** — deploy the complete stack with Docker Compose,
  Caddy, PostgreSQL, Redis, and forward-only migrations.

Vintrack is an open-source platform for monitoring new Vinted listings. Create
targeted monitors, process catalog updates through isolated Go workers, and
deliver matching items wherever you can act on them fastest.

> [!IMPORTANT]
> Vintrack is an independent project. It is not affiliated with, endorsed by,
> or operated by Vinted. Use it lawfully, respect platform limits, and only
> connect accounts you are authorized to use.

## Start here

| I want to… | Go here |
| --- | --- |
| See Vintrack without installing anything | [Try the live demo](#try-the-live-demo) |
| Run my own instance | [Self-host in five minutes](#self-host-in-five-minutes) |
| Understand the moving parts | [Architecture](#architecture) |
| Configure auth, proxies, alerts, and tuning | [Configuration guide](docs/configuration.md) |
| Configure GitHub login and 3/5/15 rewards | [GitHub rewards guide](docs/github-rewards.md) |
| Develop or contribute | [Development guide](docs/development.md) · [Contributing](CONTRIBUTING.md) |
| Fix a broken deployment | [Troubleshooting guide](docs/troubleshooting.md) |

<details>
<summary><strong>Full README contents</strong></summary>

- [Try the live demo](#try-the-live-demo)
- [Self-host in five minutes](#self-host-in-five-minutes)
- [Feature overview](#feature-overview)
- [Product tour](#product-tour)
- [Architecture](#architecture)
- [Technology](#technology)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Responsible use](#responsible-use)
- [Contributing and support](#contributing-and-support)
- [License](#license)

</details>

## Try the live demo

Open **[vintrack.jakobaio.dev](https://vintrack.jakobaio.dev)** and sign in with
Discord or GitHub. Existing Discord members link GitHub from **Account**. New
users start with the Free role and can create monitors using their
own proxies or a shared starter pool when a region is marked ready.

The demo is shared, best-effort infrastructure rather than an SLA-backed hosted
service. Pool health and regional availability can change. Linked-account
actions never use the shared free proxy pool.

### Demo quick start

1. Sign in with Discord and open **Monitors**.
2. Create a monitor and choose the matching Vinted market, for example
   `vinted.de`, `vinted.fr`, or `vinted.it`.
3. Add the search query and any price, category, brand, color, size, condition,
   or seller-country filters.
4. Select **Free Proxy Pool** when the region is marked ready, or use a personal
   proxy group for dedicated capacity.
5. Enable notifications:
   - **Discord:** paste a webhook URL into the monitor's notification dialog.
   - **Telegram:** select **Connect Telegram** and send the generated one-time
     command to the bot shown in Vintrack.
   - In **Dashboard settings**, choose `Rich` or `Compact` independently for
     Discord and Telegram item alerts. Compact alerts use a thumbnail or small
     preview when supported while keeping the title, price, size, condition,
     region, rating, and item link.
6. Watch matching listings in the monitor view, live feed, Discord, or Telegram.

Optionally install the browser extension and open **Account → Link With Installed
Extension** to connect a Vinted account you control.

### Demo notes

- Free-pool availability and supported regions depend on current health checks.
- Personal proxy groups are the reliable choice for dedicated capacity.
- Telegram users never need the bot token or a numeric chat ID.
- Discord alerts require a webhook created in a server you are authorized to
  manage.
- Account linking is optional and is required only for likes, offers, messages,
  wardrobe access, and checkout-link tools.
- The extension syncs limited session information; it does not upload the full
  browser cookie jar.
- The demo can enforce role-based resource limits because it is shared
  infrastructure. Self-hosted operators control their own policy.

[Read the five-minute demo walkthrough →](docs/getting-started.md#try-the-live-demo)

## Self-host in five minutes

### Requirements

- Docker Engine with Docker Compose v2
- Git
- `make` and OpenSSL for the guided initializer
- a Discord OAuth application **or** an OIDC provider
- a public domain with ports 80/443 for production HTTPS

### Start locally

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor.git vintrack
cd vintrack
make init
```

`make init` creates `.env`, generates the two required encryption secrets, and
creates the local proxy file. It never replaces an existing `.env` or changes
non-placeholder secrets; missing or template secret values are filled in.

Start the low-power local stack (Discord OAuth or OIDC credentials are not
required for this development mode):

```bash
make dev
```

This uses an automatically signed-in local admin, synthetic free-proxy pools,
safe test monitors, isolated development data, a deterministic mock catalog,
serial cached builds, and resource-capped containers. Run `make up` only when
you intentionally need the full live/production-like worker stack and normal
authentication.

Open [http://localhost:3000](http://localhost:3000), which matches the default
`AUTH_URL`. Caddy also exposes [http://localhost](http://localhost); if you use
that as the canonical local URL, change `AUTH_URL`, `DASHBOARD_URL`, and the
identity-provider callback to the same origin.

For Discord OAuth, register:

```text
http://localhost:3000/api/auth/callback/discord
```

For OIDC, use:

```text
http://localhost:3000/api/auth/callback/oidc
```

A production deployment must use the same public hostname in `AUTH_URL`,
`DASHBOARD_URL`, `VINTRACK_SITE_ADDRESS`, and the identity-provider callback.
Keep `AUTH_SECRET` and `VINTED_SESSION_ENCRYPTION_KEY` stable after the instance
contains users or linked sessions.

For a public deployment, read the complete
[Getting Started](docs/getting-started.md#self-host-vintrack) and
[Configuration](docs/configuration.md) guides before exposing the service.

<details>
<summary><strong>Production deployment and update checklist</strong></summary>

Before the first deployment:

- point the public hostname to the server;
- expose ports 80 and 443 to Caddy;
- use public HTTPS URLs for auth and notification links;
- configure the production OAuth/OIDC callback;
- protect and back up `.env`;
- configure reliable proxy capacity and conservative monitor intervals;
- validate with `docker compose config --quiet`.

Start from published images:

```bash
docker compose pull
docker compose up -d
```

For updates, back up PostgreSQL and `.env`, then apply committed migrations
before recreating the application services:

```bash
git pull --ff-only
docker compose pull
docker compose up --force-recreate control-center-migrate
docker compose up -d --force-recreate control-center worker vinted-service caddy
```

Vintrack uses `prisma migrate deploy`. Do not use
`prisma db push --accept-data-loss` against production.

</details>

## Feature overview

| Area | Capabilities |
| --- | --- |
| Monitoring | Per-monitor intervals, regional catalog sessions, local matching, delayed request hedging, Redis deduplication |
| Filters | Query, price, category, brand, color, size, condition, seller country, Vinted market |
| Alerts | Rich Discord embeds, Telegram bot connections, per-monitor notification controls |
| Dashboard | Monitor management, live feed, operational overview, roles, proxy pool health |
| Proxies | HTTP(S), SOCKS4/5, authenticated formats, user groups, shared pools, regional validation and cooldown |
| Account actions | Optional session linking, likes, offers, messages, image galleries, browser-assisted checkout |
| Identity | Discord OAuth or standards-based OIDC, role-based Free/Premium/Admin access |
| Operations | Docker Compose, Caddy HTTPS, PostgreSQL migrations, bounded logs and telemetry retention |

### Monitoring and filters

Each monitor keeps its canonical regional Vinted search. The worker maintains
isolated catalog sessions, performs bounded attempts, and uses Redis to
atomically deduplicate new listings before persistence and alert delivery.

Monitor filters include:

- text search;
- minimum and maximum price;
- categories and subcategories;
- brands;
- colors;
- clothing and shoe sizes;
- item condition;
- seller country;
- Vinted market or region.

An optional query-free discovery path can match keywords locally against the
same catalog filters. It is disabled by default and should be evaluated in
shadow mode before active use.

### Alerts and live feed

New matches can appear in the SSE-powered dashboard feed and in either alert
channel:

- **Discord:** per-monitor webhooks with image, title, item price, total price,
  size, condition, seller details, and direct links.
- **Telegram:** users connect to the operator's bot with a one-time code and can
  enable delivery per monitor.

Each account can select `Rich` or `Compact` item alerts independently for
Discord and Telegram from **Dashboard settings**. Existing accounts default to
the current rich format.

Notification delivery uses bounded worker pools so slow webhooks do not block
catalog processing.

### Linked-account actions

An explicitly linked Vinted account enables:

- like and unlike actions from item cards;
- price offers with built-in minimum-price validation;
- new seller conversations and replies;
- wardrobe and liked-item views;
- multi-image previews and higher-resolution galleries;
- browser-assisted checkout links with recovery history;
- account status and regional-domain visibility.

Linked-account actions are handled by the separate Vinted service and never use
the shared free proxy pool.

### Browser extension

The browser extension is the recommended way to link an account you are
authorized to use. It syncs the Vinted web access token, selected domain,
account ID/display name for mismatch protection, and, with Firefox permission,
the browser user agent. The theme stays in local extension storage. It does
**not** copy the complete cookie jar or browser refresh token.

- [Chrome ZIP](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/vintrack-browser-sync/)
- [Extension documentation](apps/vintrack-browser-sync-extension/README.md)
- [Extension privacy policy](docs/browser-extension-privacy.md)

For Chrome, extract the ZIP, open `chrome://extensions`, enable **Developer
mode**, and select **Load unpacked**. Firefox users install the Mozilla-signed
version from AMO so it persists across browser restarts. Temporary Firefox
loading through `about:debugging#/runtime/this-firefox` is only for development.

Account actions and checkout support are optional and can break when upstream
authentication or checkout flows change. Use a dedicated test account, review
each action, and complete purchases in Vinted's native checkout.

### Experimental checkout boundary

Vintrack does not replace Vinted's payment or delivery flow. It prepares or
stores a native checkout link, opens that link in the browser, and leaves
payment method selection and final confirmation to the user. Upstream changes
can break this experimental module, and an item may be reserved before payment
is completed.

### Free starter proxy pools

When enabled by an administrator, supported regions can expose a shared starter
pool to normal users. The proxy-maintainer worker:

- imports candidates from configured public sources;
- keeps independent health state per Vinted region;
- validates candidates against the selected regional catalog;
- requires repeated successful checks before activation;
- places failing routes into cooldown and retires persistently dead entries;
- publishes regional readiness to the monitor form;
- uses bounded validation batches to protect the database and worker host.

The free pool is intended for onboarding and short evaluations. Public routes
can disappear, change IP, become slow, or lose upstream access without notice.
It is not used for linked-account actions.

### Proxy sources and behavior

Vintrack supports three operational sources:

1. **Free Proxy Pool** — optional shared starter capacity for healthy regions.
2. **Server proxies** — an operator-managed shared pool for eligible roles.
3. **Personal proxy groups** — user-provided, dedicated capacity.

Accepted static formats in `apps/worker/proxies.txt` include:

```text
http://user:pass@host:port
https://user:pass@host:port
socks4://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass
host:port
```

Invalid lines are skipped. UK monitors require IPv4 proxies.

The worker keeps dedicated clients on stable proxy sessions, processes canonical
catalog searches, and can optionally evaluate a query-free discovery feed.
Health state, cooldowns, and per-region availability determine which shared
proxies may enter rotation.

Shared public proxies are useful for evaluation, not guaranteed production
capacity. Sustained deployments should use proxies the operator controls and
monitor regional health.

#### Optional proxy provider

Vintrack is provider-agnostic and works with supported proxy formats from any
provider. If you need a starting point, the maintainer currently uses
[Webshare Proxy Server](https://www.webshare.io/?referral_code=qhu9q567qrqp).
Webshare may also offer limited free capacity for initial tests.

> **Referral disclosure:** The Webshare URL is a referral link and may support
> Vintrack at no additional cost to you. Webshare is optional; review current
> pricing, regions, limits, and terms before purchasing.

You can test whether a proxy can reach Vinted with the
[Proxy6 checker](https://proxy6.net/checker). Treat third-party checkers as
external services and never submit reusable credentials unless you trust their
data-handling policy.

- [Worker performance and discovery](docs/worker-speed.md)
- [Pre-index shadow experiment](docs/preindex-shadow.md)
- [Complete proxy configuration](docs/configuration.md#proxy-sources)

### Roles and access

| Role | Free Pool* | Server Proxies | Personal Proxies | Admin Panel |
| --- | :---: | :---: | :---: | :---: |
| **Free** | Yes | No | Yes | No |
| **Premium** | Yes | Yes | Yes | No |
| **Admin** | Yes | Yes | Yes | Yes |

\* Available only when enabled and healthy for the selected region. Operators
can define additional resource policy for their own deployment.

## Product tour

<p align="center">
  <img src="docs/screenshots/dashboard-overview.webp" width="49%" alt="Vintrack dashboard overview" />
  <img src="docs/screenshots/live-feed.webp" width="49%" alt="Real-time listing feed" />
</p>
<p align="center">
  <img src="docs/screenshots/create-monitor.webp" width="49%" alt="Monitor creation form" />
  <img src="docs/screenshots/monitor-details.webp" width="49%" alt="Monitor details and matching listings" />
</p>
<p align="center">
  <img src="docs/screenshots/proxy-groups.webp" width="49%" alt="Proxy group management" />
  <img src="docs/screenshots/admin-panel.webp" width="49%" alt="Administration panel" />
</p>
<p align="center">
  <img src="docs/screenshots/linked-account.webp" width="49%" alt="Linked Vinted account" />
  <img src="docs/screenshots/account-listings.webp" width="49%" alt="Vinted account listings" />
</p>
<p align="center">
  <img src="docs/screenshots/conversations.webp" width="49%" alt="Vinted account conversations" />
  <img src="docs/screenshots/send-message.webp" width="49%" alt="Seller message dialog" />
</p>
<p align="center">
  <img src="docs/screenshots/send-offer.webp" width="49%" alt="Price offer dialog" />
</p>
<p align="center">
  <img src="docs/screenshots/browser-extension.webp" width="30%" alt="Vintrack browser session sync extension" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/screenshots/discord-embed.webp" width="36%" alt="Discord listing notification" />
</p>

## Architecture

```mermaid
flowchart LR
    Browser["Browser / Extension"] --> Caddy["Caddy"]
    Caddy --> Web["Control Center<br/>Next.js"]
    Web --> DB[("PostgreSQL")]
    Web <--> Redis[("Redis")]
    Worker["Go Worker"] --> DB
    Worker <--> Redis
    Worker --> Catalog["Vinted catalog"]
    Worker --> Alerts["Discord / Telegram"]
    Web --> Service["Vinted Service<br/>Go"]
    Service --> DB
    Service <--> Redis
    Service --> Actions["Authorized account actions"]
```

1. The control center stores monitor configuration in PostgreSQL.
2. Go workers fetch catalog data through configured regional sessions.
3. Redis coordinates deduplication, caching, and live-feed events.
4. Matching listings are persisted and dispatched to enabled alert channels.
5. The separate Vinted service handles explicitly linked account actions.

[Explore components, trust boundaries, and data flow →](docs/architecture.md)

## Technology

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Web | Next.js 16, React 19, Tailwind CSS 4 | Dashboard, APIs, auth, and live feed |
| Worker | Go, `tls-client`, goroutines | Catalog sessions, matching, proxy health, and alerts |
| Account service | Go, `tls-client` | Linked sessions and authorized item actions |
| Database | PostgreSQL 15, Prisma | Persistent application and operational state |
| Coordination | Redis 7 | Deduplication, cache, pub/sub, and session-adjacent state |
| Identity | Auth.js / NextAuth v5 | Discord OAuth and optional OIDC |
| Edge | Caddy 2 | Reverse proxy and automatic HTTPS |
| Operations | Docker Compose | Service orchestration and migrations |

Internal service contracts are documented in
[OpenAPI](docs/openapi/README.md).

## Repository layout

```text
apps/
├── control-center/                 Next.js dashboard, auth, API, and Prisma
├── worker/                         Catalog monitoring and proxy maintenance
├── vinted-service/                 Linked-account actions
├── id-scanner/                     Standalone experimental utility
└── vintrack-browser-sync-extension/
docs/                               Setup, operations, API, and design notes
requests/                           Example request payloads
scripts/                            Initialization and validation helpers
```

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Live demo, local setup, and production deployment |
| [Configuration](docs/configuration.md) | Authentication, URLs, notifications, proxies, and tuning |
| [Architecture](docs/architecture.md) | Components, data flow, and security boundaries |
| [Development](docs/development.md) | Local workflows, mock data, tests, and project conventions |
| [Troubleshooting](docs/troubleshooting.md) | Logs, startup failures, auth, proxy, and migration issues |
| [Testing](docs/testing.md) | Unit, build, and end-to-end validation |
| [OpenAPI](docs/openapi/README.md) | Internal Vinted service contract |

## Responsible use

Vintrack is intended for lawful, authorized monitoring and account automation.
You are responsible for your deployment, request rate, data handling, and
compliance with applicable law and third-party terms.

Do not use Vintrack to bypass authentication barriers, CAPTCHAs, rate limits, or
other access controls. Never commit session tokens, cookies, OAuth secrets,
webhook URLs, proxy credentials, database dumps, or personal data.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Contributing and support

Bug reports, focused features, documentation, and tests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request.

- [GitHub Issues](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/issues)
- [Vintrack Discord](https://discord.gg/WbEpEjaWjP)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Acknowledgements

Category, brand, and size data is based on
[vinted-dataset](https://github.com/teddy-vltn/vinted-dataset) by
[@teddy-vltn](https://github.com/teddy-vltn).

## License

Vintrack is available under the [MIT License](LICENSE).

<p align="center">
  <sub>If Vintrack is useful to you, a star or contribution helps the project reach more builders.</sub>
</p>
