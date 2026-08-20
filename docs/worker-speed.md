# Worker speed and hybrid discovery

Vintrack has two complementary catalog paths:

- **Canonical monitoring** keeps the exact Vinted search URL configured for each monitor.
- **Hybrid discovery** removes only `search_text`, keeps structural filters such as category, brand, size, price, color, and condition on Vinted, then matches the monitor query and anti-keywords locally.

Both paths use the same atomic `(monitor, item)` claim, so only the first path to see an item can enqueue its alert. This is intentionally catalog-based; production discovery does not probe sequential item IDs.

## Recommended rollout

Start with:

```env
DISCOVERY_MODE=shadow
```

Shadow mode runs discovery and records timing without sending discovery alerts. Open a monitor's **Metrics** dialog and compare hybrid detections, early wins, median early lead, and first-delivery detect-to-alert p95. Once the selected proxy pool is stable and early wins are useful, enable:

```env
DISCOVERY_MODE=active
```

Shadow discovery also runs on a healthy shared free-proxy pool so its timing can be evaluated without sending discovery alerts. Active discovery requires at least two dedicated proxies by default. For a short, deliberate free-pool alert test, set `DISCOVERY_ALLOW_FREE_ACTIVE=true`; canonical monitoring stays active if discovery cannot start.

## Runtime controls

| Variable                           |      Default | Purpose                                                                                                            |
| ---------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------------ |
| `TLS_PROFILE`                      | `chrome_146` | TLS and browser-header profile (`chrome_131`, `chrome_133`, `chrome_144`, or `chrome_146`).                        |
| `CLIENT_POOL_SIZE`                 |          `5` | Warm proxy sessions retained per domain and proxy source.                                                          |
| `FREE_PROXY_CLIENT_POOL_SIZE`      |         `50` | Warm sessions used to spread shared monitor traffic across each regional free pool.                                |
| `CATALOG_TIMEOUT_MS`               |       `2000` | Deadline for a catalog cycle.                                                                                      |
| `CATALOG_HEDGE_DELAY_MS`           |        `250` | Starts a second request on another healthy proxy if the first request has not completed.                           |
| `FREE_PROXY_CATALOG_HEDGE_DELAY_MS` |       `900` | Delays speculative free-proxy traffic so a normal public-proxy response does not automatically double the load.   |
| `DISCOVERY_MODE`                   |        `off` | `off`, `shadow`, or `active`.                                                                                      |
| `DISCOVERY_ALLOW_FREE_ACTIVE`      |      `false` | Explicitly allows active discovery alerts on the shared free-proxy pool. Shadow measurement does not require this. |
| `DISCOVERY_INTERVAL_MS`            |        `500` | Minimum discovery cycle interval; the worker adds 0–100 ms jitter.                                                 |
| `DISCOVERY_FREE_INTERVAL_MS`       |        `500` | Free-pool discovery interval before jitter.                                                                        |
| `DISCOVERY_PER_PAGE`               |         `96` | Items requested per discovery page.                                                                                |
| `DISCOVERY_FREE_PER_PAGE`          |         `64` | Smaller free-proxy response page to reduce timeout pressure.                                                       |
| `DISCOVERY_MAX_BACKFILL_PAGES`     |          `3` | Maximum pages fetched when the newest page turns over before overlap is found.                                     |
| `DISCOVERY_FREE_CLIENT_POOL_SIZE`  |          `8` | Isolated warm sessions reserved for free discovery.                                                                |
| `DISCOVERY_FREE_TIMEOUT_MS`        |       `3000` | Free discovery deadline; canonical keeps the normal catalog deadline.                                              |
| `DISCOVERY_FREE_HEDGE_DELAY_MS`    |        `150` | Earlier second attempt for volatile free proxies.                                                                  |
| `ALERT_WORKERS`                    |          `8` | Workers that turn a detected item into a durable outbox entry.                                                     |
| `ALERT_DELIVERY_WORKERS`           |         `16` | Shared workers that send claimed outbox entries to Discord and Telegram. Also bounds how many entries are claimed. |
| `TELEGRAM_GLOBAL_RATE_PER_SECOND`  |         `25` | Process-wide Telegram send rate. One bot token serves every member, so this budget is shared by all chats.         |
| `TELEGRAM_GLOBAL_BURST`            |         `25` | Burst allowance for the Telegram send budget.                                                                      |
| `ENRICHMENT_WORKERS`               |         `24` | Concurrent persistence and seller-enrichment workers. Effective throughput is capped by `SELLER_CLIENT_POOL_SIZE`. |
| `SELLER_NEGATIVE_CACHE_TTL_MS`     |       `3000` | How long a definitive seller-fetch failure (401/403/429/5xx/decode/empty/no-region/no-client) is remembered before retrying; excludes timeouts and cancellations. Kept below the 5s strict-retry delay so a scheduled retry always attempts a fresh fetch. `0` disables it. |
| `FREE_PROXY_HEALTH_CONCURRENCY`    |         `64` | Cluster-wide maximum parallel free-proxy validations in the isolated proxy-maintainer process.                     |
| `FREE_PROXY_HEALTH_PER_REGION_CONCURRENCY` | `12` | Maximum parallel validations against one Vinted regional domain.                                                    |
| `FREE_PROXY_HEALTH_BATCH_PER_REGION` |      `100` | Per-region cycle budget once the target reserve is available; work is claimed in bounded waves.                    |
| `FREE_PROXY_BOOTSTRAP_BATCH_PER_REGION` |   `600` | Per-region cycle budget while the pool is below its target reserve; work is claimed in bounded waves.               |
| `MONITOR_RUN_RETENTION_HOURS`      |         `24` | Retention for raw per-check monitor telemetry; hourly aggregates remain available separately.                      |
| `MONITOR_RUN_STATS_RETENTION_DAYS` |         `90` | Retention for compact hourly monitor-run aggregates.                                                               |
| `DETECTION_RETENTION_DAYS`         |         `14` | Retention for discovery/canonical comparison telemetry.                                                            |
| `CATALOG_LATENCY_METRICS`          |        `true` | In-worker fetch/process latency aggregation (p50/p95 written to `app_settings`); set `false` to disable.           |

