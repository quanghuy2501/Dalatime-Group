# Master configuration push

The production data path is:

`Admin edits web catalog -> PostgreSQL -> config push worker -> employee CONFIG sections -> employee reports -> direct NV ingestion -> PostgreSQL -> reports/dashboard`.

PostgreSQL is the production configuration authority when `CATALOG_AUTHORITY=database`. Master remains available as a transition/rollback source and is never written by this worker. The worker never writes `BAO CAO HANG NGAY`, `NORMALIZED`, salary sheets, or any non-`CONFIG` sheet.

## Audited template contract

All bounds below are dynamic. The worker discovers and validates the audited header, then finds the last row from the section identity column; no end row is hardcoded.

| Database projection | Legacy Master source used for parity | Employee destination |
|---|---|---|
| `brands`, A:H shape | `4. LIST BRAND!A5:I(last)`; omit I | `CONFIG!A3:H(last)` (`BRAND LIST`) |
| `channels`, A:E shape | `3. CHANNEL!A5:F(last)`; omit F | `CONFIG!J3:N(last)` (`CHANNEL`) |
| `staff`, A:G shape | `2. NHAN SU!A5:K(last)`; omit H:K | `CONFIG!P3:V(last)` (`NV INFO`) |
| Existing bonus block | `CONFIG!F4:H(last)` | `CONFIG!X3:Z(last)` (`THƯỞNG VIRAL`) |

Headers are currently Master row 4 (bonus row 3) and employee row 2. They are schema assertions, not copied content. If a header or its start row changes, the run fails closed. Writes use RAW values only inside the four destination column blocks from row 3 downward. When a section shrinks, only the stale tail in that same block is cleared with `values.clear`; formatting, frozen/hidden state, validations, and formulas outside the block are untouched.

`staff.active` and `staff.config_visible` select production targets. During the one-time cutover they are reconciled from `2. NHAN SU`.`TÌNH TRẠNG`; blank and unrecognized legacy statuses are active. IDs are discovered from the registry and never hardcoded.

## Operation and gates

Dry-run is the default and has readonly Google scopes:

```sh
npm run config-push:dry-run
```

Authentication first uses a readable file named by `GOOGLE_APPLICATION_CREDENTIALS`. If that path is absent or unreadable, it securely parses the full service-account object from `GOOGLE_APPLICATION_CREDENTIALS_JSON` (preferred) or `GOOGLE_SERVICE_ACCOUNT_JSON`. Render Cron should use the JSON secret env because `/etc/secrets` is not mounted. Credential contents are never logged. The fallback does not change scopes: dry-run/export remain Sheets read-only plus Drive metadata read-only, while only the production-gated config pilot requests Sheets write access.

Production requires the CLI production flag (provided by the npm script), `NODE_ENV=production`, `CONFIG_PUSH_PRODUCTION=1`, and an explicit pilot of exactly two or three active registry IDs:

```sh
npm run migrate:config-push
NODE_ENV=production CONFIG_PUSH_PRODUCTION=1 \
  CONFIG_PUSH_PILOT_NV_IDS=NVxx,NVyy npm run config-push:production
```

Full rollout additionally requires `CONFIG_PUSH_FULL_ROLLOUT=1`. The queue is hard-capped at two files and the shared API limiter at 55 requests/minute. Google 429/5xx retries honor `Retry-After`; every file is time-bounded. Snapshot and per-section hashes, diffs, writes, errors, duration, and completed-section checkpoints are audited in `config_push_runs` and `config_push_file_audit`. Every run rereads target values, so a checkpoint never hides later target drift.

## Production gate

Before enabling a new environment, apply migrations 009/011/014, confirm the service account can edit only intended employee files, run a 2-3 ID pilot, then set `CONFIG_PUSH_FULL_ROLLOUT=1`. A dry-run performs zero spreadsheet writes. The production dashboard queues a push only after a successful audited catalog save.
