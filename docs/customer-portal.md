# Customer and brand report registry

Customer and brand reports use `report_link_registry` in Supabase. Google Sheets are not written by this feature and `work.dalattimegroup.com` is outside its scope.

## Security and lifecycle

The identity is `(scope, object_code)`, where scope is `customer` or `brand`. The table has a primary key on that pair and a unique SHA-256 `token_hash`. Runtime authorization derives scope and code only from the matched registry row; URL/query parameters cannot change the object.

Tokens have `active` or `revoked` status plus `created_at`, `rotated_at`, and `revoked_at`. Rotation replaces the hash and immediately invalidates the old token. Inactive customers, inactive brands, and active brands with duplicate canonical names are revoked by the ensure job. All missing, revoked, ambiguous, inactive, malformed, and database-error cases fail closed.

The optional token material is AES-256-GCM encrypted with `REPORT_REGISTRY_ENCRYPTION_KEY`. Plaintext is never stored in the database or application logs. The key must be 32 bytes encoded as 64 hex characters or base64. Generate it locally with `openssl rand -hex 32`, then store it as a Render secret. Do not commit or print the production value.

## Install migration (manual approval only)

Migration `migrations/013_report_link_registry.sql` creates only the table and indexes. This repository task does not run it in production. After review and explicit approval:

```bash
npm run migrate:report-registry
```

## Migrate the existing 145 customer links without plaintext

The old config already contains SHA-256 hashes, which are sufficient to preserve authentication:

```bash
# Inspect counts; no write
npm run portal:import-config -- /secure/report-customers.json

# Explicit write. Production additionally requires REPORT_REGISTRY_PRODUCTION=1.
npm run portal:import-config -- --apply /secure/report-customers.json
```

The import is transactional and writes hashes only. Imported rows appear as `hash-only` in the admin menu: their existing distributed URLs keep working, but the URL cannot be reconstructed from a hash. Rotate only when a replacement URL can be redistributed.

## One-time preservation of the old customer URLs

If the original one-time export is still available, use it once to add encrypted token material to the registry without changing any distributed URL. The JSON must be shaped as `{ "customers": [{ "clientCode", "name", "reportPath", "token" }] }`. Keep it outside the repository with owner-only permissions.

```bash
# Dry run. Output contains counts, reason labels, and client codes only.
REPORT_LEGACY_LINKS_FILE=/secure/legacy-links.json \
  npm run portal:import-legacy-links

# Explicit production write. Both controls are required.
NODE_ENV=production REPORT_REGISTRY_PRODUCTION=1 \
REPORT_LEGACY_LINKS_FILE=/secure/legacy-links.json \
  npm run portal:import-legacy-links -- --apply
```

An explicit CLI path may replace `REPORT_LEGACY_LINKS_FILE`:

```bash
npm run portal:import-legacy-links -- --apply /secure/legacy-links.json
```

The command validates that each path is exactly `/report/<token>`, rejects conflicting duplicate customer codes, imports active DB customers only, and runs all writes in one transaction. `KH00083` is resolved by matching the export name to the DB name; if there is no single match it is skipped and only its code/reason is reported. An existing active row with a different hash is preserved, not rotated. A matching active hash receives only its encrypted fields. No Google Sheets operation occurs.

On Render, do not add a recurring plaintext-import service. For a single manual run, temporarily change the report-link registry cron command to `npm run portal:import-legacy-links -- --apply`, add the export as a Render secret file, set `REPORT_LEGACY_LINKS_FILE` to that secret-file path, and manually trigger the job. After one successful run, restore `npm run portal:ensure-active -- --apply`, delete the secret file and `REPORT_LEGACY_LINKS_FILE`, and redeploy. Confirm the dashboard shows “Sẵn sàng” for sampled customers, then securely delete the local/Render plaintext export when retention is no longer required.

## Ensure links for active entities

```bash
# Dry run
npm run portal:ensure-active

# Apply after migration/key configuration
npm run portal:ensure-active -- --apply

# Optional one-time local plaintext export; file is forced to mode 0600
npm run portal:ensure-active -- --apply --output reports/report-links-once.json
```

The ensure command creates links only for missing/revoked active customers and unambiguous active brands. It revokes links that are inactive or canonically ambiguous. `--rotate` deliberately replaces all active tokens and should only be used during a coordinated rotation.

In production, writes require both `--apply` and `REPORT_REGISTRY_PRODUCTION=1`. The Render cron is therefore inert/fail-closed until an operator installs migration 013, configures the encryption key, and explicitly enables that guard. Once enabled, it runs daily; a newly active entity gets a link on the next run. Plaintext is then available from the authenticated dashboard's “Khách hàng” or “Report theo Brand” menu, where the server decrypts it for that response only. It is not written to Google Sheets or logs.

## Runtime and transition fallback

Routes remain `/report/<token>` and `/api/report/<token>/{status,overview,timeseries,posts}`.

Runtime checks the DB registry first. `REPORT_PORTAL_CONFIG_FILE` / `REPORT_PORTAL_CUSTOMERS_JSON` remains a transition fallback only when migration 013 is absent or when that object has no registry row. Once any DB row claims `(scope, code)`, config fallback cannot revive its old/revoked token. Unexpected database failures return an error rather than silently using fallback.

The admin report-links API is dashboard-authenticated. It returns no ciphertext, IV, tag, hash, or encryption key. Missing encryption keys or undecryptable legacy rows are shown as `hash-only`, never logged.

## Deployment order

1. Back up and review the current hash config.
2. Apply migration 013 manually.
3. Configure the same `REPORT_REGISTRY_ENCRYPTION_KEY` on the web and registry cron services.
4. Dry-run and import the existing hash config.
5. Verify several existing customer and brand URLs.
6. Dry-run ensure, then enable `REPORT_REGISTRY_PRODUCTION=1` for the cron after approval.
7. Retain the legacy hash config during the transition; remove it only after coverage is verified.

Never commit `.env`, a plaintext token, a report URL export, or the local link store.
