/**
 * A schedule entry is only a real, played game if codedGameState is "F".
 * Postponed games keep a permanent ghost entry on their original date with
 * abstractGameState "Final" but codedGameState "D" and null scores. Trusting
 * abstractGameState alone misclassifies those as completed games.
 */
export function isCompletedGame(game) {
  return (
    game.status?.codedGameState === "F" &&
    typeof game.teams?.home?.score === "number" &&
    typeof game.teams?.away?.score === "number"
  );
}

export function isFutureGame(game) {
  return game.status?.abstractGameState === "Preview";
}

function sortKey(game) {
  return `${game.officialDate}-${String(game.gameNumber ?? 1).padStart(2, "0")}-${game.gamePk}`;
}

export function sortGamesChronologically(games) {
  return [...games].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** Flattens a schedule response's dates[].games[] into a single game list. */
export function flattenSchedule(scheduleResponse) {
  return (scheduleResponse.dates ?? []).flatMap((d) => d.games ?? []);
}

/**
 * Builds a chronological log of completed games for one team:
 * [{ gamePk, date, opponentId, isHome, win }]
 */
export function buildTeamGameLog(games, teamId) {
  const completed = games.filter(isCompletedGame).filter(
    (g) => g.teams.home.team.id === teamId || g.teams.away.team.id === teamId
  );
  return sortGamesChronologically(completed).map((g) => {
    const isHome = g.teams.home.team.id === teamId;
    const self = isHome ? g.teams.home : g.teams.away;
    const opponent = isHome ? g.teams.away : g.teams.home;
    return {
      gamePk: g.gamePk,
      date: g.officialDate,
      opponentId: opponent.team.id,
      isHome,
      win: self.score > opponent.score,
    };
  });
}

/** Head-to-head record between two teams from a set of completed games. */
export function computeHeadToHead(games, teamAId, teamBId) {
  const relevant = games
    .filter(isCompletedGame)
    .filter((g) => {
      const ids = [g.teams.home.team.id, g.teams.away.team.id];
      return ids.includes(teamAId) && ids.includes(teamBId);
    });

  let teamAWins = 0;
  let teamBWins = 0;
  for (const g of relevant) {
    const homeId = g.teams.home.team.id;
    const homeWon = g.teams.home.score > g.teams.away.score;
    const winnerId = homeWon ? homeId : g.teams.away.team.id;
    if (winnerId === teamAId) teamAWins += 1;
    else teamBWins += 1;
  }
  return { teamAWins, teamBWins, gamesPlayed: relevant.length };
}

/** Trailing results (oldest first, capped at 20) from a team's completed game log. */
export function trailingResults(teamGameLog, count = 20) {
  return teamGameLog.slice(-count).map((g) => g.win);
}

/**
 * Normalizes a leaguewide schedule response into a deduped, chronologically
 * sorted list of not-yet-played regular season games:
 * [{ gamePk, date, homeTeamId, awayTeamId }]
 */
export function normalizeRemainingGames(scheduleResponse) {
  const games = flattenSchedule(scheduleResponse).filter(
    (g) => g.gameType === "R" && isFutureGame(g)
  );
  const seen = new Set();
  const deduped = [];
  for (const g of games) {
    if (seen.has(g.gamePk)) continue;
    seen.add(g.gamePk);
    deduped.push({
      gamePk: g.gamePk,
      date: g.officialDate,
      homeTeamId: g.teams.home.team.id,
      awayTeamId: g.teams.away.team.id,
    });
  }
  return deduped.sort((a, b) => (a.date === b.date ? a.gamePk - b.gamePk : a.date < b.date ? -1 : 1));
}

/** Map<teamId, count> of not-yet-played games, from a normalized remaining games list. */
export function computeGamesRemainingByTeam(remainingGames) {
  const counts = new Map();
  for (const g of remainingGames) {
    counts.set(g.homeTeamId, (counts.get(g.homeTeamId) ?? 0) + 1);
    counts.set(g.awayTeamId, (counts.get(g.awayTeamId) ?? 0) + 1);
  }
  return counts;
}

/**
 * A team's result from a single day's schedule, or null if it did not play
 * a completed game that day (off day, or a postponement with no makeup yet).
 */
export function findCompletedResultForTeam(dayGames, teamId) {
  const game = dayGames
    .filter(isCompletedGame)
    .find((g) => g.teams.home.team.id === teamId || g.teams.away.team.id === teamId);
  if (!game) return null;
  const isHome = game.teams.home.team.id === teamId;
  const self = isHome ? game.teams.home : game.teams.away;
  const opponent = isHome ? game.teams.away : game.teams.home;
  return {
    gamePk: game.gamePk,
    isHome,
    score: self.score,
    opponentTeamId: opponent.team.id,
    opponentScore: opponent.score,
    won: self.score > opponent.score,
  };
}
