# Master CONFIG → employee Sheets push — final report

Date: 2026-09-16
Result: implementation complete; real-data dry-run passed; production blocked pending explicit approval and registry reconciliation.

## Live read-only audit

- Master snapshot: `'CONFIG'!A1:H20`, normalized to 20×8.
- Version: `sha256:d99c0e4dd04654ab`.
- SHA-256: `d99c0e4dd04654ab59c1b2d134a99e7902e4590cbe7c347272629473781bfb59`.
- Master modified time: `2026-09-16T04:43:03.411Z`.
- Registry: 40 total, 40 active, 0 inactive, 40 blank statuses. Blank status is intentionally active.
- Employee folder: 41 files, all 41 Google Sheets.
- Permission/layout sample: 3/3 CONFIG ranges readable, 3/3 have 26 columns (so marker columns X:Y exist), and 3/3 are editable by the service account. No permission email addresses were retained in this report. All three sampled files also had an `anyone:reader` permission.
- Full dry-run: 40/40 targets completed, 0 failures, 0 current CONFIG matches, 40 would update, 0 Google writes, 0 database writes.

## Implemented controls

- Google Sheets/Drive API only; no Apps Script and no Drive writes.
- Dry-run uses only `spreadsheets.readonly` and `drive.metadata.readonly`; production uses Sheets write plus Drive metadata read-only.
- Target discovery is database-registry driven with no hard-coded employee IDs.
- Concurrency is hard-capped at 2 and API throughput at 55 requests/minute.
- 429/5xx retry honors `Retry-After`, then exponential backoff.
- Per-file timeout uses abort signals for live requests.
- Hash-marker idempotency, CONFIG re-hash validation, durable production checkpoints, and safe marker-only resume are implemented.
- One target failure cannot stop other targets; final status can be partial.
- Writes are restricted to `'CONFIG'!A1:H20` and marker range `'CONFIG'!X1:Y2`. The worker cannot create, resize, clear, or write any other sheet/range.
- Supabase/Postgres audit migration `009_config_push_audit.sql` records runs and per-file stages/results.
- npm exposes separate dry-run, production, and migration commands. Render has a separate dry-run cron.

## Pilot and full-production status

- Pilot: not run (0 files). No explicit production approval/evidence was present.
- Full production: not run (0 files).
- Tokens/credentials were not rotated or modified.

## Blockers before any write

1. Obtain explicit owner approval for a 2–3 file pilot and use a pilot-only registry.
2. Reconcile registry lifecycle state: all 40 statuses are blank/active, but legacy `INACTIVE_STAFF_IDS` identifies NV15 and NV16. The new worker correctly treats the registry as authoritative.
3. Reconcile the folder/registry count difference (41 Sheets versus 40 registry rows).
4. Apply migration 009 through the approved production migration process.
5. Review the sampled `anyone:reader` permissions and confirm they are intentional.

Only after the pilot is verified should the full registry be enabled with `--production`, `CONFIG_PUSH_PRODUCTION=1`, `NODE_ENV=production`, and the separate `CONFIG_PUSH_FULL_ROLLOUT=1` approval gate.
