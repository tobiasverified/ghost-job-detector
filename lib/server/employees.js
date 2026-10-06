import { cacheGet, cacheSet } from './cache.js';
import { companyLookupName } from './companies.js';

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WIKIDATA_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'GhostJobDetector/1.1 (https://ghost-job-detector-nine.vercel.app)'
};

// v3: v1/v2 entries could hold counts cited from another company's page or a contact database.
function searchCacheKey(company) {
  return `employee_search_v3_${String(company || '').trim().toLowerCase()}`;
}

// Legal-form words that never distinguish one employer from another.
const FILLER_WORDS = new Set([
  'the', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'co', 'corp',
  'corporation', 'company', 'plc', 'sa', 'ag', 'gmbh', 'nv'
]);

// Words a listed company's legal name may add to its brand ("Capital One Financial").
// They are accepted only when the result also carries the company's own stock ticker.
const DESIGNATION_WORDS = new Set([
  'financial', 'bancorp', 'bancshares', 'holdings', 'holding', 'group', 'international',
  'industries', 'enterprises', 'technologies', 'brands', 'worldwide', 'global'
]);

// Title text after the subject: "X Number of Employees 2026", "X Careers and Benefits".
const TITLE_DESCRIPTOR = /\s+(?:number of employees|employees?|employee count|headcount|staff|careers?|jobs?|company profile|profile|information|info|reviews?|salaries|overview|about)\b.*$/i;
const TITLE_PREFIX = /^(?:working at|careers at|jobs at|about)\s+/i;

const SLUG_DESCRIPTOR_WORDS = new Set([
  'employees', 'employee', 'count', 'headcount', 'number', 'of', 'staff', 'careers', 'career',
  'jobs', 'job', 'reviews', 'review', 'salaries', 'profile', 'overview', 'about', 'company', 'info'
]);

function nameWords(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) || [];
}

function coreWords(value) {
  return nameWords(value).filter((word) => !FILLER_WORDS.has(word));
}

function core(value) {
  return coreWords(value).join('');
}

export function resultSubject(title) {
  const lead = String(title || '').split(/\s+[|–—-]\s+|:\s+/)[0] || '';
  return lead.replace(TITLE_PREFIX, '').replace(TITLE_DESCRIPTOR, '').trim();
}

function tickerCited(text, tickers) {
  return tickers.some((ticker) => {
    const symbol = String(ticker || '').replace(/[^A-Za-z0-9.]/g, '');
    return symbol && new RegExp(`(?:\\(|\\|\\s*|(?:NYSE|NASDAQ|Nasdaq)\\s*:\\s*)${symbol.replace('.', '\\.')}\\b`).test(text);
  });
}

// Contact databases list how many profiles they hold for a company ("1,039 on
// RocketReach"), which reads like a headcount but is not one.
const CONTACT_DATABASE_HOSTS = /(?:^|\.)(?:rocketreach\.co|zoominfo\.com|apollo\.io|signalhire\.com|contactout\.com|leadiq\.com|lusha\.com|seamless\.ai|adapt\.io|datanyze\.com)$/i;

