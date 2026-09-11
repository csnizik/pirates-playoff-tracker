# Pirates Playoff Tracker

A data terminal for Pittsburgh's National League wild card chase. Served as a static
GitHub Page, refreshed nightly by a GitHub Action that pulls from the unofficial MLB
Stats API, runs a Monte Carlo playoff simulation, and writes a single JSON payload the
page reads on load. No server, no client-side API calls, no build step.

The odds shown here are a model, not a prediction. It ignores starting pitchers,
injuries, rest, and weather. See "Simulation methodology" below for exactly what it
does and does not account for. The page will never round a small number up to make the
Pirates look better than they are.

## Architecture

```
/
  index.html              static page, reads data/current.json once on load
  assets/                 css, js, vendored fonts
  data/
    current.json          the payload the page renders from
    history.json           append-only daily snapshots, feeds the trend sparkline
    .last-good.json        belt-and-suspenders backup of the last valid payload
  scripts/
    lib/                   shared modules (API client, date math, standings
                            normalization, tiebreakers, elimination math, RNG, log5)
    fetch-mlb.mjs          pulls raw data from statsapi.mlb.com
    simulate.mjs           Monte Carlo season simulator
    build-data.mjs         orchestrates fetch -> normalize -> simulate -> validate -> write
    validate.mjs           payload validator, run before anything is written
  .github/workflows/
    nightly.yml            cron job, 3:00 AM America/Chicago
```

Run the pipeline locally with:

```
node scripts/build-data.mjs
```

## Data source

[MLB Stats API](https://statsapi.mlb.com/api/v1/), unofficial and undocumented. No key,
no auth. The pipeline is a polite client: one request in flight at a time, a real
User-Agent identifying this project, roughly 750ms between requests, and well under 10
requests per nightly run (currently 7: teams, NL wild card standings, NL by-division
standings, AL by-division standings, yesterday's league schedule, the NL-involving
remaining schedule, and the NL-involving season-to-date schedule).

Because it's unofficial, the schema can change without warning. The validator (see
below) is the safety net: if a response doesn't have the shape the pipeline expects, the
build fails loudly instead of writing wrong numbers.

### Things about this API that are not obvious from its shape

- **Postponed games leave a permanent "ghost" entry.** A rained-out game keeps its
  original date and gamePk with `status.abstractGameState: "Final"` but
  `status.codedGameState: "D"` (postponed) and null scores. The real makeup game is a
  *separate* gamePk on the rescheduled date. Checking `abstractGameState === "Final"`
  alone will misclassify these as completed games with a 0-0 final. The pipeline treats
  a game as completed only when `codedGameState === "F"` and both scores are numbers.
- **`standingsTypes=wildCard` omits the three division leaders entirely.** It only
  returns the non-leader contenders. The full 15-team National League pool comes from
  merging this with `standingsTypes=byDivision`, which does include every team.
- **No `lastTwenty` split exists.** The last-20-games tiebreaker is derived by hand from
  the season-to-date schedule, not read from a standings field.
- **No head-to-head field exists either.** Also derived from the schedule, by filtering
  for games between exactly two team IDs.
- **A game entry's `leagueRecord` is the team's record entering that game, not after
  it.** Don't use it to compute "record after last night" deltas.
- Team ids, league ids, and division ids are all read from the `/teams` endpoint at
  build time. The only ID hardcoded anywhere in this codebase is Pittsburgh's, 134.

## data/current.json schema (version 1)

Top level:

