/**
 * Clinch and elimination math.
 *
 * All tests here are the "trivial" sound bound: a team is only declared
 * eliminated once its ceiling (current wins + games remaining) can no longer
 * beat the guaranteed floor (current wins) of enough rivals, and only
 * declared clinched once its current wins already beat every relevant
 * rival's ceiling. Both directions are one-way sound: they never announce a
 * clinch or elimination before it is certain, but in rare multi-team
 * pileups they can lag the absolute earliest mathematically provable day by
 * up to a few days, since that day generally requires a full network-flow
 * feasibility analysis rather than a simple win/loss count. This is the same
 * simplification used by most public magic-number trackers and is
 * documented in the README.
 */

export function maxPossibleWins(team) {
  return team.wins + team.gamesRemaining;
}

/** True once fewer than 3 other NL teams could still catch or pass this team. */
export function isClinchedWildcardSpot(team, allNlTeams) {
  const dangerousRivals = allNlTeams.filter(
    (rival) => rival.teamId !== team.teamId && maxPossibleWins(rival) > team.wins
  );
  return dangerousRivals.length < 3;
}

/** True once no division mate can even tie this team's current wins by running the table. */
export function isClinchedDivision(team, allNlTeams) {
  const mates = allNlTeams.filter((t) => t.teamId !== team.teamId && t.divisionId === team.divisionId);
  return mates.every((mate) => team.wins > maxPossibleWins(mate));
}

/** True once at least 3 other NL teams already have more current wins than this team's ceiling. */
export function isEliminatedFromWildcard(team, allNlTeams) {
  const ceiling = maxPossibleWins(team);
  const teamsAlreadyAhead = allNlTeams.filter(
    (rival) => rival.teamId !== team.teamId && rival.wins > ceiling
  );
  return teamsAlreadyAhead.length >= 3;
}

/** True once this team's ceiling can't even tie the best division mate's current wins. */
export function isEliminatedFromDivision(team, allNlTeams) {
  const mates = allNlTeams.filter((t) => t.teamId !== team.teamId && t.divisionId === team.divisionId);
  if (mates.length === 0) return false;
  const bestMateWins = Math.max(...mates.map((m) => m.wins));
  return maxPossibleWins(team) < bestMateWins;
}

export function isEliminatedFromPostseason(team, allNlTeams) {
  return isEliminatedFromDivision(team, allNlTeams) && isEliminatedFromWildcard(team, allNlTeams);
}

export function isClinchedPostseasonSpot(team, allNlTeams) {
  return isClinchedDivision(team, allNlTeams) || isClinchedWildcardSpot(team, allNlTeams);
}

/**
 * Elimination number against the current 3rd wild card spot: the standard
 * two-team magic-number formula, computed against whichever NL team
 * currently holds wildCardRank 3.
 *
 * Derivation: for rival Y to clinch a spot ahead of team X, we need
 * (Y's wins + x) > (X's ceiling - y) for combined additional Y-wins x and
 * X-losses y, which resolves to needing x + y >= X's ceiling - Y's wins + 1.
 * So the number is X's own ceiling minus the rival's current wins, not the
 * rival's ceiling minus X's wins.
 *
 * This is a real two-team bound, not the full multi-team combinatorial
 * elimination number (which requires checking every other contender
 * simultaneously and can only be smaller). It is shown for legibility; the
 * ELIMINATED/CLINCHED page mode is driven by the trivial multi-team tests
 * above, not by this number reaching zero.
 */
export function eliminationNumberVsThirdSpot(team, thirdSpotHolder) {
  if (!thirdSpotHolder) return null;
  const raw = maxPossibleWins(team) - thirdSpotHolder.wins + 1;
  return Math.max(raw, 0);
}

/**
 * The threshold table: for each possible Pittsburgh finish (from 0 wins the
 * rest through running the table), the most wins each rival can post and
 * still finish behind, per the spec formula F - 1 - w, capped at the
 * rival's games remaining and floored at zero.
 */
export function buildThresholdTable(pirates, rivals) {
  const piratesCeiling = maxPossibleWins(pirates);
  const rows = [];
  for (let winsFromHere = 0; winsFromHere <= pirates.gamesRemaining; winsFromHere += 1) {
    const finish = pirates.wins + winsFromHere;
    rows.push({
      piratesFinishWins: finish,
      piratesWinsFromHere: winsFromHere,
      rivals: rivals.map((r) => ({
        teamId: r.teamId,
        maxWinsToStayBehind: Math.min(Math.max(finish - 1 - r.wins, 0), r.gamesRemaining),
      })),
    });
  }
  return {
    piratesGamesRemaining: pirates.gamesRemaining,
    piratesCeiling,
    rows,
    rivals: rivals.map((r) => ({
      teamId: r.teamId,
      wins: r.wins,
      gamesRemaining: r.gamesRemaining,
      maxPossibleWins: maxPossibleWins(r),
      isStillAThreat: maxPossibleWins(r) >= piratesCeiling,
    })),
  };
}

/**
 * Structural head-to-head facts: when two still-live NL teams have games
 * left against each other, the season series between them guarantees the
 * winner of that series a wins floor greater than zero.
 */
export function computeHeadToHeadNotes(nlTeamsById, remainingGames, eliminatedById) {
  const pairCounts = new Map();
  for (const g of remainingGames) {
    const home = nlTeamsById.get(g.homeTeamId);
    const away = nlTeamsById.get(g.awayTeamId);
    if (!home || !away) continue;
    const key = home.teamId < away.teamId ? `${home.teamId}-${away.teamId}` : `${away.teamId}-${home.teamId}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  const notes = [];
  for (const [key, count] of pairCounts.entries()) {
    const [aId, bId] = key.split("-").map(Number);
    if (eliminatedById.get(aId) && eliminatedById.get(bId)) continue;
    notes.push({
      teamAId: aId,
      teamBId: bId,
      gamesRemaining: count,
      guaranteedWinsToSeriesWinner: Math.ceil(count / 2),
    });
  }
  return notes.sort((a, b) => b.gamesRemaining - a.gamesRemaining);
}
