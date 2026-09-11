/**
 * Bill James' log5 formula: the probability that team A beats team B at a
 * neutral site, given each team's current winning percentage.
 */
export function log5(pctA, pctB) {
  const denom = pctA + pctB - 2 * pctA * pctB;
  if (denom <= 0) return 0.5;
  return (pctA - pctA * pctB) / denom;
}

/**
 * Home team win probability: the neutral-site log5 estimate, nudged by a
 * home field advantage constant (default .54, roughly the long-run MLB home
 * win rate). The nudge is applied as an odds-ratio adjustment referenced off
 * a neutral .500 field, so homeFieldPct === .5 leaves the log5 value
 * untouched.
 */
export function homeWinProbability(homePct, awayPct, homeFieldPct = 0.54) {
  const neutral = log5(homePct, awayPct);
  const clamped = Math.min(Math.max(neutral, 0.001), 0.999);
  const oddsNeutral = clamped / (1 - clamped);
  const oddsHomeField = homeFieldPct / (1 - homeFieldPct);
  const oddsFinal = oddsNeutral * oddsHomeField;
  return oddsFinal / (1 + oddsFinal);
}
