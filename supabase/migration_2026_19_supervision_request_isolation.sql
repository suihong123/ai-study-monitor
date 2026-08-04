-- v0.9: only persist an analysis result while the originating session token
-- is still current. This prevents a slow response from an old environment
-- from writing records after a successful environment rebind.

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
