# Overnight run — Onicorn / Dalat Time pipeline (phases 1–7)

Generated: 2026-09-11T15:27:52.745Z · Base commit: `2d1d74c` (main, up to date with origin)

**Read-only guarantee for this entire session:** no Google write call was made, no
database mutation was made, no secret was logged, no token was rotated. Every live
check below is either a GET-only Google read or a single read-only Postgres `SELECT`.

## What I found on arrival

The repo already contains a mature, mostly-complete implementation of this pipeline
from prior sessions (migrations 001–005, `scripts/master_snapshot.py`, the
`automation/report_batch` fail-closed worker, `render.yaml`, and `src/report/*` customer
portal isolation). There was uncommitted work in progress finishing a **current-watermark
DB parity gate**:

- `src/reconciliation/currentWatermarkParity.mjs` — already committed (4975c3d)
- `scripts/current-watermark-parity.mjs`, `test/current-watermark-parity.test.mjs` — new, untracked
- `README.md`, `package.json` — wiring/documentation for the new `phase4:parity` script
- `src/importers/liveMaster.mjs` — staff active/inactive status now reads the live sheet's
  `TÌNH TRẠNG` column (falls back to `TRẠNG THÁI`/`STATUS`)
- `.env.example` — added dashboard-auth and batch-worker variables; **one line
  (`CUSTOMER_REPORT_FOLDER_ID`) had been corrupted mid-edit** (a character was dropped).
  I restored it to match the real value in `.env.local`.

I kept all of this work as-is (it was correct and well-tested) and only fixed the one
corrupted line. I also untracked an accidentally-committed compiled Python artifact
(`scripts/__pycache__/master_snapshot.cpython-312.pyc`) that `.gitignore` already
excludes — file kept on disk, just removed from git, no behavior change.

## Phase-by-phase status

### Phase 1–2 — Schema/config + robust read-only Google ingestion — **code complete, verified live**

- Employee/source tracking lives in `source_files` (`file_type` ∈ `employee|customer_report|master`,
  migration 001) plus `clients`/`staff`/`brands`/`channels` tables — this is the canonical-mapping
  layer the task calls "employee_sources".
- `scripts/master_snapshot.py` is a **GET-only** client (`ReadonlyGoogle`) requesting only
  `spreadsheets.readonly` + `drive.metadata.readonly` scopes, paginated at 500 rows/page over
  `A:ZZ`, retrying HTTP 429 by honoring `Retry-After` (seconds or HTTP-date) before falling back
  to exponential backoff with jitter. It fetches sheets sequentially (concurrency 1, within the
  requested ≤3 bound), spools each sheet to disk to bound memory, and only marks the snapshot
  `complete`/`locked` once **every** configured sheet succeeds — any single-sheet error is captured
  per-sheet in `diagnostics`/`source_errors` and the whole snapshot stays `partial`/unlocked.
  Output is written atomically (temp file + `os.replace`) and SHA-256 fingerprinted.
- **Live evidence, run tonight** (credentials and network were available in this environment):

  ```
  npm run phase4:export
  → reports/phase4/master-snapshot-complete-20260911T152206Z.json
    run_id ee554ffc-519d-4e58-8228-1bcbbaa89d82
    sha256 f293c3e518a27b9e0f22c3656cf606d45402f21a4fef399730d5501821ee0464
    status=complete locked=true source_errors=[] duration=204,805 ms
    counts: clients 149, staff 998, channels 157, brands 174,
            raw_data 5065, normalized 65296, config 12, sync_log 951
  ```

### Phase 3 — Normalization/validation and DQ reports matching Master semantics — **code complete, verified live**

`src/reconciliation/currentWatermarkParity.mjs` drops title/instruction/header rows,
fully empty rows, and schema/status-invalid rows before any comparison; canonicalizes
`post_url` (case fold, strip query/hash/trailing slash); validates `KH\d+`/`NV\d+`/`CH\d+`
ID conventions; and computes distinct-key sets for `post_url` and `(post_url, brand)` —
matching the same dedupe semantics used by the customer-report API
(`src/report/queries.mjs:dedupedSource`). The batch envelope path
(`automation/report_batch/pipeline.py:normalize_rows`) applies the equivalent
header/instruction-drop and semantic-key de-dupe for the Render cron's snapshot.

