import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { lookupCompanyRating } from '../lib/server/company-rating.js';

const NOW = new Date('2026-10-05T12:00:00Z');

// What Glassdoor returned for "Ford" live on 2026-10-05: an Australian company.
const FORD_AU = {
  id: 10659496,
  name: 'Ford',
  website: 'elnford.com.au',
  size: '51 to 200 Employees',
  ratings: { overall: 3 },
  counts: { reviews: 1, open_jobs: 0 }
};
// The real employer, as the retry should find it (fields constructed for the test).
const FORD_MOTOR = {
  id: 263,
  name: 'Ford Motor Company',
  website: 'https://www.ford.com',
  size: '10000+ Employees',
  ratings: { overall: 4.1 },
  counts: { reviews: 21000, open_jobs: 1800 }
};

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// Wikidata answers "Ford" with Q44294 "Ford Motor Company", 186,000 employees
// (live 2026-10-05). Every call to either service is recorded.
function deps({ byName, label = 'Ford Motor Company', count = 186000, cache = new MemoryCache(), calls }) {
  return {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: 'rapid-test' },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wikidata.org')) {
        calls.wikidata.push(new URL(href).searchParams.get('action'));

        if (href.includes('wbsearchentities')) {
          return json(200, { search: label ? [{ id: 'Q44294', label }] : [] });
        }

        return json(200, {
          entities: { Q44294: { claims: { P1128: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: `+${count}` } } } }] } } }
        });
      }

      const name = new URL(href).searchParams.get('company');
      calls.rapid.push(name);
      return byName[name] ? json(200, byName[name]) : json(404, {});
    }
  };
}

const newCalls = () => ({ rapid: [], wikidata: [] });

test('Ford: the contradicted Australian hit is retried once as "Ford Motor Company"', async () => {
  const calls = newCalls();
  const rating = await lookupCompanyRating('Ford', deps({ calls, byName: { Ford: FORD_AU, 'Ford Motor Company': FORD_MOTOR } }));

  assert.deepEqual(calls.rapid, ['Ford', 'Ford Motor Company']);
  assert.equal(rating.overall, 4.1);
  assert.equal(rating.reviewCount, 21000);
  assert.equal(rating.glassdoorContradicted, undefined);
  // The label came from the headcount lookup the check already made: one search, one entity read.
  assert.deepEqual(calls.wikidata, ['wbsearchentities', 'wbgetentities']);
});

test('the retry outcome is cached: a success is not repeated', async () => {
  const cache = new MemoryCache();
  await lookupCompanyRating('Ford', deps({ cache, calls: newCalls(), byName: { Ford: FORD_AU, 'Ford Motor Company': FORD_MOTOR } }));

  const again = newCalls();
  const rating = await lookupCompanyRating('Ford', deps({ cache, calls: again, byName: { Ford: FORD_AU, 'Ford Motor Company': FORD_MOTOR } }));
  assert.deepEqual(again.rapid, []);
  assert.equal(rating.overall, 4.1);
});

test('the retry outcome is cached: a failure is not repeated', async () => {
  const cache = new MemoryCache();
  const first = newCalls();
  const rating = await lookupCompanyRating('Ford', deps({ cache, calls: first, byName: { Ford: FORD_AU } }));
  assert.deepEqual(first.rapid, ['Ford', 'Ford Motor Company']);
  assert.equal(rating.overall, null);

  const again = newCalls();
  await lookupCompanyRating('Ford', deps({ cache, calls: again, byName: { Ford: FORD_AU } }));
  assert.deepEqual(again.rapid, []);
});

test('a retried hit that is weak is not used', async () => {
  const calls = newCalls();
  const empty = { ...FORD_MOTOR, ratings: { overall: null }, counts: { reviews: 0, open_jobs: 0 } };
  const rating = await lookupCompanyRating('Ford', deps({ calls, byName: { Ford: FORD_AU, 'Ford Motor Company': empty } }));

  assert.deepEqual(calls.rapid, ['Ford', 'Ford Motor Company']);
  assert.equal(rating.overall, null);
});

test('a retried hit for a different name fails the name check and is not used', async () => {
  const calls = newCalls();
  const other = { ...FORD_MOTOR, name: 'Ford Motor Credit Company Holdings Australia' };
  const rating = await lookupCompanyRating('Ford', deps({ calls, byName: { Ford: FORD_AU, 'Ford Motor Company': other } }));

  assert.deepEqual(calls.rapid, ['Ford', 'Ford Motor Company']);
  assert.equal(rating.overall, null);
});

test('a retried hit that Wikidata also contradicts by 10x is not used', async () => {
  const calls = newCalls();
  const small = { ...FORD_MOTOR, size: '501 to 1000 Employees' };
  const rating = await lookupCompanyRating('Ford', deps({ calls, byName: { Ford: FORD_AU, 'Ford Motor Company': small } }));

  assert.deepEqual(calls.rapid, ['Ford', 'Ford Motor Company']);
  assert.equal(rating.overall, null);
  assert.equal(rating.employees, 186000);
});

test('a name-check rejection is also retried under the label', async () => {
  const calls = newCalls();
  const rejected = { ...FORD_AU, name: 'Ford Australia Logistics' };
  const rating = await lookupCompanyRating('Ford', deps({ calls, byName: { Ford: rejected, 'Ford Motor Company': FORD_MOTOR } }));

  assert.equal(calls.rapid[0], 'Ford');
  assert.equal(calls.rapid.at(-1), 'Ford Motor Company');
  assert.equal(calls.rapid.filter((name) => name === 'Ford Motor Company').length, 1);
  assert.equal(rating.overall, 4.1);
});

test('no retry when Wikidata gave no label in this check', async () => {
  // With no Wikidata entity there is no headcount either, so only a name-check
  // rejection can reach the retry. It has no label to use.
  const calls = newCalls();
  const rejected = { ...FORD_AU, name: 'Ford Australia Logistics' };
  const rating = await lookupCompanyRating('Ford', deps({ calls, label: '', byName: { Ford: rejected, 'Ford Motor Company': FORD_MOTOR } }));

  assert.deepEqual(calls.rapid, ['Ford']);
  assert.equal(rating.overall, null);
});

test('no retry when the label is the name already tried, or does not contain the company name', async () => {
  const same = newCalls();
  await lookupCompanyRating('Ford', deps({ calls: same, label: 'Ford', byName: { Ford: FORD_AU } }));
  assert.deepEqual(same.rapid, ['Ford']);

  const unrelated = newCalls();
  await lookupCompanyRating('Ford', deps({ calls: unrelated, label: 'Lincoln Motor Company', byName: { Ford: FORD_AU } }));
  assert.deepEqual(unrelated.rapid, ['Ford']);
});

test('a correct first match makes no extra calls', async () => {
  const calls = newCalls();
  const rating = await lookupCompanyRating('Ford Motor Company', deps({ calls, byName: { 'Ford Motor Company': FORD_MOTOR } }));

  assert.deepEqual(calls.rapid, ['Ford Motor Company']);
  assert.equal(rating.overall, 4.1);
});
