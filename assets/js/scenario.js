const PIRATES_TEAM_ID = 134;

function $(id) {
  return document.getElementById(id);
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function winPct(w, l) {
  const total = w + l;
  return total === 0 ? 0.5 : w / total;
}

function buildContext(payload) {
  const teams = payload.nlWildCard.teams;
  const teamsById = new Map(teams.map((t) => [t.teamId, t]));

  const remainingByPair = new Map();
  for (const r of payload.headToHeadRemaining) {
    remainingByPair.set(pairKey(r.teamAId, r.teamBId), r.gamesRemaining);
  }

  const recordByPair = new Map();
  for (const r of payload.headToHeadRecords) {
    recordByPair.set(pairKey(r.teamAId, r.teamBId), r);
  }

  return { teams, teamsById, remainingByPair, recordByPair };
}

function h2hWinsBetween(ctx, aId, bId) {
  const rec = ctx.recordByPair.get(pairKey(aId, bId));
  if (!rec) return { aWins: 0, bWins: 0 };
  return rec.teamAId === aId
    ? { aWins: rec.teamAWins, bWins: rec.teamBWins }
    : { aWins: rec.teamBWins, bWins: rec.teamAWins };
}

function paceWinsFromHere(team) {
  return Math.round(team.winPct * team.gamesRemaining);
}

function evenWinsFromHere(team) {
  return Math.round(team.gamesRemaining / 2);
}

/**
 * Checks every remaining head-to-head pairing against the chosen win totals.
 * A pair is infeasible if both teams would need more wins from their shared
 * games than those games can possibly produce.
 */
function checkFeasibility(ctx, winsFromHere) {
  const conflicts = [];
  for (const [key, n] of ctx.remainingByPair.entries()) {
    if (n <= 0) continue;
    const [aId, bId] = key.split("-").map(Number);
    const teamA = ctx.teamsById.get(aId);
    const teamB = ctx.teamsById.get(bId);
    const wA = winsFromHere.get(aId);
    const wB = winsFromHere.get(bId);
    const otherA = teamA.gamesRemaining - n;
    const otherB = teamB.gamesRemaining - n;
    const minFromSharedA = Math.max(0, wA - otherA);
    const minFromSharedB = Math.max(0, wB - otherB);
    if (minFromSharedA + minFromSharedB > n) {
      conflicts.push({ teamA, teamB, n, minFromSharedA, minFromSharedB });
    }
  }
  return conflicts;
}

/** Ranks a group of teams tied on wins using head-to-head-among-the-group,
 * then intradivision record, then last-20 record. Ties surviving all three
 * are broken by team id purely for a stable array order; that fallback is
 * never presented as a real tiebreaker result. */
function rankTiedGroup(group, ctx) {
  const scored = group.map((team) => {
    let wins = 0;
    let losses = 0;
    for (const other of group) {
      if (other.teamId === team.teamId) continue;
      const { aWins, bWins } = h2hWinsBetween(ctx, team.teamId, other.teamId);
      wins += aWins;
      losses += bWins;
    }
    return {
      team,
      h2h: winPct(wins, losses),
      intradivision: winPct(team.divisionRecord.wins, team.divisionRecord.losses),
      last20: winPct(team.last20.wins, team.last20.losses),
    };
  });

  scored.sort((a, b) => {
    if (a.h2h !== b.h2h) return b.h2h - a.h2h;
    if (a.intradivision !== b.intradivision) return b.intradivision - a.intradivision;
    if (a.last20 !== b.last20) return b.last20 - a.last20;
    return a.team.teamId - b.team.teamId;
  });

  return scored;
}

/** Flattens all teams into one ordered list (best to worst) by wins, tiebreaking within each tied group. */
function rankByWins(teams, finalWinsOf, ctx) {
  const byWins = new Map();
  for (const t of teams) {
    const w = finalWinsOf(t.teamId);
    if (!byWins.has(w)) byWins.set(w, []);
    byWins.get(w).push(t);
  }
  const winTotals = [...byWins.keys()].sort((a, b) => b - a);
  const ordered = [];
  for (const w of winTotals) {
    ordered.push(...rankTiedGroup(byWins.get(w), ctx).map((s) => ({ ...s, wins: w })));
  }
  return ordered;
}

function scoresEqual(a, b) {
  return a.h2h === b.h2h && a.intradivision === b.intradivision && a.last20 === b.last20;
}

/**
 * Given final win totals for every NL team, determines division winners,
 * the wild card top 3, and Pittsburgh's outcome. Also flags whether
 * Pittsburgh's own placement rides on a tie this tool's three tiebreaker
 * criteria could not resolve (checked against its immediate neighbors in
 * the relevant ranking, since that's where an unresolved tie would actually
 * change Pittsburgh's fate).
 */
function determineOutcome(ctx, winsFromHere) {
  const finalWinsOf = (teamId) => ctx.teamsById.get(teamId).wins + winsFromHere.get(teamId);

  const divisionIds = [...new Set(ctx.teams.map((t) => t.divisionId))];
  const divisionWinnerIds = new Set();
  for (const divisionId of divisionIds) {
    const divTeams = ctx.teams.filter((t) => t.divisionId === divisionId);
    const ranked = rankByWins(divTeams, finalWinsOf, ctx);
    divisionWinnerIds.add(ranked[0].team.teamId);
  }

  const wcPool = ctx.teams.filter((t) => !divisionWinnerIds.has(t.teamId));
  const wcRanked = rankByWins(wcPool, finalWinsOf, ctx);

  const piratesIsDivisionWinner = divisionWinnerIds.has(PIRATES_TEAM_ID);
  const piratesWcIndex = wcRanked.findIndex((s) => s.team.teamId === PIRATES_TEAM_ID);

  let outcome;
  if (piratesIsDivisionWinner) outcome = "DIVISION";
  else if (piratesWcIndex === 0) outcome = "WC1";
  else if (piratesWcIndex === 1) outcome = "WC2";
  else if (piratesWcIndex === 2) outcome = "WC3";
  else outcome = "OUT";

  // Ambiguity check: does Pittsburgh's fate depend on a tie the chain didn't resolve?
  let ambiguousWith = null;
  if (!piratesIsDivisionWinner && piratesWcIndex >= 0) {
    const mine = wcRanked[piratesWcIndex];
    const boundary = 2; // index 2 is the WC3/out cutoff
    const neighborIdx = piratesWcIndex === boundary ? boundary + 1 : piratesWcIndex - 1;
    const neighbor = wcRanked[neighborIdx];
    if (
      neighbor &&
      neighbor.wins === mine.wins &&
      scoresEqual(mine, neighbor) &&
      (piratesWcIndex <= boundary) !== (neighborIdx <= boundary)
    ) {
      ambiguousWith = neighbor.team;
    }
  }

  return {
    outcome,
    finalWins: finalWinsOf(PIRATES_TEAM_ID),
    wcRanked,
    divisionWinnerIds,
    ambiguousWith,
  };
}

const OUTCOME_COPY = {
  DIVISION: { title: "In — NL Central Champion", cls: "is-in" },
  WC1: { title: "In — Wild Card 1", cls: "is-in" },
  WC2: { title: "In — Wild Card 2", cls: "is-in" },
  WC3: { title: "In — Wild Card 3", cls: "is-in" },
  OUT: { title: "Out", cls: "is-out" },
};

function renderResult(result) {
  const el = $("scenario-result");
  const copy = OUTCOME_COPY[result.outcome];
  el.className = `scenario-result ${copy.cls}`;
  let sub = `${result.finalWins} wins.`;
  if (result.ambiguousWith) {
    sub += ` Tied with ${result.ambiguousWith.name} on wins, head-to-head, intradivision, and last-20 record — this tool can't break that tie; the real result would come down to tiebreaker rules beyond what's modeled here.`;
  }
  el.innerHTML = `<span class="result-title">${copy.title}</span><span class="result-sub">${sub}</span>`;
}

function renderConflicts(conflicts) {
  const el = $("scenario-conflicts");
  if (conflicts.length === 0) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const items = conflicts
    .map(
      (c) =>
        `<li>${c.teamA.abbreviation} and ${c.teamB.abbreviation} play ${c.n} more time${c.n === 1 ? "" : "s"}. Your inputs need at least ${c.minFromSharedA} of those for ${c.teamA.abbreviation} and at least ${c.minFromSharedB} for ${c.teamB.abbreviation} — that's ${c.minFromSharedA + c.minFromSharedB} wins required from only ${c.n} games. Not possible.</li>`
    )
    .join("");
  el.innerHTML = `<span class="conflicts-title">Impossible combination</span><ul>${items}</ul>`;
}

function main() {
  fetchJson("data/current.json")
    .then((payload) => {
      const ctx = buildContext(payload);
      const winsFromHere = new Map(ctx.teams.map((t) => [t.teamId, paceWinsFromHere(t)]));

      const tbody = $("scenario-body");
      tbody.innerHTML = "";
      const rowByTeam = new Map();

      const sortedForDisplay = [...ctx.teams].sort((a, b) => {
        if (a.teamId === PIRATES_TEAM_ID) return -1;
        if (b.teamId === PIRATES_TEAM_ID) return 1;
        return b.wins - a.wins;
      });

      function recompute() {
        const conflicts = checkFeasibility(ctx, winsFromHere);
        renderConflicts(conflicts);
        if (conflicts.length > 0) {
          $("scenario-result").className = "scenario-result";
          $("scenario-result").innerHTML =
            '<span class="result-title">Invalid combination</span><span class="result-sub">Fix the conflicts below before this scenario means anything.</span>';
          return;
        }
        const result = determineOutcome(ctx, winsFromHere);
        renderResult(result);
      }

      for (const t of sortedForDisplay) {
        const tr = document.createElement("tr");
        const classes = [];
        if (t.teamId === PIRATES_TEAM_ID) classes.push("is-pirates");
        if (t.isDivisionLeader) classes.push("is-leader");
        tr.className = classes.join(" ");

        const sliderId = `scenario-slider-${t.teamId}`;
        const winsCellId = `scenario-wins-${t.teamId}`;
        const pctCellId = `scenario-pct-${t.teamId}`;

        tr.innerHTML = `
          <td class="team-cell"><label for="${sliderId}">${t.abbreviation}</label></td>
          <td>
            <input type="range" id="${sliderId}" min="0" max="${t.gamesRemaining}" value="${winsFromHere.get(t.teamId)}"
              aria-label="${t.name} wins from here, out of ${t.gamesRemaining} remaining" />
          </td>
          <td class="num" id="${winsCellId}"></td>
          <td class="num" id="${pctCellId}"></td>
        `;
        tbody.appendChild(tr);
        rowByTeam.set(t.teamId, { winsCellId, pctCellId });

        const input = tr.querySelector("input");
        input.addEventListener("input", () => {
          winsFromHere.set(t.teamId, Number(input.value));
          updateRow(t);
          recompute();
        });
      }

      function updateRow(t) {
        const wfh = winsFromHere.get(t.teamId);
        const finalWins = t.wins + wfh;
        const finalLosses = t.losses + (t.gamesRemaining - wfh);
        const { winsCellId, pctCellId } = rowByTeam.get(t.teamId);
        $(winsCellId).textContent = `${finalWins}-${finalLosses}`;
        $(pctCellId).textContent = winPct(finalWins, finalLosses).toFixed(3).replace(/^0/, "");
      }

      function updateAllRows() {
        for (const t of ctx.teams) {
          $(`scenario-slider-${t.teamId}`).value = String(winsFromHere.get(t.teamId));
          updateRow(t);
        }
      }

      function applyPreset(name) {
        if (name === "run-table") {
          for (const t of ctx.teams) {
            winsFromHere.set(t.teamId, t.teamId === PIRATES_TEAM_ID ? t.gamesRemaining : paceWinsFromHere(t));
          }
        } else if (name === "even") {
          for (const t of ctx.teams) winsFromHere.set(t.teamId, evenWinsFromHere(t));
        } else if (name === "pace") {
          for (const t of ctx.teams) winsFromHere.set(t.teamId, paceWinsFromHere(t));
        } else if (name === "cheapest") {
          for (const t of ctx.teams) {
            if (t.teamId !== PIRATES_TEAM_ID) winsFromHere.set(t.teamId, paceWinsFromHere(t));
          }
          const pirates = ctx.teamsById.get(PIRATES_TEAM_ID);
          let found = null;
          for (let w = 0; w <= pirates.gamesRemaining; w += 1) {
            winsFromHere.set(PIRATES_TEAM_ID, w);
            const conflicts = checkFeasibility(ctx, winsFromHere);
            if (conflicts.length > 0) continue;
            const result = determineOutcome(ctx, winsFromHere);
            if (result.outcome !== "OUT") {
              found = w;
              break;
            }
          }
          if (found === null) {
            winsFromHere.set(PIRATES_TEAM_ID, pirates.gamesRemaining);
          }
        }
        updateAllRows();
        recompute();
      }

      updateAllRows();
      recompute();

      $("scenario-presets").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-preset]");
        if (!btn) return;
        applyPreset(btn.dataset.preset);
      });
    })
    .catch((err) => {
      console.error(err);
      const el = $("scenario-result");
      if (el) el.textContent = "Could not load scenario data.";
    });
}

main();
