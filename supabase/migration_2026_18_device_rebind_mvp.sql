-- v0.9：浏览器使用环境重新激活 MVP
-- 生产仍为 v0.8，本迁移尚未执行；上线顺序必须是 Migration → Deploy → 真机验收。
-- 重新激活不修改套餐、总监督时长、已用时长、会话时长或报告数据。

alter table access_codes
  add column if not exists last_rebind_at timestamptz;

alter table access_codes
  add column if not exists rebind_total integer not null default 0;

alter table access_codes
  add column if not exists current_device_name text;

alter table access_codes
  add column if not exists current_device_model text;

alter table access_codes
  add column if not exists current_device_platform text;

alter table access_codes
  add column if not exists device_bound_at timestamptz;

alter table access_codes
  add column if not exists reactivation_flagged_at timestamptz;

alter table access_codes
  add column if not exists reactivation_flag_reason text;

update access_codes
set rebind_total = greatest(coalesce(rebind_total, 0), 0);

alter table access_codes
  drop constraint if exists access_codes_rebind_total_check;

alter table access_codes
  add constraint access_codes_rebind_total_check
  check (rebind_total >= 0);

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

create index if not exists idx_device_rebind_logs_access_code_id
  on device_rebind_logs(access_code_id);

create index if not exists idx_device_rebind_logs_created_at
  on device_rebind_logs(created_at desc);

create index if not exists idx_device_rebind_logs_window_count
  on device_rebind_logs(access_code_id, created_at desc)
  where success = true
    and action_source = 'user'
    and result_code = 'rebound';

alter table device_rebind_configs enable row level security;
alter table device_rebind_logs enable row level security;

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
