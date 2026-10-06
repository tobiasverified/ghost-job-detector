import { createHash } from 'node:crypto';
import { companyCacheKey } from './companies.js';
import { isNormalCompanyName, resolveCompanyIdentity } from './company-identity.js';
import { detectLayoffs } from './layoffs.js';
import { glassdoorFields, lookupCompanyRating } from './company-rating.js';
import { checkCompanyCareers, resolveOpenJobCount } from './open-jobs.js';
import { findCompanyReviews, scoreRating } from './reviews.js';
import { analyzeVagueness } from './vagueness.js';
import { detectReposts } from './reposts.js';
import { buildGhostScore } from './score.js';
import { scoreHiringRatio } from './workforce.js';
import { searchNewsData } from './newsdata.js';
import { webSearch } from './search.js';
import { askGroq } from './groq-client.js';
import { MemoryCache, cacheGet, cacheSet, createCache, deferWrites } from './cache.js';
import { CAREERS_NETWORK } from './careers-page.js';
import { waitUntil } from '@vercel/functions';
import { createRateLimiter } from './rateLimit.js';
import { createTrace, tracedDependencies } from './trace.js';
import {
  applyCors,
  clientIp,
  readJsonBody,
  requireClient,
  sendJson,
  validateCompanyBody,
  validateJobBody
} from './http.js';

export const ANALYSIS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A review check that could not run (search failed or timed out) is retried soon.
export const REVIEW_RETRY_TTL_MS = 5 * 60 * 1000;

// Bump layoffs or vagueness when that factor's logic changes, and bump that
// factor's own cache key too. A cache hit recomputes those two only when the
// stored version differs, then writes them back. Reviews and the hiring ratio
// still refresh on every hit: their own caches expire sooner than this 7-day
// analysis. Reposts also refresh on every hit. A duplicate can be posted with
// no code change, so a matching version is not a reason to reuse the stored
// repost factor. detectReposts keeps its own 24-hour search cache, which is
// what skips a repeat DuckDuckGo or Tavily call. v3 flushes repost factors
// stored under v2, including the T-Mobile analysis that never re-searched.
export const FACTOR_VERSIONS = {
  reposts: 'v3',
  layoffs: 'v2',
  // v3 reads a pay-range field that sits outside the description text.
  vagueness: 'v3'
};

function capturedHeadcountKey(captured) {
  const employees = Number(captured?.employees);
  return Number.isFinite(employees) && employees > 0 ? String(Math.round(employees)) : '0';
}

function descriptionHash(description, salary) {
  const pay = String(salary || '').trim();
  const body = pay ? `${description || ''}\n${pay}` : String(description || '');
  return createHash('sha256')
    .update(body)
    .digest('hex')
    .slice(0, 16);
}

export function analysisCacheKey(job) {
  // v25: open roles can be Glassdoor's larger floor over a capped Workday
  // board, and the detail names the cap.
  // v24 drops every v23 analysis. Those kept repost, layoff, and vagueness
  // results for 7 days after the logic that produced them changed.
  return [
    'analyze',
    'v25',
    companyCacheKey(job.company),
    companyCacheKey(job.title),
    descriptionHash(job.description, job.salary),
    companyCacheKey(job.location || 'no-city'),
    capturedHeadcountKey(job.capturedHeadcount)
  ].join(':');
}

export function reviewCacheKey(company) {
  // v11 keeps the company Glassdoor reviews page when a jobs snippet parses a
  // larger count, and requires the full employer name. v10 keeps the rating
  // with more reviews when Glassdoor and Indeed both match.
  return `reviews:v11:${companyCacheKey(company)}`;
}

function withReviews(payload, reviews) {
  const factors = {
    ...(payload.factors || {}),
    reviews
  };

  return {
    ...payload,
    ...buildGhostScore(factors),
    factors
  };
}

function logGhostScore(company, title, hiringRatio, scored) {
  console.info('[GHD] ghost score', {
    company: company || '',
    title: title || '',
    ratio: hiringRatio?.ratio ?? null,
    employees: hiringRatio?.employees ?? null,
    openRoles: hiringRatio?.openRoles ?? null,
    workforceScore: hiringRatio?.score || 0,
    hiringRatioComponent: Math.min(Number(hiringRatio?.score) || 0, 25),
    ghostScore: scored?.ghostScore ?? null
  });
}

function staleFactors(cached) {
  const stored = cached?.factorVersions || {};

  return {
    reposts: stored.reposts !== FACTOR_VERSIONS.reposts,
    layoffs: stored.layoffs !== FACTOR_VERSIONS.layoffs,
    vagueness: stored.vagueness !== FACTOR_VERSIONS.vagueness
  };
}

function withHiringRatio(payload, hiringRatio, job) {
  const factors = {
    ...(payload.factors || {}),
    hiringRatio
  };
  const scored = buildGhostScore(factors);
  logGhostScore(job?.company, job?.title, hiringRatio, scored);

  return {
    ...payload,
    ...scored,
    factors
  };
}

