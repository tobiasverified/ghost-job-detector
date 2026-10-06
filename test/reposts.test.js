import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MemoryCache } from '../lib/server/cache.js';
import { buildGhostScore } from '../lib/server/score.js';
import { scoreRating } from '../lib/server/reviews.js';
import {
  ATS_REPOST_SCORE,
  detectReposts,
  locationsMatch,
  matchReposts,
  normalizeLocation,
  parsePostedAgeDays,
  REPOST_SCORE,
  repostCacheKey,
  repostQuery,
  titlesMatch
} from '../lib/server/reposts.js';

const NOW = new Date('2026-09-27T00:00:00Z');
const JOB = {
  title: 'Software Engineer',
  company: 'Axon',
  url: 'https://www.linkedin.com/jobs/view/software-engineer-at-axon-4472040782',
  location: 'Seattle, WA',
  platform: 'LINKEDIN',
  jobId: '4472040782'
};

function listing(id, when = '2 weeks ago') {
  return {
    title: 'Software Engineer at Axon',
    snippet: `Axon · Greater Seattle Area · Posted ${when}.`,
    url: `https://www.linkedin.com/jobs/view/software-engineer-at-axon-${id}`
  };
}

test('a company prefix on the city is not repeated in the repost query', () => {
  const job = {
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    location: 'T-Mobile New York, NY',
    locationNormalized: 'T-Mobile New York, New York',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888'
  };

  assert.equal(repostQuery(job), 'Senior Data Science Engineer T-Mobile New York, New York');
  assert.equal(
    repostCacheKey(job),
    'linkedin_repost_v3_t-mobile_senior-data-science-engineer_new-york-new-york'
  );
});

test('seattle location variants normalize and still match', () => {
  assert.equal(normalizeLocation('Seattle, WA'), 'Seattle, Washington');
  assert.equal(normalizeLocation('Greater Seattle Area'), 'Seattle');
  assert.equal(normalizeLocation('Remote'), 'Remote');
  assert.equal(locationsMatch('Seattle, WA', 'Greater Seattle Area'), true);
  assert.equal(locationsMatch('Greater Seattle Area', 'Seattle'), true);
  assert.equal(locationsMatch('Seattle, WA', 'Portland, OR'), false);
  assert.equal(parsePostedAgeDays('Posted 8 weeks ago'), 56);
});

test('one other linkedin posting of the same role scores 40', async () => {
  const two = await detectReposts(JOB, {
    now: NOW,
    webSearch: async () => [listing('111'), listing('222')]
  });
  const one = await detectReposts(JOB, {
    now: NOW,
    webSearch: async () => [listing('111', '8 weeks ago')]
  });

  assert.equal(two.score, 40);
  assert.equal(two.count, 2);
  assert.equal(one.score, 40);
  assert.equal(one.count, 1);
  assert.equal(one.matches[0].url.endsWith('-111'), true);
});

test('a hiring-in-city title matches the role, and the search is unquoted', () => {
  assert.equal(titlesMatch(
    'Senior Data Science Engineer',
    'T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn'
  ), true);
  assert.equal(repostQuery({
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    location: 'New York, NY'
  }), 'Senior Data Science Engineer T-Mobile New York, New York');
  assert.equal(repostQuery({
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    location: 'New York, NY'
  }).includes('site:'), false);
});

test('a greenhouse posting older than 7 days scores 25 and skips search', async () => {
  let searches = 0;
  const result = await detectReposts(JOB, {
    now: NOW,
    fetch: async (url) => {
      if (String(url).includes('boards-api.greenhouse.io')) {
        return {
          ok: true,
          json: async () => ({
            jobs: [{
              title: 'Software Engineer',
              updated_at: '2026-09-01T00:00:00Z',
              location: { name: 'Greater Seattle Area' },
              absolute_url: 'https://boards.greenhouse.io/axon/jobs/1'
            }]
          })
        };
      }

      return { ok: false, status: 404, json: async () => ({}) };
    },
    webSearch: async () => {
      searches += 1;
      return [listing('111'), listing('222')];
    }
  });

  assert.equal(result.score, 25);
  assert.equal(result.ageDays, 26);
  assert.equal(searches, 0);
});

