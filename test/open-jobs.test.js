import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { resolveWorkforce } from '../lib/server/analyze.js';
import { boardNameVerdict, boardTokenVerdict, parseAtsBoard, parseWorkdayBoard, resolveOpenJobCount, workdaySiteMatchesCompany } from '../lib/server/open-jobs.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const UMIAMI_URL = 'https://umiami.wd1.myworkdayjobs.com/en-US/UMCareerStaff/details/Desktop-Support-Technician_R100101533?jobFamilyGroup=12a3cb6c735c10343a4fee7b7cc4da55';

function umiamiFixture(name) {
  return readFileSync(new URL(`./fixtures/umiami/${name}`, import.meta.url), 'utf8');
}

test('an on-page LinkedIn count is used before any career-site lookup', async () => {
  let searches = 0;
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    onPageCount: 18,
    jobUrl: 'https://www.linkedin.com/jobs/view/1',
    openJobsPageUrl: 'https://www.linkedin.com/jobs/tko-group-holdings-jobs-worldwide'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => {
      searches += 1;
      return [];
    }
  });

  assert.equal(counted.count, 18);
  assert.equal(counted.source, 'page');
  assert.equal(searches, 0);
});

test('a LinkedIn keyword search count is not used as the company open-roles total', async () => {
  let searches = 0;
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    onPageCount: 2,
    jobUrl: 'https://www.linkedin.com/jobs/view/1',
    openJobsPageUrl: 'https://www.linkedin.com/jobs/search?keywords=AI%20Engineer&currentJobId=1',
    openJobsAllMatch: true
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => {
      searches += 1;
      return [];
    }
  });

  assert.notEqual(counted?.source, 'page');
  assert.notEqual(counted?.count, 2);
  assert.ok(searches > 0);
});

test('a company filter that matches this company keeps the on-page count', async () => {
  let searches = 0;
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    onPageCount: 75,
    openJobsPageUrl: 'https://www.linkedin.com/jobs/search?keywords=product&f_C=1441',
    openJobsCompanyId: '1441'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => {
      searches += 1;
      return [];
    }
  });

  assert.equal(counted.count, 75);
  assert.equal(counted.source, 'page');
  assert.equal(searches, 0);
});

test('a search with no keyword and only this company on the page keeps the count', async () => {
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    onPageCount: 12,
    openJobsPageUrl: 'https://www.linkedin.com/jobs/search?currentJobId=1',
    openJobsAllMatch: true
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => []
  });

  assert.equal(counted.count, 12);
  assert.equal(counted.source, 'page');
});

test('a Greenhouse board on the company site is counted from the public jobs API', async () => {
  const urls = [];
  let searches = 0;
  const counted = await resolveOpenJobCount('Acme', {
    website: 'https://boards.greenhouse.io/acme'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => {
      searches += 1;
      throw new Error('workday discovery should not run');
    },
    fetch: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        async json() {
          return { jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] };
        }
      };
    }
  });

  assert.equal(parseAtsBoard('https://boards.greenhouse.io/acme').platform, 'greenhouse');
  assert.equal(counted.count, 3);
  assert.equal(counted.source, 'greenhouse');
  assert.equal(counted.estimated, false);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs$/);
  assert.equal(searches, 0);
});

