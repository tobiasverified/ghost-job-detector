import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadPageHelper() {
  const sandbox = { URL, console };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL('../lib/job-page.js', import.meta.url), 'utf8'),
    sandbox
  );
  return sandbox.GhdPage;
}

function loadHeuristics() {
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'),
    sandbox
  );
  return sandbox.module.exports;
}

test('a LinkedIn keyword search is not a company-wide open-roles page', () => {
  const pages = loadPageHelper();
  const keyword = 'https://www.linkedin.com/jobs/search?keywords=AI%20Engineer&currentJobId=1';
  const companyJobs = 'https://www.linkedin.com/jobs/tko-group-holdings-jobs-worldwide';
  const filtered = 'https://www.linkedin.com/jobs/search?keywords=product&f_C=1441';

  assert.equal(pages.linkedInOpenJobsScoped(keyword, {
    company: 'TKO Group Holdings',
    allResultsMatch: true
  }), false);
  assert.equal(pages.linkedInOpenJobsScoped(companyJobs, {
    company: 'TKO Group Holdings'
  }), true);
  assert.equal(pages.linkedInOpenJobsScoped(filtered, {
    company: 'TKO Group Holdings',
    companyId: '1441'
  }), true);
  assert.equal(pages.linkedInOpenJobsScoped(filtered, {
    company: 'TKO Group Holdings',
    companyId: '999'
  }), false);
  assert.equal(pages.linkedInOpenJobsScoped('https://www.linkedin.com/jobs/search?currentJobId=1', {
    company: 'TKO Group Holdings',
    allResultsMatch: true
  }), true);
});

test('LinkedIn search URLs stay search pages even with currentJobId', () => {
  const pages = loadPageHelper();
  const page = pages.parseJobPage(
    'https://www.linkedin.com/jobs/search?keywords=AI%2BEngineer&location=United%2BStates&geoId=103644278&f_TPR=r86400&activeFilter=f_TPR&f_EA=true&position=6&pageNum=0&currentJobId=4471674468'
  );

  assert.equal(page.supported, true);
  assert.equal(page.platform, 'linkedin');
  assert.equal(page.kind, 'search');
  assert.equal(page.jobId, '4471674468');
  assert.equal(
    pages.jobIdFromJobHref(
      'https://www.linkedin.com/jobs/view/lead-ai-machine-learning-engineer-at-sherwin-williams-4472202393'
    ),
    '4472202393'
  );
  assert.equal(pages.jobIdFromEntityUrn('urn:li:jobPosting:4472202393'), '4472202393');
  assert.ok(pages.LINKEDIN_DETAIL_SELECTORS.includes('.two-pane-serp-page__detail-view'));
  assert.equal(
    JSON.stringify(pages.extractLinkedInJobUrls(
      'href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2Fsr-full-stack-member-of-technical-staff-at-axon-4407464505"'
    )),
    JSON.stringify([{
      url: 'https://www.linkedin.com/jobs/view/sr-full-stack-member-of-technical-staff-at-axon-4407464505',
      jobId: '4407464505'
    }])
  );
  assert.equal(
    JSON.stringify(pages.scriptFilesFor(page)),
    JSON.stringify(['lib/company-headcount.js', 'lib/job-page.js', 'lib/heuristics.js', 'lib/widget.js', 'content.js'])
  );
});

test('LinkedIn cards use the company line, not the location line', () => {
  const pages = loadPageHelper();
  const parsed = pages.parseLinkedInCardText([
    'Promoted',
    'Lead AI / Machine Learning Engineer',
    'Sherwin-Williams',
    'Cleveland, OH (Hybrid)',
    '1 week ago',
    'Easy Apply'
  ].join('\n'));

  assert.equal(parsed.title, 'Lead AI / Machine Learning Engineer');
  assert.equal(parsed.company, 'Sherwin-Williams');
});