// A result counts only when the page is about this company, not a subsidiary or
// namesake that merely contains its name ("University of Miami Healt[h System]").
export function searchResultMatchesCompany(result, identity) {
  const names = [identity?.company, ...(identity?.names || [])].filter(Boolean);
  const allowed = new Set(names.map(core).filter(Boolean));
  const tickers = identity?.tickers || [];
  const subject = resultSubject(result?.title);
  const subjectCore = core(subject);
  const text = `${result?.title || ''} ${result?.snippet || ''}`;
  let accepted = allowed.has(subjectCore);

  if (!accepted && subjectCore) {
    const subjectList = coreWords(subject);
    accepted = names.some((name) => {
      const base = coreWords(name);
      const extra = subjectList.slice(base.length);
      return base.length > 0
        && extra.length > 0
        && base.every((word, index) => subjectList[index] === word)
        && extra.every((word) => DESIGNATION_WORDS.has(word));
    }) && tickerCited(text, tickers);
  }

  if (!accepted) {
    return { ok: false, reason: 'title subject is not this company', subject };
  }

  const acceptable = new Set([...allowed, subjectCore]);
  let path = '';

  let host = '';

  try {
    const parsed = new URL(result.url);
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, reason: 'unreadable url', subject };
  }

  if (CONTACT_DATABASE_HOSTS.test(host)) {
    return { ok: false, reason: 'contact database count, not a headcount', subject };
  }

  for (const segment of path.split('/')) {
    const words = coreWords(segment.replace(/\.[a-z]+$/i, ''));

    // "acme-employees", "acme-322351" and "acme-profile_b5c4" describe Acme; "university-of-miami-healt" does not.
    while (words.length > 1 && (SLUG_DESCRIPTOR_WORDS.has(words[words.length - 1]) || /\d/.test(words[words.length - 1]))) {
      words.pop();
    }

    const segmentCore = words.join('');
    const namesThisCompany = [...allowed].some((name) => name.length >= 4 && segmentCore.includes(name));

    if (namesThisCompany && !acceptable.has(segmentCore)) {
      return { ok: false, reason: 'url names a different entity', subject, segment };
    }
  }

  return { ok: true, subject };
}

async function wikidataJson(url, deps) {
  const response = await deps.fetch(url, {
    headers: WIKIDATA_HEADERS,
    signal: AbortSignal.timeout(6000)
  });

  // A rate-limited or failed lookup throws, so it is not cached as "no identity".
  if (!response.ok) {
    throw new Error(`Wikidata request failed (${response.status})`);
  }

  return response.json();
}

// The names and tickers Wikidata records for this exact company. The top search hit is
// used only when its label or an alias is the name being looked up.
export async function companyIdentityNames(company, deps = {}) {
  const name = String(company || '').trim();
  const fallback = { company: name, names: [], tickers: [] };

  if (!name || typeof deps.fetch !== 'function') {
    return fallback;
  }

  const key = `wikidata_identity_v1_${name.toLowerCase()}`;
  const cached = deps.cache ? await cacheGet(deps.cache, key, deps.now || new Date()) : null;

  if (cached && Array.isArray(cached.names)) {
    return { ...cached, company: name };
  }

  try {
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    searchUrl.searchParams.set('action', 'wbsearchentities');
    const lookup = companyLookupName(name) || name;
    searchUrl.searchParams.set('search', lookup);
    searchUrl.searchParams.set('language', 'en');
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('limit', '1');
    searchUrl.searchParams.set('origin', '*');
    const id = (await wikidataJson(searchUrl, deps))?.search?.[0]?.id;
    let identity = fallback;

    if (id) {
      const entityUrl = new URL('https://www.wikidata.org/w/api.php');
      entityUrl.searchParams.set('action', 'wbgetentities');
      entityUrl.searchParams.set('ids', id);
      entityUrl.searchParams.set('props', 'labels|aliases|claims');
      entityUrl.searchParams.set('languages', 'en');
      entityUrl.searchParams.set('format', 'json');
      entityUrl.searchParams.set('origin', '*');
      const entity = (await wikidataJson(entityUrl, deps))?.entities?.[id];
      const names = [entity?.labels?.en?.value, ...(entity?.aliases?.en || []).map((alias) => alias?.value)]
        .filter(Boolean);

      if (names.some((candidate) => core(candidate) === core(lookup))) {
        const tickers = (entity?.claims?.P414 || [])
          .flatMap((claim) => claim?.qualifiers?.P249 || [])
          .map((qualifier) => qualifier?.datavalue?.value)
          .filter((value) => typeof value === 'string' && value);
        identity = { company: name, id, names, tickers: [...new Set(tickers)] };
      }
    }

    if (deps.cache) {
      await cacheSet(deps.cache, key, identity, IDENTITY_TTL_MS, deps.now || new Date());
    }

    return identity;
  } catch {
    return fallback;
  }
}

function formatCount(value) {
  return Math.round(value).toLocaleString('en-US');
}

