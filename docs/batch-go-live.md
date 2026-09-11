# Batch go-live runbook

## Deployment decision

Publication is currently **BLOCKED**. The latest local read-only reconciliation
(`reports/phase4/final-reconciliation-20260909.json`, intentionally gitignored)
has `publish_allowed: false`: RAW 4,946 vs 4,931, NORMALIZED 63,330 vs 63,163,
clients 148 vs 143, staff 998 vs 37, channels 157 vs 148, and brands 173 vs 168.
The existing customer report and web dashboard stay available, but the batch worker
must not publish until a same-watermark reconciliation passes.

## Components

- `automation/report_batch/snapshot_adapter.py` reads a local export or read-only
  endpoint and produces a sealed snapshot. It never writes Google or Postgres.
- `pipeline.py` normalizes, checkpoints, and reconciles local snapshots.
- `runner.py` stages atomically, validates parity, optionally runs one guarded
  read-only SQL `SELECT`, publishes manifests, records last-known-good state, and
  provides confirmation-gated rollback.
- `runner_cli.py` is the worker/operator entry point. A scheduled run without
  `MASTER_SNAPSHOT_PATH` exports the Master to a private ephemeral `/tmp`
  directory through `master_snapshot.py snapshot --live`. That client has only
  Sheets read-only and Drive metadata read-only scopes. The export is required
  to be complete, locked, read-only, and checksum-valid before it is adapted to
  the batch envelope. When `REPORT_SNAPSHOT_PATH` is absent, the runner creates
  a deterministic local rows projection from that validated envelope.
- `health.py` retains standalone worker liveness/readiness support. Render uses the
  existing Node web `/healthz` and `/readyz`, so customer report routing is unchanged.

All runtime snapshots, manifests, logs, local customer mappings, tokens, reports,
credentials, and `.env` files stay outside Git.

## Render Blueprint

`render.yaml` declares the existing Node web service and a daily Python cron. It
runs `scheduled-run --production`; no `MASTER_SNAPSHOT_PATH` or
`REPORT_SNAPSHOT_PATH` is required. Configure `GOOGLE_APPLICATION_CREDENTIALS`
as the path to a Render secret file containing the service-account JSON, and set
`DATABASE_URL`. Supabase upload is disabled when both its URL and service-role key
are absent; if either is set, both and `SNAPSHOT_BUCKET` are required. The immutable
Master object is uploaded only after snapshot/report validation and before local
reconciliation/publication.

The only database command allowed by this path is the single statement in
`DB_VERIFY_SELECT`; the guard rejects non-SELECT and multi-statement SQL. It never
replaces database tables and never writes Google. A blocked run exits 2 with an
exact JSON `reason`; validation/reconciliation failures leave the previous
published and last-known-good manifests untouched.

## Verification and explicit production enablement

```bash
npm run check
npm test
npm run batch:test
npm run render:verify
python3 -m automation.report_batch.runner_cli check \
  --production --master "$MASTER_SNAPSHOT_PATH" --state-dir "$SNAPSHOT_DIR" \
  --report "$REPORT_SNAPSHOT_PATH" --db-select "$DB_VERIFY_SELECT"
```

Redeploy and confirm `/healthz`, `/readyz`, the customer report URLs, cron JSONL
events, `published.json`, and `last-known-good.json`. If a run blocks, leave the
published manifest untouched; do not delete locks or repair data automatically.

Rollback restores only the last-known-good manifests and needs exact confirmation:

```bash
python3 -m automation.report_batch.runner_cli rollback \
  --state-dir "$SNAPSHOT_DIR" --confirm ROLLBACK
```
