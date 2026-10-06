import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MemoryCache } from '../lib/server/cache.js';
import { ownTenantSiteNamesCompany, resolveOpenJobCount } from '../lib/server/open-jobs.js';

// Real responses captured on 2026-10-04 for
// https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers/details/AI-Operations-Engineer_423470
const fixture = (name) => readFileSync(new URL(`./fixtures/argonne/${name}`, import.meta.url), 'utf8');
const POSTING_URL = 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers/details/AI-Operations-Engineer_423470';
const cxsJob = JSON.parse(fixture('posting.cxs.json'));
const postingHtml = fixture('posting.html');
const jsonLd = JSON.parse(postingHtml.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i)[1]);

// What the browser renders into [data-automation-id="jobPostingDescription"]:
// the CXS jobDescription HTML, tags dropped and entities decoded.
function renderedText(html) {
  return String(html)
    .replace(/<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const description = renderedText(cxsJob.jobPostingInfo.jobDescription);
const signals = {
  jobTitle: jsonLd.title,
  description,
  organization: jsonLd.hiringOrganization.name,
  siteId: 'Argonne_Careers',
  pathname: '/en-US/Argonne_Careers/details/AI-Operations-Engineer_423470',
  hostname: 'argonne.wd1.myworkdayjobs.com',
  domCompany: '',
  documentTitle: jsonLd.title,
  company: 'Argonne'
};

function loadScript(file, global) {
  const sandbox = { URL, console: { ...console, info() {} }, setTimeout, AbortSignal };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8'), sandbox);
  return sandbox[global];
}

const noStorage = { cache: { get: async () => null, set: async () => {} } };

// Wikidata as the background would return it, from the real captured payloads.
function wikidataPayload(url) {
  const action = new URL(url).searchParams.get('action');
  return action === 'wbsearchentities'
    ? JSON.parse(fixture('wikidata.search.json'))
    : JSON.parse(fixture('wikidata.entity.json'));
}

test('the real posting text names Argonne National Laboratory, past the first 800 characters', () => {
  const pages = loadScript('job-page.js', 'GhdPage');

  assert.ok(description.indexOf('Argonne National Laboratory') > 800);
  assert.ok(String(jsonLd.description).includes('Argonne National Laboratory'));
  assert.equal(jsonLd.hiringOrganization.name, 'UChicago Argonne, LLC');
  assert.equal(pages.extractDescriptionCandidates(description).length, 0);
  assert.ok(pages.extractDescriptionCandidates(description, { full: true }).includes('Argonne National Laboratory'));
});

test('without a fetch the resolver keeps the bare site name, as the live content script did', async () => {
  const pages = loadScript('job-page.js', 'GhdPage');
  assert.equal(await pages.resolveCompanyIdentity(signals, noStorage), 'Argonne');
});

test('through the background Wikidata route the real posting resolves to Argonne National Laboratory', async () => {
  const pages = loadScript('job-page.js', 'GhdPage');
  const pageFetch = loadScript('page-fetch.js', 'GhdFetch');
  const sent = [];
  // Behaves like background.js WIKIDATA_JSON: allow-list first, then the read.
  const send = async (message) => {
    sent.push(message);

    if (message.type !== 'WIKIDATA_JSON' || !pageFetch.allowedWikidataUrl(message.url)) {
      return { ok: false, error: 'BLOCKED_URL' };
    }

    return { ok: true, status: 200, payload: wikidataPayload(message.url) };
  };
  const company = await pages.resolveCompanyIdentity(signals, {
    ...noStorage,
    fetch: pages.backgroundWikidataFetch({ send })
  });

  assert.equal(company, 'Argonne National Laboratory');
  assert.ok(sent.length >= 2);
  assert.ok(sent.every((message) => message.type === 'WIKIDATA_JSON'));
});

test('the background Wikidata route allows only the two read actions', () => {
  const pageFetch = loadScript('page-fetch.js', 'GhdFetch');
  const ok = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=Argonne&language=en&format=json&limit=5&origin=*';

  assert.equal(pageFetch.allowedWikidataUrl(ok), true);
  assert.equal(pageFetch.allowedWikidataUrl('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q649120&format=json'), true);
  assert.equal(pageFetch.allowedWikidataUrl(ok.replace('wbsearchentities', 'wbeditentity')), false);
  assert.equal(pageFetch.allowedWikidataUrl(ok.replace('www.wikidata.org', 'evil.example')), false);
  assert.equal(pageFetch.allowedWikidataUrl(ok.replace('https:', 'http:')), false);
  assert.equal(pageFetch.allowedWikidataUrl(ok.replace('format=json', 'format=xml')), false);
});

// The posting's own tenant, answering like the real Workday responses.
function workdayDeps(log = []) {
  return {
    now: new Date('2026-10-04T12:00:00Z'),
    cache: new MemoryCache(),
    webSearch: async () => [],
    fetch: async (url, options = {}) => {
      const href = String(url);
      log.push(href);

      if (href.includes('/wday/cxs/argonne/Argonne_Careers/jobs')) {
        return { ok: true, status: 200, json: async () => JSON.parse(fixture('board.cxs-jobs.json')) };
      }

      if (href.startsWith('https://argonne.wd1.myworkdayjobs.com/')) {
        // Workday negotiates on Accept: asking for JSON gets the empty redirect.
        const wantsJson = /application\/json/.test(String(options.headers?.Accept || ''));
        const body = wantsJson ? fixture('board.accept-json.json') : fixture('board.html');
        return { ok: true, status: 200, text: async () => body };
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  };
}

test('a detail page visible count is not used, including query-string variants', async () => {
  const urls = [
    POSTING_URL,
    `${POSTING_URL}?jobFamilyGroup=12a3cb6c735c10343a4fee7b7cc4da55`,
    `${POSTING_URL}?q=ai`
  ];

  for (const jobUrl of urls) {
    const calls = [];
    const counted = await resolveOpenJobCount('Argonne National Laboratory', {
      jobUrl,
      hostname: 'argonne.wd1.myworkdayjobs.com',
      platform: 'WORKDAY',
      onPageCount: 1,
      profile: Promise.resolve({ website: 'www.anl.gov', openJobs: 92 })
    }, workdayDeps(calls));

    assert.equal(counted.count, 91, jobUrl);
    assert.equal(counted.source, 'workday', jobUrl);
    assert.equal(calls.some((href) => href.includes('/wday/cxs/argonne/Argonne_Careers/jobs')), true, jobUrl);
  }
});

test('the posting\'s own Workday tenant gives its real CXS total (91), not the Glassdoor floor', async () => {
  for (const company of ['Argonne National Laboratory', 'Argonne']) {
    const counted = await resolveOpenJobCount(company, {
      jobUrl: POSTING_URL,
      hostname: 'argonne.wd1.myworkdayjobs.com',
      platform: 'WORKDAY',
      profile: Promise.resolve({ website: 'www.anl.gov', openJobs: 92 })
    }, workdayDeps());

    assert.equal(counted.count, 91, company);
    assert.equal(counted.source, 'workday', company);
    assert.equal(counted.lowerBound, undefined, company);
  }
});

test('own-tenant acceptance needs the site and tenant to agree; any other site word falls back', () => {
  assert.equal(ownTenantSiteNamesCompany({ tenant: 'argonne', site: 'Argonne_Careers' }, 'Argonne National Laboratory'), true);
  assert.equal(ownTenantSiteNamesCompany({ tenant: 'argonne', site: 'Argonne_Students' }, 'Argonne National Laboratory'), false);
  assert.equal(ownTenantSiteNamesCompany({ tenant: 'argonne', site: 'Fermilab_Careers' }, 'Argonne National Laboratory'), false);
  assert.equal(ownTenantSiteNamesCompany({ tenant: 'uchicago', site: 'Argonne_Careers' }, 'Argonne National Laboratory'), false);
});

test('a sub-site of the posting\'s tenant is not counted as the whole lab', async () => {
  const counted = await resolveOpenJobCount('Argonne National Laboratory', {
    jobUrl: 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Students/details/Intern_1',
    hostname: 'argonne.wd1.myworkdayjobs.com',
    platform: 'WORKDAY',
    profile: Promise.resolve({ openJobs: 92 })
  }, workdayDeps());

  // og:title "ARGONNE CAREERS" is not "Argonne National Laboratory", so the
  // strict page check still rejects it and the Glassdoor floor is used.
  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.lowerBound, true);
});

test('Workday board pages are requested as HTML, so the real og:title is what gets read', async () => {
  const requested = [];
  const deps = workdayDeps();
  const fetchImpl = deps.fetch;
  deps.fetch = async (url, options = {}) => {
    if (!String(url).includes('/wday/cxs/')) {
      requested.push(String(options.headers?.Accept || ''));
    }

    return fetchImpl(url, options);
  };

  await resolveOpenJobCount('Argonne National Laboratory', {
    jobUrl: 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Students/details/Intern_1',
    platform: 'WORKDAY',
    profile: Promise.resolve({ openJobs: 92 })
  }, deps);

  assert.ok(requested.length >= 1);
  assert.ok(requested.every((accept) => accept === 'text/html'));
});
