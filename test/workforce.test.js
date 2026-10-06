import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MemoryCache } from '../lib/server/cache.js';
import { analyzeJobPosting } from '../lib/server/analyze.js';
import {
  detectWorkforce,
  findCompanyWorkforce,
  linkedinCompanySlugs,
  parseEmployeeCount,
  parseEmployeeSnippet,
  parseOpenRoles,
  pickWorkforce,
  readWorkforce,
  scoreHiringRatio
} from '../lib/server/workforce.js';

const NOW = new Date('2026-09-26T12:00:00Z');

test('company names normalize to the same LinkedIn slug', () => {
  assert.deepEqual(linkedinCompanySlugs('U.S. Fusion Energy'), ['us-fusion-energy']);
  assert.deepEqual(linkedinCompanySlugs('Tesla, Inc.'), ['tesla']);
  assert.deepEqual(linkedinCompanySlugs('Tesla Inc.'), ['tesla']);
  assert.deepEqual(linkedinCompanySlugs('Tesla'), ['tesla']);
  assert.deepEqual(linkedinCompanySlugs('Slalom LLC'), ['slalom']);
  assert.deepEqual(linkedinCompanySlugs('Slalom Consulting'), ['slalom-consulting', 'slalom']);
  assert.deepEqual(linkedinCompanySlugs('AMLI Residential'), ['amli-residential', 'amli']);
  assert.deepEqual(linkedinCompanySlugs('Hyundai Supernal'), ['hyundai-supernal']);
});

test('employee text accepts exact, range, minimum, and follower counts', () => {
  assert.equal(parseEmployeeCount('Widget Co has 3,452 followers.').employees, 3452);
  assert.equal(parseEmployeeCount('Range Co has 501-1,000 employees.').employees, 751);
  assert.equal(parseEmployeeCount('Mega Corp has 10,001+ employees.').employees, 10001);
  assert.equal(parseEmployeeCount('Acme has 500 employees.').employees, 500);
  assert.equal(parseOpenRoles('See all 2,000 jobs'), 2000);
});

test('a startup with 2,000 open jobs and 320 employees scores 25', () => {
  const result = readWorkforce(
    'Startup',
    'Startup has 320 employees. See all 2,000 jobs.'
  );

  assert.equal(result.available, true);
  assert.equal(result.employees, 320);
  assert.equal(result.openRoles, 2000);
  assert.equal(result.ratio, 6.25);
  assert.equal(result.score, 25);
  assert.equal(result.label, '320 employees / 2,000 open roles = 6.25:1 ratio');
  assert.match(result.tooltip, /3\+ positions per employee/);
});

test('a normal hiring ratio adds no points', () => {
  const result = scoreHiringRatio({ employees: 500, openRoles: 50 });

  assert.equal(result.available, true);
  assert.equal(result.ratio, 0.1);
  assert.equal(result.score, 0);
});

test('a ratio between 2 and 3 climbs from 20 toward 25', () => {
  const result = scoreHiringRatio({ employees: 100, openRoles: 250 });

  assert.equal(result.ratio, 2.5);
  assert.equal(result.score, 23);
});

test('a ratio just under 2 adds points instead of stopping at zero', () => {
  const justUnder = scoreHiringRatio({ employees: 293, openRoles: 557 });
  const atTwo = scoreHiringRatio({ employees: 100, openRoles: 200 });
  const approaching = scoreHiringRatio({ employees: 100, openRoles: 180 });

  assert.equal(justUnder.ratio, 1.9);
  assert.equal(justUnder.score, 16);
  assert.equal(atTwo.ratio, 2);
  assert.equal(atTwo.score, 20);
  assert.equal(approaching.ratio, 1.8);
  assert.equal(approaching.score, 12);
});

test('similar job searches do not replace the company open-role count', () => {
  const result = readWorkforce(
    'Pearson',
    'View all 14,972 employees. Pearson jobs 4,028 open jobs. Analyst jobs 694,057 open jobs.'
  );

  assert.equal(result.employees, 14972);
  assert.equal(result.openRoles, 4028);
  assert.equal(result.ratio, 0.27);
  assert.equal(result.score, 0);
});

