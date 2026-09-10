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
- `runner_cli.py` is the worker/operator entry point. `worker` is dry-run by
  default. Publication requires the literal `--production` flag.
- `health.py` retains standalone worker liveness/readiness support. Render uses the
  existing Node web `/healthz` and `/readyz`, so customer report routing is unchanged.

All runtime snapshots, manifests, logs, local customer mappings, tokens, reports,
credentials, and `.env` files stay outside Git.

## Render Blueprint

`render.yaml` declares the existing Node web service and a Python background worker
with a persistent disk. The committed worker command intentionally omits
`--production`; it only validates that the configured sealed Master and customer
report snapshots are readable and always reports `publish_allowed: false`.

Render cron jobs are not used because this batch needs a durable lock, checkpoints,
published manifest, and last-known-good state on a persistent disk. Configure all
`sync: false` values in the Render dashboard. Place the two read-only snapshots at
the configured disk paths using an approved secure operational process.

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

Only after the final command and same-watermark parity evidence pass may an operator
change the Render worker start command to:

```bash
python3 -m automation.report_batch.runner_cli worker --production --interval-seconds 3600
```

Redeploy and confirm `/healthz`, `/readyz`, the customer report URLs, worker JSONL
events, `published.json`, and `last-known-good.json`. If a run blocks, leave the
published manifest untouched; do not delete locks or repair data automatically.

Rollback restores only the last-known-good manifests and needs exact confirmation:

```bash
python3 -m automation.report_batch.runner_cli rollback \
  --state-dir "$SNAPSHOT_DIR" --confirm ROLLBACK
```
