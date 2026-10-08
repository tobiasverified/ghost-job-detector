-- After applying, run these in the Supabase SQL editor. The test suite
-- mocks ghd_consume_paid_call and does not execute this file.
--   select ghd_consume_paid_call('test', 5);  -- true
--   select ghd_consume_paid_call('test', 5, 'k1', 2);  -- true, then true, then false
--   insert into ghd_revoked_keys (key_id) values ('k1');  -- the call above then returns false
--   delete from ghd_daily_usage where provider = 'test';
--   delete from ghd_key_usage where key_id = 'k1';
--   delete from ghd_revoked_keys where key_id = 'k1';

-- Review this file, then run it in the Supabase SQL editor.
-- It is rerunnable. It is not applied by an app deploy.
-- Run it after the earlier ghd_checks, ghd_daily_usage, and ghd_cleanup files.
-- The statements are one transaction, so a failure does not leave the old
-- paid-call function dropped.

begin;
-- ghd_consume_paid_call(text, integer) is dropped and replaced by one
-- function with two extra arguments that default to null, so the old
-- call shape still works and PostgREST does not see two overloads.
-- ghd_log_check(jsonb) is replaced in place. The old call shape still works.

create table if not exists public.ghd_revoked_keys (
  key_id text primary key,
  revoked_at timestamptz not null default now()
);

alter table public.ghd_revoked_keys enable row level security;

revoke all on table public.ghd_revoked_keys from public, anon, authenticated;
grant select, insert, update, delete on table public.ghd_revoked_keys to service_role;

create table if not exists public.ghd_key_usage (
  day date not null,
  key_id text not null,
  calls integer not null default 0,
  primary key (day, key_id)
);

alter table public.ghd_key_usage enable row level security;

revoke all on table public.ghd_key_usage from public, anon, authenticated;
grant select, insert, update, delete on table public.ghd_key_usage to service_role;

alter table public.ghd_checks add column if not exists key_id text;

drop function if exists public.ghd_consume_paid_call(text, integer);

-- One round trip. False, and no counter moves, when the key is revoked or
-- either the global provider limit or the key limit is already reached.
-- Both counters move in this transaction, and neither can pass its limit.
create or replace function public.ghd_consume_paid_call(
  p_provider text,
  p_limit integer,
  p_key_id text default null,
  p_key_limit integer default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_today date := (timezone('utc', now()))::date;
  v_provider text := btrim(coalesce(p_provider, ''));
  v_key_id text := nullif(btrim(coalesce(p_key_id, '')), '');
  v_global_calls integer;
  v_key_calls integer;
begin
  if v_provider = '' or char_length(v_provider) > 40 or p_limit is null or p_limit < 1 then
    return false;
  end if;

  if v_key_id is not null and (
    char_length(v_key_id) > 80 or p_key_limit is null or p_key_limit < 1
  ) then
    return false;
  end if;

  if v_key_id is not null and exists (
    select 1 from public.ghd_revoked_keys as r where r.key_id = v_key_id
  ) then
    return false;
  end if;

  insert into public.ghd_daily_usage as u (day, provider, calls)
  values (v_today, v_provider, 0)
  on conflict (day, provider) do nothing;

  select u.calls into v_global_calls
  from public.ghd_daily_usage as u
  where u.day = v_today and u.provider = v_provider
  for update;

  if v_global_calls >= p_limit then
    return false;
  end if;

  if v_key_id is not null then
    insert into public.ghd_key_usage as k (day, key_id, calls)
    values (v_today, v_key_id, 0)
    on conflict (day, key_id) do nothing;

    select k.calls into v_key_calls
    from public.ghd_key_usage as k
    where k.day = v_today and k.key_id = v_key_id
    for update;

    if v_key_calls >= p_key_limit then
      return false;
    end if;

    if exists (
      select 1 from public.ghd_revoked_keys as r where r.key_id = v_key_id
    ) then
      return false;
    end if;

    update public.ghd_key_usage as k
    set calls = k.calls + 1
    where k.day = v_today and k.key_id = v_key_id and k.calls < p_key_limit;

    if not found then
      return false;
    end if;
  end if;

  update public.ghd_daily_usage as u
  set calls = u.calls + 1
  where u.day = v_today and u.provider = v_provider and u.calls < p_limit;

  return found;
end;
$$;

revoke all on function public.ghd_consume_paid_call(text, integer, text, integer) from public;
revoke all on function public.ghd_consume_paid_call(text, integer, text, integer) from anon, authenticated;
grant execute on function public.ghd_consume_paid_call(text, integer, text, integer) to service_role;

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
    tavily_calls, groq_calls, rapidapi_calls, newsdata_calls, rate_limited,
    key_id
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
    coalesce((p_row->>'rate_limited')::boolean, false),
    nullif(p_row->>'key_id', '')
  );

  delete from public.ghd_checks
  where created_at < now() - interval '30 days';
end;
$$;

revoke all on function public.ghd_log_check(jsonb) from public;
revoke all on function public.ghd_log_check(jsonb) from anon, authenticated;
grant execute on function public.ghd_log_check(jsonb) to service_role;

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
  key_usage_deleted bigint;
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

  delete from public.ghd_key_usage
  where day < ((timezone('utc', now()))::date - 35);
  get diagnostics key_usage_deleted = row_count;

  return jsonb_build_object(
    'ghd_rate_limits', rate_limits_deleted,
    'ghd_cache', cache_deleted,
    'ghd_checks', checks_deleted,
    'ghd_daily_usage', usage_deleted,
    'ghd_key_usage', key_usage_deleted
  );
end;
$$;

revoke all on function public.ghd_cleanup() from public;
revoke all on function public.ghd_cleanup() from anon, authenticated;
grant execute on function public.ghd_cleanup() to service_role;

commit;

notify pgrst, 'reload schema';
