import { cacheGet, cacheSet, createCache } from './cache.js';
import { shorterCompanyNames } from './companies.js';
import { findEmployeeCountBySearch } from './employees.js';
import { applyCors, cleanString, clientIp, requireClient, sendJson } from './http.js';
import { createRateLimiter } from './rateLimit.js';

const HOST = 'best-glassdoor-scraper-free-1000-calls.p.rapidapi.com';
const WIKIDATA_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)'
};
const RATING_TTL_MS = 24 * 60 * 60 * 1000;

export function ratingCacheKey(company) {
  return `glassdoor_rating_v2_${company.toLowerCase()}`;
}

export function glassdoorRatingUrl(company) {
  const url = new URL(`https://${HOST}/companies/details`);
  url.searchParams.set('company', company);
  return url;
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

export function companyDetails(payload, cached = false) {
  const size = String(payload?.size || '').replace(/\s+/g, ' ').trim();
  const presentation = employeePresentation(size);

  return {
    overall: readOverall(payload),
    employees: presentation.employees,
    employeeLabel: presentation.employeeLabel,
    ...(presentation.employeesLowerBound ? { employeesLowerBound: true } : {}),
    ...(Number.isFinite(presentation.employeeRangeMin) ? { employeeRangeMin: presentation.employeeRangeMin } : {}),
    ...(Number.isFinite(presentation.employeeRangeMax) ? { employeeRangeMax: presentation.employeeRangeMax } : {}),
    openJobs: readOpenJobs(payload),
    ...(readWebsite(payload) ? { website: readWebsite(payload) } : {}),
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

async function lookupWikidataEmployees(company, deps) {
  const name = String(company || '').trim();

  if (!name || !deps.fetch) {
    return null;
  }

  const key = `wikidata_employees_${name.toLowerCase()}`;
  const cached = await cacheGet(deps.cache, key, deps.now);

  if (cached?.miss) {
    return null;
  }

  if (typeof cached?.count === 'number' && cached.count > 0) {
    return cached;
  }

  try {
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    searchUrl.searchParams.set('action', 'wbsearchentities');
    searchUrl.searchParams.set('search', name);
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

    if (!id) {
      await cacheSet(deps.cache, key, { miss: true }, RATING_TTL_MS, deps.now);
      return null;
    }

    const entityUrl = new URL('https://www.wikidata.org/w/api.php');
    entityUrl.searchParams.set('action', 'wbgetentities');
    entityUrl.searchParams.set('ids', id);
    entityUrl.searchParams.set('props', 'claims');
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
    const count = readWikidataEmployeeCount(entity?.entities?.[id]?.claims?.P1128);

    if (count == null) {
      await cacheSet(deps.cache, key, { miss: true }, RATING_TTL_MS, deps.now);
      return null;
    }

    const result = { count, label: formatEmployeeCount(count) };
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

  return {
    size: pick(body, ['size']),
    name: pick(body, nameKeys) || pick(nested, nameKeys),
    id: pick(body, idKeys) || pick(nested, idKeys),
    url: pick(body, urlKeys) || pick(nested, urlKeys),
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
  'the', 'and', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'co', 'corp',
  'corporation', 'company', 'plc', 'group', 'holdings', 'holding', 'sa', 'ag', 'gmbh', 'nv'
]);

function entityWords(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) || [];
}

// Glassdoor answers a name query with its closest employer, which can be a different
// company ("TKO Group Holdings" -> "TKo Hospitality"). Every distinctive word in the
// returned name must come from the name that was looked up.
export function glassdoorEntityMatches(company, entityName) {
  const queried = entityWords(company);
  const returned = entityWords(entityName);

  if (!returned.length) {
    return true;
  }

  if (queried.join('') === returned.join('')) {
    return true;
  }

  const allowed = new Set(queried);
  const distinctive = returned.filter((word) => !ENTITY_FILLER_WORDS.has(word));
  return distinctive.length > 0 && distinctive.every((word) => allowed.has(word));
}

function entityMismatch(company, payload) {
  const name = glassdoorEntityFields(payload).name;

  if (!name || glassdoorEntityMatches(company, name)) {
    return null;
  }

  console.info('[GHD] glassdoor entity rejected', {
    company,
    entity: name,
    reason: 'name does not match the company looked up'
  });
  return name;
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

function capturedEmployeeCount(captured, now = new Date()) {
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

async function mergeEmployeeCounts(company, details, deps) {
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
    const found = await (deps.findEmployeeCountBySearch || findEmployeeCountBySearch)(company, deps);

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

  if (!counted) {
    // "10,000+" is a floor, not a headcount. It is not a usable count, even
    // when Wikidata has no figure and there is nothing to disagree with.
    // Search runs; this bucket is restored only if search cites no number.
    if (isOpenEndedEmployeeBucket(details)) {
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

export async function lookupCompanyRating(company, deps) {
  const key = ratingCacheKey(company);
  const stored = await cacheGet(deps.cache, key, deps.now);

  if (stored?.entityMismatch) {
    console.info('[GHD] glassdoor entity rejected', { company, entity: stored.entity || null, cached: true });
    return withEmployeeCounts(company, notFound(), deps);
  }

  const cached = cachedDetails(stored);

  if (cached && usefulDetails(cached)) {
    logGlassdoorEntity(company, stored);

    // Payloads cached before the entity check existed may belong to another company.
    if (!entityMismatch(company, stored)) {
      return withEmployeeCounts(company, cached, deps);
    }
  }

  const apiKey = String(deps.env?.RAPIDAPI_KEY || '').trim();

  if (!apiKey) {
    const captured = applyCapturedHeadcount(unavailable(), deps?.capturedHeadcount, deps?.now);
    return captured || unavailable();
  }

  const names = [String(company || '').trim(), ...shorterCompanyNames(company)].filter(Boolean);
  let missed = false;
  let rejected = null;

  for (const name of names) {
    const outcome = await requestCompanyDetails(name, deps, apiKey);

    if (outcome.hit) {
      // Checked against the full name, not the shorter query that found it.
      const mismatch = entityMismatch(company, outcome.hit.payload);

      if (mismatch) {
        rejected = mismatch;
        missed = true;
        continue;
      }

      await cacheSet(deps.cache, key, outcome.hit.payload, RATING_TTL_MS, deps.now);
      return withEmployeeCounts(company, outcome.hit.details, deps);
    }

    if (outcome.stop) {
      const captured = applyCapturedHeadcount(outcome.stop, deps?.capturedHeadcount, deps?.now);
      return captured || outcome.stop;
    }

    missed = true;
  }

  if (rejected) {
    await cacheSet(deps.cache, key, { entityMismatch: true, entity: rejected }, RATING_TTL_MS, deps.now);
  }

  return missed ? withEmployeeCounts(company, notFound(), deps) : unavailable();
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
