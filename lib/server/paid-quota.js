// Daily caps for paid providers. Read here, from the env vars named below.
// Defaults are per UTC day for the whole deployment, not per visitor.
export const DAILY_LIMIT_DEFAULTS = {
  tavily: 40,
  rapidapi: 25,
  groq: 40,
  newsdata: 25
};

export const DAILY_LIMIT_ENV = {
  tavily: 'TAVILY_DAILY_LIMIT',
  rapidapi: 'RAPIDAPI_DAILY_LIMIT',
  groq: 'GROQ_DAILY_LIMIT',
  newsdata: 'NEWSDATA_DAILY_LIMIT'
};

export const PAID_CAP_TTL_MS = 5 * 60 * 1000;

const RAPIDAPI_HOST = /(^|\.)rapidapi\.com$/i;

export function dailyLimit(env, provider) {
  const name = DAILY_LIMIT_ENV[provider];
  const raw = env?.[name];

  if (raw == null || String(raw).trim() === '') {
    return DAILY_LIMIT_DEFAULTS[provider];
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return DAILY_LIMIT_DEFAULTS[provider];
  }

  return Math.floor(parsed);
}

function hostOf(input) {
  try {
    return new URL(typeof input === 'string' || input instanceof URL ? input : input?.url).hostname;
  } catch {
    return '';
  }
}

export function createPaidQuota(env = process.env, rpcFetch = fetch) {
  const counts = { tavily: 0, groq: 0, rapidapi: 0, newsdata: 0 };
  let rateLimited = false;
  let invite = null;

  function setInvite(value) {
    const id = String(value?.id || '').trim();
    const limit = Number(value?.limit);
    invite = id && Number.isInteger(limit) && limit > 0 ? { id, limit } : null;
  }

  async function consume(provider) {
    if (!Object.prototype.hasOwnProperty.call(DAILY_LIMIT_DEFAULTS, provider)) {
      rateLimited = true;
      return false;
    }

    const limit = dailyLimit(env, provider);
    const url = String(env?.SUPABASE_URL || '').replace(/\/$/, '');
    const key = String(env?.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    // No shared counter is configured. The call is allowed and counted locally.
    if (!url || !key) {
      counts[provider] += 1;
      return true;
    }

    const body = { p_provider: provider, p_limit: limit };

    if (invite?.id) {
      body.p_key_id = invite.id;
      body.p_key_limit = invite.limit;
    }

    try {
      const response = await rpcFetch(`${url}/rest/v1/rpc/ghd_consume_paid_call`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500)
      });

      if (!response.ok) {
        console.info('[GHD] paid cap rpc failed', { provider, status: response.status, keyId: invite?.id || '' });
        rateLimited = true;
        return false;
      }

      const allowed = await response.json() === true;

      if (!allowed) {
        console.info('[GHD] paid cap reached', { provider, keyId: invite?.id || '' });
        rateLimited = true;
        return false;
      }

      counts[provider] += 1;
      return true;
    } catch (error) {
      console.info('[GHD] paid cap rpc failed', {
        provider,
        keyId: invite?.id || '',
        error: error instanceof Error ? error.message : 'failed'
      });
      rateLimited = true;
      return false;
    }
  }

  return {
    consume,
    setInvite,
    rateLimited: () => rateLimited,
    snapshot: () => ({
      tavily: counts.tavily,
      groq: counts.groq,
      rapidapi: counts.rapidapi,
      newsdata: counts.newsdata,
      rateLimited
    })
  };
}

export function guardPaidCall(quota, provider, fn) {
  return async (...args) => {
    if (!(await quota.consume(provider))) {
      const error = new Error(`${provider} daily cap`);
      error.code = 'PAID_CAP';
      throw error;
    }

    return fn(...args);
  };
}

export function guardPaidFetch(quota, fetchImpl) {
  return async (input, init) => {
    if (RAPIDAPI_HOST.test(hostOf(input))) {
      if (!(await quota.consume('rapidapi'))) {
        return {
          ok: false,
          status: 503,
          text: async () => '',
          json: async () => ({})
        };
      }
    }

    return fetchImpl(input, init);
  };
}

export function installPaidQuota(deps, rpcFetch = fetch) {
  const quota = deps.paidQuota || createPaidQuota(deps.env || process.env, rpcFetch);
  const next = { ...deps, paidQuota: quota };

  if (typeof deps.searchNews === 'function') {
    next.searchNews = guardPaidCall(quota, 'newsdata', deps.searchNews);
  }

  if (typeof deps.webSearch === 'function') {
    next.webSearch = guardPaidCall(quota, 'tavily', deps.webSearch);
  }

  if (typeof deps.askGroq === 'function') {
    next.askGroq = guardPaidCall(quota, 'groq', deps.askGroq);
  }

  if (typeof deps.fetch === 'function') {
    next.fetch = guardPaidFetch(quota, deps.fetch);
  }

  if (deps.cache && typeof deps.cache.set === 'function') {
    const cache = deps.cache;
    next.cache = {
      get: (key, now) => cache.get(key, now),
      getMeta: (key, now) => (typeof cache.getMeta === 'function' ? cache.getMeta(key, now) : cache.get(key, now)),
      set: (key, payload, ttlMs, now) => cache.set(
        key,
        payload,
        quota.rateLimited() ? Math.min(ttlMs, PAID_CAP_TTL_MS) : ttlMs,
        now
      )
    };
  }

  return next;
}
