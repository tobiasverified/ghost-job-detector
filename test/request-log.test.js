import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { MemoryRateLimiter } from '../lib/server/rateLimit.js';
import { createAnalyzeHandler } from '../lib/server/analyze.js';
import { logCheck, requestLogCutoff, requestLogRow, scheduleRequestLog } from '../lib/server/request-log.js';

const NOW = new Date('2026-10-06T00:00:00Z');
const DESCRIPTION = 'Build reliable services for a large product organization with clear ownership of the posting text.';
const CLIENT_IP = '203.0.113.10';

function mockResponse() {
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

function mockRequest(body) {
  return {
    method: 'POST',
    headers: {
      'x-ghd-client': 'ghost-job-detector',
      'x-forwarded-for': CLIENT_IP,
      origin: 'chrome-extension://abcdefghijklmnop'
    },
    body
  };
}

test('a check row keeps the company and the outcome, not the posting or the IP', () => {
  const row = requestLogRow({
    job: {
      company: 'Amazon Web Services',
      title: 'Delivery Consultant - AI/ML',
      description: DESCRIPTION,
      url: 'https://www.linkedin.com/jobs/view/delivery-consultant-4475850084',
      platform: 'LINKEDIN',
      jobId: '4475850084',
      ip: CLIENT_IP
    },
    outcome: {
      company: 'Amazon Web Services',
      cached: false,
      partial: true,
      scoreWithheld: false,
      timedOut: ['hiringRatio'],
      ghostScore: 14,
      factors: {
        hiringRatio: { employees: 147927, employeeSource: 'wikidata', openRoles: 8220, openJobsSource: 'glassdoor', openJobsLowerBound: true }
      }
    },
    status: 200,
    totalMs: 9113,
    deploymentId: 'dpl_test',
    ip: CLIENT_IP,
    description: DESCRIPTION
  });
  const encoded = JSON.stringify(row);

  assert.equal(row.company, 'Amazon Web Services');
  assert.equal(row.job_id, '4475850084');
  assert.equal(row.platform, 'LINKEDIN');
  assert.equal(row.partial, true);
  assert.equal(row.employees, 147927);
  assert.equal(row.open_roles, 8220);
  assert.equal(row.open_roles_lower_bound, true);
  assert.equal(encoded.includes(DESCRIPTION), false);
  assert.equal(encoded.includes('Delivery Consultant'), false);
  assert.equal(encoded.includes(CLIENT_IP), false);
  assert.equal(encoded.includes('linkedin.com'), false);
  assert.equal(Object.hasOwn(row, 'ip'), false);
  assert.equal(Object.hasOwn(row, 'description'), false);
  assert.equal(Object.hasOwn(row, 'title'), false);
});

test('rows older than 30 days are the ones the cleanup deletes', () => {
  assert.equal(requestLogCutoff(NOW), '2026-09-06T00:00:00.000Z');
  const sql = readFileSync(new URL('../supabase/2026-10-06-request-log.sql', import.meta.url), 'utf8');

  assert.match(sql, /create table if not exists public\.ghd_checks/);
  assert.match(sql, /delete from public\.ghd_checks\s+where created_at < now\(\) - interval '30 days'/);
  assert.match(sql, /grant execute on function public\.ghd_log_check\(jsonb\) to service_role/);
  assert.match(sql, /grant select, insert, delete on table public\.ghd_checks to service_role/);
  assert.match(sql, /grant usage, select on sequence public\.ghd_checks_id_seq to service_role/);
  assert.equal(/\bip\b/.test(sql), false);
  assert.equal(sql.includes('description'), false);
});

test('the log write is the whitelisted row, and a failed write does not change the response', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    throw new Error('supabase down');
  };

  try {
    const row = await logCheck({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key'
    }, {
      job: { company: 'Meta', description: DESCRIPTION, platform: 'LINKEDIN', jobId: '1' },
      status: 200,
      totalMs: 40
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/ghd_log_check$/);
    assert.equal(calls[0].body.includes(DESCRIPTION), false);
    assert.equal(row.company, 'Meta');
  } finally {
    globalThis.fetch = original;
  }

  const pending = [];
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: new MemoryCache(),
    rateLimit: new MemoryRateLimiter(50),
    env: {},
    waitUntil(promise) {
      pending.push(promise);
    },
    logCheck: async () => {
      throw new Error('db down');
    },
    searchNews: async () => [],
    webSearch: async () => [],
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });
  const res = mockResponse();

  await handler(mockRequest({
    title: 'Engineer',
    company: 'Meta',
    description: DESCRIPTION,
    url: 'https://example.com/meta',
    platform: 'LINKEDIN',
    jobId: '99'
  }), res);
  await Promise.all(pending);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.stringify(res.body).includes('db down'), false);

  let recorded;
  await scheduleRequestLog(null, {}, {
    job: { company: 'Meta', description: DESCRIPTION, jobId: '99', platform: 'LINKEDIN' },
    status: 200
  }, async (env, input) => {
    recorded = requestLogRow(input);
    assert.equal(env.SUPABASE_URL, undefined);
  });
  assert.equal(recorded.job_id, '99');
  assert.equal(JSON.stringify(recorded).includes(DESCRIPTION), false);
});
