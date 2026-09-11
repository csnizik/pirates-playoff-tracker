const PIRATES_TEAM_ID = 134;
const STALE_HOURS_THRESHOLD = 30;

const MODE_COPY = {
  IN_RACE: null,
  CLINCHED: { title: "Clinched a Playoff Spot", sub: "Seeding still to be determined." },
  ELIMINATED: { title: "Eliminated", sub: "The 2026 season is over for Pittsburgh's playoff chase." },
  POSTSEASON: { title: "Postseason", sub: "Regular season is over. Tracking the bracket." },
  OFFSEASON: { title: "Offseason", sub: "See you in spring." },
};

function $(id) {
  return document.getElementById(id);
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * True the first time a viewer sees a given day's data. Used to gate the
 * odds counter animation and the scoreboard row flash so they play once per
 * new result, not on every reload of the same day's data.
 */
function isNewSinceLastVisit(asOfDate) {
  try {
    const key = "pirates-tracker-last-seen-date";
    const lastSeen = localStorage.getItem(key);
    localStorage.setItem(key, asOfDate);
    return lastSeen !== asOfDate;
  } catch {
    return false;
  }
}

function animatePercentValue(el, endFraction) {
  if (prefersReducedMotion()) {
    el.textContent = formatPct(endFraction);
    return;
  }
  const duration = 700;
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) * (1 - t);
    el.textContent = formatPct(endFraction * eased);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = formatPct(endFraction);
  }
  requestAnimationFrame(step);
}