test('Workday details pages use the company, not Careers Home', () => {
  const pages = loadPageHelper();
  const page = pages.parseJobPage(
    'https://amli.wd5.myworkdayjobs.com/en-US/AMLI_Careers/details/Transactions---Risk-Coordinator_R-101072'
  );
  const company = pages.companyFromWorkdaySignals({
    jobTitle: 'Transactions & Risk Coordinator',
    description: 'AMLI Residential | Legal & Risk Management Department',
    organization: '00205 AMLI Management Company',
    siteId: 'AMLI_Careers',
    pathname: '/en-US/AMLI_Careers/details/Transactions---Risk-Coordinator_R-101072',
    hostname: 'amli.wd5.myworkdayjobs.com',
    domCompany: 'Careers Home',
    documentTitle: 'Transactions & Risk Coordinator | Careers Home'
  });

  assert.equal(page.kind, 'detail');
  assert.equal(company, 'AMLI Residential');
  assert.equal(pages.DEFAULT_API_BASE, 'https://ghost-job-detector-nine.vercel.app');
});

test('Sony Workday branding wins over a long legal-entity organization name', () => {
  const pages = loadPageHelper();
  const company = pages.companyFromWorkdaySignals({
    jobTitle: 'Senior Data Engineer',
    description: 'Design and operate data pipelines for the engagement platform, including warehouse models, partner feeds, and production support across several Sony businesses.',
    organization: 'Sony Engagement Platform Services, LLC',
    siteId: 'SonyGlobalCareers',
    pathname: '/en-US/SonyGlobalCareers/job/Senior-Data-Engineer_JR-000000',
    hostname: 'sonyglobal.wd1.myworkdayjobs.com',
    domCompany: '',
    documentTitle: 'Senior Data Engineer'
  });

  assert.equal(company, 'Sony Global');
  assert.equal(company.includes('Engagement'), false);

  const divisionOnly = pages.companyFromWorkdaySignals({
    jobTitle: 'Senior Data Engineer',
    description: 'Design and operate data pipelines for the engagement platform, including warehouse models, partner feeds, and production support across several Sony businesses.',
    organization: 'Sony Engagement Platform Services, LLC',
    siteId: '',
    pathname: '/job/Senior-Data-Engineer',
    hostname: 'example.com',
    domCompany: '',
    documentTitle: 'Senior Data Engineer'
  });

  assert.equal(divisionOnly, '');
});

test('camelCase site ids split before careers cleanup', () => {
  const pages = loadPageHelper();
  const sony = pages.companyFromWorkdaySignals({
    jobTitle: 'Senior Data Engineer',
    siteId: 'SonyGlobalCareers'
  });
  const amli = pages.companyFromWorkdaySignals({
    jobTitle: 'Transactions & Risk Coordinator',
    siteId: 'amli_careers'
  });

  assert.equal(sony, 'Sony Global');
  assert.equal(amli, 'amli');
});

test('TKO headings stop before the company name, and UMiami still extracts', () => {
  const pages = loadPageHelper();
  const sentences = [
    'Who We Are TKO Group Holdings, Inc. (NYSE: TKO) is a premium sports and entertainment company. TKO owns iconic properties including UFC, the world’s premier mixed martial arts organization; WWE, the global leader in sports entertainment; and PBR, the world’s premier bull riding organization.',
    'Who We Are: TKO Group Holdings, Inc. (NYSE: TKO) is a premium sports and entertainment company. TKO owns iconic properties including UFC, the world’s premier mixed martial arts organization; WWE, the global leader in sports entertainment; and PBR, the world’s premier bull riding organization.',
    'I. About TKO: TKO Group Holdings, Inc. (NYSE: TKO) is a premium sports and entertainment company that comprises UFC, the world’s premier mixed martial arts organization, and WWE, an integrated media organization and the recognized global leader in sports entertainment.'
  ];

  for (const sentence of sentences) {
    const candidates = pages.extractDescriptionCandidates(sentence);
    assert.equal(candidates.some((candidate) => /^TKO Group Holdings\b/.test(candidate)), true, candidates.join(' | '));
    assert.equal(candidates.some((candidate) => /Who We Are|About TKO|I About/.test(candidate)), false, candidates.join(' | '));
  }

  const miami = pages.extractDescriptionCandidates(
    'The University of Miami Health System ("UHealth") provides patient care across Miami-Dade.'
  );
  assert.equal(miami.includes('University of Miami Health System'), true);
  assert.equal(miami.includes('UHealth'), true);

  const hyphenated = pages.extractDescriptionCandidates(
    'The UHealth-University of Miami Health System IT Department has an opportunity for a full-time AI Security Engineer Specialist.'
  );
  assert.equal(
    hyphenated.some((candidate) => candidate === 'University of Miami' || candidate === 'University of Miami Health System'),
    true,
    hyphenated.join(' | ')
  );
});

