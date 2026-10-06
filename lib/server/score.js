export function labelForScore(score) {
  if (score <= 34) {
    return { label: 'Ghost Job: Not detected', cssClass: 'unlikely' };
  }

  if (score <= 49) {
    return { label: 'Ghost Job: Possible', cssClass: 'possible' };
  }

  return { label: 'Ghost Job: Likely', cssClass: 'likely' };
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