test('a filtered UMiami Workday listing is not the company total', async () => {
  const calls = [];
  const unfiltered = JSON.parse(umiamiFixture('board.cxs-jobs.json'));
  const counted = await resolveOpenJobCount('University of Miami', {
    platform: 'WORKDAY',
    hostname: 'umiami.wd1.myworkdayjobs.com',
    onPageCount: 22,
    jobUrl: UMIAMI_URL,
    profile: Promise.resolve({ openJobs: 2083 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => [],
    fetch: async (url, options = {}) => {
      const href = String(url);
      const method = options.method || 'GET';
      calls.push({ url: href, method, body: options.body || '' });

      if (href.includes('/wday/cxs/')) {
        const body = JSON.parse(options.body);
        const filtered = Object.keys(body.appliedFacets || {}).length > 0 || String(body.searchText || '').trim();
        return {
          ok: true,
          async json() {
            return filtered ? { total: 56, jobPostings: [] } : unfiltered;
          }
        };
      }

      return { ok: true, async text() { return umiamiFixture('board.html'); } };
    }
  });
  const cxs = calls.filter((call) => call.url.includes('/wday/cxs/'));

  assert.equal(cxs.length, 1);
  assert.equal(cxs[0].method, 'POST');
  assert.equal(cxs[0].url, 'https://umiami.wd1.myworkdayjobs.com/wday/cxs/umiami/UMCareerStaff/jobs');
  assert.deepEqual(JSON.parse(cxs[0].body), {
    appliedFacets: {},
    limit: 20,
    offset: 0,
    searchText: ''
  });
  assert.equal(counted.count, unfiltered.total);
  assert.equal(counted.source, 'workday');
  assert.notEqual(counted.count, 22);
  assert.notEqual(counted.count, 56);
  assert.notEqual(counted.count, 2083);
});

test('a Workday tenant is counted from the first CXS page total after the org name matches', async () => {
  const calls = [];
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    website: 'https://tkogrp.com'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      assert.match(query, /site:myworkdayjobs\.com TKO Group Holdings/);
      return [{
        title: 'TKO Group Holdings Careers',
        url: 'https://wwe.wd5.myworkdayjobs.com/en-US/wwe/job/Stamford/Director_R1',
        snippet: 'Careers'
      }];
    },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body || '' });

      if (String(url).includes('/wday/cxs/')) {
        assert.equal(JSON.parse(options.body).offset, 0);
        return {
          ok: true,
          async json() {
            return { total: 842, jobPostings: [{ title: 'Director' }] };
          }
        };
      }

      return {
        ok: true,
        async text() {
          return '<html><title>TKO Group Holdings Careers</title><body>Open roles</body></html>';
        }
      };
    }
  });
  const workforce = resolveWorkforce({
    employees: 3001,
    employeeLabel: '3,001',
    openJobs: counted.count,
    openJobsSource: counted.source,
    openJobsEstimated: counted.estimated
  });

  assert.equal(parseWorkdayBoard('https://wwe.wd5.myworkdayjobs.com/en-US/wwe/job/Director_R1').site, 'wwe');
  assert.equal(counted.count, 842);
  assert.equal(counted.source, 'workday');
  assert.equal(counted.estimated, false);
  assert.equal(calls.filter((call) => call.url.includes('/wday/cxs/')).length, 1);
  assert.equal(workforce.openRoles, 842);
  assert.equal(workforce.available, true);
  assert.doesNotMatch(workforce.label, /estimated/i);
});

test('a Workday page for a different organization is rejected and search cites an estimate', async () => {
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    glassdoorOpenJobs: 0
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      if (query.includes('site:myworkdayjobs.com')) {
        return [{
          title: 'WWE Careers',
          url: 'https://wwe.wd5.myworkdayjobs.com/en-US/wwe',
          snippet: 'WWE jobs'
        }];
      }

      return [{
        title: 'TKO Group Holdings careers',
        snippet: 'TKO Group Holdings has 40 open jobs across its brands.',
        url: 'https://example.com/tko-jobs'
      }];
    },
    fetch: async () => ({
      ok: true,
      async text() {
        return '<html><title>WWE Careers</title></html>';
      },
      async json() {
        throw new Error('CXS should not be read for a mismatched org');
      }
    }),
    askGroq: async () => 'Result 1 states 40 open jobs.'
  });
  const workforce = resolveWorkforce({
    employees: 3001,
    employeeLabel: '3,001',
    openJobs: counted.count,
    openJobsSource: counted.source,
    openJobsEstimated: counted.estimated,
    openJobsSourceUrl: counted.url
  });

  assert.equal(counted.count, 40);
  assert.equal(counted.source, 'search');
  assert.equal(counted.estimated, true);
  assert.equal(counted.url, 'https://example.com/tko-jobs');
  assert.match(workforce.label, /40 open roles \(estimated\)/);
  assert.match(workforce.detail, /Estimated from search: https:\/\/example\.com\/tko-jobs/);
});

