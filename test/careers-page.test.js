import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import {
  CAREERS_PAGE_LIMITS,
  careersLinks,
  careersPageSignal,
  domainMatchesCompany,
  isPublicAddress,
  parseCompanyWebsite,
  registrableDomain
} from '../lib/server/careers-page.js';
import { parseAtsBoard, parseWorkdayBoard, resolveOpenJobCount } from '../lib/server/open-jobs.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const PARSERS = { parseWorkdayBoard, parseAtsBoard };

// A fake network. DNS answers from a table; each request records the options it
// was made with and answers from a page table (status, headers, body chunks).
function network({ dns = {}, pages = {}, log = { lookups: [], requests: [], destroyed: 0, chunksSent: 0 } }) {
  return {
    log,
    careersLookup: async (name) => {
      log.lookups.push(name);
      const records = dns[name];

      if (!records) {
        throw new Error('ENOTFOUND');
      }

      return records;
    },
    careersRequest: (options, onResponse) => {
      const req = new EventEmitter();
      req.destroy = (error) => {
        if (error) {
          req.emit('error', error);
        }
      };
      req.end = () => {
        // What address would this connection use? Ask the lookup it was given.
        options.lookup(options.hostname, {}, (error, address) => {
          log.requests.push({ hostname: options.hostname, path: options.path, servername: options.servername, address, method: options.method, headers: options.headers });
          const page = pages[`${options.hostname}${options.path}`] || { status: 404, headers: {}, chunks: [] };
          const res = new EventEmitter();
          res.statusCode = page.status;
          res.headers = page.headers || {};
          res.resume = () => {};
          let stopped = false;
          res.destroy = () => {
            stopped = true;
            log.destroyed += 1;
          };
          onResponse(res);
          setImmediate(() => {
            for (const chunk of page.chunks || []) {
              if (stopped) {
                break;
              }

              log.chunksSent += 1;
              res.emit('data', Buffer.from(chunk));
            }

            if (!stopped) {
              res.emit('end');
            }
          });
        });
      };
      return req;
    }
  };
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const html = (body) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: [`<html><body>${body}</body></html>`] });

// --- address form ----------------------------------------------------------

test('userinfo in the website is rejected', () => {
  assert.equal(parseCompanyWebsite('https://user:secret@mayoclinic.org').error, 'userinfo in address');
  assert.equal(parseCompanyWebsite('mayoclinic.org@evil.example').error, 'userinfo in address');
});

test('decimal, hex and octal IP forms are rejected before URL parsing normalizes them', () => {
  for (const raw of ['2130706433', 'https://2130706433/', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '017700000001']) {
    assert.equal(parseCompanyWebsite(raw).error, 'numeric address form', raw);
  }
});

test('IP literals, non-https schemes and other ports are rejected', () => {
  assert.equal(parseCompanyWebsite('127.0.0.1').error, 'IP address instead of a domain');
  assert.equal(parseCompanyWebsite('https://[::1]/').error, 'IP address instead of a domain');
  assert.equal(parseCompanyWebsite('ftp://mayoclinic.org').error, 'not https');
  assert.equal(parseCompanyWebsite('https://mayoclinic.org:8443').error, 'non-standard port');
  assert.equal(parseCompanyWebsite('https://intranet.local').error, 'not a public domain');
  assert.equal(parseCompanyWebsite('http://www.mayoclinic.org').url.protocol, 'https:');
});

// --- domain match ----------------------------------------------------------

test('the domain must be the company name as its registrable label, or Wikidata\'s website', () => {
  assert.deepEqual(registrableDomain('www.mayoclinic.org'), { label: 'mayoclinic', domain: 'mayoclinic.org' });
  assert.deepEqual(registrableDomain('careers.example.co.uk'), { label: 'example', domain: 'example.co.uk' });
  assert.equal(domainMatchesCompany('www.mayoclinic.org', 'Mayo Clinic').by, 'registrable label');
  assert.equal(domainMatchesCompany('www.jhu.edu', 'Johns Hopkins University').ok, false);
  assert.equal(domainMatchesCompany('www.jhu.edu', 'Johns Hopkins University', ['https://www.jhu.edu/']).by, 'Wikidata official website');
  // A label that merely contains the company word is not the company.
  assert.equal(domainMatchesCompany('www.mayoclinicjobs.com', 'Mayo Clinic').ok, false);
  assert.equal(domainMatchesCompany('www.linkedin.com', 'LinkedIn').ok, false);
});

