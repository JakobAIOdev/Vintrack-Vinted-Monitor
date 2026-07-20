-- Raw monitor runs are pruned by the proxy-maintainer every hour. Lower
-- autovacuum thresholds keep the high-churn table and its indexes reusable
-- without waiting for PostgreSQL's default 20% dead-tuple threshold.
ALTER TABLE "monitor_runs" SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 10000,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 10000
);
