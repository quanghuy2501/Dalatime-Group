# Admin sync control plane

The spreadsheet no longer owns Master → `CONFIG` business logic. `apps-script/RenderSyncBridge.gs` only adds a **Đồng bộ** menu (and optional `syncButton` drawing handler), confirms intent, signs an allowlisted action, and calls Render. All validation, locks, idempotency, execution, status, and logs live in the service.

## One-time database deployment

Run against the production database before deploying the web service:

```sh
DATABASE_URL='…' node scripts/apply-migration.mjs migrations/012_admin_sync_control.sql
```

This creates only the durable control queue. It does not enqueue or execute a job.

## Render web-service secrets

Add these to the existing `Dalatime-Group` web service (never commit values):

- `ADMIN_SYNC_WEBHOOK_SECRET`: at least 32 random bytes, e.g. `openssl rand -hex 32`.
- `CONFIG_PUSH_PRODUCTION=1`: required before the CONFIG action can write.
- `CONFIG_PUSH_PILOT_NV_IDS=NV…,NV…`: keep the existing 2–3 source pilot gate, or set `CONFIG_PUSH_FULL_ROLLOUT=1` only after pilot approval.
- The same Google and DB credentials already used by the cron jobs: `DATABASE_URL`, `GOOGLE_APPLICATION_CREDENTIALS`, and `MASTER_SPREADSHEET_ID`.
- Copy the existing NV runtime limits to the web service (`NV_CONCURRENCY`, `NV_PAGE_ROWS`, `NV_PAGE_TIMEOUT_MS`, `NV_SOURCE_TIMEOUT_MS`, `NV_TOTAL_TIMEOUT_MS`, `NV_HEARTBEAT_MS`, `NV_SOURCE_RETRIES`, `GOOGLE_REQUESTS_PER_MINUTE`).

Keep `AUTH_SESSION_SECRET`, `DASHBOARD_BASIC_USER`, and `DASHBOARD_BASIC_PASS` unchanged. The dashboard action/status/retry endpoints remain behind the existing session/Bearer/Basic middleware. Only `/api/admin/sync/webhook` bypasses browser auth, and it requires an HMAC-SHA256 signature over `<timestamp>.<exact JSON body>` with a five-minute replay window.

Deploying does **not** run any action. The existing Render cron names, commands, and schedules remain unchanged.

## Apps Script bridge

1. Remove/disable the old Master → CONFIG trigger and copy functions. Do not delete unrelated spreadsheet automation.
2. Add `apps-script/RenderSyncBridge.gs` to the bound Master Apps Script project.
3. In **Project Settings → Script Properties**, set:
   - `RENDER_ADMIN_BASE_URL=https://<your-render-service-host>`
   - `RENDER_ADMIN_WEBHOOK_SECRET=<exact same secret as Render>`
4. Reload the spreadsheet and authorize only the bridge scopes when prompted.
5. Optional: assign `syncButton` to an existing drawing/button. It queues `full_pipeline` after confirmation.

The bridge never reads/copies CONFIG ranges and never stores the secret in cells or logs. Rotate the secret in Render and Script Properties together.

## Operations

Dashboard → **Đồng bộ** shows the allowlisted actions, latest run, durable status/logs, failed NV sources, and retry buttons. Requests with the same idempotency key return the original job. A per-action active-job constraint prevents duplicate queued/running work, while a PostgreSQL advisory lock guarantees a single worker across web instances. Queued jobs are reclaimed when the web process starts.

`report_refresh_reconcile` verifies live DB-backed report counts and latest NV source failures; there is no materialized report cache to refresh. `full_pipeline` runs CONFIG push, direct NV ingestion, then this reconciliation sequentially and stops on the first error.