test('UMiami description phrases resolve to the Wikidata label, not the site acronym', async () => {
  const pages = loadPageHelper();
  const description = 'The University of Miami Health System ("UHealth") provides patient care across Miami-Dade.';
  const candidates = pages.extractDescriptionCandidates(description);
  const cache = new Map();
  const calls = [];
  const deps = {
    now: new Date('2026-09-30T12:00:00Z'),
    cache: {
      async get(key) {
        return cache.get(key) || null;
      },
      async set(key, value) {
        cache.set(key, value);
      }
    },
    fetch: async (url) => {
      const href = String(url);
      calls.push(href);
      const params = new URL(href).searchParams;
      const search = params.get('search');
      const ids = params.get('ids');

      if (search === 'University of Miami Health System') {
        return {
          ok: true,
          async json() {
            return { search: [{ id: 'Q30281730', label: 'University of Miami Health System' }] };
          }
        };
      }

      if (search === 'University of Miami') {
        return {
          ok: true,
          async json() {
            return { search: [{ id: 'Q738258', label: 'University of Miami' }] };
          }
        };
      }

      if (ids === 'Q30281730') {
        return {
          ok: true,
          async json() {
            return {
              entities: {
                Q30281730: {
                  labels: { en: { value: 'University of Miami Health System' } },
                  aliases: { en: [] }
                }
              }
            };
          }
        };
      }

      if (ids === 'Q738258') {
        return {
          ok: true,
          async json() {
            return {
              entities: {
                Q738258: {
                  labels: { en: { value: 'University of Miami' } },
                  aliases: {
                    en: [
                      { value: 'UM' },
                      { value: 'U of M' },
                      { value: 'The U' },
                      { value: 'U Miami (FL)' }
                    ]
                  }
                }
              }
            };
          }
        };
      }

      throw new Error(`unexpected Wikidata request ${href}`);
    }
  };
  const signals = {
    jobTitle: 'Epic Senior Analyst, HB',
    description,
    siteId: 'UMCareerStaff',
    hostname: 'umiami.wd1.myworkdayjobs.com',
    pathname: '/en-US/UMCareerStaff/details/Epic-Senior-Analyst--HB_R100099322'
  };

  assert.equal(candidates.includes('University of Miami Health System'), true);
  assert.equal(candidates.includes('UHealth'), true);

  const company = await pages.resolveCompanyIdentity(signals, deps);
  const again = await pages.resolveCompanyIdentity(signals, deps);

  assert.equal(company, 'University of Miami');
  assert.equal(again, 'University of Miami');
  assert.equal(company === 'UM' || company === 'University of Miami Health System', false);
  const searched = calls.map((url) => new URL(url).searchParams.get('search')).filter(Boolean);
  assert.deepEqual(searched, ['University of Miami Health System', 'University of Miami']);
  assert.equal(calls.some((url) => new URL(url).searchParams.get('ids') === 'Q738258'), true);
  assert.equal(calls.some((url) => /[?&]search=UM(?:&|$)/.test(url) || url.includes('search=UHealth')), false);

  const sony = await pages.resolveCompanyIdentity({
    jobTitle: 'Senior Data Engineer',
    description: 'Design and operate data pipelines.',
    siteId: 'SonyGlobalCareers',
    hostname: 'sonyglobal.wd1.myworkdayjobs.com'
  }, {
    fetch: async () => {
      throw new Error('a normal company name should not query Wikidata');
    }
  });

  assert.equal(sony, 'Sony Global');
});

