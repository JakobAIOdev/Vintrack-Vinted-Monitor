<p align="center">
  <img src="https://cdn-icons-png.flaticon.com/512/8266/8266540.png" width="80" alt="Vintrack Logo" />
</p>

<h1 align="center">Vintrack</h1>

<p align="center">
  <strong>The fastest Vinted monitor for resellers.</strong><br/>
  Real-time scraping, instant Discord alerts, and a sleek control center.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js" />
  <img src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" alt="Go" />
  <img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker" />
</p>

---

## Overview

Vintrack monitors Vinted listings in real-time and notifies you the moment a matching item appears — before anyone else sees it. Built for resellers who need speed.

**Control Center** — A Next.js dashboard to create monitors, view found items, and manage Discord webhooks.  
**Worker** — A high-performance Go scraper that polls the Vinted API with proxy rotation, deduplication via Redis, and seller enrichment (region & rating).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                      Caddy                          │
│              (HTTPS / Reverse Proxy)                │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  Control Center │
              │   (Next.js 16)  │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
   ┌──────▼──────┐ ┌──▼───┐ ┌─────▼─────┐
   │  PostgreSQL  │ │Redis │ │   Worker   │
   │   (Storage)  │ │(Cache)│ │   (Go)    │
   └──────────────┘ └──────┘ └─────┬─────┘
                                   │
                          ┌────────▼────────┐
                          │   Vinted API    │
                          │  (via Proxies)  │
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │ Discord Webhooks│
                          └─────────────────┘
```

## Features

- **Real-time monitoring** — Configurable polling interval (default 1.5s per monitor)
- **Advanced filters** — Search query, price range, sizes, categories, brands
- **Multi-region scraping** — Seller location & rating enrichment via HTML scraping
- **Proxy rotation** — TLS fingerprint spoofing with `tls-client` to avoid detection
- **Redis deduplication** — Never get duplicate alerts for the same item
- **Discord webhooks** — Rich embed notifications with buy links, images, and metadata
- **Auth via Discord** — OAuth2 login through NextAuth.js
- **Live feed** — Server-Sent Events (SSE) stream for real-time item updates in the dashboard
- **Dockerized** — One command to deploy everything with `docker compose`

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Dashboard | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui |
| Worker | Go 1.25, tls-client, goroutines |
| Database | PostgreSQL 15 + Prisma ORM |
| Cache | Redis 7 (deduplication & rate limiting) |
| Auth | NextAuth.js v5 (Discord OAuth2) |
| Reverse Proxy | Caddy (automatic HTTPS) |
| Deployment | Docker Compose |

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- Discord OAuth2 app ([create one here](https://discord.com/developers/applications))

### 1. Clone the repo

```bash
git clone https://github.com/your-username/vintrack-v2.git
cd vintrack-v2
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
AUTH_SECRET=your-random-secret-here        # openssl rand -base64 32
AUTH_DISCORD_ID=your-discord-client-id
AUTH_DISCORD_SECRET=your-discord-client-secret
```

### 3. Add proxies

Add your proxies (one per line) to `apps/worker/proxies.txt`:

```
http://user:pass@host:port
socks5://user:pass@host:port
```

### 4. Deploy

```bash
docker compose up -d --build
```

The app will be available at `http://localhost:3000`.

### Production (with HTTPS)

The included Caddy reverse proxy handles automatic HTTPS via Let's Encrypt. Point your domain's A record to your server IP and update the `Caddyfile`:

```
yourdomain.com {
    reverse_proxy control-center:3000
}
```

## Project Structure

```
vintrack-v2/
├── docker-compose.yml          # Full stack orchestration
├── Caddyfile                   # Reverse proxy config
│
├── apps/
│   ├── control-center/         # Next.js dashboard
│   │   ├── prisma/             # Database schema & migrations
│   │   └── src/
│   │       ├── actions/        # Server actions (monitor CRUD)
│   │       ├── app/            # App router pages
│   │       ├── components/     # UI components (shadcn/ui)
│   │       └── lib/            # Utilities, DB client, constants
│   │
│   └── worker/                 # Go scraping engine
│       └── internal/
│           ├── cache/          # Redis client
│           ├── database/       # PostgreSQL store
│           ├── discord/        # Webhook sender
│           ├── model/          # Shared types
│           ├── pipeline/       # Monitor lifecycle manager
│           ├── proxy/          # Proxy rotation
│           └── scraper/        # Vinted API client & HTML scraper
```

## How It Works

1. **Create a monitor** via the dashboard — set a search query, optional filters (price, size, category, brand), and a Discord webhook URL.

2. The **Go worker** picks up the monitor and starts polling the Vinted API at the configured interval using the built URL with all filter parameters.

3. Each result is checked against **Redis** to avoid duplicates. New items get stored in **PostgreSQL**.

4. If the monitor has a webhook configured, a **rich Discord embed** is sent immediately with the item's title, price, image, size, condition, seller location, and direct buy link.

5. The dashboard shows a **live feed** via SSE and per-monitor item history.

## License

This project is for personal use.