test('a website that is not the company\'s is never fetched', async () => {
  const net = network({ dns: { 'www.otherhospital.org': PUBLIC } });
  const result = await careersPageSignal('Mayo Clinic', 'https://www.otherhospital.org', { ...net, now: NOW }, PARSERS);

  assert.ok(result.skipped);
  assert.deepEqual(net.log.lookups, []);
  assert.deepEqual(net.log.requests, []);
});

// --- address checks and pinning ---------------------------------------------

test('only public addresses are allowed, every one the name resolves to', () => {
  assert.equal(isPublicAddress('93.184.216.34'), true);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('a name that resolves to a private address is not requested', async () => {
  const net = network({
    dns: { 'www.mayoclinic.org': [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }] }
  });
  const result = await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  assert.equal(result.failed, true);
  assert.deepEqual(net.log.requests, []);
});

test('the request connects to the validated address, with TLS and Host kept as the name', async () => {
  const net = network({
    dns: { 'www.mayoclinic.org': [{ address: '93.184.216.34', family: 4 }] },
    pages: { 'www.mayoclinic.org/': html('<a href="https://mayoclinic.wd1.myworkdayjobs.com/en-US/MayoClinic">Jobs</a>') }
  });
  await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  const [request] = net.log.requests;
  assert.equal(request.address, '93.184.216.34');
  assert.equal(request.hostname, 'www.mayoclinic.org');
  assert.equal(request.servername, 'www.mayoclinic.org');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.Cookie, undefined);
  assert.equal(request.headers.Authorization, undefined);
  // One lookup per request (the pages are read at once): the connection never
  // resolves the name again, and every request uses the validated address.
  assert.equal(net.log.lookups.length, net.log.requests.length);
  assert.ok(net.log.requests.every((item) => item.address === '93.184.216.34'));
});

test('a redirect is checked again: off the company domain, it is not followed', async () => {
  const net = network({
    dns: { 'www.mayoclinic.org': PUBLIC, 'evil.example': PUBLIC },
    pages: { 'www.mayoclinic.org/': { status: 302, headers: { location: 'https://evil.example/' }, chunks: [] } }
  });
  await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  assert.equal(net.log.requests.some((item) => item.hostname === 'evil.example'), false);
  assert.equal(net.log.lookups.includes('evil.example'), false);
});

test('a redirect to a numeric address form is rejected', async () => {
  const net = network({
    dns: { 'www.mayoclinic.org': PUBLIC },
    pages: { 'www.mayoclinic.org/': { status: 301, headers: { location: 'https://2130706433/admin' }, chunks: [] } }
  });
  await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  assert.equal(net.log.requests.length, CAREERS_PAGE_LIMITS.paths.length, 'only the company\'s own pages are requested');
  assert.ok(net.log.requests.every((item) => item.hostname === 'www.mayoclinic.org'));
});

// --- size cap and content type ---------------------------------------------

test('the size cap is enforced while the body streams in', async () => {
  const chunk = 'x'.repeat(64 * 1024);
  const chunks = Array.from({ length: 40 }, () => chunk); // 2.5 MB offered
  const net = network({
    dns: { 'www.mayoclinic.org': PUBLIC },
    pages: { 'www.mayoclinic.org/': { status: 200, headers: { 'content-type': 'text/html' }, chunks } }
  });
  await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  assert.ok(net.log.destroyed >= 1, 'the response is cut off');
  const cap = CAREERS_PAGE_LIMITS.maxBytes / chunk.length;
  assert.ok(net.log.chunksSent <= cap + 1, `read ${net.log.chunksSent} chunks; the cap is ${cap}`);
});

test('a page that is not text/html is not read', async () => {
  const net = network({
    dns: { 'www.mayoclinic.org': PUBLIC },
    pages: { 'www.mayoclinic.org/': { status: 200, headers: { 'content-type': 'application/pdf' }, chunks: ['<a href="https://mayoclinic.wd1.myworkdayjobs.com/en-US/MayoClinic">x</a>'] } }
  });
  const result = await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  assert.equal(result.board, undefined);
});

// --- what the page says ------------------------------------------------------