export async function resolveCompanyReview(company, deps, rating) {
  if (!rating) {
    console.info('[GHD] company rating', { company });
  }

  const profile = rating || await (deps.lookupCompanyRating || lookupCompanyRating)(company, deps);

  if (typeof profile?.overall === 'number') {
    const reviewCount = Number(profile.reviewCount);

    return {
      rating: profile.overall,
      reviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? Math.round(reviewCount) : null,
      platform: 'Glassdoor',
      url: null,
      score: scoreRating(profile.overall, Number.isFinite(reviewCount) && reviewCount > 0 ? Math.round(reviewCount) : null),
      unavailable: false,
      source: 'rapidapi'
    };
  }

  console.info('[GHD] company reviews', { company });
  const fallback = await findCompanyReviews(company, {
    ...deps,
    clientHtml: deps.clientHtml || ''
  });

  return { ...fallback, source: fallback.unavailable ? null : 'duckduckgo' };
}

const OPEN_JOBS_SCOPE_TEXT = {
  glassdoor_listings: 'listed on Glassdoor',
  multiple_boards: 'on the largest of several job boards',
  workday_cap: 'on Workday, which stops counting at 2,000'
};

// An open-roles count that covers only part of the company (Glassdoor's own
// listings, or one of several boards) makes the ratio a floor, not a figure.
// It is shown as "at least" and earns no points: a partial count can neither
// confirm nor clear the signal.
function openJobsLowerBound(rating, scored, employeesLowerBound) {
  if (!rating?.openJobsLowerBound || !scored?.available) {
    return {};
  }

  const site = String(rating.openJobsScopeSite || '').trim();
  const qualifier = String(rating.openJobsScopeQualifier || '').trim();
  const scope = OPEN_JOBS_SCOPE_TEXT[rating.openJobsScope] || 'from a partial source';
  const staffLabel = employeesLowerBound
    ? String(rating.employeeLabel || `${Math.round(scored.employees).toLocaleString('en-US')}+`).replace(/\s*employees?$/i, '')
    : Math.round(scored.employees).toLocaleString('en-US');
  const roles = Math.round(scored.openRoles).toLocaleString('en-US');
  // Two significant figures, so 5 of 3,001 reads "0.0017:1", not "0:1".
  const floor = Number((scored.openRoles / scored.employees).toPrecision(2));
  const ratioText = employeesLowerBound ? 'ratio not determinable' : `at least ${floor}:1`;
  const rolesPhrase = qualifier && site
    ? `${roles}+ ${qualifier} roles listed on ${site}`
    : rating.openJobsScope === 'open_ended' && site
      ? `at least ${roles} open roles on ${site}`
      : `${roles}+ open roles ${scope}`;
  const boundDetail = qualifier && site
    ? `${roles} is only the ${qualifier} roles listed on ${site}, not the company's full careers board, so this ratio is a lower bound and is not scored.`
    : rating.openJobsScope === 'open_ended' && site
      ? `At least ${roles} is the open-ended figure on ${site}, not an exact total, so this ratio is a lower bound and is not scored.`
      : rating.openJobsScope === 'glassdoor_listings' && rating.openJobsWorkdayCapped
        // Target: its Workday board stops counting at 2,000; Glassdoor lists 12,089.
        ? `${roles} is the open roles listed on Glassdoor, more than the company's Workday board shows (Workday stops counting at 2,000), so this ratio is a lower bound and is not scored.`
        : `${roles} is only the open roles ${scope}, not the company's full careers board, so this ratio is a lower bound and is not scored.`;

  return {
    score: 0,
    openJobsLowerBound: true,
    openJobsScope: rating.openJobsScope || '',
    openJobsScopeQualifier: qualifier,
    openJobsScopeSite: site,
    label: `${staffLabel} employees / ${rolesPhrase} = ${ratioText}`,
    detail: boundDetail
  };
}

const OPEN_ROLE_RATIO_LIMIT = 20;

function openJobsConfirmed(rating) {
  return ['page', 'greenhouse', 'lever', 'ashby', 'workday'].includes(String(rating?.openJobsSource || ''));
}

