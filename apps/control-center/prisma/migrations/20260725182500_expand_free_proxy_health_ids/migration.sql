-- Health rows are reconciled frequently. Keep their generated identifiers from
-- exhausting PostgreSQL's 32-bit serial range.
ALTER TABLE "free_proxy_health"
ALTER COLUMN "id" TYPE BIGINT;

ALTER SEQUENCE "free_proxy_health_id_seq" AS BIGINT;
