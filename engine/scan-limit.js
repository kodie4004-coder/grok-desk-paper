// Gaps between public GETs. DexScreener's boost lists are about 60/minute,
// GeckoTerminal's free pool list is about 10/minute, and this desk already
// waits 7s between those calls. RugCheck has no published budget here, so a
// 429 backs off instead of hammering it. A host that is not listed is not delayed.

export const HOST_GAP_MS = {
  'api.dexscreener.com': 1100,
  'api.geckoterminal.com': 7000,
  'api.rugcheck.xyz': 1200,
  'syndication.twitter.com': 2000,
};

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

export function medianNumber(values) {
  const nums = [...(values || [])].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function createLimiter({ gaps = HOST_GAP_MS, clock = Date.now, sleep }) {
  const last = new Map();
  return {
    async wait(url) {
      const host = hostOf(url);
      const gap = gaps[host] || 0;
      if (!gap) return;
      const prev = last.get(host);
      if (prev != null) {
        const delay = prev + gap - clock();
        if (delay > 0) await sleep(delay);
      }
      last.set(host, clock());
    },
  };
}

export function limitedFetch(fetchImpl, limiter, sleep, opts = {}) {
  const attempts = opts.attempts ?? 4;
  return async function limited(url, init) {
    let backoff = opts.backoffMs ?? 1000;
    let lastStatus = 0;
    let lastError = 'request failed';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (limiter) await limiter.wait(url);
      try {
        const res = await fetchImpl(url, init);
        lastStatus = res?.status || 0;
        if (res && (res.status === 429 || res.status >= 500) && attempt < attempts) {
          const retry = Number(res.headers?.get?.('retry-after'));
          const wait = Number.isFinite(retry) && retry >= 0 ? Math.min(retry * 1000, 30000) : backoff;
          await sleep(wait);
          backoff = Math.min(backoff * 2, 30000);
          continue;
        }
        return res;
      } catch (e) {
        const aborted = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        if (aborted && init?.signal) throw e;
        lastError = aborted ? 'timeout' : 'request failed';
        if (attempt === attempts) {
          const err = new Error(lastError);
          err.status = lastStatus;
          throw err;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    return { ok: false, status: lastStatus, text: async () => '', json: async () => null, headers: { get() { return null; } } };
  };
}
