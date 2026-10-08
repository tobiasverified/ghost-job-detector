import { hashIp } from './ip-hash.js';

const HOUR_MS = 60 * 60 * 1000;

export class MemoryRateLimiter {
  constructor(limit = 50) {
    this.limit = limit;
    this.buckets = new Map();
  }

  async consume(ip, now = new Date()) {
    const bucket = now.toISOString().slice(0, 13);
    const key = `${ip}|${bucket}`;
    const count = (this.buckets.get(key) || 0) + 1;
    this.buckets.set(key, count);

    const cutoff = new Date(now.getTime() - (2 * HOUR_MS)).toISOString().slice(0, 13);

    for (const storedKey of this.buckets.keys()) {
      const storedBucket = storedKey.split('|').at(-1) || '';

      if (storedBucket < cutoff) {
        this.buckets.delete(storedKey);
      }
    }

    return {
      allowed: count <= this.limit,
      count,
      limit: this.limit
    };
  }
}

export class SupabaseRateLimiter {
  constructor(env, memoryLimit, options = {}) {
    this.env = env;
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    this.limit = memoryLimit;
    this.memory = new MemoryRateLimiter(memoryLimit);
    this.fetch = options.fetch || ((...args) => fetch(...args));
  }

  headers(extra = {}) {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async consume(ip, now = new Date()) {
    const key = hashIp(ip, this.env);

    try {
      return await this.consumeRemote(key, now);
    } catch {
      return this.memory.consume(key, now);
    }
  }

  async consumeRemote(key, now) {
    const windowStart = new Date(now);
    windowStart.setUTCMinutes(0, 0, 0);
    const bucketKey = `${key}|${windowStart.toISOString()}`;
    const counted = await this.consumeAtomic(bucketKey, windowStart);

    if (counted) {
      return counted;
    }

    return this.consumeReadWrite(bucketKey, windowStart);
  }

  // One round trip, and concurrent requests cannot lose an increment
  // (supabase/2026-10-05-rate-limit-rpc.sql). Returns null when that function
  // is not installed yet, so the read-then-write below is used instead.
  async consumeAtomic(bucketKey, windowStart) {
    const response = await this.fetch(`${this.url}/rest/v1/rpc/ghd_consume_rate_limit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        p_bucket_key: bucketKey,
        p_window_start: windowStart.toISOString()
      }),
      signal: AbortSignal.timeout(2500)
    });

    if (response.status === 404) {
      if (!SupabaseRateLimiter.warnedMissing) {
        SupabaseRateLimiter.warnedMissing = true;
        console.info('[GHD] rate limit rpc missing', { fallback: 'read-then-write' });
      }

      return null;
    }

    if (!response.ok) {
      throw new Error(`Rate limit increment failed (${response.status})`);
    }

    const count = Number(await response.json());

    if (!Number.isFinite(count) || count < 1) {
      throw new Error('Rate limit increment returned no count');
    }

    return {
      allowed: count <= this.limit,
      count,
      limit: this.limit,
      via: 'rpc'
    };
  }

  async consumeReadWrite(bucketKey, windowStart) {
    const endpoint = new URL(`${this.url}/rest/v1/ghd_rate_limits`);
    endpoint.searchParams.set('bucket_key', `eq.${bucketKey}`);
    endpoint.searchParams.set('select', 'request_count');

    const currentResponse = await this.fetch(endpoint, {
      headers: this.headers(),
      signal: AbortSignal.timeout(2500)
    });

    if (!currentResponse.ok) {
      throw new Error(`Rate limit read failed (${currentResponse.status})`);
    }

    const rows = await currentResponse.json();
    const current = Number(rows?.[0]?.request_count) || 0;
    const count = current + 1;

    const writeResponse = await this.fetch(`${this.url}/rest/v1/ghd_rate_limits`, {
      method: 'POST',
      headers: this.headers({
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify({
        bucket_key: bucketKey,
        request_count: count,
        window_start: windowStart.toISOString()
      }),
      signal: AbortSignal.timeout(2500)
    });

    if (!writeResponse.ok) {
      throw new Error(`Rate limit write failed (${writeResponse.status})`);
    }

    return {
      allowed: count <= this.limit,
      count,
      limit: this.limit,
      via: 'read-write'
    };
  }
}

// One check is analyze-job plus pay-vs-market, so the hourly cap is 300
// requests, not 50. RATE_LIMIT_PER_HOUR still overrides this when it is set.
export const HOURLY_REQUEST_LIMIT = 300;

export function createRateLimiter(env = process.env) {
  const limit = Number(env.RATE_LIMIT_PER_HOUR) || HOURLY_REQUEST_LIMIT;

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseRateLimiter(env, limit);
  }

  if (!globalThis.__ghdMemoryRateLimiter) {
    globalThis.__ghdMemoryRateLimiter = new MemoryRateLimiter(limit);
  }

  return globalThis.__ghdMemoryRateLimiter;
}