test('a cited 2 is rejected when it is only a digit inside a larger count', async () => {
  const year = new Date().getFullYear();
  const snippet = `Alignerr has approximately 2,538 total employees. Alignerr had 7,732 active job postings in ${year}.`;
  const yearly = `Alignerr had 7,732 job postings in ${year}.`;
  const rejected = await resolveOpenJobCount('Alignerr', {
    glassdoorOpenJobs: 0
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => [{
      title: 'Alignerr employees',
      url: 'https://www.reveliolabs.com/companies/alignerr/employees',
      snippet
    }],
    fetch: async () => ({ ok: false, status: 404, async text() { return ''; }, async json() { return {}; } }),
    askGroq: async () => 'The number of open jobs is 2.'
  });
  const accepted = await resolveOpenJobCount('Alignerr', {
    glassdoorOpenJobs: 0
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => [{
      title: 'Alignerr employees',
      url: 'https://www.reveliolabs.com/companies/alignerr/employees',
      snippet
    }],
    fetch: async () => ({ ok: false, status: 404, async text() { return ''; }, async json() { return {}; } }),
    askGroq: async () => 'Result 1 states 7,732 active job postings.'
  });
  const yearTotal = await resolveOpenJobCount('Alignerr', {
    glassdoorOpenJobs: 0
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => [{
      title: 'Alignerr employees',
      url: 'https://www.reveliolabs.com/companies/alignerr/employees',
      snippet: yearly
    }],
    fetch: async () => ({ ok: false, status: 404, async text() { return ''; }, async json() { return {}; } }),
    askGroq: async () => 'Result 1 states 7,732 job postings.'
  });

  assert.equal(rejected, null);
  assert.equal(accepted.count, 7732);
  assert.equal(accepted.url, 'https://www.reveliolabs.com/companies/alignerr/employees');
  assert.equal(yearTotal, null);
});

test('a parent Workday tenant is accepted when the site slug is the company alias', async () => {
  for (const url of [
    'https://wwecorp.wd5.myworkdayjobs.com/TKO',
    'https://wwecorp.wd5.myworkdayjobs.com/en-US/TKO',
    'https://wwecorp.wd5.myworkdayjobs.com/tko'
  ]) {
    const site = parseWorkdayBoard(url).site;
    assert.match(site, /^tko$/i);
    assert.equal(workdaySiteMatchesCompany(site, 'TKO Group Holdings'), true);
  }

  assert.equal(workdaySiteMatchesCompany('wwe', 'TKO Group Holdings'), false);
  let groqCalls = 0;
  const calls = [];
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    glassdoorOpenJobs: 0
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => [{
      title: 'WWE Careers',
      url: 'https://wwecorp.wd5.myworkdayjobs.com/en-US/TKO',
      snippet: 'WWE jobs'
    }],
    fetch: async (url, options = {}) => {
      calls.push(String(url));

      if (!String(url).includes('/wday/cxs/')) {
        throw new Error('the site slug should verify the board without reading the page title');
      }

      assert.equal(JSON.parse(options.body).offset, 0);
      return {
        ok: true,
        async json() {
          return { total: 75, jobPostings: [{ title: 'Director' }] };
        }
      };
    },
    askGroq: async () => {
      groqCalls += 1;
      return 'Result 1 states 40 open jobs.';
    }
  });

  assert.equal(groqCalls, 0);
  assert.equal(counted.count, 75);
  assert.equal(counted.source, 'workday');
  assert.equal(counted.estimated, false);
  assert.equal(counted.url, 'https://wwecorp.wd5.myworkdayjobs.com/en-US/TKO');
  assert.deepEqual(calls, ['https://wwecorp.wd5.myworkdayjobs.com/wday/cxs/wwecorp/TKO/jobs']);
});

function workdayDiscoveryDeps(log) {
  return {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      log.push('search');
      assert.match(query, /site:myworkdayjobs\.com TKO Group Holdings/);
      return [{
        title: 'TKO Group Holdings Careers',
        url: 'https://wwe.wd5.myworkdayjobs.com/en-US/wwe/job/Stamford/Director_R1',
        snippet: 'Careers'
      }];
    },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('boards-api.greenhouse.io')) {
        log.push('greenhouse');
        return { ok: true, async json() { return { jobs: [{ id: 1 }, { id: 2 }] }; } };
      }

      if (href.includes('/wday/cxs/')) {
        log.push('workday');
        return { ok: true, async json() { return { total: 842, jobPostings: [{ title: 'Director' }] }; } };
      }

      return { ok: true, async text() { return '<html><title>TKO Group Holdings Careers</title></html>'; } };
    }
  };
}

test('Workday discovery starts before the company profile has finished', async () => {
  const log = [];
  let finishProfile;
  const profile = new Promise((resolve) => {
    finishProfile = resolve;
  });
  const counting = resolveOpenJobCount('TKO Group Holdings', { profile }, workdayDiscoveryDeps(log));

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(log.includes('search'), 'discovery should be running while the profile is pending');
  log.push('profile');
  finishProfile({ website: 'https://tkogrp.com', openJobs: 5 });

  const counted = await counting;
  assert.equal(counted.count, 842);
  assert.equal(counted.source, 'workday');
  assert.ok(log.indexOf('search') < log.indexOf('profile'));
});

