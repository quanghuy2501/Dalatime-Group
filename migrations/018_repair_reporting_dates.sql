-- Repair only unambiguous legacy US-style dates while preserving the original
-- raw value for audit. Truly invalid dates remain in source storage and are
-- excluded from decision/report surfaces by the current read view.

update posts_raw_sheet
set posted_date=make_date(
      split_part(raw_posted_date,'/',3)::integer,
      split_part(raw_posted_date,'/',1)::integer,
      split_part(raw_posted_date,'/',2)::integer
    ),
    posted_date_parse_ok=true
where posted_date is null
  and raw_posted_date ~ '^\d{1,2}/\d{1,2}/\d{4}$'
  and split_part(raw_posted_date,'/',1)::integer between 1 and 12
  and split_part(raw_posted_date,'/',2)::integer between 13 and 31;

update post_brands_sheet b
set posted_date=p.posted_date
from posts_raw_sheet p
where p.row_key=b.raw_sheet_row_key
  and p.posted_date is not null
  and b.posted_date is distinct from p.posted_date;

refresh materialized view reporting_posts_canonical;

create or replace view reporting_posts_current as
select *
from reporting_posts_canonical
where posted_date_parse_ok
  and posted_date is not null
  and posted_date <= current_date;

comment on view reporting_posts_current is
  'Canonical reporting rows with a valid business date no later than today; invalid and future rows remain traceable in the canonical materialized view.';
