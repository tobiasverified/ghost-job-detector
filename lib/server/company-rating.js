import { NAME_REJECTION_TTL_MS, cacheGet, cacheGetMeta, cacheSet, createCache, writtenWithin } from './cache.js';
import { GENERIC_TOKENS, companyLookupName, shorterCompanyNames, STANDALONE_BLOCK } from './companies.js';
import { findEmployeeCountBySearch } from './employees.js';
import { applyCors, cleanString, clientIp, requireClient, sendJson } from './http.js';
import { createRateLimiter } from './rateLimit.js';
import { linkedinCompanySlugs } from './workforce.js';

export const GLASSDOOR_HOST = 'best-glassdoor-scraper-free-1000-calls.p.rapidapi.com';
const HOST = GLASSDOOR_HOST;
const WIKIDATA_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)'
};
const RATING_TTL_MS = 24 * 60 * 60 * 1000;

export function ratingCacheKey(company) {
  // v6 drops v5 name rejections that a Wikidata alias now accepts
  // ("Georgia Tech" for Georgia Institute of Technology).
  // v5 drops v4 entries that cached a contradicted hit (Ford: an Australian
  // "Ford" with 51-200 employees) instead of retrying under the Wikidata label.
  // v4 drops v3 entries that kept an empty same-name entity ("Intel": 0 reviews,
  // 1-50 employees) instead of the real employer.
  // v3 drops v2 entries that accepted a one-word alias for a longer company name.
  return `glassdoor_rating_v6_${company.toLowerCase()}`;
}

// A hit with no rating and no reviews is a placeholder page, not evidence about
// the employer. Glassdoor answers "Intel" with one (id 10434062: 0 reviews,
// 1-50 employees) and "Intel Corporation" with the real one (39,680 reviews).
export function isWeakGlassdoorHit(details) {
  return details?.overall == null && !(Number(details?.reviewCount) > 0);
}

const LEGAL_FORM_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|group|holdings)\.?$/i;

// Tried once, and only after a weak hit.
export function legalFormVariants(company) {
  const name = String(company || '').trim();
  return name && !LEGAL_FORM_SUFFIX.test(name) ? [`${name} Corporation`, `${name} Inc`] : [];
}

// Upper end of a closed Glassdoor bucket ("1 to 50 Employees" -> 50). An
// open-ended bucket ("10000+") has no upper end.
function closedBucketMax(glassdoorSize) {
  const match = String(glassdoorSize || '').replace(/,/g, '').match(/(\d+)\s*(?:to|-)\s*(\d+)/i);
  return match ? Number(match[2]) : null;
}

// Wikidata 10x larger than Glassdoor's closed bucket means the Glassdoor page is
// a different, smaller entity. Only this direction: a Wikidata figure far BELOW
// Glassdoor is usually stale (University of Miami), and Glassdoor is kept then.
export const ENTITY_CONTRADICTION_FACTOR = 10;

export function glassdoorRatingUrl(company) {
  const url = new URL(`https://${HOST}/companies/details`);
  url.searchParams.set('company', company);
  return url;
}

// Glassdoor sometimes returns the size bucket "Unknown". That is not a
// headcount and must not be shown as the company size.
export function usableGlassdoorSize(size) {
  const text = String(size || '').replace(/\s+/g, ' ').trim();

  if (!text || /^unknown$/i.test(text)) {
    return '';
  }

  return text;
}

export function parseEmployeeSize(sizeStr) {
  const text = String(sizeStr || '').replace(/\s+/g, ' ').trim();

  if (!text) {
    return null;
  }

  const rangeMatch = text.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*employees?/i);

  if (rangeMatch) {
    const minimum = Number(rangeMatch[1].replace(/,/g, ''));
    const maximum = Number(rangeMatch[2].replace(/,/g, ''));

    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) {
      return null;
    }

    return Math.round((minimum + maximum) / 2);
  }

  const plusMatch = text.match(/(\d[\d,]*)\s*\+\s*employees?/i);

  if (plusMatch) {
    const minimum = Number(plusMatch[1].replace(/,/g, ''));

    if (!Number.isFinite(minimum) || minimum <= 0) {
      return null;
    }

    return minimum;
  }

  return null;
}

function formatEmployeeCount(value) {
  return Math.round(value).toLocaleString('en-US');
}

function employeePresentation(sizeStr) {
  const employees = parseEmployeeSize(sizeStr);
  const text = String(sizeStr || '').replace(/\s+/g, ' ').trim();

  if (employees == null) {
    return { employees: null, employeeLabel: null, employeesLowerBound: false };
  }

  const rangeMatch = text.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*employees?/i);

  if (rangeMatch) {
    return {
      employees,
      employeeLabel: formatEmployeeCount(employees),
      employeesLowerBound: false,
      employeeRangeMin: Number(rangeMatch[1].replace(/,/g, '')),
      employeeRangeMax: Number(rangeMatch[2].replace(/,/g, ''))
    };
  }

  if (/(\d[\d,]*)\s*\+\s*employees?/i.test(text)) {
    return {
      employees,
      employeeLabel: `${formatEmployeeCount(employees)}+`,
      employeesLowerBound: true,
      employeeRangeMin: employees,
      employeeRangeMax: null
    };
  }

  return {
    employees,
    employeeLabel: formatEmployeeCount(employees),
    employeesLowerBound: false
  };
}

function readWebsite(payload) {
  const text = String(payload?.website || payload?.link || '').trim();

  if (!text) {
    return '';
  }

  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(text)) {
    return `https://${text}`;
  }

  return '';
}