test('a different company page is not used', () => {
  const result = readWorkforce(
    'Axon',
    'The Hive Company size 11-50 employees. Analyst jobs 694,057 open jobs.'
  );

  assert.equal(result.available, false);
});

test('a missing LinkedIn company page stays unavailable', () => {
  const result = readWorkforce('Axon', '<html><title>Sign in | LinkedIn</title><body>Join now</body></html>');

  assert.equal(result.available, false);
  assert.equal(result.score, 0);
  assert.equal(result.label, 'Unavailable');
});

test('workforce results are cached for seven days', async () => {
  const cache = new MemoryCache();
  let fetches = 0;
  const first = await detectWorkforce('Startup', {
    now: NOW,
    cache,
    clientHtml: {
      company: 'Startup has 320 employees.',
      companyJobs: 'Startup jobs. See all 2,000 jobs.'
    },
    fetchCompanyPage: async () => {
      fetches += 1;
      return '';
    }
  });
  const second = await detectWorkforce('Startup', {
    now: NOW,
    cache,
    fetchCompanyPage: async () => {
      fetches += 1;
      return '';
    }
  });

  assert.equal(first.cached, false);
  assert.equal(first.score, 25);
  assert.equal(second.cached, true);
  assert.equal(second.employees, 320);
  assert.equal(fetches, 0);
});

test('glassdoor details supply employees and open jobs from one lookup', async () => {
  let lookups = 0;
  const analysis = await analyzeJobPosting({
    title: 'Assistant Superintendent',
    company: 'AMLI Residential',
    description: 'Coordinate site work.',
    url: 'https://amli.wd5.myworkdayjobs.com/en-US/AMLI_Careers/details/Assistant-Superintendent_R-100982',
    platform: 'WORKDAY'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    ratioEnabled: true,
    searchNews: async () => [],
    fetchCache: async () => {
      throw new Error('offline');
    },
    webSearch: async () => [],
    lookupCompanyRating: async () => {
      lookups += 1;
      return {
        overall: 3.6,
        employees: 10000,
        employeeLabel: '10000+ Employees',
        openJobs: 1844,
        source: 'glassdoor',
        cached: false
      };
    }
  });

  assert.equal(lookups, 1);
  assert.equal(analysis.factors.reviews.source, 'rapidapi');
  assert.equal(analysis.factors.reviews.rating, 3.6);
  assert.equal(analysis.factors.hiringRatio.available, true);
  assert.equal(analysis.factors.hiringRatio.employees, 10000);
  assert.equal(analysis.factors.hiringRatio.openRoles, 1844);
  assert.equal(analysis.factors.hiringRatio.employeeSource, 'glassdoor');
  assert.equal(analysis.factors.hiringRatio.estimated, true);
  assert.equal(analysis.factors.hiringRatio.score, 0);
});

test('employee snippets accept range, plus, and single counts', () => {
  assert.deepEqual(parseEmployeeSnippet({
    title: 'Acme',
    snippet: 'Acme has 1,001-5,000 employees on LinkedIn.'
  }), { min: 1001, max: 5000, estimate: 3001, label: '1,001-5,000 employees' });
  assert.deepEqual(parseEmployeeSnippet({
    title: 'Acme',
    snippet: '10,000+ employees'
  }), { min: 10000, max: null, estimate: 10000, label: '10,000+ employees' });
  assert.deepEqual(parseEmployeeSnippet({
    title: 'Acme | 500 employees',
    snippet: ''
  }), { min: 500, max: 500, estimate: 500, label: '500 employees' });
  assert.equal(parseEmployeeSnippet({ title: 'Acme', snippet: '3,452 followers' }), null);
});

