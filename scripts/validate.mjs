const VALID_MODES = ["IN_RACE", "CLINCHED", "ELIMINATED", "POSTSEASON", "OFFSEASON"];

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Validates a data/current.json payload before it is written. Returns
 * { valid, errors }. Any failure here must abort the nightly job without
 * touching the existing file, per the pipeline's failure-handling contract.
 */
export function validatePayload(payload) {
  const errors = [];

  if (payload.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${payload.schemaVersion}`);
  }
  if (!payload.generatedAt || Number.isNaN(Date.parse(payload.generatedAt))) {
    errors.push(`generatedAt is not a valid ISO timestamp: ${payload.generatedAt}`);
  }
  if (!VALID_MODES.includes(payload.mode)) {
    errors.push(`mode "${payload.mode}" is not one of ${VALID_MODES.join(", ")}`);
  }

  const pirates = payload.pirates;
  if (!pirates) {
    errors.push("missing pirates block");
  } else {
    if (pirates.wins + pirates.losses <= 0) {
      errors.push("pirates wins+losses must be positive");
    }
    if (pirates.gamesRemaining < 0) {
      errors.push(`pirates gamesRemaining is negative: ${pirates.gamesRemaining}`);
    }
    if (pirates.eliminationNumberWildCard !== null && pirates.eliminationNumberWildCard < 0) {
      errors.push(`pirates eliminationNumberWildCard is negative: ${pirates.eliminationNumberWildCard}`);
    }
  }

  const nlTeams = payload.nlWildCard?.teams ?? [];
  const expectedTeamCount = 15;
  if (nlTeams.length !== expectedTeamCount) {
    errors.push(`expected ${expectedTeamCount} NL teams, got ${nlTeams.length}`);
  }
  for (const t of nlTeams) {
    if (t.wins + t.losses !== t.gamesPlayed) {
      errors.push(`team ${t.teamId}: wins+losses (${t.wins}+${t.losses}) != gamesPlayed (${t.gamesPlayed})`);
    }
    if (t.gamesRemaining < 0) {
      errors.push(`team ${t.teamId}: negative gamesRemaining (${t.gamesRemaining})`);
    }
    if (t.maxPossibleWins < t.wins) {
      errors.push(`team ${t.teamId}: maxPossibleWins (${t.maxPossibleWins}) < current wins (${t.wins})`);
    }
    if (!t.divisionRecord || t.divisionRecord.wins < 0 || t.divisionRecord.losses < 0) {
      errors.push(`team ${t.teamId}: missing or invalid divisionRecord`);
    }
    if (!t.last20 || t.last20.wins < 0 || t.last20.losses < 0 || t.last20.wins + t.last20.losses > 20) {
      errors.push(`team ${t.teamId}: missing or invalid last20 record`);
    }
  }

  if (!Array.isArray(payload.headToHeadRemaining)) {
    errors.push("missing headToHeadRemaining array");
  } else {
    for (const h of payload.headToHeadRemaining) {
      if (h.gamesRemaining < 0) {
        errors.push(`headToHeadRemaining ${h.teamAId}-${h.teamBId}: negative gamesRemaining`);
      }
    }
  }

  if (!Array.isArray(payload.headToHeadRecords)) {
    errors.push("missing headToHeadRecords array");
  } else {
    for (const h of payload.headToHeadRecords) {
      if (h.teamAWins < 0 || h.teamBWins < 0) {
        errors.push(`headToHeadRecords ${h.teamAId}-${h.teamBId}: negative win count`);
      }
    }
  }

  const sim = payload.simulation;
  if (!sim) {
    errors.push("missing simulation block");
  } else {
    if (sim.iterations < 25000) {
      errors.push(`simulation iterations below floor: ${sim.iterations}`);
    }
    const probs = [
      sim.postseasonProbability,
      sim.divisionWinProbability,
      sim.wildCardSeedProbabilities?.wc1,
      sim.wildCardSeedProbabilities?.wc2,
      sim.wildCardSeedProbabilities?.wc3,
    ];
    for (const p of probs) {
      if (!isFiniteNumber(p) || p < 0 || p > 1) {
        errors.push(`simulation probability out of [0,1] range: ${p}`);
      }
    }
    const wcSum =
      (sim.wildCardSeedProbabilities?.wc1 ?? 0) +
      (sim.wildCardSeedProbabilities?.wc2 ?? 0) +
      (sim.wildCardSeedProbabilities?.wc3 ?? 0);
    const composite = sim.divisionWinProbability + wcSum;
    if (Math.abs(composite - sim.postseasonProbability) > 0.01) {
      errors.push(
        `postseasonProbability (${sim.postseasonProbability}) should equal divisionWin + wildcard seed sum (${composite})`
      );
    }
    const distSum = (sim.finalWinsDistribution ?? []).reduce((acc, d) => acc + d.probability, 0);
    if (Math.abs(distSum - 1) > 0.01) {
      errors.push(`finalWinsDistribution probabilities sum to ${distSum}, expected ~1`);
    }
  }

  const table = payload.thresholdTable;
  if (!table) {
    errors.push("missing thresholdTable block");
  } else if (table.rows.length !== table.piratesGamesRemaining + 1) {
    errors.push(
      `thresholdTable should have piratesGamesRemaining+1 rows (${table.piratesGamesRemaining + 1}), got ${table.rows.length}`
    );
  }

  return { valid: errors.length === 0, errors };
}
