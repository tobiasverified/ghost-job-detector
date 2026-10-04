import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import {
  companyIdentityNames,
  findEmployeeCountBySearch,
  resultSubject,
  searchResultMatchesCompany
} from '../lib/server/employees.js';

const NOW = new Date('2026-10-01T12:00:00Z');

// Wikidata as read live on 2026-10-01: Q738258 and Q1034654 (ticker COF via P414/P249).
const UMIAMI = { company: 'University of Miami', names: ['University of Miami', 'UM', 'U of M', 'The U', 'U Miami (FL)'], tickers: [] };
const CAPITAL_ONE = { company: 'Capital One', names: ['Capital One'], tickers: ['COF'] };

// Results the production search tier cited on 2026-10-01.
const UHEALTH_REVELIO = {
  title: 'University of Miami Healt Number of Employees 2026 | Employee Count & Headcount Data | Revelio Labs',
  snippet: 'University of Miami Health System has approximately 4,625 total employees worldwide as of March 2026.',
  url: 'https://www.reveliolabs.com/companies/university-of-miami-healt/employees'
};
const COF_REVELIO = {
  title: 'Capital One Financial Number of Employees 2026 | Employee Count & Headcount Data | Revelio Labs',
  snippet: 'Capital One Financial Corp. (COF) has approximately 79,196 total employees worldwide as of March 2026.',
  url: 'https://www.reveliolabs.com/companies/capital-one-financial/employees'
};

test('the subject of a search result is read from the front of its title', () => {
  assert.equal(resultSubject(UHEALTH_REVELIO.title), 'University of Miami Healt');
  assert.equal(resultSubject(COF_REVELIO.title), 'Capital One Financial');
  assert.equal(resultSubject('Capital One Financial: Number of Employees 2012-2026 | COF'), 'Capital One Financial');
  assert.equal(resultSubject('Capital One - Wikipedia'), 'Capital One');
  assert.equal(resultSubject('University of Miami Employees, Location, Alumni'), 'University of Miami');
  assert.equal(resultSubject('Capital One Careers and Employee Benefits | US News'), 'Capital One');
});

test('a University of Miami Health System page is rejected for a University of Miami lookup', () => {
  const verdict = searchResultMatchesCompany(UHEALTH_REVELIO, UMIAMI);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.subject, 'University of Miami Healt');
});

test('the subsidiary URL alone is enough to reject a result whose title looks right', () => {
  const verdict = searchResultMatchesCompany({
    title: 'University of Miami | Headcount',
    snippet: '4,625 employees',
    url: 'https://www.reveliolabs.com/companies/university-of-miami-healt/employees'
  }, UMIAMI);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'url names a different entity');
});

test('pages about the University of Miami itself are kept', () => {
  assert.equal(searchResultMatchesCompany({
    title: 'University of Miami - Wikipedia',
    snippet: 'The University of Miami is a private research university.',
    url: 'https://en.wikipedia.org/wiki/University_of_Miami'
  }, UMIAMI).ok, true);
  assert.equal(searchResultMatchesCompany({
    title: 'University of Miami Employees, Location, Alumni',
    snippet: 'University of Miami employees on LinkedIn.',
    url: 'https://www.linkedin.com/school/university-of-miami/'
  }, UMIAMI).ok, true);
});

test('Capital One Financial is accepted for Capital One because the page cites its own ticker', () => {
  assert.equal(searchResultMatchesCompany(COF_REVELIO, CAPITAL_ONE).ok, true);
  assert.equal(searchResultMatchesCompany({
    title: 'Capital One Financial: Number of Employees 2012-2026 | COF',
    snippet: 'Capital One Financial number of employees from 2012 to 2026.',
    url: 'https://www.macrotrends.net/stocks/charts/COF/capital-one-financial/number-of-employees'
  }, CAPITAL_ONE).ok, true);
});

test('an extended name without the company ticker is rejected', () => {
  assert.equal(searchResultMatchesCompany(COF_REVELIO, { ...CAPITAL_ONE, tickers: [] }).ok, false);
  assert.equal(searchResultMatchesCompany({ ...COF_REVELIO, snippet: 'Capital One Financial has 79,196 employees.' }, CAPITAL_ONE).ok, false);
});

test('a ticker does not admit a unit name such as Health', () => {
  const verdict = searchResultMatchesCompany({
    title: 'Capital One Health Number of Employees | Revelio Labs',
    snippet: 'Capital One Health (COF unit) has 900 employees. NYSE: COF',
    url: 'https://example.com/companies/capital-one-health/employees'
  }, CAPITAL_ONE);

  assert.equal(verdict.ok, false);
});

