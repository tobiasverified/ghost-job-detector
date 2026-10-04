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