### Phase 4 — Dual-run reconciliation, exact mismatches, no unsafe repairs — **code complete; live run correctly BLOCKED**

```
npm run phase4:parity -- --snapshot reports/phase4/master-snapshot-complete-20260911T152206Z.json
→ verdict: blocked · publish_allowed: false · exit code 3 · repair_performed: false
```

| Dataset | Master | DB | Missing | Extra |
|---|---:|---:|---:|---:|
| clients | 145 | 143 | 2 | 0 |
| staff | 36 | 37 | 18 | 19 |
| channels | 152 | 147 | 5 | 0 |
| brands | 170 | 168 | 2 | 0 |
| raw_data | 5019 | 4878 | 141 | 0 |
| normalized | 65170 | 63034 | 2186 | 50 |

Full exact missing/extra key lists: `reports/phase4/current-watermark-parity-20260911T152547Z.{json,md}`.
Latency: master normalization 815 ms, DB `SELECT` 11,679 ms, total 12,737 ms.

**Root cause (evidence, not speculation):** a direct read-only query of `sync_runs` shows
the last DB-mirror import (`phase2_2_exact_sheet_mirror`) finished **2026-09-08T13:57:18Z**
with `rows_read=4931`, `rows_written=68094` (raw 4,931 / brand 63,163 in `meta`). Direct
counts confirm `posts_raw_sheet=4931`, `post_brands_sheet=63163`,
`staff.max(updated_at)=2026-09-08T13:56:28Z`. The live Google Master has since grown
(Drive `modifiedTime` now `2026-09-11T09:55:59Z`; normalized rows 63,163 → 65,296).

**This is a freshness/scheduling gap, not a bug in ingestion, normalization, or the gate.**
The gate did exactly what it's designed to do: proved a real distinct-key difference,
wrote exact missing/extra lists, performed no repair on either system, and exited non-zero.
This reconfirms — with a same-day fresh watermark — the same class of blocker already
recorded on 2026-09-09 in `docs/batch-go-live.md` / `reports/phase4/final-reconciliation-20260909.json`.

### Phase 5 — Customer published snapshot isolation/freshness/LKG — **code complete**

- Tokens are stored/compared only as SHA-256 hashes via `crypto.timingSafeEqual`
  (`src/report/config.mjs`) — no plaintext token is ever persisted or logged.
- Every report query (`src/report/queries.mjs`) is scoped by an `EXISTS` subquery on
  `brands.client_code = customer.clientCode AND brands.active = true`; brand/channel
  query-string filters are validated against that same customer's own scope before use.
- Every report response sets `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex, nofollow`.
- The batch/cron publish path (`automation/report_batch/runner.py`) keeps
  `published.json` / `last-known-good.json` manifests plus immutable
  `runs/<run_id>/master-snapshot.json` objects in private Supabase Storage; rollback
  requires the literal `--confirm ROLLBACK` and only ever restores from last-known-good.
- **Caveat:** the live Node dashboard/customer-report API reads Postgres directly (not
  the batch-published/LKG snapshot), so its freshness is bounded by the same DB-mirror
  staleness identified in Phase 4 (currently ~3 days behind the Sheet) until that mirror
  is re-imported.

### Phase 6 — Render cron/storage/alerts/rollback/auto paths — **code complete, verified**

```
npm run render:verify → RENDER_BLUEPRINT_OK render.yaml
```

- Web service: `/healthz` health check; `DATABASE_URL`, `GOOGLE_APPLICATION_CREDENTIALS`,
  and report-portal config are `sync: false` (Render secrets, never committed).
- Cron service: pay-per-run, no persistent disk/always-on worker, already set to
  `scheduled-run --production` — but internally fail-closed via `go_live_checks`/`reconcile`
  before anything is ever published.