export function resolveWorkforce(rating) {
  const employees = rating?.employees;
  let openJobs = rating?.openJobs;
  const snippetCitation = String(rating?.openJobsSource || '') === 'search' || Boolean(rating?.openJobsEstimated);

  if (
    snippetCitation
    && !openJobsConfirmed(rating)
    && typeof employees === 'number'
    && employees > 0
    && typeof openJobs === 'number'
    && openJobs / employees > OPEN_ROLE_RATIO_LIMIT
  ) {
    console.info('[GHD] open jobs citation rejected', {
      count: openJobs,
      employees,
      ratio: Math.round((openJobs / employees) * 100) / 100,
      url: rating?.openJobsSourceUrl || '',
      reason: 'open roles far above headcount'
    });
    openJobs = null;
  }

  if (typeof employees !== 'number' || typeof openJobs !== 'number') {
    const knownEmployees = typeof employees === 'number' && employees > 0;
    const employeeSource = rating?.employeeSource || (knownEmployees ? 'glassdoor' : null);
    const exactHeadcount = employeeSource === 'wikidata' || employeeSource === 'linkedin';
    const lowerBound = knownEmployees && !exactHeadcount
      && (Boolean(rating?.employeesLowerBound) || /\d[\d,]*\s*\+/.test(String(rating?.employeeLabel || '')));
    const employeeText = lowerBound
      ? String(rating?.employeeLabel || `${Math.round(employees).toLocaleString('en-US')}+`).replace(/\s*employees?$/i, '')
      : (knownEmployees ? Math.round(employees).toLocaleString('en-US') : '');

    return {
      available: false,
      unavailable: false,
      score: 0,
      ratio: null,
      employees: knownEmployees ? employees : null,
      openRoles: typeof openJobs === 'number' && openJobs > 0 ? openJobs : null,
      employeeLabel: rating?.employeeLabel || null,
      employeeSource,
      employeeDiscrepancy: String(rating?.employeeDiscrepancy || '').trim(),
      estimated: knownEmployees ? !exactHeadcount : false,
      lowerBound,
      label: knownEmployees ? `${employeeText} employees · open roles unknown` : 'Unavailable',
      detail: '',
      tooltip: lowerBound
        ? 'Employee count is a lower-bound estimate from an open-ended size bucket, so this ratio is less precise than an exact headcount or a closed range. Company hiring for 3+ positions per employee may have inflated postings'
        : 'Company hiring for 3+ positions per employee may have inflated postings'
    };
  }

  const employeeSource = rating?.employeeSource || 'glassdoor';
  const exactHeadcount = employeeSource === 'wikidata' || employeeSource === 'linkedin';
  const lowerBound = exactHeadcount
    ? false
    : Boolean(rating?.employeesLowerBound) || /\d[\d,]*\s*\+/.test(String(rating?.employeeLabel || ''));
  const scored = scoreHiringRatio({
    employees,
    openRoles: openJobs,
    employeeLabel: rating.employeeLabel,
    lowerBound
  });
  const discrepancy = String(rating?.employeeDiscrepancy || '').trim();
  const openJobsLabel = rating?.openJobsEstimated
    ? scored.label.replace(' open roles', ' open roles (estimated)')
    : scored.label;
  const rolesBound = openJobsLowerBound(rating, scored, lowerBound);

  return {
    ...scored,
    ...rolesBound,
    label: rolesBound.label || openJobsLabel,
    employeeLabel: rating.employeeLabel || null,
    employeeSource,
    openJobsSource: rating?.openJobsSource || '',
    openJobsEstimated: Boolean(rating?.openJobsEstimated),
    employeeDiscrepancy: discrepancy,
    employeeSourceUrl: rating?.employeeSourceUrl || '',
    detail: [rolesBound.detail || scored.detail, rating?.openJobsEstimated && rating?.openJobsSourceUrl
      ? `Estimated from search: ${rating.openJobsSourceUrl}`
      : '', rating?.employeeSource === 'search' && rating?.employeeSourceUrl
      ? `Estimated from search: ${rating.employeeSourceUrl}`
      : ''].filter(Boolean).join(' '),
    tooltip: [scored.tooltip, discrepancy].filter(Boolean).join(' '),
    estimated: !exactHeadcount,
    unavailable: false
  };
}

// One deadline for the whole check. At 9s, finished factors are returned and
// the rest are marked as timed out; the client aborts at 12s and Vercel stops
// the function at 15s, so this is the first of the three to fire.
export const ANALYSIS_DEADLINE_MS = 9000;
// A response with a timed-out factor is not kept as the check's answer for long.
export const PARTIAL_ANALYSIS_TTL_MS = 5 * 60 * 1000;
const TIMED_OUT_DETAIL = 'Took too long to check. Try again in a few minutes.';

export function createDeadline(ms = ANALYSIS_DEADLINE_MS, startedAt = Date.now()) {
  const at = startedAt + ms;
  let timer;
  const reached = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, at - Date.now()));
    // Never keeps a process alive by itself; the handler clears it anyway.
    timer.unref?.();
  });

  return {
    at,
    reached,
    passed: () => Date.now() >= at,
    clear: () => clearTimeout(timer)
  };
}

// { value } when the work settled first, { timedOut: true } when the deadline
// did. A rejection before the deadline still throws, as it did before.
function beforeDeadline(promise, deadline) {
  const work = Promise.resolve(promise);

  if (!deadline) {
    return work.then((value) => ({ value }));
  }

  return Promise.race([
    work.then((value) => ({ value })),
    deadline.reached.then(() => ({ timedOut: true }))
  ]);
}

