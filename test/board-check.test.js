import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { checkBoard } from '../lib/server/open-jobs.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const later = (ms) => new Date(NOW.getTime() + ms);

// Lever held Intel's slug open for the full 8s (production, 2026-10-05). This
// fetch never answers: only the timeout ends it.
function hangingFetch(calls) {
  return (url, options = {}) => {
    calls.push(String(url));
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')));
    });
  };
}

test('a hung Greenhouse/Lever/Ashby check gives up at 2.5s, then is not retried for 5 minutes', async () => {
  const calls = [];
  const cache = new MemoryCache();
  const board = { platform: 'lever', token: 'intel' };
  const started = Date.now();

  await assert.rejects(checkBoard(board, 'Intel', { fetch: hangingFetch(calls), cache, now: NOW }));
  const waited = Date.now() - started;
  assert.ok(waited >= 2400 && waited < 4000, `waited ${waited}ms`);
  assert.equal(calls.length, 1);

  // Within 5 minutes: fails at once, with no request.
  await assert.rejects(checkBoard(board, 'Intel', { fetch: hangingFetch(calls), cache, now: later(4 * 60 * 1000) }), /last 5 minutes/);
  assert.equal(calls.length, 1);

  // After 5 minutes: tried again.
  await assert.rejects(checkBoard(board, 'Intel', {
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: false, status: 404, json: async () => ({}) };
    },
    cache,
    now: later(5 * 60 * 1000 + 1)
  }), /404/);
  assert.equal(calls.length, 2);
});

test('a 404 is a miss, not a failure: it is not marked', async () => {
  const calls = [];
  const cache = new MemoryCache();
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: false, status: 404, json: async () => ({}) };
  };

  await assert.rejects(checkBoard({ platform: 'lever', token: 'intel' }, 'Intel', { fetch, cache, now: NOW }), /404/);
  await assert.rejects(checkBoard({ platform: 'lever', token: 'intel' }, 'Intel', { fetch, cache, now: later(1000) }), /404/);
  assert.equal(calls.length, 2);
});