test('a linked Workday board is found; an unsupported system or own jobs site is recognised', async () => {
  const workday = network({
    dns: { 'www.mayoclinic.org': PUBLIC },
    pages: { 'www.mayoclinic.org/': html('<a href="https://mayoclinic.wd1.myworkdayjobs.com/en-US/MayoClinic">Jobs</a>') }
  });
  assert.equal((await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...workday, now: NOW }, PARSERS)).board.kind, 'workday');

  const icims = network({
    dns: { 'www.mayoclinic.org': PUBLIC },
    pages: { 'www.mayoclinic.org/': html('<a href="https://careers-mayoclinic.icims.com/jobs">Jobs</a>') }
  });
  assert.equal((await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...icims, now: NOW }, PARSERS)).unsupported.system, 'iCIMS');

  // The company's own jobs site is not "unsupported": Cleveland Clinic's
  // (jobs.clevelandclinic.org) fronts a Workday board the Workday search finds.
  const own = network({
    dns: { 'www.clevelandclinic.org': PUBLIC },
    pages: { 'www.clevelandclinic.org/': html('<a href="https://jobs.clevelandclinic.org/">Careers</a>') }
  });
  const ownResult = await careersPageSignal('Cleveland Clinic', 'https://www.clevelandclinic.org', { ...own, now: NOW }, PARSERS);
  assert.equal(ownResult.unsupported, undefined);
});

test('outcomes are cached for the right time: board 30 days, unsupported 7, failure 5 minutes', async () => {
  const cases = [
    [html('<a href="https://mayoclinic.wd1.myworkdayjobs.com/en-US/MayoClinic">x</a>'), 30 * 24 * 60 * 60 * 1000],
    [html('<a href="https://x.icims.com/jobs">x</a>'), 7 * 24 * 60 * 60 * 1000]
  ];

  for (const [page, ttl] of cases) {
    const cache = new MemoryCache();
    const writes = [];
    const set = cache.set.bind(cache);
    cache.set = async (key, payload, ttlMs, now) => {
      writes.push(ttlMs);
      return set(key, payload, ttlMs, now);
    };
    const net = network({ dns: { 'www.mayoclinic.org': PUBLIC }, pages: { 'www.mayoclinic.org/': page } });
    await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, cache, now: NOW }, PARSERS);
    assert.deepEqual(writes, [ttl]);
  }

  const cache = new MemoryCache();
  const writes = [];
  const set = cache.set.bind(cache);
  cache.set = async (key, payload, ttlMs, now) => {
    writes.push(ttlMs);
    return set(key, payload, ttlMs, now);
  };
  const failing = network({ dns: {} });
  await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...failing, cache, now: NOW }, PARSERS);
  assert.deepEqual(writes, [5 * 60 * 1000]);
});

test('without a network supplied, the step is skipped (no internet from tests)', async () => {
  const result = await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { now: NOW }, PARSERS);
  assert.equal(result.skipped, 'no network supplied');
});

// --- in the open-roles order ------------------------------------------------

test('open roles: a named unsupported system on the careers page skips the paid board searches', async () => {
  const searches = [];
  const net = network({
    dns: { 'www.mayoclinic.org': PUBLIC },
    pages: { 'www.mayoclinic.org/': html('<a href="https://careers-mayoclinic.icims.com/jobs">Search jobs</a>') }
  });
  const counted = await resolveOpenJobCount('Mayo Clinic', {
    profile: Promise.resolve({ website: 'https://www.mayoclinic.org', glassdoorSize: '10000+ Employees', openJobs: 1360 })
  }, {
    ...net,
    now: NOW,
    cache: new MemoryCache(),
    webSearch: async (query) => {
      searches.push(query);
      return [];
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });

  assert.equal(searches.some((query) => /myworkdayjobs|" jobs$/.test(query)), false);
  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.lowerBound, true);
});

test('the careers pages are read at the same time, not one after another', async () => {
  const net = network({ dns: { 'www.mayoclinic.org': PUBLIC } });
  const request = net.careersRequest;
  // Each page answers after 250ms.
  net.careersRequest = (options, onResponse) => {
    const req = request(options, onResponse);
    const end = req.end;
    req.end = () => setTimeout(end, 250);
    return req;
  };
  const started = Date.now();
  await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, now: NOW }, PARSERS);

  assert.equal(net.log.requests.length, CAREERS_PAGE_LIMITS.paths.length);
  assert.ok(Date.now() - started < 600, `took ${Date.now() - started}ms for three 250ms pages`);
});

