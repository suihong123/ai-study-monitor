-- 仅用于隔离数据库。构造 19 个脱敏访问码，覆盖未使用、已绑定、
-- 已用时长、历史/活跃会话、监督记录和报告日志，不包含任何生产隐私数据。

with fixture_codes as (
  select
    n,
    'ISO' || lpad(n::text, 3, '0') as code,
    case (n - 1) % 4
      when 0 then 'trial'
      when 1 then 'basic_monthly'
      when 2 then 'standard_monthly'
      else 'pro_monthly'
    end as plan_type,
    case (n - 1) % 4
      when 0 then 120
      when 1 then 3600
      when 2 then 10800
      else 43200
    end as total_minutes
  from generate_series(1, 19) as n
)
insert into access_codes (
  id,
  code,
  plan_type,
  total_minutes,
  used_minutes,
  daily_minutes,
  used_minutes_today,
  last_reset_date,
  report_level,
  base_interval_seconds,
  min_interval_seconds,
  device_id,
  status,
  freeze_reason,
  admin_notes,
  created_at,
  updated_at,
  expires_at
)
select
  ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  code,
  plan_type,
  total_minutes,
  case when n = 1 then 0 else least(n * 5, total_minutes - 5) end,
  total_minutes,
  case when n = 1 then 0 else least(n * 5, total_minutes - 5) end,
  null,
  'basic',
  case when plan_type in ('trial', 'basic_monthly') then 90
    when plan_type = 'standard_monthly' then 60
    else 30
  end,
  case when plan_type in ('trial', 'basic_monthly') then 60
    when plan_type = 'standard_monthly' then 30
    else 15
  end,
  case when n = 1 then null else 'fixture-env-' || lpad(n::text, 3, '0') end,
  case n
    when 4 then 'watch'
    when 12 then 'paused'
    when 13 then 'refunded'
    when 14 then 'disabled'
    when 15 then 'blacklist'
    else 'active'
  end,
  case when n between 12 and 15 then '隔离测试状态' else null end,
  '脱敏隔离测试访问码 ' || n,
  now() - make_interval(days => 30 - n),
  now() - make_interval(days => 20 - least(n, 19)),
  null
from fixture_codes;

-- 历史监督会话：覆盖已结算、报告和监督记录。
insert into sessions (
  id,
  access_code_id,
  start_time,
  end_time,
  duration_minutes,
  focus_rate,
  ai_call_count,
  estimated_cost,
  report_level,
  session_token,
  report_token,
  status,
  ip,
  user_agent,
  last_active_at,
  privacy_notice_version,
  privacy_acknowledged_at,
  created_at
)
select
  ('10000000-0000-4000-8000-' || lpad(substring(code from 4)::integer::text, 12, '0'))::uuid,
  id,
  now() - interval '2 days',
  now() - interval '2 days' + interval '30 minutes',
  30,
  70,
  3,
  0.009,
  'basic',
  null,
  'report-' || code,
  'completed',
  '127.0.0.1',
  'fixture-historical-browser',
  now() - interval '2 days' + interval '30 minutes',
  '2026-07-27-v1',
  now() - interval '2 days',
  now() - interval '2 days'
from access_codes
where code between 'ISO003' and 'ISO012';

-- 进行中监督：用于验证旧令牌轮换、并发和事务回滚。
insert into sessions (
  id,
  access_code_id,
  start_time,
  end_time,
  duration_minutes,
  focus_rate,
  ai_call_count,
  estimated_cost,
  report_level,
  session_token,
  report_token,
  status,
  ip,
  user_agent,
  last_active_at,
  privacy_notice_version,
  privacy_acknowledged_at,
  created_at
)
select
  ('20000000-0000-4000-8000-' || lpad(substring(code from 4)::integer::text, 12, '0'))::uuid,
  id,
  now() - interval '10 minutes',
  null,
  null,
  null,
  1,
  0.003,
  'basic',
  'old-token-' || code,
  'active-report-' || code,
  'active',
  '127.0.0.1',
  'fixture-active-browser',
  now(),
  '2026-07-27-v1',
  now() - interval '10 minutes',
  now() - interval '10 minutes'
from access_codes
where code in ('ISO005', 'ISO008', 'ISO009', 'ISO010', 'ISO011', 'ISO019');

insert into records (
  session_id,
  status,
  timestamp,
  confidence,
  reason,
  analyze_mode,
  presence,
  learning_state,
  current_frequency_seconds,
  ai_called
)
select
  session.id,
  case sample.n when 1 then 'studying' when 2 then 'unknown' else 'away' end,
  session.start_time + make_interval(mins => sample.n),
  0.8,
  '脱敏隔离测试记录',
  'qwen',
  case when sample.n = 3 then 'away' else 'present' end,
  case when sample.n = 1 then 'studying' else 'uncertain' end,
  60,
  true
from sessions as session
cross join generate_series(1, 3) as sample(n);

-- 当前系统没有独立 reports 表；report_* AI 日志代表报告已生成。
insert into ai_call_logs (
  session_id,
  access_code_id,
  model_type,
  status,
  estimated_cost,
  latency_ms,
  created_at
)
select
  id,
  access_code_id,
  'report_basic',
  'success',
  0,
  20,
  end_time
from sessions
where status = 'completed';
