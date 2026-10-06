import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { analyzeJobPosting, companySizeLine } from '../lib/server/analyze.js';
import { HOURLY_REQUEST_LIMIT } from '../lib/server/rateLimit.js';
import {
  MARKET_RETRY_TTL_MS,
  MARKET_TTL_MS,
  comparePostedPay,
  createPayVsMarketHandler,
  lookupPayVsMarket,
  marketCacheKey
} from '../lib/server/pay-market.js';

const require = createRequire(import.meta.url);
const pay = require('../lib/pay.cjs');

const NOW = new Date('2026-10-06T12:00:00Z');
const ESTIMATE = JSON.parse(readFileSync(new URL('./fixtures/salary/estimate.software-engineer.new-york.json', import.meta.url), 'utf8'));
const COMPANY = JSON.parse(readFileSync(new URL('./fixtures/salary/company-salaries.json', import.meta.url), 'utf8'));

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test('posted pay parses ranges, k, hourly, monthly, equity, and non-USD', () => {
  const range = pay.parsePostedPay('$130k - $160k + equity');
  assert.equal(range.comparable, true);
  assert.equal(range.equity, true);
  assert.equal(range.annualMin, 130000);
  assert.equal(range.annualMax, 160000);
  assert.equal(range.listed, 'Listed $130-160K');

  const worded = pay.parsePostedPay('$130,000 to $160,000 a year plus bonus');
  assert.equal(worded.bonus, true);
  assert.equal(worded.annualMin, 130000);
  assert.equal(worded.midpoint, 145000);

  const dash = pay.parsePostedPay('130–160k');
  assert.equal(dash.annualMin, 130000);
  assert.equal(dash.annualMax, 160000);

  const hourly = pay.parsePostedPay('$45 - $55/hr');
  assert.equal(hourly.period, 'hourly');
  assert.equal(hourly.annualMin, 45 * 2080);
  assert.equal(hourly.annualMax, 55 * 2080);
  assert.equal(hourly.comparable, true);

  const monthly = pay.parsePostedPay('$8,000 to $10,000 per month');
  assert.equal(monthly.period, 'monthly');
  assert.equal(monthly.annualMin, 96000);
  assert.equal(monthly.annualMax, 120000);

  const contract = pay.parsePostedPay('$70/hr contract');
  assert.equal(contract.comparable, false);
  assert.equal(contract.reason, 'contract');
  assert.match(contract.listed, /Listed \$70\/hr/);

  const pounds = pay.parsePostedPay('£130k - £160k');
  assert.equal(pounds.comparable, false);
  assert.equal(pounds.reason, 'currency');
  assert.equal(pounds.currency, 'GBP');
});

test('the market fixture compares base pay, and a weak title or thin sample does not', () => {
  const posted = pay.parsePostedPay('$130,000 - $160,000');
  const compared = comparePostedPay(posted, ESTIMATE, 'Software Engineer', 'New York, NY');

  assert.equal(compared.compared, true);
  assert.equal(compared.note, 'within the range');
  assert.equal(compared.median, 125890.97);
  assert.match(compared.text, /Listed \$130-160K · Market median \$126K for this title in New York, NY \(50,621 reports\)/);
  assert.notEqual(compared.median, ESTIMATE.total_pay.p50);

  const below = comparePostedPay(pay.parsePostedPay('$80,000'), ESTIMATE, 'Software Engineer', 'New York, NY');
  assert.equal(below.note, 'below the 25th percentile');
  const above = comparePostedPay(pay.parsePostedPay('$200,000'), ESTIMATE, 'Software Engineer', 'New York, NY');
  assert.equal(above.note, 'above the 75th');

  const weak = comparePostedPay(posted, ESTIMATE, 'Data Scientist', 'New York, NY');
  assert.equal(weak.compared, false);
  assert.equal(weak.reason, 'title');
  assert.equal(weak.text, 'Listed $130-160K');

  const thin = comparePostedPay(posted, { ...ESTIMATE, salaries_count: 10 }, 'Software Engineer', 'New York, NY');
  assert.equal(thin.reason, 'sample');
  const unsure = comparePostedPay(posted, { ...ESTIMATE, confidence: 'low' }, 'Software Engineer', 'New York, NY');
  assert.equal(unsure.reason, 'confidence');
});

