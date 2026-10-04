import { createHash } from 'node:crypto';
import { companyCacheKey } from './companies.js';
import { isNormalCompanyName, resolveCompanyIdentity } from './company-identity.js';
import { detectLayoffs } from './layoffs.js';
import { lookupCompanyRating } from './company-rating.js';
import { resolveOpenJobCount } from './open-jobs.js';
import { findCompanyReviews, scoreRating } from './reviews.js';
import { analyzeVagueness } from './vagueness.js';
import { detectReposts } from './reposts.js';
import { buildGhostScore } from './score.js';
import { scoreHiringRatio } from './workforce.js';
import { searchNewsData } from './newsdata.js';
import { webSearch } from './search.js';
import { askGroq } from './groq-client.js';
import { cacheGet, cacheSet, createCache, deferWrites } from './cache.js';
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
  vagueness: 'v2'
};

function capturedHeadcountKey(captured) {
  const employees = Number(captured?.employees);
  return Number.isFinite(employees) && employees > 0 ? String(Math.round(employees)) : '0';
}

function descriptionHash(description) {
  return createHash('sha256')
    .update(String(description || ''))
    .digest('hex')
    .slice(0, 16);
}

export function analysisCacheKey(job) {
  // v24 drops every v23 analysis. Those kept repost, layoff, and vagueness
  // results for 7 days after the logic that produced them changed.
  return [
    'analyze',
    'v24',
    companyCacheKey(job.company),
    companyCacheKey(job.title),
    descriptionHash(job.description),
    companyCacheKey(job.location || 'no-city'),
    capturedHeadcountKey(job.capturedHeadcount)
  ].join(':');
}

