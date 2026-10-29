-- Keep the public status endpoint from scanning the complete reporting model.
-- CONCURRENTLY avoids blocking report readers while the index is installed.
create index concurrently if not exists reporting_posts_canonical_updated_at_idx
  on reporting_posts_canonical(updated_at desc);
