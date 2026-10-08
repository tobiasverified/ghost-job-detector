import assert from 'node:assert/strict';
import test from 'node:test';
import { hashIp } from '../lib/server/ip-hash.js';
import { SupabaseRateLimiter } from '../lib/server/rateLimit.js';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
  IP_HASH_SECRET: 'ip-hash-test'
};
const IP = '203.0.113.9';
const BUCKET = `${hashIp(IP, ENV)}|2026-10-05T12:00:00.000Z`;
const NOW = new Date('2026-10-05T12:34:56Z');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('the hourly bucket is consumed with one atomic RPC call', async () => {
  const calls = [];
  const limiter = new SupabaseRateLimiter(ENV, 50, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') });
      return response(200, 7);
    }
  });

  const result = await limiter.consume(IP, NOW);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/ghd_consume_rate_limit');
  assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.stringify(calls).includes(IP), false);
  assert.deepEqual(calls[0].body, {
    p_bucket_key: BUCKET,
    p_window_start: '2026-10-05T12:00:00.000Z'
  });
  assert.deepEqual(result, { allowed: true, count: 7, limit: 50, via: 'rpc' });
});

test('the count the RPC returns decides: one over the limit is rejected', async () => {
  const limiter = new SupabaseRateLimiter(ENV, 50, { fetch: async () => response(200, 51) });
  const result = await limiter.consume('203.0.113.9', NOW);

  assert.equal(result.allowed, false);
  assert.equal(result.count, 51);
});

test('before the SQL is installed (RPC 404), the read-then-write still counts', async () => {
  const calls = [];
  const limiter = new SupabaseRateLimiter(ENV, 50, {
    fetch: async (url, init) => {
      const href = String(url);
      calls.push(href.includes('/rpc/') ? 'rpc' : (init?.method === 'POST' ? 'write' : 'read'));

      if (href.includes('/rpc/')) {
        return response(404, { code: 'PGRST202' });
      }

      return init?.method === 'POST' ? response(201, null) : response(200, [{ request_count: 4 }]);
    }
  });

  const result = await limiter.consume('203.0.113.9', NOW);

  assert.deepEqual(calls, ['rpc', 'read', 'write']);
  assert.deepEqual(result, { allowed: true, count: 5, limit: 50, via: 'read-write' });
});

test('a failing RPC falls back to the in-memory limiter, which still counts', async () => {
  const limiter = new SupabaseRateLimiter(ENV, 2, { fetch: async () => response(500, {}) });

  assert.equal((await limiter.consume('203.0.113.9', NOW)).allowed, true);
  assert.equal((await limiter.consume('203.0.113.9', NOW)).allowed, true);
  assert.equal((await limiter.consume('203.0.113.9', NOW)).allowed, false);
});

test('an RPC answer that is not a count is not treated as allowed', async () => {
  const limiter = new SupabaseRateLimiter(ENV, 1, { fetch: async () => response(200, null) });

  // Falls back to memory: the first call is allowed, the second is over the limit of 1.
  assert.equal((await limiter.consume('203.0.113.9', NOW)).allowed, true);
  assert.equal((await limiter.consume('203.0.113.9', NOW)).allowed, false);
});