export function reviewCacheKey(company) {
  return `reviews:v6:${companyCacheKey(company)}`;
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
    return {
      rating: profile.overall,
      reviewCount: null,
      platform: 'Glassdoor',
      url: null,
      score: scoreRating(profile.overall),
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
  multiple_boards: 'on the largest of several job boards'
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
      ? `${roles}+ open roles on ${site}`
      : `${roles}+ open roles ${scope}`;
  const boundDetail = qualifier && site
    ? `${roles} is only the ${qualifier} roles listed on ${site}, not the company's full careers board, so this ratio is a lower bound and is not scored.`
    : rating.openJobsScope === 'open_ended' && site
      ? `${roles}+ is the open-ended figure on ${site}, not an exact total, so this ratio is a lower bound and is not scored.`
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

export function resolveWorkforce(rating) {
  const employees = rating?.employees;
  const openJobs = rating?.openJobs;

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

function timed(deps, name, work) {
  return deps.trace ? deps.trace.span(name, work) : work();
}

function loadCompanySignals(company, deps) {
  const now = deps.now || new Date();
  const reviewKey = reviewCacheKey(company);
  const profilePromise = timed(deps, 'factor: company profile (glassdoor+headcount)', () => (deps.lookupCompanyRating || lookupCompanyRating)(company, deps));
  const reviewsPromise = timed(deps, 'factor: reviews', async () => {
    const cachedReview = deps.cache ? await cacheGet(deps.cache, reviewKey, now) : null;

    if (cachedReview) {
      return cachedReview;
    }

    const reviews = await resolveCompanyReview(company, deps, await profilePromise);

    if (deps.cache) {
      await cacheSet(deps.cache, reviewKey, reviews, REVIEW_TTL_MS, now);
    }

    return reviews;
  });

  return {
    reviews: reviewsPromise,
    workforce: (async () => {
      // Starts with the profile, not after it. Only the later steps of the
      // open-roles order read the profile, and they await it there.
      const counted = await timed(deps, 'factor: open roles', () => resolveOpenJobCount(company, {
        website: deps.website || '',
        profile: profilePromise,
        jobUrl: deps.jobUrl || '',
        hostname: deps.hostname || '',
        platform: deps.platform || '',
        onPageCount: deps.onPageCount,
        openJobsPageUrl: deps.openJobsPageUrl || '',
        openJobsCompanyId: deps.openJobsCompanyId || '',
        openJobsAllMatch: deps.openJobsAllMatch === true
      }, deps));
      const profile = await profilePromise;
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
          openJobsSourceUrl: counted.url || ''
        }
        : profile;

      return resolveWorkforce(rating);
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
  const cached = cache ? await cacheGet(cache, key, now) : null;
  const signals = loadCompanySignals(analyzed.company, {
    ...deps,
    clientHtml: job.clientHtml?.reviews || '',
    capturedHeadcount: job.capturedHeadcount || null,
    jobUrl: job.url || '',
    hostname: job.hostname || '',
    platform: job.platform || '',
    onPageCount: job.openJobsCount,
    openJobsPageUrl: job.openJobsPageUrl || '',
    openJobsCompanyId: job.openJobsCompanyId || '',
    openJobsAllMatch: job.openJobsAllMatch === true
  });
  const reviewsPromise = signals.reviews;
  const workforcePromise = signals.workforce;

  if (cached) {
    const stale = staleFactors(cached);
    const [layoffs, reposts, hiringRatio, reviews] = await Promise.all([
      stale.layoffs
        ? timed(deps, 'factor: layoffs', () => detectLayoffs(analyzed.company, {
          ...deps,
          description: analyzed.description || '',
          clientHtml: job.clientHtml?.layoffs || ''
        }))
        : cached.factors?.layoffs,
      timed(deps, 'factor: reposts', () => detectReposts(analyzed, {
        ...deps,
        clientHtml: job.clientHtml?.reposts || ''
      })),
      workforcePromise,
      reviewsPromise
    ]);
    const vagueness = stale.vagueness
      ? analyzeVagueness(analyzed.description, analyzed.title)
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
    const scored = buildGhostScore(factors);
    logGhostScore(analyzed.company, analyzed.title, hiringRatio, scored);
    const payload = {
      ...scored,
      checkedAt: cached.checkedAt || now.toISOString(),
      factors,
      factorVersions: { ...FACTOR_VERSIONS }
    };
    const repostsOk = !stale.reposts || !reposts?.unavailable;
    const layoffsOk = !stale.layoffs || !layoffs?.unavailable;

    if (cache && (stale.reposts || stale.layoffs || stale.vagueness) && repostsOk && layoffsOk) {
      await cacheSet(cache, key, payload, ANALYSIS_TTL_MS, now);
    }

    return {
      ...payload,
      cached: true,
      cachedAt: cached.checkedAt || null
    };
  }

  const [layoffs, reposts, hiringRatio, reviews] = await Promise.all([
    timed(deps, 'factor: layoffs', () => detectLayoffs(analyzed.company, {
      ...deps,
      description: analyzed.description || '',
      clientHtml: job.clientHtml?.layoffs || ''
    })),
    timed(deps, 'factor: reposts', () => detectReposts(analyzed, {
      ...deps,
      clientHtml: job.clientHtml?.reposts || ''
    })),
    workforcePromise,
    reviewsPromise
  ]);

  const vagueness = analyzeVagueness(analyzed.description, analyzed.title);
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
  const scored = buildGhostScore(factors);
  logGhostScore(analyzed.company, analyzed.title, hiringRatio, scored);
  const payload = {
    ...scored,
    checkedAt: now.toISOString(),
    factors,
    factorVersions: { ...FACTOR_VERSIONS }
  };

  if (cache && !layoffs.unavailable && !reposts.unavailable) {
    await cacheSet(cache, key, payload, ANALYSIS_TTL_MS, now);
  }

  return {
    ...payload,
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
    env,
    askGroq: overrides.askGroq || ((prompt, options = {}) => askGroq(prompt, {
      ...options,
      env: options.env || env,
      fetch: options.fetch || overrides.fetch || fetch
    }))
  };
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

export function createAnalyzeHandler(overrides = {}) {
  return async function handler(req, res) {
    const trace = createTrace('analyze-job');
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

      const analysis = await analyzeJobPosting(validated.value, deps);
      trace.report({ company: analysis?.company || validated.value.company, cached: Boolean(analysis?.cached) });
      sendJson(res, 200, analysis);
    } catch {
      trace.report({ failed: true });
      sendJson(res, 500, { error: 'Analysis failed' });
    }
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

export const analyzeHandler = createAnalyzeHandler({
  fetch
});
export const reviewsHandler = createReviewsHandler();