test('a stub description retries identity resolution until the organization phrase is present', async () => {
  const pages = loadPageHelper();
  const real = `${'The University of Miami Health System ("UHealth") provides patient care across Miami-Dade. '}${'Clinical systems support for Epic analysts. '.repeat(6)}`;
  const reads = ['Loading job details.', real];
  let readIndex = 0;
  const calls = [];
  const logs = [];
  const waits = [];
  const result = await pages.resolveCompanyIdentityWhenReady(async () => ({
    jobTitle: 'Epic Senior Analyst, HB',
    description: reads[Math.min(readIndex, reads.length - 1)],
    siteId: 'UMCareerStaff',
    hostname: 'umiami.wd1.myworkdayjobs.com',
    pathname: '/en-US/UMCareerStaff/details/Epic-Senior-Analyst--HB_R100099322',
    company: 'UMCareer Staff'
  }), {
    retryAtMs: [1000, 3000, 6000],
    sleep: async (ms) => {
      waits.push(ms);
      readIndex += 1;
    },
    log: (message) => logs.push(message),
    fetch: async (url) => {
      calls.push(String(url));

      if (String(url).includes('wbsearchentities')) {
        return {
          ok: true,
          async json() {
            return { search: [{ id: 'Q738258', label: 'University of Miami' }] };
          }
        };
      }

      return {
        ok: true,
        async json() {
          return {
            entities: {
              Q738258: {
                labels: { en: { value: 'University of Miami' } },
                aliases: { en: [{ value: 'UMiami' }] }
              }
            }
          };
        }
      };
    }
  });

  assert.equal(pages.identityInputReady('Loading job details.', 'UMCareer Staff'), false);
  assert.equal(pages.identityInputReady(real, 'UMCareer Staff'), true);
  assert.equal(result.ready, true);
  assert.equal(result.company, 'University of Miami');
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(logs, [`[GHD] company identity retry 1/3, description length: ${real.trim().length}`]);
  assert.equal(calls.length, 2);
});

test('a LinkedIn stub description retries identity resolution before naming TKO', async () => {
  const pages = loadPageHelper();
  const real = `${'TKO Group Holdings is hiring a coordinator for live events and productions. '.repeat(6)}`;
  const reads = ['Loading job details.', real];
  let readIndex = 0;
  const logs = [];
  const waits = [];
  let resolves = 0;
  const result = await pages.resolveCompanyIdentityWhenReady(async () => ({
    company: 'TKO',
    rawName: 'TKO',
    description: reads[Math.min(readIndex, reads.length - 1)],
    hostname: 'www.linkedin.com',
    platform: 'LINKEDIN',
    slug: 'tko'
  }), {
    retryAtMs: [1000, 3000, 6000],
    sleep: async (ms) => {
      waits.push(ms);
      readIndex += 1;
    },
    log: (message) => logs.push(message),
    resolve: async (signals) => {
      resolves += 1;
      assert.match(signals.description, /TKO Group Holdings/);
      return 'TKO Group Holdings';
    }
  });

  assert.equal(pages.identityInputReady('Loading job details.', 'TKO'), false);
  assert.equal(pages.identityInputReady(real, 'TKO'), true);
  assert.equal(result.ready, true);
  assert.equal(result.company, 'TKO Group Holdings');
  assert.equal(resolves, 1);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(logs, [`[GHD] company identity retry 1/3, description length: ${real.trim().length}`]);
});

test('a failed company-identity request keeps the local name', async () => {
  const pages = loadPageHelper();
  const company = await pages.requestCompanyIdentity({
    rawName: 'TKO',
    description: 'TKO Group Holdings is hiring.',
    hostname: 'www.linkedin.com',
    platform: 'LINKEDIN',
    slug: 'tko'
  }, {
    fetch: async () => {
      throw new Error('network down');
    }
  });

  assert.equal(company, 'TKO');
});