function timedOutLayoffs() {
  return { detected: false, unavailable: true, timedOut: true, date: null, score: 0, headline: null, url: null, detail: TIMED_OUT_DETAIL, matches: [] };
}

function timedOutReviews() {
  return { rating: null, reviewCount: null, platform: null, url: null, score: 0, unavailable: true, timedOut: true, detail: TIMED_OUT_DETAIL };
}

function timedOutReposts() {
  return { ...pendingReposts(), pending: false, timedOut: true, detail: TIMED_OUT_DETAIL };
}

// The Glassdoor floor, if Glassdoor's fields have already arrived. Used only in
// this response: it is never written to the open-roles cache.
async function deadlineFloor(fieldsPromise) {
  const fields = await Promise.race([fieldsPromise, Promise.resolve(null)]);
  const count = Number(fields?.openJobs);

  return Number.isFinite(count) && count > 0
    ? { count: Math.round(count), source: 'glassdoor', estimated: false, lowerBound: true, scope: 'glassdoor_listings', url: '', deadline: true }
    : null;
}

// Layoffs and reviews feed the score directly, so if either is unfinished the
// score is withheld. Open roles, headcount and reposts do not hold it back.
function applyDeadline(scored, timedOut) {
  const partial = Object.values(timedOut).some(Boolean);
  const withheld = Boolean(timedOut.layoffs || timedOut.reviews);

  if (!partial) {
    return scored;
  }

  return {
    ...scored,
    ...(withheld ? { ghostScore: null, label: null, scoreWithheld: true } : {}),
    partial: true,
    timedOut: Object.keys(timedOut).filter((name) => timedOut[name])
  };
}

function timed(deps, name, work) {
  return deps.trace ? deps.trace.span(name, work) : work();
}

function careersFields(counted) {
  return {
    careers: counted?.careers?.show ? counted.careers : null,
    careersChecked: counted?.careersChecked !== false
  };
}

function pendingReposts() {
  return {
    pending: true,
    score: 0,
    unavailable: true,
    available: false,
    matches: [],
    detail: ''
  };
}

function loadCompanySignals(company, input) {
  // One Wikidata lookup per check, its label and official website visible to
  // both the profile and open roles (the careers-page check reads the website).
  const deps = {
    ...input,
    wikidataLabels: input?.wikidataLabels instanceof Map ? input.wikidataLabels : new Map(),
    wikidataWebsites: input?.wikidataWebsites instanceof Map ? input.wikidataWebsites : new Map(),
    wikidataMemo: input?.wikidataMemo instanceof Map ? input.wikidataMemo : new Map(),
    employeeSearchMemo: input?.employeeSearchMemo instanceof Map ? input.employeeSearchMemo : new Map()
  };
  const now = deps.now || new Date();
  const reviewKey = reviewCacheKey(company);
  // Open roles needs Glassdoor's own fields (website, size bucket, open-jobs
  // count), which are final well before the headcount merge and its paid
  // employee search. The profile sends them as soon as they are; if it never
  // does, the finished profile supplies them.
  let resolveFields;
  const fieldsPromise = new Promise((resolve) => {
    resolveFields = resolve;
  });
  const profilePromise = timed(deps, 'factor: company profile (glassdoor+headcount)', () => (deps.lookupCompanyRating || lookupCompanyRating)(company, {
    ...deps,
    onGlassdoorFields: (fields) => resolveFields(fields)
  }));
  profilePromise.then((profile) => resolveFields(glassdoorFields(profile)), () => resolveFields(glassdoorFields(null)));
  const reviewsPromise = timed(deps, 'factor: reviews', async () => {
    const cachedReview = deps.cache ? await cacheGet(deps.cache, reviewKey, now) : null;

    if (cachedReview) {
      return cachedReview;
    }

    // The validated Glassdoor rating, not the headcount merge or its paid search.
    const reviews = await resolveCompanyReview(company, deps, await fieldsPromise);

    if (deps.cache) {
      await cacheSet(deps.cache, reviewKey, reviews, reviews?.unavailable || reviews?.searchFailed ? REVIEW_RETRY_TTL_MS : REVIEW_TTL_MS, now);
    }

    return reviews;
  });

  const openJobsPromise = timed(deps, 'factor: open roles', () => resolveOpenJobCount(company, {
    website: deps.website || '',
    profile: fieldsPromise,
    jobUrl: deps.jobUrl || '',
    hostname: deps.hostname || '',
    platform: deps.platform || '',
    onPageCount: deps.onPageCount,
    openJobsPageUrl: deps.openJobsPageUrl || '',
    openJobsCompanyId: deps.openJobsCompanyId || '',
    openJobsAllMatch: deps.openJobsAllMatch === true,
    jobTitle: deps.jobTitle || ''
  }, deps));

  return {
    reviews: reviewsPromise,
    openJobs: openJobsPromise,
    workforce: (async () => {
      // Starts with the profile, not after it. Only the later steps of the
      // open-roles order read the profile, and they await it there.
      const opened = await beforeDeadline(openJobsPromise, deps.deadline);
      const counted = opened.timedOut ? await deadlineFloor(fieldsPromise) : opened.value;
      const profiled = await beforeDeadline(profilePromise, deps.deadline);

      if (profiled.timedOut) {
        // Headcount unfinished: the ratio is shown unscored and the score still shows.
        return {
          ...resolveWorkforce({ openJobs: counted?.count, openJobsSource: counted?.source }),
          score: 0,
          timedOut: true,
          headcountTimedOut: true,
          openRolesTimedOut: Boolean(opened.timedOut),
          detail: TIMED_OUT_DETAIL
        };
      }

      const profile = profiled.value;
      const rating = counted
        ? {
          ...profile,
          openJobs: counted.count,
          openJobsSource: counted.source,
          openJobsEstimated: Boolean(counted.estimated),
          openJobsLowerBound: Boolean(counted.lowerBound),
          openJobsScope: counted.scope || '',
          openJobsScopeQualifier: counted.scopeQualifier || '',
          openJobsScopeSite: counted.scopeSite || '',
          openJobsWorkdayCapped: Boolean(counted.workdayBoard),
          openJobsSourceUrl: counted.url || counted.workdayBoard || ''
        }
        : profile;
      const workforce = resolveWorkforce(rating);

      return opened.timedOut
        ? { ...workforce, timedOut: true, openRolesTimedOut: true, detail: [TIMED_OUT_DETAIL, workforce.detail].filter(Boolean).join(' ') }
        : workforce;
    })()
  };
}