test('a recent greenhouse posting falls through to linkedin matches', async () => {
  const result = await detectReposts(JOB, {
    now: NOW,
    fetch: async (url) => {
      if (String(url).includes('boards-api.greenhouse.io')) {
        return {
          ok: true,
          json: async () => ({
            jobs: [{
              title: 'Software Engineer',
              updated_at: '2026-09-26T00:00:00Z',
              location: { name: 'Seattle, WA' }
            }]
          })
        };
      }

      return { ok: false, status: 404, json: async () => ({}) };
    },
    webSearch: async () => [listing('111'), listing('222')]
  });

  assert.equal(result.score, 40);
});

test('a Workday job counts a LinkedIn repost only when two listings match', () => {
  const job = {
    title: 'AI Operations Engineer',
    company: 'Argonne',
    location: 'Lemont, IL',
    locationNormalized: 'Lemont, Illinois',
    platform: 'WORKDAY',
    url: 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers/details/AI-Operations-Engineer_423470'
  };
  const linkedIn = (id) => ({
    title: 'AI Operations Engineer at Argonne National Laboratory',
    snippet: 'Argonne National Laboratory · Lemont, IL',
    url: `https://www.linkedin.com/jobs/view/ai-operations-engineer-at-argonne-national-laboratory-${id}`
  });
  const one = matchReposts(job, [linkedIn('4472834013')]);
  const two = matchReposts(job, [linkedIn('4472834013'), linkedIn('4400000001')]);

  assert.equal(one.score, 0);
  assert.equal(one.count, 0);
  assert.equal(one.matches.length, 0);
  assert.match(one.detail, /No other LinkedIn posting matched/);
  assert.equal(two.score, REPOST_SCORE);
  assert.equal(two.count, 2);
  assert.equal(two.matches.length, 2);
});

test('a cached single LinkedIn match does not score a Workday job', async () => {
  const cache = new MemoryCache();
  const job = {
    title: 'AI Operations Engineer',
    company: 'Argonne',
    location: 'Lemont, IL',
    locationNormalized: 'Lemont, Illinois',
    platform: 'WORKDAY',
    url: 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers/details/AI-Operations-Engineer_423470'
  };

  await cache.set(repostCacheKey(job), {
    score: 40,
    count: 1,
    available: true,
    unavailable: false,
    matches: [{
      url: 'https://www.linkedin.com/jobs/view/ai-operations-engineer-at-argonne-national-laboratory-4472834013',
      dateLabel: 'Date not shown'
    }]
  }, 60_000, NOW);

  const detected = await detectReposts(job, {
    now: NOW,
    cache,
    webSearch: async () => {
      throw new Error('a stored syndication should be dropped without searching');
    }
  });

  assert.equal(detected.score, 0);
  assert.equal(detected.count, 0);
  assert.equal(detected.matches.length, 0);
});

test('other cities stay unmatched when the title overlap is looser', () => {
  const job = {
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    location: 'New York, NY',
    locationNormalized: 'New York, New York',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888',
    jobId: '4474577888'
  };
  const older = {
    title: 'T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn',
    snippet: 'At T-Mobile Advertising Solutions, we are building privacy-first advertising products.',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631'
  };
  const philadelphia = {
    title: 'Senior Data Science Engineer at T-Mobile - LinkedIn Jobs',
    snippet: 'Apply for Senior Data Science Engineer at T-Mobile in Philadelphia, PA. Full-time Mid-Senior level role.',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474594159'
  };
  const bellevue = {
    title: 'T-Mobile hiring Senior Data Science Engineer in Bellevue, WA | LinkedIn',
    snippet: 'We are seeking a creative, and curious Senior Data Science Software Engineer to join our team.',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474594161'
  };

  assert.equal(locationsMatch(job.locationNormalized, `${philadelphia.title} ${philadelphia.snippet}`), false);
  assert.equal(locationsMatch(job.locationNormalized, `${bellevue.title} ${bellevue.snippet}`), false);
  assert.equal(locationsMatch(job.locationNormalized, `${older.title} ${older.snippet}`), true);

  const detected = matchReposts(job, [older, philadelphia, bellevue]);
  assert.equal(detected.count, 1);
  assert.equal(detected.matches[0].url.includes('4460918631'), true);
  assert.equal(detected.matches.some((match) => /4474594159|4474594161/.test(match.url)), false);
});

