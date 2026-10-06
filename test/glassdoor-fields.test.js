import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { lookupCompanyRating } from '../lib/server/company-rating.js';

const NOW = new Date('2026-10-05T12:00:00Z');

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const MAYO = {
  id: 19884, name: 'Mayo Clinic', website: 'www.mayoclinic.org', size: '10000+ Employees',
  ratings: { overall: 3.7 }, counts: { reviews: 4829, open_jobs: 1360 }
};
const FORD_AU = {
  id: 10659496, name: 'Ford', website: 'elnford.com.au', size: '51 to 200 Employees',
  ratings: { overall: 3 }, counts: { reviews: 1, open_jobs: 0 }
};
const FORD_MOTOR = {
  id: 263, name: 'Ford Motor Company', website: 'https://www.ford.com', size: '10000+ Employees',
  ratings: { overall: 4.1 }, counts: { reviews: 21000, open_jobs: 1800 }
};

// The paid employee search is held open until the test releases it, so the
// test can see whether the Glassdoor fields arrived before it finished.
function setup({ byName, wikidata = null, label = '' }) {
  let release;
  const searchHeld = new Promise((resolve) => {
    release = () => resolve({ employees: 76000, employeeLabel: '76,000', sourceUrl: 'https://example.com/mayo' });
  });
  const events = [];
  const deps = {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: 'rapid-test' },
    askGroq: async () => 'UNKNOWN',
    findEmployeeCountBySearch: async () => {
      events.push('search started');
      const found = await searchHeld;
      events.push('search finished');
      return found;
    },
    onGlassdoorFields: (fields) => events.push({ fields }),
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wikidata.org')) {
        if (!wikidata) {
          return json(200, { search: [] });
        }

        return href.includes('wbsearchentities')
          ? json(200, { search: [{ id: 'Q1', label }] })
          : json(200, { entities: { Q1: { claims: { P1128: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: `+${wikidata}` } } } }] } } } });
      }

      const name = new URL(href).searchParams.get('company');
      return byName[name] ? json(200, byName[name]) : json(404, {});
    }
  };

  return { deps, events, release };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('open roles gets the Glassdoor fields before the paid employee search finishes', async () => {
  // Mayo: a 10,000+ bucket with no Wikidata figure, so the employee search runs.
  const { deps, events, release } = setup({ byName: { 'Mayo Clinic': MAYO } });
  const lookup = lookupCompanyRating('Mayo Clinic', deps);

  await settle();
  const sent = events.find((event) => event.fields);
  assert.ok(sent, 'fields should be sent while the search is still running');
  assert.deepEqual(sent.fields, { website: 'https://www.mayoclinic.org', openJobs: 1360, glassdoorSize: '10000+ Employees', overall: 3.7, reviewCount: 4829 });
  assert.ok(events.includes('search started'));
  assert.equal(events.includes('search finished'), false);

  release();
  await lookup;
  assert.equal(events.filter((event) => event.fields).length, 1, 'sent once');
});

test('a contradicted hit sends the fields only after the label retry, from the retried entity', async () => {
  const { deps, events, release } = setup({
    byName: { Ford: FORD_AU, 'Ford Motor Company': FORD_MOTOR },
    wikidata: 186000,
    label: 'Ford Motor Company'
  });
  release();
  await lookupCompanyRating('Ford', deps);

  const sent = events.filter((event) => event.fields);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].fields, { website: 'https://www.ford.com', openJobs: 1800, glassdoorSize: '10000+ Employees', overall: 4.1, reviewCount: 21000 });
});

test('a contradicted hit whose retry fails sends no Glassdoor fields', async () => {
  const { deps, events, release } = setup({ byName: { Ford: FORD_AU }, wikidata: 186000, label: 'Ford Motor Company' });
  release();
  await lookupCompanyRating('Ford', deps);

  const sent = events.filter((event) => event.fields);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].fields, { website: '', openJobs: null, glassdoorSize: '', overall: null, reviewCount: null });
});

test('no usable hit sends empty fields before the employee search finishes', async () => {
  const { deps, events, release } = setup({ byName: {} });
  const lookup = lookupCompanyRating('Mayo Clinic', deps);

  await settle();
  const sent = events.find((event) => event.fields);
  assert.ok(sent);
  assert.deepEqual(sent.fields, { website: '', openJobs: null, glassdoorSize: '', overall: null, reviewCount: null });
  assert.equal(events.includes('search finished'), false);

  release();
  await lookup;
});

test('a cached hit sends its fields before any merge work', async () => {
  const first = setup({ byName: { 'Mayo Clinic': MAYO } });
  first.release();
  await lookupCompanyRating('Mayo Clinic', first.deps);
  await settle();

  const second = setup({ byName: {} });
  const lookup = lookupCompanyRating('Mayo Clinic', { ...second.deps, cache: first.deps.cache });
  await settle();
  const sent = second.events.find((event) => event.fields);
  assert.ok(sent);
  assert.equal(sent.fields.website, 'https://www.mayoclinic.org');

  second.release();
  await lookup;
});