function readOpenJobs(payload) {
  const value = payload?.counts?.open_jobs;

  if (value == null || value === '') {
    return null;
  }

  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function readReviewCount(payload) {
  const value = payload?.counts?.reviews;

  if (value == null || value === '') {
    return null;
  }

  const count = Number(String(value).replace(/,/g, ''));

  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  return Math.round(count);
}

export function companyDetails(payload, cached = false) {
  const size = usableGlassdoorSize(payload?.size);
  const presentation = employeePresentation(size);

  return {
    overall: readOverall(payload),
    employees: presentation.employees,
    employeeLabel: presentation.employeeLabel,
    ...(presentation.employeesLowerBound ? { employeesLowerBound: true } : {}),
    ...(Number.isFinite(presentation.employeeRangeMin) ? { employeeRangeMin: presentation.employeeRangeMin } : {}),
    ...(Number.isFinite(presentation.employeeRangeMax) ? { employeeRangeMax: presentation.employeeRangeMax } : {}),
    openJobs: readOpenJobs(payload),
    ...(readReviewCount(payload) ? { reviewCount: readReviewCount(payload) } : {}),
    ...(readWebsite(payload) ? { website: readWebsite(payload) } : {}),
    // Glassdoor's own size bucket ("10000+ Employees"), kept when another source
    // replaces the headcount; open roles orders its searches by it.
    ...(size ? { glassdoorSize: size } : {}),
    source: 'glassdoor',
    cached
  };
}

function cachedDetails(cached) {
  if (!cached || typeof cached !== 'object') {
    return null;
  }

  if (cached.ratings || cached.size || cached.counts) {
    return companyDetails(cached, true);
  }

  if (typeof cached.overall === 'number') {
    return {
      overall: cached.overall,
      employees: typeof cached.employees === 'number' ? cached.employees : null,
      employeeLabel: cached.employeeLabel || null,
      ...(cached.employeesLowerBound ? { employeesLowerBound: true } : {}),
      ...(cached.employeeSource ? { employeeSource: cached.employeeSource } : {}),
      openJobs: typeof cached.openJobs === 'number' ? cached.openJobs : null,
      ...(Number(cached.reviewCount) > 0 ? { reviewCount: Math.round(Number(cached.reviewCount)) } : {}),
      source: 'glassdoor',
      cached: true
    };
  }

  return null;
}

function unavailable() {
  return { overall: null, error: 'unavailable' };
}

function readOverall(payload) {
  const value = Number(payload?.ratings?.overall);

  if (!Number.isFinite(value) || value <= 0 || value > 5) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function usefulDetails(details) {
  return details.overall != null || details.employees != null || details.openJobs != null;
}

function notFound() {
  return { overall: null, error: 'not_found' };
}

function readWikidataEmployeeCount(statements) {
  const list = Array.isArray(statements) ? statements : [];
  const ranked = [...list].sort((left, right) => {
    const preferred = Number(right?.rank === 'preferred') - Number(left?.rank === 'preferred');

    if (preferred) {
      return preferred;
    }

    const leftTime = Date.parse(String(left?.qualifiers?.P585?.[0]?.datavalue?.value?.time || '').replace(/^\+/, ''));
    const rightTime = Date.parse(String(right?.qualifiers?.P585?.[0]?.datavalue?.value?.time || '').replace(/^\+/, ''));
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  for (const statement of ranked) {
    const amount = Number(String(statement?.mainsnak?.datavalue?.value?.amount || '').replace(/^\+/, ''));

    if (Number.isFinite(amount) && amount > 0) {
      return Math.round(amount);
    }
  }

  return null;
}

// The Wikidata entity this lookup used, by its label ("Ford" -> "Ford Motor
// Company"). Recorded for the request so a rejected Glassdoor hit can be retried
// under that name without another Wikidata call.
function recordWikidataLabel(deps, name, label) {
  const text = String(label || '').trim();

  if (text && deps?.wikidataLabels instanceof Map) {
    deps.wikidataLabels.set(String(name || '').trim().toLowerCase(), text);
  }
}

function recordWikidataAliases(deps, name, aliases) {
  const list = (Array.isArray(aliases) ? aliases : [])
    .map((alias) => String(alias || '').trim())
    .filter(Boolean);

  if (list.length && deps?.wikidataAliases instanceof Map) {
    deps.wikidataAliases.set(String(name || '').trim().toLowerCase(), list);
  }
}

// The entity's official website (P856), from the same lookup. The careers-page
// check accepts a company website that matches it.
function recordWikidataWebsites(deps, name, websites) {
  const list = (Array.isArray(websites) ? websites : []).map((url) => String(url || '').trim()).filter(Boolean);

  if (list.length && deps?.wikidataWebsites instanceof Map) {
    deps.wikidataWebsites.set(String(name || '').trim().toLowerCase(), list);
  }
}

function readWikidataWebsites(claims) {
  return (Array.isArray(claims) ? claims : [])
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value))
    .slice(0, 3);
}

// Once per request: the label retry merges employee counts a second time and
// must not fetch Wikidata again.
function lookupWikidataEmployees(company, deps) {
  const name = String(company || '').trim().toLowerCase();
  const memo = deps?.wikidataMemo instanceof Map ? deps.wikidataMemo : null;

  if (memo?.has(name)) {
    return memo.get(name);
  }

  const pending = fetchWikidataEmployees(company, deps);
  memo?.set(name, pending);
  return pending;
}

async function fetchWikidataEmployees(company, deps) {
  const name = String(company || '').trim();

  if (!name || !deps.fetch) {
    return null;
  }

  // v3 entries also carry the official website (entityWebsites), read by the
  // careers-page check. v2 entries carry the entity's label (entityLabel),
  // which the Glassdoor label retry reads. Unversioned entries had neither.
  const key = `wikidata_employees_v3_${name.toLowerCase()}`;
  const cached = await cacheGet(deps.cache, key, deps.now);

  if (cached?.miss) {
    recordWikidataLabel(deps, name, cached.entityLabel);
    recordWikidataAliases(deps, name, cached.entityAliases);
    recordWikidataWebsites(deps, name, cached.entityWebsites);
    return null;
  }

  if (typeof cached?.count === 'number' && cached.count > 0) {
    recordWikidataLabel(deps, name, cached.entityLabel);
    recordWikidataAliases(deps, name, cached.entityAliases);
    recordWikidataWebsites(deps, name, cached.entityWebsites);
    return cached;
  }

  // The size line may read a Wikidata figure already stored. It does not search.
  if (deps?.wikidataCacheOnly) {
    return null;
  }

  try {
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    searchUrl.searchParams.set('action', 'wbsearchentities');
    searchUrl.searchParams.set('search', companyLookupName(name) || name);
    searchUrl.searchParams.set('language', 'en');
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('limit', '1');
    searchUrl.searchParams.set('origin', '*');
    const searchResponse = await deps.fetch(searchUrl, {
      headers: WIKIDATA_HEADERS,
      signal: AbortSignal.timeout(8000)
    });

    if (!searchResponse.ok) {
      return null;
    }

    const search = await searchResponse.json();
    const id = search?.search?.[0]?.id;
    const entityLabel = String(search?.search?.[0]?.label || '').trim();
    recordWikidataLabel(deps, name, entityLabel);

    if (!id) {
      await cacheSet(deps.cache, key, { miss: true }, RATING_TTL_MS, deps.now);
      return null;
    }

    const entityUrl = new URL('https://www.wikidata.org/w/api.php');
    entityUrl.searchParams.set('action', 'wbgetentities');
    entityUrl.searchParams.set('ids', id);
    entityUrl.searchParams.set('props', 'claims|labels|aliases');
    entityUrl.searchParams.set('format', 'json');
    entityUrl.searchParams.set('origin', '*');
    const entityResponse = await deps.fetch(entityUrl, {
      headers: WIKIDATA_HEADERS,
      signal: AbortSignal.timeout(8000)
    });

    if (!entityResponse.ok) {
      return null;
    }

    const entity = await entityResponse.json();
    const record = entity?.entities?.[id];
    const officialLabel = String(record?.labels?.en?.value || entityLabel || '').trim();
    const entityAliases = (record?.aliases?.en || [])
      .map((alias) => String(alias?.value || '').trim())
      .filter(Boolean);
    const count = readWikidataEmployeeCount(record?.claims?.P1128);
    const entityWebsites = readWikidataWebsites(record?.claims?.P856);
    recordWikidataLabel(deps, name, officialLabel);
    recordWikidataAliases(deps, name, entityAliases);
    recordWikidataWebsites(deps, name, entityWebsites);
    const extra = {
      ...(officialLabel ? { entityLabel: officialLabel } : {}),
      ...(entityAliases.length ? { entityAliases } : {}),
      ...(entityWebsites.length ? { entityWebsites } : {})
    };

    if (count == null) {
      await cacheSet(deps.cache, key, { miss: true, ...extra }, RATING_TTL_MS, deps.now);
      return null;
    }

    const result = { count, label: formatEmployeeCount(count), ...extra };
    await cacheSet(deps.cache, key, result, RATING_TTL_MS, deps.now);
    return result;
  } catch {
    return null;
  }
}

const WIKIDATA_DISAGREEMENT_FACTOR = 3;
// Glassdoor's buckets through "501-1,000" span fewer than 1,000 people.
// "1,001-5,000" is the first standard bucket whose midpoint can miss by
// thousands. Unbounded "X+" buckets are wide regardless of span.
const WIDE_BUCKET_SPAN = 1000;
// 126 is the midpoint of Glassdoor's "51 to 200" bucket, so a floor of 100
// would still accept the wrong-entity TKO match. Counts under 200 need a
// second source in the same band.
const UNCORROBORATED_HEADCOUNT_FLOOR = 200;

function wikidataEmployeesPlausible(count, details) {
  const anchor = Number(details?.employees);

  if (!Number.isFinite(anchor) || anchor <= 0) {
    return true;
  }

  const openEnded = Boolean(details.employeesLowerBound)
    || /\d[\d,]*\s*\+$/.test(String(details.employeeLabel || ''));

  if (count < anchor / WIKIDATA_DISAGREEMENT_FACTOR) {
    return false;
  }

  if (!openEnded && count > anchor * WIKIDATA_DISAGREEMENT_FACTOR) {
    return false;
  }

  return true;
}

function isOpenEndedEmployeeBucket(details) {
  return Boolean(details?.employeesLowerBound)
    || /\d[\d,]*\s*\+$/.test(String(details?.employeeLabel || ''));
}

function isWideEmployeeBucket(details) {
  if (isOpenEndedEmployeeBucket(details)) {
    return true;
  }

  const minimum = Number(details?.employeeRangeMin);
  const maximum = Number(details?.employeeRangeMax);
  return Number.isFinite(minimum) && Number.isFinite(maximum) && maximum - minimum >= WIDE_BUCKET_SPAN;
}

function captureOutsideBucket(count, details) {
  const minimum = Number(details?.employeeRangeMin);

  if (!Number.isFinite(minimum)) {
    return false;
  }

  const maximum = Number(details?.employeeRangeMax);

  if (!Number.isFinite(maximum)) {
    return count < minimum;
  }

  return count < minimum || count > maximum;
}

function withoutBucketRange(details) {
  if (!details || typeof details !== 'object') {
    return details;
  }

  const next = { ...details };
  delete next.employeeRangeMin;
  delete next.employeeRangeMax;
  return next;
}

function employeeDiscrepancy() {
  return 'A conflicting headcount was set aside and is not included in this ratio.';
}

function countsDisagree(left, right) {
  const anchor = Number(left);
  const other = Number(right);

  if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(other) || other <= 0) {
    return false;
  }

  return other < anchor / WIKIDATA_DISAGREEMENT_FACTOR
    || other > anchor * WIKIDATA_DISAGREEMENT_FACTOR;
}

function clearEmployeeCount(details, discrepancy) {
  const next = {
    ...details,
    employees: null,
    employeeLabel: null
  };
  delete next.employeesLowerBound;

  if (discrepancy) {
    next.employeeDiscrepancy = discrepancy;
  }

  return next;
}

function glassdoorEntityFields(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const nested = [body.company, body.employer, body.details, body.data]
    .find((item) => item && typeof item === 'object') || {};
  const pick = (source, keys) => {
    for (const key of keys) {
      const value = source?.[key];

      if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();

        if (text) {
          return text.slice(0, 200);
        }
      }
    }

    return null;
  };
  const nameKeys = ['name', 'company_name', 'companyName', 'shortName', 'employer_name', 'employerName'];
  const idKeys = ['id', 'company_id', 'companyId', 'employer_id', 'employerId'];
  const urlKeys = ['url', 'company_url', 'companyUrl', 'website', 'link'];

  const counts = body.counts && typeof body.counts === 'object' ? body.counts : null;
  const ratings = body.ratings && typeof body.ratings === 'object' ? body.ratings : null;

  return {
    size: pick(body, ['size']),
    name: pick(body, nameKeys) || pick(nested, nameKeys),
    id: pick(body, idKeys) || pick(nested, idKeys),
    url: pick(body, urlKeys) || pick(nested, urlKeys),
    overall: ratings && Object.prototype.hasOwnProperty.call(ratings, 'overall') ? ratings.overall : null,
    reviewCount: counts && Object.prototype.hasOwnProperty.call(counts, 'reviews') ? counts.reviews : null,
    hasCounts: Object.prototype.hasOwnProperty.call(body, 'counts'),
    countsKeys: counts ? Object.keys(counts).slice(0, 20) : null,
    openJobsPresent: Boolean(counts && Object.prototype.hasOwnProperty.call(counts, 'open_jobs')),
    openJobs: counts && Object.prototype.hasOwnProperty.call(counts, 'open_jobs') ? counts.open_jobs : null,
    keys: Object.keys(body).slice(0, 40)
  };
}

