import { executeCommittedAction } from '../../core/committed-action.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function defaultMoveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createPokerAction({
  coordinator, rules, sync, effects, getState, setState, createMoveId = defaultMoveId,
}) {
  requireFunction(coordinator?.runLocal, 'coordinator.runLocal');
  requireFunction(rules?.performAction, 'rules.performAction');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(sync?.commitPokerAction, 'sync.commitPokerAction');
  requireFunction(effects?.animateAction, 'effects.animateAction');
  requireFunction(effects?.render, 'effects.render');
  requireFunction(getState, 'getState');
  requireFunction(setState, 'setState');
  requireFunction(createMoveId, 'createMoveId');

  return function performPokerAction({ playerIndex, action } = {}) {
    const actionType = typeof action === 'string' ? action : action?.type;
    const moveId = createMoveId();
    if (typeof moveId !== 'string' || !moveId.trim()) {
      throw new TypeError('createMoveId must return a non-empty string');
    }
    return coordinator.runLocal({
      type: 'poker-action',
      moveId,
      steps: [({ signal }) => executeCommittedAction({
        signal,
        prepare: () => {
          const state = getState();
          if (state?.status !== 'betting') throw new Error('Game is not in betting phase');
          if (state.currentPlayerIndex !== playerIndex) throw new Error('It is not this player’s turn');
          const result = rules.performAction(state, playerIndex, { type: actionType });
          const integrity = rules.validateState(result);
          if (!integrity?.valid) throw new Error(integrity?.error || 'Invalid game state');
          const expectedRevision = state.revision;
          return { state, nextState: { ...result, revision: expectedRevision + 1 }, expectedRevision };
        },

        commit: (prepared) => sync.commitPokerAction({
          moveId,
          expectedRevision: prepared.expectedRevision,
          playerIndex,
          action: actionType,
          state: prepared.nextState,
          signal,
        }),
        animate: (prepared) => effects.animateAction({
          moveId,
          playerIndex,
          action: actionType,
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
            action: actionType,
            state: authoritativeState,
          });
        },
      })],
    });
  };
}
