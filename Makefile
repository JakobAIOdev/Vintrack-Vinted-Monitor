DEV_COMPOSE = COMPOSE_PROFILES= COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f docker-compose.dev.yml
DEV_SEED = $(DEV_COMPOSE) exec -T control-center node scripts/seed-dev.mjs

.PHONY: help init check compose-check dev dev-seed dev-down dev-logs dev-ps up down logs

help:
	@printf '%s\n' \
		'Vintrack development commands:' \
		'  make init           Create local files and generate missing secrets' \
		'  make check          Run the standard test suite' \
		'  make compose-check  Validate Docker Compose configuration quietly' \
		'  make dev            Build, seed, and start the low-power mock development stack' \
		'  make dev-seed       Refresh the local admin, monitors, and proxy pool fixtures' \
		'  make dev-down       Stop the development stack without deleting its data' \
		'  make dev-logs       Follow development application logs' \
		'  make dev-ps         Show development service status' \
		'  make up             Build and start the full live/production-like stack' \
		'  make down           Stop containers without deleting volumes' \
		'  make logs           Follow application service logs'

init:
	sh scripts/init.sh

check:
	sh scripts/test-all.sh

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

down:
	docker compose down

logs:
	docker compose logs -f control-center worker vinted-service
