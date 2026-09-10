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
