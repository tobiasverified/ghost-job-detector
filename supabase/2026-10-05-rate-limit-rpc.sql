-- Run this once in the Supabase SQL editor (it is also in schema.sql).
--
-- One atomic increment for the hourly rate-limit bucket. It replaces the
-- read-then-write the API used to make: two round trips, and two requests
-- arriving together could both read the same count and lose an increment.
-- INSERT ... ON CONFLICT DO UPDATE locks the row, so concurrent calls each
-- get their own count.

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

-- Only the server's service role may call it. Functions are executable by
-- PUBLIC by default, which would include the anon and authenticated roles.
revoke all on function public.ghd_consume_rate_limit(text, timestamptz) from public;
revoke all on function public.ghd_consume_rate_limit(text, timestamptz) from anon, authenticated;
grant execute on function public.ghd_consume_rate_limit(text, timestamptz) to service_role;

-- The function runs as service_role (security invoker), which needs these on
-- the table. Harmless if they were already granted.
grant select, insert, update on table public.ghd_rate_limits to service_role;

-- Make the REST API see the new function without waiting for its schema cache.
notify pgrst, 'reload schema';
