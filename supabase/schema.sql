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
  ('trial', '2小时体验版', 120, 90, 60, 'basic', '共2小时监督时长'),
  ('basic_monthly', '月卡', 3600, 90, 60, 'basic', '共60小时监督时长'),
  ('standard_monthly', '季卡', 10800, 60, 30, 'basic', '共180小时监督时长'),
  ('pro_monthly', '年卡', 43200, 30, 15, 'basic', '共720小时监督时长')
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
  last_rebind_at timestamptz,
  rebind_total integer not null default 0 check (rebind_total >= 0),
  current_device_name text,
  current_device_model text,
  current_device_platform text,
  device_bound_at timestamptz,
  reactivation_flagged_at timestamptz,
  reactivation_flag_reason text,
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
  privacy_notice_version text,
  privacy_acknowledged_at timestamptz,
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

create table if not exists ai_model_configs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'qwen' check (provider in ('qwen')),
  mode text not null default 'qwen' check (mode in ('mock', 'qwen')),
  model text not null,
  api_url text not null,
  estimated_cost_per_call numeric(10, 4) not null default 0.003,
  is_active boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

insert into ai_model_configs (
  provider,
  mode,
  model,
  api_url,
  estimated_cost_per_call,
  is_active,
  notes,
  updated_at
) values (
  'qwen',
  'qwen',
  'qwen3.6-flash',
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  0.003,
  true,
  '默认稳定模型，可在后台切换为 qwen3-vl-flash 进行低成本测试。',
  now()
)
on conflict do nothing;

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

create table if not exists device_rebind_configs (
  id boolean primary key default true check (id),
  rebind_window_days integer not null default 15
    check (rebind_window_days between 1 and 90),
  rebind_max_count integer not null default 10
    check (rebind_max_count between 1 and 100),
  rebind_min_interval_seconds integer not null default 60
    check (rebind_min_interval_seconds between 10 and 86400),
  updated_at timestamptz not null default now()
);

insert into device_rebind_configs (
  id,
  rebind_window_days,
  rebind_max_count,
  rebind_min_interval_seconds,
  updated_at
) values (
  true,
  15,
  10,
  60,
  now()
)
on conflict (id) do nothing;

create table if not exists device_rebind_logs (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid references access_codes(id) on delete set null,
  access_code text not null,
  idempotency_key text not null,
  action_source text not null default 'user'
    check (action_source in ('user', 'admin')),
  old_device_id text,
  old_device_name text,
  old_device_model text,
  old_device_platform text,
  new_device_id text,
  new_device_name text,
  new_device_model text,
  new_device_platform text,
  ip text,
  user_agent text,
  window_days integer not null default 15,
  max_count integer not null default 10,
  min_interval_seconds integer not null default 60,
  window_count_before integer not null default 0,
  window_count_after integer not null default 0,
  next_available_at timestamptz,
  success boolean not null default false,
  result_code text not null,
  failure_reason text,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (access_code_id, idempotency_key)
);

