# Canonical reporting read model

## Non-destructive contract

`posts_raw_sheet` and `post_brands_sheet` remain the exact ingestion mirrors. The reporting cutover never updates or deletes their business rows.

`reporting_posts_canonical` is a reversible materialized projection:

- identity: normalized post URL; a missing URL falls back to `row_key`;
- selected metrics row: newest `updated_at`, then highest `row_key` as a deterministic tie-break;
- brand mapping: union of normalized brand names from every source row with the same canonical identity;
- traceability: `source_row_keys` and `source_row_count` preserve every contributing mirror row;
- date safety: `reporting_posts_current` excludes only rows whose `posted_date` is after `current_date`. Source rows remain unchanged.

Dashboard, staff reports, customer reports and brand reports must all read `reporting_posts_current` so they cannot disagree about post identity or metrics.

## Refresh and verification

Direct NV ingestion refreshes the materialized view after source publication. The manual `report_refresh_reconcile` job uses the same singleton advisory lock and concurrent refresh.

Run the production read-only gate:

```bash
npm run verify:operations
```

The gate proves source/canonical key parity, complete source-row traceability, future-date exclusion, overview count parity, RLS coverage, public-role lockout and bounded representative query latency.

## Brand mapping boundary

Only case and whitespace are normalized. The system does not guess that two differently named brands are the same. Unmatched names appear as `brand_not_in_master`; ambiguous active master names appear as `ambiguous_brand_master`. Resolution requires an explicit catalog decision, not an automatic fuzzy match.

## Rollback

Application rollback is code-only: deploy the previous commit and it will read the unchanged mirror tables. The reporting materialized view may remain in place because it is additive.

Do not roll back migration 016. Removing RLS or restoring `anon`/`authenticated` grants would reopen direct database access and is not needed for application rollback because the service connects as the trusted database owner.

## Known source action

NV41 currently has five populated rows at sheet rows 5-9 with a blank required `TÊN KÊNH` column. The ingestion correctly retains last-known-good data and reports `partial`. An operator must fill the exact channel names in the employee Sheet; the application must not infer them.

