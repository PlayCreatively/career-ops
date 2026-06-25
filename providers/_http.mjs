// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

// Retry policy for transient throttling (429 / 503). We retry a couple of times
// with short backoff, but we will NOT wait out a long `Retry-After`: a host that
// asks us to wait minutes/hours (e.g. Cloudflare 1015 IP bans, which return
// Retry-After in the tens of thousands of seconds) is given up on immediately so
// one rate-limited host can't stall the whole scan. The error message surfaces
// the requested wait so the failure is legible instead of a cryptic "HTTP 429".
const DEFAULT_RETRIES = 2;          // up to 3 attempts total
const MAX_RETRY_WAIT_MS = 8_000;    // never sleep longer than this between tries
const RETRYABLE_STATUS = new Set([429, 503]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse a Retry-After header (delta-seconds or HTTP-date). Returns ms, or null.
function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = opts;

  for (let attempt = 0; ; attempt++) {
    const { res, err } = await attemptFetch(url, opts, timeoutMs);
    if (res) return res;

    // Decide whether to retry. Only retry the explicit transient statuses; let
    // timeouts/network errors and all other HTTP errors propagate as before.
    const retryable = err.status != null && RETRYABLE_STATUS.has(err.status);
    if (!retryable || attempt >= retries) throw err;

    const askedMs = parseRetryAfter(err.retryAfter);
    if (askedMs != null && askedMs > MAX_RETRY_WAIT_MS) {
      // A long cool-down (typically an IP-level ban). Don't wait it out.
      const mins = Math.round(askedMs / 60_000);
      const human = mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
      err.message = `HTTP ${err.status}: rate-limited, Retry-After ~${human} — giving up (likely IP-level throttle). ${err.message}`;
      throw err;
    }
    // Honor a short Retry-After, else exponential backoff (1s, 2s, …) capped.
    const waitMs = Math.min(askedMs ?? 1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
    await sleep(waitMs);
  }
}

async function attemptFetch(url, { headers = {}, method = 'GET', body = null, redirect = 'follow' }, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 300);
      const err = new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
      err.status = res.status;
      err.body = responseText;
      err.retryAfter = res.headers.get('retry-after');
      return { res: null, err };
    }
    return { res, err: null };
  } catch (err) {
    return { res: null, err };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.text();
}

// Classify a fetch failure so the scanner can tell a real "miss" (we were
// blocked/throttled and never saw this company's jobs) apart from a benign
// outcome (genuine 404, or a successful fetch that returned 0 jobs). Returns
// one of: 'throttled' | 'blocked' | 'notfound' | 'timeout' | 'network' | 'http'.
// Exported (and unit-tested) so the classification stays in one place.
export function classifyFetchError(err) {
  if (!err) return 'http';
  if (err.name === 'AbortError') return 'timeout';
  const status = err.status;
  const msg = String(err.message || '');
  // Cloudflare 1015 ("error code: 1015") and generic rate-limit copy ride in on
  // a 429, but some edges dress them up as 403/503 — match the body too.
  if (status === 429 || status === 503 || /error code:\s*1015|rate[\s-]?limit|too many requests/i.test(msg)) {
    return 'throttled';
  }
  if (status === 401 || status === 403) return 'blocked';
  if (status === 404) return 'notfound';
  if (status != null) return 'http';
  return 'network';
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