- Auto-export path: a scheduled run with no `MASTER_SNAPSHOT_PATH` exports the Sheet live
  via `master_snapshot.py --live` into an ephemeral `/tmp` dir; an unset
  `REPORT_SNAPSHOT_PATH` derives a rows projection from that validated envelope.
- Supabase Storage upload is disabled unless `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  + `SNAPSHOT_BUCKET` are **all** present; object paths are sanitized against traversal
  (`storage.py:safe_path`).
- `JsonlLogger` redacts secret-shaped fields/values before every audit-log write; the
  `FAILURE_NOTIFY_URL` alert is best-effort and a failed alert never masks the original
  blocking error.
- Rollback requires the exact string `--confirm ROLLBACK` and only ever restores from
  `last-known-good.json` / `last-known-good-snapshot.json`.
- **Not performed:** no Render deployment, redeploy, or actual cron trigger (no Render
  API access in this environment). Verification was local-equivalent only
  (`render:verify` + the Python unit tests below).

### Phase 7 — Production verification scripts/tests — **run tonight, all passing**

| Command | Result |
|---|---|
| `npm run check` | ✅ pass (compileall + `node --check` on every entrypoint) |
| `npm test` | ✅ 10/10 pass, 132.5 ms |
| `npm run batch:test` (`python_tests`, 14 tests) | ✅ 14/14 pass, ~2.9 s |
| `npm run render:verify` | ✅ `RENDER_BLUEPRINT_OK` |
| `npm run phase4:export` (live) | ✅ complete, locked, 0 errors, 204.8 s |
| `npm run phase4:parity` (live) | ✅ correctly blocked, exit 3, exact evidence written |

## Files touched tonight

- Fixed: `.env.example` (restored corrupted `CUSTOMER_REPORT_FOLDER_ID`)
- Untracked (hygiene, no behavior change): `scripts/__pycache__/master_snapshot.cpython-312.pyc`
- Preserved as-is (already correct): `README.md`, `package.json`, `src/importers/liveMaster.mjs`,
  `scripts/current-watermark-parity.mjs`, `test/current-watermark-parity.test.mjs`
- New: `reports/FINAL-OVERNIGHT-2026-09-12.md`, `reports/FINAL-OVERNIGHT-2026-09-12.json`

## Blockers / manual steps (cannot be done autonomously)

1. **DB mirror is stale (2026-09-08 → 2026-09-11 gap).** Manual step:
   ```bash
   npm run phase1:import        # or the exact-mirror path:
   node scripts/phase22-import-exact-sheet-mirror.mjs
   npm run phase4:export
   npm run phase4:parity -- --snapshot <new snapshot file>
   ```
   Confirm a clean (non-blocked) parity pass before treating publication as safe.
   *Not run automatically*: this mutates the production database, which is a
   hard-to-reverse, outward-facing action outside the read-only scope of this run.
2. **No scheduled job refreshes the DB mirror itself.** `render.yaml` only schedules the
   customer-report cron; the mirror import is currently manual/ad hoc. Adding a recurring
   ingestion cron is a new production-mutating schedule and needs explicit sign-off.
3. Cosmetic only: `src/bonus`, `src/exporters`, `src/normalizers`, `src/config` are empty
   scaffolding directories from 2026-09-08; the real logic already lives in
   `scripts/phase15-*.mjs` and `src/reconciliation/*`. No functional gap.

## Production go-live status

**Code complete: yes.** Every phase 1–7 code path is implemented, unit-tested, and was
exercised tonight with real, live, read-only evidence (not fixtures).

**Production verified/live: no — correctly blocked.** The Postgres mirror is genuinely
stale relative to the live Google Master as of 2026-09-11. The fail-closed gate did
exactly what it was built to do: it did not publish, did not repair either system, and
produced exact, reproducible evidence of the gap. Go-live requires the manual DB
re-import step above, followed by a clean parity re-run.
