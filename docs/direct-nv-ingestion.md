# Direct NV Google Sheets ingestion

`npm run sync:nv` is the production path from active employee spreadsheets to the PostgreSQL mirror used by the dashboard and customer reports. With `CATALOG_AUTHORITY=database`, the scheduled job seeds its source registry from CONFIG-visible database staff and does not read or overwrite the Master catalog.

## Safety contract

- `npm run seed:nv-sources` reads CONFIG-visible staff from PostgreSQL when `CATALOG_AUTHORITY=database`, then reconciles discovered employee files without writing Google. The legacy Master path remains available only when database authority is not enabled. No employee IDs or source-count range are hardcoded. The Master file ID is rejected.
- Google credentials receive only `spreadsheets.readonly` and `drive.metadata.readonly`. The reader uses `GET`, at most three concurrent files, 500-row `A:V` pages, and bounded 429/5xx retry honoring `Retry-After`.
- Every sheet must be named `BAO CAO HANG NGAY`. Its ordered 22-column header is auto-detected at any row, and every populated data row after it is read according to that layout. A readable header-only file is a valid empty source.
- A checkpoint and immutable page cache are written per run/file/page. A retry (including the next cron run after failure) reuses completed pages with the same config version and requests only failed/missing pages. Valid rows are normalized and staged under the new run ID. The stable key is SHA-256 of canonical post URL, posted date, and channel, so reruns are idempotent.
- Publication takes a transaction advisory lock and checks every source checkpoint. Successful and valid-empty sources replace their own prior rows; failed sources retain their last-known-good rows. Mixed outcomes commit as `partial`, with per-source errors and fresh/retained source IDs in run metadata. If no source is readable, publication is blocked and the prior snapshot remains available.

Run `npm run migrate:nv`, apply migration 014, then seed `nv_ingestion_sources`. Migrations 007 and 010 bootstrap config provenance and registry presence tracking. The production registry comes from the audited database catalog; ingestion refuses arbitrary or failed-run config.

Required secrets are `DATABASE_URL` and `GOOGLE_APPLICATION_CREDENTIALS`; retain the existing `MASTER_SPREADSHEET_ID` exclusion guard. Runtime controls are `NV_CONCURRENCY` (maximum 3), `NV_PAGE_ROWS`, `NV_PAGE_TIMEOUT_MS` and `NV_SOURCE_TIMEOUT_MS` (both default 120000), `NV_TOTAL_TIMEOUT_MS` (default 1500000), `NV_HEARTBEAT_MS` (default 30000), `NV_SOURCE_RETRIES`, `GOOGLE_REQUESTS_PER_MINUTE` (default 55, capped at 60), `GOOGLE_READ_DELAY_MS`, and `GOOGLE_MAX_RETRIES`. The command emits one-line JSON progress for every source/page, periodic heartbeats, and exactly one terminal `published`, `partial`, or `blocked` event. Do not add Sheets write scopes or token-rotation logic.

The Render blueprint runs this path every 30 minutes. There is intentionally no manual snapshot-file input or alternate publication command. Monitor `sync_runs`, `nv_ingestion_checkpoints`, and `nv_published_snapshots`; a failed run requires correcting its source/config and rerunning the cron, not editing the published mirror.
