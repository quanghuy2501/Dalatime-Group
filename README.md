# Onicorn Dashboard System

Infra migration workspace for Onicorn Master Dashboard.

Goal: keep existing Google Sheet workflow, move heavy processing from Apps Script to service + database.

## Modes
- Phase 0: local/read-only audit from extracted CSVs and Apps Script source.
- Phase 1: DB mirror read-only from Google Sheets/Drive.
- Phase 2+: DB-powered dashboard and exporters.

## Commands
```bash
npm run audit:local
npm run import:local
npm run check
```

No command in this folder writes to Google Drive/Sheets unless explicitly implemented under `src/exporters` and run with a write flag.

## Safe read-only sync

`npm run sync:readonly` creates an atomic, locked Master snapshot under `reports/phase4` from the repository's extracted CSV fixtures. It never invokes an importer, SQL, or a Google write API. Set `MASTER_FIXTURE_DIR` to use another fixture directory. Live export is explicitly opt-in with `READONLY_LIVE=1` plus `GOOGLE_APPLICATION_CREDENTIALS`; the exporter requests only Sheets read-only and Drive metadata read-only scopes, reads open-ended ranges, and retries HTTP 429 responses with backoff. Set `READONLY_COMPARISON_SNAPSHOT` to emit JSON and Markdown discrepancy audits by post URL, post URL/brand, and staff ID/status.

The underlying CLI is `python3 scripts/master_snapshot.py`. Use `snapshot --fixture-dir DIR --output FILE` (or `snapshot --live --output FILE`) and `audit --master FILE --against FILE --json FILE --md FILE` for direct automation.

Database migration/import is intentionally separate and explicit: `npm run phase1:import` (writes the configured database and must not be used for read-only checks).

## Dashboard authentication

When `DASHBOARD_BASIC_USER` and `DASHBOARD_BASIC_PASS` are configured, the dashboard uses the branded `/login` page instead of browser-native Basic Auth. Set `AUTH_SESSION_SECRET` to a long random value (for example `openssl rand -hex 32`) to enable signed, `HttpOnly`, `SameSite=Lax` session cookies. Sessions expire after 8 hours and are not persistent by default. `POST /auth/logout` clears the cookie. Dashboard pages and `/api/*` remain protected; APIs return `401` while browser page requests redirect to `/login`. Keep the secret and password out of source control.
Production batch go-live automation is documented in `docs/batch-go-live.md`. The
Node web service, `/healthz`, `/readyz`, and token-scoped customer reports remain
the serving path; the Python batch worker is dry-run and publish-disabled by default.

## Production cron snapshot publication

The Render cron is deliberately dry-run by default. It creates no Google writes and does not publish. After parity is proven, explicitly set its command to:

```sh
python3 -m automation.report_batch.runner_cli scheduled-run --production
```

Production creates `scripts/master_snapshot.py --live` in `/tmp`, validates a complete locked snapshot, runs reconciliation, then uploads immutable `runs/<run-id>/master-snapshot.json`, `published.json`, and `last-known-good.json` to the private Supabase Storage bucket. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Render secret, never commit), `SNAPSHOT_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`, `MASTER_SPREADSHEET_ID`, `DATABASE_URL`, and `REPORT_SNAPSHOT_PATH`. Optional `FAILURE_NOTIFY_URL` receives redacted failure alerts. Create the private bucket and service-role-only Storage policies once in Supabase. Missing credentials, incomplete/429 snapshots, lock conflicts, or parity mismatches fail closed and preserve the prior LKG.