async function companyForAnalysis(job, deps) {
  const company = String(job?.company || '').trim();

  if (!company || isNormalCompanyName(company)) {
    return company;
  }

  try {
    const resolved = await resolveCompanyIdentity({
      rawName: company,
      description: job.description || '',
      hostname: job.hostname || '',
      platform: job.platform || '',
      slug: job.slug || job.companySlug || ''
    }, deps);
    return String(resolved || company).trim() || company;
  } catch {
    return company;
  }
}

export async function analyzeJobPosting(job, deps) {
  const company = await timed(deps, 'identity (server)', () => companyForAnalysis(job, deps));
  const analyzed = company === job.company ? job : { ...job, company };
  const now = deps.now || new Date();
  const cache = deps.cache;
  const key = analysisCacheKey(analyzed);
  // The company factors run on both paths below, so they start before the
  // analysis-cache read instead of after it.
  const cachedRead = cache ? cacheGet(cache, key, now) : Promise.resolve(null);
  const signals = loadCompanySignals(analyzed.company, {
    ...deps,
    clientHtml: job.clientHtml?.reviews || '',
    capturedHeadcount: job.capturedHeadcount || null,
    companySlug: job.companySlug || job.slug || '',
    jobUrl: job.url || '',
    hostname: job.hostname || '',
    platform: job.platform || '',
    onPageCount: job.openJobsCount,
    openJobsPageUrl: job.openJobsPageUrl || '',
    openJobsCompanyId: job.openJobsCompanyId || '',
    openJobsAllMatch: job.openJobsAllMatch === true,
    jobTitle: analyzed.title || ''
  });
  const reviewsPromise = signals.reviews;
  const workforcePromise = signals.workforce;
  deps.inFlight?.push(signals.reviews, signals.openJobs, signals.workforce);
  const cached = await cachedRead;
  const deferReposts = job.deferReposts === true;
  const track = (promise) => {
    deps.inFlight?.push(promise);
    return promise;
  };
  const repostWork = () => (deferReposts
    ? pendingReposts()
    : track(timed(deps, 'factor: reposts', () => detectReposts(analyzed, {
      ...deps,
      clientHtml: job.clientHtml?.reposts || ''
    }))));

  if (cached) {
    const stale = staleFactors(cached);
    const [layoffsRun, repostsRun, hiringRatio, reviewsRun, countedRun] = await Promise.all([
      beforeDeadline(stale.layoffs
        ? track(timed(deps, 'factor: layoffs', () => detectLayoffs(analyzed.company, {
          ...deps,
          description: analyzed.description || '',
          clientHtml: job.clientHtml?.layoffs || ''
        })))
        : cached.factors?.layoffs, deps.deadline),
      beforeDeadline(repostWork(), deps.deadline),
      workforcePromise,
      beforeDeadline(reviewsPromise, deps.deadline),
      beforeDeadline(signals.openJobs, deps.deadline)
    ]);
    const layoffs = layoffsRun.timedOut ? timedOutLayoffs() : layoffsRun.value;
    const reposts = repostsRun.timedOut ? timedOutReposts() : repostsRun.value;
    const reviews = reviewsRun.timedOut ? timedOutReviews() : reviewsRun.value;
    const counted = countedRun.timedOut ? null : countedRun.value;
    const timedOut = {
      layoffs: Boolean(layoffsRun.timedOut),
      reviews: Boolean(reviewsRun.timedOut),
      reposts: Boolean(repostsRun.timedOut),
      hiringRatio: Boolean(hiringRatio?.timedOut)
    };
    const vagueness = stale.vagueness
      ? analyzeVagueness(analyzed.description, analyzed.title, analyzed.salary)
      : cached.factors?.vagueness;
    console.info('[GHD] vagueness', {
      company: analyzed.company,
      title: analyzed.title,
      cached: !stale.vagueness,
      label: vagueness?.label,
      score: vagueness?.score,
      factors: vagueness?.factors || null,
      raw: vagueness?.raw || null
    });
    const factors = { reposts, layoffs, reviews, vagueness, hiringRatio };
    const scored = applyDeadline(buildGhostScore(factors), timedOut);
    logGhostScore(analyzed.company, analyzed.title, hiringRatio, scored);
    const payload = {
      ...scored,
      checkedAt: cached.checkedAt || now.toISOString(),
      factors,
      factorVersions: { ...FACTOR_VERSIONS }
    };
    const repostsOk = deferReposts || !stale.reposts || !reposts?.unavailable;
    const layoffsOk = !stale.layoffs || !layoffs?.unavailable;

    if (cache && (stale.reposts || stale.layoffs || stale.vagueness) && repostsOk && layoffsOk) {
      await cacheSet(cache, key, payload, payload.partial ? PARTIAL_ANALYSIS_TTL_MS : ANALYSIS_TTL_MS, now);
    }

    return {
      ...payload,
      ...careersFields(counted),
      cached: true,
      cachedAt: cached.checkedAt || null
    };
  }

  const [layoffsRun, repostsRun, hiringRatio, reviewsRun, countedRun] = await Promise.all([
    beforeDeadline(track(timed(deps, 'factor: layoffs', () => detectLayoffs(analyzed.company, {
      ...deps,
      description: analyzed.description || '',
      clientHtml: job.clientHtml?.layoffs || ''
    }))), deps.deadline),
    beforeDeadline(repostWork(), deps.deadline),
    workforcePromise,
    beforeDeadline(reviewsPromise, deps.deadline),
    beforeDeadline(signals.openJobs, deps.deadline)
  ]);
  const layoffs = layoffsRun.timedOut ? timedOutLayoffs() : layoffsRun.value;
  const reposts = repostsRun.timedOut ? timedOutReposts() : repostsRun.value;
  const reviews = reviewsRun.timedOut ? timedOutReviews() : reviewsRun.value;
  const counted = countedRun.timedOut ? null : countedRun.value;
  const timedOut = {
    layoffs: Boolean(layoffsRun.timedOut),
    reviews: Boolean(reviewsRun.timedOut),
    reposts: Boolean(repostsRun.timedOut),
    hiringRatio: Boolean(hiringRatio?.timedOut)
  };

  const vagueness = analyzeVagueness(analyzed.description, analyzed.title, analyzed.salary);
  console.info('[GHD] vagueness', {
    company: analyzed.company,
    title: analyzed.title,
    label: vagueness.label,
    score: vagueness.score,
    factors: vagueness.factors,
    raw: vagueness.raw
  });
  const factors = {
    reposts,
    layoffs,
    reviews,
    vagueness,
    hiringRatio
  };
  const scored = applyDeadline(buildGhostScore(factors), timedOut);
  logGhostScore(analyzed.company, analyzed.title, hiringRatio, scored);
  const payload = {
    ...scored,
    checkedAt: now.toISOString(),
    factors,
    factorVersions: { ...FACTOR_VERSIONS }
  };

  if (cache && !layoffs.unavailable && (deferReposts || !reposts.unavailable)) {
    await cacheSet(cache, key, payload, payload.partial ? PARTIAL_ANALYSIS_TTL_MS : ANALYSIS_TTL_MS, now);
  }

  return {
    ...payload,
    ...careersFields(counted),
    cached: false,
    cachedAt: null
  };
}

