-- Read-only verification for migration 19.

select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'persist_analysis_result_if_session_current';

select
  has_function_privilege(
    'service_role',
    'public.persist_analysis_result_if_session_current(uuid, uuid, text, text, text, text, timestamptz, numeric, text, text, integer, boolean, boolean, text, integer, integer, numeric, integer, text)',
    'EXECUTE'
  ) as service_role_can_execute,
  has_function_privilege(
    'anon',
    'public.persist_analysis_result_if_session_current(uuid, uuid, text, text, text, text, timestamptz, numeric, text, text, integer, boolean, boolean, text, integer, integer, numeric, integer, text)',
    'EXECUTE'
  ) as anon_can_execute,
  has_function_privilege(
    'authenticated',
    'public.persist_analysis_result_if_session_current(uuid, uuid, text, text, text, text, timestamptz, numeric, text, text, integer, boolean, boolean, text, integer, integer, numeric, integer, text)',
    'EXECUTE'
  ) as authenticated_can_execute;
