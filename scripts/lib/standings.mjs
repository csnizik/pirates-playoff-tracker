function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "-") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalizes a standingsTypes=byDivision response into one flat array of
 * per-team records, covering every team in the league (unlike the wildCard
 * standings type, which omits division leaders entirely).
 */
export function normalizeByDivisionStandings(byDivisionResponse) {
  const out = [];
  for (const record of byDivisionResponse.records ?? []) {
    const divisionId = record.division.id;
    for (const tr of record.teamRecords ?? []) {
      const ownDivisionRecord = (tr.records?.divisionRecords ?? []).find(
        (dr) => dr.division.id === divisionId
      );
      out.push({
        teamId: tr.team.id,
        divisionId,
        wins: tr.wins,
        losses: tr.losses,
        gamesPlayed: tr.gamesPlayed,
        winPct: toNumber(tr.winningPercentage),
        divisionRank: toNumber(tr.divisionRank),
        isDivisionLeader: tr.divisionRank === "1",
        divisionChamp: Boolean(tr.divisionChamp),
        clinchedApi: Boolean(tr.clinched),
        magicNumberDivision:
          tr.magicNumber !== undefined && tr.magicNumber !== "-" ? toNumber(tr.magicNumber, null) : null,
        eliminationNumberDivision: tr.eliminationNumber,
        gamesBackDivision: tr.gamesBack,
        divisionRecord: ownDivisionRecord
          ? { wins: ownDivisionRecord.wins, losses: ownDivisionRecord.losses }
          : { wins: 0, losses: 0 },
        streak: tr.streak?.streakCode ?? null,
      });
    }
  }
  return out;
}

/**
 * Normalizes a standingsTypes=wildCard response. Only contains the non-division
 * leader teams for the league; must be merged with byDivision for the full pool.
 */
export function normalizeWildCardStandings(wildCardResponse) {
  const out = [];
  for (const record of wildCardResponse.records ?? []) {
    for (const tr of record.teamRecords ?? []) {
      out.push({
        teamId: tr.team.id,
        wildCardRank: toNumber(tr.wildCardRank),
        wildCardGamesBack: tr.wildCardGamesBack,
        wildCardEliminationNumberApi: tr.wildCardEliminationNumber,
        wildCardLeader: Boolean(tr.wildCardLeader),
        hasWildcard: Boolean(tr.hasWildcard),
      });
    }
  }
  return out;
}

/**
 * Merges byDivision + wildCard standings into one array of full NL team
 * records. Division leaders will have wildCard-specific fields left null
 * since MLB's wildCard standings type omits them.
 */
export function mergeNlStandings(byDivisionTeams, wildCardTeams) {
  const wcById = new Map(wildCardTeams.map((t) => [t.teamId, t]));
  return byDivisionTeams.map((t) => {
    const wc = wcById.get(t.teamId);
    return {
      ...t,
      wildCardRank: wc?.wildCardRank ?? null,
      wildCardGamesBack: wc?.wildCardGamesBack ?? (t.isDivisionLeader ? null : "-"),
      wildCardEliminationNumberApi: wc?.wildCardEliminationNumberApi ?? null,
    };
  });
}

/** Simple {teamId -> {wins, losses, winPct}} map, used for interleague opponent strength. */
export function buildWinPctIndex(teams) {
  const index = new Map();
  for (const t of teams) {
    index.set(t.teamId, {
      wins: t.wins,
      losses: t.losses,
      winPct: t.winPct,
    });
  }
  return index;
}
