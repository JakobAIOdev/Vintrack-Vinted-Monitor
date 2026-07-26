.PHONY: help init check compose-check up down logs

help:
	@printf '%s\n' \
		'Vintrack development commands:' \
		'  make init           Create local files and generate missing secrets' \
		'  make check          Run the standard test suite' \
		'  make compose-check  Validate Docker Compose configuration quietly' \
		'  make up             Build and start the Docker Compose stack' \
		'  make down           Stop containers without deleting volumes' \
		'  make logs           Follow application service logs'

init:
	sh scripts/init.sh

check:
	sh scripts/test-all.sh

compose-check:
	docker compose config --quiet

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f control-center worker vinted-service