test('the UHealth count never reaches Groq, and the rejection is cached', async () => {
  const cache = new MemoryCache();
  let searches = 0;
  let prompts = [];
  const deps = {
    now: NOW,
    cache,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    webSearch: async () => {
      searches += 1;
      return [UHEALTH_REVELIO];
    },
    askGroq: async (prompt) => {
      prompts.push(prompt);
      return 'Result 1 states 4,625 employees.';
    }
  };

  const first = await findEmployeeCountBySearch('University of Miami', deps);
  const second = await findEmployeeCountBySearch('University of Miami', deps);

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(prompts.length, 0);
  assert.equal(searches, 1);
});

test('the Capital One count is cited from the verified Revelio page', async () => {
  const entityFetch = async (url) => {
    const href = String(url);

    if (href.includes('wbsearchentities')) {
      return { ok: true, json: async () => ({ search: [{ id: 'Q1034654', label: 'Capital One' }] }) };
    }

    return {
      ok: true,
      json: async () => ({
        entities: {
          Q1034654: {
            labels: { en: { value: 'Capital One' } },
            aliases: {},
            claims: { P414: [{ qualifiers: { P249: [{ datavalue: { value: 'COF' } }] } }] }
          }
        }
      })
    };
  };
  const found = await findEmployeeCountBySearch('Capital One', {
    now: NOW,
    cache: new MemoryCache(),
    fetch: entityFetch,
    webSearch: async () => [COF_REVELIO],
    askGroq: async () => 'Result 1 states 79,196 employees.'
  });

  assert.equal(found.employees, 79196);
  assert.equal(found.sourceUrl, COF_REVELIO.url);
});

test('a Wikidata hit for a different entity contributes no names or tickers', async () => {
  const identity = await companyIdentityNames('Acme', {
    fetch: async (url) => String(url).includes('wbsearchentities')
      ? { ok: true, json: async () => ({ search: [{ id: 'Q1' }] }) }
      : {
        ok: true,
        json: async () => ({
          entities: {
            Q1: {
              labels: { en: { value: 'Acme Health System' } },
              claims: { P414: [{ qualifiers: { P249: [{ datavalue: { value: 'ACME' } }] } }] }
            }
          }
        })
      }
  });

  assert.deepEqual(identity.names, []);
  assert.deepEqual(identity.tickers, []);
});

test('a rate-limited Wikidata lookup is not cached as a company with no identity', async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const deps = {
    now: NOW,
    cache,
    fetch: async () => {
      calls += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    }
  };

  await companyIdentityNames('Capital One', deps);
  await companyIdentityNames('Capital One', deps);

  assert.equal(calls, 2);
});

test('directory pages that are about the company are not rejected over slug IDs or title wording', () => {
  assert.equal(searchResultMatchesCompany({
    title: 'Capital One Careers and Employee Benefits | US News',
    snippet: 'Capital One employs thousands.',
    url: 'https://careers.usnews.com/companies/capital-one-322351'
  }, CAPITAL_ONE).ok, true);
  assert.equal(searchResultMatchesCompany({
    title: 'Working at Capital One | Great Place To Work',
    snippet: 'Capital One employees say...',
    url: 'https://www.greatplacetowork.com/certified-company/1000049'
  }, CAPITAL_ONE).ok, true);
  assert.equal(searchResultMatchesCompany({
    title: 'University of Miami Profile | Company Directory',
    snippet: 'University of Miami company profile.',
    url: 'https://example.com/directory/university-of-miami-profile_b5c47f4ef42e0dfc'
  }, UMIAMI).ok, true);
  // A different school whose name shares every word is still rejected.
  assert.equal(searchResultMatchesCompany({
    title: 'Miami University Information - RocketReach',
    snippet: 'Miami University has 5,000 employees.',
    url: 'https://rocketreach.co/miami-university-profile_b5c6039bf42e0c56'
  }, UMIAMI).ok, false);
});

test('a contact-database profile count is rejected even when the page is about the right company', () => {
  // Cited live on 2026-10-01 as the University of Miami headcount.
  const verdict = searchResultMatchesCompany({
    title: 'University of Miami Information',
    snippet: '1,039 people are employed at University of Miami. Employees 6,563 (1,039 on RocketReach)',
    url: 'https://rocketreach.co/university-of-miami-profile_b5c47f4ef42e0dfc'
  }, UMIAMI);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.subject, 'University of Miami');
  assert.equal(verdict.reason, 'contact database count, not a headcount');
});
