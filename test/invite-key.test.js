import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { MemoryCache } from '../lib/server/cache.js';
import { createCleanupHandler } from '../lib/server/cleanup.js';
import {
  createAnalyzeHandler,
  createCareersHandler,
  createJobRepostsHandler,
  createReviewsHandler
} from '../lib/server/analyze.js';
import { createCompanyIdentityHandler } from '../lib/server/company-identity.js';
import { createCompanyRatingHandler } from '../lib/server/company-rating.js';
import { verifyInviteKey } from '../lib/server/invite-key.js';
import { createPaidQuota } from '../lib/server/paid-quota.js';
import { createPayVsMarketHandler } from '../lib/server/pay-market.js';
import { requestLogRow } from '../lib/server/request-log.js';

const require = createRequire(import.meta.url);
require('../lib/api-base.js');

const SECRET = 'invite-test-secret';
const IP = '203.0.113.50';
const NOW = new Date('2026-10-09T12:00:00Z');

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

function request(body, headers = {}, method = 'POST') {
  return {
    method,
    headers: {
      'x-ghd-client': 'ghost-job-detector',
      'x-forwarded-for': IP,
      origin: 'chrome-extension://abcdefghijklmnop',
      ...headers
    },
    body,
    url: '/api/company-rating?company=Initech'
  };
}