test('the current posting is excluded under every url form, including search results', () => {
  const earlier = {
    title: 'T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn',
    snippet: 'At T-Mobile Advertising Solutions, we are building privacy-first advertising products.',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631'
  };
  const selfForms = [
    'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888',
    'https://www.linkedin.com/jobs/view/4474577888/',
    'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888?trk=public_jobs'
  ];
  const pages = [
    { url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888', jobId: '' },
    { url: 'https://www.linkedin.com/jobs/view/4474577888', jobId: '' },
    { url: 'https://www.linkedin.com/jobs/search-results/?keywords=Senior%20Data%20Science%20Engineer&currentJobId=4474577888', jobId: '' },
    { url: 'https://www.linkedin.com/jobs/search?currentJobId=4474577888', jobId: '4474577888' }
  ];

  for (const page of pages) {
    for (const selfUrl of selfForms) {
      const job = {
        title: 'Senior Data Science Engineer',
        company: 'T-Mobile',
        location: 'New York, NY',
        locationNormalized: 'New York, New York',
        url: page.url,
        jobId: page.jobId
      };
      const self = {
        title: 'Senior Data Science Engineer at T-Mobile — New York, NY - LinkedIn',
        snippet: 'T-Mobile · New York, NY',
        url: selfUrl
      };
      const detected = matchReposts(job, [self, earlier]);
      const alone = matchReposts(job, [self]);

      assert.equal(detected.score, 40, page.url);
      assert.equal(detected.count, 1, selfUrl);
      assert.equal(detected.matches.length, 1);
      assert.equal(detected.matches[0].url.includes('4460918631'), true);
      assert.equal(alone.score, 0, page.url);
      assert.equal(alone.count, 0);
      assert.equal(alone.matches.length, 0);
      assert.match(alone.detail, /No other LinkedIn posting matched/);
    }
  }

  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  const row = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: true, score: 0 },
    { unavailable: false, score: 0 },
    {
      score: 40,
      count: 2,
      available: true,
      unavailable: false,
      jobId: '4474577888',
      url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4474577888',
      matches: [
        { url: selfForms[0], dateLabel: 'Date not shown' },
        { url: earlier.url, dateLabel: '4 weeks ago' }
      ]
    }
  ).find((item) => item.label === 'Reposts');
  const only = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: false },
    { unavailable: false, score: 0 },
    {
      score: 40,
      count: 1,
      available: true,
      unavailable: false,
      jobId: '4474577888',
      url: 'https://www.linkedin.com/jobs/view/4474577888',
      matches: [{ url: selfForms[1], dateLabel: 'Date not shown' }]
    }
  ).find((item) => item.label === 'Reposts');

  assert.equal(row.value, '1 other posting');
  assert.equal(row.detail, '1 LinkedIn posting matches this title, company, and location.');
  assert.equal(row.entries.length, 1);
  assert.equal(row.entries[0].href, earlier.url);
  assert.equal(only.value, 'No duplicate found');
  assert.equal(only.entries, undefined);
});

