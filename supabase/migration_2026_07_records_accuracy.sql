alter table records add column if not exists confidence numeric;
alter table records add column if not exists reason text;
alter table records add column if not exists analyze_mode text default 'mock';
alter table records add column if not exists manual_corrected boolean default false;
alter table records add column if not exists correction_source text;
alter table records add column if not exists corrected_at timestamptz;
