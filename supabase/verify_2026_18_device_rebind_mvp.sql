-- 在生产执行 migration_2026_18_device_rebind_mvp.sql 后运行。
-- 全部为只读查询，用于确认结构、默认值和现有访问码兼容情况。

select
  count(*) as access_code_count,
  count(*) filter (where rebind_total is null or rebind_total < 0)
    as invalid_rebind_total,
  count(*) filter (
    where total_minutes < 0
      or used_minutes < 0
      or used_minutes > total_minutes
  ) as invalid_minute_balance
from access_codes;

select
  rebind_window_days,
  rebind_max_count,
  rebind_min_interval_seconds,
  updated_at
from device_rebind_configs
where id = true;

select
  to_regclass('public.device_rebind_logs') is not null
    as device_rebind_logs_exists,
  to_regprocedure(
    'public.get_device_rebind_status(uuid)'
  ) is not null as get_device_rebind_status_exists,
  to_regprocedure(
    'public.perform_device_rebind(text,text,text,text,text,text,text,text,text)'
  ) is not null as perform_device_rebind_exists,
  to_regprocedure(
    'public.admin_reset_device_environment(uuid,text,text,text,text)'
  ) is not null as admin_reset_device_environment_exists;

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'access_codes'
  and column_name in (
    'last_rebind_at',
    'rebind_total',
    'current_device_name',
    'current_device_model',
    'current_device_platform',
    'device_bound_at',
    'reactivation_flagged_at',
    'reactivation_flag_reason'
  )
order by column_name;

select
  count(*) filter (
    where column_name in ('free_rebind_count', 'rebind_cost_minutes')
  ) = 0 as retired_fields_absent,
  count(*) filter (
    where column_name in (
      'last_rebind_at',
      'rebind_total',
      'current_device_name',
      'current_device_model',
      'current_device_platform',
      'device_bound_at',
      'reactivation_flagged_at',
      'reactivation_flag_reason'
    )
  ) = 8 as required_access_code_fields_present
from information_schema.columns
where table_schema = 'public'
  and table_name = 'access_codes';

select
  count(*) filter (
    where column_name in (
      'old_device_id',
      'new_device_id',
      'old_device_name',
      'new_device_name',
      'old_device_model',
      'new_device_model',
      'old_device_platform',
      'new_device_platform',
      'ip',
      'user_agent',
      'idempotency_key',
      'action_source',
      'window_count_before',
      'window_count_after',
      'next_available_at',
      'success',
      'result_code',
      'failure_reason',
      'response_payload',
      'created_at'
    )
  ) = 20 as required_log_fields_present
from information_schema.columns
where table_schema = 'public'
  and table_name = 'device_rebind_logs';

select
  count(*) as reactivation_log_count,
  count(*) filter (
    where success = true
      and action_source = 'user'
      and result_code = 'rebound'
  ) as counted_user_reactivations,
  count(*) filter (
    where success = true
      and action_source = 'admin'
  ) as admin_resets
from device_rebind_logs;

select
  (select count(*) from sessions) as session_count,
  (select count(*) from records) as record_count,
  (
    select count(*)
    from ai_call_logs
    where model_type like 'report_%'
      and status = 'success'
  ) as report_count,
  count(*) filter (where device_id is not null) as activated_access_code_count,
  count(*) filter (where device_bound_at is not null) as known_activation_time_count
from access_codes;

select
  code,
  plan_type,
  total_minutes,
  used_minutes,
  greatest(total_minutes - used_minutes, 0) as remaining_minutes,
  rebind_total,
  device_id,
  device_bound_at
from access_codes
order by created_at;
