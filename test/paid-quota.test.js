import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { createCleanupHandler } from '../lib/server/cleanup.js';
import { glassdoorCachePayload } from '../lib/server/company-rating.js';
import { hashIp, resetIpHashWarning } from '../lib/server/ip-hash.js';
import { detectLayoffs } from '../lib/server/layoffs.js';
import { analyzeJobPosting, analysisCacheKey, createAnalyzeHandler, refreshIpCacheKey } from '../lib/server/analyze.js';
import { DAILY_LIMIT_DEFAULTS, PAID_CAP_TTL_MS, createPaidQuota, dailyLimit, installPaidQuota } from '../lib/server/paid-quota.js';
import { SupabaseRateLimiter } from '../lib/server/rateLimit.js';
import { requestLogRow } from '../lib/server/request-log.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const IP = '203.0.113.44';
const QUOTA_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
  IP_HASH_SECRET: 'ip-hash-test'
};

function rpcFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function response() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    }
  };
}

function request(body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      'x-ghd-client': 'ghost-job-detector',
      'x-forwarded-for': IP,
      origin: 'chrome-extension://abcdefghijklmnop',
      ...headers
    },
    body
  };
}

const job = {
  title: 'Analyst',
  company: 'Initech',
  description: 'You will build Python services with 5 years of experience. Salary $150,000. Specific duties are listed for each quarter.',
  url: 'https://www.linkedin.com/jobs/view/101',
  platform: 'LINKEDIN',
  jobId: '101',
  deferReposts: true
};

function emptyFetch() {
  return async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
}

test('daily limits are read from env and fall back to the defaults', () => {
  assert.deepEqual(dailyLimit({}, 'tavily'), DAILY_LIMIT_DEFAULTS.tavily);
  assert.equal(dailyLimit({ TAVILY_DAILY_LIMIT: '7' }, 'tavily'), 7);
  assert.equal(dailyLimit({ RAPIDAPI_DAILY_LIMIT: '0' }, 'rapidapi'), 0);
  assert.equal(dailyLimit({ GROQ_DAILY_LIMIT: 'nope' }, 'groq'), DAILY_LIMIT_DEFAULTS.groq);
  assert.equal(DAILY_LIMIT_DEFAULTS.tavily, 40);
  assert.equal(DAILY_LIMIT_DEFAULTS.rapidapi, 25);
  assert.equal(DAILY_LIMIT_DEFAULTS.groq, 40);
  assert.equal(DAILY_LIMIT_DEFAULTS.newsdata, 25);
});

test('a reached cap degrades the layoff factor and does not call the provider', async () => {
  const called = [];
  const quota = createPaidQuota(QUOTA_ENV, rpcFetch(false));
  const deps = installPaidQuota({
    now: NOW,
    env: QUOTA_ENV,
    paidQuota: quota,
    description: '',
    searchNews: async () => {
      called.push('newsdata');
      return [];
    },
    webSearch: async () => {
      called.push('tavily');
      return [];
    },
    askGroq: async () => {
      called.push('groq');
      return 'UNKNOWN';
    },
    fetch: emptyFetch()
  });

  const result = await detectLayoffs('Acme', deps);

  assert.equal(result.detected, false);
  assert.equal(called.length, 0);
  assert.equal(quota.rateLimited(), true);
  assert.equal(quota.snapshot().newsdata, 0);
});

test('a cap-hit analysis is stored for 5 minutes and no longer', async () => {
  const cache = new MemoryCache();
  const quota = createPaidQuota(QUOTA_ENV, rpcFetch(false));
  const deps = installPaidQuota({
    now: NOW,
    cache,
    env: QUOTA_ENV,
    paidQuota: quota,
    clientIp: IP,
    searchNews: async () => [],
    webSearch: async () => [],
    askGroq: async () => 'UNKNOWN',
    fetch: emptyFetch()
  });

  const result = await analyzeJobPosting(job, deps);
  const stored = [...cache.store.entries()];
  const analysis = stored.find(([key]) => key === analysisCacheKey({ ...job, company: result.company || job.company }));

  assert.equal(quota.rateLimited(), true);
  assert.ok(analysis, 'analysis was cached');

  for (const [, row] of stored) {
    const ttl = new Date(row.expiresAt).getTime() - new Date(row.updatedAt).getTime();
    assert.ok(ttl <= PAID_CAP_TTL_MS);
  }

  assert.equal(
    new Date(analysis[1].expiresAt).getTime() - new Date(analysis[1].updatedAt).getTime(),
    PAID_CAP_TTL_MS
  );
  assert.equal(await cache.get(analysis[0], new Date(NOW.getTime() + PAID_CAP_TTL_MS - 1000)) == null, false);
  assert.equal(await cache.get(analysis[0], new Date(NOW.getTime() + PAID_CAP_TTL_MS + 1000)), null);
});

test('an RPC error skips the paid call', async () => {
  const called = [];
  const quota = createPaidQuota(QUOTA_ENV, async () => {
    throw new Error('rpc down');
  });
  const deps = installPaidQuota({
    now: NOW,
    env: QUOTA_ENV,
    paidQuota: quota,
    searchNews: async () => {
      called.push('newsdata');
      return [];
    },
    webSearch: async () => [],
    askGroq: async () => 'UNKNOWN',
    fetch: emptyFetch()
  });

  const result = await detectLayoffs('Acme', deps);

  assert.equal(result.detected, false);
  assert.equal(called.includes('newsdata'), false);
  assert.equal(quota.snapshot().newsdata, 0);
  assert.equal(quota.rateLimited(), true);
});

