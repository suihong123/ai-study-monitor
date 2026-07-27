-- 第一轮产品地基：
-- 1. 所有访问码永久有效，只按总时长控制。
-- 2. 所有套餐暂时统一为真实基础报告。
-- 3. 会话记录隐私说明确认版本。
-- 4. 使用数据库函数原子、幂等地结束会话并扣减总额度。

update plan_configs
set report_level = 'basic'
where plan_type in ('trial', 'basic_monthly', 'standard_monthly', 'pro_monthly');

update access_codes
set
  expires_at = null,
  report_level = 'basic',
  daily_minutes = total_minutes,
  used_minutes_today = least(used_minutes, total_minutes),
  last_reset_date = null;

alter table sessions
  add column if not exists privacy_notice_version text;

alter table sessions
  add column if not exists privacy_acknowledged_at timestamptz;

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
