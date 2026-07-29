-- 第二轮：访问码自助换绑 MVP
-- 上线顺序必须是：先执行本迁移，再部署应用。
-- 新增字段均兼容已有访问码；已有访问码统一获得 3 次免费换绑。

alter table access_codes
  add column if not exists free_rebind_count integer not null default 3;

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

update access_codes
set
  free_rebind_count = greatest(coalesce(free_rebind_count, 3), 0),
  rebind_total = greatest(coalesce(rebind_total, 0), 0);

alter table access_codes
  drop constraint if exists access_codes_free_rebind_count_check;

alter table access_codes
  add constraint access_codes_free_rebind_count_check
  check (free_rebind_count >= 0);

alter table access_codes
  drop constraint if exists access_codes_rebind_total_check;

alter table access_codes
  add constraint access_codes_rebind_total_check
  check (rebind_total >= 0);

create table if not exists device_rebind_configs (
  id boolean primary key default true check (id),
  rebind_cost_minutes integer not null default 30 check (rebind_cost_minutes > 0),
  rebind_cooldown_hours integer not null default 24 check (rebind_cooldown_hours >= 0),
  updated_at timestamptz not null default now()
);

insert into device_rebind_configs (
  id,
  rebind_cost_minutes,
  rebind_cooldown_hours,
  updated_at
) values (
  true,
  30,
  24,
  now()
)
on conflict (id) do nothing;

