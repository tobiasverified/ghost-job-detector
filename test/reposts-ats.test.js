import assert from 'node:assert/strict';
import test from 'node:test';
import { ATS_AGE_TIMEOUT_MS, atsBoardsFromOpenJobs, lookupAtsAge } from '../lib/server/reposts.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const job = { title: 'Research Analyst', company: 'Acme Health', location: 'Rochester, MN' };

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Answers a board URL after a delay, honouring the abort signal like fetch does.
function slowFetch(routes, log = []) {
  return (url, init) => new Promise((resolve, reject) => {
    const href = String(url);
    const route = Object.entries(routes).find(([prefix]) => href.startsWith(prefix))?.[1] || { ms: 0, body: null, status: 404 };
    log.push(href);
    const timer = setTimeout(() => resolve(json(route.status || 200, route.body)), route.ms);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

const leverListing = { text: 'Research Analyst', categories: { location: 'Rochester, MN' }, createdAt: NOW.getTime() - 100 * DAY, hostedUrl: 'https://jobs.lever.co/acmehealth/1' };
const greenhouseListing = { title: 'Research Analyst', location: { name: 'Rochester, MN' }, first_published: new Date(NOW.getTime() - 40 * DAY).toISOString(), absolute_url: 'https://boards.greenhouse.io/acmehealth/jobs/1' };

test('Greenhouse and Lever are read at once, and a slow board gives up at 1.5s', async () => {
  assert.equal(ATS_AGE_TIMEOUT_MS, 1500);
  const started = Date.now();
  const found = await lookupAtsAge(job, slowFetch({
    'https://boards-api.greenhouse.io/': { ms: 5000, status: 404 },
    'https://api.lever.co/v0/postings/acmehealth?': { ms: 50, body: [leverListing] }
  }), NOW);

  const elapsed = Date.now() - started;
  assert.equal(found.source, 'Lever');
  assert.equal(found.ageDays, 100);
  assert.ok(elapsed < 2200, `took ${elapsed}ms; one slow board must not hold the others up past 1.5s`);
});

test('the first match keeps the old order: Greenhouse before Lever for the same slug', async () => {
  const found = await lookupAtsAge(job, slowFetch({
    'https://boards-api.greenhouse.io/v1/boards/acmehealth/': { ms: 200, body: { jobs: [greenhouseListing] } },
    'https://api.lever.co/v0/postings/acmehealth?': { ms: 10, body: [leverListing] }
  }), NOW);

  assert.equal(found.source, 'Greenhouse');
  assert.equal(found.ageDays, 40);
});

test('when open roles found no board under these slugs, the slow reads are not waited for', async () => {
  const started = Date.now();
  const found = await lookupAtsAge(job, slowFetch({
    'https://boards-api.greenhouse.io/': { ms: 1400, status: 404 },
    'https://api.lever.co/': { ms: 1400, status: 404 }
  }), NOW, { known: Promise.resolve([]) });

  assert.equal(found, null);
  assert.ok(Date.now() - started < 500);
});

test('a board open roles found under another name is read as well', async () => {
  const log = [];
  const found = await lookupAtsAge(job, slowFetch({
    'https://api.lever.co/v0/postings/acme-health-inc?': { ms: 10, body: [leverListing] }
  }, log), NOW, { known: Promise.resolve([{ platform: 'lever', token: 'acme-health-inc' }]) });

  assert.equal(found.source, 'Lever');
  assert.ok(log.some((href) => href.includes('/acme-health-inc?')));
});

test('the cached open-roles result is read as board knowledge only when it is conclusive', () => {
  assert.deepEqual(atsBoardsFromOpenJobs({ tier: 'workday-discovery', source: 'workday', url: 'https://x.wd1.myworkdayjobs.com/X' }), []);
  assert.deepEqual(atsBoardsFromOpenJobs({ tier: 'glassdoor', source: 'glassdoor', url: '' }), []);
  assert.deepEqual(atsBoardsFromOpenJobs({ miss: true, tier: 'search' }), []);
  assert.deepEqual(atsBoardsFromOpenJobs({ tier: 'direct-token', source: 'greenhouse', url: 'https://boards.greenhouse.io/stripe' }), [{ platform: 'greenhouse', token: 'stripe' }]);
  // A failed tier, or a source found before the direct-slug step, says nothing.
  assert.equal(atsBoardsFromOpenJobs({ tier: 'glassdoor', higherTierFailed: true }), null);
  assert.equal(atsBoardsFromOpenJobs({ tier: 'own-tenant', source: 'workday' }), null);
  assert.equal(atsBoardsFromOpenJobs(null), null);
});
