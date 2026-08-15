// Authoritative replay validation for unified Bluff actions.

const ACTION_KEYS = new Set([
  'type', 'moveId', 'expectedRevision', 'playerIndex', 'action', 'payload',
]);
const PLACE_KEYS = new Set(['cardIds', 'declaredRank']);
const PIN_KEYS = new Set(['placementMoveId', 'placementRevision']);
const ACTIONS = new Set(['place', 'pass', 'challenge', 'accept']);

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
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
function validPayload(action) {
  if (action.action === 'pass') return action.payload === null;
  if (action.action === 'place') {
    const payload = action.payload;
    return exactKeys(payload, PLACE_KEYS) && Array.isArray(payload.cardIds)
      && payload.cardIds.length >= 1 && payload.cardIds.length <= 4
      && payload.cardIds.every((id) => typeof id === 'string' && id)
      && new Set(payload.cardIds).size === payload.cardIds.length
      && typeof payload.declaredRank === 'string';
  }
  const payload = action.payload;
  return exactKeys(payload, PIN_KEYS) && typeof payload.placementMoveId === 'string'
    && Boolean(payload.placementMoveId.trim()) && Number.isSafeInteger(payload.placementRevision)
    && payload.placementRevision >= 1;
}
function replay(rules, currentState, action) {
  const { playerIndex, payload } = action;
  if (action.action === 'place') {
    return rules.placeCards(
      currentState, playerIndex, payload.cardIds, payload.declaredRank, action.moveId,
    );
  }
  if (action.action === 'pass') return rules.passCard(currentState, playerIndex);
  if (action.action === 'challenge') {
    return rules.resolveChallenge(
      currentState, playerIndex, payload.placementMoveId, payload.placementRevision,
    );
  }
  return rules.acceptPlacement(
    currentState, playerIndex, payload.placementMoveId, payload.placementRevision,
  );
}

export function createBluffTransitionValidator(rules) {
  for (const name of ['placeCards', 'passCard', 'acceptPlacement', 'resolveChallenge', 'validateState']) {
    requireFunction(rules?.[name], `rules.${name}`);
  }
  return ({ currentState, nextState, action } = {}) => {
    if (!exactKeys(action, ACTION_KEYS) || action.type !== 'bluff-action') {
      return { valid: false, reason: 'unsupported-action' };
    }
    if (typeof action.moveId !== 'string' || !action.moveId.trim()) {
      return { valid: false, reason: 'missing-move-id' };
    }
    if (!ACTIONS.has(action.action) || !validPayload(action)) {
      return { valid: false, reason: 'invalid-action-payload' };
    }
    if (currentState?.status !== 'playing') return { valid: false, reason: 'game-not-playing' };
    if (!Number.isInteger(action.playerIndex) || action.playerIndex < 0
      || action.playerIndex >= currentState.players?.length) return { valid: false, reason: 'invalid-player' };
    if (!Number.isSafeInteger(currentState.revision)
      || action.expectedRevision !== currentState.revision) {
      return { valid: false, reason: 'revision-mismatch' };
    }
    if (action.action !== 'challenge' && currentState.currentPlayerIndex !== action.playerIndex) {
      return { valid: false, reason: 'wrong-turn' };
    }
    if (action.action === 'challenge'
      && currentState.lastPlacement?.playerIndex === action.playerIndex) {
      return { valid: false, reason: 'self-challenge' };
    }
    try {
      const expected = replay(rules, currentState, action);
      const integrity = rules.validateState(expected);
      if (!integrity?.valid) return { valid: false, reason: integrity?.error || 'invalid-state' };
      if (expected.revision !== currentState.revision + 1) {
        return { valid: false, reason: 'invalid-next-revision' };
      }
      return sameValue(expected, nextState)
        ? { valid: true }
        : { valid: false, reason: 'state-transition-mismatch' };
    } catch (_) {
      return { valid: false, reason: 'invalid-transition' };
    }
  };
}
