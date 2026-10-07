/**
 * Relays the latest extracted job and injects content scripts
 * after LinkedIn or Workday client-side navigations.
 */

importScripts('lib/page-fetch.js');

let currentJob = null;

function filesForUrl(rawUrl) {
  let page = null;

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      if (url.pathname.includes('/company/')) {
        page = 'linkedin-company';
      } else if (url.pathname.includes('/jobs/')) {
        page = 'linkedin';
      }
    } else if (host.endsWith('.myworkdayjobs.com')) {
      page = 'workday';
    }
  } catch {
    return null;
  }

  if (page === 'linkedin-company') {
    return ['lib/company-headcount.js', 'content/linkedin-company.js'];
  }

  if (page === 'linkedin') {
    return ['lib/company-headcount.js', 'lib/job-page.js', 'lib/heuristics.js', 'lib/pay.js', 'lib/widget.js', 'content.js'];
  }

  if (page === 'workday') {
    return ['lib/company-headcount.js', 'lib/job-page.js', 'lib/heuristics.js', 'lib/pay.js', 'lib/widget.js', 'content/workday.js'];
  }

  return null;
}

const INJECT_DEBUG_KEY = 'ghd_inject_debug';
const INJECT_DEBUG_LIMIT = 20;
// Content scripts run in the isolated world. The probe has to use that same
// world: the page's main world shares the DOM but not __GHD_COPY_LIVE__.
const SCRIPT_WORLD = 'ISOLATED';

function tabLocation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return { host: url.host, path: url.pathname };
  } catch {
    return { host: '', path: '' };
  }
}

function errorText(error) {
  return String(error?.message || error || 'unknown error');
}

async function recordInjectDebug(entry) {
  let current = [];

  try {
    const stored = await chrome.storage.local.get(INJECT_DEBUG_KEY);
    current = Array.isArray(stored?.[INJECT_DEBUG_KEY]) ? stored[INJECT_DEBUG_KEY] : [];
  } catch {
    current = [];
  }

  const next = [entry, ...current].slice(0, INJECT_DEBUG_LIMIT);

  try {
    await chrome.storage.local.set({ [INJECT_DEBUG_KEY]: next });
  } catch {
    // The record is diagnostic only.
  }

  return entry;
}

async function targetedFrames(tabId) {
  const frameIds = [0];

  try {
    if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
      return { frameIds, pageFrameIds: frameIds, frameError: '' };
    }

    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const pageFrameIds = (frames || [])
      .map((frame) => frame.frameId)
      .filter((id) => Number.isInteger(id));
    return { frameIds, pageFrameIds, frameError: '' };
  } catch (error) {
    return { frameIds, pageFrameIds: [], frameError: errorText(error) };
  }
}

function inject(tabId, rawUrl) {
  const files = filesForUrl(rawUrl);

  if (!files || !tabId) {
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: SCRIPT_WORLD,
    files
  }).catch(() => {
    // The page can reject injection during discard or navigation.
  });
}

// Same match patterns as manifest.content_scripts. chrome.tabs.query uses them
// to find tabs that were already open when this worker started.
const OPEN_TAB_URLS = [
  '*://*.linkedin.com/jobs/*',
  '*://*.linkedin.com/jobs/search*',
  '*://*.linkedin.com/jobs/search?*',
  '*://linkedin.com/jobs/*',
  '*://*.myworkdayjobs.com/*',
  '*://*.linkedin.com/company/*',
  '*://linkedin.com/company/*'
];

