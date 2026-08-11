-- CreateTable
CREATE TABLE "member_brands" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "brand_id" BIGINT NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "source_region" VARCHAR(10) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_brands_userId_brand_id_key" ON "member_brands"("userId", "brand_id");

-- CreateIndex
CREATE INDEX "member_brands_userId_active_idx" ON "member_brands"("userId", "active");

-- CreateIndex
CREATE INDEX "member_brands_brand_id_idx" ON "member_brands"("brand_id");

-- AddForeignKey
ALTER TABLE "member_brands" ADD CONSTRAINT "member_brands_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