test('LinkedIn headcount outranks another snippet for the same company', () => {
  const picked = pickWorkforce([
    {
      title: 'Acme company size',
      snippet: 'Acme has 10,000+ employees.',
      url: 'https://example.com/acme'
    },
    {
      title: 'Acme | LinkedIn',
      snippet: 'Acme has 500 employees.',
      url: 'https://www.linkedin.com/company/acme'
    }
  ], 'Acme');

  assert.equal(picked.parsed.estimate, 500);
  assert.match(picked.result.url, /linkedin\.com/);
});

test('employee lookup falls back when the LinkedIn search has no count', async () => {
  const queries = [];
  const workforce = await findCompanyWorkforce('Acme', {
    webSearch: async (query) => {
      queries.push(query);

      if (query.includes('site:linkedin.com')) {
        return [];
      }

      return [
        {
          title: 'Acme company size',
          snippet: 'Acme has 500 employees.',
          url: 'https://example.com/acme'
        }
      ];
    }
  });

  assert.match(queries[0], /number of employees site:linkedin\.com/i);
  assert.match(queries[1], /employees company size/i);
  assert.equal(workforce.employees, 500);
  assert.equal(workforce.employeeSource, 'search');
  assert.equal(workforce.unavailable, false);
});

test('an employee search outage is unavailable', async () => {
  const workforce = await findCompanyWorkforce('Acme', {
    webSearch: async () => {
      throw new Error('blocked');
    }
  });

  assert.equal(workforce.employees, null);
  assert.equal(workforce.available, false);
  assert.equal(workforce.unavailable, true);
});

test('glassdoor company details are reused for 24 hours', async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const deps = {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: 'test-key' },
    searchNews: async () => [],
    fetchCache: async () => {
      throw new Error('offline');
    },
    webSearch: async () => [],
    fetch: async (url) => {
      if (!String(url).includes('/companies/details')) {
        return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
      }

      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ratings: { overall: 4.2 },
            size: '501 to 1,000 Employees',
            counts: { open_jobs: 10 }
          };
        }
      };
    }
  };
  const job = {
    title: 'Engineer',
    company: 'Acme',
    description: 'Build software for customers in the office with a specific stack.'
  };
  const first = await analyzeJobPosting(job, deps);
  const second = await analyzeJobPosting(job, deps);
  const expired = await analyzeJobPosting(job, {
    ...deps,
    now: new Date(NOW.getTime() + (25 * 60 * 60 * 1000))
  });

  assert.equal(calls, 2);
  assert.equal(first.factors.hiringRatio.label, '501 to 1,000 Employees');
  assert.equal(first.factors.hiringRatio.score, 0);
  assert.equal(first.factors.hiringRatio.openRoles, null);
  assert.equal(first.factors.reviews.rating, 4.2);
  assert.equal(second.factors.hiringRatio.label, '501 to 1,000 Employees');
  assert.equal(expired.factors.hiringRatio.label, '501 to 1,000 Employees');
});

test('Petfolk 1.9 reaches calculateGhostScore as the hiring-ratio component', () => {
  const logged = [];
  const sandbox = {
    console: {
      info(...args) {
        logged.push(args);
      }
    },
    module: { exports: {} }
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);

  const workforce = sandbox.module.exports.analyzeWorkforceSignal({
    employeeCountEstimate: 293,
    openJobsCount: 557
  });
  const score = sandbox.module.exports.calculateGhostScore({
    vagueness: { score: 0 },
    layoff: { detected: false, score: 0 },
    workforce,
    reviews: { score: 0 },
    reposts: { score: 0 }
  });
  const entry = logged.find((args) => args[0] === '[GHD] ghost score');

  assert.equal(workforce.ratio, 1.9);
  assert.equal(workforce.label, '293 employees / 557 open roles = 1.9:1 ratio');
  assert.equal(workforce.score, 16);
  assert.equal(score.components.hiringRatio, 0);
  assert.equal(score.score, 0);
  assert.equal(entry[1].ratio, 1.9);
  assert.equal(entry[1].workforceScore, 16);
  assert.equal(entry[1].hiringRatioComponent, 0);
  assert.equal(scoreHiringRatio({ employees: 293, openRoles: 557 }).score, 16);
});
