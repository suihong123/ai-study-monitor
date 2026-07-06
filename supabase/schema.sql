create extension if not exists "pgcrypto";

create table if not exists plan_configs (
  id uuid primary key default gen_random_uuid(),
  plan_type text not null unique check (
    plan_type in ('trial', 'basic_monthly', 'standard_monthly', 'pro_monthly')
  ),
  name text not null,
  daily_minutes integer not null,
  base_interval_seconds integer not null,
  min_interval_seconds integer not null,
  report_level text not null check (report_level in ('basic', 'standard', 'advanced')),
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

create table if not exists access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan_type text not null check (
    plan_type in ('trial', 'basic_monthly', 'standard_monthly', 'pro_monthly')
  ),
  total_minutes integer not null default 0,
  used_minutes integer not null default 0,
  daily_minutes integer not null default 120,
  used_minutes_today integer not null default 0,
  last_reset_date text,
  report_level text not null default 'basic' check (report_level in ('basic', 'standard', 'advanced')),
  base_interval_seconds integer not null default 90,
  min_interval_seconds integer not null default 60,
  device_id text,
  status text not null default 'active' check (
    status in ('active', 'watch', 'paused', 'refunded', 'expired', 'disabled', 'blacklist')
  ),
  freeze_reason text,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  expires_at timestamptz
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid not null references access_codes(id) on delete cascade,
  start_time timestamptz not null,
  end_time timestamptz,
  duration_minutes integer,
  focus_rate integer,
  ai_call_count integer,
  estimated_cost numeric(10, 3),
  report_level text check (report_level in ('basic', 'standard', 'advanced')),
  session_token text,
  report_token text not null default gen_random_uuid()::text,
  status text not null default 'active' check (
    status in ('active', 'completed', 'expired')
  ),
  ip text,
  user_agent text,
  last_active_at timestamptz default now(),
  created_at timestamptz not null default now()
);

create table if not exists records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  status text not null check (
    status in ('studying', 'distracted', 'away', 'lying', 'unrelated', 'unknown')
  ),
  timestamp timestamptz not null,
  confidence numeric,
  reason text,
  analyze_mode text default 'mock',
  presence text default 'present' check (presence in ('present', 'away')),
  learning_state text default 'uncertain' check (
    learning_state in ('studying', 'uncertain')
  ),
  current_frequency_seconds integer,
  frequency_boosted_by_abnormal boolean default false,
  frequency_lowered_by_focus boolean default false,
  triggered_reminder boolean default false,
  reminder_type text check (reminder_type in ('uncertain', 'away')),
  reminder_text text,
  ai_called boolean default true,
  error_message text,
  manual_corrected boolean default false,
  correction_source text,
  corrected_at timestamptz
);

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

create index if not exists idx_access_codes_code on access_codes(code);
create index if not exists idx_sessions_access_code_id on sessions(access_code_id);
create unique index if not exists idx_sessions_report_token on sessions(report_token);
create index if not exists idx_records_session_id on records(session_id);
create index if not exists idx_error_logs_created_at on error_logs(created_at);
create index if not exists idx_ai_call_logs_created_at on ai_call_logs(created_at);
create index if not exists idx_suspicious_logs_created_at on suspicious_logs(created_at);
create index if not exists idx_admin_actions_access_code_id on admin_actions(access_code_id);
create index if not exists idx_admin_actions_created_at on admin_actions(created_at);

alter table plan_configs enable row level security;
alter table access_codes enable row level security;
alter table sessions enable row level security;
alter table records enable row level security;
alter table error_logs enable row level security;
alter table ai_call_logs enable row level security;
alter table suspicious_logs enable row level security;
alter table admin_actions enable row level security;

-- 本项目所有数据库写入都通过 Next.js API Routes 的 service role key 完成。
-- 不创建 anon 访问策略，避免浏览器端直接读写业务数据。