test('a career board on the profile website still outranks a faster Workday discovery', async () => {
  const log = [];
  let finishProfile;
  const profile = new Promise((resolve) => {
    finishProfile = resolve;
  });
  const counting = resolveOpenJobCount('TKO Group Holdings', { profile }, workdayDiscoveryDeps(log));

  // Discovery finishes completely before the profile arrives.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(log.includes('workday'));
  finishProfile({ website: 'https://boards.greenhouse.io/tko', openJobs: 5 });

  const counted = await counting;
  assert.equal(counted.count, 2);
  assert.equal(counted.source, 'greenhouse');
});

test('Glassdoor open jobs from the profile are used only after discovery comes up empty', async () => {
  const counted = await resolveOpenJobCount('TKO Group Holdings', {
    profile: Promise.resolve({ website: 'https://tkogrp.com', openJobs: 17 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async () => [],
    fetch: async () => ({ ok: false, status: 404 })
  });

  assert.equal(counted.count, 17);
  assert.equal(counted.source, 'glassdoor');
});

// Spring Health as read live on 2026-10-02: Glassdoor counts.open_jobs was 5;
// its own careers board is Ashby board deaa6ad2-... with 67 listed jobs.
const SPRING_BOARD = 'deaa6ad2-d184-436b-b69e-17f761da1d94';

function boardSearchDeps({ results, pages = {}, greenhouse = {}, jobs = {}, searches = [] }) {
  return {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query, options = {}) => {
      searches.push({ query, options });
      return query.includes('site:myworkdayjobs.com') ? [] : results;
    },
    fetch: async (url) => {
      const href = String(url);
      const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

      if (href.startsWith('https://api.ashbyhq.com/posting-api/job-board/')) {
        const token = decodeURIComponent(href.split('/').pop());
        return json({ jobs: Array.from({ length: jobs[`ashby:${token}`] || 0 }, (_, id) => ({ id })) });
      }

      if (href.startsWith('https://boards-api.greenhouse.io/v1/boards/')) {
        const parts = href.replace('https://boards-api.greenhouse.io/v1/boards/', '').split('/');
        const token = decodeURIComponent(parts[0]);

        if (parts[1] === 'jobs') {
          return json({ jobs: Array.from({ length: jobs[`greenhouse:${token}`] || 0 }, (_, id) => ({ id })) });
        }

        return greenhouse[token] ? json({ name: greenhouse[token] }) : { ok: false, status: 404 };
      }

      if (pages[href]) {
        return { ok: true, status: 200, text: async () => `<html><title>${pages[href]}</title></html>` };
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  };
}

test('Spring Health: the search-found Ashby board (67) is used instead of Glassdoor (5)', async () => {
  const searches = [];
  const counted = await resolveOpenJobCount('Spring Health', {
    profile: Promise.resolve({ website: 'https://www.springhealth.com/', openJobs: 5 })
  }, boardSearchDeps({
    searches,
    results: [{ title: 'Spring Health Jobs', url: `https://jobs.ashbyhq.com/${SPRING_BOARD}/3daaa470-0c6b-4c57-a793-d9abe54dbf11` }],
    pages: { [`https://jobs.ashbyhq.com/${SPRING_BOARD}`]: 'Spring Health Jobs' },
    jobs: { [`ashby:${SPRING_BOARD}`]: 67 }
  }));

  assert.equal(counted.count, 67);
  assert.equal(counted.source, 'ashby');
  assert.equal(counted.lowerBound, undefined);
  const boardSearch = searches.find((item) => !item.query.includes('myworkdayjobs'));
  assert.deepEqual(boardSearch.options.includeDomains, ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co']);
});

test('V1: a board whose own name is another organization is not counted', async () => {
  assert.equal(boardNameVerdict('Spring Health', 'Lyra Health').reason, 'different organization');

  // The address passes S2, so only the board's own name can reject it.
  const counted = await resolveOpenJobCount('Spring Health', {
    profile: Promise.resolve({ openJobs: 5 })
  }, boardSearchDeps({
    results: [{ title: 'Spring Health jobs', url: 'https://boards.greenhouse.io/springhealth' }],
    greenhouse: { springhealth: 'Lyra Health' },
    jobs: { 'greenhouse:springhealth': 200 }
  }));

  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.count, 5);
});

test('V2: a board whose name cannot be read is not counted', async () => {
  const counted = await resolveOpenJobCount('Spring Health', {
    profile: Promise.resolve({ openJobs: 5 })
  }, boardSearchDeps({
    results: [{ title: 'Jobs', url: `https://jobs.ashbyhq.com/${SPRING_BOARD}` }],
    jobs: { [`ashby:${SPRING_BOARD}`]: 67 }
  }));

  assert.equal(counted.source, 'glassdoor');
});

test('S1: a board named for part of the company is a sub-board and is not counted', async () => {
  assert.deepEqual(boardNameVerdict('Spring Health', 'Spring Health UK Jobs').extra, ['uk']);
  assert.equal(boardNameVerdict('Spring Health', 'Spring Health UK Jobs').reason, 'sub-board name');
  assert.equal(boardNameVerdict('Acme', 'Acme Clinical Careers').ok, false);
  assert.equal(boardNameVerdict('Palantir', 'Palantir Technologies').ok, true);
  assert.equal(boardNameVerdict('Spring Health', 'Spring Health Jobs').ok, true);

  const counted = await resolveOpenJobCount('Spring Health', {
    profile: Promise.resolve({ openJobs: 5 })
  }, boardSearchDeps({
    results: [{ title: 'Spring Health UK', url: 'https://boards.greenhouse.io/springhealth' }],
    greenhouse: { springhealth: 'Spring Health UK' },
    jobs: { 'greenhouse:springhealth': 9 }
  }));

  assert.equal(counted.source, 'glassdoor');
});

test('S2: a readable board address naming a region is not counted even with the right board name', async () => {
  assert.equal(boardTokenVerdict('Spring Health', 'springhealth').ok, true);
  assert.equal(boardTokenVerdict('Spring Health', 'spring-health').ok, true);
  assert.equal(boardTokenVerdict('Spring Health', 'springhealth-emea').ok, false);
  assert.equal(boardTokenVerdict('Spring Health', 'springhealth66').ok, true);
  assert.equal(boardTokenVerdict('Spring Health', 'charliehealth').ok, false);
  assert.equal(boardTokenVerdict('Spring Health', SPRING_BOARD).id, true);

  const counted = await resolveOpenJobCount('Spring Health', {
    profile: Promise.resolve({ openJobs: 5 })
  }, boardSearchDeps({
    results: [{ title: 'Spring Health', url: 'https://boards.greenhouse.io/springhealth-emea' }],
    greenhouse: { 'springhealth-emea': 'Spring Health' },
    jobs: { 'greenhouse:springhealth-emea': 12 }
  }));

  assert.equal(counted.source, 'glassdoor');
});

test('S3: two verified boards make the larger one a lower bound', async () => {
  const counted = await resolveOpenJobCount('Spring Health', {
    profile: Promise.resolve({ openJobs: 5 })
  }, boardSearchDeps({
    results: [
      { title: 'Spring Health Jobs', url: `https://jobs.ashbyhq.com/${SPRING_BOARD}` },
      { title: 'Spring Health', url: 'https://boards.greenhouse.io/springhealth' }
    ],
    pages: { [`https://jobs.ashbyhq.com/${SPRING_BOARD}`]: 'Spring Health Jobs' },
    greenhouse: { springhealth: 'Spring Health' },
    jobs: { [`ashby:${SPRING_BOARD}`]: 67, 'greenhouse:springhealth': 20 }
  }));

  assert.equal(counted.count, 67);
  assert.equal(counted.lowerBound, true);
  assert.equal(counted.scope, 'multiple_boards');
  assert.equal(counted.boards.length, 2);
});

test('a Glassdoor open-jobs count is a lower bound and is never scored', () => {
  // 10 employees and 50 roles would be a 5:1 ratio and full points if the count were company-wide.
  const workforce = resolveWorkforce({
    employees: 10,
    employeeLabel: '10',
    employeeSource: 'linkedin',
    openJobs: 50,
    openJobsSource: 'glassdoor',
    openJobsLowerBound: true,
    openJobsScope: 'glassdoor_listings'
  });

  assert.equal(workforce.score, 0);
  assert.equal(workforce.openJobsLowerBound, true);
  assert.match(workforce.label, /50\+ open roles listed on Glassdoor = at least 5:1/);
  assert.match(workforce.detail, /lower bound and is not scored/);
});

test('Spring Health shape: 3,001 employees and Glassdoor 5 reads as a floor, not a figure', () => {
  const workforce = resolveWorkforce({
    employees: 3001,
    employeeLabel: '3,001',
    openJobs: 5,
    openJobsSource: 'glassdoor',
    openJobsLowerBound: true,
    openJobsScope: 'glassdoor_listings'
  });

  assert.equal(workforce.score, 0);
  assert.equal(workforce.label, '3,001 employees / 5+ open roles listed on Glassdoor = at least 0.0017:1');
});

function citationDeps({ results, answer }) {
  return {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => (query.includes('site:myworkdayjobs.com') ? [] : results),
    fetch: async () => ({ ok: false, status: 404, async text() { return ''; }, async json() { return {}; } }),
    askGroq: async () => answer
  };
}

test('a company open-roles count beats an earlier scoped aggregator count', async () => {
  const counted = await resolveOpenJobCount('Alignerr', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/1',
    glassdoorOpenJobs: 0,
    website: 'https://www.alignerr.com'
  }, citationDeps({
    results: [
      {
        title: 'Remote Alignerr Jobs',
        snippet: 'Browse 45 REMOTE ALIGNERR jobs from companies hiring now.',
        url: 'https://www.ziprecruiter.com/Jobs/Remote-Alignerr'
      },
      {
        title: 'Alignerr jobs',
        snippet: 'Alignerr lists 5,624 open roles.',
        url: 'https://www.alignerr.com/jobs'
      }
    ],
    answer: 'Result 1 states 45 open jobs. Result 2 states 5,624 open roles.'
  }));
  const workforce = resolveWorkforce({
    employees: 2538,
    employeeLabel: '2,538',
    employeeSource: 'search',
    openJobs: counted.count,
    openJobsSource: counted.source,
    openJobsEstimated: counted.estimated,
    openJobsLowerBound: counted.lowerBound,
    openJobsScope: counted.scope,
    openJobsSourceUrl: counted.url
  });

  assert.equal(counted.count, 5624);
  assert.equal(counted.url, 'https://www.alignerr.com/jobs');
  assert.equal(counted.lowerBound, undefined);
  assert.equal(workforce.score, 21);
  assert.match(workforce.label, /5,624 open roles \(estimated\)/);
});

test('the Alignerr worldwide cap is a floor and a step number is not the count', async () => {
  const counted = await resolveOpenJobCount('Alignerr', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/1',
    glassdoorOpenJobs: 0,
    website: 'https://www.alignerr.com'
  }, citationDeps({
    results: [
      {
        title: 'Alignerr: Jobs',
        snippet: 'Apply today through our open Job Postings. Employees - Now: 3,950.',
        url: 'https://www.linkedin.com/company/alignerr/jobs'
      },
      {
        title: 'Remote Alignerr Jobs',
        snippet: 'Browse 45 REMOTE ALIGNERR jobs from companies hiring now.',
        url: 'https://www.ziprecruiter.com/Jobs/Remote-Alignerr'
      },
      {
        title: 'Alignerr Jobs in Worldwide (5000+ Open Roles)',
        snippet: '5000+ Alignerr jobs in Worldwide. New Alignerr jobs added daily.',
        url: 'https://www.linkedin.com/jobs/alignerr-jobs-worldwide'
      },
      {
        title: 'Alignerr Jobs, Employment',
        snippet: 'Browse 2 Alignerr jobs. New jobs posted today.',
        url: 'https://www.indeed.com/q-alignerr-jobs.html'
      },
      {
        title: 'Learn how to become an Alignerr today',
        snippet: 'Explore Alignerr Connect Step 2 ## Apply for a job. 2 Apply for a job.',
        url: 'https://www.alignerr.com/process'
      },
      {
        title: 'Alignerr jobs search',
        snippet: '5,000+ Alignerr jobs.',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Alignerr'
      }
    ],
    answer: 'Result 2 states 45. Result 3 states 5,000+ open roles. Result 4 states 2 Alignerr jobs. Step 2.'
  }));
  const workforce = resolveWorkforce({
    employees: 2538,
    employeeLabel: '2,538',
    employeeSource: 'linkedin',
    openJobs: counted.count,
    openJobsSource: counted.source,
    openJobsEstimated: counted.estimated,
    openJobsLowerBound: counted.lowerBound,
    openJobsScope: counted.scope,
    openJobsScopeQualifier: counted.scopeQualifier,
    openJobsScopeSite: counted.scopeSite,
    openJobsSourceUrl: counted.url
  });

  assert.equal(counted.count, 5000);
  assert.notEqual(counted.count, 2);
  assert.equal(counted.lowerBound, true);
  assert.equal(counted.scope, 'open_ended');
  assert.equal(counted.scopeSite, 'LinkedIn');
  assert.match(counted.url, /alignerr-jobs-worldwide/);
  assert.equal(workforce.score, 0);
  assert.match(workforce.label, /at least 5,000/);
  assert.doesNotMatch(workforce.label, /\b2 open roles\b/);
});

test('a scoped aggregator count is a floor when it is the only citation', async () => {
  const counted = await resolveOpenJobCount('Alignerr', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/1',
    glassdoorOpenJobs: 0
  }, citationDeps({
    results: [{
      title: 'Remote Alignerr Jobs',
      snippet: 'Browse 45 REMOTE ALIGNERR jobs from companies hiring now.',
      url: 'https://www.ziprecruiter.com/Jobs/Remote-Alignerr'
    }],
    answer: 'Result 1 states 45 open jobs.'
  }));
  const workforce = resolveWorkforce({
    employees: 2538,
    employeeLabel: '2,538',
    employeeSource: 'linkedin',
    openJobs: counted.count,
    openJobsSource: counted.source,
    openJobsEstimated: counted.estimated,
    openJobsLowerBound: counted.lowerBound,
    openJobsScope: counted.scope,
    openJobsScopeQualifier: counted.scopeQualifier,
    openJobsScopeSite: counted.scopeSite
  });

  assert.equal(counted.count, 45);
  assert.equal(counted.lowerBound, true);
  assert.equal(counted.scopeQualifier, 'remote');
  assert.equal(counted.scopeSite, 'ZipRecruiter');
  assert.equal(workforce.score, 0);
  assert.equal(workforce.label, '2,538 employees / 45+ remote roles listed on ZipRecruiter = at least 0.018:1');
  assert.match(workforce.detail, /not scored/);
});

