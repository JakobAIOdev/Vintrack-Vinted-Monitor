<p align="center">
  <img src="https://cdn-icons-png.flaticon.com/512/8266/8266540.png" width="90" alt="Vintrack" />
</p>

<h1 align="center">Vintrack</h1>

<p align="center">
  <b>Open-source Vinted monitoring platform for resellers.</b><br/>
  Real-time scraping · Instant Discord alerts · Proxy rotation · Beautiful dashboard
</p>

<p align="center">
  <a href="#features"><img src="https://img.shields.io/badge/monitors-unlimited-22c55e?style=flat-square" alt="Monitors" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Next.js-16-000?style=flat-square&logo=next.js" alt="Next.js" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Go-1.25-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" /></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/deploy-one_command-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" /></a>
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> •
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#screenshots">Screenshots</a> •
  <a href="#self-hosting">Self-Hosting</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## Why Vintrack?

Vinted doesn't have a proper notification system — you either refresh manually or miss the deal. Vintrack solves this by monitoring listings **every 1.5 seconds** and sending alerts to Discord **before anyone else** can see the item.

Built for resellers who need speed. Open-sourced for the community.

- **Sub-2s detection** — catch items faster than any other tool
- **Anti-detection** — TLS fingerprint rotation with proxy support
- **Granular filters** — price, size, category, brand, and more
- **Full dashboard** — no CLI needed, everything from the browser
- **One-command deploy** — `docker compose up` and you're live

---

## Features

### Real-Time Monitoring
Create unlimited monitors with custom search queries. Each monitor polls the Vinted API independently with configurable intervals (default: 1.5s). Results are deduplicated via Redis — you'll never see the same item twice.

### Advanced Filters
Fine-tune every monitor with:
- **Search query** — keyword-based filtering
- **Price range** — min/max price boundaries
- **Categories** — over 900+ Vinted categories supported
- **Brands** — filter by specific brands
- **Sizes** — clothing size filtering

### Discord Notifications
Rich embed webhooks sent instantly when a new item is found:
- Item image, title, price, size, condition
- Seller region & rating (enriched via HTML scraping)
- Direct buy link + app deep link + dashboard link
- Per-webhook toggle — pause without deleting

### Live Feed
Server-Sent Events (SSE) stream items directly to the dashboard in real-time. See every new listing appear the moment it's detected — no manual refresh needed.

### Proxy System
Two-tier proxy architecture designed for scale:
- **Server proxies** — shared pool for premium users
- **User proxy groups** — BYOP (Bring Your Own Proxies) for free users
- Automatic rotation with `tls-client` TLS fingerprint spoofing
- Input validation — garbage lines are silently skipped
- Supports `http://`, `https://`, `socks4://`, `socks5://`, and `host:port:user:pass` formats

### Multi-User & Roles
Built-in role system with Discord OAuth:
| Role | Server Proxies | Own Proxies | Admin Panel |
|------|:-:|:-:|:-:|
| **Free** | ❌ | ✅ | ❌ |
| **Premium** | ✅ | ✅ | ❌ |
| **Admin** | ✅ | ✅ | ✅ |

### Admin Dashboard
Manage all users from a dedicated admin panel:
- View all registered users with stats
- Change roles (Free → Premium → Admin) in one click
- Monitor and proxy group counts per user

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
  <img src="docs/screenshots/create.webp" width="49%" alt="Create Monitor" />
  <img src="docs/screenshots/user-management.webp" width="49%" alt="Admin Panel" />
</p>
<p align="center">
  <img src="docs/screenshots/discord-embed.webp" width="49%" alt="Discord Alert" />
</p>

---

## Architecture

```
                         ┌──────────────────┐
                         │     Internet      │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │      Caddy        │
                         │  (Auto HTTPS)     │
                         └────────┬─────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │      Control Center         │
                    │  Next.js 16 · React 19      │
                    │  Prisma · NextAuth · SSE     │
                    └──────┬──────────┬──────────┘
                           │          │
              ┌────────────▼──┐  ┌────▼────────────┐
              │  PostgreSQL   │  │     Redis        │
              │   (Storage)   │  │ (Cache + Pub/Sub)│
              └────────────▲──┘  └────▲────────────┘
                           │          │
                    ┌──────┴──────────┴──────────┐
                    │         Go Worker           │
                    │  tls-client · goroutines    │
                    │  proxy rotation · enrichment│
                    └──────┬──────────┬──────────┘
                           │          │
                  ┌────────▼──┐  ┌────▼────────────┐
                  │ Vinted API │  │    Discord       │
                  │ (Proxied)  │  │   (Webhooks)     │
                  └────────────┘  └─────────────────┘
```

**Data flow:**
1. User creates a monitor via the dashboard
2. Go Worker detects the new monitor within 5s and starts a goroutine
3. Goroutine polls Vinted API through rotating proxies
4. New items are deduplicated via Redis, stored in PostgreSQL, published via SSE
5. Discord webhooks fire immediately for configured monitors

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui | Dashboard & UI |
| **Backend** | Next.js Server Actions, App Router | API & auth |
| **Worker** | Go 1.25, tls-client, goroutines | High-perf scraping |
| **Database** | PostgreSQL 15 + Prisma ORM | Persistent storage |
| **Cache** | Redis 7 | Deduplication & SSE pub/sub |
| **Auth** | NextAuth.js v5 (Discord OAuth2) | Authentication |
| **Proxy** | tls-client with SOCKS4/5 & HTTP(S) | Anti-detection |
| **Reverse Proxy** | Caddy 2 | Auto HTTPS via Let's Encrypt |
| **Deployment** | Docker Compose | One-command orchestration |