function logGlassdoorEntity(company, payload) {
  if (!payload || typeof payload !== 'object' || !(payload.ratings || payload.size || payload.counts)) {
    return;
  }

  console.info('[GHD] glassdoor entity', {
    company,
    ...glassdoorEntityFields(payload)
  });
}

// Words that do not distinguish one employer from another, so Glassdoor may add or drop them.
const ENTITY_FILLER_WORDS = new Set([
  ...GENERIC_TOKENS,
  'llp', 'lp', 'sa', 'ag', 'gmbh', 'nv'
]);

// Industry words Glassdoor drops from the end of a longer legal name
// ("University of Miami Health System" -> "University of Miami"). University,
// college, and laboratory stay: they are the distinctive word, not a suffix
// that can be ignored ("Argonne National" is not Argonne National Laboratory).
const TRAILING_ENTITY_WORDS = new Set(
  [...STANDALONE_BLOCK].filter((word) => (
    word !== 'university' && word !== 'college' && word !== 'laboratory' && word !== 'laboratories'
  ))
);

function entityWords(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) || [];
}

function distinctiveWords(words) {
  return words.filter((word) => !ENTITY_FILLER_WORDS.has(word));
}

function requiredLookupWords(words) {
  const required = distinctiveWords(words);

  while (required.length > 1 && TRAILING_ENTITY_WORDS.has(required[required.length - 1])) {
    required.pop();
  }

  return required;
}