function formatPct(fraction) {
  const pct = fraction * 100;
  if (pct <= 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function formatPctPoints(fraction) {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "" : "±";
  if (Math.abs(pct) < 0.01) return "±0.00pp";
  return `${sign}${pct.toFixed(2)}pp`;
}

function formatGamesBack(gb) {
  if (gb === null || gb === undefined) return "—";
  if (gb === "-") return "—";
  return String(gb).replace(/^\+/, "+");
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function hoursSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / 3600000;
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function renderMasthead(payload) {
  $("as-of-date").textContent = formatDate(payload.asOfDate);
  $("as-of-date").setAttribute("datetime", payload.asOfDate);
  const generated = new Date(payload.generatedAt);
  $("generated-at").textContent = generated.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  $("generated-at").setAttribute("datetime", payload.generatedAt);

  const hours = hoursSince(payload.generatedAt);
  if (hours > STALE_HOURS_THRESHOLD) {
    $("stale-hours").textContent = hours.toFixed(0);
    $("stale-banner").hidden = false;
  }
}

function renderModeBanner(payload) {
  const banner = $("mode-banner");
  const copy = MODE_COPY[payload.mode];
  if (!copy) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = `mode-banner mode-${payload.mode.toLowerCase()}`;
  banner.innerHTML = `<span class="mode-title">${copy.title}</span><span class="mode-sub">${copy.sub}</span>`;
}

function renderStatus(payload, history, isNewData) {
  const p = payload.pirates;
  $("stat-record").textContent = `${p.wins}-${p.losses}`;
  $("stat-gb").textContent = formatGamesBack(p.wildCardGamesBack);
  $("stat-gr").textContent = String(p.gamesRemaining);

  if (p.eliminatedPostseason) {
    $("stat-elim").textContent = "E";
  } else if (p.clinchedPostseason) {
    $("stat-elim").textContent = "—";
  } else {
    $("stat-elim").textContent = p.eliminationNumberWildCard === null ? "—" : String(p.eliminationNumberWildCard);
  }

  const oddsEl = $("stat-odds");
  if (isNewData) {
    animatePercentValue(oddsEl, payload.simulation.postseasonProbability);
  } else {
    oddsEl.textContent = formatPct(payload.simulation.postseasonProbability);
  }

  const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : 1));
  const idx = sorted.findIndex((h) => h.date === payload.asOfDate);
  const deltaEl = $("stat-odds-delta");
  if (idx > 0) {
    const prev = sorted[idx - 1];
    const delta = payload.simulation.postseasonProbability - prev.postseasonProbability;
    deltaEl.textContent = `${formatPctPoints(delta)} vs prior day`;
    deltaEl.className = `stat-delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`;
  } else {
    deltaEl.textContent = "first tracked day";
    deltaEl.className = "stat-delta";
  }
}

function formatStartTime(isoString) {
  return new Date(isoString).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function renderScoreboard(payload, teamMetaById, isNewData) {
  const tbody = $("scoreboard-body");
  tbody.innerHTML = "";

  $("scoreboard-heading").textContent = `Scores for ${formatDate(payload.scoreboard.date)}`;
  $("scoreboard-description").textContent =
    "Only showing games involving NL teams still alive for a wild card spot as of today. Games not yet final show their start time, not a live score.";

  const results = payload.scoreboard.results;
  if (results.length === 0) {
    $("scoreboard-note").hidden = false;
    return;
  }
  $("scoreboard-note").hidden = true;

  const ordered = [...results].sort((a, b) => {
    if (a.isPirates) return -1;
    if (b.isPirates) return 1;
    if (a.state !== b.state) return a.state === "final" ? -1 : 1;
    if (a.state === "final") return Math.abs(b.gapToPiratesChange) - Math.abs(a.gapToPiratesChange);
    return a.abbreviation.localeCompare(b.abbreviation);
  });

  for (const r of ordered) {
    const tr = document.createElement("tr");
    const classes = [];
    if (r.isPirates) classes.push("is-pirates");
    if (isNewData && r.state === "final") classes.push("flash");
    tr.className = classes.join(" ");

    const opp = `${r.isHome ? "vs" : "@"} ${r.opponentAbbreviation}`;

    let scoreCell = "";
    let scoreClass = "";
    let gapCell = "—";
    let gapClass = "";

    if (r.state === "final") {
      scoreCell = `${r.won ? "W" : "L"} ${r.score}-${r.opponentScore}`;
      scoreClass = r.won ? "result-win" : "result-loss";
      if (!r.isPirates) {
        const delta = r.gapToPiratesChange;
        if (delta > 0) {
          gapCell = `▲ ${delta.toFixed(1)}`;
          gapClass = "result-win";
        } else if (delta < 0) {
          gapCell = `▼ ${Math.abs(delta).toFixed(1)}`;
          gapClass = "result-loss";
        } else {
          gapCell = "– 0.0";
        }
      }
    } else {
      scoreCell = formatStartTime(r.startTime);
      scoreClass = "";
    }

    tr.innerHTML = `
      <td>${teamMetaById.get(r.teamId)?.name ?? r.abbreviation}</td>
      <td class="${scoreClass}">${scoreCell}</td>
      <td>${opp}</td>
      <td class="num ${gapClass}">${gapCell}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderStandings(payload, teamMetaById) {
  const tbody = $("standings-body");
  tbody.innerHTML = "";
  const teams = [...payload.nlWildCard.teams].sort((a, b) => b.wins - a.wins || a.losses - b.losses);

  for (const t of teams) {
    const tr = document.createElement("tr");
    const classes = [];
    if (t.teamId === PIRATES_TEAM_ID) classes.push("is-pirates");
    if (t.isDivisionLeader) classes.push("is-leader");
    tr.className = classes.join(" ");

    tr.innerHTML = `
      <td class="team-cell">${teamMetaById.get(t.teamId)?.abbreviation ?? t.abbreviation}</td>
      <td class="num">${t.wins}</td>
      <td class="num">${t.losses}</td>
      <td class="num">${t.winPct.toFixed(3).replace(/^0/, "")}</td>
      <td class="num">${t.isDivisionLeader ? "—" : formatGamesBack(t.wildCardGamesBack)}</td>
      <td class="num">${t.gamesRemaining}</td>
      <td class="num">${t.maxPossibleWins}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderThresholdTable(payload, teamMetaById) {
  const table = payload.thresholdTable;
  const wcRivals = table.rivals.filter((r) => !r.isDivisionLeader);
  const leaders = table.rivals.filter((r) => r.isDivisionLeader);

  const headRow = $("threshold-head");
  headRow.innerHTML =
    `<th scope="col">Pirates Finish</th>` +
    wcRivals.map((r) => `<th scope="col" class="num">${teamMetaById.get(r.teamId)?.abbreviation ?? r.teamId}</th>`).join("");

  const tbody = $("threshold-body");
  tbody.innerHTML = "";
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    const cells = wcRivals
      .map((r) => {
        const cell = row.rivals.find((x) => x.teamId === r.teamId);
        const val = cell.maxWinsToStayBehind;
        const cls = val === 0 ? "result-loss" : "";
        return `<td class="num ${cls}">${val}</td>`;
      })
      .join("");
    tr.innerHTML = `<td class="num">${row.piratesFinishWins} (${row.piratesWinsFromHere}/${table.piratesGamesRemaining})</td>${cells}`;
    tbody.appendChild(tr);
  }

  if (leaders.length > 0) {
    const lastRow = table.rows[table.rows.length - 1];
    const parts = leaders.map((l) => {
      const cell = lastRow.rivals.find((x) => x.teamId === l.teamId);
      const name = teamMetaById.get(l.teamId)?.name ?? l.teamId;
      return `${name} could win at most ${cell.maxWinsToStayBehind} more and still finish behind an ${lastRow.piratesFinishWins}-win Pittsburgh finish, but that only matters if they lose their own division lead first`;
    });
    $("threshold-leaders-note").textContent = `Division leaders, for reference: ${parts.join("; ")}.`;
  }
}

const MAX_H2H_NOTES = 8;

function renderHeadToHeadNotes(payload) {
  const list = $("h2h-notes");
  list.innerHTML = "";

  // Relevance proxy: wild card rank (division leaders and Pittsburgh sort
  // first). Keeps this list to the live part of the race instead of every
  // still-mathematically-alive pair, most of which aren't part of the story.
  const rankById = new Map(
    payload.nlWildCard.teams.map((t) => [t.teamId, t.isDivisionLeader ? 0 : (t.wildCardRank ?? 99)])
  );

  const scored = payload.headToHeadNotes.map((n) => {
    const involvesPirates = n.teamAId === PIRATES_TEAM_ID || n.teamBId === PIRATES_TEAM_ID;
    const rankSum = (rankById.get(n.teamAId) ?? 99) + (rankById.get(n.teamBId) ?? 99);
    return { note: n, involvesPirates, rankSum };
  });

  scored.sort((a, b) => {
    if (a.involvesPirates !== b.involvesPirates) return a.involvesPirates ? -1 : 1;
    if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
    return b.note.gamesRemaining - a.note.gamesRemaining;
  });

  const shown = scored.slice(0, MAX_H2H_NOTES);

  if (shown.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No remaining head-to-head series among the live contenders.";
    list.appendChild(li);
    return;
  }

  for (const { note: n } of shown) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="lead">${n.teamAAbbreviation} and ${n.teamBAbbreviation}</span> play ${n.gamesRemaining} more time${n.gamesRemaining === 1 ? "" : "s"}. Whoever wins that season series is guaranteed at least ${n.guaranteedWinsToSeriesWinner} of those wins toward their final total.`;
    list.appendChild(li);
  }

  if (scored.length > shown.length) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = `${scored.length - shown.length} more remaining series among longer-shot contenders not shown.`;
    list.appendChild(li);
  }
}

function renderSimulation(payload) {
  const s = payload.simulation;
  $("sim-postseason").textContent = formatPct(s.postseasonProbability);
  $("sim-division").textContent = formatPct(s.divisionWinProbability);
  $("sim-wc1").textContent = formatPct(s.wildCardSeedProbabilities.wc1);
  $("sim-wc2").textContent = formatPct(s.wildCardSeedProbabilities.wc2);
  $("sim-wc3").textContent = formatPct(s.wildCardSeedProbabilities.wc3);
  $("sim-meta").textContent = `${s.iterations.toLocaleString()} simulated seasons, seed ${s.seed}. Log5 win probabilities from current record, .54 home field adjustment, every remaining NL game simulated. See methodology.`;
}

function makeSvg(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function renderSparkline(history, asOfDate) {
  const wrap = $("sparkline-wrap");
  wrap.innerHTML = "";
  const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : 1));

  if (sorted.length < 2) {
    wrap.textContent = "Not enough tracked days yet for a trend line.";
    $("sparkline-caption").textContent = "";
    return;
  }

  const width = 600;
  const height = 80;
  const padding = 4;
  const values = sorted.map((h) => h.postseasonProbability);
  const max = Math.max(...values, 0.0001);
  const min = 0;

  const points = sorted.map((h, i) => {
    const x = padding + (i / (sorted.length - 1)) * (width - padding * 2);
    const y = height - padding - ((h.postseasonProbability - min) / (max - min || 1)) * (height - padding * 2);
    return [x, y];
  });

  const svg = makeSvg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-labelledby": "sparkline-title",
  });
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.id = "sparkline-title";
  title.textContent = `Postseason probability trend from ${formatDate(sorted[0].date)} to ${formatDate(sorted[sorted.length - 1].date)}, ${formatPct(values[0])} to ${formatPct(values[values.length - 1])}.`;
  svg.appendChild(title);

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  svg.appendChild(makeSvg("path", { d: path, fill: "none", stroke: "#fdb827", "stroke-width": "2" }));

  const last = points[points.length - 1];
  svg.appendChild(makeSvg("circle", { cx: last[0], cy: last[1], r: 3, fill: "#fdb827" }));

  wrap.appendChild(svg);

  $("sparkline-caption").textContent =
    `${formatDate(sorted[0].date)}: ${formatPct(values[0])} → ${formatDate(sorted[sorted.length - 1].date)}: ${formatPct(values[values.length - 1])}`;

  // A <table> ignores an explicit width smaller than its content's minimum
  // under auto table layout, so .sr-only (which relies on being clipped to
  // 1px) has to go on a wrapping div, not the table itself.
  const srWrap = document.createElement("div");
  srWrap.className = "sr-only";
  srWrap.innerHTML =
    "<table><caption>Daily postseason probability</caption><thead><tr><th>Date</th><th>Probability</th></tr></thead><tbody>" +
    sorted.map((h) => `<tr><td>${h.date}</td><td>${formatPct(h.postseasonProbability)}</td></tr>`).join("") +
    "</tbody></table>";
  wrap.appendChild(srWrap);
}

function renderHistogram(distribution) {
  const wrap = $("histogram-wrap");
  wrap.innerHTML = "";
  if (!distribution || distribution.length === 0) {
    wrap.textContent = "No distribution data.";
    return;
  }

  const width = 600;
  const height = 140;
  const padding = 20;
  const max = Math.max(...distribution.map((d) => d.probability));
  const barWidth = (width - padding * 2) / distribution.length;

  const svg = makeSvg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-labelledby": "histogram-title",
  });
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.id = "histogram-title";
  const peak = distribution.reduce((a, b) => (b.probability > a.probability ? b : a));
  title.textContent = `Distribution of Pittsburgh's simulated final win total, ranging from ${distribution[0].wins} to ${distribution[distribution.length - 1].wins} wins. Most likely: ${peak.wins} wins at ${formatPct(peak.probability)}.`;
  svg.appendChild(title);

  distribution.forEach((d, i) => {
    const barHeight = (d.probability / max) * (height - padding * 2);
    const x = padding + i * barWidth;
    const y = height - padding - barHeight;
    const isPeak = d.wins === peak.wins;
    svg.appendChild(
      makeSvg("rect", {
        x: x + 0.5,
        y,
        width: Math.max(barWidth - 1, 1),
        height: barHeight,
        fill: isPeak ? "#fdb827" : "#4a4d53",
      })
    );
  });

  // axis labels: min, peak, max win totals
  [distribution[0], peak, distribution[distribution.length - 1]].forEach((d) => {
    const i = distribution.indexOf(d);
    const x = padding + i * barWidth + barWidth / 2;
    svg.appendChild(
      makeSvg("text", {
        x,
        y: height - 4,
        "text-anchor": "middle",
        fill: "#9a9da3",
        "font-size": "10",
        "font-family": "monospace",
      })
    ).textContent = String(d.wins);
  });

  wrap.appendChild(svg);
  $("histogram-caption").textContent = `Most likely finish: ${peak.wins} wins (${formatPct(peak.probability)}). Range shown: ${distribution[0].wins}-${distribution[distribution.length - 1].wins} wins.`;

  const srWrap = document.createElement("div");
  srWrap.className = "sr-only";
  srWrap.innerHTML =
    "<table><caption>Distribution of simulated final win totals</caption><thead><tr><th>Wins</th><th>Probability</th></tr></thead><tbody>" +
    distribution.map((d) => `<tr><td>${d.wins}</td><td>${formatPct(d.probability)}</td></tr>`).join("") +
    "</tbody></table>";
  wrap.appendChild(srWrap);
}

async function main() {
  let payload;
  let history;
  try {
    [payload, history] = await Promise.all([fetchJson("data/current.json"), fetchJson("data/history.json")]);
  } catch (err) {
    document.querySelector(".app").innerHTML =
      '<p style="color:#d9584f">Could not load tracker data. Try reloading, or check back after the next nightly refresh.</p>';
    console.error(err);
    return;
  }

  const teamMetaById = new Map(
    payload.nlWildCard.teams.map((t) => [t.teamId, { name: t.name, abbreviation: t.abbreviation }])
  );
  const isNewData = isNewSinceLastVisit(payload.asOfDate);

  renderMasthead(payload);
  renderModeBanner(payload);
  renderStatus(payload, history, isNewData);
  renderScoreboard(payload, teamMetaById, isNewData);
  renderStandings(payload, teamMetaById);
  renderThresholdTable(payload, teamMetaById);
  renderHeadToHeadNotes(payload);
  renderSimulation(payload);
  renderSparkline(history, payload.asOfDate);
  renderHistogram(payload.simulation.finalWinsDistribution);
}

main();
