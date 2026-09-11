function pairKey(idA, idB) {
  return idA < idB ? `${idA}-${idB}` : `${idB}-${idA}`;
}

export function makePairMap() {
  return new Map();
}

export function addPairResult(map, homeId, awayId, homeWon) {
  const key = pairKey(homeId, awayId);
  const entry = map.get(key) ?? { small: 0, large: 0 };
  const smallId = Math.min(homeId, awayId);
  const winnerId = homeWon ? homeId : awayId;
  if (winnerId === smallId) entry.small += 1;
  else entry.large += 1;
  map.set(key, entry);
}

/** Returns { aWins, bWins, gamesPlayed } for the pair (idA, idB), from either direction. */
export function getPairRecord(map, idA, idB) {
  const key = pairKey(idA, idB);
  const entry = map.get(key);
  if (!entry) return { aWins: 0, bWins: 0, gamesPlayed: 0 };
  const smallId = Math.min(idA, idB);
  const aIsSmall = idA === smallId;
  const aWins = aIsSmall ? entry.small : entry.large;
  const bWins = aIsSmall ? entry.large : entry.small;
  return { aWins, bWins, gamesPlayed: aWins + bWins };
}

function winPct(wins, losses) {
  const total = wins + losses;
  return total === 0 ? 0.5 : wins / total;
}

/**
 * Ranks a set of teams that are tied on final wins, applying MLB's tiebreaker
 * chain as specified: head-to-head season series first, then intradivision
 * record, then record in the last 20 games. There is no game 163, so a group
 * still tied after all three criteria is broken by a seeded coin flip drawn
 * from the same simulation RNG (an exceedingly rare case with 3+ way ties
 * that remain symmetric through every real criterion).
 *
 * teams: array of { teamId, divisionRecord: {wins, losses}, last20: {wins, losses} }
 * Returns teams sorted best-to-worst.
 */
export function rankTiedGroup(teams, h2hMap, rng) {
  if (teams.length <= 1) return teams;

  const ids = teams.map((t) => t.teamId);
  const h2hScore = new Map();
  for (const t of teams) {
    let wins = 0;
    let losses = 0;
    for (const otherId of ids) {
      if (otherId === t.teamId) continue;
      const rec = getPairRecord(h2hMap, t.teamId, otherId);
      wins += rec.aWins;
      losses += rec.bWins;
    }
    h2hScore.set(t.teamId, winPct(wins, losses));
  }

  const withScores = teams.map((t) => ({
    team: t,
    h2h: h2hScore.get(t.teamId),
    intradivision: winPct(t.divisionRecord.wins, t.divisionRecord.losses),
    last20: winPct(t.last20.wins, t.last20.losses),
    coinFlip: rng(),
  }));

  withScores.sort((a, b) => {
    if (a.h2h !== b.h2h) return b.h2h - a.h2h;
    if (a.intradivision !== b.intradivision) return b.intradivision - a.intradivision;
    if (a.last20 !== b.last20) return b.last20 - a.last20;
    return b.coinFlip - a.coinFlip;
  });

  return withScores.map((w) => w.team);
}

/**
 * Groups teams by identical finalWins (descending) and resolves each group's
 * internal order via rankTiedGroup, returning one fully ordered list.
 */
export function rankByWinsWithTiebreak(teams, finalWinsOf, h2hMap, rng) {
  const byWins = new Map();
  for (const t of teams) {
    const w = finalWinsOf(t.teamId);
    if (!byWins.has(w)) byWins.set(w, []);
    byWins.get(w).push(t);
  }
  const winTotals = [...byWins.keys()].sort((a, b) => b - a);
  const ranked = [];
  for (const w of winTotals) {
    const group = byWins.get(w);
    ranked.push(...rankTiedGroup(group, h2hMap, rng));
  }
  return ranked;
}

export { pairKey };
