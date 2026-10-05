ALTER TABLE "User"
ADD COLUMN "checkout_risk_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "checkout_risk_accepted_at" TIMESTAMP(6);
