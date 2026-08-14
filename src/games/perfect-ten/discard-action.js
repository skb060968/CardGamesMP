import { discardCard as runDiscardCard } from '../../core/card-actions.js';
import { executeCommittedAction } from '../../core/committed-action.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function defaultMoveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createPerfectTenDiscardAction({
  coordinator, rules, sync, effects, getState, setState, createMoveId = defaultMoveId,
}) {
  requireFunction(getState, 'getState');
  requireFunction(setState, 'setState');
  requireFunction(createMoveId, 'createMoveId');
  requireFunction(rules?.discardCard, 'rules.discardCard');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(sync?.commitDiscard, 'sync.commitDiscard');
  requireFunction(effects?.animateDiscard, 'effects.animateDiscard');
  requireFunction(effects?.render, 'effects.render');

  return function performDiscard({ handIndex, playerIndex } = {}) {
    const moveId = createMoveId();
    if (typeof moveId !== 'string' || !moveId.trim()) throw new TypeError('createMoveId must return a non-empty string');
    return runDiscardCard(coordinator, {
      moveId,
      steps: [({ signal }) => executeCommittedAction({
        signal,
        prepare: () => {
          const state = getState();
          if (state?.status !== 'playing') throw new Error('Game is not active');
          if (state.currentPlayerIndex !== playerIndex) throw new Error('It is not this player’s turn');
          if (state.turnPhase !== 'discard') throw new Error('Cannot discard: not in discard phase');
          const hand = state.players?.[playerIndex]?.hand;
          if (!Number.isInteger(handIndex) || !Array.isArray(hand) || !hand[handIndex]) {
            throw new RangeError('Invalid hand index');
          }
          const card = hand[handIndex];
          const result = rules.discardCard(state, handIndex);
          const integrity = rules.validateState(result?.newState);
          if (!integrity?.valid) throw new Error(integrity?.error || 'Invalid game state');
          const expectedRevision = Number.isSafeInteger(state.revision) ? state.revision : 0;
          const nextState = { ...result.newState, revision: expectedRevision + 1 };
          return {
            state, nextState, card, won: result.won === true,
            winGroups: null, expectedRevision,
          };
        },
        commit: (prepared) => sync.commitDiscard({
          moveId, expectedRevision: prepared.expectedRevision, playerIndex, handIndex,
          card: prepared.card, won: prepared.won, winGroups: null,
          state: prepared.nextState, signal,
        }),
        animate: (prepared) => effects.animateDiscard({
          moveId, playerIndex, handIndex, card: prepared.card,
          fromState: prepared.state, toState: prepared.nextState, signal,
        }),
        publish: async (prepared, committed) => {
          const authoritativeState = committed?.state || prepared.nextState;
          setState(authoritativeState);
          await effects.render({
            moveId, playerIndex, handIndex, card: prepared.card,
            won: prepared.won, state: authoritativeState,
          });
        },
      })],
    });
  };
}