alter table bonus_rules add column if not exists amount_fulltime numeric not null default 0;
alter table bonus_rules add column if not exists amount_parttime numeric not null default 0;
alter table bonus_rules add column if not exists amount_legacy numeric;
update bonus_rules set amount_legacy = amount where amount_legacy is null;