export async function lookupCompanyReviews(company, deps) {
  const reviews = await findCompanyReviews(company, {
    ...deps,
    clientHtml: deps.clientHtml || ''
  });

  return {
    ...reviews,
    cached: false
  };
}

// The package's waitUntil is a silent no-op outside a Vercel request, so writes
// are deferred only when the request context really provides one.
function requestWaitUntil() {
  const context = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  return typeof context?.waitUntil === 'function' ? waitUntil : null;
}

function dependencies(overrides = {}) {
  const env = overrides.env || process.env;

  return {
    searchNews: overrides.searchNews || ((query) => searchNewsData(query, env)),
    webSearch: overrides.webSearch || ((query, options = {}) => webSearch(query, { ...options, env })),
    cache: overrides.cache || createCache(env),
    rateLimit: overrides.rateLimit || createRateLimiter(env),
    now: overrides.now || new Date(),
    fetchCompanyPage: overrides.fetchCompanyPage,
    fetch: overrides.fetch || fetch,
    careersLookup: overrides.careersLookup || CAREERS_NETWORK.careersLookup,
    careersRequest: overrides.careersRequest || CAREERS_NETWORK.careersRequest,
    env,
    askGroq: overrides.askGroq || ((prompt, options = {}) => askGroq(prompt, {
      ...options,
      env: options.env || env,
      fetch: options.fetch || overrides.fetch || fetch
    }))
  };
}

