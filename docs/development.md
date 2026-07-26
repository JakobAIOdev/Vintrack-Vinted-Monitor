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

Complete local authentication values in `.env`.

## Full stack

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f control-center worker vinted-service
```

Stop containers without removing persistent volumes:

```bash
docker compose down
```

Do not add `--volumes` unless you explicitly intend to delete the development
database, Redis data, and Caddy state.

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

Use the mock overlay for repeatable dashboard and notification development
without live Vinted traffic:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.dev-mock.yml \
  up -d --build
```

The overlay:

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
