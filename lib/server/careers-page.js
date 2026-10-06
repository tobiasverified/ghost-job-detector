// Reads a company's careers page for a link to its job system, before any paid
// search. The page address comes from a third party (Glassdoor's "website"
// field), so every step below treats it as untrusted:
//
//  - Only https on port 443, no userinfo ("user:pass@"), and no IP addresses in
//    any written form (dotted, decimal "2130706433", hex "0x7f000001", octal,
//    IPv6). The raw text is checked before URL parsing, which would otherwise
//    quietly turn "2130706433" into 127.0.0.1.
//  - The domain must be the company's: its registrable label equals the company
//    name ("mayoclinic.org" for Mayo Clinic), or it matches Wikidata's official
//    website for the company.
//  - The host is resolved once, every address must be public, and the request
//    connects to that validated address (no second lookup between the check and
//    the connection). Each redirect (at most 2) is checked again from the start.
//  - GET only, no cookies or credentials, 2s per page, text/html only, and the
//    512 KB cap is enforced while the body streams in.
//  - Only href values are read from the page. Its text is data, never instructions.

import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

// The real network, supplied by the API handlers. Without it (unit tests) the
// careers-page step is skipped rather than reaching the internet.
export const CAREERS_NETWORK = Object.freeze({
  careersLookup: (name) => dns.lookup(name, { all: true, verbatim: true }),
  careersRequest: https.request
});
import { cacheGet, cacheSet } from './cache.js';

export const CAREERS_PAGE_LIMITS = Object.freeze({
  timeoutMs: 2000,
  totalMs: 3500,
  maxBytes: 512 * 1024,
  maxRedirects: 2,
  paths: ['', '/careers', '/jobs']
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL = Object.freeze({
  board: 30 * DAY_MS,
  unsupported: 7 * DAY_MS,
  none: DAY_MS,
  failed: 5 * 60 * 1000
});

const USER_AGENT = 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)';

// Second-level suffixes where the registrable name is one label further in.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'co.jp', 'or.jp', 'ac.jp', 'com.br', 'com.mx', 'co.in', 'co.za', 'com.sg',
  'com.hk', 'com.cn', 'co.kr', 'com.tw', 'co.il', 'com.tr'
]);

// Social, review and job-board sites are never a company's own careers page.
const NOT_COMPANY_DOMAINS = new Set([
  'linkedin', 'facebook', 'instagram', 'twitter', 'x', 'youtube', 'glassdoor', 'indeed',
  'wikipedia', 'ziprecruiter', 'monster', 'simplyhired', 'google', 'bit'
]);

// Job systems the open-roles step cannot count. A link to one means the paid
// board and Workday searches would not find the company's board.
const UNSUPPORTED_SYSTEMS = [
  [/(^|\.)icims\.com$/i, 'iCIMS'],
  [/(^|\.)taleo\.net$/i, 'Taleo'],
  [/(^|\.)successfactors\.(com|eu)$/i, 'SuccessFactors'],
  [/(^|\.)oraclecloud\.com$/i, 'Oracle HCM'],
  [/(^|\.)smartrecruiters\.com$/i, 'SmartRecruiters'],
  [/(^|\.)jobvite\.com$/i, 'Jobvite'],
  [/(^|\.)ultipro\.com$/i, 'UKG'],
  [/(^|\.)paylocity\.com$/i, 'Paylocity'],
  [/(^|\.)brassring\.com$/i, 'BrassRing'],
  [/(^|\.)applytojob\.com$/i, 'JazzHR']
  // Not Phenom: it is a careers-site layer over another system (the University
  // of Miami's runs over its Workday board), so it does not mean the Workday
  // search would miss the board.
];