// Runs in the tab. A reload leaves the old copy's chrome dead, so that tab is
// injected again. A live job page also has a widget host stamped with this
// copy's instance. Leftover DOM from an orphaned copy is not enough.
function extensionCopyIsHealthy() {
  try {
    let runtimeId = '';

    try {
      runtimeId = chrome.runtime?.id || '';
    } catch (error) {
      return { healthy: false, reason: `runtime-threw: ${errorText(error)}` };
    }

    if (!runtimeId) {
      return { healthy: false, reason: 'no-runtime' };
    }

    let copyLive = false;

    try {
      copyLive = typeof globalThis.__GHD_COPY_LIVE__ === 'function' && globalThis.__GHD_COPY_LIVE__() === true;
    } catch (error) {
      return { healthy: false, reason: `live-check-threw: ${errorText(error)}` };
    }

    if (!copyLive) {
      return { healthy: false, reason: 'no-live-copy' };
    }

    if (globalThis.__GHD_LINKEDIN_COMPANY__ === true) {
      return { healthy: true, reason: 'company-live' };
    }

    const instance = globalThis.__GHD_INSTANCE__ || '';
    const host = document.getElementById('ghd-widget-host');
    const stamped = host?.getAttribute?.('data-ghd-instance') || '';

    if (!instance) {
      return { healthy: false, reason: 'no-instance' };
    }

    if (!host) {
      return { healthy: false, reason: 'host-missing' };
    }

    if (stamped !== instance) {
      return { healthy: false, reason: 'host-instance-mismatch' };
    }

    return { healthy: true, reason: 'host-instance-match' };
  } catch (error) {
    return { healthy: false, reason: `probe-threw: ${errorText(error)}` };
  }
}

async function injectOpenTab(tab) {
  const files = filesForUrl(tab?.url);
  const location = tabLocation(tab?.url);
  const frames = await targetedFrames(tab?.id);
  const record = {
    id: tab?.id ?? null,
    host: location.host,
    path: location.path,
    healthy: false,
    healthyReason: '',
    executeScript: false,
    files: null,
    result: '',
    frameIds: frames.frameIds,
    pageFrameIds: frames.pageFrameIds,
    world: SCRIPT_WORLD
  };

  if (frames.frameError) {
    record.frameError = frames.frameError;
  }

  if (!files || !tab?.id) {
    record.healthyReason = 'no-match';
    record.result = 'not-injected';
    return record;
  }

  try {
    const probed = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: frames.frameIds },
      world: SCRIPT_WORLD,
      func: extensionCopyIsHealthy
    });
    const verdict = probed?.[0]?.result;

    if (verdict && typeof verdict === 'object') {
      record.healthy = verdict.healthy === true;
      record.healthyReason = String(verdict.reason || '');
    } else {
      record.healthy = false;
      record.healthyReason = 'probe-empty';
    }
  } catch (error) {
    record.healthy = false;
    record.healthyReason = `probe-error: ${errorText(error)}`;
  }

  if (record.healthy) {
    record.result = 'skipped';
    return record;
  }

  record.executeScript = true;
  record.files = files;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: frames.frameIds },
      world: SCRIPT_WORLD,
      files
    });
    record.result = 'ok';
  } catch (error) {
    record.result = errorText(error);
  }

  return record;
}

async function injectMatchingTabs(reason) {
  const entry = {
    time: new Date().toISOString(),
    event: reason || 'startup',
    tabs: []
  };

  let tabs = [];

  try {
    tabs = await chrome.tabs.query({ url: OPEN_TAB_URLS });
  } catch (error) {
    entry.result = errorText(error);
    await recordInjectDebug(entry);
    return entry;
  }

  entry.tabs = await Promise.all((tabs || []).map((tab) => injectOpenTab(tab)));
  await recordInjectDebug(entry);
  return entry;
}

let openTabsInjection = null;

function injectOpenTabs(reason) {
  const event = reason || 'startup';

  if (!openTabsInjection) {
    openTabsInjection = injectMatchingTabs(event).finally(() => {
      openTabsInjection = null;
    });
    return openTabsInjection;
  }

  return openTabsInjection.then((report) => recordInjectDebug({
    time: new Date().toISOString(),
    event,
    tabs: report?.tabs || [],
    note: 'joined an injection already running'
  }));
}

function allowedFetchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    if (url.protocol !== 'https:') {
      return false;
    }

    if (
      host === 'html.duckduckgo.com'
      || host === 'duckduckgo.com'
      || host === 'lite.duckduckgo.com'
    ) {
      return true;
    }

    return (host === 'linkedin.com' || host.endsWith('.linkedin.com'))
      && (url.pathname.includes('/jobs/') || url.pathname.includes('/company/'));
  } catch {
    return false;
  }
}

function usableSearchHtml(url, html) {
  return self.GhdFetch.usablePageHtml(url, html);
}