test('CAREERS_PAGE_DISABLED turns the step off before any lookup', async () => {
  const { careersPageDisabled } = await import('../lib/server/careers-page.js');
  assert.equal(careersPageDisabled({ CAREERS_PAGE_DISABLED: '1' }), true);
  assert.equal(careersPageDisabled({ CAREERS_PAGE_DISABLED: 'true' }), true);
  assert.equal(careersPageDisabled({ CAREERS_PAGE_DISABLED: '0' }), false);
  assert.equal(careersPageDisabled({}), false);

  const net = network({ dns: { 'www.mayoclinic.org': PUBLIC } });
  const result = await careersPageSignal('Mayo Clinic', 'https://www.mayoclinic.org', { ...net, env: { CAREERS_PAGE_DISABLED: '1' }, now: NOW }, PARSERS);
  assert.equal(result.skipped, 'disabled by CAREERS_PAGE_DISABLED');
  assert.deepEqual(net.log.lookups, []);
  assert.deepEqual(net.log.requests, []);
});

// miami.edu loads a stylesheet from cdn.phenompeople.com. That said "Phenom" and
// skipped the Workday search, though Phenom sits over UMiami's Workday board.
test('only <a> links classify a careers page, and Phenom does not skip the searches', async () => {
  const page = '<link rel="stylesheet" href="https://cdn.phenompeople.com/x/globalstyles.css">'
    + '<script src="https://careers-x.icims.com/app.js"></script>'
    + '<a class="btn" href="https://careers.miami.edu/us/en">Search jobs</a>';
  assert.deepEqual(careersLinks(page, 'https://www.miami.edu/').map((link) => link.hostname), ['careers.miami.edu']);

  const umiami = network({
    dns: { 'www.miami.edu': PUBLIC },
    pages: { 'www.miami.edu/': html(page + '<a href="https://cdn.phenompeople.com/careers">Jobs</a>') }
  });
  const result = await careersPageSignal('University of Miami', 'https://www.miami.edu', { ...umiami, wikidataWebsites: new Map([['university of miami', ['https://www.miami.edu']]]), now: NOW }, PARSERS);
  assert.equal(result.unsupported, undefined);
  assert.equal(result.none, true);
});

// --- a Workday board linked from the company's own site ---------------------

// Live totals, 2026-10-05: target/targetcareers 2,000 (the cap),
// massgeneralbrigham/MGBExternal 2,000, umiami/UMCareerStaff 1,750. Glassdoor:
// Target 12,089, Mass General Brigham 329, University of Miami 2,083.
function linkedBoardDeps(net, totals, searches = []) {
  const fetched = [];
  return {
    fetched,
    deps: {
      ...net,
      now: NOW,
      cache: new MemoryCache(),
      webSearch: async (query) => {
        searches.push(query);
        return [];
      },
      fetch: async (url) => {
        const href = String(url);
        fetched.push(href);
        const total = Object.entries(totals).find(([path]) => href.includes(`/wday/cxs/${path}/jobs`));

        if (total) {
          return { ok: true, status: 200, json: async () => ({ total: total[1] }) };
        }

        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      }
    }
  };
}

