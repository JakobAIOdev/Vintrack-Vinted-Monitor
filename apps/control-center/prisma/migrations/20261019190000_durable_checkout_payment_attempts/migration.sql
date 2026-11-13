-- Payment claims outlive Redis, region changes, member changes and relinking.
-- No card data or payment redirect tokens are stored here.
CREATE TABLE "checkout_payment_attempts" (
    "vinted_user_id" BIGINT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "owner_token" VARCHAR(128) NOT NULL,
    "result_ciphertext" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "checkout_payment_attempts_pkey" PRIMARY KEY ("vinted_user_id", "item_id")
);
