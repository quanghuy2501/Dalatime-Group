# Master Reporting Mirror V2

## Operating flow

1. An authenticated manager maintains customer, brand, staff, and channel data in the web dashboard. PostgreSQL is authoritative.
2. The audited CONFIG push sends only the approved CONFIG blocks to active employee Sheets.
3. Employees continue entering posts in their existing Sheets. Direct NV ingestion reads them into the canonical database every 30 minutes.
4. Report keys are repaired at `:05` and `:35`; the Master mirror publishes the database snapshot at `:10` and `:40`.
5. Customer web reports and the two Master report tabs therefore read the same canonical snapshot.

## Safety contract

- `MASTER_MIRROR_SPREADSHEET_ID` is the isolated copy. The runner refuses the legacy `MASTER_SPREADSHEET_ID`.
- Apply requires both `--apply` and `MASTER_MIRROR_PRODUCTION=1`.
- An advisory DB lock prevents overlapping publications.
- RAW and NORMALIZED are first written to staging, read back, and hash-verified.
- Final publication uses one Sheets batch request. Surplus rows are removed to stay below the Sheets cell ceiling.
- Final RAW and NORMALIZED are read back and hash-verified again; report formula errors fail the run.
- Each attempt is recorded in `master_mirror_runs`. `DB_MIRROR_STATUS` and `DB_DATA_QUALITY` expose the latest successful snapshot and quality counts.
- Catalog rows are exact DB mappings. There is no fuzzy brand mapping and no business-row deletion API.

## Current isolated target

- Spreadsheet ID: `1F1-F0rtBxgWmcBQmnbrGYBG4lxG_gzpV0lcWwq3COw0`
- The former protected Brand tab is retained hidden as `4. LIST BRAND_LEGACY` for rollback. The active `4. LIST BRAND` has no owner-only protection.
- To promote a different copy later, change only `MASTER_MIRROR_SPREADSHEET_ID` and ensure the Google service account has editor access. Keep `MASTER_SPREADSHEET_ID` pointed at the legacy sheet so the write guard remains effective.

## Verification

```sh
npm test
npm run check
npm run render:verify
MASTER_MIRROR_SPREADSHEET_ID=<copy-id> npm run master-mirror:dry-run
MASTER_MIRROR_SPREADSHEET_ID=<copy-id> MASTER_MIRROR_PRODUCTION=1 npm run master-mirror:apply
```

A successful apply reports the source watermark, row counts, snapshot hash, RAW hash, NORMALIZED hash, duration, and zero report formula errors. Re-running the same watermark must return the same hashes.
