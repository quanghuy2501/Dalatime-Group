# Master staff status authority — 2026-09-16

## Implemented contract

- Master tab `2. NHAN SU`, column `TÌNH TRẠNG`, is the only staff lifecycle authority.
- `Đang làm` and blank values are active.
- `Đã nghỉ`, `inactive`, `disabled`, `retired`, `archived`, and `offboarded` are inactive.
- Employee spreadsheets absent from the Master registry are logged and skipped.
- Direct NV ingestion and CONFIG push use the same status resolver.
- Discovery uses Sheets read-only and Drive metadata read-only scopes and performs no Google writes.
- CONFIG writes remain behind the existing explicit 2–3 file pilot or separately enabled full rollout gates.

## Persistence

Migration `010_master_staff_status_authority.sql` adds `master_registry_present`. Source seeding stores the verbatim Master status and registry presence transactionally. Previously registered sources not present in the current Master read remain available as audit records with `master_registry_present=false` and cannot be targeted.

## Verification

- `npm test`: 51/51 passed.
- `npm run check`: passed.
- `npm run batch:test`: 14/14 passed.
- `npm run render:verify`: passed (`RENDER_BLUEPRINT_OK`).
- `git diff --check`: passed.
