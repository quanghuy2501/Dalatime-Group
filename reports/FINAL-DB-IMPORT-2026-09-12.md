# Final DB Import — 2026-09-12

- Status: **complete**
- Publish allowed: **true**
- Source run: `ee554ffc-519d-4e58-8228-1bcbbaa89d82`
- Source fingerprint: `f293c3e518a27b9e0f22c3656cf606d45402f21a4fef399730d5501821ee0464`
- Transaction committed: **true**
- Backup: `reports/backups/final-db-import-before-20260912T015533251Z.sql`
- Duration: 55081 ms

## Before counts

`{"clients":143,"staff":37,"channels":148,"brands":168,"posts_raw_sheet":4931,"post_brands_sheet":63163,"sync_runs":11}`

## After counts

`{"clients":145,"staff":36,"channels":152,"brands":170,"posts_raw_sheet":5028,"post_brands_sheet":65170,"sync_runs":12}`

## Blocker

None.

## Verification

- Locked source validation: **pass**
- In-transaction SELECT parity: **pass** (zero missing/extra in all six datasets)
- Customer report metric smoke (`KH0001`): **pass**
- `/healthz` and `/readyz`: **200**
- Authenticated API status, overview, brands, staff, channels, and posts: **200**
