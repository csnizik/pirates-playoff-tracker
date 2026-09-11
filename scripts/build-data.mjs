import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fetchRawData, PIRATES_TEAM_ID } from "./fetch-mlb.mjs";
import { chicagoDateString, addDays } from "./lib/dates.mjs";
import {
  normalizeByDivisionStandings,
  normalizeWildCardStandings,
  mergeNlStandings,
  buildWinPctIndex,
} from "./lib/standings.mjs";
import {
  flattenSchedule,
  normalizeRemainingGames,
  computeGamesRemainingByTeam,
  buildTeamGameLog,
  trailingResults,
  findGameStatusForTeam,
  isCompletedGame,
} from "./lib/schedule-utils.mjs";
import { makePairMap, addPairResult, getPairRecord } from "./lib/tiebreak.mjs";
import {
  maxPossibleWins,
  isClinchedDivision,
  isClinchedWildcardSpot,
  isEliminatedFromWildcard,
  isEliminatedFromDivision,
  isEliminatedFromPostseason,
  isClinchedPostseasonSpot,
  eliminationNumberVsThirdSpot,
  buildThresholdTable,
  computeHeadToHeadNotes,
} from "./lib/elimination.mjs";
import { runSimulation } from "./simulate.mjs";
import { seedFromDate } from "./lib/rng.mjs";
import { validatePayload } from "./validate.mjs";

const SCHEMA_VERSION = 1;
const SIMULATION_ITERATIONS = 25000;
const REMAINING_SCHEDULE_WINDOW_DAYS = 75;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

function gapDelta(referenceResult, teamResult) {
  const refWin = referenceResult?.won ? 1 : 0;
  const refLoss = referenceResult && !referenceResult.won ? 1 : 0;
  const teamWin = teamResult?.won ? 1 : 0;
  const teamLoss = teamResult && !teamResult.won ? 1 : 0;
  return (refWin - teamWin + (teamLoss - refLoss)) / 2;
}