test('a stored self-match is dropped and a lone self-match scores 0', async () => {
  const cache = new MemoryCache();
  const job = {
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    location: 'New York, NY',
    locationNormalized: 'New York, New York',
    url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4474577888',
    jobId: ''
  };
  await cache.set(repostCacheKey(job), {
    score: 40,
    count: 2,
    available: true,
    unavailable: false,
    matches: [
      { url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888', dateLabel: 'Date not shown' },
      { url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631', dateLabel: '4 weeks ago' }
    ]
  }, 60_000, NOW);
  const detected = await detectReposts(job, {
    now: NOW,
    cache,
    webSearch: async () => {
      throw new Error('stored matches should be filtered without searching');
    }
  });
  const onlySelf = matchReposts(job, [{
    title: 'Senior Data Science Engineer at T-Mobile — New York, NY - LinkedIn',
    snippet: 'T-Mobile · New York, NY',
    url: 'https://www.linkedin.com/jobs/view/4474577888'
  }]);

  assert.equal(detected.score, 40);
  assert.equal(detected.count, 1);
  assert.equal(detected.matches[0].url.includes('4460918631'), true);
  assert.equal(onlySelf.score, 0);
  assert.equal(onlySelf.matches.length, 0);
});

test('portland and the current job id do not become two matches', async () => {
  const result = await detectReposts(JOB, {
    now: NOW,
    webSearch: async () => [
      listing('4472040782'),
      {
        title: 'Software Engineer at Axon',
        snippet: 'Axon · Portland, OR · Posted 2 days ago.',
        url: 'https://www.linkedin.com/jobs/view/software-engineer-at-axon-999'
      }
    ]
  });

  assert.equal(result.score, 0);
});

test('repost results cache for 24 hours under the linkedin key', async () => {
  let calls = 0;
  const cache = new MemoryCache();
  const deps = {
    now: NOW,
    cache,
    webSearch: async () => {
      calls += 1;
      return [];
    }
  };

  await detectReposts(JOB, deps);
  await detectReposts(JOB, deps);

  assert.equal(calls, 1);
  assert.equal(repostCacheKey(JOB), 'linkedin_repost_v3_axon_software-engineer_seattle-washington');
});

test('a stored confirmed duplicate is rescored at the current weight', async () => {
  const cache = new MemoryCache();
  const job = {
    ...JOB,
    location: 'New York, NY',
    locationNormalized: 'New York, New York'
  };
  await cache.set(repostCacheKey(job), {
    score: 15,
    count: 1,
    available: true,
    unavailable: false,
    matches: [{ url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631' }]
  }, 60_000, NOW);
  const detected = await detectReposts(job, {
    now: NOW,
    cache,
    webSearch: async () => {
      throw new Error('stored match should be rescored without searching');
    }
  });

  assert.equal(detected.score, 40);
  assert.equal(detected.count, 1);
});

test('client search HTML is parsed even when a stored miss exists', async () => {
  const cache = new MemoryCache();
  const deps = {
    now: NOW,
    cache,
    webSearch: async () => {
      throw new Error('stored miss should not send an empty prefetch back to Tavily');
    }
  };
  await cache.set(repostCacheKey(JOB), {
    score: 0,
    count: 0,
    matches: [],
    available: true,
    unavailable: false,
    detail: 'No other LinkedIn posting matched this title, company, and location.'
  }, 60_000, NOW);
  const html = '<div class="result__body"><a class="result__a" href="https://www.linkedin.com/jobs/view/software-engineer-at-axon-999">Axon hiring Software Engineer in Seattle, WA | LinkedIn</a><a class="result__snippet" href="https://example.com">Axon in Seattle, WA.</a></div>';
  const detected = await detectReposts({ ...JOB, url: 'https://www.linkedin.com/jobs/view/software-engineer-at-axon-1' }, {
    ...deps,
    clientHtml: html
  });

  assert.equal(detected.count, 1);
  assert.equal(detected.matches[0].url.includes('999'), true);
});

test('the score widget ranks a confirmed duplicate above an old ATS posting', () => {
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  const found = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: false },
    { rating: null, unavailable: false, score: 0 },
    {
      score: 40,
      count: 2,
      available: true,
      unavailable: false,
      detail: '2 LinkedIn postings match.',
      matches: [
        { url: 'https://www.linkedin.com/jobs/view/1', dateLabel: 'Date not shown' },
        { url: 'https://www.linkedin.com/jobs/view/2', dateLabel: '4 weeks ago' }
      ]
    }
  ).find((factor) => factor.label === 'Reposts');
  const stale = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: false },
    { unavailable: false, score: 0 },
    { score: 25, count: 0, ageDays: 26, available: true, unavailable: false, detail: 'Greenhouse created this posting 26 days ago.' }
  ).find((factor) => factor.label === 'Reposts');

  const estimated = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    {
      available: true,
      score: 0,
      ratio: 0.18,
      estimated: true,
      label: '10,000 employees / 1,844 open roles = 0.18:1 ratio'
    },
    { rating: null, unavailable: false, score: 0 },
    { score: 0, available: true, unavailable: false }
  ).find((factor) => factor.label === 'Company size');

  assert.equal(found.value, '2 other postings');
  assert.equal(found.entries.length, 2);
  assert.equal(found.entries[0].text, 'date not shown');
  assert.equal(found.entries[1].text, '4 weeks ago');
  assert.equal(stale.value, 'Older than 7 days');
  const rejected = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    {
      available: true,
      score: 0,
      ratio: 0.2,
      label: '10,000+ employees / 1,984 open roles = 0.2:1 ratio',
      tooltip: 'Employee count is a lower-bound estimate from an open-ended size bucket.',
      employeeDiscrepancy: 'A conflicting headcount was set aside and is not included in this ratio.'
    },
    { rating: null, unavailable: false, score: 0 },
    { score: 0, available: true, unavailable: false }
  ).find((factor) => factor.label === 'Company size');

  const headcountOnly = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    {
      available: false,
      employees: 3001,
      openRoles: null,
      label: '3,001 employees · open roles unknown'
    },
    { rating: null, unavailable: false, score: 0 },
    { score: 0, available: true, unavailable: false }
  ).find((factor) => factor.label === 'Company size');

  const precise = sandbox.module.exports.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    {
      available: true,
      score: 0,
      ratio: 0.01,
      estimated: false,
      employeeSource: 'linkedin',
      label: '12,057 employees / 75 open roles = 0.01:1 ratio'
    },
    { rating: null, unavailable: false, score: 0 },
    { score: 0, available: true, unavailable: false }
  ).find((factor) => factor.label === 'Company size');

  assert.equal(estimated.value, '10,000 employees / 1,844 open roles = 0.18:1 ratio (estimated)');
  assert.equal(precise.value, '12,057 employees / 75 open roles = 0.01:1 ratio');
  assert.equal(headcountOnly.value, '3,001 employees · open roles unknown');
  assert.equal(headcountOnly.detail, '');
  assert.equal(rejected.detail, '');
  assert.match(rejected.tooltip, /lower-bound estimate/);
  assert.match(rejected.tooltip, /conflicting headcount was set aside/);
  assert.doesNotMatch(`${rejected.detail} ${rejected.tooltip}`, /Wikidata|2,681/);
  assert.equal(found.severity, 'danger');
  assert.equal(stale.severity, 'warning');
  assert.equal(sandbox.module.exports.calculateGhostScore({
    vagueness: { score: 0 },
    layoff: { detected: false, score: 0 },
    workforce: { score: 0 },
    reviews: { score: 0 },
    reposts: { score: 40 }
  }).components.reposts, 40);
  assert.equal(sandbox.module.exports.calculateGhostScore({
    vagueness: { score: 0 },
    layoff: { detected: false, score: 0 },
    workforce: { score: 0 },
    reviews: { score: 0 },
    reposts: { score: 80 }
  }).components.reposts, 40);
});