// The rate check runs alongside the factors instead of before them. Until it
// allows the request, nothing that costs money is sent and nothing is written
// to the shared cache: paid calls (RapidAPI, Tavily, Groq, NewsData) and cache
// writes wait for the decision, and fail or are dropped when it is a no. Free
// reads (cache, Wikidata, public job-board APIs, layoffs.fyi) start at once.
// A rejected request gets its 429 before anything else is sent.
const PAID_HOSTS = /(^|\.)(rapidapi\.com|tavily\.com|groq\.com|newsdata\.io)$/i;

function hostOf(input) {
  try {
    return new URL(typeof input === 'string' || input instanceof URL ? input : input?.url).hostname;
  } catch {
    return '';
  }
}

// After the deadline no new paid step starts: each paid call fails before it is
// sent. Calls already in flight finish, and their results are cached as usual.
export function stopPaidCallsAfter(deps, deadline) {
  if (!deadline) {
    return deps;
  }

  const check = () => {
    if (deadline.passed()) {
      throw new Error('DEADLINE_PASSED');
    }
  };
  const gate = (fn) => (typeof fn === 'function'
    ? async (...args) => {
      check();
      return fn(...args);
    }
    : fn);

  return {
    ...deps,
    deadline,
    webSearch: gate(deps.webSearch),
    askGroq: gate(deps.askGroq),
    searchNews: gate(deps.searchNews),
    fetch: typeof deps.fetch === 'function'
      ? async (input, init) => {
        if (PAID_HOSTS.test(hostOf(input))) {
          check();
        }

        return deps.fetch(input, init);
      }
      : deps.fetch
  };
}

export function gateOnRateLimit(deps, allowed) {
  const decided = async () => {
    if (!(await allowed)) {
      throw new Error('RATE_LIMITED');
    }
  };
  const gate = (fn) => (typeof fn === 'function'
    ? async (...args) => {
      await decided();
      return fn(...args);
    }
    : fn);
  const cache = deps.cache
    ? {
      get: (...args) => deps.cache.get(...args),
      set: async (...args) => {
        if (await allowed) {
          return deps.cache.set(...args);
        }

        return undefined;
      }
    }
    : deps.cache;

  return {
    ...deps,
    cache,
    webSearch: gate(deps.webSearch),
    askGroq: gate(deps.askGroq),
    searchNews: gate(deps.searchNews),
    fetch: typeof deps.fetch === 'function'
      ? async (input, init) => {
        if (PAID_HOSTS.test(hostOf(input))) {
          await decided();
        }

        return deps.fetch(input, init);
      }
      : deps.fetch
  };
}

function rateLimitHeaders(res, result) {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(result.limit - result.count, 0)));
}

function sendRateLimited(res) {
  res.setHeader('Retry-After', '3600');
  sendJson(res, 429, {
    error: 'Rate limit exceeded. Try again in under an hour.'
  });
}

async function enforceRateLimit(req, res, deps) {
  const result = await deps.rateLimit.consume(clientIp(req), deps.now);

  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(result.limit - result.count, 0)));

  if (!result.allowed) {
    res.setHeader('Retry-After', '3600');
    sendJson(res, 429, {
      error: 'Rate limit exceeded. Try again in under an hour.'
    });
    return false;
  }

  return true;
}

// TEMPORARY (latency measurement, 2026-10-05): a request carrying the private
// token gets an empty per-request cache, so the same companies can be timed
// cold before and after a change without touching the shared cache. Only the
// token's hash is here. Remove once the measurement is done.
const TRACE_COLD_TOKEN_SHA256 = '7eb2778dae8e44205bb0166ec749ac636675801f725c42cc4711b12798480d9c';

function coldTraceRequested(req) {
  const token = String(req.headers?.['x-ghd-trace-cold'] || '');
  return Boolean(token) && createHash('sha256').update(token).digest('hex') === TRACE_COLD_TOKEN_SHA256;
}

