// A finished lookup that accepted nothing. Read at this age, not the write TTL.
export const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
// Hits came back and the name check rejected all of them.
export const NAME_REJECTION_TTL_MS = 60 * 60 * 1000;

export function writtenWithin(updatedAt, capMs, now = new Date()) {
  const written = new Date(updatedAt || 0).getTime();

  if (!updatedAt || !Number.isFinite(written)) {
    return false;
  }

  return now.getTime() - written <= capMs;
}

export class MemoryCache {
  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  async getMeta(key, now = new Date()) {
    const row = this.store.get(key);

    if (!row) {
      return null;
    }

    if (new Date(row.expiresAt).getTime() <= now.getTime()) {
      this.store.delete(key);
      return null;
    }

    return {
      payload: row.payload,
      updatedAt: row.updatedAt || null
    };
  }

  async get(key, now = new Date()) {
    const meta = await this.getMeta(key, now);
    return meta ? meta.payload : null;
  }

  async set(key, payload, ttlMs, now = new Date()) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }

    this.store.set(key, {
      payload,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      updatedAt: now.toISOString()
    });
  }
}

export class SupabaseCache {
  constructor(env) {
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  headers(extra = {}) {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async getMeta(key, now = new Date()) {
    const endpoint = new URL(`${this.url}/rest/v1/ghd_cache`);
    endpoint.searchParams.set('cache_key', `eq.${key}`);
    endpoint.searchParams.set('select', 'payload,expires_at,updated_at');

    const response = await fetch(endpoint, {
      headers: this.headers(),
      signal: AbortSignal.timeout(2500)
    });

    if (!response.ok) {
      return null;
    }

    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;

    if (!row?.expires_at) {
      return null;
    }

    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      return null;
    }

    return {
      payload: row.payload,
      updatedAt: row.updated_at || null
    };
  }

  async get(key, now = new Date()) {
    const meta = await this.getMeta(key, now);
    return meta ? meta.payload : null;
  }

  async set(key, payload, ttlMs, now = new Date()) {
    const response = await fetch(`${this.url}/rest/v1/ghd_cache`, {
      method: 'POST',
      headers: this.headers({
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify({
        cache_key: key,
        payload,
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        updated_at: now.toISOString()
      }),
      signal: AbortSignal.timeout(2500)
    });

    if (!response.ok) {
      const body = typeof response.text === 'function' ? await response.text() : '';
      console.info('[GHD] cache write response', {
        status: response.status,
        body: String(body)
      });
      throw new Error(`Cache write failed (${response.status})`);
    }
  }
}

export function createCache(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseCache(env);
  }

  if (!globalThis.__ghdMemoryCache) {
    globalThis.__ghdMemoryCache = new MemoryCache();
  }

  return globalThis.__ghdMemoryCache;
}

export async function cacheGet(cache, key, now) {
  try {
    return await cache.get(key, now);
  } catch {
    return null;
  }
}

export async function cacheGetMeta(cache, key, now) {
  try {
    if (cache && typeof cache.getMeta === 'function') {
      return await cache.getMeta(key, now);
    }

    const payload = await cacheGet(cache, key, now);
    return payload == null ? null : { payload, updatedAt: null };
  } catch {
    return null;
  }
}

export async function cacheSet(cache, key, payload, ttlMs, now) {
  try {
    await cache.set(key, payload, ttlMs, now);
  } catch (error) {
    // A cache outage should not fail the analysis.
    console.info('[GHD] cache write failed', { key, error: error?.message || String(error) });
  }
}

// Cache writes do not change the response, so they need not delay it. With a
// waitUntil (Vercel keeps the function alive until the promise settles), set()
// hands the write off and returns at once. Without one, set() waits as before.
// Reads are untouched. A later get() of the same key in the same request may
// miss the pending write, which only costs a recomputation.
export function deferWrites(cache, waitUntil) {
  if (!cache || typeof waitUntil !== 'function') {
    return cache;
  }

  return {
    get: (key, now) => cache.get(key, now),
    getMeta: (key, now) => (
      typeof cache.getMeta === 'function'
        ? cache.getMeta(key, now)
        : cache.get(key, now).then((payload) => (payload == null ? null : { payload, updatedAt: null }))
    ),
    set: (key, payload, ttlMs, now) => {
      const write = Promise.resolve()
        .then(() => cache.set(key, payload, ttlMs, now))
        .catch((error) => {
          console.info('[GHD] cache write failed', { key, deferred: true, error: error?.message || String(error) });
        });

      try {
        waitUntil(write);
      } catch {
        return write;
      }

      return Promise.resolve();
    }
  };
}
