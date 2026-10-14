CREATE TABLE "checkout_notification_deliveries" (
    "id" VARCHAR(64) NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "outcome" VARCHAR(50) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(6),
    CONSTRAINT "checkout_notification_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "checkout_notification_deliveries_status_created_at_idx"
    ON "checkout_notification_deliveries"("status", "created_at");