create or replace function settle_study_session(
  p_session_id uuid,
  p_end_time timestamptz,
  p_focus_rate integer,
  p_ai_call_count integer,
  p_estimated_cost numeric,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_session sessions%rowtype;
  current_code access_codes%rowtype;
  effective_end_time timestamptz;
  elapsed_minutes integer;
  available_minutes integer;
  charged_minutes integer;
begin
  if p_status not in ('completed', 'expired') then
    raise exception 'invalid settlement status';
  end if;

  select *
  into current_session
  from sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'session not found';
  end if;

  if current_session.status <> 'active' or current_session.end_time is not null then
    return jsonb_build_object(
      'skipped', true,
      'durationMinutes', coalesce(current_session.duration_minutes, 0),
      'chargedMinutes', 0
    );
  end if;

  select *
  into current_code
  from access_codes
  where id = current_session.access_code_id
  for update;

  if not found then
    raise exception 'access code not found';
  end if;

  effective_end_time := greatest(
    current_session.start_time,
    least(coalesce(p_end_time, now()), now())
  );
  elapsed_minutes := greatest(
    1,
    ceil(extract(epoch from (effective_end_time - current_session.start_time)) / 60.0)::integer
  );
  available_minutes := greatest(0, current_code.total_minutes - current_code.used_minutes);
  charged_minutes := least(elapsed_minutes, available_minutes);

  if charged_minutes < elapsed_minutes then
    effective_end_time :=
      current_session.start_time + make_interval(mins => charged_minutes);
  end if;

  update sessions
  set
    end_time = effective_end_time,
    duration_minutes = charged_minutes,
    focus_rate = p_focus_rate,
    ai_call_count = p_ai_call_count,
    estimated_cost = p_estimated_cost,
    report_level = 'basic',
    session_token = null,
    status = p_status,
    last_active_at = effective_end_time
  where id = current_session.id;

  update access_codes
  set
    used_minutes = least(
      current_code.total_minutes,
      current_code.used_minutes + charged_minutes
    ),
    used_minutes_today = least(
      current_code.total_minutes,
      current_code.used_minutes + charged_minutes
    ),
    last_reset_date = null,
    expires_at = null
  where id = current_code.id;

  return jsonb_build_object(
    'skipped', false,
    'durationMinutes', charged_minutes,
    'chargedMinutes', charged_minutes
  );
end;
$$;

revoke all on function settle_study_session(
  uuid, timestamptz, integer, integer, numeric, text
) from public;
grant execute on function settle_study_session(
  uuid, timestamptz, integer, integer, numeric, text
) to service_role;

create or replace function persist_analysis_result_if_session_current(
  p_access_code_id uuid,
  p_session_id uuid,
  p_session_token text,
  p_status text,
  p_presence text,
  p_learning_state text,
  p_timestamp timestamptz,
  p_confidence numeric,
  p_reason text,
  p_analyze_mode text,
  p_current_frequency_seconds integer,
  p_frequency_boosted_by_abnormal boolean,
  p_frequency_lowered_by_focus boolean,
  p_model_type text,
  p_input_size integer,
  p_output_size integer,
  p_estimated_cost numeric,
  p_latency_ms integer,
  p_model_error_message text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_session sessions%rowtype;
  new_record_id uuid;
begin
  select *
  into current_session
  from sessions
  where id = p_session_id
    and access_code_id = p_access_code_id
  for update;

  if not found
    or current_session.status <> 'active'
    or current_session.end_time is not null
    or current_session.session_token is distinct from p_session_token then
    return jsonb_build_object(
      'persisted', false,
      'recordId', null,
      'resultCode', 'session_reactivated_elsewhere'
    );
  end if;

  if nullif(trim(coalesce(p_model_error_message, '')), '') is not null then
    insert into error_logs (
      session_id,
      access_code_id,
      error_type,
      error_message
    ) values (
      current_session.id,
      p_access_code_id,
      'analyze接口失败',
      p_model_error_message
    );
  end if;

  insert into records (
    session_id,
    status,
    presence,
    learning_state,
    timestamp,
    confidence,
    reason,
    analyze_mode,
    current_frequency_seconds,
    frequency_boosted_by_abnormal,
    frequency_lowered_by_focus,
    reminder_type,
    reminder_text,
    ai_called
  ) values (
    current_session.id,
    p_status,
    p_presence,
    p_learning_state,
    p_timestamp,
    p_confidence,
    p_reason,
    p_analyze_mode,
    p_current_frequency_seconds,
    coalesce(p_frequency_boosted_by_abnormal, false),
    coalesce(p_frequency_lowered_by_focus, false),
    null,
    null,
    true
  )
  returning id into new_record_id;

  insert into ai_call_logs (
    session_id,
    access_code_id,
    model_type,
    status,
    input_size,
    output_size,
    estimated_cost,
    latency_ms
  ) values (
    current_session.id,
    p_access_code_id,
    p_model_type,
    'success',
    greatest(coalesce(p_input_size, 0), 0),
    greatest(coalesce(p_output_size, 0), 0),
    greatest(coalesce(p_estimated_cost, 0), 0),
    greatest(coalesce(p_latency_ms, 0), 0)
  );

  return jsonb_build_object(
    'persisted', true,
    'recordId', new_record_id,
    'resultCode', 'recorded'
  );
end;
$$;

revoke all on function persist_analysis_result_if_session_current(
  uuid, uuid, text, text, text, text, timestamptz, numeric, text, text,
  integer, boolean, boolean, text, integer, integer, numeric, integer, text
) from public, anon, authenticated;

grant execute on function persist_analysis_result_if_session_current(
  uuid, uuid, text, text, text, text, timestamptz, numeric, text, text,
  integer, boolean, boolean, text, integer, integer, numeric, integer, text
) to service_role;

create or replace function get_device_rebind_status(
  p_access_code_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  config_window_days integer := 15;
  config_max_count integer := 10;
  config_min_interval_seconds integer := 60;
  recent_count integer := 0;
  first_success_at timestamptz;
  last_success_at timestamptz;
  next_available_at timestamptz;
  allowed boolean := true;
  limit_reason text;
begin
  select
    rebind_window_days,
    rebind_max_count,
    rebind_min_interval_seconds
  into
    config_window_days,
    config_max_count,
    config_min_interval_seconds
  from device_rebind_configs
  where id = true;

  if not found then
    config_window_days := 15;
    config_max_count := 10;
    config_min_interval_seconds := 60;
  end if;

  select
    count(*)::integer,
    min(created_at),
    max(created_at)
  into
    recent_count,
    first_success_at,
    last_success_at
  from device_rebind_logs
  where access_code_id = p_access_code_id
    and action_source = 'user'
    and success = true
    and result_code = 'rebound'
    and created_at > now() - make_interval(days => config_window_days);

  if recent_count >= config_max_count then
    allowed := false;
    limit_reason := 'window_limit_reached';
    next_available_at := first_success_at + make_interval(days => config_window_days);
  elsif last_success_at is not null
    and last_success_at + make_interval(secs => config_min_interval_seconds) > now() then
    allowed := false;
    limit_reason := 'rate_limited';
    next_available_at :=
      last_success_at + make_interval(secs => config_min_interval_seconds);
  end if;

  return jsonb_build_object(
    'usedCount', recent_count,
    'maxCount', config_max_count,
    'nextCount', least(config_max_count, recent_count + 1),
    'windowDays', config_window_days,
    'minIntervalSeconds', config_min_interval_seconds,
    'allowed', allowed,
    'limitReason', limit_reason,
    'nextAvailableAt', next_available_at
  );
end;
$$;

create or replace function perform_device_rebind(
  p_access_code text,
  p_new_device_id text,
  p_new_device_name text,
  p_new_device_model text,
  p_new_device_platform text,
  p_idempotency_key text,
  p_new_session_token text,
  p_ip text,
  p_user_agent text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_code access_codes%rowtype;
  existing_response jsonb;
  config_window_days integer := 15;
  config_max_count integer := 10;
  config_min_interval_seconds integer := 60;
  recent_count integer := 0;
  first_success_at timestamptz;
  last_success_at timestamptz;
  next_available_at timestamptz;
  success_count_24h integer := 0;
  failed_count_10m integer := 0;
  distinct_user_agents_24h integer := 0;
  response jsonb;
begin
  if coalesce(trim(p_access_code), '') = ''
    or coalesce(trim(p_new_device_id), '') = ''
    or coalesce(trim(p_idempotency_key), '') = '' then
    return jsonb_build_object(
      'success', false,
      'resultCode', 'invalid_request',
      'message', '重新绑定请求信息不完整',
      'usedCount', 0,
      'maxCount', 10,
      'nextCount', 0,
      'windowDays', 15,
      'minIntervalSeconds', 60,
      'allowed', false,
      'limitReason', 'invalid_request',
      'nextAvailableAt', null,
      'replayed', false
    );
  end if;

  select *
  into current_code
  from access_codes
  where code = trim(p_access_code)
  for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'resultCode', 'access_code_not_found',
      'message', '访问码不存在',
      'usedCount', 0,
      'maxCount', 10,
      'nextCount', 0,
      'windowDays', 15,
      'minIntervalSeconds', 60,
      'allowed', false,
      'limitReason', 'access_code_not_found',
      'nextAvailableAt', null,
      'replayed', false
    );
  end if;

  select response_payload
  into existing_response
  from device_rebind_logs
  where access_code_id = current_code.id
    and idempotency_key = p_idempotency_key
  limit 1;

  if found then
    return existing_response || jsonb_build_object('replayed', true);
  end if;

  select
    rebind_window_days,
    rebind_max_count,
    rebind_min_interval_seconds
  into
    config_window_days,
    config_max_count,
    config_min_interval_seconds
  from device_rebind_configs
  where id = true;

  if not found then
    config_window_days := 15;
    config_max_count := 10;
    config_min_interval_seconds := 60;
  end if;

  if current_code.status not in ('active', 'watch') then
    response := jsonb_build_object(
      'success', false,
      'resultCode', 'access_code_unavailable',
      'message', '访问码当前不可用',
      'usedCount', 0,
      'maxCount', config_max_count,
      'nextCount', 0,
      'windowDays', config_window_days,
      'minIntervalSeconds', config_min_interval_seconds,
      'allowed', false,
      'limitReason', 'access_code_unavailable',
      'nextAvailableAt', null,
      'replayed', false
    );

    insert into device_rebind_logs (
      access_code_id, access_code, idempotency_key, action_source,
      old_device_id, old_device_name, old_device_model, old_device_platform,
      new_device_id, new_device_name, new_device_model, new_device_platform,
      ip, user_agent, window_days, max_count, min_interval_seconds,
      window_count_before, window_count_after, next_available_at,
      success, result_code, failure_reason, response_payload
    ) values (
      current_code.id, current_code.code, p_idempotency_key, 'user',
      current_code.device_id, current_code.current_device_name,
      current_code.current_device_model, current_code.current_device_platform,
      p_new_device_id, nullif(trim(p_new_device_name), ''),
      nullif(trim(p_new_device_model), ''), nullif(trim(p_new_device_platform), ''),
      p_ip, p_user_agent, config_window_days, config_max_count,
      config_min_interval_seconds, 0, 0, null,
      false, 'access_code_unavailable', current_code.status, response
    );

    return response;
  end if;

  -- 兜底处理直接调用重新激活接口的首次激活；首次激活不计次数、不写历史。
  if current_code.device_id is null then
    update access_codes
    set
      device_id = p_new_device_id,
      current_device_name = nullif(trim(p_new_device_name), ''),
      current_device_model = nullif(trim(p_new_device_model), ''),
      current_device_platform = nullif(trim(p_new_device_platform), ''),
      device_bound_at = now(),
      updated_at = now()
    where id = current_code.id;

    return jsonb_build_object(
      'success', true,
      'resultCode', 'first_activated',
      'message', '当前使用环境已激活',
      'usedCount', 0,
      'maxCount', config_max_count,
      'nextCount', 0,
      'windowDays', config_window_days,
      'minIntervalSeconds', config_min_interval_seconds,
      'allowed', true,
      'limitReason', null,
      'nextAvailableAt', null,
      'replayed', false
    );
  end if;

  -- 并发请求中，前一个请求已激活相同目标环境时直接返回，不计次数。
  if current_code.device_id = p_new_device_id then
    return jsonb_build_object(
      'success', true,
      'resultCode', 'already_active',
      'message', '当前使用环境已经激活',
      'usedCount', (
        select count(*)::integer
        from device_rebind_logs
        where access_code_id = current_code.id
          and action_source = 'user'
          and success = true
          and result_code = 'rebound'
          and created_at > now() - make_interval(days => config_window_days)
      ),
      'maxCount', config_max_count,
      'nextCount', 0,
      'windowDays', config_window_days,
      'minIntervalSeconds', config_min_interval_seconds,
      'allowed', true,
      'limitReason', null,
      'nextAvailableAt', null,
      'replayed', false
    );
  end if;

  select
    count(*)::integer,
    min(created_at),
    max(created_at)
  into
    recent_count,
    first_success_at,
    last_success_at
  from device_rebind_logs
  where access_code_id = current_code.id
    and action_source = 'user'
    and success = true
    and result_code = 'rebound'
    and created_at > now() - make_interval(days => config_window_days);

  if recent_count >= config_max_count then
    next_available_at := first_success_at + make_interval(days => config_window_days);
    response := jsonb_build_object(
      'success', false,
      'resultCode', 'window_limit_reached',
      'message', format(
        '最近%s天内重新绑定次数已达到%s次',
        config_window_days,
        config_max_count
      ),
      'usedCount', recent_count,
      'maxCount', config_max_count,
      'nextCount', recent_count,
      'windowDays', config_window_days,
      'minIntervalSeconds', config_min_interval_seconds,
      'allowed', false,
      'limitReason', 'window_limit_reached',
      'nextAvailableAt', next_available_at,
      'replayed', false
    );

    insert into device_rebind_logs (
      access_code_id, access_code, idempotency_key, action_source,
      old_device_id, old_device_name, old_device_model, old_device_platform,
      new_device_id, new_device_name, new_device_model, new_device_platform,
      ip, user_agent, window_days, max_count, min_interval_seconds,
      window_count_before, window_count_after, next_available_at,
      success, result_code, failure_reason, response_payload
    ) values (
      current_code.id, current_code.code, p_idempotency_key, 'user',
      current_code.device_id, current_code.current_device_name,
      current_code.current_device_model, current_code.current_device_platform,
      p_new_device_id, nullif(trim(p_new_device_name), ''),
      nullif(trim(p_new_device_model), ''), nullif(trim(p_new_device_platform), ''),
      p_ip, p_user_agent, config_window_days, config_max_count,
      config_min_interval_seconds, recent_count, recent_count, next_available_at,
      false, 'window_limit_reached', 'window_limit_reached', response
    );

    update access_codes
    set
      reactivation_flagged_at = coalesce(reactivation_flagged_at, now()),
      reactivation_flag_reason = '最近滚动窗口内重新激活频繁',
      updated_at = now()
    where id = current_code.id;

    return response;
  end if;

  if last_success_at is not null
    and last_success_at + make_interval(secs => config_min_interval_seconds) > now() then
    next_available_at :=
      last_success_at + make_interval(secs => config_min_interval_seconds);
    response := jsonb_build_object(
      'success', false,
      'resultCode', 'rate_limited',
      'message', '操作过于频繁，请稍后再试',
      'usedCount', recent_count,
      'maxCount', config_max_count,
      'nextCount', recent_count + 1,
      'windowDays', config_window_days,
      'minIntervalSeconds', config_min_interval_seconds,
      'allowed', false,
      'limitReason', 'rate_limited',
      'nextAvailableAt', next_available_at,
      'replayed', false
    );

    insert into device_rebind_logs (
      access_code_id, access_code, idempotency_key, action_source,
      old_device_id, old_device_name, old_device_model, old_device_platform,
      new_device_id, new_device_name, new_device_model, new_device_platform,
      ip, user_agent, window_days, max_count, min_interval_seconds,
      window_count_before, window_count_after, next_available_at,
      success, result_code, failure_reason, response_payload
    ) values (
      current_code.id, current_code.code, p_idempotency_key, 'user',
      current_code.device_id, current_code.current_device_name,
      current_code.current_device_model, current_code.current_device_platform,
      p_new_device_id, nullif(trim(p_new_device_name), ''),
      nullif(trim(p_new_device_model), ''), nullif(trim(p_new_device_platform), ''),
      p_ip, p_user_agent, config_window_days, config_max_count,
      config_min_interval_seconds, recent_count, recent_count, next_available_at,
      false, 'rate_limited', 'rate_limited', response
    );

    select count(*)::integer
    into failed_count_10m
    from device_rebind_logs
    where access_code_id = current_code.id
      and action_source = 'user'
      and success = false
      and created_at > now() - interval '10 minutes';

    if failed_count_10m >= 10 then
      update access_codes
      set
        reactivation_flagged_at = coalesce(reactivation_flagged_at, now()),
        reactivation_flag_reason = '短时间内重新激活失败请求较多',
        updated_at = now()
      where id = current_code.id;
    end if;

    return response;
  end if;

  update access_codes
  set
    device_id = p_new_device_id,
    current_device_name = nullif(trim(p_new_device_name), ''),
    current_device_model = nullif(trim(p_new_device_model), ''),
    current_device_platform = nullif(trim(p_new_device_platform), ''),
    device_bound_at = now(),
    last_rebind_at = now(),
    rebind_total = current_code.rebind_total + 1,
    updated_at = now()
  where id = current_code.id;

  -- 旧环境令牌在同一事务提交时失效，新环境重新验证后恢复当前会话。
  update sessions
  set session_token = p_new_session_token
  where access_code_id = current_code.id
    and status = 'active'
    and end_time is null;

  next_available_at := now() + make_interval(secs => config_min_interval_seconds);
  response := jsonb_build_object(
    'success', true,
    'resultCode', 'rebound',
      'message', '重新绑定成功',
    'usedCount', recent_count + 1,
    'maxCount', config_max_count,
    'nextCount', recent_count + 1,
    'windowDays', config_window_days,
    'minIntervalSeconds', config_min_interval_seconds,
    'allowed', true,
    'limitReason', null,
    'nextAvailableAt', next_available_at,
    'replayed', false
  );

  insert into device_rebind_logs (
    access_code_id, access_code, idempotency_key, action_source,
    old_device_id, old_device_name, old_device_model, old_device_platform,
    new_device_id, new_device_name, new_device_model, new_device_platform,
    ip, user_agent, window_days, max_count, min_interval_seconds,
    window_count_before, window_count_after, next_available_at,
    success, result_code, failure_reason, response_payload
  ) values (
    current_code.id, current_code.code, p_idempotency_key, 'user',
    current_code.device_id, current_code.current_device_name,
    current_code.current_device_model, current_code.current_device_platform,
    p_new_device_id, nullif(trim(p_new_device_name), ''),
    nullif(trim(p_new_device_model), ''), nullif(trim(p_new_device_platform), ''),
    p_ip, p_user_agent, config_window_days, config_max_count,
    config_min_interval_seconds, recent_count, recent_count + 1, next_available_at,
    true, 'rebound', null, response
  );

  insert into suspicious_logs (
    access_code_id, ip, user_agent, event_type, message
  ) values (
    current_code.id, p_ip, p_user_agent, '使用环境重新激活',
    jsonb_build_object(
      'success', true,
      'oldEnvironment', current_code.device_id,
      'newEnvironment', p_new_device_id,
      'windowCount', recent_count + 1,
      'windowDays', config_window_days
    )::text
  );

  select count(*)::integer
  into success_count_24h
  from device_rebind_logs
  where access_code_id = current_code.id
    and action_source = 'user'
    and success = true
    and result_code = 'rebound'
    and created_at > now() - interval '24 hours';

  select count(distinct user_agent)::integer
  into distinct_user_agents_24h
  from device_rebind_logs
  where access_code_id = current_code.id
    and action_source = 'user'
    and user_agent is not null
    and created_at > now() - interval '24 hours';

  if recent_count + 1 >= config_max_count
    or success_count_24h >= 5
    or distinct_user_agents_24h >= 5 then
    update access_codes
    set
      reactivation_flagged_at = coalesce(reactivation_flagged_at, now()),
      reactivation_flag_reason = case
        when recent_count + 1 >= config_max_count
          then '最近滚动窗口内已用完重新激活次数'
        when success_count_24h >= 5
          then '24小时内重新激活达到5次'
        else '24小时内出现大量不同浏览器标识'
      end,
      updated_at = now()
    where id = current_code.id;
  end if;

  return response;
end;
$$;

revoke all on function get_device_rebind_status(uuid)
  from public, anon, authenticated;
grant execute on function get_device_rebind_status(uuid) to service_role;

revoke all on function perform_device_rebind(
  text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function perform_device_rebind(
  text, text, text, text, text, text, text, text, text
) to service_role;

create or replace function admin_reset_device_environment(
  p_access_code_id uuid,
  p_reason text,
  p_admin text,
  p_request_id text,
  p_new_session_token text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_code access_codes%rowtype;
  updated_code access_codes%rowtype;
  config_window_days integer := 15;
  config_max_count integer := 10;
  config_min_interval_seconds integer := 60;
  recent_count integer := 0;
begin
  if p_access_code_id is null
    or coalesce(trim(p_reason), '') = ''
    or coalesce(trim(p_request_id), '') = ''
    or coalesce(trim(p_new_session_token), '') = '' then
    return jsonb_build_object(
      'success', false,
      'resultCode', 'invalid_request',
      'message', '管理员重置必须填写原因'
    );
  end if;

  select *
  into current_code
  from access_codes
  where id = p_access_code_id
  for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'resultCode', 'access_code_not_found',
      'message', '访问码不存在'
    );
  end if;

  select
    rebind_window_days,
    rebind_max_count,
    rebind_min_interval_seconds
  into
    config_window_days,
    config_max_count,
    config_min_interval_seconds
  from device_rebind_configs
  where id = true;

  if not found then
    config_window_days := 15;
    config_max_count := 10;
    config_min_interval_seconds := 60;
  end if;

  select count(*)::integer
  into recent_count
  from device_rebind_logs
  where access_code_id = current_code.id
    and action_source = 'user'
    and success = true
    and result_code = 'rebound'
    and created_at > now() - make_interval(days => config_window_days);

  update access_codes
  set
    device_id = null,
    current_device_name = null,
    current_device_model = null,
    current_device_platform = null,
    device_bound_at = null,
    updated_at = now()
  where id = current_code.id
  returning * into updated_code;

  update sessions
  set session_token = p_new_session_token
  where access_code_id = current_code.id
    and status = 'active'
    and end_time is null;

  insert into device_rebind_logs (
    access_code_id, access_code, idempotency_key, action_source,
    old_device_id, old_device_name, old_device_model, old_device_platform,
    new_device_id, new_device_name, new_device_model, new_device_platform,
    ip, user_agent, window_days, max_count, min_interval_seconds,
    window_count_before, window_count_after, next_available_at,
    success, result_code, failure_reason, response_payload
  ) values (
    current_code.id, current_code.code, p_request_id, 'admin',
    current_code.device_id, current_code.current_device_name,
    current_code.current_device_model, current_code.current_device_platform,
    null, null, null, null,
    null, null, config_window_days, config_max_count,
    config_min_interval_seconds, recent_count, recent_count, null,
    true, 'admin_reset', null,
    jsonb_build_object(
      'success', true,
      'resultCode', 'admin_reset',
      'message', '当前激活环境已由管理员重置',
      'usedCount', recent_count,
      'maxCount', config_max_count
    )
  );

  insert into admin_actions (
    admin,
    access_code_id,
    action_type,
    before_data,
    after_data,
    reason
  ) values (
    coalesce(nullif(trim(p_admin), ''), 'unknown'),
    current_code.id,
    'reset_device_environment',
    to_jsonb(current_code),
    to_jsonb(updated_code),
    trim(p_reason)
  );

  return jsonb_build_object(
    'success', true,
    'resultCode', 'admin_reset',
    'message', '当前激活环境已重置',
    'accessCode', to_jsonb(updated_code),
    'usedCount', recent_count,
    'maxCount', config_max_count
  );
end;
$$;

revoke all on function admin_reset_device_environment(
  uuid, text, text, text, text
) from public, anon, authenticated;

grant execute on function admin_reset_device_environment(
  uuid, text, text, text, text
) to service_role;

create index if not exists idx_access_codes_code on access_codes(code);
create index if not exists idx_sessions_access_code_id on sessions(access_code_id);
create unique index if not exists idx_sessions_report_token on sessions(report_token);
create index if not exists idx_records_session_id on records(session_id);
create index if not exists idx_error_logs_created_at on error_logs(created_at);
create index if not exists idx_ai_call_logs_created_at on ai_call_logs(created_at);
create unique index if not exists idx_ai_model_configs_one_active_provider
  on ai_model_configs(provider)
  where is_active = true;
create index if not exists idx_suspicious_logs_created_at on suspicious_logs(created_at);
create index if not exists idx_admin_actions_access_code_id on admin_actions(access_code_id);
create index if not exists idx_admin_actions_created_at on admin_actions(created_at);
create index if not exists idx_device_rebind_logs_access_code_id
  on device_rebind_logs(access_code_id);
create index if not exists idx_device_rebind_logs_created_at
  on device_rebind_logs(created_at desc);
create index if not exists idx_device_rebind_logs_window_count
  on device_rebind_logs(access_code_id, created_at desc)
  where success = true
    and action_source = 'user'
    and result_code = 'rebound';

alter table plan_configs enable row level security;
alter table access_codes enable row level security;
alter table sessions enable row level security;
alter table records enable row level security;
alter table error_logs enable row level security;
alter table ai_call_logs enable row level security;
alter table ai_model_configs enable row level security;
alter table suspicious_logs enable row level security;
alter table admin_actions enable row level security;
alter table device_rebind_configs enable row level security;
alter table device_rebind_logs enable row level security;

-- 本项目所有数据库写入都通过 Next.js API Routes 的 service role key 完成。
-- 不创建 anon 访问策略，避免浏览器端直接读写业务数据。
