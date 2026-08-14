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

export function createPerfectTenDiscardTransitionValidator(rules) {
  requireFunction(rules?.discardCard, 'rules.discardCard');
  requireFunction(rules?.validateState, 'rules.validateState');

  return ({ currentState, nextState, action } = {}) => {
    if (typeof action?.moveId !== 'string' || !action.moveId.trim()) {
      return { valid: false, reason: 'missing-move-id' };
    }
    if (currentState?.status !== 'playing') return { valid: false, reason: 'game-not-playing' };
    if (currentState.currentPlayerIndex !== action.playerIndex) return { valid: false, reason: 'wrong-turn' };
    if (currentState.turnPhase !== 'discard') return { valid: false, reason: 'wrong-phase' };
    const revision = Number.isSafeInteger(currentState.revision) ? currentState.revision : 0;
    if (action.expectedRevision !== revision) return { valid: false, reason: 'revision-mismatch' };
    const hand = currentState.players?.[action.playerIndex]?.hand;
    if (!Number.isInteger(action.handIndex) || !Array.isArray(hand) || !hand[action.handIndex]) {
      return { valid: false, reason: 'invalid-hand-index' };
    }
    if (!sameValue(hand[action.handIndex], action.card)) return { valid: false, reason: 'card-mismatch' };

    try {
      const result = rules.discardCard(currentState, action.handIndex);
      if (!result?.newState) return { valid: false, reason: 'invalid-discard-result' };
      if (!Object.prototype.hasOwnProperty.call(action, 'won')
        || action.won !== (result.won === true)) {
        return { valid: false, reason: 'win-mismatch' };
      }
      if (!Object.prototype.hasOwnProperty.call(action, 'winGroups') || action.winGroups !== null) {
        return { valid: false, reason: 'win-groups-must-be-null' };
      }
      if (Object.prototype.hasOwnProperty.call(result, 'winGroups')) {
        return { valid: false, reason: 'unexpected-engine-win-groups' };
      }
      const integrity = rules.validateState(result.newState);
      if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };
      const expected = { ...result.newState, revision: revision + 1 };
      return sameValue(expected, nextState)
        ? { valid: true }
        : { valid: false, reason: 'state-transition-mismatch' };
    } catch (_) {
      return { valid: false, reason: 'invalid-transition' };
    }
  };
}