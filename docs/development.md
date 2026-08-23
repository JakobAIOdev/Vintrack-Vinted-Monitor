# Development

## Prerequisites

For host-based development:

- Node.js 20 or newer and npm;
- Go 1.25 or newer;
- Docker with Docker Compose v2;
- OpenSSL and `make`.

Docker remains the easiest way to run PostgreSQL, Redis, migrations, and all
application services together.

## Initialize

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor.git vintrack
cd vintrack
make init
```

Complete local authentication values in `.env` when using the full live stack.
The low-power `make dev` workflow supplies its own local admin session.

## Low-power local stack

```bash
make dev
```

This is the default local workflow. It builds changed images with reusable
caches and serial service builds, starts a resource-capped stack, and applies
idempotent development fixtures with:

- an automatically signed-in local admin at `http://localhost:3000`;
- synthetic healthy free-proxy pools for DE, FR, IT, ES, NL, BE, and AT;
- safe example members, monitors, feed items, and a personal proxy group;
- a separate, persistent development database and Redis volume;
- the deterministic mock catalog worker;
- no Caddy, GitHub rewards scheduler, proxy maintainer, live discovery, price
  watch scanner, or pre-index scanner.

`make dev` explicitly ignores `COMPOSE_PROFILES` from `.env`, so an old
`COMPOSE_PROFILES=preindex` setting cannot start the scanner accidentally.
Follow logs or inspect status with `make dev-logs` and `make dev-ps`.
Run `make dev-seed` to refresh only the fixtures without rebuilding images.

All seeded proxy addresses are loopback-only fixtures and all seeded monitor
notifications are disabled. The worker stays in mock mode, so this workflow
does not validate real Vinted access or real proxy connectivity. The automatic
admin session is defined only in `docker-compose.dev.yml`; `make up` keeps the
normal authentication flow.

Stop containers without removing development data:

```bash
make dev-down
```

Do not add `--volumes` unless you explicitly intend to delete the isolated
development database and Redis data.

## Full live stack

Only use the live/production-like stack when validating real catalog behavior:

```bash
make up
```

This can consume substantially more CPU, network, and battery because it starts
the live monitor worker and proxy maintainer. Enable the pre-index scanner only
for an intentional experiment; it is not part of ordinary development.

## Control center

Install dependencies:

```bash
cd apps/control-center
npm ci
npx prisma generate
```

Start infrastructure and migrations from the repository root:

```bash
docker compose up -d postgres redis control-center-migrate
```

Then run:

```bash
cd apps/control-center
npm run dev
```

Useful checks:

```bash
npm run lint
npm run build
npm run test:e2e
npm run format:check
```

## Go services

Worker:

```bash
cd apps/worker
go test ./...
go run ./cmd
```

Vinted service:

```bash
cd apps/vinted-service
go test ./...
go run ./cmd
```

Use `gofmt` on changed Go files. Keep entry points in `cmd/` and reusable logic
inside `internal/`.

## Mock catalog development

The standard `make dev` command already enables repeatable mock catalog data.
To select a different scenario for one run:

```bash
VINTED_MOCK_SCENARIO=empty make dev
```

The development overlay:

- switches the monitor worker to `VINTED_FETCH_MODE=mock`;
- disables live seller enrichment;
- starts a local webhook catcher on `127.0.0.1:8088`.

See [Mock Vinted data](mock-vinted-data.md) for scenarios and monitor setup.

## Validation

Run the standard repository suite:

```bash
make check
```

It covers Go unit tests, control-center lint and build, and public Playwright
tests. More modes are documented in [Testing](testing.md).

Before a pull request, also run:

```bash
docker compose config --quiet
git diff --check
```

## Project conventions

- TypeScript follows the existing ESLint configuration, double quotes, and
  semicolons.
- Go follows `gofmt`, package-oriented design, and adjacent `*_test.go` files.
- Keep changes focused and update `.env.example` with every new setting.
- Never record real sessions, tokens, webhook URLs, proxy credentials, or user
  data in fixtures, logs, documentation, or commits.
- Prefer the mock worker and synthetic accounts for development.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.
