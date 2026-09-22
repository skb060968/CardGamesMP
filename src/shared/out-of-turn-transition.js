/**
 * Standard out-of-turn moves shared by every game (see GAME-SCAFFOLD-CHECKLIST §6):
 *
 *   skip-turn  — the watchdog: a connected seat (`actorIndex`) advances the game
 *                past the offline current player (`playerIndex`). The engine's
 *                `skipTurn(state)` decides what "advancing" means for that game.
 *   claim-win  — everyone else is offline: the actor ends the round as winner via
 *                the engine's `claimWin(state, actorIndex)`.
 *
 * The store has already confirmed presence inside its transaction; this module
 * only proves the state transition is the deterministic one the engine produces.
 * Returns `null` for any other action type so the game's own validator runs.
 */

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export const OUT_OF_TURN_TYPES = Object.freeze(['skip-turn', 'claim-win']);

export function isOutOfTurnAction(action) {
  return OUT_OF_TURN_TYPES.includes(action?.type);
}

/**
 * @param {object} rules - engine module exposing `skipTurn`, `claimWin`, `validateState`
 * @param {{ activeStatus?: string }} options - the status a running round carries ('playing' by default)
 */
export function createOutOfTurnTransitionValidator(rules, { activeStatus = 'playing' } = {}) {
  requireFunction(rules?.skipTurn, 'rules.skipTurn');
  requireFunction(rules?.claimWin, 'rules.claimWin');
  requireFunction(rules?.validateState, 'rules.validateState');

  return ({ currentState, nextState, action }) => {
    if (!isOutOfTurnAction(action)) return null;
    if (currentState?.status !== activeStatus) return { valid: false, reason: 'game-not-playing' };
    const seats = currentState.players?.length ?? 0;
    const validSeat = (index) => Number.isInteger(index) && index >= 0 && index < seats;
    if (!validSeat(action.actorIndex) || !validSeat(action.playerIndex)) {
      return { valid: false, reason: 'invalid-player' };
    }

    let produced;
    try {
      if (action.type === 'skip-turn') {
        if (currentState.currentPlayerIndex !== action.playerIndex) return { valid: false, reason: 'wrong-turn' };
        if (action.actorIndex === action.playerIndex) return { valid: false, reason: 'self-skip' };
        produced = rules.skipTurn(currentState);
      } else {
        if (action.actorIndex !== action.playerIndex) return { valid: false, reason: 'claim-actor-mismatch' };
        produced = rules.claimWin(currentState, action.actorIndex);
      }
    } catch (error) {
      return { valid: false, reason: error?.message || 'engine-rejected' };
    }
    if (!produced) return { valid: false, reason: 'engine-rejected' };

    // Some engines bump `revision` themselves (Bluff), the others leave it to the caller.
    const expected = produced.revision === currentState.revision + 1
      ? produced
      : { ...produced, revision: currentState.revision + 1 };
    const integrity = rules.validateState(expected);
    if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };
    return sameValue(expected, nextState)
      ? { valid: true }
      : { valid: false, reason: 'state-transition-mismatch' };
  };
}
