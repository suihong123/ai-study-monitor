alter table records add column if not exists frequency_boosted_by_abnormal boolean default false;
alter table records add column if not exists frequency_lowered_by_focus boolean default false;
