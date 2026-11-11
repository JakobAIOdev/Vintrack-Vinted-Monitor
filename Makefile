DEV_COMPOSE = COMPOSE_PROFILES= COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f docker-compose.dev.yml
DEV_SEED = $(DEV_COMPOSE) exec -T control-center node scripts/seed-dev.mjs

.PHONY: help init setup check config-check compose-check dev dev-seed dev-down dev-logs dev-ps up local admin telegram-webhook backup update down logs

help:
	@printf '%s\n' \
		'Run your own instance:' \
		'  make setup          Guided setup: create .env, generate secrets, ask for URL and login' \
		'  make up             Start the full stack with Caddy and HTTPS (public domain)' \
		'  make local          Start the full stack without Caddy (this computer, or your own reverse proxy)' \
		'  make admin          Give your account the admin role (ACCOUNT=<id or email> to pick one)' \
		'  make telegram-webhook  Register the Telegram bot webhook for this instance' \
		'  make backup         Dump the database to ../vintrack-backups' \
		'  make update         Back up, fetch the new version, migrate and restart (BUILD=1 to build from source)' \
		'  make down           Stop containers without deleting volumes' \
		'  make logs           Follow application service logs' \
		'' \
		'Development:' \
		'  make init           Create local files and generate missing secrets without asking questions' \
		'  make check          Run the standard test suite' \
		'  make config-check   Validate .env without printing values' \
		'  make compose-check  Validate Docker Compose configuration quietly' \
		'  make dev            Build, seed, and start the low-power mock development stack' \
		'  make dev-seed       Refresh the local admin, monitors, and proxy pool fixtures' \
		'  make dev-down       Stop the development stack without deleting its data' \
		'  make dev-logs       Follow development application logs' \
		'  make dev-ps         Show development service status'

init:
	sh scripts/init.sh

setup:
	sh scripts/setup.sh

check:
	sh scripts/test-all.sh

config-check:
	node scripts/config-check.mjs .env

compose-check:
	docker compose config --quiet
	$(DEV_COMPOSE) config --quiet

dev:
	docker compose --profile preindex stop worker id-scanner proxy-maintainer caddy github-rewards-scheduler
	$(DEV_COMPOSE) build control-center
	$(DEV_COMPOSE) build worker
	$(DEV_COMPOSE) build vinted-service
	$(DEV_COMPOSE) up -d --no-build --force-recreate --remove-orphans
	$(DEV_SEED)
	$(DEV_COMPOSE) ps

dev-seed:
	$(DEV_SEED)

dev-down:
	$(DEV_COMPOSE) down --remove-orphans

dev-logs:
	$(DEV_COMPOSE) logs -f control-center worker vinted-service webhook-catcher

dev-ps:
	$(DEV_COMPOSE) ps

up:
	docker compose up -d --build

# Caddy publishes ports 80 and 443 and is only needed for a public HTTPS
# hostname. Without it the dashboard is served on http://localhost:3000.
local:
	docker compose up -d --build --scale caddy=0

admin:
	sh scripts/make-admin.sh "$(ACCOUNT)"

telegram-webhook:
	sh scripts/telegram-webhook.sh

backup:
	sh scripts/backup.sh

update:
	sh scripts/update.sh $(if $(BUILD),--build,)

down:
	docker compose down

logs:
	docker compose logs -f control-center worker vinted-service
