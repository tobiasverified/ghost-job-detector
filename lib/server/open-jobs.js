import { cacheGet, cacheGetMeta, cacheSet, writtenWithin } from './cache.js';
import { careersPageSignal } from './careers-page.js';
import { capturedEmployeeCount } from './company-rating.js';
import { companyCacheKey } from './companies.js';
import { resultSubject, searchResultMatchesCompany } from './employees.js';
import { linkedinCompanySlugs } from './workforce.js';

const OPEN_JOBS_TTL_MS = 24 * 60 * 60 * 1000;
// A Glassdoor floor (or any later tier) saved after a better tier timed out
// would otherwise stick for a day. The next check retries within minutes.
const OPEN_JOBS_RETRY_TTL_MS = 5 * 60 * 1000;
// Pages are read for their organization name, so ask for HTML only: Workday
// answers "text/html,application/json" with a JSON redirect that has no name.
const PAGE_HEADERS = {
  Accept: 'text/html',
  'User-Agent': 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)'
};

// v8: a "5,000+" cap on the company-scoped LinkedIn jobs-worldwide page is a
// floor ("at least 5,000"), not an exact total. Caps on the company page and
// on search results stay unusable. v7 treated every LinkedIn cap that way,
// which dropped Alignerr's worldwide page and left a step number ("Step 2").
// v6: a "Result 2" label in the model answer is not an open-roles count.
// v9: the posting's own Workday tenant is accepted when its site and tenant
// name the company, and Workday pages are read as HTML (og:title included).
// v8 entries for Workday postings could hold a Glassdoor floor instead.
// v10: a Workday listing filtered by jobFamilyGroup, or any other facet, is
// not the company total. The CXS request uses empty appliedFacets and empty
// searchText, and the total is read from the first page.
// v11: a detail page's visible title is not the company total. v10 kept
// Argonne's detail page at 1 and never asked the tenant for its CXS total.
// v12: a fallback saved after a higher tier timed out is not kept for a day,
// and the company slug is tried on Greenhouse, Lever, and Ashby before search.
// v11 had stored Airbnb's Glassdoor floor of 28 after that search aborted.
// v13: Workday totals at the 2,000 cap are a floor, and Workday boards found by
// search are verified by tenant and site name (NVIDIA, Salesforce, Adobe).
// v14: a Workday board found by search whose site name marks a sub-board
// (Cleveland Clinic's ClevelandClinicCareersUK, 31 jobs) is no longer counted.
// v15: a Workday board linked from the company's own website is accepted
// (Target, Mass General Brigham); board checks time out at 2.5s.
// v16: joined-word and initials matching in the sub-board rule apply only
// to a board linked from the company's own website, not one found by search.
export function openJobsCacheKey(company) {
  return `open_jobs_v16_${String(company || '').trim().toLowerCase()}`;
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function parseAtsBoard(href) {
  let url;

  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (/(^|\.)(?:boards|job-boards)\.greenhouse\.io$/.test(host) && parts[0]) {
    return { platform: 'greenhouse', token: decodeURIComponent(parts[0]) };
  }

  if (/(^|\.)jobs\.lever\.co$/.test(host) && parts[0]) {
    return { platform: 'lever', token: decodeURIComponent(parts[0]) };
  }

  if (/(^|\.)jobs\.ashbyhq\.com$/.test(host) && parts[0]) {
    return { platform: 'ashby', token: decodeURIComponent(parts[0]) };
  }

  return null;
}

export function parseWorkdayBoard(href) {
  let url;

  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const host = url.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);

  if (!host) {
    return null;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  let locale = '';

  if (parts.length && /^[a-z]{2}-[a-z]{2}$/i.test(parts[0])) {
    locale = parts.shift();
  }

  const site = parts[0];

  if (!site || /^(job|jobs|details)$/i.test(site)) {
    return null;
  }

  return {
    tenant: host[1],
    site,
    host: url.hostname,
    origin: url.origin,
    pageUrl: `${url.origin}${locale ? `/${locale}` : ''}/${site}`
  };
}

function positiveCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
}

function compactCompany(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugMatchesCompany(slug, company) {
  const left = compactCompany(slug);
  const right = compactCompany(company);

  if (left.length < 3 || right.length < 3) {
    return false;
  }

  return left === right || right.startsWith(left) || left.startsWith(right);
}

// Keep this aligned with linkedInOpenJobsScoped in lib/job-page.js.
// A keyword search count is only the rendered hits for that term.
export function linkedInOpenJobsScoped(pageUrl, options = {}) {
  let url;

  try {
    url = new URL(String(pageUrl || ''));
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();

  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    return false;
  }

  let path = url.pathname;

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not encoded.
  }

  const jobs = path.match(/\/jobs\/([^/]+)-jobs(?:-worldwide)?\/?$/i);
  const companyBoard = path.match(/\/company\/([^/]+)\/jobs\/?$/i);
  const slug = (jobs || companyBoard)?.[1] || '';

  if (slug && slugMatchesCompany(slug, options.company)) {
    return true;
  }

  const filters = String(url.searchParams.get('f_C') || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part));
  const companyId = String(options.companyId || '').trim();

  if (companyId && filters.includes(companyId)) {
    return true;
  }

  if (String(url.searchParams.get('keywords') || '').trim()) {
    return false;
  }

  return options.allResultsMatch === true;
}

function workdayUrl(href) {
  try {
    const url = new URL(String(href || ''));
    return url.hostname.toLowerCase().endsWith('myworkdayjobs.com') ? url : null;
  } catch {
    return null;
  }
}

function workdayListingFiltered(href) {
  const url = workdayUrl(href);
  return Boolean(url) && [...url.searchParams.keys()].length > 0;
}

function workdayDetailPage(href) {
  const url = workdayUrl(href);
  return Boolean(url) && /\/(?:job|details)\//i.test(url.pathname);
}

function onPageOpenJobs(company, input) {
  const count = positiveCount(input?.onPageCount);
  const platform = String(input?.platform || '').toUpperCase();
  const host = String(input?.hostname || '').toLowerCase();
  const onLinkedIn = platform === 'LINKEDIN' || host === 'linkedin.com' || host.endsWith('.linkedin.com');
  const onWorkday = platform === 'WORKDAY' || host.endsWith('.myworkdayjobs.com');
  const pageUrl = input?.openJobsPageUrl || input?.jobUrl || '';

  if (!count || (!onLinkedIn && !onWorkday)) {
    return null;
  }

  if (onLinkedIn && !linkedInOpenJobsScoped(input?.openJobsPageUrl, {
    company,
    companyId: input?.openJobsCompanyId,
    allResultsMatch: input?.openJobsAllMatch === true
  })) {
    console.info('[GHD] open jobs page skipped', {
      company,
      reason: 'not company scoped',
      url: input?.openJobsPageUrl || ''
    });
    return null;
  }

  if (onWorkday && (workdayDetailPage(pageUrl) || workdayListingFiltered(pageUrl))) {
    console.info('[GHD] open jobs page skipped', {
      company,
      reason: workdayDetailPage(pageUrl) ? 'workday detail page' : 'workday listing is filtered',
      url: pageUrl
    });
    return null;
  }

  return { count, source: 'page', estimated: false, url: pageUrl };
}

// Greenhouse, Lever and Ashby answer in 41ms at the median and 1.6s at p99 from
// production (322 calls). The 8s wait was only ever spent on a hung request:
// Lever held Intel's slug for the full 8s and the check missed its deadline.
const ATS_BOARD_TIMEOUT_MS = 2500;
const ATS_BOARD_FAILED_TTL_MS = 5 * 60 * 1000;

async function readJson(deps, url, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;
  const response = await deps.fetch(url, {
    ...fetchOptions,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Open jobs request failed (${response.status})`);
  }

  return response.json();
}

async function countAtsBoard(board, deps) {
  if (board.platform === 'greenhouse') {
    const payload = await readJson(
      deps,
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs`,
      { timeoutMs: ATS_BOARD_TIMEOUT_MS }
    );
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    return jobs.length ? { count: jobs.length, source: 'greenhouse', estimated: false, url: `https://boards.greenhouse.io/${board.token}`, titles: listedTitles(jobs, 'title') } : null;
  }

  if (board.platform === 'lever') {
    const payload = await readJson(
      deps,
      `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`,
      { timeoutMs: ATS_BOARD_TIMEOUT_MS }
    );
    const jobs = Array.isArray(payload) ? payload : [];
    return jobs.length ? { count: jobs.length, source: 'lever', estimated: false, url: `https://jobs.lever.co/${board.token}`, titles: listedTitles(jobs, 'text') } : null;
  }

  const payload = await readJson(
    deps,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}`,
    { timeoutMs: ATS_BOARD_TIMEOUT_MS }
  );
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return jobs.length ? { count: jobs.length, source: 'ashby', estimated: false, url: `https://jobs.ashbyhq.com/${board.token}`, titles: listedTitles(jobs, 'title') } : null;
}