test('company identity goes through the background worker, not a page-origin fetch', async () => {
  const pages = loadPageHelper();
  const sent = [];
  const company = await pages.requestCompanyIdentity({
    rawName: 'TKO',
    description: 'TKO Group Holdings, Inc is hiring.',
    hostname: 'www.linkedin.com',
    platform: 'LINKEDIN',
    slug: 'tkogroup'
  }, {
    send: async (message) => {
      sent.push(message);
      return { ok: true, payload: { company: 'TKO Group Holdings' } };
    }
  });

  assert.equal(company, 'TKO Group Holdings');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'RESOLVE_COMPANY_IDENTITY');
  assert.equal(sent[0].body.slug, 'tkogroup');
});

test('a failed background identity reply keeps the local name', async () => {
  const pages = loadPageHelper();
  const company = await pages.requestCompanyIdentity({ rawName: 'TKO' }, {
    send: async () => ({ ok: false, error: 'API_429' })
  });

  assert.equal(company, 'TKO');
});

test('Workday job URLs and DuckDuckGo links are recognized', () => {
  const pages = loadPageHelper();
  const page = pages.parseJobPage(
    'https://hyundai.wd5.myworkdayjobs.com/en-US/External/job/Santa-Fe/AI-Engineer_JR123'
  );

  assert.equal(page.platform, 'workday');
  assert.equal(page.kind, 'detail');
  assert.equal(
    pages.duckDuckGoUrl('"AI Engineer" "Hyundai" job').startsWith('https://duckduckgo.com/?q='),
    true
  );
  assert.equal(pages.companyFromPrimary('Hyundai Supernal · Santa Fe, NM'), 'Hyundai Supernal');
});

test('repost URL extraction reads DuckDuckGo redirects and direct result links', () => {
  const pages = loadPageHelper();
  const html = [
    '<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2Frole-at-axon-4407464505">Axon</a>',
    '<div data-type="web"><a class="snippet-url" href="https://www.linkedin.com/jobs/view/role-at-axon-4472040782">Current</a></div>'
  ].join('');
  const urls = pages.extractLinkedInJobUrls(html).map((item) => item.jobId).sort();

  assert.equal(JSON.stringify(urls), '["4407464505","4472040782"]');
});

test('a workday listing counts each visible opening once', () => {
  const pages = loadPageHelper();
  const count = pages.countWorkdayOpenings([
    {
      href: 'https://umiami.wd1.myworkdayjobs.com/en-US/UMCareerStaff/job/Miami/Analyst_R1',
      text: 'Analyst'
    },
    {
      href: 'https://umiami.wd1.myworkdayjobs.com/en-US/UMCareerStaff/job/Miami/Analyst_R1?q=epic',
      text: 'Analyst'
    },
    {
      href: 'https://umiami.wd1.myworkdayjobs.com/en-US/UMCareerStaff/job/Miami/Nurse_R2',
      text: 'Nurse'
    }
  ]);

  assert.equal(count, 2);
  assert.equal(pages.countWorkdayOpenings([]), null);
});

test('job location keeps remote and expands state codes', () => {
  const pages = loadPageHelper();
  const seattle = pages.normalizeJobLocation('Greater Seattle Area, WA');
  const remote = pages.normalizeJobLocation('Remote');

  assert.equal(seattle.raw, 'Greater Seattle Area, WA');
  assert.equal(seattle.normalized, 'Seattle, Washington');
  assert.equal(remote.normalized, 'Remote');
  assert.equal(pages.readJobLocation('Software Engineer\nGreater Seattle Area\nPosted 2 days ago'), 'Greater Seattle Area');
});

