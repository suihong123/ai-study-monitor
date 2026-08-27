-- 只读快照：迁移前后必须返回完全相同的 JSON。
-- 报告数量按当前系统的 report_* AI 调用成功日志统计，因为没有独立 reports 表。
select jsonb_agg(to_jsonb(snapshot_row) order by snapshot_row.code) as snapshot
from (
  select
    access_code.code,
    access_code.plan_type,
    access_code.total_minutes,
    access_code.used_minutes,
    greatest(access_code.total_minutes - access_code.used_minutes, 0)
      as remaining_minutes,
    access_code.status,
    access_code.device_id,
    (
      select count(*)::integer
      from sessions
      where sessions.access_code_id = access_code.id
        and sessions.status = 'active'
        and sessions.end_time is null
    ) as active_session_count,
    (
      select count(*)::integer
      from sessions
      where sessions.access_code_id = access_code.id
    ) as historical_session_count,
    (
      select count(*)::integer
      from records
      join sessions on sessions.id = records.session_id
      where sessions.access_code_id = access_code.id
    ) as record_count,
    (
      select count(*)::integer
      from ai_call_logs
      where ai_call_logs.access_code_id = access_code.id
        and ai_call_logs.model_type like 'report_%'
        and ai_call_logs.status = 'success'
    ) as report_count
  from access_codes as access_code
) as snapshot_row;
