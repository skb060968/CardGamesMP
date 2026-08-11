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

export function createFlipAndMatchTransitionValidator(rules) {
  requireFunction(rules?.flipCard, 'rules.flipCard');
  requireFunction(rules?.checkGameEnd, 'rules.checkGameEnd');
  requireFunction(rules?.validateState, 'rules.validateState');

  return ({ currentState, nextState, action }) => {
    if (currentState?.status !== 'playing') return { valid: false, reason: 'game-not-playing' };
    if (currentState.currentPlayerIndex !== action.playerIndex) {
      return { valid: false, reason: 'wrong-turn' };
    }
    if (!Number.isInteger(action.cardIndex)) return { valid: false, reason: 'invalid-card-index' };
    const currentCard = currentState.board?.[action.cardIndex]?.card;
    if (!currentCard || !sameValue(currentCard, action.card)) {
      return { valid: false, reason: 'card-mismatch' };
    }

    try {
      const replay = rules.flipCard(currentState, action.cardIndex, action.playerIndex);
      if (replay.matched !== action.matched) return { valid: false, reason: 'match-mismatch' };
      if (replay.matchedIndex !== action.matchedIndex) {
        return { valid: false, reason: 'matched-index-mismatch' };
      }
      const integrity = rules.validateState(replay.newState);
      if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };

      const end = rules.checkGameEnd(replay.newState);
      const resolved = end.finished ? {
        ...replay.newState,
        status: 'finished',
        winnerIndex: end.winnerIndex,
        isTie: end.isTie,
        tiedIndices: end.tiedIndices,
      } : replay.newState;
      const expected = { ...resolved, revision: currentState.revision + 1 };
      return sameValue(expected, nextState)
        ? { valid: true }
        : { valid: false, reason: 'state-transition-mismatch' };
    } catch (_) {
      return { valid: false, reason: 'invalid-flip' };
    }
  };
}