test('paid call counts land on the check log', async () => {
  const pending = [];
  const logged = [];
  const quota = createPaidQuota(QUOTA_ENV, rpcFetch(true));
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: new MemoryCache(),
    env: QUOTA_ENV,
    paidQuota: quota,
    quotaFetch: rpcFetch(true),
    rateLimit: { async consume() { return { allowed: true, count: 1, limit: 300 }; } },
    searchNews: async () => [],
    webSearch: async () => [],
    askGroq: async () => 'UNKNOWN',
    fetch: emptyFetch(),
    waitUntil: (work) => pending.push(work),
    logCheck: async (_env, input) => {
      logged.push(requestLogRow(input));
    }
  });

  const res = response();
  await handler(request(job), res);
  await Promise.all(pending);

  assert.equal(res.statusCode, 200);
  assert.equal(logged.length, 1);
  const row = logged[0];
  const snap = quota.snapshot();
  assert.equal(row.tavily_calls, snap.tavily);
  assert.equal(row.groq_calls, snap.groq);
  assert.equal(row.rapidapi_calls, snap.rapidapi);
  assert.equal(row.newsdata_calls, snap.newsdata);
  assert.equal(row.rate_limited, false);
  assert.ok(row.newsdata_calls + row.tavily_calls + row.groq_calls + row.rapidapi_calls > 0);
  assert.equal(JSON.stringify(row).includes(IP), false);
});

test('a check row without paid counts stores zeros', () => {
  const row = requestLogRow({ status: 200, job: { company: 'Acme' } });
  assert.equal(row.tavily_calls, 0);
  assert.equal(row.groq_calls, 0);
  assert.equal(row.rapidapi_calls, 0);
  assert.equal(row.newsdata_calls, 0);
  assert.equal(row.rate_limited, false);
});

test('supabase payloads and logs do not contain the raw address', async () => {
  const calls = [];
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(JSON.stringify(args));

  try {
    const limiter = new SupabaseRateLimiter(QUOTA_ENV, 50, {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body || '') });
        if (String(url).includes('/rpc/')) {
          return { ok: false, status: 404, json: async () => ({}) };
        }

        return init?.method === 'POST'
          ? { ok: true, status: 201, json: async () => null }
          : { ok: true, status: 200, json: async () => [{ request_count: 1 }] };
      }
    });
    await limiter.consume(IP, NOW);
    const key = refreshIpCacheKey(IP, QUOTA_ENV);
    const blob = JSON.stringify(calls) + logs.join('\n') + key;
    assert.equal(blob.includes(IP), false);
    assert.equal(calls.length >= 2, true);
  } finally {
    console.info = original;
  }
});

test('the same address hashes the same and a different address does not', () => {
  const env = { IP_HASH_SECRET: 'ip-hash-test' };
  const first = hashIp(IP, env);
  assert.equal(first, hashIp(IP, env));
  assert.notEqual(first, hashIp('203.0.113.45', env));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first.includes(IP), false);
  assert.equal(refreshIpCacheKey(IP, env), refreshIpCacheKey(IP, env));
  assert.notEqual(refreshIpCacheKey(IP, env), refreshIpCacheKey('198.51.100.8', env));
});

test('a missing hash secret warns once and uses the service role key', () => {
  resetIpHashWarning();
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args);
  const secret = 'service-role-material';
  const env = { SUPABASE_SERVICE_ROLE_KEY: secret };

  try {
    const first = hashIp(IP, env);
    const second = hashIp(IP, env);
    assert.equal(first, second);
    assert.notEqual(first, hashIp('198.51.100.9', env));
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].fallback, 'SUPABASE_SERVICE_ROLE_KEY');
    assert.equal(JSON.stringify(logs).includes(IP), false);
    assert.equal(JSON.stringify(logs).includes(secret), false);
  } finally {
    console.info = original;
    resetIpHashWarning();
  }
});

test('cleanup rejects a missing or wrong token', async () => {
  const handler = createCleanupHandler({
    env: { ...QUOTA_ENV, CRON_SECRET: 'cron-test' },
    fetch: async () => {
      throw new Error('cleanup was called');
    }
  });
  const missing = response();
  await handler({ method: 'GET', headers: {} }, missing);
  assert.equal(missing.statusCode, 401);

  const wrong = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer other-token' } }, wrong);
  assert.equal(wrong.statusCode, 401);

  const ok = response();
  const counts = { ghd_rate_limits: 2, ghd_cache: 1, ghd_checks: 0, ghd_daily_usage: 3 };
  const allowed = createCleanupHandler({
    env: { ...QUOTA_ENV, CRON_SECRET: 'cron-test' },
    fetch: async () => ({ ok: true, status: 200, json: async () => counts })
  });
  await allowed({ method: 'GET', headers: { authorization: 'Bearer cron-test' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, counts);
});

test('the glassdoor cache keeps only the fields the score reads', () => {
  const kept = glassdoorCachePayload({
    ratings: { overall: 4.2, culture: 3.1 },
    counts: { reviews: 10, open_jobs: 2, salaries: 9 },
    size: '1001-5000 Employees',
    website: 'https://example.com',
    link: 'https://example.com/ignored',
    name: 'Acme',
    id: 42,
    ceo: 'Pat',
    headquarters: 'Austin',
    company: { name: 'Nested', revenue: 'hidden' }
  });

  assert.deepEqual(kept, {
    ratings: { overall: 4.2 },
    counts: { reviews: 10, open_jobs: 2 },
    size: '1001-5000 Employees',
    website: 'https://example.com',
    name: 'Acme',
    id: '42'
  });

  const linked = glassdoorCachePayload({
    link: 'https://example.com/about',
    company: { name: 'Nested Co', id: '9' },
    ghdMatchedAs: 'Nested Co'
  });
  assert.deepEqual(linked, {
    link: 'https://example.com/about',
    name: 'Nested Co',
    id: '9',
    ghdMatchedAs: 'Nested Co'
  });
});
