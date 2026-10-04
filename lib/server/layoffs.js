import { cacheGet, cacheSet } from './cache.js';
import { companyCacheKey, companyQueries, mentionsCompanyName } from './companies.js';
import { parseDuckDuckGoHtml } from './search.js';
import { companyIdentityNames } from './employees.js';

const LAYOFF_PATTERN = /\b(layoffs?|laid off|lays off|laying off|job cuts|workforce reduction|redundanc(?:y|ies)|downsiz(?:e|ing)|cutting jobs)\b/i;
const TEMPLATE_TITLE_PATTERN = /layoff signals guide|job security checklist/i;
const BLOCKED_SOURCES = new Set([
  'claveprep.com'
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const LAYOFFS_FYI_ORIGIN = 'https://layoffs-fyi.onrender.com';
const LAYOFFS_FYI_TIMEOUT_MS = 6000;
const LAYOFFS_FYI_TTL_MS = 7 * DAY_MS;
const LAYOFFS_FYI_MISS_TTL_MS = DAY_MS;

function isBlockedSource(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return BLOCKED_SOURCES.has(host);
  } catch {
    return false;
  }
}

export function parseArticleDate(value, now = new Date(), url = '') {
  const text = String(value || '').trim();

  if (text && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/.test(text) && text.length <= 40) {
    const withTime = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    const normalized = withTime
      ? `${withTime[1]}T${withTime[2]}Z`
      : `${text.slice(0, 10)}T00:00:00Z`;
    const parsed = Date.parse(normalized);

    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  if (text) {
    const monthPattern = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}(?!\d)/gi;
    const monthMatches = [...text.matchAll(monthPattern)];

    if (monthMatches.length) {
      const parsed = Date.parse(monthMatches.at(-1)[0]);

      if (!Number.isNaN(parsed)) {
        return new Date(parsed);
      }
    }
  }

  const urlMonthMatch = String(url || '').match(/\/(\d{4})\/(\d{1,2})\//);

  if (urlMonthMatch) {
    return dateFromParts(Number(urlMonthMatch[1]), Number(urlMonthMatch[2]), 1, now);
  }

  const urlYearMatch = String(url || '').match(/\/(\d{4})\/(?!\d)/);
  const namedMonth = text ? monthMention(text) : null;

  if (urlYearMatch && namedMonth) {
    return dateFromParts(Number(urlYearMatch[1]), namedMonth.month, namedMonth.day, now);
  }

  return null;
}

function monthMention(text) {
  const pattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{1,2}))?\b/g;
  const mentions = [...String(text).matchAll(pattern)];
  const mention = mentions.at(-1);

  if (!mention) {
    return null;
  }

  const key = mention[1].toLowerCase().slice(0, 3);
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(key) + 1;
  const day = mention[2] ? Number(mention[2]) : 1;

  if (month < 1 || day < 1 || day > 31) {
    return null;
  }

  return { month, day };
}