test('job-id ages estimate a middle posting and stay quiet without a range', () => {
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  const api = sandbox.module.exports;
  const now = Date.parse('2026-10-04T05:00:00Z');
  const recent = '4474577888';
  const older = '4460918631';
  const middle = String(Math.round((Number(recent) + Number(older)) / 2));
  const pairs = api.rememberJobAge(
    api.rememberJobAge([], recent, '5 hours ago', now),
    older,
    '4 weeks ago',
    now
  );
  const earlier = 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631';
  const row = api.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: true, score: 0 },
    { rating: 3.6, unavailable: false, score: 4 },
    {
      score: 40,
      count: 3,
      now,
      idDates: pairs,
      available: true,
      unavailable: false,
      dates: ['Date not shown', 'Date not shown'],
      detail: 'ignored',
      matches: [
        { url: `https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-${middle}`, dateLabel: 'Date not shown' },
        { url: earlier, dateLabel: '4 weeks ago' }
      ]
    }
  ).find((item) => item.label === 'Reposts');
  const uncalibrated = api.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: false },
    { unavailable: false, score: 0 },
    {
      score: 40,
      count: 2,
      now,
      idDates: [],
      available: true,
      unavailable: false,
      matches: [{ url: earlier, dateLabel: 'Date not shown' }]
    }
  ).find((item) => item.label === 'Reposts');
  const none = api.buildFactors(
    { score: 0, label: 'Clear' },
    { detected: false, unavailable: false, score: 0 },
    { available: false },
    { unavailable: false, score: 0 },
    { score: 0, count: 0, available: true, unavailable: false }
  ).find((item) => item.label === 'Reposts');

  assert.equal(api.estimateEarlierAge(middle, pairs, now), 'about 2 weeks earlier (estimated)');
  assert.equal(api.estimateEarlierAge('1000000000', pairs, now), 'date not shown');
  assert.equal(row.value, '2 other postings');
  assert.equal(row.detail, '2 LinkedIn postings match this title, company, and location.');
  assert.equal(row.entries.length, 2);
  assert.equal(row.entries[0].text, 'about 2 weeks earlier (estimated)');
  assert.equal(row.entries[0].href.endsWith(middle), true);
  assert.equal(row.entries[0].linkLabel, 'source');
  assert.match(row.entries[0].title, /may have been removed/);
  assert.equal(row.entries[1].text, '4 weeks ago');
  assert.equal(row.entries[1].href, earlier);
  assert.equal(uncalibrated.value, '1 other posting');
  assert.equal(uncalibrated.entries[0].text, 'date not shown');
  assert.equal(uncalibrated.entries[0].href, earlier);
  assert.equal(none.value, 'No duplicate found');
});

