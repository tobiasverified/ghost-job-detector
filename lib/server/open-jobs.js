import { cacheGet, cacheSet } from './cache.js';
import { resultSubject, searchResultMatchesCompany } from './employees.js';
import { linkedinCompanySlugs } from './workforce.js';

const OPEN_JOBS_TTL_MS = 24 * 60 * 60 * 1000;
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
function openJobsCacheKey(company) {
  return `open_jobs_v11_${String(company || '').trim().toLowerCase()}`;
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

async function readJson(deps, url, options = {}) {
  const response = await deps.fetch(url, {
    ...options,
    signal: AbortSignal.timeout(8000)
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
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs`
    );
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    return jobs.length ? { count: jobs.length, source: 'greenhouse', estimated: false, url: `https://boards.greenhouse.io/${board.token}`, titles: listedTitles(jobs, 'title') } : null;
  }

  if (board.platform === 'lever') {
    const payload = await readJson(
      deps,
      `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`
    );
    const jobs = Array.isArray(payload) ? payload : [];
    return jobs.length ? { count: jobs.length, source: 'lever', estimated: false, url: `https://jobs.lever.co/${board.token}`, titles: listedTitles(jobs, 'text') } : null;
  }

  const payload = await readJson(
    deps,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}`
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

function logCareersCheck(company, jobTitle, result) {
  const board = ['greenhouse', 'lever', 'ashby', 'workday'].includes(result?.source) ? result.source : (result?.source || null);

  if (!completeBoard(result)) {
    console.info('[GHD] careers check', {
      company,
      board,
      jobCount: typeof result?.count === 'number' ? result.count : null,
      matchedTitle: '',
      overlap: null,
      outcome: 'board unverified'
    });
    return;
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

  console.info('[GHD] careers check', {
    company,
    board: result.source,
    jobCount: result.count,
    matchedTitle,
    overlap,
    outcome: best?.agrees ? 'found' : 'not found'
  });
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

  return {
    count: Math.round(total),
    source: 'workday',
    estimated: false,
    url: board.pageUrl
  };
}

const WORKDAY_SITE_BOILERPLATE = new Set(['careers', 'career', 'jobs', 'job', 'external', 'site', 'portal', 'opportunities']);

// For the posting's OWN tenant only (the board the job is on), not for
// tenants found by search. "argonne.wd1.../Argonne_Careers": with the generic
// "Careers" removed, the site is "argonne", the same as the tenant name, and it
// names the company. Two separate parts of the address agree, so this is the
// tenant's general careers site. A site with any other word ("Argonne_Students")
// does not equal the tenant name and falls back to the checks below.
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

  const slugMatch = workdaySiteMatchesCompany(board.site, company)
    || (options.ownTenant === true && ownTenantSiteNamesCompany(board, company));
  let matched = slugMatch;

  if (!matched) {
    const html = await workdayPageText(board.pageUrl, deps);
    matched = pageOrgNames(html).some((name) => orgNameMatches(company, name, board.pageUrl))
      || (options.ownTenant === true && descriptionNamesCompany(html, company));
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
  const candidates = (Array.isArray(results) ? results : [])
    .map((result) => result?.url)
    .filter((url) => parseWorkdayBoard(url))
    .slice(0, 3);

  for (const url of candidates) {
    try {
      const counted = await verifiedWorkdayTotal(url, company, deps);

      if (counted) {
        return counted;
      }
    } catch (error) {
      console.info('[GHD] open jobs workday error', {
        company,
        url,
        error: error?.message || String(error)
      });
    }
  }

  return null;
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
    const payload = await readJson(deps, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}`);
    return [String(payload?.name || '').trim()].filter(Boolean);
  }

  const pageUrl = board.platform === 'lever'
    ? `https://jobs.lever.co/${encodeURIComponent(board.token)}`
    : `https://jobs.ashbyhq.com/${encodeURIComponent(board.token)}`;
  const response = await deps.fetch(pageUrl, {
    headers: PAGE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    return [];
  }

  return pageOrgNames(typeof response.text === 'function' ? await response.text() : '');
}

async function verifyBoard(board, company, deps) {
  const token = boardTokenVerdict(company, board.token);

  if (!token.ok) {
    return { ok: false, reason: token.reason };
  }

  const names = await readBoardName(board, deps);
  const verdicts = names.map((name) => boardNameVerdict(company, name));
  const passed = verdicts.find((verdict) => verdict.ok);

  if (!passed) {
    const first = verdicts[0] || { reason: 'board name missing', subject: '' };
    return { ok: false, reason: first.reason, name: first.subject, extra: first.extra };
  }

  const counted = await countAtsBoard(board, deps);
  return counted ? { ok: true, name: passed.subject, counted } : { ok: false, reason: 'board has no jobs', name: passed.subject };
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
      return { board, ...(await verifyBoard(board, company, deps)) };
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
    glassdoorOpenJobs: input?.glassdoorOpenJobs ?? profile?.openJobs
  };
}

