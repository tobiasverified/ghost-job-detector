-- Review this file, then run it in the Supabase SQL editor.
-- It is rerunnable. It does not drop ghd_log_check(jsonb): that signature
-- is replaced in place, so the previous call shape still works.
-- Nothing here is applied by the app deploy.

create table if not exists public.ghd_daily_usage (
  day date not null,
  provider text not null,
  calls integer not null default 0,
  primary key (day, provider)
);

alter table public.ghd_daily_usage enable row level security;

revoke all on table public.ghd_daily_usage from public, anon, authenticated;
grant select, insert, update, delete on table public.ghd_daily_usage to service_role;

-- One increment for today (UTC). False when the row is already at the limit,
-- and that call does not add another count.
create or replace function public.ghd_consume_paid_call(p_provider text, p_limit integer)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_provider is null or btrim(p_provider) = '' or char_length(btrim(p_provider)) > 40
     or p_limit is null or p_limit < 1 then
    return false;
  end if;

  insert into public.ghd_daily_usage as usage (day, provider, calls)
  values ((timezone('utc', now()))::date, btrim(p_provider), 1)
  on conflict (day, provider)
  do update set calls = usage.calls + 1
  where usage.calls < p_limit;

  return found;
end;
$$;

revoke all on function public.ghd_consume_paid_call(text, integer) from public;
revoke all on function public.ghd_consume_paid_call(text, integer) from anon, authenticated;
grant execute on function public.ghd_consume_paid_call(text, integer) to service_role;

alter table public.ghd_checks add column if not exists tavily_calls integer not null default 0;
alter table public.ghd_checks add column if not exists groq_calls integer not null default 0;
alter table public.ghd_checks add column if not exists rapidapi_calls integer not null default 0;
alter table public.ghd_checks add column if not exists newsdata_calls integer not null default 0;
alter table public.ghd_checks add column if not exists rate_limited boolean not null default false;

-- Same argument list as the function from 2026-10-06-request-log.sql.
-- create or replace keeps one function, so there is no ambiguous overload
-- and the old signature is not dropped.
create or replace function public.ghd_log_check(p_row jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.ghd_checks (
    company, platform, job_id, status, cached, partial, score_withheld,
    timed_out, ghost_score, employees, employee_source, open_roles,
    open_roles_source, open_roles_lower_bound, total_ms, deployment_id,
    tavily_calls, groq_calls, rapidapi_calls, newsdata_calls, rate_limited
  ) values (
    coalesce(p_row->>'company', ''),
    coalesce(p_row->>'platform', ''),
    coalesce(p_row->>'job_id', ''),
    coalesce((p_row->>'status')::integer, 0),
    coalesce((p_row->>'cached')::boolean, false),
    coalesce((p_row->>'partial')::boolean, false),
    coalesce((p_row->>'score_withheld')::boolean, false),
    coalesce(
      (select array_agg(item) from jsonb_array_elements_text(coalesce(p_row->'timed_out', '[]'::jsonb)) as item),
      '{}'::text[]
    ),
    (p_row->>'ghost_score')::integer,
    (p_row->>'employees')::integer,
    nullif(p_row->>'employee_source', ''),
    (p_row->>'open_roles')::integer,
    nullif(p_row->>'open_roles_source', ''),
    coalesce((p_row->>'open_roles_lower_bound')::boolean, false),
    (p_row->>'total_ms')::integer,
    nullif(p_row->>'deployment_id', ''),
    coalesce((p_row->>'tavily_calls')::integer, 0),
    coalesce((p_row->>'groq_calls')::integer, 0),
    coalesce((p_row->>'rapidapi_calls')::integer, 0),
    coalesce((p_row->>'newsdata_calls')::integer, 0),
    coalesce((p_row->>'rate_limited')::boolean, false)
  );

  delete from public.ghd_checks
  where created_at < now() - interval '30 days';
end;
$$;

revoke all on function public.ghd_log_check(jsonb) from public;
revoke all on function public.ghd_log_check(jsonb) from anon, authenticated;
grant execute on function public.ghd_log_check(jsonb) to service_role;
grant select, insert, delete on table public.ghd_checks to service_role;
grant usage, select on sequence public.ghd_checks_id_seq to service_role;

create or replace function public.ghd_cleanup()
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  rate_limits_deleted bigint;
  cache_deleted bigint;
  checks_deleted bigint;
  usage_deleted bigint;
begin
  delete from public.ghd_rate_limits
  where window_start < now() - interval '2 hours';
  get diagnostics rate_limits_deleted = row_count;

  delete from public.ghd_cache
  where expires_at < now();
  get diagnostics cache_deleted = row_count;

  delete from public.ghd_checks
  where created_at < now() - interval '30 days';
  get diagnostics checks_deleted = row_count;

  delete from public.ghd_daily_usage
  where day < ((timezone('utc', now()))::date - 35);
  get diagnostics usage_deleted = row_count;

  return jsonb_build_object(
    'ghd_rate_limits', rate_limits_deleted,
    'ghd_cache', cache_deleted,
    'ghd_checks', checks_deleted,
    'ghd_daily_usage', usage_deleted
  );
end;
$$;

revoke all on function public.ghd_cleanup() from public;
revoke all on function public.ghd_cleanup() from anon, authenticated;
grant execute on function public.ghd_cleanup() to service_role;

grant select, insert, update, delete on table public.ghd_rate_limits to service_role;
grant select, insert, update, delete on table public.ghd_cache to service_role;
grant select, insert, delete on table public.ghd_checks to service_role;

-- Hourly buckets stored the raw address in bucket_key. They expire within
-- two hours; this removes the ones already written.
delete from public.ghd_rate_limits;

-- Refresh counters stored the raw address in the cache key.
delete from public.ghd_cache where cache_key like 'refresh_ip_v1_%';

notify pgrst, 'reload schema';
