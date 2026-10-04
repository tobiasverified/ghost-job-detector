import { mentionsCompanyName, shorterCompanyNames } from './companies.js';
import { parseDuckDuckGoHtml } from './search.js';

const RATING_PATTERNS = [
  /(\d(?:\.\d{1,2})?)\s*(?:\/\s*5|out of 5(?:\s+stars?)?|\bof\s+5)\b/i,
  /\brating of\s+(\d(?:\.\d{1,2})?)\b/i,
  /\b(\d(?:\.\d{1,2})?)\s*stars?\b/i
];

export function scoreRating(rating) {
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

export function platformFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();

    if (host.includes('glassdoor.')) {
      return 'Glassdoor';
    }

    if (host.includes('indeed.')) {
      return 'Indeed';
    }

    if (host.includes('simplyhired.')) {
      return 'SimplyHired';
    }

    if (host.includes('comparably.')) {
      return 'Comparably';
    }

    if (host.includes('yelp.')) {
      return 'Yelp';
    }

    if (host.includes('google.')) {
      return 'Google';
    }

    if (host.includes('trustpilot.')) {
      return 'Trustpilot';
    }

    if (host.includes('tripadvisor.')) {
      return 'Tripadvisor';
    }

    if (host.includes('bbb.org')) {
      return 'BBB';
    }

    return host.replace(/^www\./, '') || null;
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

  const countMatch = text.match(/([\d,]{2,})\s+(?:[a-z]+\s+){0,3}reviews?\b/i);
  const reviewCount = countMatch
    ? Number(countMatch[1].replace(/,/g, ''))
    : null;

  return {
    rating,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null
  };
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

export function pickReview(results, company) {
  const ranked = [];

  for (const result of results || []) {
    const platform = platformFromUrl(result.url);
    const parsed = parseReviewSnippet(result);

    if (!platform || !parsed || !mentionsCompany(result, company)) {
      continue;
    }

    ranked.push({ result, platform, parsed });
  }

  ranked.sort((left, right) => reviewRank(right.result, company) - reviewRank(left.result, company));
  const best = ranked[0];

  if (!best) {
    return null;
  }

  return {
    rating: best.parsed.rating,
    reviewCount: best.parsed.reviewCount,
    platform: best.platform,
    url: best.result.url,
    score: scoreRating(best.parsed.rating),
    unavailable: false
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

async function searchNamedReviews(queryName, company, deps) {
  try {
    const results = await deps.webSearch(`"${queryName}" reviews`);
    return { review: pickReview(results, company) };
  } catch {
    return { failed: true };
  }
}

export async function findCompanyReviews(company, deps) {
  const name = String(company || '').replace(/["<>]/g, '').trim();

  if (!name) {
    return emptyReviews(false);
  }

  if (String(deps.clientHtml || '').trim()) {
    const parsed = parseDuckDuckGoHtml(deps.clientHtml);
    const picked = pickReview(parsed, name);

    if (picked) {
      return picked;
    }
  } else {
    const searched = await searchNamedReviews(name, name, deps);

    if (searched.review) {
      return searched.review;
    }

    if (searched.failed) {
      return emptyReviews(false);
    }
  }

  for (const alias of shorterCompanyNames(name)) {
    const searched = await searchNamedReviews(alias, name, deps);

    if (searched.review) {
      return searched.review;
    }

    if (searched.failed) {
      return emptyReviews(false);
    }
  }

  return emptyReviews(false);
}
