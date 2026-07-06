create extension if not exists "pgcrypto";

alter table sessions add column if not exists report_token text;

update sessions
set report_token = gen_random_uuid()::text
where report_token is null;

alter table sessions alter column report_token set default gen_random_uuid()::text;
alter table sessions alter column report_token set not null;

create unique index if not exists idx_sessions_report_token
on sessions(report_token);
