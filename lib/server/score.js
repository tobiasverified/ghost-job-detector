export function labelForScore(score) {
  if (score <= 34) {
    return { label: 'Ghost Job: Not detected', cssClass: 'unlikely' };
  }

  if (score <= 49) {
    return { label: 'Ghost Job: Possible', cssClass: 'possible' };
  }

  return { label: 'Ghost Job: Likely', cssClass: 'likely' };
}

// Keep aligned with hasScoreEvidence in lib/heuristics.js.
const ACCEPTED_LAYOFF_SOURCES = new Set(['layoffs.fyi', 'newsdata', 'duckduckgo']);
const MIN_INFORMATIVE_REVIEWS = 5;

function knownSizeText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (!text || /^unknown$/i.test(text) || text === 'Unavailable') {
    return '';
  }

  return text;
}

export function hasScoreEvidence({ layoff, reviews, workforce, reposts } = {}) {
  const rating = Number(reviews?.rating);
  const reviewCount = Number(reviews?.reviewCount);
  const employees = Number(workforce?.employees);

  if (Number.isFinite(rating) && Number.isFinite(reviewCount) && reviewCount >= MIN_INFORMATIVE_REVIEWS) {
    return true;
  }

  if (Number.isFinite(employees) && employees > 0) {
    return true;
  }

  if (knownSizeText(workforce?.glassdoorSize) || knownSizeText(workforce?.label)) {
    return true;
  }

  if (Number(reposts?.score) > 0) {
    return true;
  }

  return layoff?.detected === true && ACCEPTED_LAYOFF_SOURCES.has(layoff?.source);
}

export function buildGhostScore(factors) {
  // The hiring ratio is a display line. It does not change the score.
  const total = ['reposts', 'layoffs', 'reviews', 'vagueness']
    .reduce((sum, key) => sum + (Number(factors[key]?.score) || 0), 0);
  const ghostScore = Math.max(0, Math.min(100, Math.round(total)));

  return {
    ghostScore,
    ...labelForScore(ghostScore)
  };
}
