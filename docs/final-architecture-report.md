# Final architecture implementation report

Implemented the API-only configuration distribution layer between Master and employee files while retaining the existing direct NV-to-Supabase ingestion and dashboard/report query path.

Safety invariants:

- Four dynamic `CONFIG` data blocks are the entire write allowlist: `A:H`, `J:N`, `P:V`, and `X:Z`, all from row 3.
- Master headers and exact projections are validated before any target processing. Last rows come from non-empty identity keys, which avoids copying hundreds of trailing staff formula rows.
- Shrink clears only the old tail in the same allowlisted columns. Expand writes exactly through the new last row.
- Employee report tabs, normalized data, salary/other tabs, formatting, frozen/hidden state, and cells outside the allowlist are not mutated.
- Master staff status and registry presence decide eligibility; there is no NV ID list in code.
- Dry-run is default. Pilot and full rollout are separately explicit. Concurrency is two, request rate is at most 55/minute, and retry/checkpoint/hash/audit controls remain in force.

Verification covers dynamic discovery, trailing-formula handling, shrink/expand planning, write/clear allowlisting, status filtering, queue concurrency, retries, and hash skips. The live audit is readonly; production writes remain blocked pending an owner-selected pilot.

## Readonly live audit — 2026-09-16

`npm run config-push:dry-run` completed with zero Google writes and no failures: 40 registry sources, 21 active, 19 inactive, and 21 files evaluated. Final snapshot `sha256:452ddb5db2f9d005` discovered:

| Section | Master last row | Records |
|---|---:|---:|
| Brand | 174 | 170 |
| Channel | 171 | 167 range rows (166 keyed records) |
| Staff | 43 | 39 |
| Bonus | 12 | 9 |

The audit initially exposed one internal blank channel row; the final implementation preserves internal rows within the dynamic rectangle and removes only trailing rows. For most legacy files, staff has prefilled content/formulas through 994 data rows -> 39 real keyed rows, and bonus is 8 -> 9. NV40/NV41 also need brand/channel/staff expansion (120 -> 170, 99 -> 167, 25 -> 39). These are dry-run diffs only. No pilot IDs were selected and no production mutation was attempted.
