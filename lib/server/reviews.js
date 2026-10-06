import { mentionsCompanyName, shorterCompanyNames } from './companies.js';
import { glassdoorEntityMatches } from './company-rating.js';
import { parseDuckDuckGoHtml } from './search.js';

const RATING_PATTERNS = [
  /(\d(?:\.\d{1,2})?)\s*(?:\/\s*5|out of 5(?:\s+stars?)?|\bof\s+5)\b/i,
  /\brating of\s+(\d(?:\.\d{1,2})?)\b/i,
  /\b(\d(?:\.\d{1,2})?)\s*stars?\b/i
];

// A handful of reviews is not enough to treat the rating as a signal.
const MIN_SCORED_REVIEWS = 5;

export function scoreRating(rating, reviewCount) {
  const count = Number(reviewCount);

  if (reviewCount != null && reviewCount !== '' && Number.isFinite(count) && count < MIN_SCORED_REVIEWS) {
    return 0;
  }

  if (!Number.isFinite(rating)) {
    return 0;
  }

  if (rating <= 3) {
    return 15;
  }

  if (rating <= 3.5) {
    return 10;
  }

  if (rating <= 3.8) {
    return 4;
  }

  return 0;
}

// Employee-review sites. Customer-review hosts (Trustpilot, Yelp, Google,
// Tripadvisor, BBB) are not a source for this factor, and neither is an
// unrecognized host: platformFromUrl used to accept those.
const EMPLOYER_REVIEW_HOSTS = [
  ['glassdoor.', 'Glassdoor'],
  ['indeed.', 'Indeed'],
  ['simplyhired.', 'SimplyHired'],
  ['comparably.', 'Comparably']
];

export function platformFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const match = EMPLOYER_REVIEW_HOSTS.find(([needle]) => host.includes(needle));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function parseReviewSnippet(result) {
  const text = `${result?.title || ''} ${result?.snippet || ''}`;
  let rating = null;

  for (const pattern of RATING_PATTERNS) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const value = Number(match[1]);

    if (Number.isFinite(value) && value >= 1 && value <= 5) {
      rating = value;
      break;
    }
  }

  if (rating == null) {
    const stars = text.match(/[★☆]{3,5}/);

    if (stars) {
      const filled = (stars[0].match(/★/g) || []).length;
      const total = stars[0].length;

      if (filled > 0 && total <= 5) {
        rating = Math.round((filled / total) * 50) / 10;
      }
    }
  }

  if (rating == null) {
    return null;
  }

  const countMatch = text.match(/([\d,]{1,})\s+(?:[a-z]+\s+){0,3}reviews?\b/i);
  const reviewCount = countMatch
    ? Number(countMatch[1].replace(/,/g, ''))
    : null;

  return {
    rating,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null
  };
}

