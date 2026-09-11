import { mlbGet } from "./lib/mlb-client.mjs";

export const PIRATES_TEAM_ID = 134;

/**
 * Pulls every raw MLB Stats API response the pipeline needs. League ids and
 * team ids (other than Pittsburgh's, which is given) are derived from the
 * /teams response rather than hardcoded, so a future league realignment
 * would not silently break the job.
 */
export async function fetchRawData({ season, todayDate, yesterdayDate, seasonStartDate, remainingEndDate }) {
  const teamsResponse = await mlbGet("/teams", { sportId: 1, season });
  const teams = teamsResponse.teams ?? [];
  if (teams.length === 0) {
    throw new Error("teams endpoint returned no teams");
  }

  const nationalLeague = teams.find((t) => t.league?.name === "National League");
  const americanLeague = teams.find((t) => t.league?.name === "American League");
  if (!nationalLeague || !americanLeague) {
    throw new Error("could not identify National/American League ids from teams response");
  }
  const nationalLeagueId = nationalLeague.league.id;
  const americanLeagueId = americanLeague.league.id;

  const nlTeamIds = teams.filter((t) => t.league?.id === nationalLeagueId).map((t) => t.id);
  const alTeamIds = teams.filter((t) => t.league?.id === americanLeagueId).map((t) => t.id);
  if (!nlTeamIds.includes(PIRATES_TEAM_ID)) {
    throw new Error("Pittsburgh (134) not found in National League team list");
  }

  const wildCardResponse = await mlbGet("/standings", {
    leagueId: nationalLeagueId,
    season,
    standingsTypes: "wildCard",
  });

  const byDivisionNlResponse = await mlbGet("/standings", {
    leagueId: nationalLeagueId,
    season,
    standingsTypes: "byDivision",
  });

  const byDivisionAlResponse = await mlbGet("/standings", {
    leagueId: americanLeagueId,
    season,
    standingsTypes: "byDivision",
  });

  const yesterdayScheduleResponse = await mlbGet("/schedule", {
    sportId: 1,
    date: yesterdayDate,
    hydrate: "linescore,decisions,team",
  });

  const remainingScheduleResponse = await mlbGet("/schedule", {
    sportId: 1,
    teamId: nlTeamIds.join(","),
    startDate: todayDate,
    endDate: remainingEndDate,
    gameType: "R",
  });

  const seasonToDateScheduleResponse = await mlbGet("/schedule", {
    sportId: 1,
    teamId: nlTeamIds.join(","),
    startDate: seasonStartDate,
    endDate: yesterdayDate,
    gameType: "R",
  });

  return {
    teams,
    nationalLeagueId,
    americanLeagueId,
    nlTeamIds,
    alTeamIds,
    wildCardResponse,
    byDivisionNlResponse,
    byDivisionAlResponse,
    yesterdayScheduleResponse,
    remainingScheduleResponse,
    seasonToDateScheduleResponse,
  };
}
