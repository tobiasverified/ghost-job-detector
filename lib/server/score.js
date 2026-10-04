export function labelForScore(score) {
  if (score <= 34) {
    return { label: 'Ghost Job: Unlikely', cssClass: 'unlikely' };
  }

  if (score <= 49) {
    return { label: 'Ghost Job: Possible', cssClass: 'possible' };
  }

  return { label: 'Ghost Job: Likely', cssClass: 'likely' };
}

export function buildGhostScore(factors) {
  const total = ['reposts', 'layoffs', 'reviews', 'vagueness', 'hiringRatio']
    .reduce((sum, key) => sum + (Number(factors[key]?.score) || 0), 0);
  const ghostScore = Math.max(0, Math.min(100, Math.round(total)));

  return {
    ghostScore,
    ...labelForScore(ghostScore)
  };
}