// Glassdoor answers a name query with its closest employer, which can be a different
// company ("TKO Group Holdings" -> "TKo Hospitality", "Harrison Clarke" -> "Clarke").
// Every distinctive word in the returned name must come from the lookup, and the
// returned name must still carry the lookup's own distinctive words. A legal suffix
// may differ ("Palantir Technologies" for "Palantir").
export function glassdoorEntityMatches(company, entityName) {
  const queried = entityWords(companyLookupName(company));
  const returned = entityWords(entityName);

  if (!returned.length) {
    return true;
  }

  if (queried.join('') === returned.join('')) {
    return true;
  }

  const returnedDistinctive = distinctiveWords(returned);
  const required = requiredLookupWords(queried);
  const allowed = new Set(queried);

  if (!returnedDistinctive.length || !returnedDistinctive.every((word) => allowed.has(word))) {
    return false;
  }

  return required.every((word) => returned.includes(word));
}

function exactEntityName(left, right) {
  const text = (value) => String(value || '').normalize('NFKD').replace(/\s+/g, ' ').trim().toLowerCase();
  const name = text(left);
  const other = text(right);
  return Boolean(name) && name === other;
}

function wikidataNamesFor(deps, company) {
  const key = String(company || '').trim().toLowerCase();
  const label = deps?.wikidataLabels?.get(key) || '';
  const aliases = deps?.wikidataAliases?.get(key) || [];
  return [label, ...aliases].map((name) => String(name || '').trim()).filter(Boolean);
}

// A shortened Glassdoor name is this company only when it is exactly the
// label or an alias from the Wikidata lookup this check already made.
async function matchesWikidataName(company, entityName, deps) {
  await lookupWikidataEmployees(company, deps);
  return wikidataNamesFor(deps, company).some((candidate) => exactEntityName(candidate, entityName));
}

async function entityMismatch(company, payload, deps, wikidataCompany = company) {
  const name = glassdoorEntityFields(payload).name;

  // Search hits call this same function once they have a readable employer
  // name (lib/server/reviews.js). A payload with no name is not a mismatch.
  if (!name || glassdoorEntityMatches(company, name)) {
    return null;
  }

  if (deps && await matchesWikidataName(wikidataCompany, name, deps)) {
    console.info('[GHD] glassdoor entity accepted', {
      company,
      entity: name,
      reason: 'wikidata label or alias'
    });
    return null;
  }

  console.info('[GHD] glassdoor entity rejected', {
    company,
    entity: name,
    reason: 'name does not match the company looked up'
  });
  return name;
}

function isOneWordAlias(company, query) {
  const alias = String(query || '').trim().toLowerCase();

  if (!alias || /\s/.test(alias)) {
    return false;
  }

  return shorterCompanyNames(company).some((name) => name.toLowerCase() === alias);
}

function registrableLabel(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let host = '';

  try {
    host = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }

  if (!host || host === 'glassdoor.com' || host.endsWith('.glassdoor.com')) {
    return '';
  }

  const parts = host.split('.').filter(Boolean);

  if (parts.length < 2) {
    return '';
  }

  return parts[parts.length - 2].replace(/[^a-z0-9]/g, '');
}

function domainCorroborates(payload, company) {
  const stem = requiredLookupWords(entityWords(company)).join('');

  if (stem.length < 3) {
    return false;
  }

  const candidates = [payload?.website, payload?.link, payload?.url, payload?.company_url, payload?.companyUrl];

  return candidates.some((value) => {
    const label = registrableLabel(value);
    return label === stem || label.startsWith(stem);
  });
}

