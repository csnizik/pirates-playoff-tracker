const BASE_URL = "https://statsapi.mlb.com/api/v1";
const USER_AGENT =
  "pirates-playoff-tracker/1.0 (+https://github.com/csnizik/pirates-playoff-tracker; contact: casinnola@gmail.com)";
const REQUEST_DELAY_MS = 750;
const REQUEST_TIMEOUT_MS = 15000;

let lastRequestAt = 0;
let requestCount = 0;

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
  }
}

/**
 * Fetch a single MLB Stats API endpoint. Throws on non-200, on a non-JSON body,
 * or on timeout. Callers are responsible for validating the shape of the result.
 */
export async function mlbGet(path, params = {}) {
  await throttle();

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Request failed for ${url}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
    lastRequestAt = Date.now();
    requestCount += 1;
  }

  if (!response.ok) {
    throw new Error(`MLB API returned ${response.status} ${response.statusText} for ${url}`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`MLB API returned non-JSON body for ${url}: ${text.slice(0, 200)}`);
  }

  return body;
}

export function getRequestCount() {
  return requestCount;
}
