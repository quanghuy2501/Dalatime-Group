-- Read-only customer report lookup support. No token material is stored in Postgres.
create index if not exists brands_client_code_active_idx on brands(client_code, active);
create index if not exists post_brands_sheet_row_key_idx on post_brands_sheet(raw_sheet_row_key);
create index if not exists posts_raw_sheet_channel_date_idx on posts_raw_sheet(channel_name, posted_date);