function companyReviewPage(url) {
  try {
    return /\/Reviews\/[^/]+-Reviews-E\d+\.htm$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// A company reviews page and a jobs snippet are not comparable: the jobs
// snippet can parse a larger count off a role filter. Counts are compared
// only after both pages are the same kind.
function reviewPageKind(url) {
  if (companyReviewPage(url)) {
    return 'reviews';
  }

  let path = '';

  try {
    path = new URL(String(url || '')).pathname;
  } catch {
    return 'other';
  }

  if (/\/cmp\/[^/]+\/reviews\/?$/i.test(path)) {
    return 'reviews';
  }

  if (/\/jobs\//i.test(path)) {
    return 'jobs';
  }

  return 'other';
}

const REVIEW_PAGE_RANK = { reviews: 0, other: 1, jobs: 2 };

function compareReviewPages(leftUrl, leftCount, rightUrl, rightCount) {
  const leftKind = reviewPageKind(leftUrl);
  const rightKind = reviewPageKind(rightUrl);

  if (leftKind !== rightKind) {
    return REVIEW_PAGE_RANK[leftKind] - REVIEW_PAGE_RANK[rightKind];
  }

  const leftReviews = Number(leftCount);
  const rightReviews = Number(rightCount);

  if (Number.isFinite(leftReviews) && Number.isFinite(rightReviews) && leftReviews !== rightReviews) {
    return rightReviews - leftReviews;
  }

  return 0;
}

function compareParsedReviews(left, right, company) {
  const byPage = compareReviewPages(
    left?.result?.url,
    left?.parsed?.reviewCount,
    right?.result?.url,
    right?.parsed?.reviewCount
  );

  if (byPage) {
    return byPage;
  }

  return reviewRank(right.result, company) - reviewRank(left.result, company);
}

function preferReviewCount(left, right) {
  const byPage = compareReviewPages(left?.url, left?.reviewCount, right?.url, right?.reviewCount);

  if (byPage) {
    return byPage;
  }

  if (left?.platform === 'Glassdoor' && right?.platform !== 'Glassdoor') {
    return -1;
  }

  if (right?.platform === 'Glassdoor' && left?.platform !== 'Glassdoor') {
    return 1;
  }

  return 0;
}

function reviewRank(result, company) {
  let rank = 0;
  const title = String(result.title || '');
  let host = '';

  try {
    host = new URL(result.url).hostname.toLowerCase();
  } catch {
    host = '';
  }

  if (host === 'www.glassdoor.com' || host === 'glassdoor.com') {
    rank += 8;
  }

  if (host.startsWith('stage.')) {
    rank -= 6;
  }

  if (company) {
    const exact = new RegExp(
      `^(?:working at\\s+)?${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+reviews\\b`,
      'i'
    );

    if (exact.test(title)) {
      rank += 12;
    }
  }

  if (platformFromUrl(result.url) === 'Glassdoor') {
    rank += 3;
  }

  return rank;
}

function mentionsCompany(result, company) {
  if (!company) {
    return true;
  }

  const text = `${result?.title || ''} ${result?.snippet || ''}`;

  if (!mentionsCompanyName(text, company)) {
    return false;
  }

  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp(`(?:^|[^a-z0-9])${escaped}-[a-z0-9]`, 'i').test(text);
}

function glassdoorEntityName(result) {
  const title = String(result?.title || '').replace(/\s+/g, ' ').trim();
  const working = title.match(/^working at\s+(.+?)(?:\s+(?:reviews|jobs)\b|$)/i);
  const named = working?.[1]
    || title.match(/^(.+?)\s+reviews\b/i)?.[1]
    || title.match(/^(.+?)\s+jobs\b/i)?.[1]
    || '';

  if (named) {
    return named.trim();
  }

  try {
    const slug = new URL(result?.url || '').pathname.split('/').filter(Boolean)[1] || '';
    const reviews = slug.match(/^(.+)-Reviews-E\d+$/i);

    if (reviews) {
      return reviews[1].replace(/-/g, ' ').trim();
    }
  } catch {
    // The title is the other source for the employer name.
  }

  return '';
}

function indeedEntityName(result) {
  try {
    const parts = new URL(result?.url || '').pathname.split('/').filter(Boolean);
    const index = parts.findIndex((part) => part.toLowerCase() === 'cmp');
    const slug = index >= 0 ? parts[index + 1] : '';

    if (slug) {
      return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
    }
  } catch {
    // A title can still name the employer.
  }

  const title = String(result?.title || '').replace(/\s+/g, ' ').trim();
  const working = title.match(/^working at\s+(.+?)(?:\s+(?:reviews|careers|jobs)\b|$)/i);
  const named = working?.[1] || title.match(/^(.+?)\s+reviews\b/i)?.[1] || '';
  return named.replace(/^working at\s+/i, '').trim();
}

export function pickReview(results, company) {
  const ranked = [];

  for (const result of results || []) {
    const platform = platformFromUrl(result.url);
    const parsed = parseReviewSnippet(result);

    if (!platform || !parsed || !mentionsCompany(result, company)) {
      continue;
    }

    if (!reviewEntityAccepted(platform, company, result)) {
      const entity = platform === 'Indeed' ? indeedEntityName(result) : glassdoorEntityName(result);
      console.info(`[GHD] ${platform.toLowerCase()} entity rejected`, {
        company,
        entity: entity || null,
        url: result.url || ''
      });
      continue;
    }

    ranked.push({ result, platform, parsed });
  }

  ranked.sort((left, right) => compareParsedReviews(left, right, company));
  const best = ranked[0];

  if (!best) {
    return null;
  }

  return {
    rating: best.parsed.rating,
    reviewCount: best.parsed.reviewCount,
    platform: best.platform,
    url: best.result.url,
    score: scoreRating(best.parsed.rating, best.parsed.reviewCount),
    unavailable: false
  };
}

function failedReviews() {
  return {
    ...emptyReviews(true),
    detail: 'Review search did not complete',
    searchFailed: true
  };
}

function emptyReviews(unavailable) {
  return {
    rating: null,
    reviewCount: null,
    platform: null,
    url: null,
    score: 0,
    unavailable,
    detail: 'No public reviews found'
  };
}

// webSearch forwards includeDomains as Tavily's include_domains. Glassdoor
// first, then Indeed. An open query is what let Trustpilot outrank the
// employer page.
const REVIEW_SEARCH_DOMAINS = ['glassdoor.com', 'indeed.com'];

function reviewEntityAccepted(platform, company, result) {
  if ((platform !== 'Indeed' && platform !== 'Glassdoor') || !company) {
    return true;
  }

  const entity = platform === 'Indeed' ? indeedEntityName(result) : glassdoorEntityName(result);

  // Same check as the Glassdoor API payload in company-rating.js. A search
  // hit with no readable employer name is rejected; the API accepts a payload
  // that simply has no name field.
  return Boolean(entity) && glassdoorEntityMatches(company, entity);
}

function logReviewSearch(company, query, domain, results) {
  const rows = (Array.isArray(results) ? results : []).map((result) => {
    const platform = platformFromUrl(result?.url);
    const parsed = parseReviewSnippet(result);
    const entity = platform === 'Indeed'
      ? indeedEntityName(result)
      : platform === 'Glassdoor'
        ? glassdoorEntityName(result)
        : '';
    let reason = 'eligible';

    if (!platform) {
      reason = 'not an employer review page';
    } else if (!parsed) {
      reason = 'no rating in the snippet';
    } else if (!mentionsCompany(result, company)) {
      reason = 'does not mention the company';
    } else if (!reviewEntityAccepted(platform, company, result)) {
      reason = 'entity rejected';
    }

    return {
      url: result?.url || '',
      title: String(result?.title || '').slice(0, 160),
      rating: parsed?.rating ?? null,
      reviewCount: parsed?.reviewCount ?? null,
      reason
    };
  });

  console.info('[GHD] review search', {
    company,
    query,
    domain,
    e35240: rows.some((row) => /E35240/i.test(row.url)),
    results: rows
  });
}

// One budget for the whole search fallback, not one per search: Intel's two
// searches each ran to the 4s search timeout (9.2s). After a search fails or
// the budget runs out, no further search is started.
export const REVIEW_SEARCH_BUDGET_MS = 4000;

function withinBudget(work, budget) {
  const remaining = budget.deadline - Date.now();

  if (remaining <= 0) {
    return Promise.reject(new Error('review search budget spent'));
  }

  let timer;
  return Promise.race([
    work,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('review search budget spent')), remaining);
    })
  ]).finally(() => clearTimeout(timer));
}

