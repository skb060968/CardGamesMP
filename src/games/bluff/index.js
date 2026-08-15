// Public Bluff module surface.

export {
  BLUFF_RANKS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_PLACEMENT_CARDS,
  DECK_SIZE,
  PRNG_ALGORITHM,
  createGame,
  placeCards,
  passCard,
  acceptPlacement,
  deriveChallengeOutcome,
  resolveChallenge,
  validateState,
  serializeState,
} from './engine.js';
export { createBluffAction } from './bluff-action.js';
export { createBluffTransitionValidator } from './bluff-transition.js';
export { createBluffRuntime } from './runtime.js';
export { createBluffEffects } from './effects.js';
export {
  renderGameplay,
  renderRankSelector,
  hideRankSelector,
  renderChallengeResult,
  hideChallengeResult,
  renderResults,
  renderLobbyPlayers,
  renderReadyIndicators,
  setEventMessage,
  getSelectedCardIds,
  clearSelection,
} from './ui.js';
