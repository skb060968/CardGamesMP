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

export function createPokerTransitionValidator(rules) {
  requireFunction(rules?.performAction, 'rules.performAction');
  requireFunction(rules?.validateState, 'rules.validateState');

  return ({ currentState, nextState, action } = {}) => {
    if (action?.type !== 'poker-action') return { valid: false, reason: 'unsupported-action' };
    if (typeof action.moveId !== 'string' || !action.moveId.trim()) {
      return { valid: false, reason: 'missing-move-id' };
    }
    if (currentState?.status !== 'betting') return { valid: false, reason: 'game-not-betting' };
    if (currentState.currentPlayerIndex !== action.playerIndex) {
      return { valid: false, reason: 'wrong-turn' };
    }
    if (!Number.isSafeInteger(currentState.revision)
      || action.expectedRevision !== currentState.revision) {
      return { valid: false, reason: 'revision-mismatch' };
    }
    if (typeof action.action !== 'string') return { valid: false, reason: 'invalid-action' };

    try {
      const replay = rules.performAction(currentState, action.playerIndex, { type: action.action });
      const integrity = rules.validateState(replay);
      if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };
      const expected = { ...replay, revision: currentState.revision + 1 };
      return sameValue(expected, nextState)
        ? { valid: true }
        : { valid: false, reason: 'state-transition-mismatch' };
    } catch (_) {
      return { valid: false, reason: 'invalid-transition' };
    }
  };
}
