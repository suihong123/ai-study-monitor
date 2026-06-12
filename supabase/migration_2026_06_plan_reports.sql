create extension if not exists "pgcrypto";

create table if not exists plan_configs (
  id uuid primary key default gen_random_uuid(),
  plan_type text not null unique,
  name text not null,
  daily_minutes integer not null,
  base_interval_seconds integer not null,
  min_interval_seconds integer not null,
  report_level text not null,
  price_suggest text,
  created_at timestamptz not null default now()
);

insert into plan_configs (
  plan_type,
  name,
  daily_minutes,
  base_interval_seconds,
  min_interval_seconds,
  report_level,
  price_suggest
) values
  ('trial', '体验版', 120, 90, 60, 'basic', '体验'),
  ('basic_monthly', '基础月卡', 120, 90, 60, 'basic', '适合每天2小时作业监督'),
  ('standard_monthly', '标准月卡', 180, 60, 30, 'standard', '适合每天3小时作业监督'),
  ('pro_monthly', '强化月卡', 240, 30, 15, 'advanced', '适合每天4小时高强度监督')
on conflict (plan_type) do update set
  name = excluded.name,
  daily_minutes = excluded.daily_minutes,
  base_interval_seconds = excluded.base_interval_seconds,
  min_interval_seconds = excluded.min_interval_seconds,
  report_level = excluded.report_level,
  price_suggest = excluded.price_suggest;

alter table access_codes add column if not exists daily_minutes integer not null default 120;
alter table access_codes add column if not exists used_minutes_today integer not null default 0;
alter table access_codes add column if not exists last_reset_date text;
alter table access_codes add column if not exists report_level text not null default 'basic';
alter table access_codes add column if not exists base_interval_seconds integer not null default 90;
alter table access_codes add column if not exists min_interval_seconds integer not null default 60;
alter table access_codes add column if not exists freeze_reason text;
alter table access_codes add column if not exists admin_notes text;
alter table access_codes add column if not exists updated_at timestamptz;

alter table access_codes drop constraint if exists access_codes_plan_type_check;
update access_codes set
  plan_type = 'standard_monthly',
  daily_minutes = 180,
  report_level = 'standard',
  base_interval_seconds = 60,
  min_interval_seconds = 30
where plan_type = 'weekly';

update access_codes set
  plan_type = 'pro_monthly',
  daily_minutes = 240,
  report_level = 'advanced',
  base_interval_seconds = 30,
  min_interval_seconds = 15
where plan_type = 'monthly';

alter table access_codes add constraint access_codes_plan_type_check check (
  plan_type in ('trial', 'basic_monthly', 'standard_monthly', 'pro_monthly')
);
alter table access_codes drop constraint if exists access_codes_status_check;
alter table access_codes add constraint access_codes_status_check check (
  status in ('active', 'watch', 'paused', 'refunded', 'expired', 'disabled', 'blacklist')
);
alter table access_codes drop constraint if exists access_codes_report_level_check;
alter table access_codes add constraint access_codes_report_level_check check (
  report_level in ('basic', 'standard', 'advanced')
);

alter table sessions add column if not exists ai_call_count integer;
alter table sessions add column if not exists estimated_cost numeric(10, 3);
alter table sessions add column if not exists report_level text;
alter table sessions add column if not exists session_token text;
alter table sessions add column if not exists status text not null default 'active';
alter table sessions add column if not exists ip text;
alter table sessions add column if not exists user_agent text;
alter table sessions drop constraint if exists sessions_report_level_check;
alter table sessions add constraint sessions_report_level_check check (
  report_level in ('basic', 'standard', 'advanced')
);

alter table records add column if not exists current_frequency_seconds integer;
alter table records add column if not exists triggered_reminder boolean default false;
alter table records add column if not exists ai_called boolean default true;
alter table records add column if not exists error_message text;
alter table records add column if not exists confidence numeric;
alter table records add column if not exists reason text;
alter table records add column if not exists analyze_mode text default 'mock';
alter table records add column if not exists manual_corrected boolean default false;
alter table records add column if not exists correction_source text;
alter table records add column if not exists corrected_at timestamptz;

create table if not exists error_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete set null,
  access_code_id uuid references access_codes(id) on delete set null,
  error_type text not null,
  error_message text not null,
  stack text,
  created_at timestamptz not null default now()
);

create table if not exists ai_call_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete set null,
  access_code_id uuid references access_codes(id) on delete set null,
  model_type text not null,
  status text not null,
  input_size integer default 0,
  output_size integer default 0,
  estimated_cost numeric(10, 3) not null default 0,
  latency_ms integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists suspicious_logs (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid references access_codes(id) on delete set null,
  ip text,
  user_agent text,
  event_type text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin text not null,
  access_code_id uuid references access_codes(id) on delete set null,
  action_type text not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_error_logs_created_at on error_logs(created_at);
create index if not exists idx_ai_call_logs_created_at on ai_call_logs(created_at);
create index if not exists idx_suspicious_logs_created_at on suspicious_logs(created_at);
create index if not exists idx_admin_actions_access_code_id on admin_actions(access_code_id);
create index if not exists idx_admin_actions_created_at on admin_actions(created_at);

alter table plan_configs enable row level security;
alter table error_logs enable row level security;
alter table ai_call_logs enable row level security;
alter table suspicious_logs enable row level security;
alter table admin_actions enable row level security;
