const CHICAGO_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Returns the current wall-clock date in America/Chicago as YYYY-MM-DD.
 * Uses the calendar date only, so it is safe across the DST boundary.
 */
export function chicagoDateString(now = new Date()) {
  return CHICAGO_FORMATTER.format(now);
}

/**
 * Adds (or subtracts) whole days to a YYYY-MM-DD string using UTC-noon-safe
 * arithmetic, so the result is never shifted by a local timezone offset.
 */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split("-").map(Number);
  const [ty, tm, td] = toDateStr.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}