function dateFromParts(year, month, day, now) {
  if (year < 2020 || year > now.getFullYear() || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getTime() > now.getTime()
  ) {
    return null;
  }

  return parsed;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when the posting itself uses the short form as a name: capitalized,
// mid-sentence, not right after the rest of the company name ("On Location"),
// and not a field label ("Location: Remote").
export function postingUsesShortName(description, shortForm, fullName) {
  const text = String(description || '');
  const word = String(shortForm || '').trim();

  if (!text || !word) {
    return false;
  }

  const fullWords = String(fullName || '').toLowerCase().split(/\s+/).filter(Boolean);
  const before = fullWords[fullWords.indexOf(word.toLowerCase()) - 1] || '';
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi');
  let match = pattern.exec(text);

  while (match) {
    const found = match[0];
    const lead = text.slice(Math.max(0, match.index - 40), match.index);
    const tail = text.slice(match.index + found.length);
    const capitalized = /^[A-Z]/.test(found);
    const sentenceStart = /(?:^|[.!?:;\n])\s*$/.test(lead);
    const afterRestOfName = Boolean(before) && new RegExp(`\\b${escapeRegExp(before)}\\s+$`, 'i').test(lead);
    const fieldLabel = /^\s*:/.test(tail);

    if (capitalized && !sentenceStart && !afterRestOfName && !fieldLabel) {
      return true;
    }

    match = pattern.exec(text);
  }

  return false;
}

// companyQueries() adds the last word of a multi-word name as a short form, so
// "On Location" also searched and matched the plain word "location". A one-word
// short form is kept only when it is grounded: Wikidata records it as this
// company's own label or alias ("Disney" for The Walt Disney Company), or the
// posting itself uses it as the company's name ("At Supernal, we...").
export async function groundedCompanyQueries(company, deps = {}) {
  const queries = companyQueries(company);
  const multiWord = (queries[0] || '').split(' ').length > 1;
  const isShortForm = (query) => multiWord && query.split(' ').length === 1;

  if (!queries.some(isShortForm)) {
    return queries;
  }

  const identity = await companyIdentityNames(company, deps);
  const compact = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const grounded = new Set((identity.names || []).map(compact));
  const kept = queries.filter((query) => (
    !isShortForm(query)
    || grounded.has(compact(query))
    || postingUsesShortName(deps.description, query, queries[0])
  ));
  const dropped = queries.filter((query) => !kept.includes(query));

  if (dropped.length) {
    console.info('[GHD] layoff name variants dropped', { company, dropped, reason: 'not a Wikidata name for this company or used alone in the posting' });
  }

  return kept;
}

export function articleMatchesCompany(company, article, names) {
  const title = String(article?.title || '');
  const body = String(article?.description || article?.snippet || '');
  const text = `${title}\n${body}`;

  if (!LAYOFF_PATTERN.test(text)) {
    return null;
  }

  const titleHit = mentionsCompanyName(title, company, { queries: names });

  if (titleHit) {
    return { query: titleHit, where: 'title' };
  }

  const bodyHit = mentionsCompanyName(text, company, { allowShort: false, queries: names });

  if (bodyHit) {
    return { query: bodyHit, where: 'body' };
  }

  return null;
}

export function selectLayoffs(company, articles, now = new Date(), names) {
  const matches = [];

  for (const article of articles || []) {
    if (isBlockedSource(article.url) || TEMPLATE_TITLE_PATTERN.test(article.title)) {
      continue;
    }

    const match = articleMatchesCompany(company, article, names);

    if (!match) {
      continue;
    }

    const dated = datedLayoff(
      parseArticleDate(article.publishedAt || article.date || '', now, article.url)
        || parseArticleDate(`${article.title || ''} ${article.snippet || article.description || ''}`, now, article.url),
      now
    );

    if (!dated) {
      continue;
    }

    matches.push({
      title: article.title || '',
      url: article.url || '',
      snippet: String(article.snippet || article.description || ''),
      date: dated.date,
      source: article.source || null,
      matchedOn: match.query,
      timestamp: dated.timestamp,
      score: dated.score
    });
  }

  matches.sort((left, right) => right.timestamp - left.timestamp);

  if (!matches.length) {
    return {
      detected: false,
      score: 0,
      date: null,
      headline: null,
      url: null,
      matches: []
    };
  }

  const newest = matches[0];

  return {
    detected: true,
    score: newest.score,
    date: newest.date,
    headline: newest.title,
    url: newest.url,
    matches: matches.slice(0, 3).map(({ timestamp, ...match }) => match)
  };
}

function datedLayoff(date, now) {
  if (!date) {
    return null;
  }

  const ageMs = now.getTime() - date.getTime();

  if (ageMs < (-2 * DAY_MS) || ageMs > (365 * DAY_MS)) {
    return null;
  }

  return {
    date: date.toISOString().slice(0, 10),
    timestamp: date.getTime(),
    score: (ageMs / DAY_MS) <= 180 ? 25 : 15
  };
}

function layoffSlugs(company, names) {
  const slugs = [];

  for (const query of (names || companyQueries(company)).slice(0, 2)) {
    const slug = query.replace(/\s+/g, '-');

    if (slug && !slugs.includes(slug)) {
      slugs.push(slug);
    }
  }

  return slugs;
}

function eventHeadline(event) {
  const count = event.count ? `${event.count.toLocaleString()} employees` : 'Layoffs';
  const percent = event.percent != null ? ` (${Math.round(event.percent * 100)}%)` : '';
  return `${count}${percent} laid off`;
}

function layoffFyiKey(company) {
  // v2: v1 entries could come from a bare-word slug such as "location".
  return `layoffs:fyi:v2:${companyCacheKey(company)}`;
}

async function fyiFetch(url, deps) {
  const timeoutMs = deps.layoffFyiTimeoutMs || LAYOFFS_FYI_TIMEOUT_MS;
  const doFetch = deps.fetch || fetch;

  try {
    return await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return null;
  }
}

export async function fetchLayoffsFyiPage(company, deps) {
  for (const slug of layoffSlugs(company, deps?.layoffNames)) {
    const response = await fyiFetch(
      `${LAYOFFS_FYI_ORIGIN}/api/company/${encodeURIComponent(slug)}`,
      deps
    );

    if (!response) {
      return null;
    }

    if (response.status === 404) {
      continue;
    }

    if (!response.ok) {
      return null;
    }

    try {
      const body = await response.json();
      return body && typeof body === 'object' ? body : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function fetchEventDescription(company, event, deps) {
  if (!event?.source) {
    return '';
  }

  const response = await fyiFetch(
    `${LAYOFFS_FYI_ORIGIN}/api/event-description?url=${encodeURIComponent(event.source)}&company=${encodeURIComponent(company)}`,
    deps
  );

  if (!response?.ok) {
    return '';
  }

  try {
    const body = await response.json();
    return String(body?.description || '').trim();
  } catch {
    return '';
  }
}

function selectFyiEvents(events, now) {
  const matches = [];

  for (const event of events || []) {
    const dated = datedLayoff(parseArticleDate(event?.date, now), now);

    if (!dated) {
      continue;
    }

    matches.push({ event, ...dated });
  }

  matches.sort((left, right) => right.timestamp - left.timestamp);
  return matches;
}

async function lookupLayoffsFyi(company, deps) {
  const now = deps.now || new Date();
  const key = layoffFyiKey(company);

  if (deps.cache) {
    const cached = await cacheGet(deps.cache, key, now);

    if (cached?.result) {
      return cached.result;
    }

    if (cached?.miss || cached?.empty) {
      return null;
    }
  }

  const page = await fetchLayoffsFyiPage(company, deps);

  if (!page) {
    if (deps.cache) {
      await cacheSet(deps.cache, key, { miss: true }, LAYOFFS_FYI_MISS_TTL_MS, now);
    }

    return null;
  }

  const matches = selectFyiEvents(page.events, now);

  if (!matches.length) {
    if (deps.cache) {
      await cacheSet(deps.cache, key, { empty: true }, LAYOFFS_FYI_TTL_MS, now);
    }

    return null;
  }

  for (const match of matches.slice(0, 3)) {
    const description = await fetchEventDescription(company, match.event, deps);
    const headline = description || eventHeadline(match.event);
    const article = {
      title: headline,
      snippet: description,
      url: match.event.source || ''
    };

    if (typeof deps.askGroq === 'function') {
      const relevant = await verifyLayoffRelevance(company, article, deps);

      if (!relevant) {
        continue;
      }
    }

    const result = {
      detected: true,
      score: match.score,
      unavailable: false,
      date: match.date,
      headline,
      detail: headline,
      url: match.event.source || '',
      source: 'layoffs.fyi',
      matches: [{
        title: headline,
        snippet: description,
        url: match.event.source || '',
        date: match.date,
        score: match.score,
        source: 'layoffs.fyi',
        matchedOn: 'layoffs.fyi'
      }]
    };

    if (deps.cache) {
      await cacheSet(deps.cache, key, { result }, LAYOFFS_FYI_TTL_MS, now);
    }

    return result;
  }

  if (deps.cache) {
    await cacheSet(deps.cache, key, { empty: true }, LAYOFFS_FYI_MISS_TTL_MS, now);
  }

  return null;
}

function layoffVerifyKey(company, article) {
  const articleKey = companyCacheKey(article?.url || article?.title || '');
  return `layoff-verify:v1:${companyCacheKey(company)}:${articleKey}`;
}

function verdictWord(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)[0]
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

export async function verifyLayoffRelevance(company, article, deps = {}) {
  if (typeof deps.askGroq !== 'function') {
    return true;
  }

  const now = deps.now || new Date();
  const key = layoffVerifyKey(company, article);

  if (deps.cache && key) {
    const cached = await cacheGet(deps.cache, key, now);

    if (cached?.relevant === true) {
      return true;
    }

    if (cached?.relevant === false) {
      return false;
    }
  }

  let text = '';

  try {
    text = await deps.askGroq(
      `Company: ${company}. Article title: ${article?.title || ''}. Snippet: ${article?.snippet || article?.description || ''}. Does this article report that ${company} itself had layoffs, or does it just mention ${company} while reporting on a different company? Answer only YES or NO.`,
      { env: deps.env, fetch: deps.fetch, timeoutMs: 4000, temperature: 0 }
    );
  } catch {
    // A Groq outage fails closed. An unverified article is the false-positive
    // case this gate exists to stop, so a timeout is treated as NO.
    return false;
  }

  const word = verdictWord(text);

  if (word !== 'YES' && word !== 'NO') {
    return true;
  }

  const relevant = word === 'YES';

  if (deps.cache && key) {
    await cacheSet(
      deps.cache,
      key,
      { relevant },
      relevant ? LAYOFFS_FYI_TTL_MS : LAYOFFS_FYI_MISS_TTL_MS,
      now
    );
  }

  return relevant;
}

async function confirmLayoffSelection(company, selection, deps) {
  if (!selection?.detected || typeof deps?.askGroq !== 'function') {
    return selection;
  }

  const candidates = selection.matches?.length
    ? selection.matches
    : [{
      title: selection.headline || '',
      snippet: selection.detail || selection.headline || '',
      url: selection.url || '',
      date: selection.date,
      score: selection.score
    }];

  for (const candidate of candidates) {
    const relevant = await verifyLayoffRelevance(company, candidate, deps);

    if (relevant) {
      return {
        ...selection,
        detected: true,
        score: candidate.score || selection.score,
        date: candidate.date || selection.date,
        headline: candidate.title || selection.headline,
        url: candidate.url || selection.url
      };
    }
  }

  return {
    detected: false,
    score: 0,
    date: null,
    headline: null,
    url: null,
    source: selection.source || null,
    matches: []
  };
}

function emptyLayoff(unavailable, source = null) {
  return {
    detected: false,
    score: 0,
    unavailable,
    date: null,
    headline: null,
    url: null,
    source,
    matches: []
  };
}

export async function detectLayoffs(company, deps) {
  const now = deps.now || new Date();
  const queries = (await groundedCompanyQueries(company, deps)).slice(0, 2);

  if (!queries.length) {
    return emptyLayoff(false, null);
  }

  // layoffs.fyi can take its full timeout (it sleeps between requests), so the
  // other sources start at the same time. Results are still taken in the old
  // order: layoffs.fyi, then NewsData, then the search page or web search, each
  // confirmed the same way. The cost is NewsData and web calls that layoffs.fyi
  // may make unnecessary.
  const settle = (work) => Promise.resolve().then(work).then((value) => ({ value }), (error) => ({ error }));
  const hasClientHtml = Boolean(String(deps.clientHtml || '').trim());
  const fyiLookup = settle(() => lookupLayoffsFyi(company, { ...deps, layoffNames: queries }));
  const newsLookup = settle(() => deps.searchNews(`${queries[queries.length - 1]} layoffs`));
  // Every name variant is searched at once; results are still taken in the
  // original order, and the first confirmed match wins as before.
  const searches = hasClientHtml
    ? []
    : [...queries].reverse().map((term) => settle(() => deps.webSearch(`${term} layoffs`)));

  const fyi = await fyiLookup;

  if (fyi.error) {
    throw fyi.error;
  }

  const fromFyi = fyi.value;

  if (fromFyi?.detected) {
    return fromFyi;
  }

  const news = await newsLookup;
  const newsFailed = Boolean(news.error);
  const newsArticles = news.error ? [] : news.value;

  const fromNews = await confirmLayoffSelection(company, selectLayoffs(company, newsArticles, now, queries), deps);

  if (fromNews.detected) {
    return {
      ...fromNews,
      unavailable: false,
      source: 'newsdata'
    };
  }

  if (hasClientHtml) {
    const fromClient = await confirmLayoffSelection(
      company,
      selectLayoffs(company, parseDuckDuckGoHtml(deps.clientHtml), now, queries),
      deps
    );

    if (fromClient.detected) {
      return {
        ...fromClient,
        unavailable: false,
        source: 'duckduckgo'
      };
    }

    // The extension already fetched the search page. Another datacenter search
    // usually times out and can hit the function limit before a response is sent.
    return emptyLayoff(newsFailed, newsFailed ? null : 'newsdata');
  }

  let webFailed = true;
  const webArticles = [];

  for (const pending of searches) {
    try {
      const outcome = await pending;

      if (outcome.error) {
        throw outcome.error;
      }

      const rows = outcome.value;
      webFailed = false;
      webArticles.push(...rows);
      const attempt = await confirmLayoffSelection(company, selectLayoffs(company, webArticles, now, queries), deps);

      if (attempt.detected) {
        return {
          ...attempt,
          unavailable: false,
          source: 'duckduckgo'
        };
      }
    } catch {
      // Try the next company name.
    }
  }

  if (newsFailed && webFailed) {
    return emptyLayoff(true, null);
  }

  const fromWeb = await confirmLayoffSelection(company, selectLayoffs(company, webArticles, now, queries), deps);

  if (fromWeb.detected) {
    return {
      ...fromWeb,
      unavailable: false,
      source: 'duckduckgo'
    };
  }

  return emptyLayoff(false, newsFailed ? 'duckduckgo' : 'newsdata');
}
