import { createRng } from "./lib/rng.mjs";
import { homeWinProbability } from "./lib/log5.mjs";
import { makePairMap, addPairResult, rankByWinsWithTiebreak } from "./lib/tiebreak.mjs";

const PIRATES_TEAM_ID = 134;
const DEFAULT_HOME_FIELD_PCT = 0.54;

/**
 * Runs the Monte Carlo season simulation.
 *
 * nlTeams: normalized NL team records, one per team, each:
 *   { teamId, divisionId, wins, losses, divisionRecord: {wins, losses} }
 * opponentWinPct: Map<teamId, winPct> covering every team (NL and AL) that
 *   appears in remainingGames, used as the static per-game strength input.
 * remainingGames: chronologically sorted [{ gamePk, date, homeTeamId, awayTeamId }],
 *   every not-yet-played regular season game involving at least one NL team.
 * completedH2H: pair map (see tiebreak.mjs) seeded with this season's played
 *   games among NL teams.
 * trailingReal20: Map<teamId, boolean[]> chronological (oldest first, max 20)
 *   real completed results, used to seed the last-20 tiebreaker.
 * seed: integer RNG seed.
 * iterations: number of seasons to simulate (minimum 25000 per spec).
 */
export function runSimulation({
  nlTeams,
  opponentWinPct,
  remainingGames,
  completedH2H,
  trailingReal20,
  seed,
  iterations,
  homeFieldPct = DEFAULT_HOME_FIELD_PCT,
}) {
  const teamsById = new Map(nlTeams.map((t) => [t.teamId, t]));
  const nlTeamIds = new Set(nlTeams.map((t) => t.teamId));
  const divisionIds = [...new Set(nlTeams.map((t) => t.divisionId))];

  const rng = createRng(seed);

  let postseasonCount = 0;
  let divisionWinCount = 0;
  const wcSeedCounts = { wc1: 0, wc2: 0, wc3: 0 };
  const finalWinsHistogram = new Map();

  for (let iter = 0; iter < iterations; iter += 1) {
    const simWins = new Map();
    const simDivRecord = new Map();
    const last20 = new Map();
    for (const t of nlTeams) {
      simWins.set(t.teamId, 0);
      simDivRecord.set(t.teamId, { wins: 0, losses: 0 });
      last20.set(t.teamId, [...(trailingReal20.get(t.teamId) ?? [])]);
    }
    const h2h = makePairMap();
    // Seed with this season's already-played games among NL teams.
    for (const [key, entry] of completedH2H.entries()) {
      h2h.set(key, { ...entry });
    }

    for (const game of remainingGames) {
      const pHome = opponentWinPct.get(game.homeTeamId);
      const pAway = opponentWinPct.get(game.awayTeamId);
      if (pHome === undefined || pAway === undefined) continue;

      const p = homeWinProbability(pHome, pAway, homeFieldPct);
      const homeWon = rng() < p;

      const homeIsNl = nlTeamIds.has(game.homeTeamId);
      const awayIsNl = nlTeamIds.has(game.awayTeamId);

      if (homeIsNl) {
        if (homeWon) simWins.set(game.homeTeamId, simWins.get(game.homeTeamId) + 1);
        last20.get(game.homeTeamId).push(homeWon);
      }
      if (awayIsNl) {
        if (!homeWon) simWins.set(game.awayTeamId, simWins.get(game.awayTeamId) + 1);
        last20.get(game.awayTeamId).push(!homeWon);
      }

      if (homeIsNl && awayIsNl) {
        addPairResult(h2h, game.homeTeamId, game.awayTeamId, homeWon);

        const homeTeam = teamsById.get(game.homeTeamId);
        const awayTeam = teamsById.get(game.awayTeamId);
        if (homeTeam.divisionId === awayTeam.divisionId) {
          const homeRec = simDivRecord.get(game.homeTeamId);
          const awayRec = simDivRecord.get(game.awayTeamId);
          if (homeWon) {
            homeRec.wins += 1;
            awayRec.losses += 1;
          } else {
            homeRec.losses += 1;
            awayRec.wins += 1;
          }
        }
      }
    }

    const finalWins = new Map();
    const finalDivisionRecord = new Map();
    const finalLast20 = new Map();
    for (const t of nlTeams) {
      finalWins.set(t.teamId, t.wins + simWins.get(t.teamId));
      finalDivisionRecord.set(t.teamId, {
        wins: t.divisionRecord.wins + simDivRecord.get(t.teamId).wins,
        losses: t.divisionRecord.losses + simDivRecord.get(t.teamId).losses,
      });
      const trailing = last20.get(t.teamId).slice(-20);
      finalLast20.set(t.teamId, {
        wins: trailing.filter(Boolean).length,
        losses: trailing.filter((w) => !w).length,
      });
    }

    const teamMeta = (teamId) => ({
      teamId,
      divisionRecord: finalDivisionRecord.get(teamId),
      last20: finalLast20.get(teamId),
    });

    const divisionWinners = new Set();
    for (const divisionId of divisionIds) {
      const divTeams = nlTeams.filter((t) => t.divisionId === divisionId).map((t) => teamMeta(t.teamId));
      const ranked = rankByWinsWithTiebreak(divTeams, (id) => finalWins.get(id), h2h, rng);
      divisionWinners.add(ranked[0].teamId);
    }

    const wildcardPool = nlTeams
      .filter((t) => !divisionWinners.has(t.teamId))
      .map((t) => teamMeta(t.teamId));
    const wildcardRanked = rankByWinsWithTiebreak(wildcardPool, (id) => finalWins.get(id), h2h, rng);

    const piratesDivisionWin = divisionWinners.has(PIRATES_TEAM_ID);
    const piratesWcIndex = wildcardRanked.findIndex((t) => t.teamId === PIRATES_TEAM_ID);
    const piratesMadePlayoffs = piratesDivisionWin || (piratesWcIndex >= 0 && piratesWcIndex < 3);

    if (piratesMadePlayoffs) postseasonCount += 1;
    if (piratesDivisionWin) divisionWinCount += 1;
    if (!piratesDivisionWin && piratesWcIndex === 0) wcSeedCounts.wc1 += 1;
    if (!piratesDivisionWin && piratesWcIndex === 1) wcSeedCounts.wc2 += 1;
    if (!piratesDivisionWin && piratesWcIndex === 2) wcSeedCounts.wc3 += 1;

    const piratesFinalWins = finalWins.get(PIRATES_TEAM_ID);
    finalWinsHistogram.set(piratesFinalWins, (finalWinsHistogram.get(piratesFinalWins) ?? 0) + 1);
  }

  const finalWinsDistribution = [...finalWinsHistogram.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wins, count]) => ({ wins, probability: count / iterations }));

  return {
    seed,
    iterations,
    postseasonProbability: postseasonCount / iterations,
    divisionWinProbability: divisionWinCount / iterations,
    wildCardSeedProbabilities: {
      wc1: wcSeedCounts.wc1 / iterations,
      wc2: wcSeedCounts.wc2 / iterations,
      wc3: wcSeedCounts.wc3 / iterations,
    },
    finalWinsDistribution,
  };
}