async function buildPayload({ now = new Date(), scoreboardMode } = {}) {
  const todayDate = chicagoDateString(now);
  const yesterdayDate = addDays(todayDate, -1);
  const season = Number(todayDate.slice(0, 4));
  const seasonStartDate = `${season}-03-01`;
  const remainingEndDate = addDays(todayDate, REMAINING_SCHEDULE_WINDOW_DAYS);

  // The scheduled 3am Central cron always wants "yesterday" (today's games
  // haven't happened yet at 3am). A manual daytime/evening trigger can ask
  // for "today" instead, once that day's games have actually been played -
  // see the scoreboard_date input on the nightly workflow.
  const resolvedScoreboardMode = scoreboardMode === "today" ? "today" : "yesterday";
  const scoreboardDate = resolvedScoreboardMode === "today" ? todayDate : yesterdayDate;

  const raw = await fetchRawData({
    season,
    todayDate,
    scoreboardDate,
    seasonStartDate,
    remainingEndDate,
  });

  const teamMetaById = new Map(
    raw.teams.map((t) => [
      t.id,
      { abbreviation: t.abbreviation, name: t.name, divisionId: t.division?.id, leagueId: t.league?.id },
    ])
  );

  const byDivisionNl = normalizeByDivisionStandings(raw.byDivisionNlResponse);
  const wildCard = normalizeWildCardStandings(raw.wildCardResponse);
  let nlTeams = mergeNlStandings(byDivisionNl, wildCard);

  const byDivisionAl = normalizeByDivisionStandings(raw.byDivisionAlResponse);
  const alWinPctIndex = buildWinPctIndex(byDivisionAl);

  const remainingGames = normalizeRemainingGames(raw.remainingScheduleResponse);
  const gamesRemainingByTeam = computeGamesRemainingByTeam(remainingGames);
  nlTeams = nlTeams.map((t) => ({
    ...t,
    gamesRemaining: gamesRemainingByTeam.get(t.teamId) ?? 0,
  }));
  const nlTeamsById = new Map(nlTeams.map((t) => [t.teamId, t]));

  const seasonToDateGames = flattenSchedule(raw.seasonToDateScheduleResponse);
  const nlIdSet = new Set(raw.nlTeamIds);

  const completedH2H = makePairMap();
  for (const g of seasonToDateGames.filter(isCompletedGame)) {
    const homeId = g.teams.home.team.id;
    const awayId = g.teams.away.team.id;
    if (nlIdSet.has(homeId) && nlIdSet.has(awayId)) {
      addPairResult(completedH2H, homeId, awayId, g.teams.home.score > g.teams.away.score);
    }
  }

  const trailingReal20 = new Map();
  for (const t of nlTeams) {
    const log = buildTeamGameLog(seasonToDateGames, t.teamId);
    trailingReal20.set(t.teamId, trailingResults(log, 20));
  }

  const opponentWinPct = new Map();
  for (const t of nlTeams) opponentWinPct.set(t.teamId, t.winPct);
  for (const [teamId, rec] of alWinPctIndex.entries()) opponentWinPct.set(teamId, rec.winPct);

  const pirates = nlTeamsById.get(PIRATES_TEAM_ID);
  if (!pirates) throw new Error("Pittsburgh missing from normalized NL standings");

  const thirdSpotHolder = nlTeams.find((t) => t.wildCardRank === 3) ?? null;

  const eliminatedById = new Map(nlTeams.map((t) => [t.teamId, isEliminatedFromPostseason(t, nlTeams)]));

  const piratesClinchedDivision = isClinchedDivision(pirates, nlTeams);
  const piratesClinchedWildcard = isClinchedWildcardSpot(pirates, nlTeams);
  const piratesClinchedPostseason = piratesClinchedDivision || piratesClinchedWildcard;
  const piratesEliminated = isEliminatedFromPostseason(pirates, nlTeams);

  let mode = "IN_RACE";
  if (piratesEliminated) mode = "ELIMINATED";
  else if (piratesClinchedPostseason) mode = "CLINCHED";

  const simulation = runSimulation({
    nlTeams: nlTeams.map((t) => ({
      teamId: t.teamId,
      divisionId: t.divisionId,
      wins: t.wins,
      losses: t.losses,
      divisionRecord: t.divisionRecord,
    })),
    opponentWinPct,
    remainingGames,
    completedH2H,
    trailingReal20,
    seed: seedFromDate(todayDate),
    iterations: SIMULATION_ITERATIONS,
  });

  const rivalsForThreshold = nlTeams
    .filter((t) => t.teamId !== PIRATES_TEAM_ID)
    .map((t) => ({
      teamId: t.teamId,
      wins: t.wins,
      gamesRemaining: t.gamesRemaining,
      isDivisionLeader: t.isDivisionLeader,
    }));
  const thresholdTable = buildThresholdTable(
    { wins: pirates.wins, gamesRemaining: pirates.gamesRemaining },
    rivalsForThreshold
  );

  const nlOnlyRemainingGames = remainingGames.filter(
    (g) => nlIdSet.has(g.homeTeamId) && nlIdSet.has(g.awayTeamId)
  );
  const headToHeadNotes = computeHeadToHeadNotes(nlTeamsById, nlOnlyRemainingGames, eliminatedById).map(
    (note) => ({
      ...note,
      teamAAbbreviation: teamMetaById.get(note.teamAId)?.abbreviation ?? null,
      teamBAbbreviation: teamMetaById.get(note.teamBId)?.abbreviation ?? null,
    })
  );

  // Unfiltered remaining head-to-head counts for every NL pair (not just the
  // still-live ones), so the scenario explorer can check feasibility of any
  // combination the user picks, including for a team it otherwise treats as
  // a long shot.
  const headToHeadRemaining = computeHeadToHeadNotes(nlTeamsById, nlOnlyRemainingGames, new Map()).map(
    (note) => ({
      teamAId: note.teamAId,
      teamBId: note.teamBId,
      gamesRemaining: note.gamesRemaining,
    })
  );

  // Full to-date head-to-head matrix, used by the scenario explorer to
  // resolve ties the same way the nightly simulation does.
  const headToHeadRecords = [...completedH2H.keys()].map((key) => {
    const [aId, bId] = key.split("-").map(Number);
    const rec = getPairRecord(completedH2H, aId, bId);
    return { teamAId: aId, teamBId: bId, teamAWins: rec.aWins, teamBWins: rec.bWins };
  });

  // Scoreboard section: only still-live NL teams (not yet mathematically
  // eliminated), for whichever day scoreboardDate resolved to. A team with
  // no game that day is omitted; a game already final shows the score; a
  // game not yet started shows its scheduled time instead of a score. A
  // game in progress is omitted too - this is a once-a-day digest, not a
  // live scoreboard, so an in-progress result is only ever reported once
  // it is final.
  const scoreboardGames = flattenSchedule(raw.scoreboardScheduleResponse);
  const piratesScoreboardStatus = findGameStatusForTeam(scoreboardGames, PIRATES_TEAM_ID);
  const piratesFinalResult = piratesScoreboardStatus?.state === "final" ? piratesScoreboardStatus : null;

  const scoreboardResults = [];
  for (const t of nlTeams) {
    if (eliminatedById.get(t.teamId)) continue;
    const status = findGameStatusForTeam(scoreboardGames, t.teamId);
    if (!status || status.state === "inProgress") continue;

    const isPirates = t.teamId === PIRATES_TEAM_ID;
    const base = {
      teamId: t.teamId,
      abbreviation: teamMetaById.get(t.teamId)?.abbreviation ?? null,
      isHome: status.isHome,
      opponentTeamId: status.opponentTeamId,
      opponentAbbreviation: teamMetaById.get(status.opponentTeamId)?.abbreviation ?? null,
      isPirates,
      state: status.state,
    };

    if (status.state === "final") {
      scoreboardResults.push({
        ...base,
        score: status.score,
        opponentScore: status.opponentScore,
        won: status.won,
        gapToPiratesChange: isPirates ? 0 : gapDelta(piratesFinalResult, status),
      });
    } else {
      scoreboardResults.push({ ...base, startTime: status.gameDate });
    }
  }

  const nlWildCardTeams = nlTeams.map((t) => ({
    teamId: t.teamId,
    abbreviation: teamMetaById.get(t.teamId)?.abbreviation ?? null,
    name: teamMetaById.get(t.teamId)?.name ?? null,
    divisionId: t.divisionId,
    wins: t.wins,
    losses: t.losses,
    gamesPlayed: t.gamesPlayed,
    winPct: t.winPct,
    gamesRemaining: t.gamesRemaining,
    maxPossibleWins: maxPossibleWins(t),
    isDivisionLeader: t.isDivisionLeader,
    wildCardRank: t.wildCardRank,
    wildCardGamesBack: t.wildCardGamesBack,
    divisionGamesBack: t.gamesBackDivision,
    magicNumberDivision: t.magicNumberDivision,
    streak: t.streak,
    clinchedPostseason: isClinchedPostseasonSpot(t, nlTeams),
    eliminatedPostseason: eliminatedById.get(t.teamId),
    divisionRecord: t.divisionRecord,
    last20: (() => {
      const trailing = trailingReal20.get(t.teamId) ?? [];
      return { wins: trailing.filter(Boolean).length, losses: trailing.filter((w) => !w).length };
    })(),
  }));

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    season,
    asOfDate: scoreboardDate,
    mode,

    pirates: {
      teamId: PIRATES_TEAM_ID,
      wins: pirates.wins,
      losses: pirates.losses,
      gamesPlayed: pirates.gamesPlayed,
      gamesRemaining: pirates.gamesRemaining,
      winPct: pirates.winPct,
      wildCardGamesBack: pirates.wildCardGamesBack,
      divisionGamesBack: pirates.gamesBackDivision,
      thirdSpotHolderTeamId: thirdSpotHolder?.teamId ?? null,
      eliminationNumberWildCard: eliminationNumberVsThirdSpot(pirates, thirdSpotHolder),
      clinchedDivision: piratesClinchedDivision,
      clinchedWildcard: piratesClinchedWildcard,
      clinchedPostseason: piratesClinchedPostseason,
      eliminatedFromDivision: isEliminatedFromDivision(pirates, nlTeams),
      eliminatedFromWildcard: isEliminatedFromWildcard(pirates, nlTeams),
      eliminatedPostseason: piratesEliminated,
    },

    scoreboard: {
      date: scoreboardDate,
      results: scoreboardResults,
    },

    nlWildCard: {
      leagueId: raw.nationalLeagueId,
      teams: nlWildCardTeams,
    },

    thresholdTable,
    headToHeadNotes,
    headToHeadRemaining,
    headToHeadRecords,
    simulation,

    postseason: null,
    eliminatedState: null,
  };

  return payload;
}

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function appendHistory(payload) {
  const historyPath = path.join(DATA_DIR, "history.json");
  let history = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf8"));
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
  }
  const existing = history.find((h) => h.date === payload.asOfDate);
  const entry = {
    date: payload.asOfDate,
    generatedAt: payload.generatedAt,
    piratesWins: payload.pirates.wins,
    piratesLosses: payload.pirates.losses,
    postseasonProbability: payload.simulation.postseasonProbability,
    divisionWinProbability: payload.simulation.divisionWinProbability,
  };
  // If a same-day re-run (e.g. a late or retried cron fire) produces an
  // identical entry apart from the timestamp, keep the original entry
  // unchanged so the file doesn't diff on a no-op rebuild.
  const unchanged =
    existing &&
    existing.piratesWins === entry.piratesWins &&
    existing.piratesLosses === entry.piratesLosses &&
    existing.postseasonProbability === entry.postseasonProbability &&
    existing.divisionWinProbability === entry.divisionWinProbability;
  const finalEntry = unchanged ? existing : entry;

  history = history.filter((h) => h.date !== entry.date);
  history.push(finalEntry);
  history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
}

