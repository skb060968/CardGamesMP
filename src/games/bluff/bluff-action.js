import { executeCommittedAction } from '../../core/committed-action.js';

const ACTIONS = new Set(['place', 'pass', 'challenge']);
const PLACE_KEYS = new Set(['cardIds', 'declaredRank']);
const PIN_KEYS = new Set(['placementMoveId', 'placementRevision']);

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}
function defaultMoveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}
function normalizeAction(action) {
  if (!isRecord(action) || Object.keys(action).some((key) => key !== 'type' && key !== 'payload')
    || !ACTIONS.has(action.type)) throw new TypeError('Invalid Bluff action');
  const payload = action.payload ?? null;
  if (action.type === 'place') {
    if (!exactKeys(payload, PLACE_KEYS) || !Array.isArray(payload.cardIds)
      || payload.cardIds.length < 1 || payload.cardIds.length > 4
      || payload.cardIds.some((id) => typeof id !== 'string' || !id)
      || new Set(payload.cardIds).size !== payload.cardIds.length
      || typeof payload.declaredRank !== 'string') throw new TypeError('Invalid place payload');
    return { type: action.type, payload: { cardIds: [...payload.cardIds], declaredRank: payload.declaredRank } };
  }
  if (action.type === 'challenge') {
    if (!exactKeys(payload, PIN_KEYS) || typeof payload.placementMoveId !== 'string'
      || !payload.placementMoveId.trim() || !Number.isSafeInteger(payload.placementRevision)
      || payload.placementRevision < 1) throw new TypeError('Invalid challenge payload');
    return { type: action.type, payload: { ...payload } };
  }
  if (payload !== null) throw new TypeError('Pass payload must be null');
  return { type: 'pass', payload: null };
}
function reduce(rules, state, playerIndex, action, moveId) {
  if (action.type === 'place') {
    return rules.placeCards(
      state, playerIndex, action.payload.cardIds, action.payload.declaredRank, moveId,
    );
  }
  if (action.type === 'pass') return rules.passCard(state, playerIndex);
  return rules.resolveChallenge(
    state, playerIndex, action.payload.placementMoveId, action.payload.placementRevision,
  );
}

export function createBluffAction({
  coordinator, rules, sync, effects, getState, setState, createMoveId = defaultMoveId,
}) {
  requireFunction(coordinator?.runLocal, 'coordinator.runLocal');
  for (const name of ['placeCards', 'passCard', 'resolveChallenge', 'validateState']) {
    requireFunction(rules?.[name], `rules.${name}`);
  }
  requireFunction(sync?.commitBluffAction, 'sync.commitBluffAction');
  requireFunction(effects?.animateAction, 'effects.animateAction');
  requireFunction(effects?.render, 'effects.render');
  requireFunction(getState, 'getState');
  requireFunction(setState, 'setState');
  requireFunction(createMoveId, 'createMoveId');

  return function performBluffAction({ playerIndex, action } = {}) {
    const normalized = normalizeAction(action);
    const moveId = createMoveId();
    if (typeof moveId !== 'string' || !moveId.trim()) {
      throw new TypeError('createMoveId must return a non-empty string');
    }
    return coordinator.runLocal({
      type: 'bluff-action',
      moveId,
      steps: [({ signal }) => executeCommittedAction({
        signal,
        prepare: () => {
          const state = getState();
          if (state?.status !== 'playing') throw new Error('Game is not active');
          const expectedRevision = state.revision;
          const nextState = reduce(rules, state, playerIndex, normalized, moveId);
          if (nextState.revision !== expectedRevision + 1) throw new Error('Reducer produced invalid revision');
          const integrity = rules.validateState(nextState);
          if (!integrity?.valid) throw new Error(integrity?.error || 'Invalid game state');
          return { state, nextState, expectedRevision };
        },
        commit: (prepared) => sync.commitBluffAction({
          moveId,
          expectedRevision: prepared.expectedRevision,
          playerIndex,
          action: normalized.type,
          payload: normalized.payload,
          state: prepared.nextState,
          signal,
        }),
        animate: (prepared) => effects.animateAction({
          moveId,
          playerIndex,
          action: normalized.type,
          payload: normalized.payload,
          fromState: prepared.state,
          toState: prepared.nextState,
          signal,
        }),
        publish: async (prepared, committed) => {
          const authoritativeState = committed?.state || prepared.nextState;
          setState(authoritativeState);
          await effects.render({
            moveId,
            playerIndex,
            action: normalized.type,
            payload: normalized.payload,
            state: authoritativeState,
          });
        },
      })],
    });
  };
}