function compactWords(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

// --- address checks --------------------------------------------------------

// Raw-text checks, before any URL parsing normalizes the address.
export function rawWebsiteProblem(raw) {
  const text = String(raw || '').trim();

  if (!text) {
    return 'no website';
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const authority = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];

  if (authority.includes('@')) {
    return 'userinfo in address';
  }

  const host = authority.replace(/:\d*$/, '').replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    return 'IP address instead of a domain';
  }

  // Decimal (2130706433), hex (0x7f000001, 0x7f.0.0.1) and octal (0177.0.0.1)
  // forms all resolve to an IP address once parsed.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) {
    return 'numeric address form';
  }

  return null;
}

export function parseCompanyWebsite(raw) {
  const problem = rawWebsiteProblem(raw);

  if (problem) {
    return { error: problem };
  }

  const text = String(raw).trim();
  let url;

  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: 'not a valid address' };
  }

  // A site given as http is fetched over https; nothing else is accepted.
  if (url.protocol === 'http:') {
    url = new URL(url.href.replace(/^http:/, 'https:'));
  }

  if (url.protocol !== 'https:') {
    return { error: 'not https' };
  }

  if (url.port && url.port !== '443') {
    return { error: 'non-standard port' };
  }

  if (url.username || url.password) {
    return { error: 'userinfo in address' };
  }

  const hostname = url.hostname.toLowerCase();

  if (net.isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.')
    || /(^|\.)(localhost|local|internal|localdomain|home|lan)$/.test(hostname)) {
    return { error: 'not a public domain' };
  }

  return { url, hostname };
}

export function registrableDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);

  if (labels.length < 2) {
    return null;
  }

  const lastTwo = labels.slice(-2).join('.');
  const suffixLabels = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1;

  if (labels.length <= suffixLabels) {
    return null;
  }

  const label = labels[labels.length - suffixLabels - 1];
  return { label, domain: labels.slice(-(suffixLabels + 1)).join('.') };
}

// The website is the company's when its registrable label is the company name
// ("mayoclinic" for Mayo Clinic), or when it is the same domain as Wikidata's
// official website for the company.
export function domainMatchesCompany(hostname, company, wikidataWebsites = []) {
  const site = registrableDomain(hostname);

  if (!site || NOT_COMPANY_DOMAINS.has(site.label)) {
    return { ok: false, reason: 'not a company domain' };
  }

  if (site.label === compactWords(company)) {
    return { ok: true, by: 'registrable label' };
  }

  for (const official of wikidataWebsites || []) {
    try {
      const officialSite = registrableDomain(new URL(official).hostname);

      if (officialSite && officialSite.domain === site.domain) {
        return { ok: true, by: 'Wikidata official website' };
      }
    } catch {
      // Skip a malformed Wikidata value.
    }
  }

  return { ok: false, reason: 'domain is not the company name or its Wikidata website' };
}

// Public unicast only: no loopback, private, link-local (including the cloud
// metadata address 169.254.169.254), carrier-grade NAT, multicast or reserved.
export function isPublicAddress(address) {
  const ip = String(address || '');

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);

    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)));
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

    if (mapped) {
      return isPublicAddress(mapped[1]);
    }

    return !(lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower));
  }

  return false;
}

async function resolvePublicAddress(hostname, deps) {
  const records = await deps.careersLookup(hostname);
  const list = Array.isArray(records) ? records : [records];

  if (!list.length) {
    throw new Error('no address');
  }

  // Every address the name resolves to must be public, not just the first.
  if (list.some((record) => !isPublicAddress(record.address))) {
    throw new Error('resolves to a non-public address');
  }

  return list[0];
}

// --- the request -----------------------------------------------------------

