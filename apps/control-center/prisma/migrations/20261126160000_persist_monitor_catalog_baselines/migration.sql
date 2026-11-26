CREATE TABLE "monitor_catalog_baselines" (
    "monitor_id" INTEGER NOT NULL,
    "query_key" VARCHAR(64) NOT NULL,
    "item_id" BIGINT NOT NULL CHECK ("item_id" > 0),

    CONSTRAINT "monitor_catalog_baselines_pkey" PRIMARY KEY ("monitor_id", "query_key"),
    CONSTRAINT "monitor_catalog_baselines_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