function listedTitles(jobs, key) {
  return jobs.map((job) => String(job?.[key] || job?.title || '').trim()).filter(Boolean);
}

// Measurement only. A complete Greenhouse, Lever, or Ashby board (one board,
// not a lower bound) is compared with the posting title. Nothing here is scored.
// Seniority and glue words can differ. Every remaining word is role-defining:
// the posting and the board title have to carry the same set. One specialty
// word introduced or dropped ("AI" vs "Developer", "Support" present on only
// one side) is a different role.
const CAREERS_GLUE = new Set([
  'a', 'an', 'and', 'at', 'for', 'in', 'of', 'or', 'the', 'to', 'with',
  'remote', 'hybrid', 'onsite'
]);
const CAREERS_SENIORITY = new Set([
  'i', 'ii', 'iii', 'iv', 'sr', 'jr', 'senior', 'junior', 'staff', 'principal', 'lead'
]);

function careersTokens(value) {
  return [...new Set(
    (String(value || '').normalize('NFKD').toLowerCase().replace(/&/g, ' and ').match(/[a-z0-9]+/g) || [])
      .filter((word) => word.length > 1 && !CAREERS_GLUE.has(word) && !CAREERS_SENIORITY.has(word))
  )];
}

function roleWords(title, company) {
  const companyWords = new Set(careersTokens(company));
  const words = careersTokens(title).filter((word) => !companyWords.has(word));
  return words.length ? words : careersTokens(title);
}

function careersCompare(jobTitle, boardTitle, company) {
  const left = roleWords(jobTitle, company);
  const right = roleWords(boardTitle, company);
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  const shared = left.filter((word) => rightSet.has(word));
  const dropped = left.filter((word) => !rightSet.has(word));
  const introduced = right.filter((word) => !leftSet.has(word));

  return {
    shared,
    dropped,
    introduced,
    agrees: shared.length > 0 && dropped.length === 0 && introduced.length === 0
  };
}

function completeBoard(result) {
  return Boolean(result)
    && ['greenhouse', 'lever', 'ashby'].includes(result.source)
    && !result.lowerBound
    && Array.isArray(result.titles);
}

