// Bad-quote guard for the coin books. Paper only.
// Why: on 2026-11-23 three trend-rotate rows for PUMP were settled at a quote
// near $11.9 against a ~$0.0027 entry (about 4,400x in under five minutes).
// Each $2 line booked about +$8,400. One bad tick like that turned the coin
// repair gate to "pass" and the shadow book to +$24,972.
// Rule (fixed here, not fitted to any row): a coin quote more than 100x the
// position's entry price is treated as a feed error. There is no floor: a coin
// that rugs to near zero is a real loss and stays in every tally.
// The tick is skipped and the position stays open. Rows already settled on such
// a quote stay in the journal, untouched, and are set aside from every gate and
// tally. Nothing here changes the stop, the take-profit, the $2 size, the edge
// gate or live_execution.

export const QUOTE_MAX_RATIO = 100;

// True when px is usable against this entry.
export function saneQuote(entry, px) {
  if (!(entry > 0) || !(px > 0)) return false;
  return px / entry <= QUOTE_MAX_RATIO;
}

// Settled coin row whose exit price sits outside the band.
export function isQuoteError(row) {
  if (!row || !(row.entry > 0) || !(row.exitPx > 0)) return false;
  return !saneQuote(row.entry, row.exitPx);
}

export function withoutQuoteErrors(rows) {
  return (rows || []).filter((row) => !isQuoteError(row));
}

export function quoteErrorCount(rows) {
  return (rows || []).filter(isQuoteError).length;
}
