import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { MemoryRateLimiter } from '../lib/server/rateLimit.js';
import { createAnalyzeHandler } from '../lib/server/analyze.js';

const NOW = new Date('2026-10-07T00:00:00Z');

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

// The temporary cold-trace hook gave a request carrying X-GHD-Trace-Cold an
// empty cache, so every such request paid for every lookup. It is gone: the
// header changes nothing and the shared cache is read as for any request.
test('the X-GHD-Trace-Cold header no longer bypasses the shared cache', async () => {
  const shared = new MemoryCache();
  const reads = [];
  const get = shared.get.bind(shared);
  shared.get = async (key, now) => {
    reads.push(key);
    return get(key, now);
  };
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: shared,
    rateLimit: new MemoryRateLimiter(50),
    env: {},
    waitUntil() {},
    logCheck: async () => {},
    searchNews: async () => [],
    webSearch: async () => [],
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });
  const res = mockResponse();

  await handler({
    method: 'POST',
    headers: {
      'x-ghd-client': 'ghost-job-detector',
      'x-ghd-trace-cold': 'any-token-value-at-all',
      'x-forwarded-for': '203.0.113.20'
    },
    body: { title: 'Engineer', company: 'Meta', description: 'Build services.', platform: 'LINKEDIN' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(reads.some((key) => key.startsWith('analyze:')), 'the shared analysis cache was read');
});

test('no trace of the cold-trace hook is left in the server', () => {
  const source = readFileSync(new URL('../lib/server/analyze.js', import.meta.url), 'utf8');
  assert.equal(/x-ghd-trace-cold|coldTrace|TRACE_COLD/i.test(source), false);
});
