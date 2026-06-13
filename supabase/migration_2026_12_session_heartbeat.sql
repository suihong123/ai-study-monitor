alter table sessions add column if not exists last_active_at timestamptz;

update sessions
set
  last_active_at = coalesce(last_active_at, end_time, start_time, created_at),
  status = case when status = 'ended' then 'completed' else status end
where last_active_at is null or status = 'ended';

alter table sessions alter column last_active_at set default now();

alter table sessions drop constraint if exists sessions_status_check;
alter table sessions add constraint sessions_status_check check (
  status in ('active', 'completed', 'expired')
);

create index if not exists idx_sessions_status_last_active
on sessions(status, last_active_at);