function groundedEmployeeCount(text, results) {
  const raw = String(text || '').trim();

  if (!raw || /^UNKNOWN\b/i.test(raw)) {
    return null;
  }

  const mentioned = [...raw.matchAll(/\d[\d,]*/g)]
    .map((match) => Number(match[0].replace(/,/g, '')))
    .filter((count) => Number.isFinite(count) && count >= 10);

  for (const count of mentioned) {
    const needle = String(count);
    const source = results.find((item) => {
      const hay = `${item?.title || ''} ${item?.snippet || ''}`.replace(/,/g, '');
      return hay.includes(needle);
    });

    if (source?.url) {
      return {
        employees: count,
        employeeLabel: formatCount(count),
        source: 'search',
        sourceUrl: source.url
      };
    }
  }

  return null;
}

function snippetBlock(results) {
  return results.slice(0, 5).map((item, index) => {
    return `${index + 1}. ${item.title || ''} ${item.snippet || ''} (${item.url || ''})`.trim();
  }).join('\n');
}

export async function findEmployeeCountBySearch(company, deps = {}) {
  const name = String(company || '').replace(/["<>]/g, '').trim();

  if (!name || typeof deps.askGroq !== 'function') {
    return null;
  }

  const now = deps.now || new Date();
  const key = searchCacheKey(name);

  if (deps.cache) {
    const cached = await cacheGet(deps.cache, key, now);

    if (cached?.miss) {
      return null;
    }

    if (typeof cached?.employees === 'number' && cached.sourceUrl) {
      return cached;
    }
  }

  let results = [];
  // Independent of the search, so it runs while the search is in flight.
  // companyIdentityNames never throws; it falls back to no names.
  const identityPromise = companyIdentityNames(name, deps);

  try {
    const search = deps.webSearch;
    results = search ? await search(`"${companyLookupName(name) || name}" number of employees`) : [];
  } catch (error) {
    console.info('[GHD] employee search results', {
      company: name,
      resultCount: 0,
      error: error?.message || 'search failed'
    });
    return null;
  }

  const returned = (Array.isArray(results) ? results : []).filter((item) => item?.url && (item.title || item.snippet));
  const identity = await identityPromise;
  const usable = [];
  const rejected = [];

  for (const item of returned) {
    const verdict = searchResultMatchesCompany(item, identity);

    if (verdict.ok) {
      usable.push(item);
    } else {
      rejected.push({ url: item.url, subject: verdict.subject, reason: verdict.reason });
    }
  }

  console.info('[GHD] employee search results', {
    company: name,
    resultCount: returned.length,
    verifiedCount: usable.length,
    identityNames: identity.names,
    tickers: identity.tickers,
    titles: usable.slice(0, 5).map((item) => item.title || '')
  });

  if (rejected.length) {
    console.info('[GHD] employee search rejected', { company: name, rejected });
  }

  if (!usable.length) {
    // Remembered so the same off-target results are not searched and rejected again.
    if (returned.length && deps.cache) {
      await cacheSet(deps.cache, key, { miss: true, rejected: rejected.map((item) => item.url) }, SEARCH_TTL_MS, now);
    }

    return null;
  }

  let text = '';

  try {
    text = await deps.askGroq(
      `Given these search results about ${name}, do any state a genuine, current employee count? If yes, what is the number and which result stated it? If none clearly state one, respond UNKNOWN.\n\n${snippetBlock(usable)}`,
      { env: deps.env, fetch: deps.fetch, timeoutMs: 4000, temperature: 0 }
    );
  } catch {
    return null;
  }

  const found = groundedEmployeeCount(text, usable);
  console.info('[GHD] employee search groq', {
    company: name,
    answer: String(text || '').slice(0, 300),
    employees: found?.employees ?? null,
    sourceUrl: found?.sourceUrl || null
  });

  if (deps.cache) {
    await cacheSet(deps.cache, key, found || { miss: true }, SEARCH_TTL_MS, now);
  }

  return found;
}
