CREATE TABLE "vinted_browser_links" (
    "user_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vinted_browser_links_pkey" PRIMARY KEY ("user_id")
);

CREATE UNIQUE INDEX "vinted_browser_links_token_hash_key"
ON "vinted_browser_links"("token_hash");

ALTER TABLE "vinted_browser_links"
ADD CONSTRAINT "vinted_browser_links_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