const tabReadQueues = new Map();
let lastLinkedInTabAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHtmlInTab(url) {
  let host = 'unknown';

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = 'unknown';
  }

  const linkedIn = host === 'linkedin.com' || host.endsWith('.linkedin.com');
  const previous = tabReadQueues.get(host) || Promise.resolve();
  const run = previous.then(async () => {
    if (linkedIn && lastLinkedInTabAt) {
      const wait = 1500 - (Date.now() - lastLinkedInTabAt);

      if (wait > 0) {
        await sleep(wait);
      }
    }

    try {
      return await readHtmlInTabNow(url);
    } finally {
      if (linkedIn) {
        lastLinkedInTabAt = Date.now();
      }
    }
  });

  tabReadQueues.set(host, run.then(() => undefined, () => undefined));
  return run;
}

function readHtmlInTabNow(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tabId = null;

    const finish = (error, html) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);

      if (tabId != null) {
        chrome.tabs.remove(tabId, () => {
          // The tab may already be gone.
          chrome.runtime.lastError;
        });
      }

      if (error) {
        reject(error);
        return;
      }

      resolve(html);
    };

    const finishPage = (error, html) => {
      chrome.tabs.get(tabId, (tab) => {
        const finalUrl = tab?.url || url;

        if (error) {
          error.finalUrl = finalUrl;
        }

        finish(error, { html, finalUrl });
      });
    };

    const timer = setTimeout(() => finish(new Error('TAB_TIMEOUT')), 8000);

    function scrape() {
      chrome.scripting.executeScript({
        target: { tabId },
        func: (mode) => {
          const html = () => document.documentElement?.outerHTML || '';

          if (!mode) {
            return html();
          }

          const ready = () => /employees|followers|open jobs|\d[\d,]*\s+jobs\b/i.test(document.body?.innerText || '');
          const reveal = () => {
            if (mode !== 'company') {
              return;
            }

            const button = [...document.querySelectorAll('button, a')].find((element) => (
              /show more|see more/i.test(element.textContent || '')
            ));
            button?.click();
          };

          if (ready()) {
            reveal();
            return html();
          }

          return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
              if (!ready()) {
                return;
              }

              observer.disconnect();
              reveal();
              setTimeout(() => resolve(html()), 400);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
              observer.disconnect();
              resolve(html());
            }, 4000);
          });
        },
        args: [/\/company\//i.test(url) ? 'company' : '']
      }).then((results) => {
        const html = results?.[0]?.result || '';

        if (self.GhdFetch.isLinkedInBlocked(html)) {
          finishPage(new Error('LINKEDIN_BLOCKED'), html);
          return;
        }

        if (!usableSearchHtml(url, html)) {
          finishPage(new Error('SEARCH_BLOCKED'), html);
          return;
        }

        finishPage(null, html);
      }).catch((error) => finish(error));
    }

    function onUpdated(updatedId, info) {
      if (updatedId !== tabId || info.status !== 'complete') {
        return;
      }

      scrape();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        finish(new Error(chrome.runtime.lastError?.message || 'TAB_FAILED'));
        return;
      }

      tabId = tab.id;

      if (tab.status === 'complete') {
        scrape();
      }
    });
  });
}

async function loadAllowedText(url, options = {}) {
  let sawBlocked = false;
  let fetched = '';
  let status = 0;
  let finalUrl = url;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    status = response.status;
    finalUrl = response.url || url;
    fetched = await response.text();
  } catch {
    // DuckDuckGo answers extension fetch() with 403. A real tab navigation is the fallback.
  }

  if (/duckduckgo\.com/i.test(url) && fetched && self.GhdFetch.hasBotBlock(fetched)) {
    // A refused or captcha page is not a result. A real tab still can be, which is how
    // Glassdoor ratings were loaded when anonymous fetch was blocked.
    fetched = '';

    if (options.skipTab) {
      throw new Error('SEARCH_BLOCKED');
    }
  }

  if (fetched && self.GhdFetch.isLinkedInBlocked(fetched)) {
    sawBlocked = true;
  } else if (fetched && status >= 200 && status < 300 && usableSearchHtml(url, fetched)) {
    console.info('[GHD] fetch', {
      url,
      status,
      finalUrl,
      bytes: fetched.length,
      blocked: false,
      tab: false
    });
    return { text: fetched, status, finalUrl };
  }

  if (options.skipTab) {
    throw new Error(sawBlocked ? 'LINKEDIN_BLOCKED' : 'FETCH_FAILED');
  }

  try {
    const page = await readHtmlInTab(url);
    console.info('[GHD] fetch', {
      url,
      status: 200,
      finalUrl: page.finalUrl,
      bytes: page.html.length,
      ...self.GhdFetch.htmlMarkers(page.html)
    });
    return { text: page.html, status: 200, finalUrl: page.finalUrl || url };
  } catch (error) {
    console.info('[GHD] fetch failed', {
      url,
      error: error.message,
      finalUrl: error.finalUrl || ''
    });

    if (sawBlocked && error.message === 'SEARCH_BLOCKED') {
      throw new Error('LINKEDIN_BLOCKED');
    }

    throw error;
  }
}