create table if not exists device_rebind_logs (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid references access_codes(id) on delete set null,
  access_code text not null,
  idempotency_key text not null,
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
  is_free boolean not null default false,
  deducted_minutes integer not null default 0,
  remaining_minutes integer not null default 0,
  free_rebind_count integer not null default 0,
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

alter table device_rebind_configs enable row level security;
alter table device_rebind_logs enable row level security;

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
  config_cost_minutes integer := 30;
  config_cooldown_hours integer := 24;
  current_remaining integer := 0;
  next_free_rebind_count integer := 0;
  deducted_minutes integer := 0;
  is_free_rebind boolean := false;
  cooldown_remaining_seconds integer := 0;
  next_rebind_at timestamptz;
  response jsonb;
begin
  if coalesce(trim(p_access_code), '') = ''
    or coalesce(trim(p_new_device_id), '') = ''
    or coalesce(trim(p_idempotency_key), '') = '' then
    return jsonb_build_object(
      'success', false,
      'resultCode', 'invalid_request',
      'message', '换绑请求信息不完整',
      'freeRebindCount', 0,
      'remainingMinutes', 0,
      'cooldownRemainingSeconds', 0,
      'costMinutes', 30,
      'deductedMinutes', 0,
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
      'freeRebindCount', 0,
      'remainingMinutes', 0,
      'cooldownRemainingSeconds', 0,
      'costMinutes', 30,
      'deductedMinutes', 0,
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
    rebind_cost_minutes,
    rebind_cooldown_hours
  into
    config_cost_minutes,
    config_cooldown_hours
  from device_rebind_configs
  where id = true;

  if not found then
    config_cost_minutes := 30;
    config_cooldown_hours := 24;
  end if;

  config_cost_minutes := greatest(coalesce(config_cost_minutes, 30), 1);
  config_cooldown_hours := greatest(coalesce(config_cooldown_hours, 24), 0);
  current_remaining := greatest(0, current_code.total_minutes - current_code.used_minutes);

  if current_code.status not in ('active', 'watch') then
    response := jsonb_build_object(
      'success', false,
      'resultCode', 'access_code_unavailable',
      'message', '访问码当前不可用',
      'freeRebindCount', current_code.free_rebind_count,
      'remainingMinutes', current_remaining,
      'cooldownRemainingSeconds', 0,
      'costMinutes', config_cost_minutes,
      'deductedMinutes', 0,
      'replayed', false
    );

    insert into device_rebind_logs (
      access_code_id, access_code, idempotency_key,
      old_device_id, old_device_name, old_device_model, old_device_platform,
      new_device_id, new_device_name, new_device_model, new_device_platform,
      ip, user_agent, is_free, deducted_minutes, remaining_minutes,
      free_rebind_count, success, result_code, failure_reason, response_payload
    ) values (
      current_code.id, current_code.code, p_idempotency_key,
      current_code.device_id, current_code.current_device_name,
      current_code.current_device_model, current_code.current_device_platform,
      p_new_device_id, p_new_device_name, p_new_device_model, p_new_device_platform,
      p_ip, p_user_agent, false, 0, current_remaining,
      current_code.free_rebind_count, false, 'access_code_unavailable',
      current_code.status, response
    );

    insert into suspicious_logs (
      access_code_id, ip, user_agent, event_type, message
    ) values (
      current_code.id, p_ip, p_user_agent, 'DEVICE_REBOUND',
      jsonb_build_object(
        'success', false,
        'reason', 'access_code_unavailable',
        'oldDevice', current_code.device_id,
        'newDevice', p_new_device_id,
        'freeRebindCount', current_code.free_rebind_count,
        'deductedMinutes', 0,
        'remainingMinutes', current_remaining
      )::text
    );

    return response;
  end if;

  -- 兜底处理直接调用换绑接口的首次绑定；不消耗免费次数。
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
      'resultCode', 'first_bound',
      'message', '设备已绑定',
      'freeRebindCount', current_code.free_rebind_count,
      'remainingMinutes', current_remaining,
      'cooldownRemainingSeconds', 0,
      'costMinutes', config_cost_minutes,
      'deductedMinutes', 0,
      'isFree', true,
      'replayed', false
    );
  end if;

  -- 并发请求中，前一个请求已把同一目标设备绑定成功时直接返回，不重复扣减。
  if current_code.device_id = p_new_device_id then
    return jsonb_build_object(
      'success', true,
      'resultCode', 'already_bound',
      'message', '当前设备已经绑定',
      'freeRebindCount', current_code.free_rebind_count,
      'remainingMinutes', current_remaining,
      'cooldownRemainingSeconds', 0,
      'costMinutes', config_cost_minutes,
      'deductedMinutes', 0,
      'isFree', true,
      'replayed', false
    );
  end if;

  if current_code.last_rebind_at is not null
    and current_code.last_rebind_at + make_interval(hours => config_cooldown_hours) > now() then
    next_rebind_at :=
      current_code.last_rebind_at + make_interval(hours => config_cooldown_hours);
    cooldown_remaining_seconds := greatest(
      1,
      ceil(extract(epoch from (next_rebind_at - now())))::integer
    );

    response := jsonb_build_object(
      'success', false,
      'resultCode', 'cooldown_active',
      'message', '为了保障访问码安全，请在冷却结束后再次尝试',
      'freeRebindCount', current_code.free_rebind_count,
      'remainingMinutes', current_remaining,
      'cooldownRemainingSeconds', cooldown_remaining_seconds,
      'nextRebindAt', next_rebind_at,
      'costMinutes', config_cost_minutes,
      'deductedMinutes', 0,
      'replayed', false
    );

    insert into device_rebind_logs (
      access_code_id, access_code, idempotency_key,
      old_device_id, old_device_name, old_device_model, old_device_platform,
      new_device_id, new_device_name, new_device_model, new_device_platform,
      ip, user_agent, is_free, deducted_minutes, remaining_minutes,
      free_rebind_count, success, result_code, failure_reason, response_payload
    ) values (
      current_code.id, current_code.code, p_idempotency_key,
      current_code.device_id, current_code.current_device_name,
      current_code.current_device_model, current_code.current_device_platform,
      p_new_device_id, p_new_device_name, p_new_device_model, p_new_device_platform,
      p_ip, p_user_agent, current_code.free_rebind_count > 0, 0, current_remaining,
      current_code.free_rebind_count, false, 'cooldown_active',
      'cooldown_active', response
    );

    insert into suspicious_logs (
      access_code_id, ip, user_agent, event_type, message
    ) values (
      current_code.id, p_ip, p_user_agent, 'DEVICE_REBOUND',
      jsonb_build_object(
        'success', false,
        'reason', 'cooldown_active',
        'oldDevice', current_code.device_id,
        'newDevice', p_new_device_id,
        'freeRebindCount', current_code.free_rebind_count,
        'deductedMinutes', 0,
        'remainingMinutes', current_remaining,
        'cooldownRemainingSeconds', cooldown_remaining_seconds
      )::text
    );

    return response;
  end if;

  is_free_rebind := current_code.free_rebind_count > 0;

  if not is_free_rebind and current_remaining < config_cost_minutes then
    response := jsonb_build_object(
      'success', false,
      'resultCode', 'insufficient_minutes',
      'message', format(
        '剩余监督时长不足%s分钟，无法完成设备更换',
        config_cost_minutes
      ),
      'freeRebindCount', current_code.free_rebind_count,
      'remainingMinutes', current_remaining,
      'cooldownRemainingSeconds', 0,
      'costMinutes', config_cost_minutes,
      'deductedMinutes', 0,
      'replayed', false
    );

    insert into device_rebind_logs (
      access_code_id, access_code, idempotency_key,
      old_device_id, old_device_name, old_device_model, old_device_platform,
      new_device_id, new_device_name, new_device_model, new_device_platform,
      ip, user_agent, is_free, deducted_minutes, remaining_minutes,
      free_rebind_count, success, result_code, failure_reason, response_payload
    ) values (
      current_code.id, current_code.code, p_idempotency_key,
      current_code.device_id, current_code.current_device_name,
      current_code.current_device_model, current_code.current_device_platform,
      p_new_device_id, p_new_device_name, p_new_device_model, p_new_device_platform,
      p_ip, p_user_agent, false, 0, current_remaining,
      current_code.free_rebind_count, false, 'insufficient_minutes',
      'insufficient_minutes', response
    );

    insert into suspicious_logs (
      access_code_id, ip, user_agent, event_type, message
    ) values (
      current_code.id, p_ip, p_user_agent, 'DEVICE_REBOUND',
      jsonb_build_object(
        'success', false,
        'reason', 'insufficient_minutes',
        'oldDevice', current_code.device_id,
        'newDevice', p_new_device_id,
        'freeRebindCount', current_code.free_rebind_count,
        'deductedMinutes', 0,
        'remainingMinutes', current_remaining
      )::text
    );

    return response;
  end if;

  deducted_minutes := case when is_free_rebind then 0 else config_cost_minutes end;
  next_free_rebind_count := case
    when is_free_rebind then current_code.free_rebind_count - 1
    else current_code.free_rebind_count
  end;
  current_remaining := current_remaining - deducted_minutes;
  next_rebind_at := now() + make_interval(hours => config_cooldown_hours);

  update access_codes
  set
    device_id = p_new_device_id,
    current_device_name = nullif(trim(p_new_device_name), ''),
    current_device_model = nullif(trim(p_new_device_model), ''),
    current_device_platform = nullif(trim(p_new_device_platform), ''),
    device_bound_at = now(),
    free_rebind_count = next_free_rebind_count,
    last_rebind_at = now(),
    rebind_total = current_code.rebind_total + 1,
    used_minutes = least(
      current_code.total_minutes,
      current_code.used_minutes + deducted_minutes
    ),
    used_minutes_today = least(
      current_code.total_minutes,
      current_code.used_minutes + deducted_minutes
    ),
    updated_at = now()
  where id = current_code.id;

  -- 换绑后让旧设备持有的会话令牌立即失效；新设备重新验证后可恢复会话。
  update sessions
  set session_token = p_new_session_token
  where access_code_id = current_code.id
    and status = 'active'
    and end_time is null;

  response := jsonb_build_object(
    'success', true,
    'resultCode', 'rebound',
    'message', '设备更换成功',
    'freeRebindCount', next_free_rebind_count,
    'remainingMinutes', current_remaining,
    'cooldownRemainingSeconds', config_cooldown_hours * 3600,
    'nextRebindAt', next_rebind_at,
    'costMinutes', config_cost_minutes,
    'deductedMinutes', deducted_minutes,
    'isFree', is_free_rebind,
    'replayed', false
  );

  insert into device_rebind_logs (
    access_code_id, access_code, idempotency_key,
    old_device_id, old_device_name, old_device_model, old_device_platform,
    new_device_id, new_device_name, new_device_model, new_device_platform,
    ip, user_agent, is_free, deducted_minutes, remaining_minutes,
    free_rebind_count, success, result_code, failure_reason, response_payload
  ) values (
    current_code.id, current_code.code, p_idempotency_key,
    current_code.device_id, current_code.current_device_name,
    current_code.current_device_model, current_code.current_device_platform,
    p_new_device_id, p_new_device_name, p_new_device_model, p_new_device_platform,
    p_ip, p_user_agent, is_free_rebind, deducted_minutes, current_remaining,
    next_free_rebind_count, true, 'rebound', null, response
  );

  insert into suspicious_logs (
    access_code_id, ip, user_agent, event_type, message
  ) values (
    current_code.id, p_ip, p_user_agent, 'DEVICE_REBOUND',
    jsonb_build_object(
      'success', true,
      'oldDevice', current_code.device_id,
      'newDevice', p_new_device_id,
      'isFree', is_free_rebind,
      'freeRebindCount', next_free_rebind_count,
      'deductedMinutes', deducted_minutes,
      'remainingMinutes', current_remaining
    )::text
  );

  return response;
end;
$$;

revoke all on function perform_device_rebind(
  text, text, text, text, text, text, text, text, text
) from public;

grant execute on function perform_device_rebind(
  text, text, text, text, text, text, text, text, text
) to service_role;