function boardLabel(source) {
  return { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' }[source] || '';
}

function assessCareers(company, jobTitle, result) {
  const board = ['greenhouse', 'lever', 'ashby', 'workday'].includes(result?.source) ? result.source : (result?.source || null);

  if (!completeBoard(result)) {
    return {
      company,
      board,
      jobCount: typeof result?.count === 'number' ? result.count : null,
      matchedTitle: '',
      overlap: null,
      dropped: [],
      introduced: [],
      outcome: 'board unverified'
    };
  }

  let best = null;
  let matchedTitle = '';

  for (const title of result.titles) {
    const compared = careersCompare(jobTitle, title, company);
    const closer = !best
      || compared.agrees && !best.agrees
      || compared.dropped.length + compared.introduced.length < best.dropped.length + best.introduced.length
      || (
        compared.dropped.length + compared.introduced.length === best.dropped.length + best.introduced.length
        && compared.shared.length > best.shared.length
      );

    if (closer) {
      best = compared;
      matchedTitle = title;
    }
  }

  const overlap = best
    ? { shared: best.shared, dropped: best.dropped, introduced: best.introduced }
    : { shared: [], dropped: [], introduced: [] };

  return {
    company,
    board: result.source,
    jobCount: result.count,
    matchedTitle,
    overlap,
    dropped: overlap.dropped,
    introduced: overlap.introduced,
    outcome: best?.agrees ? 'found' : 'not found'
  };
}

function logCareersCheck(company, jobTitle, result) {
  console.info('[GHD] careers check', assessCareers(company, jobTitle, result));
}

// Shown only when a complete Greenhouse, Lever, or Ashby board has no title
// match. Found, unverified, and Workday stay off the card and out of the score.
function careersDisplay(company, jobTitle, result) {
  const assessed = assessCareers(company, jobTitle, result);

  if (assessed.outcome !== 'not found') {
    return null;
  }

  const count = assessed.jobCount;
  const label = boardLabel(assessed.board);

  return {
    show: true,
    text: '⚠️ Not found on the company\'s careers board',
    tooltip: `Checked ${label} board, ${count} ${count === 1 ? 'job' : 'jobs'}`
  };
}

function attachCareers(company, jobTitle, result) {
  const stripped = withoutBoardTitles(result);

  if (!stripped || typeof stripped !== 'object') {
    return stripped;
  }

  return {
    ...stripped,
    careers: careersDisplay(company, jobTitle, result),
    careersChecked: true
  };
}

function withoutBoardTitles(result) {
  if (!result?.titles) {
    return result;
  }

  const { titles, ...rest } = result;
  return rest;
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageOrgNames(html) {
  const source = String(html || '');
  const found = [];
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const site = source.match(/property=["']og:site_name["']\s+content=["']([^"']+)["']/i)
    || source.match(/content=["']([^"']+)["']\s+property=["']og:site_name["']/i);
  const org = source.match(/"(?:organizationName|companyName|orgName)"\s*:\s*"([^"]+)"/i);
  // Workday pages leave <title> empty and put the site name here.
  const ogTitle = source.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)
    || source.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i);

  for (const match of [title?.[1], site?.[1], org?.[1], ogTitle?.[1]]) {
    const text = stripTags(match);

    if (text) {
      found.push(text);
    }
  }

  return found;
}

const WORKDAY_SITE_IGNORE = new Set([
  'the', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'co', 'corp',
  'corporation', 'company', 'plc', 'sa', 'ag', 'gmbh', 'nv',
  'financial', 'bancorp', 'bancshares', 'holdings', 'holding', 'group', 'international',
  'industries', 'enterprises', 'technologies', 'brands', 'worldwide', 'global'
]);

// A parent tenant can host the brand ("wwecorp.../TKO" titled WWE). The site
// segment is then the company, even when the page's organization name is not.
export function workdaySiteMatchesCompany(site, company) {
  const slug = compact(site);

  if (slug.length < 3) {
    return false;
  }

  const words = String(company || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const distinctive = words.filter((word) => !WORKDAY_SITE_IGNORE.has(word));
  const alias = distinctive.join('');

  return slug === compact(company)
    || (alias.length >= 3 && slug === alias)
    || distinctive.some((word) => word.length >= 3 && word === slug);
}

function orgNameMatches(company, orgName, pageUrl) {
  return searchResultMatchesCompany({
    title: orgName,
    snippet: '',
    url: pageUrl
  }, {
    company,
    names: [company],
    tickers: []
  }).ok;
}

async function workdayPageText(pageUrl, deps) {
  const response = await deps.fetch(pageUrl, {
    headers: PAGE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    return '';
  }

  return typeof response.text === 'function' ? await response.text() : '';
}

function ogDescription(html) {
  const source = String(html || '');
  const match = source.match(/property=["']og:description["']\s+content=["']([^"']*)["']/i)
    || source.match(/content=["']([^"']*)["']\s+property=["']og:description["']/i);

  return String(match?.[1] || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

// The staff board's og:title is empty. Its description still names the
// university. A one-word company is not accepted from that paragraph, so a
// students site that only says "Argonne" stays rejected.
function descriptionNamesCompany(html, company) {
  const phrase = String(company || '').replace(/\s+/g, ' ').trim();

  if (!phrase || !/\s/.test(phrase)) {
    return false;
  }

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(ogDescription(html));
}

async function workdayTotal(board, deps) {
  const endpoint = `${board.origin}/wday/cxs/${encodeURIComponent(board.tenant)}/${encodeURIComponent(board.site)}/jobs`;
  const body = {
    appliedFacets: {},
    limit: 20,
    offset: 0,
    searchText: ''
  };
  console.info('[GHD] open jobs workday', { method: 'POST', url: endpoint, body });
  const payload = await readJson(deps, endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': PAGE_HEADERS['User-Agent']
    },
    body: JSON.stringify(body)
  });
  const total = Number(payload?.total);

  if (!Number.isFinite(total) || total < 0) {
    return null;
  }

  // Workday's CXS total stops at 2,000. NVIDIA reported exactly 2,000 while its
  // one-value-per-job facets (timeType, workerSubType) each summed to 2,679.
  if (total >= WORKDAY_TOTAL_CAP) {
    return {
      count: WORKDAY_TOTAL_CAP,
      source: 'workday',
      estimated: false,
      lowerBound: true,
      scope: 'workday_cap',
      url: board.pageUrl
    };
  }

  return {
    count: Math.round(total),
    source: 'workday',
    estimated: false,
    url: board.pageUrl
  };
}

export const WORKDAY_TOTAL_CAP = 2000;

const WORKDAY_SITE_BOILERPLATE = new Set(['careers', 'career', 'jobs', 'job', 'external', 'site', 'portal', 'opportunities']);

// For the posting's OWN tenant only (the board the job is on), not for
// tenants found by search. "argonne.wd1.../Argonne_Careers": with the generic
// "Careers" removed, the site is "argonne", the same as the tenant name, and it
// names the company. Two separate parts of the address agree, so this is the
// tenant's general careers site. A site with any other word ("Argonne_Students")
// does not equal the tenant name and falls back to the checks below.
// Generic words a company-wide Workday site name carries. A site with any other
// word (Students, University, Contractors, Interns) is a sub-board.
const WORKDAY_GENERIC_SITE_WORDS = new Set([
  ...WORKDAY_SITE_BOILERPLATE, 'experienced', 'professional', 'professionals', 'global'
]);

// "NVIDIAExternalCareerSite" -> nvidia external career site.
export function workdaySiteWords(site) {
  return String(site || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

// For a tenant found by search. Both parts of the address must point at this
// company: the tenant subdomain is the WHOLE company name ("nvidia", not one
// word of a longer name, so "spring" is not Spring Health), and the site is the
// company name plus generic words only ("NVIDIAExternalCareerSite",
// "External_Career_Site"), never a sub-board ("NVIDIA_University").
export function workdayTenantNamesCompany(board, company) {
  const companyWords = boardWords(company);
  const whole = companyWords.join('');

  if (!whole || compact(board?.tenant) !== whole) {
    return false;
  }

  const allowed = new Set([...companyWords, whole]);
  return workdaySiteWords(board?.site)
    .filter((word) => !WORKDAY_GENERIC_SITE_WORDS.has(word))
    .every((word) => allowed.has(word));
}

// A site name with a word that is not the company's, the tenant's or a generic
// one ("ClevelandClinicCareersUK", "NVIDIA_University") is part of the company,
// not its whole board. Numbers count as generic ("Careers_2").
//
// Joined words ("targetcareers") and initials ("MGBExternal") are read only for
// a board linked from the company's own verified website. For a board found by
// search the site words must be the company's words exactly.
export function workdaySiteIsSubBoard(board, company, options = {}) {
  const words = workdaySiteWords(board?.site)
    .filter((word) => !WORKDAY_GENERIC_SITE_WORDS.has(word) && !/^\d+$/.test(word));

  if (options.linkedFromOwnSite === true) {
    const allowed = companySiteTokens(company, board?.tenant);
    return words.some((word) => !siteWordCovered(word, allowed));
  }

  const companyWords = boardWords(company);
  const allowed = new Set([...companyWords, companyWords.join(''), compact(board?.tenant)]);
  return words.some((word) => !allowed.has(word));
}

const INITIALISM_SKIP = new Set(['of', 'and', 'for', 'at', 'de', 'la']);

// The words a whole-company site name may use: the company's words, the
// compact name, its initials with and without "of"/"and" ("Mass General
// Brigham" -> mgb, "University of Miami" -> uom and um), and the tenant.
function companySiteTokens(company, tenant) {
  const words = boardWords(company);
  const tokens = new Set([...words, words.join(''), compact(tenant)]);

  if (words.length >= 2) {
    tokens.add(words.map((word) => word[0]).join(''));
    const kept = words.filter((word) => !INITIALISM_SKIP.has(word));

    if (kept.length >= 2) {
      tokens.add(kept.map((word) => word[0]).join(''));
    }
  }

  tokens.delete('');
  return tokens;
}

// A site word run together from allowed and generic words ("targetcareers" is
// target + careers) is covered; one with any other part ("careerstaff") is not.
function siteWordCovered(word, allowed) {
  const reachable = [true];

  for (let end = 1; end <= word.length; end += 1) {
    reachable[end] = false;

    for (let start = 0; start < end && !reachable[end]; start += 1) {
      const part = word.slice(start, end);
      reachable[end] = reachable[start]
        && (allowed.has(part) || WORKDAY_GENERIC_SITE_WORDS.has(part) || /^\d+$/.test(part));
    }
  }

  return reachable[word.length];
}

// The board's address must carry the company's own name somewhere: the tenant
// or a site word made from the company's words or initials. A careers page
// that links a partner's or parent's board ("affiliate.wd1.../AffiliateJobs")
// does not make that board the company's.
function workdayAddressNamesCompany(board, company) {
  const allowed = companySiteTokens(company, '');
  const named = (word) => siteWordCovered(word, allowed)
    && [...allowed].some((token) => word.includes(token));

  return named(compact(board?.tenant)) || workdaySiteWords(board?.site).some(named);
}

// A search hit whose tenant and site share no word with the company is a
// different employer. That is knowable from the URL, so the page is not fetched.
export function workdayUrlNamesCompany(board, company) {
  const words = boardWords(company);
  const allowed = new Set(words);

  if (!allowed.size) {
    return false;
  }

  const namesCompany = (token) => {
    const word = String(token || '').toLowerCase();

    if (!word || WORKDAY_GENERIC_SITE_WORDS.has(word)) {
      return false;
    }

    if (allowed.has(word) || word === words.join('')) {
      return true;
    }

    return siteWordCovered(word, allowed);
  };

  return workdaySiteWords(board?.tenant).some(namesCompany)
    || workdaySiteWords(board?.site).some(namesCompany);
}

export function ownTenantSiteNamesCompany(board, company) {
  const words = String(board?.site || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  const site = words.filter((word) => !WORKDAY_SITE_BOILERPLATE.has(word)).join('');

  return Boolean(site)
    && site === compact(board?.tenant)
    && workdaySiteMatchesCompany(site, company);
}

async function verifiedWorkdayTotal(href, company, deps, options = {}) {
  const board = parseWorkdayBoard(href);

  if (!board || typeof deps.fetch !== 'function') {
    return null;
  }

  // A board linked from the company's own website (its registrable label is
  // the company name, or it is Wikidata's official website) is the company's:
  // the domain check already did what the page-name check does for a board
  // found by search. It must still be a whole-company site and its address
  // must carry the company's name.
  if (options.linkedFromOwnSite === true) {
    const reason = workdaySiteIsSubBoard(board, company, { linkedFromOwnSite: true })
      ? 'site name marks part of the company (sub-board)'
      : !workdayAddressNamesCompany(board, company)
        ? 'linked board address does not name the company'
        : null;

    if (reason) {
      console.info('[GHD] open jobs workday rejected', { company, url: board.pageUrl, site: board.site, reason, via: 'careers page' });
      return null;
    }

    return workdayTotal(board, deps);
  }

  // A site equal to any one word of the company is accepted only for the
  // posting's own tenant. For a tenant found by search it would let "Spring"
  // stand for Spring Health; those need the whole-name rule.
  const slugMatch = (options.ownTenant === true && workdaySiteMatchesCompany(board.site, company))
    || (options.ownTenant !== true && workdaySiteMatchesCompany(board.site, company) && compact(board.site) === boardWords(company).join(''))
    || workdayTenantNamesCompany(board, company)
    || (options.ownTenant === true && ownTenantSiteNamesCompany(board, company));
  let matched = slugMatch;

  if (!matched) {
    // Search candidates only. The posting's own board can be named in the
    // page description when the address uses a short tenant ("umiami").
    if (options.ownTenant !== true && !workdayUrlNamesCompany(board, company)) {
      console.info('[GHD] open jobs workday rejected', {
        company,
        url: board.pageUrl,
        site: board.site,
        reason: 'address does not name the company'
      });
      return null;
    }

    const html = await workdayPageText(board.pageUrl, deps);
    // The page name is checked against the board's host only. The employee-search
    // URL veto read the site path ("NVIDIAExternalCareerSite") as another
    // entity's name and rejected NVIDIA's own board.
    matched = pageOrgNames(html).some((name) => orgNameMatches(company, name, board.origin))
      || (options.ownTenant === true && descriptionNamesCompany(html, company));

    // A page name says whose board it is, not how much of the company it
    // covers: Cleveland Clinic's UK board (31 jobs) carries the same name as
    // its main one. A tenant found by search must also be a whole-company site.
    if (matched && options.ownTenant !== true && workdaySiteIsSubBoard(board, company)) {
      console.info('[GHD] open jobs workday rejected', {
        company,
        url: board.pageUrl,
        site: board.site,
        reason: 'site name marks part of the company (sub-board)'
      });
      return null;
    }
  }

  if (!matched) {
    console.info('[GHD] open jobs workday rejected', {
      company,
      url: board.pageUrl,
      site: board.site,
      reason: 'page org name does not match'
    });
    return null;
  }

  return workdayTotal(board, deps);
}

async function discoverWorkday(company, deps) {
  if (typeof deps.webSearch !== 'function') {
    return null;
  }

  const results = await deps.webSearch(`site:myworkdayjobs.com ${company}`, {
    env: deps.env,
    fetch: deps.fetch,
    timeoutMs: 4000
  });
  // One check per board: search often returns the same board under several
  // job or locale paths (NVIDIA's board was checked three times).
  const seen = new Set();
  const candidates = (Array.isArray(results) ? results : [])
    .map((result) => result?.url)
    .filter((url) => {
      const board = parseWorkdayBoard(url);
      const key = board ? `${board.host}/${board.site}`.toLowerCase() : '';

      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .slice(0, 3);

  const checked = await Promise.all(candidates.map(async (url) => {
    try {
      return await verifiedWorkdayTotal(url, company, deps);
    } catch (error) {
      console.info('[GHD] open jobs workday error', {
        company,
        url,
        error: error?.message || String(error)
      });
      return null;
    }
  }));

  return checked.find((counted) => counted) || null;
}

// ---- Job boards found by search (Greenhouse, Lever, Ashby) -----------------
//
// A board name guessed from the company name misses boards whose address is
// an ID (Spring Health's Ashby board is a UUID), so boards are also found by
// search. A found board is counted only when both questions below are yes.
//
// Is this board the company's?
//   V1  The board's own name, read from the platform (Greenhouse board API
//       name; Lever and Ashby board page title), names exactly this company.
//       Legal-form words (Inc, Group, Technologies...) may differ; nothing else.
//   V2  A board whose name cannot be read is not used.
//
// Is it the whole company's board, not part of it?
//   S1  A board name that adds any other word to the company name
//       ("Spring Health UK", "Acme Clinical") is a sub-board and is rejected.
//   S2  A readable board address must match the company the same way
//       ("acme-emea" is rejected for Acme). An ID address has no words and
//       relies on the board name.
//   S3  If more than one board passes, no single one is the whole company.
//       The largest is reported as a lower bound and is not scored.
const ATS_SEARCH_DOMAINS = ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co'];
const ATS_CANDIDATES = 3;

function boardWords(value) {
  return (String(value || '').normalize('NFKD').toLowerCase().replace(/&/g, ' and ').match(/[a-z0-9]+/g) || [])
    .filter((word) => !WORKDAY_SITE_IGNORE.has(word));
}

export function boardNameVerdict(company, boardName) {
  const subject = resultSubject(boardName);
  const want = boardWords(company);
  const got = boardWords(subject);

  if (!got.length || !want.length) {
    return { ok: false, reason: 'board name missing', subject };
  }

  if (got.join('') === want.join('')) {
    return { ok: true, subject };
  }

  if (want.every((word, index) => got[index] === word)) {
    return { ok: false, reason: 'sub-board name', subject, extra: got.slice(want.length) };
  }

  return { ok: false, reason: 'different organization', subject };
}

function isIdToken(token) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(token || ''));
}

export function boardTokenVerdict(company, token) {
  if (isIdToken(token)) {
    return { ok: true, id: true };
  }

  const want = boardWords(company).join('');
  // A trailing number ("springhealth66") is how Greenhouse makes a taken name
  // unique, not a region or team; the board name check (V1) still applies.
  const bare = String(token || '').replace(/[-_]?\d+$/, '') || String(token || '');
  const got = boardWords(bare.replace(/[-_]+/g, ' ')).join('');

  return want && got === want
    ? { ok: true }
    : { ok: false, reason: 'board address names something else', token };
}

async function readBoardName(board, deps) {
  if (board.platform === 'greenhouse') {
    const payload = await readJson(deps, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}`, { timeoutMs: ATS_BOARD_TIMEOUT_MS });
    return [String(payload?.name || '').trim()].filter(Boolean);
  }

  const pageUrl = board.platform === 'lever'
    ? `https://jobs.lever.co/${encodeURIComponent(board.token)}`
    : `https://jobs.ashbyhq.com/${encodeURIComponent(board.token)}`;
  const response = await deps.fetch(pageUrl, {
    headers: PAGE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(ATS_BOARD_TIMEOUT_MS)
  });

  if (!response.ok) {
    return [];
  }

  return pageOrgNames(typeof response.text === 'function' ? await response.text() : '');
}

function boardFailedKey(board) {
  return `ats_board_failed_v1_${board.platform}_${String(board.token || '').toLowerCase()}`;
}

// A board check that failed (timed out, 5xx) is not tried again for 5 minutes,
// so a hung Lever slug costs 2.5s once, not on every check. It still counts as
// a failure (not a miss): callers record it as higherTierFailed. A 404 is a
// miss and is not marked.
export async function checkBoard(board, company, deps) {
  const now = deps.now || new Date();

  if (deps.cache && await cacheGet(deps.cache, boardFailedKey(board), now)) {
    throw new Error('board check failed in the last 5 minutes');
  }

  try {
    return await verifyBoard(board, company, deps);
  } catch (error) {
    if (deps.cache && !tokenNotFound(error)) {
      await cacheSet(deps.cache, boardFailedKey(board), { failed: true }, ATS_BOARD_FAILED_TTL_MS, now);
    }

    throw error;
  }
}

async function verifyBoard(board, company, deps) {
  const token = boardTokenVerdict(company, board.token);

  if (!token.ok) {
    return { ok: false, reason: token.reason };
  }

  // Greenhouse gives the board name from a fast API, so the name comes first
  // and a mismatched board's jobs are never fetched. Lever and Ashby give the
  // name only on their board page, which can be slow (jobs.lever.co/asana
  // took 6.9s for a slug with no board), so their jobs API goes first: a
  // missing (404) or empty board is rejected either way, and that answer is fast.
  const nameFirst = board.platform === 'greenhouse';
  let counted = null;

  if (!nameFirst) {
    counted = await countAtsBoard(board, deps);

    if (!counted) {
      return { ok: false, reason: 'board has no jobs' };
    }
  }

  const names = await readBoardName(board, deps);
  const verdicts = names.map((name) => boardNameVerdict(company, name));
  const passed = verdicts.find((verdict) => verdict.ok);

  if (!passed) {
    const first = verdicts[0] || { reason: 'board name missing', subject: '' };
    return { ok: false, reason: first.reason, name: first.subject, extra: first.extra };
  }

  counted = counted || await countAtsBoard(board, deps);
  return counted ? { ok: true, name: passed.subject, counted } : { ok: false, reason: 'board has no jobs', name: passed.subject };
}

// The compact company name, then the hyphenated one. "Airbnb" is "airbnb".
function companyBoardSlugs(company) {
  const key = companyCacheKey(company);
  const compactSlug = key.replace(/-/g, '');
  return [...new Set([compactSlug, key].filter((slug) => slug.length >= 2))].slice(0, 2);
}

function tokenNotFound(error) {
  return /\(404\)/.test(String(error?.message || error || ''));
}

// Before a search, try the company slug on each public jobs API. A 404 is a
// miss. The board is kept only when its own name matches, same as a searched board.
async function guessDirectBoards(company, deps) {
  if (typeof deps.fetch !== 'function') {
    return { value: null, failed: false };
  }

  const boards = companyBoardSlugs(company).flatMap((token) => (
    ['greenhouse', 'lever', 'ashby'].map((platform) => ({ platform, token }))
  ));
  const checked = await Promise.all(boards.map(async (board) => {
    try {
      return { board, ...(await checkBoard(board, company, deps)) };
    } catch (error) {
      const missed = tokenNotFound(error);
      return {
        board,
        ok: false,
        reason: missed ? 'not found' : (error?.message || String(error)),
        failed: !missed
      };
    }
  }));

  console.info('[GHD] open jobs board token', {
    company,
    candidates: checked.map((item) => ({
      board: `${item.board.platform}:${item.board.token}`,
      ok: item.ok,
      reason: item.reason || null,
      name: item.name || null,
      count: item.counted?.count ?? null
    }))
  });

  const verified = checked.filter((item) => item.ok);

  if (!verified.length) {
    return { value: null, failed: checked.some((item) => item.failed) };
  }

  if (verified.length === 1) {
    return { value: verified[0].counted, failed: false };
  }

  const largest = verified.reduce((best, item) => (item.counted.count > best.counted.count ? item : best));
  return {
    value: {
      ...largest.counted,
      lowerBound: true,
      scope: 'multiple_boards',
      boards: verified.map((item) => item.counted.url)
    },
    failed: false
  };
}

async function discoverAtsBoards(company, deps) {
  if (typeof deps.webSearch !== 'function' || typeof deps.fetch !== 'function') {
    return null;
  }

  const results = await deps.webSearch(`"${company}" jobs`, {
    env: deps.env,
    fetch: deps.fetch,
    timeoutMs: 4000,
    includeDomains: ATS_SEARCH_DOMAINS
  });
  const boards = [];

  for (const result of Array.isArray(results) ? results : []) {
    const board = parseAtsBoard(result?.url || '');

    if (board && !boards.some((seen) => seen.platform === board.platform && seen.token.toLowerCase() === board.token.toLowerCase())) {
      boards.push(board);
    }
  }

  const candidates = boards.slice(0, ATS_CANDIDATES);
  const checked = await Promise.all(candidates.map(async (board) => {
    try {
      return { board, ...(await checkBoard(board, company, deps)) };
    } catch (error) {
      return { board, ok: false, reason: error?.message || String(error) };
    }
  }));
  const verified = checked.filter((item) => item.ok);

  console.info('[GHD] open jobs board search', {
    company,
    candidates: checked.map((item) => ({
      board: `${item.board.platform}:${item.board.token}`,
      ok: item.ok,
      reason: item.reason || null,
      name: item.name || null,
      extra: item.extra || null,
      count: item.counted?.count ?? null
    }))
  });

  if (!verified.length) {
    return null;
  }

  if (verified.length === 1) {
    return verified[0].counted;
  }

  const largest = verified.reduce((best, item) => (item.counted.count > best.counted.count ? item : best));
  return {
    ...largest.counted,
    lowerBound: true,
    scope: 'multiple_boards',
    boards: verified.map((item) => item.counted.url)
  };
}

function countForms(count) {
  const digits = String(count);
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return grouped === digits ? [digits] : [digits, grouped];
}

function countAppears(text, count) {
  return countForms(count).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\d,])${escaped}(?![\\d,])`).test(String(text || ''));
  });
}

function countIsOpenEnded(text, count) {
  return countForms(count).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\d,])${escaped}\\s*\\+`).test(String(text || ''));
  });
}

function linkedInResult(url) {
  const host = resultHost(url);
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

// The {company}-jobs-worldwide page (slug match, or f_C when a company id is
// known). The company page and keyword search are not this page.
function linkedInJobsWorldwide(url, company) {
  let path = '';

  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }

  if (!/\/jobs\/[^/]+-jobs-worldwide\/?$/i.test(path)) {
    return false;
  }

  return linkedInOpenJobsScoped(url, { company });
}

function excerptAround(text, count) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();

  for (const form of countForms(count)) {
    const index = source.indexOf(form);

    if (index >= 0) {
      return source.slice(Math.max(0, index - 90), index + form.length + 90);
    }
  }

  return source.slice(0, 180);
}

function currentYearFigure(sentence, count) {
  const year = String(new Date().getFullYear());

  return countForms(count).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const number = `(?<![\\d,])${escaped}(?![\\d,])`;
    const nearYear = new RegExp(`${number}[^.!?]{0,80}\\b${year}\\b|\\b${year}\\b[^.!?]{0,80}${number}`, 'i');
    return nearYear.test(sentence);
  });
}

// "Step 2" and "2 Apply for a job" are onboarding steps, not a jobs total.
function stepNumber(sentence, count) {
  return countForms(count).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const step = new RegExp(`\\bsteps?\\s+${escaped}\\b`, 'i');
    const apply = new RegExp(`(?<![\\d,])${escaped}\\s+(?:#+\\s*)?apply\\s+for\\s+a\\s+job\\b`, 'i');
    return step.test(sentence) || apply.test(sentence);
  });
}

// "46 jobs" and "7,732 active job postings" count. A number elsewhere in the
// sentence does not. A current-year total counts only when the same sentence
// says the roles are active or open.
function countBesideJobsPhrase(text, count) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/);

  return sentences.some((sentence) => countForms(count).some((form) => {
    if (currentYearFigure(sentence, count) && !/\b(?:active|open)\b/i.test(sentence)) {
      return false;
    }

    if (stepNumber(sentence, count)) {
      return false;
    }

    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const gap = '(?:\\s*\\+)?(?:\\s+[^\\s.!?]+){0,5}\\s+';
    const phrase = '(?:open\\s+roles?|openings?|postings?|positions?|vacanc(?:y|ies)|jobs?)';
    const forward = new RegExp(`(?<![\\d,])${escaped}${gap}${phrase}\\b`, 'i');
    const backward = new RegExp(`\\b${phrase}${gap}(?<![\\d,])${escaped}(?![\\d,])`, 'i');
    return forward.test(sentence) || backward.test(sentence);
  }));
}

function rejectCitation(company, count, item, reason) {
  const hay = `${item?.title || ''} ${item?.snippet || ''}`;
  console.info('[GHD] open jobs citation rejected', {
    company,
    count,
    url: item?.url || '',
    reason,
    context: excerptAround(hay, count)
  });
}

// Job boards that republish someone else's listings. Their counts are the
// lowest-priority citation and are often limited to one filter (remote, a
// city, a department), the same kind of partial board S1 rejects.
const AGGREGATOR_SITES = [
  ['ziprecruiter.com', 'ZipRecruiter'],
  ['indeed.com', 'Indeed'],
  ['simplyhired.com', 'SimplyHired'],
  ['monster.com', 'Monster'],
  ['careerbuilder.com', 'CareerBuilder'],
  ['dice.com', 'Dice'],
  ['glassdoor.com', 'Glassdoor'],
  ['bebee.com', 'beBee'],
  ['talent.com', 'Talent.com'],
  ['jooble.org', 'Jooble'],
  ['snagajob.com', 'Snagajob'],
  ['theladders.com', 'Ladders'],
  ['builtin.com', 'Built In']
];

const SCOPE_JOB_WORDS = new Set([
  'job', 'jobs', 'open', 'opening', 'openings', 'role', 'roles', 'position', 'positions',
  'career', 'careers', 'hiring', 'browse', 'apply', 'listed', 'listing', 'listings',
  'result', 'results', 'the', 'and', 'for', 'at', 'in', 'of', 'a', 'an', 'now', 'new',
  'today', 'top', 'from', 'company', 'companies', 'posted', 'daily', 'see', 'view',
  'search', 'worldwide', 'global', 'all', 'current', 'active', 'total', 'across',
  'its', 'with', 'your', 'our', 'has', 'have', 'had', 'over', 'more', 'than', 'about',
  'approximately'
]);

const SCOPE_REGION_WORDS = new Set([
  'remote', 'hybrid', 'onsite', 'emea', 'apac', 'latam', 'europe', 'asia', 'africa',
  'uk', 'canada', 'australia', 'india', 'germany', 'france', 'ireland', 'mexico',
  'brazil', 'japan', 'singapore', 'nyc', 'alabama', 'alaska', 'arizona', 'arkansas',
  'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii',
  'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'wisconsin',
  'wyoming'
]);

const SCOPE_REGION_PHRASES = [
  'new york', 'new jersey', 'new hampshire', 'new mexico', 'north carolina',
  'north dakota', 'south carolina', 'south dakota', 'west virginia', 'rhode island',
  'district of columbia'
];

const SCOPE_DEPARTMENT_WORDS = new Set([
  'engineering', 'sales', 'marketing', 'clinical', 'finance', 'legal', 'design',
  'product', 'support', 'operations', 'nursing', 'research', 'hr'
]);

function resultHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function websiteHost(website) {
  const text = String(website || '').trim();

  if (!text) {
    return '';
  }

  return resultHost(text.includes('://') ? text : `https://${text}`);
}

function aggregatorName(host) {
  const found = AGGREGATOR_SITES.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  return found ? found[1] : '';
}

function isCompanyHost(host, company, website) {
  if (!host || aggregatorName(host)) {
    return false;
  }

  const site = websiteHost(website);

  if (site && (host === site || host.endsWith(`.${site}`))) {
    return true;
  }

  const brand = compact(company);

  if (brand.length < 3) {
    return false;
  }

  return host.split('.').slice(0, -1).some((label) => compact(label) === brand);
}

function jobPlatformDomains(input) {
  const platform = String(input?.platform || '').toLowerCase();
  const host = resultHost(input?.jobUrl || '') || String(input?.hostname || '').toLowerCase().replace(/^www\./, '');
  const domains = [];

  if (platform === 'linkedin' || host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    domains.push('linkedin.com');
  }

  if (platform === 'workday' || host.endsWith('myworkdayjobs.com')) {
    domains.push('myworkdayjobs.com');
  }

  if (platform === 'greenhouse' || host.endsWith('greenhouse.io')) {
    domains.push('greenhouse.io');
  }

  if (platform === 'lever' || host.endsWith('lever.co')) {
    domains.push('lever.co');
  }

  if (platform === 'ashby' || host.endsWith('ashbyhq.com')) {
    domains.push('ashbyhq.com');
  }

  return domains;
}

function isPlatformHost(host, input) {
  return jobPlatformDomains(input).some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// 0 company site, 1 the posting's own platform, 2 any other page, 3 aggregators.
function sourceRank(url, company, input) {
  const host = resultHost(url);

  if (isCompanyHost(host, company, input?.website)) {
    return 0;
  }

  if (isPlatformHost(host, input)) {
    return 1;
  }

  if (aggregatorName(host)) {
    return 3;
  }

  return 2;
}

function sourceSite(url) {
  const host = resultHost(url);
  const aggregator = aggregatorName(host);

  if (aggregator) {
    return aggregator;
  }

  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    return 'LinkedIn';
  }

  if (host.endsWith('myworkdayjobs.com')) {
    return 'Workday';
  }

  if (host.endsWith('greenhouse.io')) {
    return 'Greenhouse';
  }

  if (host.endsWith('lever.co')) {
    return 'Lever';
  }

  if (host.endsWith('ashbyhq.com')) {
    return 'Ashby';
  }

  const brand = host.split('.').slice(0, -1).pop() || host;
  return brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : '';
}

// An aggregator title that adds a place, a work mode, or a department to the
// company name is only that slice of the listings. Generic job words and
// "worldwide" are not a slice.
function scopeQualifier(text, company) {
  const lower = String(text || '').toLowerCase();
  const phrase = SCOPE_REGION_PHRASES.find((region) => new RegExp(`\\b${region}\\b`).test(lower));

  if (phrase) {
    return phrase;
  }

  const companyWords = new Set(boardWords(company));
  const words = lower.match(/[a-z][a-z0-9+]*/g) || [];

  for (const word of words) {
    const bare = word.replace(/\+$/, '');

    if (companyWords.has(bare) || SCOPE_JOB_WORDS.has(bare)) {
      continue;
    }

    if (bare === 'remote' || bare === 'hybrid') {
      return bare;
    }

    if (bare === 'onsite') {
      return 'on-site';
    }

    if (SCOPE_REGION_WORDS.has(bare) || SCOPE_DEPARTMENT_WORDS.has(bare)) {
      return bare;
    }
  }

  return '';
}

function citedCount(text, results, company, input) {
  const raw = String(text || '').trim();

  if (!raw || /^UNKNOWN\b/i.test(raw)) {
    return null;
  }

  const needle = compact(company);
  // "Result 2" answers which snippet stated the count. It is not itself a count.
  const withoutResultIndex = raw.replace(/\bresults?\s*#?\s*\d[\d,]*/gi, ' ');
  const mentioned = [...withoutResultIndex.matchAll(/\d[\d,]*/g)]
    .map((match) => Number(match[0].replace(/,/g, '')))
    .filter((count) => Number.isFinite(count) && count >= 1);
  const candidates = [];

  for (const count of mentioned) {
    if (candidates.some((item) => item.count === count)) {
      continue;
    }

    const matches = results.filter((item) => {
      const hay = `${item?.title || ''} ${item?.snippet || ''}`;

      if (!item?.url || !countAppears(hay, count) || !compact(hay).includes(needle)) {
        return false;
      }

      // LinkedIn prints 5,000+ and 10,000+ when the real total is past the cap.
      // On the company-scoped jobs-worldwide page that cap is a floor. On the
      // company page and on search results it is not a count.
      if (linkedInResult(item.url) && countIsOpenEnded(hay, count) && !linkedInJobsWorldwide(item.url, company)) {
        rejectCitation(company, count, item, 'linkedin display cap');
        return false;
      }

      if (!countBesideJobsPhrase(hay, count)) {
        rejectCitation(company, count, item, 'number is not in a jobs-count sentence');
        return false;
      }

      return true;
    }).sort((left, right) => sourceRank(left.url, company, input) - sourceRank(right.url, company, input));
    const source = matches[0];

    if (!source?.url) {
      continue;
    }

    const hay = `${source.title || ''} ${source.snippet || ''}`;
    const aggregator = aggregatorName(resultHost(source.url));
    candidates.push({
      count,
      url: source.url,
      rank: sourceRank(source.url, company, input),
      qualifier: aggregator ? scopeQualifier(hay, company) : '',
      openEnded: countIsOpenEnded(hay, count),
      site: sourceSite(source.url)
    });
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => left.rank - right.rank || Number(Boolean(left.qualifier)) - Number(Boolean(right.qualifier)));
  const best = candidates[0];
  const scopedAggregator = Boolean(best.qualifier);
  const floor = scopedAggregator || best.openEnded;

  return {
    count: best.count,
    source: 'search',
    estimated: true,
    url: best.url,
    ...(floor ? {
      lowerBound: true,
      scope: scopedAggregator ? 'aggregator_listings' : 'open_ended',
      scopeQualifier: best.qualifier || '',
      scopeSite: best.site || ''
    } : {})
  };
}

function scopedLinkedInCount(results, company) {
  for (const item of results || []) {
    if (!item?.url || !linkedInOpenJobsScoped(item.url, { company })) {
      continue;
    }

    const hay = `${item.title || ''} ${item.snippet || ''}`;

    if (!compact(hay).includes(compact(company))) {
      continue;
    }

    const counts = [...hay.matchAll(/\d[\d,]*/g)]
      .map((match) => Number(match[0].replace(/,/g, '')))
      .filter((count) => Number.isFinite(count) && count >= 1);

    for (const count of counts) {
      if (!countBesideJobsPhrase(hay, count)) {
        continue;
      }

      const capped = countIsOpenEnded(hay, count);

      if (capped && !linkedInJobsWorldwide(item.url, company)) {
        continue;
      }

      return {
        count,
        source: 'page',
        estimated: false,
        url: item.url,
        scoped: true,
        context: excerptAround(hay, count),
        ...(capped ? {
          lowerBound: true,
          scope: 'open_ended',
          scopeSite: 'LinkedIn'
        } : {})
      };
    }
  }

  return null;
}

async function searchScopedLinkedInJobs(company, deps) {
  if (typeof deps.webSearch !== 'function') {
    return null;
  }

  const slug = linkedinCompanySlugs(company)[0];

  if (!slug) {
    return null;
  }

  try {
    const results = await deps.webSearch(`"${company}" ${slug}-jobs-worldwide`, {
      includeDomains: ['linkedin.com'],
      env: deps.env,
      fetch: deps.fetch,
      timeoutMs: 4000
    });
    return scopedLinkedInCount(results, company);
  } catch {
    return null;
  }
}

function snippetLog(results) {
  return (results || []).map((item, index) => ({
    index: index + 1,
    title: item?.title || '',
    snippet: item?.snippet || '',
    url: item?.url || ''
  }));
}

async function estimateOpenJobs(company, deps) {
  if (typeof deps.webSearch !== 'function') {
    return null;
  }

  let results = [];

  try {
    results = await deps.webSearch(`"${company}" open jobs`, {
      env: deps.env,
      fetch: deps.fetch,
      timeoutMs: 4000
    });
  } catch {
    results = [];
  }

  const usable = (Array.isArray(results) ? results : []).filter((item) => item?.url && (item.title || item.snippet)).slice(0, 5);
  const scoped = scopedLinkedInCount(usable, company) || await searchScopedLinkedInJobs(company, deps);

  if (scoped) {
    console.info('[GHD] open jobs search', {
      company,
      snippets: snippetLog(usable),
      answer: null,
      count: scoped.count,
      url: scoped.url,
      context: scoped.context || '',
      reason: 'company-scoped linkedin jobs page'
    });
    return scoped;
  }

  if (typeof deps.askGroq !== 'function' || !usable.length) {
    return null;
  }

  const block = usable.map((item, index) => {
    return `${index + 1}. ${item.title || ''} ${item.snippet || ''} (${item.url})`.trim();
  }).join('\n');
  let text = '';

  try {
    text = await deps.askGroq(
      `Given these search results about ${company}, do any state a current number of open jobs or open positions at this company? If yes, what is the number and which result stated it? If none clearly state one, respond exactly UNKNOWN.\n\n${block}`,
      { env: deps.env, fetch: deps.fetch, timeoutMs: 4000, temperature: 0 }
    );
  } catch {
    return null;
  }

  const found = citedCount(text, usable, company, deps);
  const cited = usable.find((item) => item.url === found?.url);
  const citedText = `${cited?.title || ''} ${cited?.snippet || ''}`;
  console.info('[GHD] open jobs search', {
    company,
    snippets: snippetLog(usable),
    prompt: block,
    answer: String(text || ''),
    count: found?.count ?? null,
    url: found?.url || null,
    context: found ? excerptAround(citedText, found.count) : '',
    lowerBound: Boolean(found?.lowerBound),
    scope: found?.scope || '',
    scopeQualifier: found?.scopeQualifier || '',
    scopeSite: found?.scopeSite || ''
  });
  return found;
}

// Settles to { value } or { error }, so a speculative call that is never awaited
// cannot become an unhandled rejection.
function settle(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

// Profile fields (company website, Glassdoor open jobs) may arrive as a promise
// so the steps that do not need them can start before the profile finishes.
async function profileInput(input) {
  const profile = input?.profile ? await input.profile : null;

  return {
    website: input?.website || profile?.website || '',
    glassdoorOpenJobs: input?.glassdoorOpenJobs ?? profile?.openJobs,
    glassdoorSize: input?.glassdoorSize || profile?.glassdoorSize || ''
  };
}

function isLargeCompany(glassdoorSize) {
  return /10,?000\s*\+/.test(String(glassdoorSize || ''));
}

const LARGE_HEADCOUNT = 10000;

function positiveHeadcount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
}

// A promise that has already settled is readable. One that is still running
// is not waited on: the board-search decision uses only what is ready.
async function ifSettled(promise) {
  if (!promise || typeof promise.then !== 'function') {
    return { ready: true, value: promise ?? null };
  }

  let ready = false;
  let value = null;
  promise.then((result) => {
    ready = true;
    value = result;
  }, () => {
    ready = true;
  });
  await Promise.resolve();
  return ready ? { ready: true, value } : { ready: false, value: null };
}

async function readyHeadcount(company, deps) {
  const key = String(company || '').trim().toLowerCase();
  const wikiMemo = deps?.wikidataMemo instanceof Map ? deps.wikidataMemo.get(key) : null;
  const wiki = wikiMemo ? await ifSettled(wikiMemo) : { ready: false };
  const wikidata = wiki.ready ? positiveHeadcount(wiki.value?.count) : null;

  if (wikidata) {
    return { employees: wikidata, source: 'wikidata' };
  }

  const captured = positiveHeadcount(capturedEmployeeCount(deps?.capturedHeadcount, deps?.now));

  if (captured) {
    return { employees: captured, source: 'capture' };
  }

  const searchMemo = deps?.employeeSearchMemo instanceof Map ? deps.employeeSearchMemo.get(key) : null;
  const search = searchMemo ? await ifSettled(searchMemo) : { ready: false };
  const searched = search.ready ? positiveHeadcount(search.value?.employees) : null;

  if (searched) {
    return { employees: searched, source: 'search' };
  }

  return { employees: null, source: null };
}

// A known headcount of 10,000 or more skips the board search, as does
// Glassdoor's 10,000+ bucket. A smaller known bucket still searches. A missing
// bucket is not evidence the company is small, so it does not start that search.
function skipBoardSearch(estimate, glassdoorSize) {
  if (estimate != null) {
    return estimate >= LARGE_HEADCOUNT;
  }

  if (isLargeCompany(glassdoorSize)) {
    return true;
  }

  return !/\d/.test(String(glassdoorSize || ''));
}

// A verified Workday board, remembered so later checks skip both searches and
// read a fresh count from CXS. Only the board's address is kept, never a count,
// and never "this company has no board".
const WORKDAY_BOARD_TTL_MS = 60 * 24 * 60 * 60 * 1000;

function workdayBoardKey(company) {
  // v2: v1 could remember a sub-board found by search (Cleveland Clinic UK).
  return `workday_board_v2_${String(company || '').trim().toLowerCase()}`;
}

async function rememberWorkdayBoard(company, pageUrl, deps) {
  const board = parseWorkdayBoard(pageUrl || '');

  if (!board || !deps.cache) {
    return;
  }

  await cacheSet(deps.cache, workdayBoardKey(company), { pageUrl: board.pageUrl }, WORKDAY_BOARD_TTL_MS, deps.now || new Date());
}

async function rememberedWorkdayCount(company, deps) {
  if (!deps.cache || typeof deps.fetch !== 'function') {
    return { value: null, failed: false };
  }

  const now = deps.now || new Date();
  const stored = await cacheGet(deps.cache, workdayBoardKey(company), now);
  const board = parseWorkdayBoard(stored?.pageUrl || '');

  if (!board) {
    return { value: null, failed: false };
  }

  try {
    const counted = await workdayTotal(board, deps);
    console.info('[GHD] open jobs remembered workday', { company, url: board.pageUrl, count: counted?.count ?? null });
    return { value: counted, failed: false };
  } catch (error) {
    if (tokenNotFound(error)) {
      // The board is gone: forget it and look again.
      console.info('[GHD] open jobs remembered workday dropped', { company, url: board.pageUrl });
      await cacheSet(deps.cache, workdayBoardKey(company), { dropped: true }, 0, now);
      return { value: null, failed: false };
    }

    return { value: null, failed: true };
  }
}

async function lookupOpenJobs(company, input, deps) {
  let higherTierFailed = false;
  // Workday stops counting at 2,000. When Glassdoor already lists more (Target:
  // 2,000 on Workday, 12,089 on Glassdoor), the larger floor is the better one;
  // both are lower bounds and score the same way.
  const finish = async (value, tier) => {
    if (value?.scope === 'workday_cap') {
      const glassdoor = positiveCount((await profileInput(input)).glassdoorOpenJobs);

      if (glassdoor > value.count) {
        console.info('[GHD] open jobs floor raised', { company, workday: value.count, glassdoor, board: value.url });
        return {
          value: { count: glassdoor, source: 'glassdoor', estimated: false, lowerBound: true, scope: 'glassdoor_listings', url: '', workdayBoard: value.url },
          tier: `${tier}+glassdoor`,
          higherTierFailed
        };
      }
    }

    return { value: value || null, tier, higherTierFailed };
  };
  const knownBoard = parseAtsBoard(input?.jobUrl || '') || parseAtsBoard(input?.website || '');
  const ownTenant = parseWorkdayBoard(input?.jobUrl || '');
  // The paid searches (Tavily board search, then Workday discovery) run only
  // when every free source before them has missed. They used to start at once
  // and were thrown away whenever a direct board answered.
  const board = knownBoard || parseAtsBoard((await profileInput(input)).website);

  if (board && typeof deps.fetch === 'function') {
    try {
      const counted = await countAtsBoard(board, deps);

      if (counted) {
        return finish(counted, 'known-board');
      }
    } catch (error) {
      higherTierFailed = true;
      console.info('[GHD] open jobs ats error', {
        company,
        platform: board.platform,
        error: error?.message || String(error)
      });
    }
  }

  if (ownTenant) {
    try {
      const counted = await verifiedWorkdayTotal(input.jobUrl, company, deps, { ownTenant: true });

      if (counted) {
        await rememberWorkdayBoard(company, counted.url, deps);
        return finish(counted, 'own-tenant');
      }
    } catch (error) {
      higherTierFailed = true;
      console.info('[GHD] open jobs workday error', {
        company,
        url: input?.jobUrl || '',
        error: error?.message || String(error)
      });
    }
  }

  if (!ownTenant && !board) {
    const direct = await guessDirectBoards(company, deps);

    if (direct.failed) {
      higherTierFailed = true;
    }

    if (direct.value) {
      return finish(direct.value, 'direct-token');
    }
  }

  if (!ownTenant) {
    const remembered = await rememberedWorkdayCount(company, deps);

    if (remembered.failed) {
      higherTierFailed = true;
    }

    if (remembered.value) {
      return finish(remembered.value, 'remembered-workday');
    }
  }

  // The company's own careers page, before any paid search. A Workday board
  // linked there counts as the company's (the domain was verified), subject to
  // the sub-board rule. An ATS board still has its name checked.
  let unsupportedSystem = null;

  if (!ownTenant && !board) {
    const site = await careersPageSignal(company, (await profileInput(input)).website, deps, { parseWorkdayBoard, parseAtsBoard });

    if (site.board?.kind === 'workday') {
      try {
        const counted = await verifiedWorkdayTotal(site.board.url, company, deps, { linkedFromOwnSite: true });

        if (counted) {
          await rememberWorkdayBoard(company, counted.url, deps);
          return finish(counted, 'careers-page');
        }
      } catch (error) {
        higherTierFailed = true;
        console.info('[GHD] open jobs careers page workday error', { company, url: site.board.url, error: error?.message || String(error) });
      }
    } else if (site.board?.kind === 'ats') {
      try {
        const verified = await checkBoard({ platform: site.board.platform, token: site.board.token }, company, deps);

        if (verified.ok) {
          return finish(verified.counted, 'careers-page');
        }
      } catch (error) {
        higherTierFailed = true;
        console.info('[GHD] open jobs careers page board error', { company, url: site.board.url, error: error?.message || String(error) });
      }
    } else if (site.unsupported) {
      unsupportedSystem = site.unsupported.system;
    }
  }

  const boardSearch = async () => {
    const found = await settle(discoverAtsBoards(company, deps));

    if (found.error) {
      higherTierFailed = true;
      console.info('[GHD] open jobs board search error', { company, error: found.error?.message || String(found.error) });
      return null;
    }

    return found.value ? { value: found.value, tier: 'board-search' } : null;
  };
  const workdaySearch = async () => {
    const outcome = await settle(discoverWorkday(company, deps));

    if (outcome.error) {
      // Recorded wherever it sits in the order. When nothing after it answers,
      // the Glassdoor floor is used, and higherTierFailed keeps that result for
      // minutes, not a day, so the search is retried soon.
      higherTierFailed = true;
      console.info('[GHD] open jobs workday search error', { company, error: outcome.error?.message || String(outcome.error) });
      return null;
    }

    if (outcome.value) {
      await rememberWorkdayBoard(company, outcome.value.url, deps);
      return { value: outcome.value, tier: 'workday-discovery' };
    }

    return null;
  };

  // Paid searches, one at a time. A company of 10,000 or more (a headcount
  // already in hand, otherwise Glassdoor's 10,000+ bucket) gets the Workday
  // search only: in 15 logged checks of such companies the board search
  // (1.3-4.0s on a first query) answered none; Workday answered 5 and the
  // Glassdoor floor the rest. A missing size is not treated as small. A known
  // smaller bucket still searches boards, then Workday. The floor and estimate
  // tiers below still run.
  const searchBoards = !ownTenant && !board;
  const profile = await profileInput(input);
  const headcount = await readyHeadcount(company, deps);
  const large = skipBoardSearch(headcount.employees, profile.glassdoorSize);
  // A careers page that links a job system this step cannot count (iCIMS,
  // Taleo, the company's own jobs site) skips the paid board searches; the
  // Glassdoor floor and the estimate tiers below still apply.
  const steps = !ownTenant && !unsupportedSystem
    ? (searchBoards
      ? (large ? ['workday'] : ['boards', 'workday'])
      : ['workday'])
    : [];

  if (unsupportedSystem) {
    console.info('[GHD] open jobs searches skipped', { company, reason: `careers page uses ${unsupportedSystem}` });
  }

  console.info('[GHD] open jobs search order', {
    company,
    order: steps,
    glassdoorSize: profile.glassdoorSize || null,
    headcount: headcount.employees,
    headcountSource: headcount.source
  });

  for (const step of steps) {
    const answer = step === 'boards' ? await boardSearch() : await workdaySearch();

    if (answer) {
      return finish(answer.value, answer.tier);
    }
  }

  const glassdoor = positiveCount((await profileInput(input)).glassdoorOpenJobs);

  // Glassdoor counts only the jobs listed on Glassdoor, not the company's own
  // board (Spring Health: 5 there, 67 on its Ashby board). It is a lower bound.
  if (glassdoor) {
    return finish({
      count: glassdoor,
      source: 'glassdoor',
      estimated: false,
      lowerBound: true,
      scope: 'glassdoor_listings',
      url: ''
    }, 'glassdoor');
  }

  return finish(await estimateOpenJobs(company, {
    ...deps,
    website: profile.website,
    platform: input?.platform || '',
    hostname: input?.hostname || '',
    jobUrl: input?.jobUrl || ''
  }), 'search');
}

export async function resolveOpenJobCount(company, input = {}, deps = {}) {
  const name = String(company || '').trim();

  if (!name) {
    return null;
  }

  const listed = onPageOpenJobs(company, input);

  if (listed) {
    console.info('[GHD] open jobs', { company: name, ...listed });
    logCareersCheck(name, input?.jobTitle || '', listed);
    // The visible listing answered before any board fetch. A later careers
    // check may read the cache or fetch the board; this pass does not.
    return { ...listed, careers: null, careersChecked: false };
  }

  const now = deps.now || new Date();
  const key = openJobsCacheKey(name);

  if (deps.cache) {
    const meta = await cacheGetMeta(deps.cache, key, now);
    const cached = meta?.payload;

    if (cached?.miss) {
      const fresh = !deps.refresh && writtenWithin(meta.updatedAt, OPEN_JOBS_TTL_MS, now);

      if (fresh) {
        logCareersCheck(name, input?.jobTitle || '', null);
        return null;
      }
    } else if (typeof cached?.count === 'number') {
      logCareersCheck(name, input?.jobTitle || '', cached);
      return attachCareers(name, input?.jobTitle || '', cached);
    }
  }

  let outcome = null;

  try {
    outcome = await lookupOpenJobs(name, input, deps);
  } catch (error) {
    console.info('[GHD] open jobs error', { company: name, error: error?.message || String(error) });
    logCareersCheck(name, input?.jobTitle || '', null);
    return null;
  }

  const found = outcome?.value || null;
  const higherTierFailed = Boolean(outcome?.higherTierFailed);

  console.info('[GHD] open jobs', {
    company: name,
    count: found?.count ?? null,
    source: found?.source || null,
    estimated: Boolean(found?.estimated),
    lowerBound: Boolean(found?.lowerBound),
    scope: found?.scope || '',
    url: found?.url || '',
    tier: outcome?.tier || null,
    higherTierFailed
  });
  logCareersCheck(name, input?.jobTitle || '', found);

  if (deps.cache) {
    const payload = found
      ? { ...found, tier: outcome.tier, higherTierFailed }
      : { miss: true, tier: outcome?.tier || null, higherTierFailed };
    await cacheSet(
      deps.cache,
      key,
      payload,
      higherTierFailed ? OPEN_JOBS_RETRY_TTL_MS : OPEN_JOBS_TTL_MS,
      now
    );
  }

  return attachCareers(name, input?.jobTitle || '', found);
}

// Used after the card is up, and only when the open-roles pass did not fetch a
// board. A cached complete board is compared as-is. A fetch here is not written
// back over the hiring-ratio cache.
export async function checkCompanyCareers(company, input = {}, deps = {}) {
  const name = String(company || '').trim();

  if (!name) {
    return null;
  }

  const now = deps.now || new Date();
  const key = openJobsCacheKey(name);
  const cached = deps.cache ? await cacheGet(deps.cache, key, now) : null;
  const stored = completeBoard(cached) ? cached : null;

  if (stored) {
    logCareersCheck(name, input.jobTitle || '', stored);
    return careersDisplay(name, input.jobTitle || '', stored);
  }

  let found = null;

  try {
    const outcome = await lookupOpenJobs(name, {
      ...input,
      onPageCount: null,
      openJobsPageUrl: ''
    }, deps);
    found = outcome?.value || null;
  } catch (error) {
    console.info('[GHD] open jobs error', { company: name, error: error?.message || String(error) });
    logCareersCheck(name, input.jobTitle || '', null);
    return null;
  }

  logCareersCheck(name, input.jobTitle || '', found);
  return careersDisplay(name, input.jobTitle || '', found);
}