async function main() {
  const scoreboardMode = process.env.SCOREBOARD_DATE_MODE === "today" ? "today" : "yesterday";

  let payload;
  try {
    payload = await buildPayload({ scoreboardMode });
  } catch (err) {
    console.error("Data fetch/build failed, leaving existing data/current.json untouched.");
    console.error(err.stack ?? err.message);
    process.exit(1);
  }

  const { valid, errors } = validatePayload(payload);
  if (!valid) {
    console.error("Validation failed, leaving existing data/current.json untouched.");
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }

  ensureDataDir();
  const json = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(path.join(DATA_DIR, "current.json"), json);
  writeFileSync(path.join(DATA_DIR, ".last-good.json"), json);
  appendHistory(payload);

  console.log(
    `Wrote data/current.json (mode=${payload.mode}, asOfDate=${payload.asOfDate}, scoreboard=${scoreboardMode})`
  );
  console.log(`Pirates: ${payload.pirates.wins}-${payload.pirates.losses}, ${payload.pirates.gamesRemaining} remaining`);
  console.log(`Wild card GB: ${payload.pirates.wildCardGamesBack}, elimination number vs 3rd spot: ${payload.pirates.eliminationNumberWildCard}`);
  console.log(`Postseason probability: ${(payload.simulation.postseasonProbability * 100).toFixed(2)}%`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { buildPayload };
