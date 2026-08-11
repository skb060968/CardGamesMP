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

export function createPatteParPattaThrowTransitionValidator(rules) {
  requireFunction(rules?.throwCard, 'rules.throwCard');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(rules?.checkWinCondition, 'rules.checkWinCondition');
  requireFunction(rules?.advanceTurn, 'rules.advanceTurn');

  return ({ currentState, nextState, action }) => {
    if (currentState?.status !== 'playing') return { valid: false, reason: 'game-not-playing' };
    if (currentState.currentPlayerIndex !== action.playerIndex) return { valid: false, reason: 'wrong-turn' };
    const currentCard = currentState.players[action.playerIndex]?.hand[action.handIndex];
    if (!currentCard || !sameValue(currentCard, action.card)) return { valid: false, reason: 'card-mismatch' };

    const { newState, captured } = rules.throwCard(currentState, action.handIndex);
    if (captured !== action.captured) return { valid: false, reason: 'capture-mismatch' };
    const integrity = rules.validateState(newState);
    if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };

    const win = rules.checkWinCondition(newState);
    const resolved = win.finished
      ? { ...newState, status: 'finished', winnerIndex: win.winnerIndex }
      : rules.advanceTurn(newState);
    const expected = { ...resolved, revision: currentState.revision + 1 };
    return sameValue(expected, nextState)
      ? { valid: true }
      : { valid: false, reason: 'state-transition-mismatch' };
  };
}