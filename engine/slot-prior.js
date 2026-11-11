// Overwritten by runner/study-slots.mjs. Until that file is regenerated, no slot
// has a holdout edge, so every slot is exploration size.
export const SLOT_PRIOR = {
  id: 'pending',
  collectedAt: null,
  summary: 'The multi-strategy holdout has not been written into this build yet. Every slot trades at exploration size.',
  edges: { meanrev: false, breakout: false, momentum: false, grid: false },
  rows: [],
};