export function createAnalyzeHandler(overrides = {}) {
  return async function handler(req, res) {
    const trace = createTrace('analyze-job');
    const cold = coldTraceRequested(req);
    const base = cold ? { ...dependencies(overrides), cache: new MemoryCache() } : dependencies(overrides);
    const deferred = { ...base, cache: deferWrites(base.cache, overrides.waitUntil || requestWaitUntil()) };
    const traced = tracedDependencies(deferred, trace);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!requireClient(req, res)) {
      return;
    }

    const decision = trace.span('rate limit', () => traced.rateLimit.consume(clientIp(req), traced.now));
    const allowed = decision.then((result) => result.allowed === true, () => false);
    const deadline = createDeadline(overrides.deadlineMs || ANALYSIS_DEADLINE_MS);
    const deps = { ...stopPaidCallsAfter(gateOnRateLimit(traced, allowed), deadline), inFlight: [] };
    // Work still running when a partial response goes out finishes (within the
    // function's time limit) so its results are cached for the next check.
    const finishInFlight = () => {
      deadline.clear();
      const keepAlive = overrides.waitUntil || requestWaitUntil();

      if (keepAlive && deps.inFlight.length) {
        keepAlive(Promise.allSettled(deps.inFlight));
      }
    };
    let analysis = null;
    let validated = null;

    try {
      validated = validateJobBody(await readJsonBody(req));

      if (!validated.error) {
        analysis = analyzeJobPosting(validated.value, deps).then((value) => ({ value }), (error) => ({ error }));
      }
    } catch (error) {
      analysis = Promise.resolve({ error });
    }

    let result;

    try {
      result = await decision;
    } catch {
      result = { allowed: false, count: 0, limit: 0 };
    }

    rateLimitHeaders(res, result);

    if (!result.allowed) {
      trace.report({ rateLimited: true });
      finishInFlight();
      sendRateLimited(res);
      return;
    }

    if (validated?.error) {
      finishInFlight();
      sendJson(res, 400, { error: validated.error });
      return;
    }

    const outcome = await analysis;

    if (!outcome || outcome.error) {
      trace.report({ failed: true });
      finishInFlight();
      sendJson(res, 500, { error: 'Analysis failed' });
      return;
    }

    trace.report({ company: outcome.value?.company || validated.value.company, cached: Boolean(outcome.value?.cached), coldTrace: cold, rateVia: result.via || 'memory', partial: Boolean(outcome.value?.partial), timedOut: outcome.value?.timedOut || [] });
    finishInFlight();
    sendJson(res, 200, outcome.value);
  };
}

export function createReviewsHandler(overrides = {}) {
  return async function handler(req, res) {
    const deps = dependencies(overrides);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!requireClient(req, res)) {
      return;
    }

    if (!(await enforceRateLimit(req, res, deps))) {
      return;
    }

    try {
      const body = await readJsonBody(req);
      const validated = validateCompanyBody(body);

      if (validated.error) {
        sendJson(res, 400, { error: validated.error });
        return;
      }

      const reviews = await lookupCompanyReviews(validated.value.company, {
        ...deps,
        clientHtml: validated.value.clientHtml || ''
      });
      sendJson(res, 200, reviews);
    } catch {
      sendJson(res, 500, { error: 'Review lookup failed' });
    }
  };
}

export function createJobRepostsHandler(overrides = {}) {
  return async function handler(req, res) {
    const trace = createTrace('job-reposts');
    const base = dependencies(overrides);
    const deferred = { ...base, cache: deferWrites(base.cache, overrides.waitUntil || requestWaitUntil()) };
    const deps = tracedDependencies(deferred, trace);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!requireClient(req, res)) {
      return;
    }

    if (!(await trace.span('rate limit', () => enforceRateLimit(req, res, deps)))) {
      return;
    }

    try {
      const body = await readJsonBody(req);
      const validated = validateJobBody(body);

      if (validated.error) {
        sendJson(res, 400, { error: validated.error });
        return;
      }

      const reposts = await trace.span('factor: reposts', () => detectReposts(validated.value, {
        ...deps,
        clientHtml: validated.value.clientHtml?.reposts || ''
      }));
      trace.report({ company: validated.value.company });
      sendJson(res, 200, { reposts });
    } catch {
      trace.report({ failed: true });
      sendJson(res, 500, { error: 'Repost check failed' });
    }
  };
}

export function createCareersHandler(overrides = {}) {
  return async function handler(req, res) {
    const deps = dependencies(overrides);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!requireClient(req, res)) {
      return;
    }

    if (!(await enforceRateLimit(req, res, deps))) {
      return;
    }

    try {
      const body = await readJsonBody(req);
      const validated = validateJobBody(body);

      if (validated.error) {
        sendJson(res, 400, { error: validated.error });
        return;
      }

      const careers = await checkCompanyCareers(validated.value.company, {
        jobTitle: validated.value.title,
        jobUrl: validated.value.url,
        website: '',
        platform: validated.value.platform,
        hostname: validated.value.hostname
      }, deps);
      sendJson(res, 200, { careers });
    } catch {
      sendJson(res, 500, { error: 'Careers check failed' });
    }
  };
}

export const analyzeHandler = createAnalyzeHandler({
  fetch
});
export const reviewsHandler = createReviewsHandler();
export const jobRepostsHandler = createJobRepostsHandler({
  fetch
});
export const careersHandler = createCareersHandler({
  fetch
});
