# Phase 6 Cron go-live report

Status: **CODE READY, PROVISIONING BLOCKED**

Implemented immutable Supabase Storage REST adapter, checksum/path guards, ephemeral live Master snapshot creation for scheduled production runs, immutable run/published/LKG objects, structured existing run logs and fail-closed gates. Google client remains GET-only with readonly scopes. Render remains dry-run by default; production requires explicit `--production`.

## One-time setup

1. Create private Supabase Storage bucket `onicorn-snapshots` (or set `SNAPSHOT_BUCKET`).
2. Add Storage policy allowing only the server-side service role to insert/select. Do not expose service role key to web service or browser.
3. Configure Render cron secret env vars: `GOOGLE_APPLICATION_CREDENTIALS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SNAPSHOT_BUCKET`, `DATABASE_URL`, `REPORT_SNAPSHOT_PATH` and optional `FAILURE_NOTIFY_URL`.
4. Prove parity and report generation in dry-run. Then change cron start command to `python3 -m automation.report_batch.runner_cli scheduled-run --production`.

No Supabase credentials were available, so no external provisioning or fake success was attempted.
