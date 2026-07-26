# Contributing to Vintrack

Thanks for helping make Vintrack better. Focused bug fixes, tests,
documentation improvements, and well-scoped features are welcome.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use GitHub Discussions or the
  [Vintrack Discord](https://discord.gg/WbEpEjaWjP) for usage questions.
- Open an issue before a large architectural change so the approach can be
  discussed before significant work is invested.
- Report vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), never in a public issue.

## Development setup

Requirements:

- Docker with Docker Compose;
- Node.js 20 or newer;
- Go 1.25 or newer;
- Git.

Clone and initialize the repository:

```bash
git clone https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor.git vintrack
cd vintrack
make init
```

Complete the authentication values in `.env`, then start the stack:

```bash
docker compose up -d --build
```

See [Getting Started](docs/getting-started.md) for setup details and
[Development](docs/development.md) for component-specific workflows.

## Making a change

1. Create a branch from the current `main`.
2. Keep the change focused; avoid unrelated formatting or refactors.
3. Add or update tests for behavior changes.
4. Update documentation and `.env.example` when configuration changes.
5. Run the relevant validation before opening a pull request.

Use the established conventions:

- TypeScript uses the repository ESLint configuration, double quotes, and
  semicolons.
- Go code must be `gofmt`-formatted and keep reusable logic in `internal/`.
- Do not commit `.env`, session data, cookies, tokens, webhook URLs, proxy
  credentials, database dumps, or captured personal data.

## Validation

Run the main local suite:

```bash
make check
```

For a faster component-specific iteration:

```bash
cd apps/worker && go test ./...
cd apps/vinted-service && go test ./...
cd apps/control-center && npm run lint && npm run build
```

Dashboard end-to-end coverage and other options are documented in
[Testing](docs/testing.md).

## Pull requests

A good pull request:

- explains the problem and the chosen solution;
- links the related issue;
- lists the commands used to validate the change;
- calls out configuration, database, or compatibility implications;
- includes screenshots or a short recording for visible UI changes;
- stays small enough to review confidently.

Use short, imperative commit subjects, for example:

```text
Improve proxy health reporting
Fix monitor region validation
Document OIDC setup
```

Maintainers may ask for a change to be split when independent concerns are
combined.

## Third-party services and responsible use

Contributions must not embed bypasses for CAPTCHAs, authentication barriers, or
other access controls. Preserve reasonable rate limits and stable public
interfaces. Only automate accounts and systems you own or are authorized to use,
and comply with applicable law and third-party terms.
