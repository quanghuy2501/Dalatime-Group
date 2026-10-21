# Web catalog administration

## Production ownership

PostgreSQL is the operational source of truth for customers, brands, staff, and channels. Employees continue entering daily posts in their existing Google Sheets. Managers use the authenticated dashboard. Customers keep using token-scoped reports.

The flow is:

`Web catalog -> PostgreSQL -> employee CONFIG -> employee daily Sheet -> direct ingestion -> PostgreSQL -> dashboard/customer report`.

Master is retained as a transition and recovery reference. The recurring Render jobs do not pull catalog rows from Master when `CATALOG_AUTHORITY=database`.

## Safety contract

- Migration 014 is additive. It adds web-edit fields, optimistic `change_version`, CONFIG ordering/visibility, and immutable audit rows.
- The API exposes list, create, and update only. There is no DELETE route.
- Deactivation replaces deletion. A client with active brands and a staff member owning active channels cannot be deactivated.
- Every write uses a transaction, validates allowed fields and relationships, records before/after data, and checks `change_version` to prevent lost updates.
- Customer and brand report-key activation or revocation occurs in the same transaction as the catalog change.
- A successful save queues CONFIG distribution. The Google write allowlist remains restricted to the four employee CONFIG blocks.
- Daily post sheets and existing post/report data are never rewritten by catalog administration.

## One-time cutover

Run the additive migration first. The cutover reads only the four existing Master catalog/config blocks, performs no Google write, preserves historical database rows, and rolls back unless the exact CONFIG projection matches.

```sh
npm run migrate:web-admin
npm run catalog:cutover
NODE_ENV=production CATALOG_CUTOVER_PRODUCTION=1 npm run catalog:cutover -- --apply
```

After cutover, set these Render values on the web, direct-ingestion, and CONFIG services as declared in `render.yaml`:

```text
CATALOG_AUTHORITY=database
CONFIG_PUSH_PRODUCTION=1
CONFIG_PUSH_FULL_ROLLOUT=1
```

## Admin endpoints

- `GET /api/admin/catalog/summary`
- `GET /api/admin/catalog/suggestions`
- `GET /api/admin/catalog/audit`
- `GET|POST /api/admin/catalog/:entity`
- `PATCH /api/admin/catalog/:entity/:id`
- `GET /api/admin/reports/staff/:id`

All endpoints inherit dashboard authentication. Supported entities are exactly `clients`, `brands`, `staff`, and `channels`.

## Acceptance checks

1. `/healthz` reports `webCatalogAdmin: true` and `databaseCatalogAuthority: true`.
2. Catalog counts and CONFIG parity match the approved cutover snapshot.
3. `npm run config-push:dry-run` reports every active employee file as `hash_skip` with zero writes.
4. Creating a temporary approved test row produces an audit entry and report key where applicable; deactivate it instead of deleting it.
5. An employee daily-sheet update appears after the next direct-ingestion cycle and is visible in both manager and customer reports.

## Rollback

Code rollback is non-destructive: redeploy the prior Git commit and set `CATALOG_AUTHORITY=master`. Do not reverse migration 014 and do not delete audit rows. Existing catalog and report data remain readable. Before using Master as authority again, run the cutover command without `--apply` and review parity so stale Master data cannot silently replace newer web edits.