// GET over https to the already-validated address. The TLS name and Host header
// stay the hostname, so the certificate is checked against the real name.
function requestPage(url, record, deps) {
  const request = deps.careersRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    const req = request({
      protocol: 'https:',
      hostname: url.hostname,
      servername: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Accept: 'text/html',
        'User-Agent': USER_AGENT
      },
      // Connects to the address that passed the check, never a fresh lookup.
      lookup: (hostname, options, callback) => {
        if (options?.all) {
          callback(null, [{ address: record.address, family: record.family }]);
        } else {
          callback(null, record.address, record.family);
        }
      },
      timeout: CAREERS_PAGE_LIMITS.timeoutMs
    }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400) {
        res.resume();
        finish(resolve, { status, location: res.headers?.location || '' });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        finish(resolve, { status, body: '' });
        return;
      }

      if (!/text\/html/i.test(String(res.headers?.['content-type'] || ''))) {
        res.resume();
        finish(resolve, { status, body: '', notHtml: true });
        return;
      }

      const chunks = [];
      let bytes = 0;
      let truncated = false;

      res.on('data', (chunk) => {
        if (truncated) {
          return;
        }

        const room = CAREERS_PAGE_LIMITS.maxBytes - bytes;

        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          bytes += room;
          truncated = true;
          // The cap is enforced as the body arrives: stop reading here.
          res.destroy();
          finish(resolve, { status, body: Buffer.concat(chunks).toString('utf8'), bytes, truncated: true });
          return;
        }

        chunks.push(chunk);
        bytes += chunk.length;
      });
      res.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks).toString('utf8'), bytes, truncated }));
      res.on('error', (error) => finish(reject, error));
    });

    req.on('timeout', () => {
      req.destroy(new Error('timed out'));
    });
    req.on('error', (error) => finish(reject, error));
    req.end();
  });
}

async function fetchCompanyPage(startUrl, deps) {
  let url = startUrl;

  for (let hop = 0; hop <= CAREERS_PAGE_LIMITS.maxRedirects; hop += 1) {
    const record = await resolvePublicAddress(url.hostname, deps);
    const response = await requestPage(url, record, deps);

    if (!response.location) {
      return { url, ...response };
    }

    // A redirect is checked again from the start: address form, https, port,
    // the same company domain, and a public address.
    let next;

    try {
      next = new URL(response.location, url);
    } catch {
      throw new Error('bad redirect');
    }

    const parsed = parseCompanyWebsite(next.href);

    if (parsed.error) {
      throw new Error(`redirect rejected: ${parsed.error}`);
    }

    if (registrableDomain(parsed.hostname)?.domain !== registrableDomain(startUrl.hostname)?.domain) {
      throw new Error('redirect leaves the company domain');
    }

    url = parsed.url;
  }

  throw new Error('too many redirects');
}

// --- reading the page ------------------------------------------------------

// Links people follow (<a href>) only. A stylesheet or script on a vendor's
// CDN ("cdn.phenompeople.com/...css") says who built the page, not where its
// jobs are.
export function careersLinks(html, pageUrl) {
  const links = [];
  const pattern = /<a\b[^>]*?\bhref\s*=\s*["']([^"'#\s][^"']*)["']/gi;
  let match = pattern.exec(String(html || ''));

  while (match && links.length < 2000) {
    try {
      const link = new URL(match[1], pageUrl);

      if (link.protocol === 'https:' || link.protocol === 'http:') {
        links.push(link);
      }
    } catch {
      // Ignore a malformed href.
    }

    match = pattern.exec(String(html || ''));
  }

  return links;
}

// A board this check can count beats an unsupported system on the same page.
export function classifyCareersLinks(links, companyDomain, parsers) {
  for (const link of links) {
    if (parsers.parseWorkdayBoard(link.href)) {
      return { board: { kind: 'workday', url: link.href } };
    }

    const ats = parsers.parseAtsBoard(link.href);

    if (ats) {
      return { board: { kind: 'ats', url: link.href, platform: ats.platform, token: ats.token } };
    }
  }

  for (const link of links) {
    const host = link.hostname.toLowerCase();
    const known = UNSUPPORTED_SYSTEMS.find(([pattern]) => pattern.test(host));

    if (known) {
      return { unsupported: { system: known[1], url: link.href } };
    }
  }

  // A link to the company's own jobs site ("jobs.clevelandclinic.org") is not
  // treated as unsupported: Cleveland Clinic's fronts its Workday board, which
  // the Workday search finds. Only a named vendor above skips the searches.

  return {};
}

