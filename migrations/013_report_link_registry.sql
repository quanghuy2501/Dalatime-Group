-- Token hashes authorize report access. Encrypted token material exists only so
-- the authenticated admin UI can reconstruct a link; plaintext is never stored.
create table if not exists report_link_registry (
  scope text not null check (scope in ('customer','brand')),
  object_code text not null check (length(trim(object_code)) > 0),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text,
  token_iv text,
  token_tag text,
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  primary key (scope,object_code),
  unique (token_hash),
  check ((token_ciphertext is null and token_iv is null and token_tag is null)
    or (token_ciphertext is not null and token_iv is not null and token_tag is not null)),
  check ((status='active' and revoked_at is null) or status='revoked')
);

create index if not exists report_link_registry_active_scope_idx
  on report_link_registry(scope,object_code) where status='active';

comment on table report_link_registry is 'DB-backed customer/brand report token registry; never stores plaintext tokens';