Client selection favors low-latency, successful, idle sessions. HTTP 401/403/407/429 responses cool down the affected session, and hedged-request losers are canceled without being counted as failures. Free discovery uses its own stable client pool, so free-pool refreshes no longer restart the feed or disturb canonical catalog sessions.

The automatic free-proxy import combines IPLocate and ProxyScrape with measured, frequently refreshed Proxifly, Databay SOCKS4/SOCKS5, and Monosans feeds. Candidates are deduplicated before storage, interleaved across providers, and still have to pass the target Vinted region check before they become usable.

## Alert semantics

Dashboard/SSE publishing, Discord, and Telegram use separate bounded worker queues, so a slow external channel cannot stall later items. Without a seller-country filter, the dashboard publishes immediately from catalog data while Discord and Telegram wait for seller enrichment so their alerts include region and rating. A configured seller-country filter remains strict: seller enrichment and the country check complete before the item is published, saved, or alerted.

Operational check counts and success rates use canonical monitor runs only. Discovery runs remain separate telemetry so shadow or free-discovery failures cannot make the primary monitor health look worse than it is.

## Process isolation

Docker Compose runs the latency-sensitive monitor process with `WORKER_ROLE=monitor` and free-proxy imports/health checks with `WORKER_ROLE=proxy-maintainer`. Keep both services running: the maintainer owns free-pool upkeep and hourly telemetry cleanup, while the monitor process only refreshes ready proxy snapshots. Cleanup uses bounded batches so a backlog cannot create one oversized delete transaction.

The optional `WORKER_ROLE=id-scanner` process is a separate, shadow-only experiment behind the `preindex` Compose profile. It never sends alerts. See [Pre-index shadow scanner](preindex-shadow.md) for its request budget, metrics, and controls.