test('a Harrison Clarke 5,000+ company-page snippet is rejected and 46 jobs is kept', async () => {
  const rejected = await resolveOpenJobCount('Harrison Clarke', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/4474346769',
    glassdoorOpenJobs: 0
  }, citationDeps({
    results: [{
      title: 'Harrison Clarke | LinkedIn',
      snippet: 'Harrison Clarke. 5,000+ open roles on LinkedIn.',
      url: 'https://www.linkedin.com/company/harrisonclarke'
    }],
    answer: 'The company page lists 5,000+ open roles.'
  }));
  const accepted = await resolveOpenJobCount('Harrison Clarke', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/4474346769',
    glassdoorOpenJobs: 0
  }, citationDeps({
    results: [{
      title: 'Harrison Clarke Jobs',
      snippet: 'Harrison Clarke has 46 jobs.',
      url: 'https://www.linkedin.com/jobs/harrison-clarke-jobs-worldwide?f_C=5114934'
    }],
    answer: 'should not be asked'
  }));

  const searchCap = await resolveOpenJobCount('Harrison Clarke', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/4474346769',
    glassdoorOpenJobs: 0
  }, citationDeps({
    results: [{
      title: 'Harrison Clarke jobs',
      snippet: '5,000+ Harrison Clarke jobs.',
      url: 'https://www.linkedin.com/jobs/search/?keywords=Harrison%20Clarke'
    }],
    answer: 'The search lists 5,000+ jobs.'
  }));

  assert.equal(rejected, null);
  assert.equal(searchCap, null);
  assert.equal(accepted.count, 46);
  assert.equal(accepted.source, 'page');
  assert.match(accepted.url, /harrison-clarke-jobs-worldwide/);
  assert.match(accepted.url, /f_C=5114934/);
});

