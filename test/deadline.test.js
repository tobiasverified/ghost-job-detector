import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import {
  analyzeJobPosting,
  createDeadline,
  PARTIAL_ANALYSIS_TTL_MS,
  stopPaidCallsAfter
} from '../lib/server/analyze.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const DEADLINE_MS = 150;
const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

const JOB = {
  title: 'Analyst',
  company: 'Acme',
  description: 'You will build Python services with 5 years of experience. Salary $150,000. Specific duties are listed for each quarter.',
  url: 'https://www.linkedin.com/jobs/view/1',
  platform: 'LINKEDIN',
  deferReposts: true
};

const FIELDS = { website: 'https://acme.example', openJobs: 40, glassdoorSize: '10000+ Employees', overall: 4.2, reviewCount: 900 };
const PROFILE = { overall: 4.2, reviewCount: 900, employees: 50000, employeeLabel: '50,000', employeeSource: 'wikidata', openJobs: 40, website: 'https://acme.example', glassdoorSize: '10000+ Employees' };

function recordingCache() {
  const cache = new MemoryCache();
  const writes = [];
  const set = cache.set.bind(cache);
  cache.set = async (key, payload, ttlMs, now) => {
    writes.push({ key, payload, ttlMs });
    return set(key, payload, ttlMs, now);
  };
  return { cache, writes };
}

// Every source answers at once unless a test makes one slow or endless.
function deps({ cache = new MemoryCache(), lookup, layoffs, news, searches = [] } = {}) {
  const base = {
    now: NOW,
    cache,
    // NewsData is used by layoffs only, so it can hold layoffs alone.
    searchNews: async () => (news ? news() : []),
    webSearch: async (query) => {
      searches.push(query);
      return layoffs ? layoffs() : [];
    },
    askGroq: async () => 'NO',
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    lookupCompanyRating: lookup || (async (company, options) => {
      options.onGlassdoorFields?.(FIELDS);
      return PROFILE;
    })
  };
  return stopPaidCallsAfter(base, createDeadline(DEADLINE_MS));
}

test('layoffs unfinished at the deadline: unavailable, score withheld, partial', async () => {
  const started = Date.now();
  const analysis = await analyzeJobPosting(JOB, deps({ news: never }));

  assert.ok(Date.now() - started < DEADLINE_MS + 200, 'returns at the deadline');
  assert.equal(analysis.factors.layoffs.unavailable, true);
  assert.equal(analysis.factors.layoffs.timedOut, true);
  assert.equal(analysis.partial, true);
  assert.equal(analysis.scoreWithheld, true);
  assert.equal(analysis.ghostScore, null);
  assert.deepEqual(analysis.timedOut, ['layoffs']);
});

test('reviews unfinished at the deadline: unavailable, score withheld', async () => {
  const analysis = await analyzeJobPosting(JOB, deps({
    lookup: async () => never()
  }));

  assert.equal(analysis.factors.reviews.timedOut, true);
  assert.equal(analysis.factors.reviews.unavailable, true);
  assert.equal(analysis.ghostScore, null);
  assert.equal(analysis.partial, true);
});

test('open roles held past the deadline falls back to the floor and keeps the score', async () => {
  const { cache, writes } = recordingCache();
  const held = deps({ cache, layoffs: async () => [] });
  // Open roles reads the job-board APIs first; hold only those, so layoffs.fyi
  // and everything else still answer.
  const fetchImpl = held.fetch;
  held.fetch = async (url, init) => (/boards-api.greenhouse.io|api.lever.co|api.ashbyhq.com|jobs.lever.co|jobs.ashbyhq.com/.test(String(url)) ? never() : fetchImpl(url, init));

  const analysis = await analyzeJobPosting(JOB, held);
  const ratio = analysis.factors.hiringRatio;

  assert.equal(ratio.openRolesTimedOut, true);
  assert.equal(ratio.openJobsSource, 'glassdoor');
  assert.equal(ratio.openRoles, 40);
  assert.equal(ratio.score, 0);
  assert.equal(typeof analysis.ghostScore, 'number', 'the score still shows');
  assert.equal(analysis.scoreWithheld, undefined);
  assert.equal(analysis.partial, true);
  assert.equal(writes.some((item) => item.key.startsWith('open_jobs_')), false, 'no deadline floor in the open-roles cache');
  const saved = writes.find((item) => item.key.startsWith('analyze:'));
  assert.ok(saved, 'the partial analysis is cached');
  assert.ok(saved.ttlMs <= PARTIAL_ANALYSIS_TTL_MS);
});