// v2 drops v1 entries that marked a company's own jobs site (Cleveland Clinic's
// jobs.clevelandclinic.org, a Workday front) as unsupported for 7 days.
// v3 drops v2 entries classified from non-anchor links or as Phenom
// (miami.edu, from a stylesheet on cdn.phenompeople.com).
function careersCacheKey(domain) {
  return `careers_page_v3_${domain}`;
}

// { board } | { unsupported } | { none } | { failed } | { skipped }
// Set CAREERS_PAGE_DISABLED=1 (or "true") in the environment to turn the step
// off without a deploy of new code; open roles then runs as it did before it.
export function careersPageDisabled(env) {
  return /^(1|true|yes|on)$/i.test(String(env?.CAREERS_PAGE_DISABLED || '').trim());
}

export async function careersPageSignal(company, website, deps = {}, parsers) {
  const started = Date.now();
  const result = await readCareersPage(company, website, deps, parsers);
  console.info('[GHD] careers page timing', {
    company,
    ms: Date.now() - started,
    outcome: result.board ? 'board' : result.unsupported ? 'unsupported' : result.none ? 'none' : result.failed ? 'failed' : 'skipped',
    reason: result.skipped || null,
    cached: Boolean(result.cached)
  });
  return result;
}

async function readCareersPage(company, website, deps, parsers) {
  if (careersPageDisabled(deps.env)) {
    return { skipped: 'disabled by CAREERS_PAGE_DISABLED' };
  }

  if (typeof deps.careersLookup !== 'function' || typeof deps.careersRequest !== 'function') {
    return { skipped: 'no network supplied' };
  }

  const parsed = parseCompanyWebsite(website);

  if (parsed.error) {
    return { skipped: parsed.error };
  }

  const wikidataWebsites = deps.wikidataWebsites?.get(String(company || '').trim().toLowerCase()) || [];
  const match = domainMatchesCompany(parsed.hostname, company, wikidataWebsites);

  if (!match.ok) {
    return { skipped: match.reason };
  }

  const domain = registrableDomain(parsed.hostname).domain;
  const now = deps.now || new Date();
  const key = careersCacheKey(domain);
  const cached = deps.cache ? await cacheGet(deps.cache, key, now) : null;

  if (cached?.board || cached?.unsupported || cached?.none || cached?.failed) {
    return { ...cached, cached: true };
  }

  let outcome = { none: true };
  let failed = false;
  // The pages are read at the same time, each through every check above, and
  // taken in order (the given page first). Cleveland Clinic's three reads took
  // 3.6s one after another; together they take about one page's time.
  const reads = CAREERS_PAGE_LIMITS.paths.map((path) => {
    const target = new URL(parsed.url.href);

    if (path) {
      target.pathname = path;
      target.search = '';
    }

    return fetchCompanyPage(target, deps)
      .then((page) => classifyCareersLinks(careersLinks(page.body, page.url), domain, parsers))
      .catch((error) => {
        console.info('[GHD] careers page fetch', { company, url: target.href, error: error?.message || String(error) });
        return { failed: true };
      });
  });
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve('budget'), CAREERS_PAGE_LIMITS.totalMs);
    timer.unref?.();
  });
  const results = await Promise.race([Promise.all(reads), budget]);
  clearTimeout(timer);

  if (results === 'budget') {
    failed = true;
  } else {
    for (const found of results) {
      if (found.board || found.unsupported) {
        outcome = found;
        break;
      }

      if (found.failed) {
        failed = true;
      }
    }
  }

  if (failed && outcome.none) {
    outcome = { failed: true };
  }

  console.info('[GHD] careers page', { company, domain, by: match.by, ...outcome });

  if (deps.cache) {
    const ttl = outcome.board ? TTL.board : outcome.unsupported ? TTL.unsupported : outcome.failed ? TTL.failed : TTL.none;
    await cacheSet(deps.cache, key, outcome, ttl, now);
  }

  return outcome;
}
