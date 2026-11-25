// Top 10 holder share from RugCheck when the public Solana RPC rate-limits
// getTokenLargestAccounts (HTTP 429 on every snapshot since 2026-11-22).
// Read-only. No wallet, no key, no order. Paper only.
//
// As strict as the RPC rule in engine/meme.js topHolderShare: only the pool
// itself is left out (AMM accounts, market pubkeys, and the pool's liquidity
// account owners). Lockers and the creator are counted. A failed or missing
// report leaves top10 null, and null still fails the check. The 40% limit in
// MEME_RULES.maxTop10 is not changed.

export const RUG_REPORT_URL = 'https://api.rugcheck.xyz/v1/tokens';
export const RUG_FALLBACK_CAP = 8;

const num = (x) => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export function rugTop10Strict(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.topHolders)) return null;
  const pool = new Set();
  for (const [addr, row] of Object.entries(body.knownAccounts || {})) {
    if (row?.type === 'AMM') pool.add(addr);
  }
  for (const m of body.markets || []) {
    if (m?.pubkey) pool.add(m.pubkey);
    for (const side of [m?.liquidityAAccount, m?.liquidityBAccount]) if (side?.owner) pool.add(side.owner);
  }
  const kept = body.topHolders.filter((h) => h && !pool.has(h.owner) && !pool.has(h.address)).slice(0, 10);
  if (!kept.length) return null;
  let sum = 0;
  for (const h of kept) {
    const pct = num(h.pct);
    if (pct == null || pct < 0) return null;
    sum += pct;
  }
  return Math.min(1, sum / 100);
}

// Fills top10 only when the RPC left it null. A number from the RPC wins.
export function withRugTop10(safety, top10) {
  const base = safety || { mint: null, freeze: null, top10: null, mintDetail: 'lookup failed', freezeDetail: 'lookup failed', top10Detail: 'lookup failed' };
  if (num(base.top10) != null || num(top10) == null) return base;
  return { ...base, top10, top10Detail: undefined, top10Source: 'rugcheck' };
}

// Only coins that clear every other blocking board check need the extra call.
export function wantsRugTop10(score) {
  const reasons = score?.reasons || [];
  const top = reasons.find((r) => r.name === 'top 10 holders');
  if (!top || top.ok === true || score?.features?.top10 != null) return false;
  return reasons.every((r) => r.name === 'top 10 holders' || r.name === 'dev wallet share' || r.name === 'fdv / liquidity' || r.ok === true);
}

export async function fetchRugTop10(ca, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${RUG_REPORT_URL}/${encodeURIComponent(ca)}/report`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return rugTop10Strict(await res.json());
  } catch {
    return null;
  }
}