test('company salary rows are read from base pay, not total pay', () => {
  const base = pay.companyBasePay(COMPANY, 'Software Engineer');

  assert.equal(base.p50, 184722.83);
  assert.ok(base.p50 < COMPANY.salaries[0].total_pay.p50);
  assert.equal(pay.companyBasePay(COMPANY, 'Senior Software Engineer').p50, 231325.27);
  assert.equal(pay.companyBasePay(COMPANY, 'Data Scientist'), null);
});

test('the market cache is title, location, and experience, 14 days for a hit and 5 minutes for a failure', async () => {
  assert.equal(
    marketCacheKey('Software Engineer', 'New York, NY', 'all'),
    marketCacheKey('software engineer', 'new york ny')
  );
  assert.notEqual(
    marketCacheKey('Software Engineer', 'New York, NY', 'all'),
    marketCacheKey('Software Engineer', 'New York, NY', 'four_to_six')
  );
  assert.equal(marketCacheKey('Software Engineer', 'New York, NY').includes('capital'), false);

  const cache = new MemoryCache();
  const calls = [];
  const deps = {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: 'rapid-test' },
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse(200, ESTIMATE);
    }
  };
  const first = await lookupPayVsMarket({
    title: 'Software Engineer',
    location: 'New York, NY',
    salary: '$130k-$160k'
  }, deps);
  const second = await lookupPayVsMarket({
    title: 'Software Engineer',
    location: 'New York, NY',
    salary: '$90,000',
    company: 'Capital One'
  }, deps);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/salaries\/estimate\?/);
  assert.match(calls[0], /job_title=Software\+Engineer/);
  assert.match(calls[0], /location=New\+York%2C\+NY/);
  assert.match(calls[0], /years_of_experience=all/);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.note, 'below the 25th percentile');
  const stored = await cache.getMeta(marketCacheKey('Software Engineer', 'New York, NY'), NOW);
  assert.equal(stored.payload.estimate.base_pay.p50, 125890.97);
  assert.equal(await cache.get(marketCacheKey('Software Engineer', 'New York, NY'), new Date(NOW.getTime() + MARKET_TTL_MS + 1000)), null);

  const failed = new MemoryCache();
  let quotaCalls = 0;
  const quotaDeps = {
    now: NOW,
    cache: failed,
    env: { RAPIDAPI_KEY: 'rapid-test' },
    fetch: async () => {
      quotaCalls += 1;
      return jsonResponse(429, { message: 'quota' });
    }
  };
  const blocked = await lookupPayVsMarket({ title: 'Software Engineer', location: 'Hartford, CT', salary: '$130k' }, quotaDeps);
  await lookupPayVsMarket({ title: 'Software Engineer', location: 'Hartford, CT', salary: '$130k' }, quotaDeps);

  assert.equal(blocked.compared, false);
  assert.equal(blocked.text, 'Listed $130K');
  assert.equal(quotaCalls, 1);
  assert.equal(
    await failed.get(marketCacheKey('Software Engineer', 'Hartford, CT'), new Date(NOW.getTime() + MARKET_RETRY_TTL_MS + 1000)),
    null
  );
});