async function lookupOpenJobs(company, input, deps) {
  const knownBoard = parseAtsBoard(input?.jobUrl || '') || parseAtsBoard(input?.website || '');
  const ownTenant = parseWorkdayBoard(input?.jobUrl || '');
  // Discovery is the slow step (a search plus board fetches) and needs nothing
  // from the steps before it. While the profile (and so the company website) is
  // still pending it starts now; its answer is still only used in its place in
  // the order below, so an earlier source still wins.
  const speculate = !knownBoard && !ownTenant && input?.profile;
  const speculativeBoards = speculate ? settle(discoverAtsBoards(company, deps)) : null;
  const speculativeDiscovery = speculate ? settle(discoverWorkday(company, deps)) : null;
  const board = knownBoard || parseAtsBoard((await profileInput(input)).website);

  if (board && typeof deps.fetch === 'function') {
    try {
      const counted = await countAtsBoard(board, deps);

      if (counted) {
        return counted;
      }
    } catch (error) {
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
        return counted;
      }
    } catch (error) {
      console.info('[GHD] open jobs workday error', {
        company,
        url: input?.jobUrl || '',
        error: error?.message || String(error)
      });
    }
  }

  if (!ownTenant && !board) {
    const found = speculativeBoards ? await speculativeBoards : await settle(discoverAtsBoards(company, deps));

    if (found.error) {
      console.info('[GHD] open jobs board search error', { company, error: found.error?.message || String(found.error) });
    } else if (found.value) {
      return found.value;
    }
  }

  if (!ownTenant) {
    const outcome = speculativeDiscovery ? await speculativeDiscovery : await settle(discoverWorkday(company, deps));

    if (outcome.error) {
      throw outcome.error;
    }

    if (outcome.value) {
      return outcome.value;
    }
  }

  const glassdoor = positiveCount((await profileInput(input)).glassdoorOpenJobs);

  // Glassdoor counts only the jobs listed on Glassdoor, not the company's own
  // board (Spring Health: 5 there, 67 on its Ashby board). It is a lower bound.
  if (glassdoor) {
    return { count: glassdoor, source: 'glassdoor', estimated: false, lowerBound: true, scope: 'glassdoor_listings', url: '' };
  }

  const profile = await profileInput(input);

  return estimateOpenJobs(company, {
    ...deps,
    website: profile.website,
    platform: input?.platform || '',
    hostname: input?.hostname || '',
    jobUrl: input?.jobUrl || ''
  });
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
    return listed;
  }

  const now = deps.now || new Date();
  const key = openJobsCacheKey(name);

  if (deps.cache) {
    const cached = await cacheGet(deps.cache, key, now);

    if (cached?.miss) {
      logCareersCheck(name, input?.jobTitle || '', null);
      return null;
    }

    if (typeof cached?.count === 'number') {
      logCareersCheck(name, input?.jobTitle || '', cached);
      return withoutBoardTitles(cached);
    }
  }

  let found = null;

  try {
    found = await lookupOpenJobs(name, input, deps);
  } catch (error) {
    console.info('[GHD] open jobs error', { company: name, error: error?.message || String(error) });
    logCareersCheck(name, input?.jobTitle || '', null);
    return null;
  }

  console.info('[GHD] open jobs', {
    company: name,
    count: found?.count ?? null,
    source: found?.source || null,
    estimated: Boolean(found?.estimated),
    lowerBound: Boolean(found?.lowerBound),
    scope: found?.scope || '',
    url: found?.url || ''
  });
  logCareersCheck(name, input?.jobTitle || '', found);

  if (deps.cache) {
    await cacheSet(deps.cache, key, found || { miss: true }, OPEN_JOBS_TTL_MS, now);
  }

  return withoutBoardTitles(found);
}