---

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2
- [Discord Developer App](https://discord.com/developers/applications) (for OAuth2 login)
- Proxies (residential recommended)

### Proxy Recommendation (Referral)

If you need affordable proxies, I can recommend **IPv6 proxies from Proxy6** — they are low-cost and come with **no data limit**.

- Referral link: https://proxy6.net/?r=864123
- Alternative referral link: https://proxy6.net/a/864123
- Affiliate code: `DHCenDeFUI`

### Quick Start

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/vintrack.git
cd vintrack

# 2. Configure
cp .env.example .env
# Edit .env with your Discord OAuth credentials

# 3. Add proxies
nano apps/worker/proxies.txt
# One proxy per line: http://user:pass@host:port

# 4. Launch
docker compose up -d --build

# 5. Open dashboard
open http://localhost:3000
```

### Environment Variables

Create a `.env` file in the project root:

```env
# Required — generate with: openssl rand -base64 32
AUTH_SECRET=your-random-secret

# Required — from Discord Developer Portal
AUTH_DISCORD_ID=your-discord-client-id
AUTH_DISCORD_SECRET=your-discord-client-secret
```

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

## Self-Hosting

### Production with HTTPS

Vintrack includes Caddy for automatic HTTPS via Let's Encrypt:

1. Point your domain's **A record** to your server IP
2. Update the `Caddyfile`:

```
yourdomain.com {
    reverse_proxy control-center:3000
}
```

3. Update `AUTH_URL` in `docker-compose.yml`:

```yaml
- AUTH_URL=https://yourdomain.com
```

4. Set the Discord OAuth2 callback URL to:

```
https://yourdomain.com/api/auth/callback/discord
```

5. Deploy:

```bash
docker compose up -d --build
```

### Making Yourself Admin

After first login, promote your user:

```bash
docker exec -it vintrack_db psql -U vinuser -d vintrack \
  -c "UPDATE \"User\" SET role = 'admin' WHERE email = 'your@email.com';"
```

---

## Project Structure

```
vintrack/
├── docker-compose.yml            # Stack orchestration
├── Caddyfile                     # HTTPS reverse proxy
├── .env                          # Secrets (not committed)
│
├── apps/
│   ├── control-center/           # Next.js 16 dashboard
│   │   ├── prisma/
│   │   │   ├── schema.prisma     # Database models
│   │   │   └── migrations/       # Auto-generated migrations
│   │   └── src/
│   │       ├── auth.ts           # NextAuth config
│   │       ├── actions/          # Server actions
│   │       │   ├── admin.ts      #   User management (admin)
│   │       │   ├── dashboard-actions.ts
│   │       │   ├── monitor.ts    #   Monitor CRUD
│   │       │   └── proxy-groups.ts
│   │       ├── app/
│   │       │   ├── (auth)/       # OAuth routes
│   │       │   ├── (dashboard)/  # Protected pages
│   │       │   │   ├── admin/    #   Admin panel
│   │       │   │   ├── dashboard/#   Monitor overview
│   │       │   │   ├── feed/     #   Real-time feed
│   │       │   │   ├── monitors/ #   Monitor detail + creation
│   │       │   │   └── proxies/  #   Proxy group management
│   │       │   └── api/          # API routes (SSE, items)
│   │       ├── components/       # React components
│   │       └── lib/              # Utils, DB, constants
│   │
│   └── worker/                   # Go scraping engine
│       ├── cmd/main.go           # Entrypoint
│       └── internal/
│           ├── cache/            # Redis dedup + pub/sub
│           ├── database/         # PostgreSQL queries
│           ├── discord/          # Webhook sender
│           ├── model/            # Shared types
│           ├── pipeline/         # Monitor lifecycle
│           ├── proxy/            # Rotation + validation
│           └── scraper/          # Vinted API + HTML scraper
```

---

## How It Works

```mermaid
sequenceDiagram
    participant U as User
    participant D as Dashboard
    participant DB as PostgreSQL
    participant W as Worker
    participant V as Vinted API
    participant R as Redis
    participant DC as Discord

    U->>D: Create monitor (query, filters)
    D->>DB: Save monitor (status: active)
    W->>DB: Poll for active monitors (every 5s)
    W->>V: Fetch listings (via proxy)
    V-->>W: Return items
    W->>R: Check dedup cache
    R-->>W: New item IDs
    W->>DB: Store new items
    W->>R: Publish via SSE channel
    R-->>D: Push to live feed
    W->>DC: Send webhook embed
    DC-->>U: Discord notification
```

---

## Roadmap

- [ ] Vinted Account Linking
- [ ] Auto Chat Module
- [ ] Auto Buy Module
- [ ] Price history tracking & charts
- [ ] Saved searches / favorites
- [ ] Rate limiting per user
- [ ] API tokens for external integrations
- [ ] Multi-language Vinted region support
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
