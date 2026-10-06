import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { resolveWorkforce } from '../lib/server/analyze.js';
import { findCompanyReviews } from '../lib/server/reviews.js';
import {
  parseWorkdayBoard,
  resolveOpenJobCount,
  workdaySiteWords,
  workdayTenantNamesCompany,
  workdayUrlNamesCompany,
  WORKDAY_TOTAL_CAP
} from '../lib/server/open-jobs.js';

// Real boards and their offset-0 CXS responses, captured 2026-10-05.
const fixture = (name) => readFileSync(new URL(`./fixtures/workday/${name}`, import.meta.url), 'utf8');
const NOW = new Date('2026-10-05T12:00:00Z');
const BOARDS = {
  NVIDIA: { tenant: 'nvidia', url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite', size: '10000+ Employees' },
  Salesforce: { tenant: 'salesforce', url: 'https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site', size: '10000+ Employees' },
  Adobe: { tenant: 'adobe', url: 'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced', size: '10000+ Employees' },
  Intel: { tenant: 'intel', url: 'https://intel.wd1.myworkdayjobs.com/External', size: '10000+ Employees' }
};

test('the real NVIDIA, Salesforce, Adobe, and Intel boards pass the tenant-and-site rule', () => {
  assert.deepEqual(workdaySiteWords('NVIDIAExternalCareerSite'), ['nvidia', 'external', 'career', 'site']);

  for (const [company, board] of Object.entries(BOARDS)) {
    assert.equal(workdayTenantNamesCompany(parseWorkdayBoard(board.url), company), true, company);
  }
});

test('"spring" is not Spring Health: the tenant must be the whole company name', () => {
  assert.equal(workdayTenantNamesCompany({ tenant: 'spring', site: 'Spring_Careers' }, 'Spring Health'), false);
  assert.equal(workdayTenantNamesCompany({ tenant: 'springhealth', site: 'Careers' }, 'Spring Health'), true);
});

test('a different company with the same short name is rejected', () => {
  // A tenant named "apex" is not Apex Systems, even with a careers site.
  assert.equal(workdayTenantNamesCompany({ tenant: 'apex', site: 'Apex_Careers' }, 'Apex Systems'), false);
  // And a tenant for another company never passes on a generic site name.
  assert.equal(workdayTenantNamesCompany({ tenant: 'wattswater', site: 'External' }, 'Salesforce'), false);
});

test('a sub-site of the right tenant is rejected', () => {
  assert.equal(workdayTenantNamesCompany({ tenant: 'nvidia', site: 'NVIDIA_University' }, 'NVIDIA'), false);
  assert.equal(workdayTenantNamesCompany({ tenant: 'adobe', site: 'external_university' }, 'Adobe'), false);
  assert.equal(workdayTenantNamesCompany({ tenant: 'salesforce', site: 'Contractors' }, 'Salesforce'), false);
});

// Workday as the real boards answered, Tavily as a list of result URLs.
function discoveryDeps({ results, log = [], searches = [], cache = new MemoryCache(), cxs = {} }) {
  return {
    now: NOW,
    cache,
    webSearch: async (query) => {
      searches.push(query);
      return query.startsWith('site:myworkdayjobs.com') ? results.map((url) => ({ url, title: '', snippet: '' })) : [];
    },
    fetch: async (url) => {
      const href = String(url);
      log.push(href);

      for (const board of Object.values(BOARDS)) {
        const parsed = parseWorkdayBoard(board.url);

        if (href === `${parsed.origin}/wday/cxs/${parsed.tenant}/${parsed.site}/jobs`) {
          const override = cxs[board.tenant];

          if (override === 404) {
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
          }

          return { ok: true, status: 200, json: async () => JSON.parse(fixture(`${board.tenant}.cxs-jobs.json`)) };
        }

        if (href.startsWith(parsed.origin) && !href.includes('/wday/cxs/')) {
          return { ok: true, status: 200, text: async () => fixture(`${board.tenant}.board.html`) };
        }
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  };
}

test('Salesforce and Adobe get their real Workday totals instead of the Glassdoor floor', async () => {
  for (const [company, expected] of [['Salesforce', 1520], ['Adobe', 524], ['Intel', 607]]) {
    const counted = await resolveOpenJobCount(company, {
      profile: Promise.resolve({ glassdoorSize: BOARDS[company].size, openJobs: 500 })
    }, discoveryDeps({ results: [BOARDS[company].url] }));

    assert.equal(counted.source, 'workday', company);
    assert.equal(counted.count, expected, company);
    assert.equal(Boolean(counted.lowerBound), false, company);
  }
});

test('NVIDIA\'s total at the 2,000 cap is a floor, and is shown as one', async () => {
  const counted = await resolveOpenJobCount('NVIDIA', {
    profile: Promise.resolve({ glassdoorSize: BOARDS.NVIDIA.size, openJobs: 1977 })
  }, discoveryDeps({ results: [BOARDS.NVIDIA.url] }));

  assert.equal(counted.source, 'workday');
  assert.equal(counted.count, WORKDAY_TOTAL_CAP);
  assert.equal(counted.lowerBound, true);
  assert.equal(counted.scope, 'workday_cap');

  const workforce = resolveWorkforce({
    employees: 42000,
    employeeLabel: '42,000',
    employeeSource: 'wikidata',
    openJobs: counted.count,
    openJobsSource: 'workday',
    openJobsLowerBound: true,
    openJobsScope: 'workday_cap'
  });
  assert.equal(workforce.score, 0);
  assert.match(workforce.label, /2,000\+ open roles on Workday, which stops counting at 2,000/);
});

test('a board returned three times by search is checked once', async () => {
  const log = [];
  const nv = BOARDS.NVIDIA.url;
  await resolveOpenJobCount('NVIDIA', {
    profile: Promise.resolve({ glassdoorSize: BOARDS.NVIDIA.size })
  }, discoveryDeps({ log, results: [`${nv}/job/US-CA-Santa-Clara/Engineer_JR1`, nv, nv.replace('/en-US', '')] }));

  const cxsCalls = log.filter((href) => href.includes('/wday/cxs/'));
  assert.equal(cxsCalls.length, 1);
});

test('10,000+ companies try the Workday search first; others try the board search first', async () => {
  const large = [];
  await resolveOpenJobCount('Salesforce', {
    profile: Promise.resolve({ glassdoorSize: '10000+ Employees' })
  }, discoveryDeps({ searches: large, results: [BOARDS.Salesforce.url] }));
  assert.equal(large[0], 'site:myworkdayjobs.com Salesforce');
  assert.equal(large.length, 1, 'the board search is not run once Workday answered');

  const small = [];
  await resolveOpenJobCount('Salesforce', {
    profile: Promise.resolve({ glassdoorSize: '1001 to 5000 Employees' })
  }, discoveryDeps({ searches: small, results: [BOARDS.Salesforce.url] }));
  assert.equal(small[0], '"Salesforce" jobs');
  assert.equal(small[1], 'site:myworkdayjobs.com Salesforce');
});

test('a remembered board skips both searches and reads a fresh count; a 404 drops it', async () => {
  const cache = new MemoryCache();
  const first = [];
  await resolveOpenJobCount('Intel', {
    profile: Promise.resolve({ glassdoorSize: BOARDS.Intel.size })
  }, discoveryDeps({ cache, searches: first, results: [BOARDS.Intel.url] }));
  assert.ok(first.length >= 1);

  // A day later the open-roles count has expired, but the board is remembered.
  const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  const second = [];
  const deps = discoveryDeps({ cache, searches: second, results: [BOARDS.Intel.url] });
  const counted = await resolveOpenJobCount('Intel', {
    profile: Promise.resolve({ glassdoorSize: BOARDS.Intel.size })
  }, { ...deps, now: later });
  assert.equal(counted.count, 607);
  assert.equal(second.length, 0);

  // The board is gone: the entry is dropped and the next check searches again.
  const gone = new Date(later.getTime() + 25 * 60 * 60 * 1000);
  const third = [];
  const goneDeps = discoveryDeps({ cache, searches: third, results: [], cxs: { intel: 404 } });
  await resolveOpenJobCount('Intel', {
    profile: Promise.resolve({ glassdoorSize: BOARDS.Intel.size })
  }, { ...goneDeps, now: gone });
  assert.ok(third.length >= 1);
  assert.equal(await cache.get('workday_board_v1_intel', gone), null);
});

test('the review fallback stops at one overall budget and does not start a second search', async () => {
  const queries = [];
  const started = Date.now();
  const review = await findCompanyReviews('Intel', {
    reviewSearchBudgetMs: 60,
    webSearch: async (query, options) => {
      queries.push(options?.includeDomains?.[0]);
      // Like the live Intel search: no answer before the budget runs out.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [];
    }
  });

  assert.ok(Date.now() - started < 250, 'the fallback returns at the budget, not after the slow search');
  assert.deepEqual(queries, ['glassdoor.com']);
  assert.equal(review.rating, null);
  assert.equal(review.searchFailed, true);
});

test('when the last search fails, the Glassdoor floor is used and kept only briefly', async () => {
  const cache = new MemoryCache();
  const writes = [];
  const set = cache.set.bind(cache);
  cache.set = async (key, payload, ttlMs, now) => {
    writes.push({ key, payload, ttlMs });
    return set(key, payload, ttlMs, now);
  };
  const counted = await resolveOpenJobCount('Salesforce', {
    profile: Promise.resolve({ glassdoorSize: '10000+ Employees', openJobs: 1415 })
  }, {
    now: NOW,
    cache,
    // Workday search first (10,000+), then the board search: both time out.
    webSearch: async () => {
      throw new Error('The operation was aborted due to timeout');
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.count, 1415);
  assert.equal(counted.lowerBound, true);
  const saved = writes.find((item) => item.key.startsWith('open_jobs_'));
  assert.equal(saved.payload.higherTierFailed, true);
  assert.equal(saved.ttlMs, 5 * 60 * 1000);
});

test('a 10,000+ company with no Workday board skips the board search but still gets the floor', async () => {
  const searches = [];
  const counted = await resolveOpenJobCount('Mayo Clinic', {
    profile: Promise.resolve({ glassdoorSize: '10000+ Employees', openJobs: 1360 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      searches.push(query);
      return [];
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.deepEqual(searches, ['site:myworkdayjobs.com Mayo Clinic']);
  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.count, 1360);
  assert.equal(counted.lowerBound, true);
});

test('a smaller company still gets the board search, then Workday', async () => {
  const searches = [];
  await resolveOpenJobCount('St. Jude Children\'s Research Hospital', {
    profile: Promise.resolve({ glassdoorSize: '5001 to 10000 Employees', openJobs: 200 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      searches.push(query);
      return [];
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.deepEqual(searches.slice(0, 2), ['"St. Jude Children\'s Research Hospital" jobs', 'site:myworkdayjobs.com St. Jude Children\'s Research Hospital']);
});

test('a sub-board found by search is not counted as the whole company (Cleveland Clinic UK)', async () => {
  const { workdaySiteIsSubBoard } = await import('../lib/server/open-jobs.js');
  // Both carry the page name "Cleveland Clinic Careers"; only the site name differs.
  assert.equal(workdaySiteIsSubBoard({ tenant: 'ccf', site: 'ClevelandClinicCareersUK' }, 'Cleveland Clinic'), true);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'ccf', site: 'ClevelandClinicCareers' }, 'Cleveland Clinic'), false);

  const page = '<html><head><title></title><meta property="og:title" content="CLEVELAND CLINIC CAREERS"></head></html>';
  const counted = await resolveOpenJobCount('Cleveland Clinic', {
    profile: Promise.resolve({ glassdoorSize: '10000+ Employees', openJobs: 2766 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => (query.startsWith('site:myworkdayjobs.com')
      ? [{ url: 'https://ccf.wd1.myworkdayjobs.com/en-US/ClevelandClinicCareersUK', title: '', snippet: '' },
        { url: 'https://ccf.wd1.myworkdayjobs.com/ClevelandClinicCareers', title: '', snippet: '' }]
      : []),
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('/wday/cxs/ccf/ClevelandClinicCareersUK/')) {
        return { ok: true, status: 200, json: async () => ({ total: 31 }) };
      }

      if (href.includes('/wday/cxs/ccf/ClevelandClinicCareers/')) {
        return { ok: true, status: 200, json: async () => ({ total: 2000 }) };
      }

      if (href.startsWith('https://ccf.wd1.myworkdayjobs.com/')) {
        return { ok: true, status: 200, text: async () => page };
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });

  // The main board (2,000, the Workday cap) is the one kept, not the UK one.
  // Glassdoor lists 2,766, a larger floor, so that is the count reported.
  assert.notEqual(counted.count, 31);
  assert.equal(counted.workdayBoard, 'https://ccf.wd1.myworkdayjobs.com/ClevelandClinicCareers');
  assert.equal(counted.count, 2766);
  assert.equal(counted.lowerBound, true);
});

const AWS_CANDIDATES = [
  'https://zendesk.wd1.myworkdayjobs.com/en-US/zendesk',
  'https://ingrammicro.wd5.myworkdayjobs.com/en-US/ingrammicro',
  'https://accenture.wd103.myworkdayjobs.com/en-US/AccentureCareers'
];

test('Zendesk, Ingram Micro and Accenture boards for Amazon Web Services are rejected from the URL, with no page fetch', async () => {
  const fetched = [];

  for (const url of AWS_CANDIDATES) {
    assert.equal(workdayUrlNamesCompany(parseWorkdayBoard(url), 'Amazon Web Services'), false, url);
  }

  const counted = await resolveOpenJobCount('Amazon Web Services', {
    profile: Promise.resolve({ glassdoorSize: 'Unknown', openJobs: 8220 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => (query.startsWith('site:myworkdayjobs.com')
      ? AWS_CANDIDATES.map((url) => ({ url, title: '', snippet: '' }))
      : []),
    fetch: async (url) => {
      fetched.push(String(url));
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });

  assert.equal(fetched.some((url) => url.includes('myworkdayjobs.com')), false);
  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.count, 8220);
  assert.equal(counted.lowerBound, true);
});

test('candidate boards are verified together, and the first match in search order is kept', async () => {
  let active = 0;
  let peak = 0;
  const page = '<html><head><meta property="og:title" content="Cleveland Clinic"></head></html>';
  const pages = {
    'https://ccf.wd1.myworkdayjobs.com/ClevelandClinicCareers': 80,
    'https://other.wd1.myworkdayjobs.com/en-US/ClevelandClinicJobs': 10
  };
  const counted = await resolveOpenJobCount('Cleveland Clinic', {
    profile: Promise.resolve({ glassdoorSize: '10000+ Employees', openJobs: 100 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => (query.startsWith('site:myworkdayjobs.com')
      ? Object.keys(pages).map((url) => ({ url, title: '', snippet: '' }))
      : []),
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('/wday/cxs/ccf/ClevelandClinicCareers/')) {
        return { ok: true, status: 200, json: async () => ({ total: 400 }) };
      }

      if (href.includes('/wday/cxs/other/ClevelandClinicJobs/')) {
        return { ok: true, status: 200, json: async () => ({ total: 12 }) };
      }

      if (pages[href] != null) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, pages[href]));
        active -= 1;
        return { ok: true, status: 200, text: async () => page };
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });

  assert.ok(peak >= 2);
  assert.equal(counted.source, 'workday');
  assert.equal(counted.count, 400);
  assert.equal(counted.url, 'https://ccf.wd1.myworkdayjobs.com/ClevelandClinicCareers');
});

test('AWS skips the board search when a headcount of 147,927 is already known and Glassdoor size is Unknown', async () => {
  const cases = [
    { wikidataMemo: new Map([['amazon web services', Promise.resolve({ count: 147927 })]]) },
    { capturedHeadcount: { employees: 147927, capturedAt: NOW.getTime() } },
    { employeeSearchMemo: new Map([['amazon web services', Promise.resolve({ employees: 147927, sourceUrl: 'https://example.com/aws' })]]) }
  ];

  for (const extra of cases) {
    const searches = [];
    await resolveOpenJobCount('Amazon Web Services', {
      profile: Promise.resolve({ glassdoorSize: 'Unknown', openJobs: 8220 })
    }, {
      now: NOW,
      cache: new MemoryCache(),
      webSearch: async (query) => {
        searches.push(query);
        return [];
      },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
      ...extra
    });

    assert.equal(searches.includes('"Amazon Web Services" jobs'), false);
    assert.equal(searches[0], 'site:myworkdayjobs.com Amazon Web Services');
  }
});

test('a mid-size company with no headcount estimate still searches boards', async () => {
  const searches = [];
  await resolveOpenJobCount('Northwind Clinics', {
    profile: Promise.resolve({ glassdoorSize: '1001 to 5000 Employees', openJobs: 40 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      searches.push(query);
      return [];
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.equal(searches[0], '"Northwind Clinics" jobs');
  assert.equal(searches[1], 'site:myworkdayjobs.com Northwind Clinics');
});

test('a missing size is not treated as a small company', async () => {
  const searches = [];
  const pending = new Promise(() => {});
  await resolveOpenJobCount('Amazon Web Services', {
    profile: Promise.resolve({ glassdoorSize: 'Unknown', openJobs: 8220 })
  }, {
    now: NOW,
    cache: new MemoryCache(),
    wikidataMemo: new Map([['amazon web services', pending]]),
    webSearch: async (query) => {
      searches.push(query);
      return [];
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.equal(searches.includes('"Amazon Web Services" jobs'), false);
  assert.equal(searches[0], 'site:myworkdayjobs.com Amazon Web Services');
});

test('TKO, Argonne, NVIDIA, Salesforce, Adobe and Mass General Brigham addresses still name the company', () => {
  const accepted = [
    ['TKO Group Holdings', 'https://wwecorp.wd5.myworkdayjobs.com/en-US/TKO'],
    ['Argonne National Laboratory', 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers'],
    ['NVIDIA', 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite'],
    ['Salesforce', 'https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site'],
    ['Adobe', 'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced'],
    ['Mass General Brigham', 'https://massgeneralbrigham.wd1.myworkdayjobs.com/MGBExternal']
  ];

  for (const [company, url] of accepted) {
    assert.equal(workdayUrlNamesCompany(parseWorkdayBoard(url), company), true, company);
  }
});