| field | type | meaning |
|---|---|---|
| `schemaVersion` | number | currently `1` |
| `generatedAt` | ISO string | when this file was built |
| `season` | number | MLB season year |
| `asOfDate` | YYYY-MM-DD | the date the `scoreboard` section covers (see below) |
| `mode` | enum | `IN_RACE`, `CLINCHED`, `ELIMINATED`, `POSTSEASON`, or `OFFSEASON`. Drives which UI state the page renders; the page does not compute this itself. |
| `pirates` | object | Pittsburgh's current record, remaining games, clinch/elimination flags, and elimination number. Always reflects live current standings regardless of `asOfDate`. |
| `scoreboard` | object | that day's NL scoreboard (still-live teams only), with each final result's effect on the gap to Pittsburgh, and a scheduled start time instead of a score for games not yet final |
| `nlWildCard` | object | full 15-team NL standings pool with wild card specific fields, plus each team's `divisionRecord` and `last20` for tiebreak resolution |
| `thresholdTable` | object | for each possible Pittsburgh finish, the most wins each rival can post and still finish behind |
| `headToHeadNotes` | array | remaining season series between two still-live NL teams, and the guaranteed win floor that creates (curated for the page's narrative section) |
| `headToHeadRemaining` | array | every NL pair's remaining head-to-head game count, unfiltered — feeds the scenario explorer's feasibility check |
| `headToHeadRecords` | array | full to-date head-to-head matrix between NL teams — feeds the scenario explorer's tiebreak resolution |
| `simulation` | object | Monte Carlo results: postseason probability, division probability, wild card seed probabilities, final wins distribution |
| `postseason` | object or null | populated only in `POSTSEASON` mode |
| `eliminatedState` | object or null | populated only in `ELIMINATED` mode, the frozen final numbers |

See a live example by running the pipeline, or reading `data/current.json` directly —
it's the authoritative reference for exact field names.

`data/history.json` is a separate flat array, one entry per day
(`{ date, generatedAt, piratesWins, piratesLosses, postseasonProbability,
divisionWinProbability }`), appended to nightly and de-duplicated by date so re-running
the same day is safe.

### Which day the scoreboard section covers

`pirates` and `nlWildCard` always reflect live current standings, whatever time the
build runs. `scoreboard` (and `asOfDate`) are pinned to one specific day, because a
day's games move from not-yet-played to final over the course of that day, and the
scoreboard needs to render each game consistently rather than mixing states from
different fetches.

The scheduled 3am America/Chicago run always uses **yesterday** — at 3am, today's games
haven't been played yet, so "yesterday" is the last day with anything to report. A
manual run (`workflow_dispatch`, or `node scripts/build-data.mjs` with
`SCOREBOARD_DATE_MODE=today` set) can ask for **today** instead, once today's games are
underway or finished, so a mid-day or evening check-in shows today's results rather than
waiting for the overnight run. This is exactly what running the workflow by hand from
the Actions tab with the "today" option gets you.

Within that chosen day, each still-live NL team's game (if it has one) renders as one of:
a final score, a scheduled start time if the game hasn't started yet, or nothing at all
if the game is currently in progress — this is a once-a-day digest, not a live
scoreboard, so an in-progress game is only ever reported once it reaches final.

## Simulation methodology

**Per-game win probability**: [Bill James' log5 formula](https://en.wikipedia.org/wiki/Log5)
using each team's current season winning percentage, with a home field adjustment of
.54 applied as an odds-ratio nudge off a neutral .500 reference (see
`scripts/lib/log5.mjs`). Team strength is held fixed at its current-to-date value for
the whole simulated season; the model does not account for hot streaks, injuries,
rotation, or roster changes, and does not know who is pitching.

**Every remaining NL game is simulated**, not just the contenders' games, so a
collapsing division leader can fall into the wild card pool. Interleague opponents
(American League teams) are simulated as single games using their current winning
percentage as a fixed input; their own remaining schedule isn't simulated forward since
it can't affect the NL wild card race.

**Tiebreakers**, applied in this order, exactly as specified for this project: head to
head season series (including simulated remaining head-to-head games within that
iteration), then intradivision record, then record in the last 20 games. There is no
game 163 under current rules. In the extremely rare case where a 3+ way tie survives all
three criteria, it's broken by a coin flip drawn from the same seeded RNG used for the
rest of that iteration, and that's clearly a modeling artifact rather than a real rule.

**Seeding**: the RNG (`scripts/lib/rng.mjs`, mulberry32) is seeded from a hash of the
build's `asOfDate`, so a given day's inputs always reproduce the same simulation output.
Minimum 25,000 iterations per run.

## Clinch and elimination math

Elimination and clinching are computed from the remaining schedule, not inferred from
the simulated odds hitting 0% or 100%.

A team is **eliminated from the postseason** once it's eliminated from both its division
and the wild card:

- Eliminated from the division: its maximum possible wins (current wins + games
  remaining) can't even tie the best division mate's *current* wins.
- Eliminated from the wild card: at least 3 other NL teams already have current wins
  exceeding this team's maximum possible wins — meaning their *guaranteed floor* alone
  already beats this team's *ceiling*, regardless of anything else that happens.

A team **clinches a postseason spot** the mirror-image way: once its current wins
already exceed the ceiling of everyone who could otherwise take its spot.

This is the standard "trivial elimination" test used by most public magic-number
trackers, and it is a sound one-directional bound: it will never announce a clinch or
elimination early. In rare, tightly bunched multi-team scenarios, the absolute earliest
mathematically provable elimination or clinch day (which requires a full network-flow
feasibility analysis across every contender simultaneously) can be a few days earlier
than what this test reports. That tradeoff was chosen deliberately for auditability over
exhaustive combinatorial analysis.

The single **elimination number** shown in the status header is a different, simpler
number: the classic two-team magic number against whichever team currently holds the
3rd wild card spot. Concretely, for Pittsburgh's ceiling `C` and that rival's current
wins `w`, it's `max(C - w + 1, 0)`. This is a real but incomplete bound — it only
accounts for one rival, not the full field — so it will typically run a few games higher
than MLB's own (unpublished-methodology) elimination number. It's shown for legibility,
not as the trigger for the `ELIMINATED` mode; that's driven by the multi-team test above.

## Threshold table

For each possible Pittsburgh finish `F` (current wins through winning out), and each
rival with `w` current wins and `g` games remaining:

```
maxWinsToStayBehind = clamp(F - 1 - w, 0, g)
```

A value of `0` means that rival has to lose out to finish behind Pittsburgh's finish of
`F`. A value equal to `g` means that rival could win every remaining game and still
finish behind — i.e., this Pittsburgh finish doesn't even need help from that team.

Separately, a rival is flagged `isStillAThreat: false` once its own maximum possible
wins already falls below Pittsburgh's ceiling (best case, running the table) — meaning
no Pittsburgh outcome, however good, could still be caught by that rival.

Every other NL team is included as a rival, including the three current division
leaders, each tagged `isDivisionLeader: true`. A division leader's row in this table is
conditional, not a live requirement: a division leader makes the postseason by winning
their division regardless of how their win total compares to Pittsburgh's, so their
`maxWinsToStayBehind` number only becomes relevant in the scenario where they lose their
own division lead and fall into the wild card pool. The page must present a leader's row
that way — never as something Pittsburgh currently "needs" from them — or it
misrepresents the actual playoff mechanism.

## Head-to-head structural notes

For every pair of still-live NL teams with games remaining against each other, the
pipeline surfaces the plain fact that whoever wins that season series is guaranteed at
least `ceil(games / 2)` of those wins toward their final total — a real floor the
schedule creates, not a prediction of who wins it.

## Scenario explorer

Client side (`assets/js/scenario.js`), reading `data/current.json` directly — no
simulation runs in the browser. A slider per NL team sets how many of its remaining
games it wins; the tool then works out division winners and the wild card top 3 from
those totals and reports Pittsburgh's outcome.

**Feasibility is checked before anything is reported.** `data/current.json` includes
`headToHeadRemaining` (every NL pair's remaining game count against each other,
unfiltered by elimination status). For a pair sharing `n` games left, a team can get at
most `n` of its chosen wins from that pair; if the combined minimum wins the two teams'
inputs require from their shared games exceeds `n`, the combination is flagged
impossible and named explicitly (which two teams, how many games, how many wins each
input demands) instead of producing a result. This is the same head-to-head-games
constraint the spec calls out: two rivals can't both go 3-0 against each other in a
3-game set.

**Ties** are broken with the same three criteria as the nightly simulation — head-to-head
among the tied teams, then intradivision record, then last-20 record — using
`headToHeadRecords` (the full to-date head-to-head matrix) and each team's
`divisionRecord`/`last20`, both included in the payload. Unlike the nightly simulation,
this tool has no per-game outcomes to fall back on, so a tie that survives all three
criteria is reported as a tie, not guessed with a coin flip: if Pittsburgh's own
placement depends on such a tie, the result names the team it's tied with and says so
plainly.

**Presets**: "Pirates run the table" sets Pittsburgh to win out and every other team to
its current-pace projection (`round(current win pct x games remaining)`); "Everyone
plays .500" sets every team, Pittsburgh included, to as close to .500 the rest of the
way as integer wins allow; "Cheapest path in" holds every other team at its pace
projection and searches upward from zero for the fewest Pittsburgh wins that still
produce a postseason spot, honestly reporting "even running the table" territory if
that's what it takes rather than a softer number. "Reset to current pace" returns every
slider to the pace projection.

## Failure handling

The build validates its own output (team counts, win/loss/games-played consistency,
non-negative games remaining, simulation probabilities in [0,1] and summing correctly,
threshold table row counts) before writing anything. If the fetch fails, the API returns
an unexpected shape, or validation fails, the process exits non-zero and
`data/current.json` is left untouched — verified by pointing the client at an
unreachable host and confirming the existing file's contents were unchanged and the
process exited 1. `data/.last-good.json` is a second copy of the last valid payload, and
the page shows a stale-data banner if `generatedAt` is more than 30 hours old.
