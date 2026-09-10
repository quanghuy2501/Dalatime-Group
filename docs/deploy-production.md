# Onicorn Dashboard System - Production Deploy Notes

## Current architecture
- Google Sheets/Drive remain current team input/output workflow.
- Supabase/Postgres stores imported mirror and analytics tables.
- API/dashboard reads Supabase.
- No Google Sheet writes are performed in Phase 2.

## Required secrets
Never commit these.

```env
DATABASE_URL=postgresql://...
SUPABASE_POOLER_IP=13.124.111.232 # optional fallback if DNS fails
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
DASHBOARD_BASIC_USER=...
DASHBOARD_BASIC_PASS=...
# or DASHBOARD_AUTH_TOKEN=...
```

## Run locally
```bash
cd /Users/quanghuy/Projects/tui-mo-dashboard/onicorn-dashboard-system
set -a; source .env.local; set +a
npm run api
```
Open:
```text
http://localhost:4177
```

## Read-only sync cycle
This reads Google Sheets and writes only Supabase DB tables. It does not write Google Sheets.

```bash
set -a; source .env.local; set +a
node scripts/run-readonly-sync-cycle.mjs
```

Recommended schedule during Phase 2:
- Manual only while validating.
- Then every 1-2 hours via cron/Cloud Run Scheduler.
- Keep Google Sheet export disabled until Phase 3 staging export is implemented and approved.

## Deploy target recommendation
Best production shape for this project:
1. Cloud Run service for API/dashboard container.
2. Cloud Scheduler job calling a private/manual sync endpoint or running a separate job container.
3. Supabase remains database.
4. Google service account key stored in Secret Manager.

Alternative quick path:
- Run API locally or on a small VPS using pm2.
- Use cron to run `scripts/run-readonly-sync-cycle.mjs`.

## Security rules
- Dashboard must not be public without auth.
- Use Basic Auth or Bearer token at minimum.
- Rotate Supabase password if it was pasted in chat.
- Keep service account JSON outside repo.
- Do not expose write endpoints until Phase 3 staging export is pass.