const API_BASE_KEY = 'ghd_api_base';
const DEFAULT_API_BASE = 'https://ghost-job-detector-nine.vercel.app';

function storageAdapter() {
  return {
    async get(key) {
      const stored = await chrome.storage.local.get(key);
      return stored[key] || null;
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    }
  };
}

async function apiBase() {
  const stored = await chrome.storage.local.get(API_BASE_KEY);
  const text = String(stored[API_BASE_KEY] || '').trim().replace(/\/$/, '');

  try {
    const url = new URL(text);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) {
      return url.origin;
    }
  } catch {
    return DEFAULT_API_BASE;
  }

  return DEFAULT_API_BASE;
}

async function cachedSearchHtml(query, key, ttlMs) {
  const tools = self.GhdFetch;
  const cache = tools.createHtmlCache(storageAdapter(), ttlMs);
  const cached = await cache.get(key);

  if (cached) {
    return cached;
  }

  for (const engine of tools.searchEngines(query)) {
    try {
      const page = await loadAllowedText(engine.url, { skipTab: false });

      if (page?.text && engine.validator(page.text)) {
        const html = page.text.slice(0, 80000);
        await cache.set(key, html);
        return html;
      }
    } catch (error) {
      console.info('[GHD] search fetch miss', { engine: engine.name, error: error.message });
    }
  }

  return '';
}

function repostStorageKey(body) {
  const slug = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown';

  return `linkedin_repost_v2_${slug(body.company)}_${slug(body.title)}_${slug(body.locationNormalized || body.location)}`;
}

