# Master CONFIG push worker

The worker snapshots exactly `'CONFIG'!A1:H20` from the Master spreadsheet, pads it to a deterministic 20×8 grid, and derives a SHA-256 hash plus a short version. Targets come only from `nv_ingestion_sources`; there are no hard-coded employee IDs. A blank status is active, while `inactive`, `disabled`, `retired`, `archived`, and `offboarded` are skipped.

Dry-run is the default:

```sh
npm run config-push:dry-run
```

Production requires all three controls and an applied audit migration:

```sh
npm run migrate:config-push
NODE_ENV=production CONFIG_PUSH_PRODUCTION=1 CONFIG_PUSH_PILOT_NV_IDS=NVxx,NVyy npm run config-push:production
```

Do not enable the production command until an owner explicitly approves 2–3 registry IDs. Production refuses a non-pilot target set unless `CONFIG_PUSH_FULL_ROLLOUT=1` is also explicitly set after pilot approval. The Render cron is separately defined and remains dry-run.

Safety properties:

- Google Sheets API and Drive metadata API only; no Apps Script and no Drive writes.
- Dry-run scopes: `spreadsheets.readonly`, `drive.metadata.readonly`. Production swaps only the Sheets scope to `spreadsheets`.
- Exact write allowlist: `'CONFIG'!A1:H20` and `'CONFIG'!X1:Y2` only.
- Concurrency is hard-capped at 2; the shared limiter is capped at 55 requests/minute.
- Google 429/5xx responses honor `Retry-After` or exponential backoff.
- Each read/write is time-bounded; writes carry an abort signal.
- Matching hash markers skip writes. A `config_written` checkpoint resumes at the marker only after re-reading and hashing CONFIG.
- Per-file failures are returned as partial results and do not block other targets.
- Production run/file audit data is stored by `migrations/009_config_push_audit.sql`.
