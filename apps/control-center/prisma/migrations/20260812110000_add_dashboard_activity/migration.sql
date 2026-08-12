ALTER TABLE "User"
ADD COLUMN "last_dashboard_seen_at" TIMESTAMP(6);

CREATE INDEX "User_last_dashboard_seen_at_idx"
ON "User"("last_dashboard_seen_at");