async function searchNamedReviews(queryName, company, deps, budget) {
  const query = `"${queryName}" reviews`;
  const found = [];
  let failed = false;

  for (const domain of REVIEW_SEARCH_DOMAINS) {
    try {
      const results = await withinBudget(deps.webSearch(query, { includeDomains: [domain] }), budget);
      logReviewSearch(company, query, domain, results);
      const review = pickReview(results, company);

      if (review) {
        found.push(review);
      }
    } catch {
      failed = true;
      break;
    }
  }

  if (!found.length) {
    return failed ? { failed: true } : { review: null };
  }

  found.sort(preferReviewCount);
  return { review: found[0] };
}

export async function findCompanyReviews(company, deps) {
  const name = String(company || '').replace(/["<>]/g, '').trim();

  if (!name) {
    return emptyReviews(false);
  }

  if (String(deps.clientHtml || '').trim()) {
    const picked = pickReview(parseDuckDuckGoHtml(deps.clientHtml), name);

    if (picked) {
      return picked;
    }
  }

  const budget = { deadline: Date.now() + (deps.reviewSearchBudgetMs || REVIEW_SEARCH_BUDGET_MS) };
  const searched = await searchNamedReviews(name, name, deps, budget);

  if (searched.review) {
    return searched.review;
  }

  // A search that failed or ran out of time checked nothing, so the check is
  // unavailable. Only a search that ran and found nothing says "No public
  // reviews found".
  if (searched.failed) {
    return failedReviews();
  }

  for (const alias of shorterCompanyNames(name)) {
    const aliasSearch = await searchNamedReviews(alias, name, deps, budget);

    if (aliasSearch.review) {
      return aliasSearch.review;
    }

    if (aliasSearch.failed) {
      return failedReviews();
    }
  }

  return emptyReviews(false);
}