test('a 330 to 1 ratio from a snippet citation is not displayed', () => {
  const cited = resolveWorkforce({
    employees: 15,
    employeeLabel: '15',
    openJobs: 4950,
    openJobsSource: 'search',
    openJobsEstimated: true,
    openJobsSourceUrl: 'https://www.linkedin.com/company/harrisonclarke'
  });
  const confirmed = resolveWorkforce({
    employees: 15,
    employeeLabel: '15',
    openJobs: 4950,
    openJobsSource: 'page',
    openJobsEstimated: false,
    openJobsSourceUrl: 'https://www.linkedin.com/jobs/harrison-clarke-jobs-worldwide?f_C=5114934'
  });

  assert.equal(cited.ratio, null);
  assert.equal(cited.openRoles, null);
  assert.equal(cited.score, 0);
  assert.doesNotMatch(cited.label, /:1/);
  assert.match(cited.label, /15 employees/);
  assert.equal(confirmed.ratio, 330);
  assert.match(confirmed.label, /330:1/);
});

test('a result index in the model answer is not an open-roles count', async () => {
  const counted = await resolveOpenJobCount('Alignerr', {
    platform: 'LINKEDIN',
    hostname: 'www.linkedin.com',
    jobUrl: 'https://www.linkedin.com/jobs/view/1',
    glassdoorOpenJobs: 0,
    website: 'https://www.alignerr.com'
  }, citationDeps({
    results: [
      {
        title: 'Alignerr Jobs in Worldwide (5000+ Open Roles)',
        snippet: "Today's top 5000+ Alignerr jobs in Worldwide.",
        url: 'https://www.linkedin.com/jobs/alignerr-jobs-worldwide'
      },
      {
        title: 'Learn how to become an Alignerr',
        snippet: 'Explore Alignerr Connect Step 2. Apply for a job. Billing signup 5 Alignerr onboarding.',
        url: 'https://www.alignerr.com/process'
      },
      {
        title: 'Remote Alignerr Jobs',
        snippet: 'Browse 45 REMOTE ALIGNERR jobs from companies hiring now.',
        url: 'https://www.ziprecruiter.com/Jobs/Remote-Alignerr'
      }
    ],
    answer: '5000+ – Result 2'
  }));

  assert.equal(counted.count, 5000);
  assert.equal(counted.lowerBound, true);
  assert.notEqual(counted.count, 2);
  assert.match(counted.url, /alignerr-jobs-worldwide/);
});

