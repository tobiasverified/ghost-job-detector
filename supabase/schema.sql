-- Run this in the Supabase SQL editor.
-- The service role key bypasses row level security.
-- The anon key has no policies, so it cannot read this data.

create table if not exists public.ghd_cache (
  cache_key text primary key,
  payload jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists ghd_cache_expires_at_idx
  on public.ghd_cache (expires_at);

create table if not exists public.ghd_rate_limits (
  bucket_key text primary key,
  request_count integer not null,
  window_start timestamptz not null
);

alter table public.ghd_cache enable row level security;
alter table public.ghd_rate_limits enable row level security;

-- Atomic hourly rate-limit increment (see 2026-10-05-rate-limit-rpc.sql).
create or replace function public.ghd_consume_rate_limit(
  p_bucket_key text,
  p_window_start timestamptz
)
returns integer
language sql
security invoker
set search_path = public
as $$
  insert into public.ghd_rate_limits as r (bucket_key, request_count, window_start)
  values (p_bucket_key, 1, p_window_start)
  on conflict (bucket_key)
  do update set request_count = r.request_count + 1
  returning r.request_count;
$$;

revoke all on function public.ghd_consume_rate_limit(text, timestamptz) from public;
revoke all on function public.ghd_consume_rate_limit(text, timestamptz) from anon, authenticated;
grant execute on function public.ghd_consume_rate_limit(text, timestamptz) to service_role;
grant select, insert, update on table public.ghd_rate_limits to service_role;
