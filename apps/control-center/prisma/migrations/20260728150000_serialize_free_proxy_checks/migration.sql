ALTER TABLE "free_proxies"
    ADD COLUMN "check_claimed_until" TIMESTAMP(6);

CREATE INDEX "free_proxies_check_claimed_until_idx"
    ON "free_proxies"("check_claimed_until");
