import { companyCacheKey, companyLookupName, mentionsCompanyName } from './companies.js';
import { cacheGet, cacheSet } from './cache.js';
import { openJobsCacheKey, parseAtsBoard } from './open-jobs.js';
import { locationsMatch, normalizeJobLocation } from './location.js';

export { locationsMatch };
import { parseDuckDuckGoHtml } from './search.js';

// A verified second posting is 40: Possible on its own, short of Likely.
// An ATS age inference is 25, the same ceiling as layoffs, and below a
// confirmed duplicate. 25 alone stays Not detected, which is why the confirmed
// tier is not capped there.
export const REPOST_SCORE = 40;
export const SIMILAR_REPOST_SCORE = 15;
export const ATS_REPOST_SCORE = 25;
export const REPOST_CAP = REPOST_SCORE;
export const REPOST_TTL_MS = 24 * 60 * 60 * 1000;

function applyRepostScore(result) {
  if (!result || result.unavailable) {
    return result;
  }

  if ((result.count || 0) >= 1) {
    const score = Number(result.score);
    return {
      ...result,
      score: Math.min(REPOST_CAP, Number.isFinite(score) && score > 0 ? score : SIMILAR_REPOST_SCORE)
    };
  }

  if (Number(result.ageDays) > ATS_STALE_DAYS && result.score > 0) {
    return { ...result, score: ATS_REPOST_SCORE };
  }

  return result;
}
export const ATS_STALE_DAYS = 7;

function sanitizeQueryPart(value) {
  return String(value || '').replace(/["<>]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeLocation(value) {
  return normalizeJobLocation(value).normalized;
}

export function postedAgePhrase(text) {
  const source = String(text || '');
  const match = source.match(/(?:posted|reposted)\s+\d+\s+(?:hour|day|week|month|year)s?\s+ago/i)
    || source.match(/\b\d+\s+(?:hour|day|week|month|year)s?\s+ago\b/i);

  if (match) {
    return match[0].replace(/^(?:posted|reposted)\s+/i, '');
  }

  if (/\byesterday\b/i.test(source)) {
    return '1 day ago';
  }

  if (/\b(just posted|today)\b/i.test(source)) {
    return 'today';
  }

  return '';
}

export function parsePostedAgeDays(text) {
  const source = String(text || '');
  const match = source.match(/(?:posted|reposted)\s+(\d+)\s+(day|week|month)s?\s+ago/i)
    || source.match(/\b(\d+)\s+(day|week|month)s?\s+ago\b/i);

  if (!match) {
    if (/\b(just posted|today|hour ago|hours ago)\b/i.test(source)) {
      return 0;
    }

    if (/\byesterday\b/i.test(source)) {
      return 1;
    }

    return null;
  }

  const count = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('week')) {
    return count * 7;
  }

  if (unit.startsWith('month')) {
    return count * 30;
  }

  return count;
}

const TITLE_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'job', 'jobs', 'hiring', 'linkedin'
]);

function titleTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TITLE_STOP.has(word));
}

// Sixty percent of the role's own words must appear in the result.
// "Senior Data Science Engineer" matches "T-Mobile hiring Senior Data
// Science Engineer in New York, NY | LinkedIn" without requiring the
// whole string to be identical.
// Keep aligned with the title comparison in lib/heuristics.js.
const SENIORITY_WORDS = new Set(['senior', 'staff', 'lead', 'principal', 'junior', 'associate']);

export function comparableTitle(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !SENIORITY_WORDS.has(word))
    .join(' ');
}