test('the T-Mobile top card keeps the city and drops the company prefix', () => {
  const pages = loadPageHelper();
  // Guest text for job 4474577888. The company and city are one line, with
  // a space and no middot: "T-Mobile New York, NY".
  const page = [
    'Senior Data Science Engineer',
    'T-Mobile New York, NY',
    '4 hours ago 44 applicants'
  ].join('\n');
  const found = pages.readJobLocation(page, 'T-Mobile');
  const normalized = pages.normalizeJobLocation(found, 'T-Mobile');

  assert.equal(found, 'New York, NY');
  assert.equal(normalized.normalized, 'New York, New York');
  assert.equal(pages.normalizeJobLocation('T-Mobile New York, NY', 'T-Mobile').normalized, 'New York, New York');
  assert.equal(pages.normalizeJobLocation('T-Mobile · New York, NY', 'T-Mobile').normalized, 'New York, New York');
});

test('vagueness waits for the same description length identity already requires', () => {
  const pages = loadPageHelper();
  const stub = 'About the job. We are hiring.';

  assert.equal(pages.descriptionReadyForVagueness(stub), false);
  assert.equal(pages.descriptionReadyForVagueness(`${stub} ${'x'.repeat(200)}`), true);
  assert.equal(pages.identityInputReady(stub, 'TKO Group Holdings'), false);
});

test('an empty description does not pretend the posting is vague', async () => {
  const heuristics = loadHeuristics();
  const analysis = await heuristics.analyzeJob({
    title: 'AI Engineer',
    company: 'Hyundai Supernal',
    description: '',
    employeeCountEstimate: 200,
    employeeCountLabel: '200 employees',
    openJobsCount: 80
  });

  assert.equal(analysis.evidence.vagueness.score, 0);
  assert.equal(analysis.evidence.layoff.unavailable, true);
  assert.equal(analysis.factors.some((factor) => /layoffs\.json|google\.com/i.test(JSON.stringify(factor))), false);
  assert.ok(analysis.score.score < 34);
});

test('a second widget injection keeps the open panel instead of stacking another', async () => {
  const hosts = [];

  function createElement(tag) {
    const element = {
      tag,
      id: '',
      style: {},
      textContent: '',
      innerHTML: '',
      isConnected: false,
      children: [],
      shadow: null,
      append(...nodes) {
        element.children.push(...nodes);
      },
      attachShadow() {
        element.shadow = createElement('shadow');
        return element.shadow;
      },
      querySelector(selector) {
        const pool = element.shadow ? element.shadow.children : element.children;
        return pool.find((node) => node.tag === selector) || null;
      },
      getElementById() {
        return null;
      },
      addEventListener() {},
      remove() {
        element.isConnected = false;
        const index = hosts.indexOf(element);
        if (index >= 0) {
          hosts.splice(index, 1);
        }
      }
    };
    return element;
  }

  const sandbox = {
    URL,
    console,
    hosts,
    document: {
      createElement,
      documentElement: {
        appendChild(node) {
          node.isConnected = true;
          hosts.push(node);
        }
      },
      querySelectorAll(selector) {
        if (selector === '#ghd-widget-host') {
          return hosts.filter((node) => node.id === 'ghd-widget-host');
        }
        return [];
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  const widgetSource = readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8');
  vm.runInContext(widgetSource, sandbox);

  const job = {
    title: 'Analyst',
    company: 'University of Miami',
    description: 'Patient care across the health system, with specific duties and a real location.'
  };
  await sandbox.GhdWidget.analyze(job);
  const first = sandbox.GhdWidget;
  assert.equal(hosts.length, 1);

  vm.runInContext(widgetSource, sandbox);
  await sandbox.GhdWidget.analyze({
    ...job,
    title: 'Second Analyst'
  });

  assert.equal(sandbox.GhdWidget, first);
  assert.equal(hosts.length, 1);
});

test('heuristics.js can be injected twice without redeclaring its constants', () => {
  const source = readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8');
  const sandbox = { console, globalThis: {} };
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const first = sandbox.module.exports.calculateGhostScore;
  vm.runInContext(source, sandbox);

  assert.equal(typeof first, 'function');
  assert.equal(sandbox.module.exports.calculateGhostScore, first);
  assert.equal(sandbox.__GHD_HEURISTICS__, true);
});
