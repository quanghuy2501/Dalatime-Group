# Master configuration push

The final data path is:

`Admin edits Master -> config push worker -> employee CONFIG sections -> employee reports -> direct NV ingestion -> Supabase -> reports/dashboard`.

Master is the only configuration editing surface. The worker never writes Master, `BAO CAO HANG NGAY`, `NORMALIZED`, salary sheets, or any non-`CONFIG` sheet.

## Audited template contract

All bounds below are dynamic. The worker discovers and validates the audited header, then finds the last row from the section identity column; no end row is hardcoded.

| Master source | Projection | Employee destination |
|---|---|---|
| `4. LIST BRAND!A5:I(last)` | A:H; omit I `LINK REPORT` | `CONFIG!A3:H(last)` (`BRAND LIST`) |
| `3. CHANNEL!A5:F(last)` | A:E; omit F `FOLLOWER` | `CONFIG!J3:N(last)` (`CHANNEL`) |
| `2. NHAN SU!A5:K(last)` | A:G; omit H:K | `CONFIG!P3:V(last)` (`NV INFO`) |
| `CONFIG!F4:H(last)` | F:H | `CONFIG!X3:Z(last)` (`THƯỞNG VIRAL`) |

Headers are currently Master row 4 (bonus row 3) and employee row 2. They are schema assertions, not copied content. If a header or its start row changes, the run fails closed. Writes use RAW values only inside the four destination column blocks from row 3 downward. When a section shrinks, only the stale tail in that same block is cleared with `values.clear`; formatting, frozen/hidden state, validations, and formulas outside the block are untouched.

`2. NHAN SU`.`TÌNH TRẠNG` is authoritative. Blank and unrecognized statuses are active. Normalized inactive variants are `Đã nghỉ`, `inactive`, `disabled`, `retired`, `archived`, and `offboarded`. Targets absent from Master are skipped. IDs are discovered from the registry and never hardcoded.

## Operation and gates

Dry-run is the default and has readonly Google scopes:

```sh
npm run config-push:dry-run
```

Production requires the CLI production flag (provided by the npm script), `NODE_ENV=production`, `CONFIG_PUSH_PRODUCTION=1`, and an explicit pilot of exactly two or three active registry IDs:

```sh
npm run migrate:config-push
NODE_ENV=production CONFIG_PUSH_PRODUCTION=1 \
  CONFIG_PUSH_PILOT_NV_IDS=NVxx,NVyy npm run config-push:production
```

Full rollout additionally requires `CONFIG_PUSH_FULL_ROLLOUT=1`. The queue is hard-capped at two files and the shared API limiter at 55 requests/minute. Google 429/5xx retries honor `Retry-After`; every file is time-bounded. Snapshot and per-section hashes, diffs, writes, errors, duration, and completed-section checkpoints are audited in `config_push_runs` and `config_push_file_audit`. Every run rereads target values, so a checkpoint never hides later target drift.

## Pilot blocker

No production pilot is authorized by this repository. Before a pilot, an owner must name two or three active NV IDs, apply migrations 009/011, confirm the service account has edit access to only the intended employee files, and set the production gates above. A dry-run does not satisfy that approval and performs zero spreadsheet writes.