test('headcount unfinished: the ratio is unscored and the score still shows', async () => {
  const analysis = await analyzeJobPosting(JOB, deps({
    layoffs: async () => [],
    lookup: async (company, options) => {
      // The Glassdoor rating is final; the headcount merge never finishes.
      options.onGlassdoorFields?.(FIELDS);
      return never();
    }
  }));

  assert.equal(analysis.factors.hiringRatio.headcountTimedOut, true);
  assert.equal(analysis.factors.hiringRatio.score, 0);
  assert.equal(analysis.factors.reviews.rating, 4.2);
  assert.equal(typeof analysis.ghostScore, 'number');
  assert.equal(analysis.partial, true);
});

test('after the deadline no new paid step starts', async () => {
  const searches = [];
  const held = deps({ searches, layoffs: async () => [] });
  await after(DEADLINE_MS + 20);

  await assert.rejects(() => held.webSearch('"Acme" jobs'), /DEADLINE_PASSED/);
  await assert.rejects(() => held.askGroq('prompt'), /DEADLINE_PASSED/);
  await assert.rejects(() => held.fetch('https://best-glassdoor-scraper-free-1000-calls.p.rapidapi.com/companies/details?company=Acme'), /DEADLINE_PASSED/);
  assert.deepEqual(searches, []);
  // Free reads are not blocked.
  const free = await held.fetch('https://boards-api.greenhouse.io/v1/boards/acme/jobs');
  assert.equal(free.status, 404);
});

test('a check that finishes in time is unchanged: full score, not partial, normal cache', async () => {
  const { cache, writes } = recordingCache();
  const analysis = await analyzeJobPosting(JOB, deps({ cache, layoffs: async () => [] }));

  assert.equal(analysis.partial, undefined);
  assert.equal(typeof analysis.ghostScore, 'number');
  const saved = writes.find((item) => item.key.startsWith('analyze:'));
  assert.ok(saved.ttlMs > PARTIAL_ANALYSIS_TTL_MS);
});

test('a retry within 5 minutes completes open roles instead of replaying the cached partial', async () => {
  const cache = new MemoryCache();
  const held = deps({ cache, layoffs: async () => [] });
  const fetchImpl = held.fetch;
  held.fetch = async (url, init) => (/boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com|jobs\.lever\.co|jobs\.ashbyhq\.com/.test(String(url)) ? never() : fetchImpl(url, init));
  const first = await analyzeJobPosting(JOB, held);
  assert.equal(first.partial, true);
  assert.equal(first.factors.hiringRatio.openRolesTimedOut, true);

  // One minute later the board answers.
  const retry = await analyzeJobPosting(JOB, {
    ...deps({ cache, layoffs: async () => [] }),
    now: new Date(NOW.getTime() + 60 * 1000),
    fetch: async (url) => (String(url).startsWith('https://boards-api.greenhouse.io/v1/boards/acme')
      ? (String(url).endsWith('/jobs')
        ? { ok: true, status: 200, json: async () => ({ jobs: Array.from({ length: 12 }, (_, id) => ({ id })) }) }
        : { ok: true, status: 200, json: async () => ({ name: 'Acme' }) })
      : { ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.equal(retry.cached, true, 'the retry used the cached analysis for the finished factors');
  assert.equal(retry.partial, undefined);
  assert.equal(retry.factors.hiringRatio.openRolesTimedOut, undefined);
  assert.equal(retry.factors.hiringRatio.openRoles, 12);
  assert.equal(retry.factors.hiringRatio.openJobsSource, 'greenhouse');
});

test('a retry within 5 minutes completes reviews and shows the score', async () => {
  const cache = new MemoryCache();
  const first = await analyzeJobPosting(JOB, deps({ cache, layoffs: async () => [], lookup: async () => never() }));
  assert.equal(first.scoreWithheld, true);

  const retry = await analyzeJobPosting(JOB, { ...deps({ cache, layoffs: async () => [] }), now: new Date(NOW.getTime() + 60 * 1000) });
  assert.equal(retry.factors.reviews.rating, 4.2);
  assert.equal(retry.scoreWithheld, undefined);
  assert.equal(typeof retry.ghostScore, 'number');
  assert.equal(retry.partial, undefined);
});