test('a confirmed T-Mobile duplicate alone lands in Possible, not Likely', () => {
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  const reviewScore = scoreRating(3.6);
  const reposts = {
    score: REPOST_SCORE,
    count: 2,
    available: true,
    unavailable: false,
    detail: '2 LinkedIn postings match this title, company, and location.',
    matches: [
      { url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631' },
      { url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888' }
    ]
  };
  const factors = {
    vagueness: { score: 0, label: 'Clear' },
    layoff: { detected: false, unavailable: false, score: 0 },
    workforce: { available: true, score: 0, ratio: 0.07, employees: 38000, openRoles: 2743 },
    reviews: { rating: 3.6, unavailable: false, score: reviewScore, platform: 'Glassdoor' },
    reposts
  };
  const shown = sandbox.module.exports.calculateGhostScore({
    vagueness: factors.vagueness,
    layoff: factors.layoff,
    workforce: factors.workforce,
    reviews: factors.reviews,
    reposts
  });
  const stored = buildGhostScore({
    vagueness: factors.vagueness,
    layoffs: factors.layoff,
    hiringRatio: factors.workforce,
    reviews: factors.reviews,
    reposts
  });

  assert.equal(REPOST_SCORE, 40);
  assert.equal(ATS_REPOST_SCORE, 25);
  assert.ok(REPOST_SCORE > ATS_REPOST_SCORE);
  assert.equal(reviewScore, 4);
  assert.equal(shown.components.reposts, 40);
  assert.equal(shown.score, 44);
  assert.equal(stored.ghostScore, 44);
  assert.equal(shown.label, 'Ghost Job: Possible');
  assert.ok(shown.score >= 35 && shown.score <= 45);
  assert.ok(shown.score < 50);

  const withLayoff = sandbox.module.exports.calculateGhostScore({
    vagueness: factors.vagueness,
    layoff: { detected: true, score: 25 },
    workforce: factors.workforce,
    reviews: factors.reviews,
    reposts
  });

  assert.ok(withLayoff.score >= 50);
  assert.equal(withLayoff.label, 'Ghost Job: Likely');
});
