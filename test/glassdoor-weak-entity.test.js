import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { isWeakGlassdoorHit, legalFormVariants, lookupCompanyRating } from '../lib/server/company-rating.js';

const NOW = new Date('2026-10-05T12:00:00Z');

// Entity fields as Glassdoor returned them live on 2026-10-05.
const INTEL_SHELL = {
  id: 10434062,
  name: 'Intel',
  website: 'www.intel.com',
  size: '1 to 50 Employees',
  ratings: { overall: null },
  counts: { reviews: 0, open_jobs: 0 }
};
const INTEL_REAL = {
  id: 1519,
  name: 'Intel Corporation',
  website: 'https://www.intel.com/life',
  size: '10000+ Employees',
  ratings: { overall: 3.9 },
  counts: { reviews: 39680, open_jobs: 2310 }
};

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// RapidAPI answers by queried name; Wikidata answers with a headcount (or none).
function deps({ byName, wikidataCount = null, queried = [], cache = new MemoryCache() }) {
  return {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: 'rapid-test' },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wikidata.org')) {
        if (!wikidataCount) {
          return json(200, { search: [] });
        }

        if (href.includes('wbsearchentities')) {
          return json(200, { search: [{ id: 'Q248' }] });
        }

        return json(200, {
          entities: {
            Q248: { claims: { P1128: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: `+${wikidataCount}` } } } }] } }
          }
        });
      }

      const name = new URL(href).searchParams.get('company');
      queried.push(name);
      return byName[name] ? json(200, byName[name]) : json(404, {});
    }
  };
}

test('a hit with no rating and no reviews is weak', () => {
  assert.equal(isWeakGlassdoorHit({ overall: null }), true);
  assert.equal(isWeakGlassdoorHit({ overall: null, reviewCount: 0 }), true);
  assert.equal(isWeakGlassdoorHit({ overall: 3.9, reviewCount: 39680 }), false);
  assert.equal(isWeakGlassdoorHit({ overall: null, reviewCount: 12 }), false);
  assert.deepEqual(legalFormVariants('Intel'), ['Intel Corporation', 'Intel Inc']);
  assert.deepEqual(legalFormVariants('Intel Corporation'), []);
});

test('Intel: the empty "Intel" page is skipped and "Intel Corporation" is used', async () => {
  const queried = [];
  const rating = await lookupCompanyRating('Intel', deps({
    queried,
    byName: { Intel: INTEL_SHELL, 'Intel Corporation': INTEL_REAL },
    wikidataCount: 121100
  }));

  assert.deepEqual(queried, ['Intel', 'Intel Corporation']);
  assert.equal(rating.overall, 3.9);
  assert.equal(rating.reviewCount, 39680);
  assert.equal(rating.glassdoorSize, '10000+ Employees');
});

test('a strong first hit makes no legal-form calls', async () => {
  const queried = [];
  await lookupCompanyRating('Intel Corporation', deps({ queried, byName: { 'Intel Corporation': INTEL_REAL } }));
  assert.deepEqual(queried, ['Intel Corporation']);
});

test('with no strong variant, the weak entity and its 1-50 bucket are not used, and are remembered', async () => {
  const cache = new MemoryCache();
  const queried = [];
  const rating = await lookupCompanyRating('Intel', deps({ cache, queried, byName: { Intel: INTEL_SHELL }, wikidataCount: null }));

  assert.deepEqual(queried, ['Intel', 'Intel Corporation', 'Intel Inc']);
  assert.equal(rating.overall ?? null, null);
  assert.notEqual(rating.employees, 26);
  assert.notEqual(rating.employeeLabel, '26');
  assert.equal(rating.glassdoorSize, undefined);

  const again = [];
  await lookupCompanyRating('Intel', deps({ cache, queried: again, byName: { Intel: INTEL_SHELL } }));
  assert.deepEqual(again, [], 'the weak result is remembered, so no RapidAPI calls are repeated');
});

test('a Glassdoor entity Wikidata contradicts by 10x is rejected; its rating is not used', async () => {
  // A same-name entity with a few reviews but a tiny closed bucket.
  const smallNamesake = { ...INTEL_SHELL, ratings: { overall: 2.1 }, counts: { reviews: 7, open_jobs: 3 } };
  const rating = await lookupCompanyRating('Intel', deps({ byName: { Intel: smallNamesake }, wikidataCount: 121100 }));

  assert.equal(rating.overall, null);
  assert.equal(rating.openJobs, null);
  assert.equal(rating.employees, 121100);
  assert.equal(rating.employeeSource, 'wikidata');
  assert.equal(rating.glassdoorContradicted, true);
});

test('a Wikidata figure far below Glassdoor does not reject the Glassdoor entity', async () => {
  // University of Miami: Wikidata said 2,681, the real figure is far higher.
  const umiami = { id: 33297, name: 'University of Miami', size: '5001 to 10000 Employees', ratings: { overall: 3.8 }, counts: { reviews: 3000, open_jobs: 1984 } };
  const rating = await lookupCompanyRating('University of Miami', deps({ byName: { 'University of Miami': umiami }, wikidataCount: 300 }));

  assert.equal(rating.overall, 3.8);
  assert.equal(rating.glassdoorContradicted, undefined);
});
