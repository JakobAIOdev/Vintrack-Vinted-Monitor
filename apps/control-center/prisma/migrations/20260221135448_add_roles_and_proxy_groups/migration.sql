-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" VARCHAR(20) NOT NULL DEFAULT 'free';

-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "proxy_group_id" INTEGER;

-- CreateTable
CREATE TABLE "proxy_groups" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "proxies" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proxy_groups_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_proxy_group_id_fkey" FOREIGN KEY ("proxy_group_id") REFERENCES "proxy_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_groups" ADD CONSTRAINT "proxy_groups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