export function titleFromLinkedInUrl(url) {
  let slug = '';

  try {
    slug = new URL(String(url || ''), 'https://www.linkedin.com').pathname;
  } catch {
    slug = String(url || '');
  }

  const match = slug.match(/\/jobs\/view\/([^/?#]+)/i) || String(url || '').match(/linkedin\.com\/jobs\/view\/([^/?#]+)/i);
  const decoded = decodeURIComponent(match?.[1] || '').replace(/\/+$/, '');

  if (!decoded || /^\d+$/.test(decoded)) {
    return '';
  }

  const withoutId = decoded.replace(/-\d+$/, '');
  const titleSlug = withoutId.split(/-at-/i)[0];
  return titleSlug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleFromSnippet(title, snippet) {
  const cleaned = `${title || ''} ${snippet || ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[|]\s*linkedin\b.*$/i, '')
    .replace(/\s+-\s+linkedin\b.*$/i, '')
    .trim();
  const hiring = cleaned.match(/\bhiring\s+(.+?)\s+in\b/i);

  if (hiring?.[1]) {
    return hiring[1].trim();
  }

  const at = cleaned.match(/^(.+?)\s+at\s+\S+/i);

  if (at?.[1] && !/^(linkedin|jobs?)$/i.test(at[1].trim())) {
    return at[1].trim();
  }

  return '';
}

// The listing title used for identical-vs-similar. A bare-ID URL with no
// parseable snippet title stays blank, and a blank title is never identical.
export function listingTitle(match) {
  const fromUrl = titleFromLinkedInUrl(match?.url);

  if (fromUrl) {
    return fromUrl;
  }

  const parsed = titleFromSnippet(match?.title, match?.snippet);

  if (parsed) {
    return parsed;
  }

  // A search result that did not parse has no listing title. A stored match
  // has no snippet, and its title is the one saved at match time.
  if (match?.snippet) {
    return '';
  }

  const stored = String(match?.title || '').trim();

  if (stored && !/\b(hiring|linkedin)\b/i.test(stored) && !stored.includes('|')) {
    return stored;
  }

  return '';
}

export function titlesAreIdentical(postingTitle, match) {
  const left = comparableTitle(postingTitle);
  const right = comparableTitle(listingTitle(match));
  return Boolean(left && right && left === right);
}

export function scoreRepostMatches(postingTitle, matches) {
  const list = Array.isArray(matches) ? matches.filter((match) => match?.url) : [];

  if (!list.length) {
    return 0;
  }

  return list.some((match) => titlesAreIdentical(postingTitle, match))
    ? REPOST_SCORE
    : SIMILAR_REPOST_SCORE;
}

export function titlesMatch(jobTitle, resultTitle) {
  const wanted = titleTokens(jobTitle);

  if (wanted.length < 2) {
    return false;
  }

  const haystack = String(resultTitle || '').toLowerCase();
  const hits = wanted.filter((word) => haystack.includes(word));
  return hits.length / wanted.length >= 0.6;
}

function addJobId(ids, value) {
  const id = String(value || '').trim();

  if (/^\d+$/.test(id)) {
    ids.add(id);
  }
}

// Ids from /jobs/view/<slug>-<id>, /jobs/view/<id>, and currentJobId=<id>.
function idsInUrl(url) {
  const ids = new Set();
  const raw = String(url || '').trim();

  if (!raw) {
    return ids;
  }

  try {
    const parsed = new URL(raw, 'https://www.linkedin.com');
    addJobId(ids, parsed.searchParams.get('currentJobId'));
    const view = parsed.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/i);

    if (view) {
      addJobId(ids, view[1]);
    }
  } catch {
    const query = raw.match(/[?&]currentJobId=(\d+)/i);
    const view = raw.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/i);

    if (query) {
      addJobId(ids, query[1]);
    }

    if (view) {
      addJobId(ids, view[1]);
    }
  }

  return ids;
}

function currentIds(job) {
  const ids = idsInUrl(job?.url);
  addJobId(ids, job?.jobId);
  return ids;
}

function canonicalPostingUrl(url) {
  const raw = String(url || '').trim();

  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, 'https://www.linkedin.com');
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const ids = [...idsInUrl(parsed.href)];

    if (/linkedin\.com$/i.test(host) && /\/jobs\/view\//i.test(parsed.pathname) && ids.length) {
      return `https://www.linkedin.com/jobs/view/${ids[0]}`;
    }

    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const current = parsed.searchParams.get('currentJobId');
    const query = current && /^\d+$/.test(current) ? `?currentjobid=${current}` : '';
    return `https://${host}${path}${query}`;
  } catch {
    return raw.split('#')[0].replace(/\/+$/, '').toLowerCase();
  }
}

function samePosting(job, url) {
  const mine = currentIds(job);

  for (const id of idsInUrl(url)) {
    if (mine.has(id)) {
      return true;
    }
  }

  const left = canonicalPostingUrl(job?.url);
  const right = canonicalPostingUrl(url);
  return Boolean(left && right && left === right);
}

function linkedInJobId(url) {
  return [...idsInUrl(url)][0] || '';
}

function isLinkedInJob(url) {
  return /linkedin\.com\/jobs\/view\//i.test(String(url || ''));
}

function platformsMatch(job, url) {
  return isLinkedInJob(url);
}

function jobIsLinkedIn(job) {
  const platform = String(job?.platform || '').trim().toUpperCase();

  if (platform === 'LINKEDIN') {
    return true;
  }

  if (platform) {
    return false;
  }

  return /linkedin\.com\/jobs\//i.test(String(job?.url || ''));
}

// Off LinkedIn, one LinkedIn hit is the same requisition syndicated there.
function minimumLinkedInMatches(job) {
  return jobIsLinkedIn(job) ? 1 : 2;
}

function withRepostThreshold(job, result) {
  if (!result || result.unavailable) {
    return result;
  }

  const matches = (Array.isArray(result.matches) ? result.matches : [])
    .filter((match) => isLinkedInJob(match?.url));

  if (!matches.length) {
    return result;
  }

  if (matches.length >= minimumLinkedInMatches(job)) {
    const posting = matches.length === 1 ? 'posting matches' : 'postings match';

    return {
      ...result,
      score: scoreRepostMatches(job?.title, matches),
      count: matches.length,
      dates: matches.map((match) => match.dateLabel),
      matches,
      available: true,
      unavailable: false,
      detail: `${matches.length} LinkedIn ${posting} this title, company, and location.`
    };
  }

  console.info('[GHD] repost syndication', {
    platform: String(job?.platform || ''),
    url: String(job?.url || ''),
    discarded: matches.map((match) => match.url)
  });

  return {
    ...emptyReposts('No other LinkedIn posting matched this title, company, and location.', false),
    query: result.query || ''
  };
}

function postingLocation(job) {
  return normalizeJobLocation(job?.locationNormalized || job?.location, job?.company).normalized;
}

export function repostQuery(job) {
  const title = sanitizeQueryPart(job?.title);
  const company = sanitizeQueryPart(companyLookupName(job?.company) || job?.company);
  const location = sanitizeQueryPart(postingLocation(job));

  if (!title || !company) {
    return '';
  }

  // Unquoted, and not limited to /jobs/view. Exact phrases plus that
  // site filter missed an older posting of the same role that an ordinary
  // title + company + city search returns on the first page.
  return [title, company, location].filter(Boolean).join(' ');
}

export function repostCacheKey(job) {
  const company = companyCacheKey(job?.company);
  const title = companyCacheKey(job?.title);
  const location = companyCacheKey(postingLocation(job) || 'noloc');

  if (!company || !title) {
    return '';
  }

  // v5 scores an identical title at 40 and any other kept match at 15.
  // v4 drops v3 entries that could hold matches parsed from client HTML.
  // A non-empty client page is parsed even when this key already has a result.
  return `linkedin_repost_v5_${company}_${title}_${location}`;
}

function companySlugs(company) {
  const key = companyCacheKey(company);
  const compact = key.replace(/-/g, '');
  return [...new Set([compact, key].filter(Boolean))].slice(0, 2);
}

function ageDays(timestamp, now) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return Math.floor((now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000));
}

async function readJson(fetchImpl, url, timeoutMs = 4000) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

function atsMatch(job, listing) {
  const title = listing?.title || listing?.text || '';
  const location = listing?.location?.name || listing?.categories?.location || '';
  const text = `${title} ${listing?.company || job?.company || ''} ${location}`;

  return titlesMatch(job?.title, title)
    && mentionsCompanyName(text, job?.company)
    && locationsMatch(postingLocation(job) || job?.location, location);
}

// Each board read gets 1.5s, and they all run at once (Lever took 3.7s to
// answer "mayoclinic", a slug with no board, when these ran one by one at 4s).
export const ATS_AGE_TIMEOUT_MS = 1500;

function atsBoardUrl(board) {
  return board.platform === 'greenhouse'
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs`
    : `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
}

function atsBoardAge(job, board, payload, now) {
  if (board.platform === 'greenhouse') {
    for (const listing of payload?.jobs || []) {
      if (!atsMatch(job, listing)) {
        continue;
      }

      const days = ageDays(listing.first_published || listing.created_at || listing.updated_at, now);

      if (days != null) {
        return { source: 'Greenhouse', ageDays: days, url: listing.absolute_url || '' };
      }
    }

    return null;
  }

  for (const listing of Array.isArray(payload) ? payload : []) {
    if (!atsMatch(job, listing)) {
      continue;
    }

    const days = ageDays(listing.createdAt, now);

    if (days != null) {
      return { source: 'Lever', ageDays: days, url: listing.hostedUrl || '' };
    }
  }

  return null;
}

// What the cached open-roles result already says about this company's boards.
// null: nothing known. []: the guessed slugs had no Greenhouse or Lever board
// (a tier after the direct-slug one answered, and none failed). Otherwise, the
// Greenhouse or Lever board open roles found.
export function atsBoardsFromOpenJobs(cached) {
  if (!cached || cached.higherTierFailed) {
    return null;
  }

  const board = parseAtsBoard(cached.url || '');

  if (board && (board.platform === 'greenhouse' || board.platform === 'lever')
    && (cached.tier === 'direct-token' || cached.tier === 'board-search')) {
    return [board];
  }

  const afterDirectSlugs = ['board-search', 'workday-discovery', 'remembered-workday', 'glassdoor', 'search'];
  return afterDirectSlugs.includes(cached.tier) || cached.miss ? [] : null;
}

export async function lookupAtsAge(job, fetchImpl, now, options = {}) {
  if (!fetchImpl) {
    return null;
  }

  const guessed = companySlugs(job?.company).flatMap((token) => [
    { platform: 'greenhouse', token },
    { platform: 'lever', token }
  ]);
  const read = (board) => readJson(fetchImpl, atsBoardUrl(board), ATS_AGE_TIMEOUT_MS)
    .then((payload) => atsBoardAge(job, board, payload, now), () => null);
  // Same order as before: first slug's Greenhouse, then its Lever, then the next slug.
  const guesses = Promise.all(guessed.map(read)).then((found) => found.find(Boolean) || null);

  if (!options.known) {
    return guesses;
  }

  const known = await Promise.race([options.known.then((boards) => ({ boards }), () => ({ boards: null })), guesses.then(() => null)]);

  if (!known || known.boards == null) {
    return guesses;
  }

  if (!known.boards.length) {
    console.info('[GHD] repost ats age skipped', { company: job?.company || '', reason: 'open roles found no board under these slugs' });
    return null;
  }

  const extra = known.boards.filter((board) => !guessed.some((item) => item.platform === board.platform && item.token === board.token));
  const [fromGuesses, ...fromKnown] = await Promise.all([guesses, ...extra.map(read)]);
  return fromGuesses || fromKnown.find(Boolean) || null;
}

function emptyReposts(detail, unavailable) {
  return {
    score: 0,
    count: 0,
    dates: [],
    ageDays: null,
    query: '',
    closed: false,
    available: !unavailable,
    unavailable,
    skipped: false,
    matches: [],
    detail
  };
}

function listingText(result) {
  return `${result?.title || ''} ${result?.snippet || ''}`;
}

function dropSelfMatches(result, job) {
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  const kept = matches.filter((match) => match?.url && !samePosting(job, match.url));

  if (kept.length === matches.length) {
    return result;
  }

  if (!kept.length) {
    return {
      ...emptyReposts('No other LinkedIn posting matched this title, company, and location.', false),
      query: result?.query || ''
    };
  }

  const posting = kept.length === 1 ? 'posting matches' : 'postings match';

  return {
    ...result,
    score: scoreRepostMatches(job?.title, kept),
    count: kept.length,
    dates: kept.map((match) => match.dateLabel),
    matches: kept,
    detail: `${kept.length} LinkedIn ${posting} this title, company, and location.`
  };
}

function logSelfCheck(job, before, after) {
  const describe = (match) => ({
    url: match?.url || '',
    id: linkedInJobId(match?.url)
  });
  const considered = Array.isArray(before) ? before : [];

  console.info('[GHD] repost self-check', {
    jobId: String(job?.jobId || ''),
    url: String(job?.url || ''),
    currentIds: [...currentIds(job)],
    skipped: considered.filter((match) => samePosting(job, match?.url)).map(describe),
    matches: (after?.matches || []).map(describe)
  });
}

export function matchReposts(job, results) {
  const matches = [];
  const skipped = [];

  for (const result of results || []) {
    const url = String(result?.url || '');
    const text = listingText(result);
    const postedDays = parsePostedAgeDays(text);

    if (!platformsMatch(job, url)) {
      continue;
    }

    if (samePosting(job, url)) {
      skipped.push({ url });
      continue;
    }

    if (!titlesMatch(job?.title, `${result?.title || ''} ${result?.snippet || ''}`)) {
      continue;
    }

    if (!mentionsCompanyName(text, job?.company)) {
      continue;
    }

    if (!locationsMatch(postingLocation(job) || job?.location, text)) {
      continue;
    }

    matches.push({
      url,
      title: listingTitle({ url, title: result.title, snippet: result.snippet }),
      ageDays: postedDays,
      dateLabel: postedAgePhrase(text) || 'Date not shown',
      closed: /no longer accepting/i.test(text)
    });
  }

  const posting = matches.length === 1 ? 'posting matches' : 'postings match';
  const detected = matches.length
    ? {
      score: scoreRepostMatches(job?.title, matches),
      count: matches.length,
      dates: matches.map((match) => match.dateLabel),
      ageDays: matches.find((match) => match.ageDays != null)?.ageDays ?? null,
      query: repostQuery(job),
      closed: matches.some((match) => match.closed),
      available: true,
      unavailable: false,
      skipped: false,
      matches,
      detail: `${matches.length} LinkedIn ${posting} this title, company, and location.`
    }
    : emptyReposts('No other LinkedIn posting matched this title, company, and location.', false);

  logSelfCheck(job, skipped, detected);
  return withRepostThreshold(job, detected);
}

export async function detectReposts(job, deps = {}) {
  const query = repostQuery(job);
  const now = deps.now instanceof Date ? deps.now : new Date();
  const key = repostCacheKey(job);

  if (!query) {
    return emptyReposts('Repost check did not run.', true);
  }

  const clientHtml = String(deps.clientHtml || '').trim();

  // A page the extension just fetched is newer than a stored miss. An empty
  // prefetch still uses the cache, then Tavily.
  if (!clientHtml && deps.cache && key) {
    const cached = await cacheGet(deps.cache, key, now);

    if (cached) {
      console.info('[GHD] cache hit', { key });
      const detected = withRepostThreshold(job, dropSelfMatches(applyRepostScore(cached), job));
      logSelfCheck(job, cached.matches || [], detected);
      return detected;
    }

    console.info('[GHD] cache miss', { key });
  } else if (deps.cache && key) {
    console.info('[GHD] cache miss', { key, reason: 'client html' });
  }

  try {
    // Open roles' cached result, when there is one, says which boards exist.
    const known = deps.cache && job?.company
      ? cacheGet(deps.cache, openJobsCacheKey(job.company), now).then(atsBoardsFromOpenJobs, () => null)
      : null;
    const ats = await lookupAtsAge(job, deps.fetch, now, { known });

    if (ats && ats.ageDays > ATS_STALE_DAYS) {
      const detected = {
        ...emptyReposts(`${ats.source} created this posting ${ats.ageDays} days ago.`, false),
        score: ATS_REPOST_SCORE,
        ageDays: ats.ageDays,
        query,
        matches: ats.url ? [{ url: ats.url, title: job.title, ageDays: ats.ageDays, dateLabel: `${ats.ageDays} days ago` }] : []
      };

      if (deps.cache && key) {
        await cacheSet(deps.cache, key, detected, REPOST_TTL_MS, now);
      }

      return detected;
    }

    const results = clientHtml
      ? parseDuckDuckGoHtml(clientHtml)
      : await deps.webSearch(query, { timeoutMs: 6000 });
    console.info('[GHD] repost search results', {
      company: job?.company || '',
      query,
      source: clientHtml ? 'clientHtml' : 'tavily',
      count: Array.isArray(results) ? results.length : 0,
      urls: (Array.isArray(results) ? results : []).map((item) => item?.url || '')
    });
    const detected = { ...matchReposts(job, results), query };

    // Matches parsed from the requester's own HTML answer that request only.
    // Anyone can send that HTML, so it never becomes the shared entry.
    if (deps.cache && key && !clientHtml) {
      await cacheSet(deps.cache, key, detected, REPOST_TTL_MS, now);
    }

    return detected;
  } catch {
    return { ...emptyReposts('Repost search did not return results.', true), query };
  }
}