test('stated years select a Glassdoor band, and seniority without years is not compared', async () => {
  assert.equal(pay.experienceChoice('Software Engineer', 'Build services.').bucket, 'all');
  assert.equal(pay.experienceChoice('Engineering Leadership', 'Build services.').bucket, 'all');
  assert.equal(pay.experienceChoice('Software Engineer', '5 years of experience').bucket, 'four_to_six');
  assert.equal(pay.experienceChoice('Software Engineer', '3-5 years of experience').bucket, 'one_to_three');
  assert.equal(pay.experienceChoice('Software Engineer', 'less than 1 year of experience').bucket, 'less_than_one');
  assert.equal(pay.experienceChoice('Software Engineer', '1 year of experience').bucket, 'one_to_three');
  assert.equal(pay.experienceChoice('Software Engineer', '8+ years of experience').bucket, 'seven_to_nine');
  assert.equal(pay.experienceChoice('Software Engineer', '10 years of experience').bucket, 'ten_to_fourteen');
  assert.equal(pay.experienceChoice('Software Engineer', '15+ years of experience').bucket, 'above_fifteen');
  assert.equal(pay.experienceChoice('Software Engineer', 'The firm is 10 years old.').bucket, 'all');

  for (const title of ['Senior Engineer', 'Staff Engineer', 'Lead Engineer', 'Principal Engineer', 'Junior Engineer', 'Associate Engineer', 'Engineering Intern']) {
    const choice = pay.experienceChoice(title, 'Build services for customers.');
    assert.equal(choice.skip, true, title);
    assert.equal(choice.reason, 'seniority');
  }

  assert.equal(pay.experienceChoice('Senior Engineer', '7 years of experience').bucket, 'seven_to_nine');

  const calls = [];
  const deps = {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: 'rapid-test' },
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse(200, ESTIMATE);
    }
  };
  const senior = await lookupPayVsMarket({
    title: 'Senior Software Engineer',
    location: 'Hartford, CT',
    salary: '$130k-$160k',
    description: 'Own the roadmap.'
  }, deps);

  assert.equal(senior.compared, false);
  assert.equal(senior.reason, 'seniority');
  assert.equal(senior.text, 'Listed $130-160K');
  assert.equal(calls.length, 0);

  const banded = await lookupPayVsMarket({
    title: 'Software Engineer',
    location: 'New York, NY',
    salary: '$130k-$160k',
    description: '7 years of experience required.'
  }, deps);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /years_of_experience=seven_to_nine/);
  assert.equal(banded.compared, true);
  assert.equal(banded.note, 'within the range');
});

test('pay-vs-market counts against the same hourly limit', async () => {
  assert.equal(HOURLY_REQUEST_LIMIT, 300);
  const { MemoryRateLimiter } = await import('../lib/server/rateLimit.js');
  const handler = createPayVsMarketHandler({
    now: NOW,
    cache: new MemoryCache(),
    rateLimit: new MemoryRateLimiter(1),
    env: { RAPIDAPI_KEY: 'rapid-test' },
    fetch: async () => jsonResponse(200, ESTIMATE)
  });
  const headers = { 'x-ghd-client': 'ghost-job-detector', 'x-forwarded-for': '203.0.113.40' };
  const respond = () => {
    const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = JSON.parse(body); } };
    return res;
  };
  const first = respond();
  const second = respond();
  const request = () => ({
    method: 'POST',
    headers,
    body: { title: 'Software Engineer', location: 'New York, NY', salary: '$130k-$160k' }
  });

  await handler(request(), first);
  await handler(request(), second);

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.compared, true);
  assert.equal(second.statusCode, 429);
});

test('the default check shows company size and does not search for open roles or headcount', async () => {
  const queries = [];
  let groq = 0;
  const analysis = await analyzeJobPosting({
    title: 'Software Engineer',
    company: 'Northwind',
    description: 'Build services. The salary range is $130,000-$160,000.',
    salary: '$130,000-$160,000',
    url: 'https://www.linkedin.com/jobs/view/1',
    platform: 'LINKEDIN',
    location: 'Hartford, CT'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    searchNews: async () => [],
    webSearch: async (query) => {
      queries.push(query);
      return [];
    },
    askGroq: async () => {
      groq += 1;
      return '';
    },
    fetch: async () => jsonResponse(404, {}),
    lookupCompanyRating: async () => ({
      overall: 4.1,
      glassdoorSize: '501 to 1000 Employees',
      employees: 751,
      employeeLabel: '751',
      source: 'glassdoor'
    })
  });

  assert.equal(groq, 0);
  assert.equal(queries.some((query) => /employees|open jobs|myworkday|glassdoor/i.test(query)), false);
  assert.equal(analysis.factors.hiringRatio.openRoles, null);
  assert.equal(analysis.factors.hiringRatio.score, 0);
  assert.equal(analysis.factors.hiringRatio.label, '501 to 1000 Employees');
  assert.equal(analysis.careersChecked, true);
  assert.equal(analysis.careers, null);
  assert.equal(companySizeLine({
    employees: 1200,
    employeeSource: 'linkedin',
    glassdoorSize: '1001 to 5000 Employees'
  }).label, '1,200 employees');
});
