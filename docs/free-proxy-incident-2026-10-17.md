# Free Proxy Pool: production incident, 17 October 2026

Read-only investigation. Snapshots were collected around 18:19–18:23 UTC
(20:19–20:23 Europe/Berlin). Counts fluctuate as validation runs complete.

## Impact and deployed version

- 230 active Free Pool monitors; 227 were waiting for pool capacity at the snapshot.
- DE had 7 mature proxies and FR 8. Recovery requires 10 mature proxies on two
  observations. Other configured regions were generally at 6–8; BE still served
  with 8 because an already-serving pool has an 80% exit threshold.
- Production runs v2.7.3, commit
  `84775918524e5c2a23ea249a0968da07a37f105c`, confirmed from the checkout and
  worker image metadata. The detection-speed changes on `dev` are not deployed.
- Worker and proxy maintainer have run since 16 October around 15:16 UTC with
  zero container restarts and no OOM kills. Host CPU, memory and disk snapshots
  did not indicate resource exhaustion.

## Validation evidence

Thirteen completed maintainer cycles in the sampled hour reported:

| Result | Count | Share of checked |
| --- | ---: | ---: |
| Checked | 10,524 | 100% |
| Passed | 739 | 7.02% |
| Failed | 9,785 | 92.98% |
| Timeout | 8,079 | 76.77% |
| Connect error | 1,153 | 10.96% |
| Proxy handshake error | 220 | 2.09% |
| Transport error | 216 | 2.05% |
| Vinted 403 | 94 | 0.89% |
| TLS error | 22 | 0.21% |
| Upstream 5xx | 1 | 0.01% |

No 429 was reported in these cycle summaries. Cycles also reported 228 canceled
operations and zero persistence failures. Most failures occurred during warmup.
This is evidence of predominantly unusable or slow candidate transport, rather
than predominantly HTTP access denials. Passed checks are events, not a count of
distinct usable proxies.

## Inventory renewal remains constrained

The inventory is full at 30,000 entries. Source refreshes still run, but typically
add zero new entries. The previous fix has reduced stale, never-checked entries
with no success history to 9; the previous incident recorded 9,164.

However, 7,428 inventory entries were last seen over seven days ago,
had no global success in seven days, and had no regional success in the last
24 hours. Historical success permanently protects such entries from the current
cleanup query:

- `apps/worker/internal/database/store.go:1598`,
  `PruneUnselectedFreeProxiesContext`, requires zero global successes, no global
  success timestamp, and no regional success timestamp ever.
- `apps/worker/cmd/main.go:1825` refuses additional inventory entries at the cap.

These conditions explain a continuing renewal bottleneck. They do not prove
that newly imported replacements would pass validation.

## Candidate selection restricts protocol diversity

Current hourly candidate windows contain 10,000 entries per sampled region:

| Region | HTTP | SOCKS5 | SOCKS4 | HTTPS |
| --- | ---: | ---: | ---: | ---: |
| DE | 9,630 | 343 | 19 | 8 |
| FR | 9,685 | 293 | 17 | 5 |
| UK | 9,677 | 303 | 16 | 4 |

The candidate-window query explicitly orders HTTP, HTTPS, SOCKS5, SOCKS4 before
its final tie breakers (`apps/worker/internal/database/store.go:1740`). With many
untested HTTP candidates and a bounded window, new SOCKS candidates have little
opportunity to enter. This is a confirmed selection bias, not evidence that
SOCKS candidates necessarily have a higher live success rate.

## Additional unresolved signal

Logs include repeated UK canary database claim cancellations (SQLSTATE 57014)
and several worker runtime-success database write deadlines. A database activity
snapshot showed no lock waits, but cannot exclude intermittent contention or
slow queries. Investigate these separately; do not attribute all failures to
inventory selection.

## Recommended changes and validation

1. Add bounded expiration for stale auto-import entries with historical success,
   requiring absence from sources and no recent global or regional success.
   Preserve manual entries, disabled entries, active claims and recently healthy
   proxies. Cover a full inventory with stale historical successes in database
   integration tests.
2. Give supported protocols a bounded opportunity to enter candidate windows;
   cover HTTP saturation and cold SOCKS candidates with deterministic tests.
3. Investigate canary claim and runtime-write deadlines with query timing and
   bounded database diagnostics.
4. Evaluate several maintainer cycles after any deployment: distinct mature
   proxies, serving regions, waiting monitors, newly admitted candidates, check
   outcomes and database deadlines. Cleanup or protocol balance alone is not a
   guarantee of enough healthy public proxies.

No production configuration, database rows or containers were changed. No extra
Vinted or public-proxy probes were made. No source code was changed during this
investigation. Credentials, proxy endpoints and user/item data are omitted.

## Remediation prepared on dev

The v2.7.4 patch addresses the verified inventory and candidate-window defects:

- Auto-import entries that have disappeared from feeds and had no global or
  regional success for seven days can expire, including entries with historical
  success. Cleanup still removes at most 1,000 entries per import cycle and
  protects current feed members, manual/unknown sources, disabled entries and
  active validation claims. The existing one-day retention for never-successful
  entries remains in place.
- Candidate windows interleave protocols within the same readiness/due class.
  Regional source affinity still orders candidates within a protocol; a large
  regional HTTP feed cannot exclude every cold SOCKS candidate. Existing hourly
  windows remain stable until refill or the next hourly rollover.
- Canary claims and sampled runtime-success writes use `SKIP LOCKED` so they
  can yield to a concurrent validation/import instead of waiting for its row
  locks. This addresses a reproduced contention case; it does not establish
  that every production database deadline had this cause.
- Serving minimums, freshness requirements, promotion checks and access-denial
  backoffs are unchanged. No automatic migration or production-wide deletion
  script is required; the existing import process applies bounded cleanup.

Regression tests first reproduced historical entries being retained forever,
HTTP-only cold windows, and background database operations timing out on locked
rows. They pass with the patch. PostgreSQL integration checks also cover a full
30,000-entry inventory admitting 1,000 replacements while retaining 29,000
recently successful entries, a 30,000-candidate window with protocol scarcity,
repeated window refreshes, healthy-proxy retention and duplicate canary claims.

Deployment verification remains necessary: monitor the mature proxy counts and
waiting monitors over several maintainer/import cycles. A passing local test
does not certify current public-proxy availability or resolve the production
incident before the patch is deployed.
