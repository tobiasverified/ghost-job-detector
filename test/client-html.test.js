import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { validateCompanyBody, validateJobBody } from '../lib/server/http.js';
import { detectReposts, repostCacheKey } from '../lib/server/reposts.js';
import { analysisCacheKey, reviewCacheKey } from '../lib/server/analyze.js';
import { workforceCacheKey } from '../lib/server/workforce.js';

const NOW = new Date('2026-10-07T00:00:00Z');
const REVIEW_HTML = '<div class="result__body"><a class="result__a" href="https://www.glassdoor.com/Reviews/Axon-Reviews-E1597674.htm">Axon Reviews</a><a class="result__snippet" href="https://example.com">Axon has an employee rating of 4.9 out of 5 stars, based on 9,999 company reviews.</a></div>';
const REPOST_HTML = '<div class="result__body"><a class="result__a" href="https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631">T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn</a><a class="result__snippet" href="https://example.com">T-Mobile Advertising Solutions in New York, NY.</a></div>';
const JOB = {
  title: 'Senior Data Science Engineer',
  company: 'T-Mobile',
  location: 'New York, NY',
  locationNormalized: 'New York, New York',
  url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888',
  platform: 'LINKEDIN'
};

test('only the repost prefetch is kept from client-supplied HTML', () => {
  const { value } = validateJobBody({
    title: 'Engineer',
    company: 'Axon',
    clientHtml: {
      reposts: REPOST_HTML,
      reviews: REVIEW_HTML,
      layoffs: '<div>Axon lays off 50%</div>',
      company: '<div>Axon 3 employees</div>',
      companyJobs: '<div>See all 9,000 jobs</div>',
      repostPages: [{ url: 'https://www.linkedin.com/jobs/view/1', html: '<div>x</div>' }]
    }
  });

  assert.deepEqual(Object.keys(value.clientHtml), ['reposts']);
  assert.equal(value.clientHtml.reposts.includes('4460918631'), true);
  assert.equal(validateCompanyBody({ company: 'Axon', clientHtml: { reviews: REVIEW_HTML } }).value.clientHtml, '');
});

test('repost matches parsed from client HTML answer the request but are never cached', async () => {
  const cache = new MemoryCache();
  let searches = 0;
  const deps = {
    now: NOW,
    cache,
    webSearch: async () => {
      searches += 1;
      return [];
    }
  };

  const fromClient = await detectReposts(JOB, { ...deps, clientHtml: REPOST_HTML });
  assert.equal(fromClient.count, 1);
  assert.equal(await cache.get(repostCacheKey(JOB), NOW), null);

  // The next user without that HTML gets the server's own search, not the
  // first user's parsed matches.
  const fromServer = await detectReposts(JOB, deps);
  assert.equal(searches, 1);
  assert.equal(fromServer.count, 0);
  assert.notEqual(await cache.get(repostCacheKey(JOB), NOW), null);
});

test('the on-page open-roles fields are part of the analysis cache key', () => {
  const base = { ...JOB, description: 'Build services.' };
  const plain = analysisCacheKey(base);
  const counted = analysisCacheKey({ ...base, openJobsCount: 40, openJobsPageUrl: 'https://www.linkedin.com/jobs/t-mobile-jobs', openJobsCompanyId: '123' });
  const forged = analysisCacheKey({ ...base, openJobsCount: 90000, openJobsPageUrl: 'https://www.linkedin.com/jobs/t-mobile-jobs', openJobsCompanyId: '123' });
  const allMatch = analysisCacheKey({ ...base, openJobsCount: 40, openJobsPageUrl: 'https://www.linkedin.com/jobs/t-mobile-jobs', openJobsCompanyId: '123', openJobsAllMatch: true });

  assert.match(plain, /^analyze:v29:.*:oj0$/);
  assert.notEqual(counted, plain);
  assert.notEqual(forged, counted);
  assert.notEqual(allMatch, counted);
  assert.equal(analysisCacheKey({ ...base, openJobsCount: 40, openJobsPageUrl: 'https://www.linkedin.com/jobs/t-mobile-jobs', openJobsCompanyId: '123' }), counted);
});

test('keys that could hold results built from client HTML are bumped', () => {
  assert.match(repostCacheKey(JOB), /^linkedin_repost_v5_/);
  assert.match(reviewCacheKey('Axon'), /^reviews:v12:/);
  assert.match(workforceCacheKey('Axon'), /^workforce:v2:/);
});