async function repostHtml(body) {
  const title = String(body.title || '').replace(/["<>]/g, '').trim();
  const company = String(body.company || '').replace(/["<>]/g, '').trim();

  if (!title || !company) {
    return '';
  }

  let location = String(body.locationNormalized || body.location || '').replace(/["<>]/g, '').trim();
  const escapedCompany = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (escapedCompany) {
    location = location.replace(new RegExp(`^${escapedCompany}(?![A-Za-z0-9])[\\s·•|–—-]*`, 'i'), '').trim();
  }
  const tools = self.GhdFetch;
  // Same query as repostQuery() in lib/server/reposts.js. Unquoted title,
  // company, and city. The service worker cannot import that module.
  return cachedSearchHtml(
    [title, company, location].filter(Boolean).join(' '),
    repostStorageKey({ ...body, locationNormalized: location }),
    tools.SEARCH_TTL_MS
  );
}

function capHtml(work, limitMs) {
  return Promise.race([
    work,
    new Promise((resolve) => setTimeout(() => resolve(''), limitMs))
  ]);
}

async function enrichJob(message) {
  const body = message.body || {};
  const started = performance.now();
  const base = await apiBase();
  const response = await fetch(`${base}/api/analyze-job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GHD-Client': 'ghost-job-detector'
    },
    body: JSON.stringify({
      ...body,
      deferReposts: true
    }),
    // This abort ends the main check. Reposts are a second request, so this
    // no longer waits on a search-page prefetch. vercel.json maxDuration for
    // api/analyze-job.js is 15s, above this abort. If you raise this number,
    // raise that maxDuration too.
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`API_${response.status}`);
  }

  const analysis = await response.json();
  return {
    ...analysis,
    clientTiming: {
      apiMs: Math.round(performance.now() - started),
      enrichMs: Math.round(performance.now() - started)
    }
  };
}

async function enrichReposts(message) {
  const body = message.body || {};
  const started = performance.now();
  const prefetchStarted = performance.now();
  const reposts = await capHtml(repostHtml(body), 4000).catch(() => '');
  const prefetchMs = Math.round(performance.now() - prefetchStarted);
  const apiStarted = performance.now();
  const base = await apiBase();
  const response = await fetch(`${base}/api/job-reposts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GHD-Client': 'ghost-job-detector'
    },
    body: JSON.stringify({
      ...body,
      clientHtml: { reposts }
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`API_${response.status}`);
  }

  const payload = await response.json();
  return {
    reposts: payload.reposts,
    clientTiming: {
      prefetchReposts: { ms: prefetchMs, bytes: String(reposts || '').length },
      apiMs: Math.round(performance.now() - apiStarted),
      enrichMs: Math.round(performance.now() - started)
    }
  };
}

async function enrichPay(message) {
  const body = message.body || {};
  const base = await apiBase();
  const response = await fetch(`${base}/api/pay-vs-market`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GHD-Client': 'ghost-job-detector'
    },
    body: JSON.stringify({
      title: body.title || '',
      location: body.locationNormalized || body.location || '',
      salary: body.salary || ''
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`API_${response.status}`);
  }

  return response.json();
}

async function enrichCareers(message) {
  const body = message.body || {};
  const base = await apiBase();
  const response = await fetch(`${base}/api/careers-check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GHD-Client': 'ghost-job-detector'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`API_${response.status}`);
  }

  const payload = await response.json();
  return payload.careers || null;
}

async function resolveCompanyIdentity(body) {
  const base = await apiBase();
  const response = await fetch(`${base}/api/company-identity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GHD-Client': 'ghost-job-detector'
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`API_${response.status}`);
  }

  return response.json();
}

async function wikidataJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // Wikimedia asks browser clients to identify themselves with this header.
      'Api-User-Agent': 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)'
    },
    signal: AbortSignal.timeout(8000)
  });

  return {
    status: response.status,
    payload: response.ok ? await response.json() : null
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WIKIDATA_JSON') {
    if (!self.GhdFetch.allowedWikidataUrl(message.url)) {
      sendResponse({ ok: false, error: 'BLOCKED_URL' });
      return true;
    }

    wikidataJson(message.url)
      .then((result) => sendResponse({ ok: result.status >= 200 && result.status < 300, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'FETCH_TEXT') {
    if (!allowedFetchUrl(message.url)) {
      sendResponse({ ok: false, error: 'BLOCKED_URL' });
      return true;
    }

    loadAllowedText(message.url, { skipTab: message.skipTab === true })
      .then((page) => sendResponse({
        ok: true,
        text: page.text,
        status: page.status,
        finalUrl: page.finalUrl
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message,
        finalUrl: error.finalUrl || ''
      }));

    return true;
  }

  if (message.type === 'JOB_DATA_AVAILABLE') {
    currentJob = message.job;
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_CURRENT_JOB') {
    sendResponse(currentJob);
    return true;
  }

  if (message.type === 'ENRICH_JOB') {
    enrichJob(message)
      .then((analysis) => sendResponse({ ok: true, analysis }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'CAREERS_JOB') {
    enrichCareers(message)
      .then((careers) => sendResponse({ ok: true, careers }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'PAY_MARKET') {
    enrichPay(message)
      .then((pay) => sendResponse({ ok: true, pay }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'REPOST_JOB') {
    enrichReposts(message)
      .then((result) => sendResponse({ ok: true, reposts: result.reposts, clientTiming: result.clientTiming }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'RESOLVE_COMPANY_IDENTITY') {
    resolveCompanyIdentity(message.body)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === 'complete' ? tab.url : '');

  if (url) {
    inject(tabId, url);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }

  inject(details.tabId, details.url);
});

chrome.runtime.onSuspend.addListener(() => {
  currentJob = null;
});

chrome.runtime.onInstalled.addListener((details) => {
  const reason = details?.reason || 'installed';

  if (reason === 'install' || reason === 'update') {
    return injectOpenTabs(reason);
  }

  return recordInjectDebug({
    time: new Date().toISOString(),
    event: reason,
    tabs: [],
    note: 'onInstalled did not re-inject open tabs'
  });
});

injectOpenTabs('startup');
