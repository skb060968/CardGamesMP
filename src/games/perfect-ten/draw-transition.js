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

export function createPerfectTenDrawTransitionValidator(rules) {
  requireFunction(rules?.drawCard, 'rules.drawCard');
  requireFunction(rules?.validateState, 'rules.validateState');

  return ({ currentState, nextState, action } = {}) => {
    if (typeof action?.moveId !== 'string' || !action.moveId.trim()) {
      return { valid: false, reason: 'missing-move-id' };
    }
    if (currentState?.status !== 'playing') return { valid: false, reason: 'game-not-playing' };
    if (currentState.currentPlayerIndex !== action.playerIndex) return { valid: false, reason: 'wrong-turn' };
    if (currentState.turnPhase !== 'draw') return { valid: false, reason: 'wrong-phase' };
    if (action.source !== 'drawPile' && action.source !== 'discardPile') {
      return { valid: false, reason: 'invalid-source' };
    }
    const revision = Number.isSafeInteger(currentState.revision) ? currentState.revision : 0;
    if (action.expectedRevision !== revision) return { valid: false, reason: 'revision-mismatch' };

    try {
      const oldHand = currentState.players?.[action.playerIndex]?.hand;
      if (!Array.isArray(oldHand)) return { valid: false, reason: 'invalid-player' };
      let expected = rules.drawCard(currentState, action.source);
      let card = null;
      if (expected.status !== 'finished') {
        const engineHand = expected.players?.[action.playerIndex]?.hand;
        if (!Array.isArray(engineHand) || engineHand.length !== oldHand.length + 1) {
          return { valid: false, reason: 'invalid-draw-result' };
        }
        card = engineHand[engineHand.length - 1];
        expected = {
          ...expected,
          players: expected.players.map((player, index) => index === action.playerIndex
            ? { ...player, hand: [...oldHand, card] }
            : player),
        };
      }
      if (!sameValue(card, action.card ?? null)) return { valid: false, reason: 'card-mismatch' };
      const integrity = rules.validateState(expected);
      if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };
      expected = { ...expected, revision: revision + 1 };
      return sameValue(expected, nextState)
        ? { valid: true }
        : { valid: false, reason: 'state-transition-mismatch' };
    } catch (_) {
      return { valid: false, reason: 'invalid-transition' };
    }
  };
}