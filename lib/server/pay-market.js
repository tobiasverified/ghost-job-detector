import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GLASSDOOR_HOST } from './company-rating.js';
import { cacheGetMeta, cacheSet, createCache, writtenWithin } from './cache.js';
import { createRateLimiter, HOURLY_REQUEST_LIMIT } from './rateLimit.js';
import { installPaidQuota } from './paid-quota.js';
import { applyCors, cleanString, clientIp, readJsonBody, requireClient, sendJson } from './http.js';

function loadPay() {
  const sandbox = { console, module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../pay.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.module.exports;
}

const pay = loadPay();

export function payCompareEnabled(deps = {}) {
  if (deps.payCompareEnabled === true) {
    return true;
  }

  if (deps.payCompareEnabled === false) {
    return false;
  }

  const flag = String(deps.env?.PAY_COMPARE_ENABLED || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on';
}

export const MARKET_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MARKET_RETRY_TTL_MS = 5 * 60 * 1000;

function normalizePlace(value) {
  return pay.normalizeTitle(value);
}

export function marketCacheKey(title, location, bucket = 'all') {
  return `salary_market_v2_${pay.normalizeTitle(title)}_${normalizePlace(location) || 'no-location'}_${bucket}`;
}

export function salaryEstimateUrl(title, location, bucket = 'all') {
  const url = new URL(`https://${GLASSDOOR_HOST}/salaries/estimate`);
  url.searchParams.set('job_title', title);
  url.searchParams.set('years_of_experience', bucket || 'all');

  if (location) {
    url.searchParams.set('location', location);
  }

  return url;
}

function placeName(estimate, requested) {
  return String(estimate?.location?.name || requested || '').trim();
}

export function comparePostedPay(posted, estimate, title, location) {
  const decision = pay.marketDecision(estimate, title);

  if (!posted?.comparable || !decision.compare) {
    return {
      compared: false,
      reason: posted?.comparable ? decision.reason : (posted?.reason || 'no pay'),
      listed: posted?.listed || '',
      text: posted?.listed || '',
      note: ''
    };
  }

  const base = estimate.base_pay;
  const note = pay.placementOf(posted.midpoint, base);
  const medianText = pay.formatUsdSpan(base.p50, base.p50);
  const market = {
    compared: true,
    medianText,
    place: placeName(estimate, location),
    reports: estimate.salaries_count
  };

  return {
    compared: true,
    reason: '',
    listed: posted.listed,
    text: pay.paySentence(posted, market),
    note,
    median: base.p50,
    p25: base.p25,
    p75: base.p75,
    reports: estimate.salaries_count,
    place: market.place,
    currency: 'USD'
  };
}

async function readMarket(title, location, bucket, deps) {
  const key = marketCacheKey(title, location, bucket);
  const now = deps.now || new Date();
  const meta = deps.cache ? await cacheGetMeta(deps.cache, key, now) : null;
  const cached = meta?.payload || null;

  if (cached?.estimate && !deps.refresh) {
    return { estimate: cached.estimate, cached: true };
  }

  if (cached?.failed && !deps.refresh && writtenWithin(meta.updatedAt, MARKET_RETRY_TTL_MS, now)) {
    return { estimate: null, cached: true, failed: true, quota: Boolean(cached.quota) };
  }

  const apiKey = String(deps.env?.RAPIDAPI_KEY || '').trim();

  if (!apiKey || typeof deps.fetch !== 'function') {
    return { estimate: null, failed: true };
  }

  let response;

  try {
    response = await deps.fetch(salaryEstimateUrl(title, location, bucket), {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': GLASSDOOR_HOST
      },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    if (deps.cache) {
      await cacheSet(deps.cache, key, { failed: true }, MARKET_RETRY_TTL_MS, now);
    }

    return { estimate: null, failed: true };
  }

  if (!response.ok) {
    const quota = response.status === 429;

    if (deps.cache) {
      await cacheSet(deps.cache, key, { failed: true, quota }, MARKET_RETRY_TTL_MS, now);
    }

    return { estimate: null, failed: true, quota };
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!payload?.base_pay) {
    if (deps.cache) {
      await cacheSet(deps.cache, key, { failed: true }, MARKET_RETRY_TTL_MS, now);
    }

    return { estimate: null, failed: true };
  }

  if (deps.cache) {
    await cacheSet(deps.cache, key, { estimate: payload }, MARKET_TTL_MS, now);
  }

  return { estimate: payload, cached: false };
}

export async function lookupPayVsMarket(input, deps) {
  const title = cleanString(input?.title, 200);
  const location = cleanString(input?.location, 120);
  const posted = pay.parsePostedPay(input?.salary || '');

  if (!payCompareEnabled(deps)) {
    return {
      compared: false,
      reason: 'disabled',
      listed: posted.listed || '',
      text: posted.listed || '',
      note: ''
    };
  }

  if (!posted.ok) {
    return {
      compared: false,
      reason: 'no pay',
      listed: '',
      text: 'Salary not listed',
      note: ''
    };
  }

  if (!posted.comparable) {
    return comparePostedPay(posted, null, title, location);
  }

  const choice = pay.experienceChoice(title, `${input?.description || ''}\n${input?.salary || ''}`);

  if (choice.skip) {
    const shown = comparePostedPay(posted, null, title, location);
    return { ...shown, compared: false, reason: 'seniority' };
  }

  const market = await readMarket(title, location, choice.bucket, deps);
  const compared = comparePostedPay(posted, market.estimate, title, location);

  return {
    ...compared,
    cached: Boolean(market.cached),
    failed: Boolean(market.failed),
    quota: Boolean(market.quota)
  };
}

function rateHeaders(res, result) {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(result.limit - result.count, 0)));
}

export function createPayVsMarketHandler(overrides = {}) {
  const env = overrides.env || process.env;

  return async function handler(req, res) {
    const deps = installPaidQuota({
      cache: overrides.cache || createCache(env),
      rateLimit: overrides.rateLimit || createRateLimiter(env),
      now: overrides.now || new Date(),
      fetch: overrides.fetch || fetch,
      env,
      paidQuota: overrides.paidQuota
    }, overrides.quotaFetch);
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

    let result;

    try {
      result = await deps.rateLimit.consume(clientIp(req), deps.now);
    } catch {
      result = { allowed: false, count: 0, limit: HOURLY_REQUEST_LIMIT };
    }

    rateHeaders(res, result);

    if (!result.allowed) {
      res.setHeader('Retry-After', '3600');
      sendJson(res, 429, { error: 'Rate limit exceeded. Try again in under an hour.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const title = cleanString(body?.title, 200);

      if (!title) {
        sendJson(res, 400, { error: 'title is required' });
        return;
      }

      const payload = await lookupPayVsMarket({
        title,
        location: body?.location || body?.locationNormalized || '',
        salary: body?.salary || '',
        description: body?.description || ''
      }, deps);
      sendJson(res, 200, payload);
    } catch {
      sendJson(res, 500, { error: 'Pay comparison failed' });
    }
  };
}

export const payVsMarketHandler = createPayVsMarketHandler();
