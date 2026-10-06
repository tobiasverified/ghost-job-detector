-- Run this once in the Supabase SQL editor (it is also in schema.sql).
--
-- One row per analyze-job check, kept for 30 days. The row has no posting
-- text and no client IP. service_role is the only role that can write it.
-- ghd_log_check inserts the row and deletes anything older than 30 days.

create table if not exists public.ghd_checks (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  company text not null default '',
  platform text not null default '',
  job_id text not null default '',
  status integer not null,
  cached boolean not null default false,
  partial boolean not null default false,
  score_withheld boolean not null default false,
  timed_out text[] not null default '{}',
  ghost_score integer,
  employees integer,
  employee_source text,
  open_roles integer,
  open_roles_source text,
  open_roles_lower_bound boolean not null default false,
  total_ms integer,
  deployment_id text
);

create index if not exists ghd_checks_created_at_idx
  on public.ghd_checks (created_at);

alter table public.ghd_checks enable row level security;

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
    open_roles_source, open_roles_lower_bound, total_ms, deployment_id
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
    nullif(p_row->>'deployment_id', '')
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

notify pgrst, 'reload schema';
