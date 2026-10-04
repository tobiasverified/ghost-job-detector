import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findCompanyHeadcount,
  lookupCrunchbase,
  parseWebsiteEmployees,
  rangeFromEnum
} from '../lib/server/headcount.js';

const ABOUT = `
<html><head><title>About Acme</title></head>
<body><p>Acme team size of 2,000 people keeps the company close to customers.</p></body>
</html>`;

test('Crunchbase employee enums become ranges', () => {
  assert.deepEqual(rangeFromEnum('c_01001_05000'), {
    employees: 3001,
    employeeMin: 1001,
    employeeMax: 5000,
    employeeLabel: '1,001-5,000 employees'
  });
  assert.equal(rangeFromEnum('c_10001_max').employeeMin, 10001);
  assert.equal(rangeFromEnum('c_10001_max').employeeMax, null);
});

test('a company about page yields an employee estimate', () => {
  const parsed = parseWebsiteEmployees(ABOUT, 'Acme');

  assert.equal(parsed.estimate, 2000);
  assert.equal(parsed.label, '2000 employees');
});

test('Crunchbase quota exhaustion falls through to the company site', async () => {
  const calls = [];
  const result = await findCompanyHeadcount('Acme', {
    env: { CRUNCHBASE_API_KEY: 'test-key' },
    webSearch: async () => {
      calls.push('search');
      return [];
    },
    fetch: async (url) => {
      calls.push(url);

      if (String(url).includes('crunchbase.com')) {
        return { ok: false, status: 429, json: async () => ({}), text: async () => '' };
      }

      if (String(url).includes('/about')) {
        return { ok: true, status: 200, text: async () => ABOUT, json: async () => ({}) };
      }

      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
  });

  assert.equal(result.employeeSource, 'website');
  assert.equal(result.employees, 2000);
  assert.equal(calls.includes('search'), false);
  assert.equal(calls.some((url) => String(url).includes('crunchbase.com')), true);
});

test('search snippets run before Apollo', async () => {
  const calls = [];
  const result = await findCompanyHeadcount('Acme', {
    env: { APOLLO_API_KEY: 'test-key' },
    webSearch: async () => {
      calls.push('search');
      return [{
        title: 'Acme | LinkedIn',
        snippet: 'Acme has 500 employees.',
        url: 'https://www.linkedin.com/company/acme'
      }];
    },
    fetch: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ organization: { estimated_num_employees: 9 } }),
        text: async () => '<html><title>Other</title><p>Other has 9 employees.</p></html>'
      };
    }
  });

  assert.equal(result.employeeSource, 'search');
  assert.equal(result.employees, 500);
  assert.equal(calls.includes('search'), true);
  assert.equal(calls.some((url) => url.includes('apollo.io')), false);
});

test('Apollo runs only after the other sources miss', async () => {
  const result = await findCompanyHeadcount('Acme', {
    env: { APOLLO_API_KEY: 'test-key' },
    webSearch: async () => [],
    fetch: async (url) => {
      if (String(url).includes('apollo.io')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ organization: { estimated_num_employees: 80 } }),
          text: async () => ''
        };
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });

  assert.equal(result.employeeSource, 'apollo');
  assert.equal(result.employees, 80);
});

test('lookupCrunchbase reads an organization range', async () => {
  const result = await lookupCrunchbase('Acme', {
    env: { CRUNCHBASE_API_KEY: 'test-key' },
    fetch: async (url) => {
      if (String(url).includes('autocompletes')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            entities: [{ identifier: { permalink: 'acme', value: 'Acme' } }]
          })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ properties: { num_employees_enum: 'c_00101_00250' } })
      };
    }
  });

  assert.equal(result.employeeSource, 'crunchbase');
  assert.equal(result.employeeMin, 101);
  assert.equal(result.employeeMax, 250);
  assert.equal(result.employees, 176);
});