function issueKey({ id = 'ada', label = 'Ada', limit = 3, secret = SECRET } = {}) {
  const payload = Buffer.from(JSON.stringify({ id, label, limit }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return { id, limit, token: `ghd_${payload}.${signature}` };
}

function countingLimiter() {
  const calls = [];

  return {
    calls,
    async consume(ip) {
      calls.push(ip);
      return { allowed: true, count: calls.length, limit: 300 };
    }
  };
}

function quietFetch() {
  return async () => {
    throw new Error('request path called the network');
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

function handlerEnv(extra = {}) {
  return {
    REQUIRE_INVITE_KEY: 'true',
    INVITE_KEY_SECRET: SECRET,
    ...extra
  };
}

function analyzeHandler(extra = {}) {
  const limiter = extra.rateLimit || countingLimiter();
  const fetches = [];
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: new MemoryCache(),
    env: handlerEnv(extra.env),
    rateLimit: limiter,
    searchNews: async () => [],
    webSearch: async () => [],
    askGroq: async () => 'UNKNOWN',
    fetch: extra.fetch || quietFetch(),
    paidQuota: extra.paidQuota,
    quotaFetch: extra.quotaFetch,
    waitUntil: extra.waitUntil,
    logCheck: extra.logCheck,
    careersLookup: async () => [],
    careersRequest() {
      throw new Error('careers request');
    }
  });

  return { handler, limiter, fetches };
}

test('a tampered invite key is rejected before any work and counts toward the rate limit', async () => {
  const issued = issueKey();
  const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('a') ? 'b' : 'a'}`;
  const { handler, limiter } = analyzeHandler();
  const res = response();
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(JSON.stringify(args));

  try {
    await handler(request(job, { 'x-ghd-key': tampered }), res);
  } finally {
    console.info = original;
  }

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invite_invalid');
  assert.equal(limiter.calls.length, 1);
  assert.equal(JSON.stringify(logs).includes(tampered), false);
  assert.equal(JSON.stringify(res.body).includes(tampered), false);
});

test('a missing invite key is invite_required and does no work', async () => {
  const { handler, limiter } = analyzeHandler();
  const res = response();

  await handler(request(job), res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invite_required');
  assert.equal(limiter.calls.length, 1);
});

test('a key revoked in the environment is rejected with its id only', async () => {
  const issued = issueKey({ id: 'revoked-env' });
  const { handler } = analyzeHandler({
    env: { REVOKED_KEY_IDS: 'other, revoked-env' }
  });
  const res = response();
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(JSON.stringify(args));

  try {
    await handler(request(job, { 'x-ghd-key': issued.token }), res);
  } finally {
    console.info = original;
  }

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invite_invalid');
  assert.equal(JSON.stringify(logs).includes('revoked-env'), true);
  assert.equal(JSON.stringify(logs).includes(issued.token), false);
  assert.equal(JSON.stringify(res.body).includes(issued.token), false);
});

test('a key revoked in the table fails inside the paid-call counter, with no key lookup', async () => {
  const issued = issueKey({ id: 'revoked-table', limit: 10 });
  const urls = [];
  const quota = createPaidQuota({
    ...handlerEnv(),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test'
  }, async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(init.body);

    if (String(url).includes('ghd_revoked_keys') || String(url).includes('/ghd_key')) {
      throw new Error('key lookup on the request path');
    }

    return {
      ok: true,
      status: 200,
      json: async () => body.p_key_id !== 'revoked-table'
    };
  });
  quota.setInvite({ id: issued.id, limit: issued.limit });
  const logged = [];
  const { handler } = analyzeHandler({
    paidQuota: quota,
    logCheck: async (_env, input) => {
      logged.push(requestLogRow(input));
    },
    waitUntil(work) {
      return work;
    }
  });
  const res = response();
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(JSON.stringify(args));

  try {
    await handler(request(job, { 'x-ghd-key': issued.token }), res);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.info = original;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(quota.rateLimited(), true);
  assert.equal(logged[0].rate_limited, true);
  assert.equal(logged[0].key_id, 'revoked-table');
  assert.equal(urls.some((url) => url.includes('ghd_revoked_keys')), false);
  assert.equal(urls.every((url) => url.endsWith('/rpc/ghd_consume_paid_call')), true);
  const blob = JSON.stringify(logged) + logs.join('\n') + JSON.stringify(res.body);
  assert.equal(blob.includes(issued.token), false);
});

test('the paid-call counter enforces both the global limit and the key limit', async () => {
  const usage = { global: 0, key: 0 };
  const quota = createPaidQuota({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    TAVILY_DAILY_LIMIT: '2'
  }, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.p_key_id, 'ada');
    assert.equal(body.p_key_limit, 2);
    const globalHit = usage.global >= body.p_limit;
    const keyHit = usage.key >= body.p_key_limit;

    if (globalHit || keyHit) {
      return { ok: true, status: 200, json: async () => false };
    }

    usage.global += 1;
    usage.key += 1;
    return { ok: true, status: 200, json: async () => true };
  });
  quota.setInvite({ id: 'ada', limit: 2 });

  assert.equal(await quota.consume('tavily'), true);
  assert.equal(await quota.consume('tavily'), true);
  assert.equal(await quota.consume('tavily'), false);
  assert.equal(usage.global, 2);
  assert.equal(usage.key, 2);
  assert.equal(quota.rateLimited(), true);

  const globalOnly = { calls: 0 };
  const globalQuota = createPaidQuota({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    TAVILY_DAILY_LIMIT: '1'
  }, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.p_key_limit, 5);

    if (globalOnly.calls >= body.p_limit) {
      return { ok: true, status: 200, json: async () => false };
    }

    globalOnly.calls += 1;
    return { ok: true, status: 200, json: async () => true };
  });
  globalQuota.setInvite({ id: 'ada', limit: 5 });
  assert.equal(await globalQuota.consume('tavily'), true);
  assert.equal(await globalQuota.consume('tavily'), false);
  assert.equal(globalOnly.calls, 1);
});

test('invite keys are not checked when the flag is off', async () => {
  const { handler, limiter } = analyzeHandler({
    env: { REQUIRE_INVITE_KEY: 'false', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });
  const res = response();

  await handler(request(job), res);

  assert.equal(res.statusCode, 200);
  assert.equal(limiter.calls.length, 1);
});

test('every user route requires a key and cleanup does not', async () => {
  const env = handlerEnv();
  const shared = {
    now: NOW,
    cache: new MemoryCache(),
    env,
    rateLimit: countingLimiter(),
    searchNews: async () => [],
    webSearch: async () => [],
    askGroq: async () => 'UNKNOWN',
    fetch: quietFetch()
  };
  const routes = [
    createAnalyzeHandler(shared),
    createReviewsHandler(shared),
    createJobRepostsHandler(shared),
    createCareersHandler(shared),
    createCompanyIdentityHandler(shared),
    createPayVsMarketHandler(shared),
    createCompanyRatingHandler(shared)
  ];

  for (const handler of routes) {
    const res = response();
    const method = handler === routes[6] ? 'GET' : 'POST';
    await handler(request({ company: 'Initech', title: 'Analyst' }, {}, method), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'invite_required');
  }

  const cleanup = createCleanupHandler({
    env: { ...env, CRON_SECRET: 'cron-test' },
    fetch: quietFetch()
  });
  const open = response();
  await cleanup({ method: 'GET', headers: {} }, open);
  assert.equal(open.statusCode, 401);
  assert.equal(open.body.error, 'Unauthorized');
});

test('the invite SQL is one function, keeps the old call shape, and expires key usage', () => {
  const sql = readFileSync(new URL('../supabase/2026-10-09-invite-keys.sql', import.meta.url), 'utf8');

  assert.match(sql, /create table if not exists public\.ghd_revoked_keys/);
  assert.match(sql, /create table if not exists public\.ghd_key_usage/);
  assert.match(sql, /enable row level security/);
  assert.equal(/create policy/i.test(sql), false);
  assert.match(sql, /drop function if exists public\.ghd_consume_paid_call\(text, integer\)/);
  assert.match(sql, /p_key_id text default null/);
  assert.match(sql, /p_key_limit integer default null/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /grant execute on function public\.ghd_consume_paid_call\(text, integer, text, integer\) to service_role/);
  assert.match(sql, /add column if not exists key_id text/);
  assert.match(sql, /delete from public\.ghd_key_usage\s+where day < \(\(timezone\('utc', now\(\)\)\)::date - 35\)/);
  assert.match(sql, /ghd_revoked_keys/);
});

test('the key script prints one key and verify accepts only that signature', () => {
  const result = spawnSync(process.execPath, [
    'scripts/create-invite-key.mjs',
    '--label',
    'Ada',
    '--limit',
    '12'
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      INVITE_KEY_SECRET: SECRET
    }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const lines = result.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const token = lines[0];
  const verdict = verifyInviteKey(token, { INVITE_KEY_SECRET: SECRET });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.limit, 12);
  assert.equal(verifyInviteKey(`${token}x`, { INVITE_KEY_SECRET: SECRET }).ok, false);
  assert.equal(result.stdout.includes(SECRET), false);
});

test('the extension sends the key only from the background, and not to a custom origin without developer mode', () => {
  const { inviteKeyHeader, DEFAULT_API_BASE } = globalThis.GhdApiBase;
  const token = 'ghd_payload.signature';
  const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const content = [
    'content.js',
    'content/workday.js',
    'content/linkedin-company.js',
    'popup/popup.js',
    'lib/widget.js',
    'lib/job-page.js'
  ].map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');

  assert.match(background, /inviteKeyHeader/);
  assert.equal(content.includes('X-GHD-Key'), false);
  assert.deepEqual(inviteKeyHeader(token, DEFAULT_API_BASE, false), { 'X-GHD-Key': token });
  assert.deepEqual(inviteKeyHeader(token, 'http://127.0.0.1:8787', false), { 'X-GHD-Key': token });
  assert.deepEqual(inviteKeyHeader(token, 'https://jobs.example.com', false), {});
  assert.deepEqual(inviteKeyHeader(token, 'https://jobs.example.com', true), { 'X-GHD-Key': token });
  assert.deepEqual(inviteKeyHeader('', DEFAULT_API_BASE, true), {});
});