test('Target: the Workday board its own site links is counted, with no page-name check or search', async () => {
  const net = network({
    dns: { 'www.target.com': PUBLIC },
    pages: { 'www.target.com/': html('<a href="https://target.wd5.myworkdayjobs.com/targetcareers/login?redirect=%2Ftargetcareers%2FuserHome">Sign in</a>') }
  });
  const searches = [];
  const { deps, fetched } = linkedBoardDeps(net, { 'target/targetcareers': 2000 }, searches);
  const counted = await resolveOpenJobCount('Target', {
    profile: Promise.resolve({ website: 'https://www.target.com', glassdoorSize: '10000+ Employees', openJobs: 12089 })
  }, deps);

  assert.equal(counted.workdayBoard, 'https://target.wd5.myworkdayjobs.com/targetcareers');
  // Workday stops at 2,000; Glassdoor's 12,089 is the larger floor.
  assert.equal(counted.count, 12089);
  assert.equal(counted.lowerBound, true);
  assert.equal(fetched.some((href) => href.includes('target.wd5.myworkdayjobs.com') && !href.includes('/wday/cxs/')), false);
  assert.deepEqual(searches.filter((query) => /myworkdayjobs|" jobs$/.test(query)), []);
});

test('Mass General Brigham: MGBExternal, linked from its own site, is counted', async () => {
  const net = network({
    dns: { 'www.massgeneralbrigham.org': PUBLIC },
    pages: { 'www.massgeneralbrigham.org/': html('<a href="https://massgeneralbrigham.wd1.myworkdayjobs.com/MGBExternal">Find a job</a>') }
  });
  const { deps } = linkedBoardDeps(net, { 'massgeneralbrigham/MGBExternal': 2000 });
  const counted = await resolveOpenJobCount('Mass General Brigham', {
    profile: Promise.resolve({ website: 'https://www.massgeneralbrigham.org', glassdoorSize: '10000+ Employees', openJobs: 329 })
  }, deps);

  assert.equal(counted.source, 'workday');
  assert.equal(counted.count, 2000);
  assert.equal(counted.scope, 'workday_cap');
  assert.equal(counted.url, 'https://massgeneralbrigham.wd1.myworkdayjobs.com/MGBExternal');
});

test('University of Miami: its staff-only site is still a sub-board, even linked from miami.edu', async () => {
  const net = network({
    dns: { 'www.miami.edu': PUBLIC },
    pages: { 'www.miami.edu/': html('<a href="https://umiami.wd1.myworkdayjobs.com/UMCareerStaff">Staff jobs</a>') }
  });
  const { deps, fetched } = linkedBoardDeps(net, { 'umiami/UMCareerStaff': 1750 });
  const counted = await resolveOpenJobCount('University of Miami', {
    profile: Promise.resolve({ website: 'https://www.miami.edu', glassdoorSize: '10000+ Employees', openJobs: 2083 })
  }, { ...deps, wikidataWebsites: new Map([['university of miami', ['https://www.miami.edu']]]) });

  assert.equal(fetched.some((href) => href.includes('/wday/cxs/umiami/UMCareerStaff/')), false);
  assert.equal(counted.source, 'glassdoor');
  assert.equal(counted.count, 2083);
  assert.equal(counted.lowerBound, true);
});

test('linked-board rules: compound and initial-letter site names, and a board that names someone else', async () => {
  const { workdaySiteIsSubBoard } = await import('../lib/server/open-jobs.js');
  const linked = { linkedFromOwnSite: true };
  assert.equal(workdaySiteIsSubBoard({ tenant: 'target', site: 'targetcareers' }, 'Target', linked), false);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'massgeneralbrigham', site: 'MGBExternal' }, 'Mass General Brigham', linked), false);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'umiami', site: 'UMCareerStaff' }, 'University of Miami', linked), true);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'ccf', site: 'ClevelandClinicCareersUK' }, 'Cleveland Clinic', linked), true);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'nvidia', site: 'NVIDIA_University' }, 'NVIDIA', linked), true);

  // Found by search, the site words must be the company's words exactly: no
  // joined words, no initials.
  assert.equal(workdaySiteIsSubBoard({ tenant: 'target', site: 'targetcareers' }, 'Target'), true);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'massgeneralbrigham', site: 'MGBExternal' }, 'Mass General Brigham'), true);
  assert.equal(workdaySiteIsSubBoard({ tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' }, 'NVIDIA'), false);

  // A careers page that links a partner's board does not make it the company's.
  const net = network({
    dns: { 'www.target.com': PUBLIC },
    pages: { 'www.target.com/': html('<a href="https://partnerco.wd1.myworkdayjobs.com/External">Partner jobs</a>') }
  });
  const { deps, fetched } = linkedBoardDeps(net, { 'partnerco/External': 900 });
  const counted = await resolveOpenJobCount('Target', {
    profile: Promise.resolve({ website: 'https://www.target.com', glassdoorSize: '10000+ Employees', openJobs: 12089 })
  }, deps);

  assert.equal(fetched.some((href) => href.includes('/wday/cxs/partnerco/')), false);
  assert.equal(counted.source, 'glassdoor');
});
