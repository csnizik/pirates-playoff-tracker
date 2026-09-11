/**
 * mulberry32: a small, fast, deterministic PRNG. Same seed always produces
 * the same sequence, which is what makes the nightly simulation repeatable
 * and the "idempotent if run twice" requirement possible.
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives a numeric seed from a date string like "2026-09-10", stable across runs. */
export function seedFromDate(dateStr) {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i += 1) {
    hash = (hash * 31 + dateStr.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
