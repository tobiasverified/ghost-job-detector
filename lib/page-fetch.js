(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.GhdFetch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COMPANY_TTL_MS = 6 * 60 * 60 * 1000;
  const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
  const JOB_TTL_MS = 60 * 60 * 1000;
  const LAYOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const COMPANY_DATA_TTL_MS = 24 * 60 * 60 * 1000;
  const COMPANY_PREFIX = 'ghd_co:';
  const SEARCH_PREFIX = 'ghd_search:';
  const REVIEW_PREFIX = 'ghd_review:';
  const LAYOFF_PREFIX = 'ghd_layoff:';

  function isLinkedInBlocked(html) {
    const text = String(html || '');

    if (!text) {
      return false;
    }

    return /authwall|linkedin\.com\/uas\/login|linkedin\.com\/login|checkpoint\/challenge|security verification|sign in \| linkedin|join linkedin to see/i.test(text);
  }

  function isCompanyPage(html) {
    const text = String(html || '');

    if (!text || isLinkedInBlocked(text)) {
      return false;
    }

    return /employees|followers|company size|\d[\d,]*\s+open jobs/i.test(text);
  }

  // DuckDuckGo HTML first (server-rendered, usually under 1s). Lite is the only fallback.
  // Brave was removed: its tab path answered "request has been refused" and then sat until timeout.
  function searchEngines(query) {
    const encoded = encodeURIComponent(String(query || ''));

    return [
      {
        name: 'ddg-html',
        url: `https://html.duckduckgo.com/html/?q=${encoded}`,
        validator: (html) => /result__a|uddg=/i.test(html) && !hasBotBlock(html)
      },
      {
        name: 'ddg-lite',
        url: `https://lite.duckduckgo.com/lite/?q=${encoded}`,
        validator: (html) => /result-link|uddg=/i.test(html) && !hasBotBlock(html)
      }
    ];
  }

  function hasBotBlock(html) {
    const text = String(html || '');

    if (/result__a|uddg=|result-link/i.test(text) && !/request has been refused/i.test(text)) {
      return false;
    }

    return /request has been refused|Tor|VPN|bot|captcha|unusual traffic/i.test(text);
  }

  function pickCompanyResult(attempts) {
    const ready = (attempts || []).find((item) => item && item.status !== 'blocked' && (item.jobs || item.about));

    if (ready) {
      return {
        about: ready.about || '',
        jobs: ready.jobs || '',
        status: 'ok'
      };
    }

    if ((attempts || []).some((item) => item?.status === 'blocked')) {
      return { about: '', jobs: '', status: 'blocked' };
    }

    const status = (attempts || []).find((item) => item?.status)?.status || 'missing';

    return { about: '', jobs: '', status };
  }

  function normalizedSearchHtml(url, html) {
    let host = '';

    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return String(html || '');
    }

    if (host !== 'search.brave.com') {
      return String(html || '');
    }

    const rows = [];

    for (const block of String(html || '').split(/data-type="web"/i).slice(1)) {
      const linkMatch = block.match(/href="(https?:\/\/[^"]+)"/i);

      if (!linkMatch || /search\.brave\.com|imgs\.search\.brave\.com/i.test(linkMatch[1])) {
        continue;
      }

      const title = block
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);

      if (title) {
        rows.push(`<a class="result__a" href="${linkMatch[1]}">${title}</a>`);
      }
    }

    return rows.length ? `<html><body>${rows.join('\n')}</body></html>` : String(html || '');
  }

  function firstValidPage(pages) {
    for (const page of pages || []) {
      if (usablePageHtml(page.url, page.html)) {
        return page;
      }
    }

    return null;
  }

  function usablePageHtml(url, html) {
    const text = String(html || '');
    let host = '';

    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }

    if (text.length < 500 || isLinkedInBlocked(text)) {
      return false;
    }

    if (host === 'html.duckduckgo.com' || host === 'duckduckgo.com') {
      return /result__a|uddg=/i.test(text) && !hasBotBlock(text);
    }

    if (host === 'lite.duckduckgo.com') {
      return /result-link|uddg=/i.test(text) && !hasBotBlock(text);
    }

    if ((host === 'linkedin.com' || host.endsWith('.linkedin.com')) && /\/company\//i.test(url)) {
      return isCompanyPage(text);
    }

    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      return true;
    }

    return false;
  }

  function companyCacheKey(company, part) {
    const name = String(company || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80);

    return `${COMPANY_PREFIX}${name}:${part}`;
  }

  function searchCacheKey(query) {
    return `${SEARCH_PREFIX}${String(query || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180)}`;
  }

  function reviewCacheKey(query) {
    return `${REVIEW_PREFIX}${String(query || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180)}`;
  }

  function normalizeStorageKey(prefix, value) {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'unknown';

    return `${prefix}${normalized}`;
  }

  function createJsonCache(storage, ttlMs, now) {
    const clock = now || (() => Date.now());

    return {
      async get(key) {
        const row = await storage.get(key);

        if (!row || row.savedAt == null || row.value == null) {
          console.info('[GHD] cache miss', { key });
          return null;
        }

        if (clock() - Number(row.savedAt) > ttlMs) {
          console.info('[GHD] cache miss', { key, reason: 'expired' });

          if (storage.remove) {
            await storage.remove(key);
          }

          return null;
        }

        console.info('[GHD] cache hit', { key });
        return row.value;
      },
      async set(key, value) {
        if (value == null) {
          return;
        }

        await storage.set(key, {
          value,
          savedAt: clock()
        });
      }
    };
  }

  function createHtmlCache(storage, ttlMs, now) {
    const clock = now || (() => Date.now());

    return {
      async get(key) {
        const row = await storage.get(key);

        if (!row || typeof row.html !== 'string' || !row.html || !row.savedAt) {
          console.info('[GHD] cache miss', { key });
          return null;
        }

        if (clock() - Number(row.savedAt) > ttlMs) {
          console.info('[GHD] cache miss', { key, reason: 'expired' });
          if (storage.remove) {
            await storage.remove(key);
          }

          return null;
        }

        console.info('[GHD] cache hit', { key });
        return row.html;
      },
      async set(key, html) {
        if (!html) {
          return;
        }

        await storage.set(key, {
          html: String(html),
          savedAt: clock()
        });
      }
    };
  }

  function classifyFetchError(error) {
    const message = String(error?.message || error || '');

    if (message === 'TAB_TIMEOUT') {
      return 'timeout';
    }

    if (message === 'SEARCH_BLOCKED' || message === 'LINKEDIN_BLOCKED') {
      return 'blocked';
    }

    return 'failed';
  }

  function htmlMarkers(html) {
    const text = String(html || '');

    return {
      length: text.length,
      authwall: /authwall/i.test(text),
      login: /linkedin\.com\/(?:uas\/)?login/i.test(text),
      signIn: /sign in/i.test(text),
      challenge: /challenge|captcha/i.test(text),
      blocked: isLinkedInBlocked(text),
      companyPage: isCompanyPage(text)
    };
  }

  return {
    COMPANY_TTL_MS,
    SEARCH_TTL_MS,
    JOB_TTL_MS,
    LAYOFF_TTL_MS,
    COMPANY_DATA_TTL_MS,
    COMPANY_PREFIX,
    SEARCH_PREFIX,
    REVIEW_PREFIX,
    LAYOFF_PREFIX,
    normalizeStorageKey,
    createJsonCache,
    hasBotBlock,
    pickCompanyResult,
    reviewCacheKey,
    isLinkedInBlocked,
    isCompanyPage,
    searchEngines,
    normalizedSearchHtml,
    firstValidPage,
    usablePageHtml,
    companyCacheKey,
    searchCacheKey,
    createHtmlCache,
    classifyFetchError,
    htmlMarkers
  };
});
