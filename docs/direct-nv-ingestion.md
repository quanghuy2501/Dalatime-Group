# Direct NV Google Sheets ingestion

`npm run sync:nv` is the production path from active employee spreadsheets to the Supabase mirror used by the dashboard and customer reports. It does not replace or modify Master sync. Master supplies only the source registry/configuration version; its rows are never ingested as employee data.

## Safety contract

- Sources come from `nv_ingestion_sources`, or `NV_SOURCE_REGISTRY` for a controlled file-backed deployment. Exactly 20–30 active sources must remain after NV15/NV16 and inactive entries are skipped. The Master file ID is rejected.
- Google credentials receive only `spreadsheets.readonly` and `drive.metadata.readonly`. The reader uses `GET`, at most three concurrent files, 500-row `A:V` pages, and bounded 429/5xx retry honoring `Retry-After`.
- Every sheet must be named `BAO CAO HANG NGAY` and match the ordered 22-column mapping in `COLUMN_MAPPING`. Missing headers, invalid required values, duplicate natural keys, partial reads, or an unproven Master config version block the run.
- A checkpoint is written per run/file/page. Valid rows are normalized and staged under the run ID. The stable key is SHA-256 of canonical post URL, posted date, and channel, so reruns are idempotent.
- Publication takes a transaction advisory lock, checks every source checkpoint, replaces both exact mirror tables, verifies staging/published parity, moves the singleton published pointer, and commits. Any error rolls back and leaves the prior published snapshot available.

Apply `migrations/007_direct_nv_ingestion.sql`, then seed `nv_ingestion_sources`. The migration bootstraps the latest successful Master run and installs a trigger so each later successful Master sync atomically becomes the active `config_version` with the exact 22-pair mapping. This explicit provenance is the handoff from existing Master sync; ingestion refuses arbitrary or failed-run config.

Required secrets are `DATABASE_URL` and `GOOGLE_APPLICATION_CREDENTIALS`; retain the existing `MASTER_SPREADSHEET_ID` exclusion guard. Optional controls are `NV_CONCURRENCY` (maximum 3), `NV_PAGE_ROWS`, `GOOGLE_READ_DELAY_MS`, and `GOOGLE_MAX_RETRIES`. Do not add Sheets write scopes or token-rotation logic.

The Render blueprint runs this path every 30 minutes. There is intentionally no manual snapshot-file input or alternate publication command. Monitor `sync_runs`, `nv_ingestion_checkpoints`, and `nv_published_snapshots`; a failed run requires correcting its source/config and rerunning the cron, not editing the published mirror.
