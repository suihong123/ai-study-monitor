-- 在生产执行 migration_2026_18_device_rebind_mvp.sql 后运行。
-- 本文件只读，用于确认结构、默认值和已有访问码兼容情况。

select
  count(*) as access_code_count,
  count(*) filter (where free_rebind_count is null or free_rebind_count < 0)
    as invalid_free_rebind_count,
  count(*) filter (where rebind_total is null or rebind_total < 0)
    as invalid_rebind_total
from access_codes;

select
  rebind_cost_minutes,
  rebind_cooldown_hours,
  updated_at
from device_rebind_configs
where id = true;

select
  to_regclass('public.device_rebind_logs') is not null
    as device_rebind_logs_exists,
  to_regprocedure(
    'public.perform_device_rebind(text,text,text,text,text,text,text,text,text)'
  ) is not null as perform_device_rebind_exists;

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'access_codes'
  and column_name in (
    'free_rebind_count',
    'last_rebind_at',
    'rebind_total',
    'current_device_name',
    'current_device_model',
    'current_device_platform',
    'device_bound_at'
  )
order by column_name;