function normalizeCompanySlug(value) {
  const text = String(value || '').trim().toLowerCase();
  const segment = text.split('/').filter(Boolean).pop() || '';
  return segment.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function slugOverlaps(given, slugs) {
  return slugs.some((candidate) =>
    candidate === given
    || given.startsWith(`${candidate}-`)
    || candidate.startsWith(`${given}-`)
  );
}

function slugCorroborates(slug, entityName, company) {
  const given = normalizeCompanySlug(slug);
  const entity = String(entityName || '').trim();

  if (!given || !entity) {
    return false;
  }

  return slugOverlaps(given, linkedinCompanySlugs(company))
    && slugOverlaps(given, linkedinCompanySlugs(entity));
}

async function wikidataCorroborates(company, entityName, deps) {
  const entity = String(entityName || '').trim();

  if (!entity || typeof deps?.fetch !== 'function') {
    return false;
  }

  try {
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    searchUrl.searchParams.set('action', 'wbsearchentities');
    searchUrl.searchParams.set('search', companyLookupName(company) || company);
    searchUrl.searchParams.set('language', 'en');
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('limit', '1');
    searchUrl.searchParams.set('origin', '*');
    const searchResponse = await deps.fetch(searchUrl, {
      headers: WIKIDATA_HEADERS,
      signal: AbortSignal.timeout(8000)
    });

    if (!searchResponse.ok) {
      return false;
    }

    const id = (await searchResponse.json())?.search?.[0]?.id;

    if (!id) {
      return false;
    }

    const entityUrl = new URL('https://www.wikidata.org/w/api.php');
    entityUrl.searchParams.set('action', 'wbgetentities');
    entityUrl.searchParams.set('ids', id);
    entityUrl.searchParams.set('props', 'labels|aliases');
    entityUrl.searchParams.set('languages', 'en');
    entityUrl.searchParams.set('format', 'json');
    entityUrl.searchParams.set('origin', '*');
    const entityResponse = await deps.fetch(entityUrl, {
      headers: WIKIDATA_HEADERS,
      signal: AbortSignal.timeout(8000)
    });

    if (!entityResponse.ok) {
      return false;
    }

    const record = (await entityResponse.json())?.entities?.[id];
    const labels = [record?.labels?.en?.value, ...(record?.aliases?.en || []).map((alias) => alias?.value)]
      .filter(Boolean);

    const namesThisCompany = labels.some((label) => glassdoorEntityMatches(company, label));
    const namesThisEntity = labels.some((label) =>
      glassdoorEntityMatches(entity, label) && glassdoorEntityMatches(label, entity)
    );
    return namesThisCompany && namesThisEntity;
  } catch {
    return false;
  }
}

async function aliasCorroborated(company, payload, deps) {
  if (domainCorroborates(payload, company)) {
    return true;
  }

  const entityName = glassdoorEntityFields(payload).name;

  if (slugCorroborates(deps?.companySlug, entityName, company)) {
    return true;
  }

  return wikidataCorroborates(company, entityName, deps);
}

function logEmployeeSearchTrigger(company, details, deps) {
  const noUsableCount = typeof details?.employees !== 'number';
  const blocked = details?.error === 'quota' || details?.error === 'unavailable';
  const canSearch = typeof deps?.askGroq === 'function' || typeof deps?.findEmployeeCountBySearch === 'function';
  console.info('[GHD] employee search trigger', {
    company,
    glassdoorOrMergedEmployees: details?.employees ?? null,
    employeeLabel: details?.employeeLabel ?? null,
    employeeSource: details?.employeeSource || null,
    employeesLowerBound: Boolean(details?.employeesLowerBound),
    employeeDiscrepancy: details?.employeeDiscrepancy || null,
    error: details?.error || null,
    noUsableCount,
    trigger: noUsableCount && !blocked && canSearch
  });
}

function glassdoorSnapshot(details) {
  if (typeof details?.employees !== 'number') {
    return null;
  }

  return {
    employees: details.employees,
    employeeLabel: details.employeeLabel || null,
    employeesLowerBound: Boolean(details.employeesLowerBound)
  };
}

function restoreGlassdoor(details, snapshot) {
  if (!snapshot) {
    return details;
  }

  const next = {
    ...details,
    employees: snapshot.employees,
    employeeLabel: snapshot.employeeLabel
  };
  delete next.rejectedEmployeeCount;

  if (snapshot.employeesLowerBound) {
    next.employeesLowerBound = true;
  } else {
    delete next.employeesLowerBound;
  }

  return next;
}

const CAPTURED_HEADCOUNT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function capturedEmployeeCount(captured, now = new Date()) {
  const employees = Number(captured?.employees);
  const capturedAt = Number(captured?.capturedAt);
  const time = now instanceof Date ? now.getTime() : Number(now);

  if (!Number.isFinite(employees) || employees <= 0 || !Number.isFinite(capturedAt) || !Number.isFinite(time)) {
    return null;
  }

  if (time - capturedAt > CAPTURED_HEADCOUNT_TTL_MS || capturedAt > time + 5 * 60 * 1000) {
    return null;
  }

  return Math.round(employees);
}

function applyCapturedHeadcount(details, captured, now) {
  const employees = capturedEmployeeCount(captured, now);

  if (!employees) {
    return null;
  }

  const next = {
    ...details,
    employees,
    employeeLabel: employees.toLocaleString('en-US'),
    employeeSource: 'linkedin'
  };
  delete next.employeesLowerBound;
  delete next.employeeDiscrepancy;
  delete next.employeeSourceUrl;
  delete next.rejectedEmployeeCount;
  next.estimated = false;
  return next;
}

async function withEmployeeCounts(company, details, deps) {
  return withoutBucketRange(await mergeEmployeeCounts(company, details, deps));
}

async function freeHeadcount(company, details, deps) {
  const captured = applyCapturedHeadcount(details, deps?.capturedHeadcount, deps?.now);

  if (captured) {
    return captured;
  }

  return withWikidataEmployees(company, details, { ...deps, wikidataCacheOnly: true, skipPaidHeadcount: true });
}

async function mergeEmployeeCounts(company, details, deps) {
  if (deps?.skipPaidHeadcount) {
    return freeHeadcount(company, details, deps);
  }

  const capturedCount = capturedEmployeeCount(deps?.capturedHeadcount, deps?.now);
  const glassdoorCount = typeof details?.employees === 'number' ? details.employees : null;

  // The capture was already read from the extension's 90-day store. A wide
  // bucket does not get a network lookup when that store has nothing.
  if (capturedCount && glassdoorCount && isWideEmployeeBucket(details)) {
    console.info('[GHD] wide bucket capture', {
      company,
      glassdoorEmployees: glassdoorCount,
      glassdoorLabel: details?.employeeLabel || null,
      capturedEmployees: capturedCount,
      outsideBucket: captureOutsideBucket(capturedCount, details)
    });
    return applyCapturedHeadcount(details, deps.capturedHeadcount, deps.now);
  }

  const captureDisagrees = Boolean(capturedCount && glassdoorCount && countsDisagree(glassdoorCount, capturedCount));
  const uncorroboratedSmall = Boolean(
    glassdoorCount
    && glassdoorCount < UNCORROBORATED_HEADCOUNT_FLOOR
    && !capturedCount
  );
  let working = details;

  if (captureDisagrees) {
    console.info('[GHD] employee count rejected', {
      company,
      source: 'glassdoor',
      count: glassdoorCount,
      comparedWith: 'linkedin',
      comparedCount: capturedCount
    });
    working = clearEmployeeCount(details, employeeDiscrepancy());
  } else if (uncorroboratedSmall) {
    console.info('[GHD] employee count rejected', {
      company,
      source: 'glassdoor',
      count: glassdoorCount,
      reason: 'below uncorroborated floor',
      floor: UNCORROBORATED_HEADCOUNT_FLOOR
    });
    working = clearEmployeeCount(details);
  } else if (capturedCount) {
    return applyCapturedHeadcount(details, deps.capturedHeadcount, deps.now);
  }

  const snapshot = glassdoorSnapshot(working);
  const merged = await withWikidataEmployees(company, working, deps);
  const searched = await maybeSearchEmployees(company, merged, deps);

  if (searched?.rejectedEmployeeCount && typeof searched.employees !== 'number') {
    return restoreGlassdoor(searched, snapshot);
  }

  if (searched?.rejectedEmployeeCount) {
    const next = { ...searched };
    delete next.rejectedEmployeeCount;
    return next;
  }

  return searched;
}

async function maybeSearchEmployees(company, details, deps) {
  if (deps?.skipPaidHeadcount) {
    return details;
  }

  logEmployeeSearchTrigger(company, details, deps);

  if (!details || typeof details.employees === 'number') {
    return details;
  }

  if (details.error === 'quota' || details.error === 'unavailable') {
    return details;
  }

  if (typeof deps?.askGroq !== 'function' && typeof deps?.findEmployeeCountBySearch !== 'function') {
    return details;
  }

  try {
    // Once per check: a Glassdoor label retry merges counts again and must not
    // repeat this paid search.
    const memo = deps.employeeSearchMemo instanceof Map ? deps.employeeSearchMemo : null;
    const memoKey = String(company || '').trim().toLowerCase();

    if (memo && !memo.has(memoKey)) {
      memo.set(memoKey, (deps.findEmployeeCountBySearch || findEmployeeCountBySearch)(company, deps));
    }

    const found = await (memo ? memo.get(memoKey) : (deps.findEmployeeCountBySearch || findEmployeeCountBySearch)(company, deps));

    if (!found?.employees || !found.sourceUrl) {
      return details;
    }

    return {
      ...details,
      employees: found.employees,
      employeeLabel: found.employeeLabel || found.employees.toLocaleString('en-US'),
      employeeSource: 'search',
      employeeSourceUrl: found.sourceUrl,
      estimated: true
    };
  } catch {
    return details;
  }
}

async function withWikidataEmployees(company, details, deps) {
  const counted = await lookupWikidataEmployees(company, deps);
  console.info('[GHD] employee sources', {
    company,
    glassdoorEmployees: details?.employees ?? null,
    glassdoorLabel: details?.employeeLabel ?? null,
    glassdoorLowerBound: Boolean(details?.employeesLowerBound),
    wikidataEmployees: counted?.count ?? null,
    wikidataLabel: counted?.label ?? null
  });

  const bucketMax = closedBucketMax(details?.glassdoorSize);
  const contradicted = Boolean(counted && bucketMax && counted.count >= bucketMax * ENTITY_CONTRADICTION_FACTOR);

  // The Glassdoor answer is final here: the paid employee search that may
  // follow only affects the headcount. Open roles waits for this, not for it.
  deps?.onGlassdoorChecked?.({ contradicted });

  if (contradicted) {
    console.info('[GHD] glassdoor entity rejected', {
      company,
      reason: 'Wikidata headcount is 10x the Glassdoor size bucket',
      glassdoorSize: details.glassdoorSize,
      wikidataEmployees: counted.count
    });
    // The whole Glassdoor entity goes, not just its bucket; the headcount is Wikidata's.
    const next = {
      ...details,
      overall: null,
      reviewCount: null,
      openJobs: null,
      employees: counted.count,
      employeeLabel: counted.label,
      employeeSource: 'wikidata',
      glassdoorContradicted: true
    };
    delete next.glassdoorSize;
    delete next.employeesLowerBound;
    delete next.employeeDiscrepancy;
    delete next.website;
    return next;
  }

  if (!counted) {
    // "10,000+" is a floor, not a headcount. It is not a usable count, even
    // when Wikidata has no figure and there is nothing to disagree with.
    // Search runs; this bucket is restored only if search cites no number.
    if (isOpenEndedEmployeeBucket(details) && !deps?.skipPaidHeadcount) {
      const opened = {
        ...details,
        employees: null,
        employeeLabel: null,
        rejectedEmployeeCount: true
      };
      delete opened.employeesLowerBound;
      return opened;
    }

    return details;
  }

  // No Glassdoor size bucket to compare against. A stale P1128 value cannot
  // be sanity-checked here and is accepted as the only employee figure.
  if (details.employees == null) {
    const next = {
      ...details,
      employees: counted.count,
      employeeLabel: counted.label,
      employeeSource: 'wikidata'
    };
    delete next.employeesLowerBound;
    return next;
  }

  if (!wikidataEmployeesPlausible(counted.count, details)) {
    console.info('[GHD] employee count rejected', {
      company,
      source: 'wikidata',
      count: counted.count,
      keptEmployees: details.employees ?? null,
      keptLabel: details.employeeLabel || null
    });
    const rejected = {
      ...details,
      employees: null,
      employeeLabel: null,
      employeeDiscrepancy: employeeDiscrepancy(),
      rejectedEmployeeCount: true
    };
    delete rejected.employeesLowerBound;
    return rejected;
  }

  const next = {
    ...details,
    employees: counted.count,
    employeeLabel: counted.label,
    employeeSource: 'wikidata'
  };
  delete next.employeesLowerBound;
  delete next.employeeDiscrepancy;
  return next;
}

async function requestCompanyDetails(name, deps, apiKey) {
  let response;

  try {
    response = await deps.fetch(glassdoorRatingUrl(name), {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': HOST
      },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return { stop: unavailable() };
  }

  if (!response.ok) {
    const body = await response.text();
    console.info('[GHD] glassdoor rating', {
      company: name,
      status: response.status,
      body: body.slice(0, 2000)
    });

    if (response.status === 429) {
      return { stop: { overall: null, error: 'quota' } };
    }

    if (response.status === 404) {
      return { miss: true };
    }

    return { stop: unavailable() };
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    return { stop: unavailable() };
  }

  const details = companyDetails(payload, false);

  if (!usefulDetails(details)) {
    return { miss: true };
  }

  logGlassdoorEntity(name, payload);
  return { hit: { payload, details } };
}

const RETRY_STOP_TTL_MS = 5 * 60 * 1000;

function nameKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameWordsOf(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

// After a rejected Glassdoor hit, one more query under the name Wikidata gives
// the company ("Ford" -> "Ford Motor Company"). The label must already be known
// from this check's own Wikidata lookup; none is made for it. The retried hit
// passes the same checks as any hit: the name check (against the name queried),
// the weak-hit check, and the 10x Wikidata check.
async function retryWithWikidataLabel(company, tried, deps, apiKey, trigger, sendFields = null) {
  const label = deps.wikidataLabels?.get(String(company || '').trim().toLowerCase()) || '';
  const report = (result) => {
    console.info('[GHD] glassdoor label retry', {
      company,
      trigger,
      label: label || null,
      retried: result.called === true,
      ok: result.ok === true,
      reason: result.reason || null
    });
    return { ...result, label: label || null };
  };

  if (!label) {
    return report({ ok: false, reason: 'no Wikidata label in this check' });
  }

  if (tried.some((name) => nameKey(name) === nameKey(label))) {
    return report({ ok: false, reason: 'label already tried' });
  }

  // The label has to contain the company's own name, so it names this company
  // and not something Wikidata ranked first for the word.
  const labelWords = new Set(nameWordsOf(label));

  if (!nameWordsOf(company).every((word) => labelWords.has(word))) {
    return report({ ok: false, reason: 'label does not contain the company name' });
  }

  const outcome = await requestCompanyDetails(label, deps, apiKey);

  if (outcome.stop) {
    return report({ ok: false, called: true, stopped: true, reason: 'request did not complete' });
  }

  if (!outcome.hit) {
    return report({ ok: false, called: true, reason: 'not found' });
  }

  const mismatch = await entityMismatch(label, outcome.hit.payload, deps, company);

  if (mismatch) {
    return report({ ok: false, called: true, reason: `name check rejected ${mismatch}` });
  }

  if (isWeakGlassdoorHit(outcome.hit.details)) {
    return report({ ok: false, called: true, reason: 'weak entity (no rating, no reviews)' });
  }

  const merged = sendFields
    ? await mergeAndSend(company, outcome.hit.details, deps, sendFields)
    : await withEmployeeCounts(company, outcome.hit.details, deps);

  if (merged?.glassdoorContradicted) {
    return report({ ok: false, called: true, reason: 'Wikidata headcount is 10x the Glassdoor size bucket' });
  }

  return report({ ok: true, called: true, payload: outcome.hit.payload, details: outcome.hit.details, merged });
}

async function cacheRetryOutcome(deps, key, retry, marker) {
  if (retry.ok) {
    // Remembered with the name it matched, so the cached hit is checked
    // against "Ford Motor Company", not "Ford".
    await cacheSet(deps.cache, key, { ...retry.payload, ghdMatchedAs: retry.label }, RATING_TTL_MS, deps.now);
    return;
  }

  await cacheSet(
    deps.cache,
    key,
    { ...marker, retried: retry.called ? retry.label : null, retryReason: retry.reason || null },
    retry.stopped ? RETRY_STOP_TTL_MS : RATING_TTL_MS,
    deps.now
  );
}

// What open roles and reviews need from the profile: Glassdoor's own fields,
// once the Glassdoor answer is final (entity, weak-hit, 10x and label retry),
// without waiting for the headcount merge or the paid employee search.
export function glassdoorFields(details) {
  const reviewCount = Number(details?.reviewCount);

  return {
    website: details?.website || '',
    openJobs: typeof details?.openJobs === 'number' ? details.openJobs : null,
    glassdoorSize: details?.glassdoorSize || '',
    overall: typeof details?.overall === 'number' ? details.overall : null,
    reviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : null
  };
}

export async function lookupCompanyRating(company, input) {
  let sent = false;
  const sendFields = (details) => {
    if (!sent) {
      sent = true;
      input?.onGlassdoorFields?.(glassdoorFields(details));
    }
  };

  try {
    const rating = await lookupCompanyRatingInner(company, input, sendFields);
    sendFields(rating);
    return rating;
  } catch (error) {
    sendFields(null);
    throw error;
  }
}

// Runs a merge and sends the fields as soon as its 10x check has passed.
async function mergeAndSend(company, details, deps, sendFields) {
  let checked;
  const stage = new Promise((resolve) => {
    checked = resolve;
  });
  const merging = withEmployeeCounts(company, details, { ...deps, onGlassdoorChecked: checked });
  const first = await Promise.race([stage, merging.then(() => null, () => null)]);

  if (first && !first.contradicted) {
    sendFields(details);
  }

  return merging;
}

async function lookupCompanyRatingInner(company, input, sendFields) {
  // One Wikidata lookup and one employee search per check, shared by a retry.
  const deps = {
    ...input,
    wikidataLabels: input?.wikidataLabels instanceof Map ? input.wikidataLabels : new Map(),
    wikidataAliases: input?.wikidataAliases instanceof Map ? input.wikidataAliases : new Map(),
    wikidataWebsites: input?.wikidataWebsites instanceof Map ? input.wikidataWebsites : new Map(),
    wikidataMemo: input?.wikidataMemo instanceof Map ? input.wikidataMemo : new Map(),
    employeeSearchMemo: input?.employeeSearchMemo instanceof Map ? input.employeeSearchMemo : new Map()
  };
  const rawCompany = String(company || '').trim();
  const lookedUp = companyLookupName(rawCompany) || rawCompany;
  const key = ratingCacheKey(rawCompany);
  const meta = await cacheGetMeta(deps.cache, key, deps.now);
  const stored = meta?.payload || null;
  const nameRejection = Boolean(stored?.entityMismatch) && !stored?.weakEntity && !stored?.entityContradicted;
  const negativeMarker = Boolean(stored?.entityMismatch || stored?.weakEntity || stored?.entityContradicted);
  const negativeFresh = negativeMarker
    && !deps.refresh
    && writtenWithin(meta.updatedAt, nameRejection ? NAME_REJECTION_TTL_MS : RATING_TTL_MS, deps.now || new Date());

  if (negativeFresh) {
    console.info('[GHD] glassdoor entity rejected', {
      company,
      entity: stored.entity || null,
      reason: stored.weakEntity
        ? 'weak entity (no rating, no reviews)'
        : (stored.entityContradicted ? 'Wikidata headcount is 10x the Glassdoor size bucket' : 'name mismatch'),
      retried: stored.retried || null,
      cached: true
    });
    sendFields(null);
    return withEmployeeCounts(company, notFound(), deps);
  }

  const cached = cachedDetails(stored);

  if (cached && usefulDetails(cached) && !isWeakGlassdoorHit(cached)) {
    logGlassdoorEntity(company, stored);

    // Payloads cached before the entity check existed may belong to another
    // company. A hit found under its Wikidata label is checked against that label.
    if (!await entityMismatch(stored?.ghdMatchedAs || lookedUp, stored, deps, rawCompany)) {
      sendFields(cached);
      return withEmployeeCounts(company, cached, deps);
    }
  }

  const apiKey = String(deps.env?.RAPIDAPI_KEY || '').trim();

  if (!apiKey) {
    const captured = applyCapturedHeadcount(unavailable(), deps?.capturedHeadcount, deps?.now);
    return captured || unavailable();
  }

  const names = [lookedUp, ...shorterCompanyNames(lookedUp)].filter(Boolean);
  let missed = false;
  let rejected = null;
  let uncorroborated = false;
  let weak = null;

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const outcome = await requestCompanyDetails(name, deps, apiKey);

    if (outcome.hit) {
      // Checked against the full name, not the shorter query that found it.
      const mismatch = await entityMismatch(lookedUp, outcome.hit.payload, deps, rawCompany);

      if (mismatch) {
        rejected = mismatch;
        missed = true;
        continue;
      }

      // A one-word alias may surface the right employer, but the name overlap
      // alone is how "clarke" was accepted for Harrison Clarke.
      if (isOneWordAlias(company, name) && !(await aliasCorroborated(company, outcome.hit.payload, deps))) {
        console.info('[GHD] glassdoor entity rejected', {
          company,
          entity: glassdoorEntityFields(outcome.hit.payload).name,
          query: name,
          reason: 'one-word alias is not corroborated'
        });
        uncorroborated = true;
        missed = true;
        continue;
      }

      // No rating and no reviews: a placeholder entity. Its size bucket is not
      // used. The legal-form names are tried next, once, before shorter names.
      if (isWeakGlassdoorHit(outcome.hit.details)) {
        console.info('[GHD] glassdoor weak entity', {
          company,
          query: name,
          entity: glassdoorEntityFields(outcome.hit.payload).name,
          size: outcome.hit.details.glassdoorSize || null
        });

        if (!weak) {
          const variants = legalFormVariants(company).filter((variant) => !names.includes(variant));
          names.splice(index + 1, 0, ...variants);
        }

        weak = weak || glassdoorEntityFields(outcome.hit.payload).name || name;
        missed = true;
        continue;
      }

      // The 10x Wikidata check runs while counts are merged, so the hit is
      // cached only after it has passed.
      const merged = await mergeAndSend(company, outcome.hit.details, deps, sendFields);

      if (!merged?.glassdoorContradicted) {
        sendFields(outcome.hit.details);
        await cacheSet(deps.cache, key, outcome.hit.payload, RATING_TTL_MS, deps.now);
        return merged;
      }

      const retry = await retryWithWikidataLabel(company, names, deps, apiKey, 'contradicted', sendFields);
      sendFields(retry.ok ? retry.details : null);
      await cacheRetryOutcome(deps, key, retry, {
        entityContradicted: true,
        entity: glassdoorEntityFields(outcome.hit.payload).name || name
      });
      return retry.ok ? retry.merged : merged;
    }

    if (outcome.stop) {
      const captured = applyCapturedHeadcount(outcome.stop, deps?.capturedHeadcount, deps?.now);
      return captured || outcome.stop;
    }

    missed = true;
  }

  if (!missed) {
    sendFields(null);
    return unavailable();
  }

  if (rejected && !uncorroborated) {
    // The usual not-found merge looks up Wikidata, which supplies the label.
    // The retry starts as soon as that lookup is done, not after the merge's
    // paid employee search, and open roles gets its fields from the retry.
    let retrying = null;
    const startRetry = () => {
      if (!retrying) {
        retrying = retryWithWikidataLabel(company, names, deps, apiKey, 'name check', sendFields);
        retrying.then((result) => sendFields(result.ok ? result.details : null), () => sendFields(null));
      }

      return retrying;
    };
    const base = await withEmployeeCounts(company, notFound(), { ...deps, onGlassdoorChecked: startRetry });
    const retry = await startRetry();
    await cacheRetryOutcome(deps, key, retry, { entityMismatch: true, entity: rejected });
    return retry.ok ? retry.merged : base;
  }

  // Weak or no usable hit: no Glassdoor fields, and nothing left to wait for.
  sendFields(null);
  const base = await withEmployeeCounts(company, notFound(), deps);

  if (weak && !uncorroborated) {
    // Remembered like a rejection, so the extra legal-form calls are not repeated.
    await cacheSet(deps.cache, key, { weakEntity: true, entity: weak }, RATING_TTL_MS, deps.now);
  }

  return base;
}

function companyQuery(req) {
  if (req.query?.company) {
    return cleanString(req.query.company, 500);
  }

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return cleanString(url.searchParams.get('company'), 500);
  } catch {
    return '';
  }
}

function dependencies(overrides = {}) {
  const env = overrides.env || process.env;

  return {
    cache: overrides.cache || createCache(env),
    rateLimit: overrides.rateLimit || createRateLimiter(env),
    fetch: overrides.fetch || fetch,
    now: overrides.now || new Date(),
    env
  };
}

export function createCompanyRatingHandler(overrides = {}) {
  return async function handler(req, res) {
    const deps = dependencies(overrides);
    applyCors(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!requireClient(req, res)) {
      return;
    }

    const limit = await deps.rateLimit.consume(clientIp(req), deps.now);
    res.setHeader('X-RateLimit-Limit', String(limit.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(limit.limit - limit.count, 0)));

    if (!limit.allowed) {
      res.setHeader('Retry-After', '3600');
      sendJson(res, 429, { error: 'Rate limit exceeded. Try again in under an hour.' });
      return;
    }

    const company = companyQuery(req);

    if (!company) {
      sendJson(res, 400, { error: 'company is required' });
      return;
    }

    const rating = await lookupCompanyRating(company, deps);
    sendJson(res, 200, rating);
  };
}

export const companyRatingHandler = createCompanyRatingHandler();