test('a verified Greenhouse board is title-matched from the jobs fetch and not returned', async () => {
  const lines = [];
  const original = console.info;
  console.info = (message, details) => {
    if (message === '[GHD] careers check') {
      lines.push(details);
    }
  };

  try {
    const counted = await resolveOpenJobCount('Stripe', {
      website: 'https://boards.greenhouse.io/stripe',
      jobTitle: 'Software Engineer, Payments'
    }, {
      now: NOW,
      cache: new MemoryCache(),
      webSearch: async () => {
        throw new Error('no extra search');
      },
      fetch: async () => ({
        ok: true,
        async json() {
          return {
            jobs: [
              { id: 1, title: 'Software Engineer, Payments' },
              { id: 2, title: 'Account Executive' }
            ]
          };
        }
      })
    });

    assert.equal(counted.count, 2);
    assert.equal(counted.source, 'greenhouse');
    assert.equal(counted.titles, undefined);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, 'found');
    assert.equal(lines[0].board, 'greenhouse');
    assert.equal(lines[0].jobCount, 2);
    assert.deepEqual(lines[0].overlap, {
      shared: ['software', 'engineer', 'payments'],
      dropped: [],
      introduced: []
    });
    assert.equal(lines[0].matchedTitle, 'Software Engineer, Payments');

    const missed = [];
    console.info = (message, details) => {
      if (message === '[GHD] careers check') {
        missed.push(details);
      }
    };
    const board = {
      ok: true,
      async json() {
        return {
          jobs: [
            { id: 1, title: 'Software Engineer, Payments' },
            { id: 2, title: 'Software Engineer, Developer Platform' },
            { id: 3, title: 'Staff Product Engineer - Americas' },
            { id: 4, title: 'Senior Software Engineer - Egress (Go/Rust)' }
          ]
        };
      }
    };
    const cases = [
      ['Director of Horse Husbandry', 'not found', 'Software Engineer, Payments'],
      ['Software Engineer, AI Platform', 'not found', 'Software Engineer, Developer Platform'],
      ['Product Support Engineer - Americas', 'not found', 'Staff Product Engineer - Americas'],
      ['Engineering Manager, Web Infrastructure', 'not found', 'Software Engineer, Payments'],
      ['Software Engineer - Egress (Go/Rust)', 'found', 'Senior Software Engineer - Egress (Go/Rust)']
    ];

    const seen = new Map();

    for (const [jobTitle, outcome, matchedTitle] of cases) {
      missed.length = 0;
      await resolveOpenJobCount('Stripe', {
        website: 'https://boards.greenhouse.io/stripe',
        jobTitle
      }, {
        now: new Date('2026-10-01T13:00:00Z'),
        cache: new MemoryCache(),
        fetch: async () => board
      });
      assert.equal(missed[0].outcome, outcome, jobTitle);
      assert.equal(missed[0].matchedTitle, matchedTitle, jobTitle);
      seen.set(jobTitle, missed[0].overlap);
    }

    assert.deepEqual(seen.get('Software Engineer, AI Platform'), {
      shared: ['software', 'engineer', 'platform'],
      dropped: ['ai'],
      introduced: ['developer']
    });
    assert.deepEqual(seen.get('Product Support Engineer - Americas'), {
      shared: ['product', 'engineer', 'americas'],
      dropped: ['support'],
      introduced: []
    });
    assert.deepEqual(seen.get('Software Engineer - Egress (Go/Rust)'), {
      shared: ['software', 'engineer', 'egress', 'go', 'rust'],
      dropped: [],
      introduced: []
    });
  } finally {
    console.info = original;
  }
});
