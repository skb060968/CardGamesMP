import { drawCard as runDrawCard } from '../../core/card-actions.js';
import { executeCommittedAction } from '../../core/committed-action.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function defaultMoveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createPerfectTenDrawAction({
  coordinator, rules, sync, effects, getState, setState, createMoveId = defaultMoveId,
}) {
  requireFunction(getState, 'getState');
  requireFunction(setState, 'setState');
  requireFunction(createMoveId, 'createMoveId');
  requireFunction(rules?.drawCard, 'rules.drawCard');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(sync?.commitDraw, 'sync.commitDraw');
  requireFunction(effects?.animateDraw, 'effects.animateDraw');
  requireFunction(effects?.render, 'effects.render');

  return function performDraw({ source, playerIndex } = {}) {
    const moveId = createMoveId();
    if (typeof moveId !== 'string' || !moveId.trim()) throw new TypeError('createMoveId must return a non-empty string');
    return runDrawCard(coordinator, {
      moveId,
      steps: [({ signal }) => executeCommittedAction({
        signal,
        prepare: () => {
          const state = getState();
          if (state?.status !== 'playing') throw new Error('Game is not active');
          if (state.currentPlayerIndex !== playerIndex) throw new Error('It is not this player’s turn');
          if (state.turnPhase !== 'draw') throw new Error('Cannot draw: not in draw phase');
          if (source !== 'drawPile' && source !== 'discardPile') throw new RangeError('Invalid draw source');
          if (!Array.isArray(state.players?.[playerIndex]?.hand)) throw new RangeError('Invalid player');
          const oldHand = [...state.players[playerIndex].hand];
          let nextState = rules.drawCard(state, source);
          let card = null;
          if (nextState.status !== 'finished') {
            const engineHand = nextState.players?.[playerIndex]?.hand;
            if (!Array.isArray(engineHand) || engineHand.length !== oldHand.length + 1) {
              throw new Error('Draw transition did not add exactly one card');
            }
            card = engineHand[engineHand.length - 1];
            nextState = {
              ...nextState,
              players: nextState.players.map((player, index) => index === playerIndex
                ? { ...player, hand: [...oldHand, card] }
                : player),
            };
          }
          const integrity = rules.validateState(nextState);
          if (!integrity?.valid) throw new Error(integrity?.error || 'Invalid game state');
          const expectedRevision = Number.isSafeInteger(state.revision) ? state.revision : 0;
          nextState = { ...nextState, revision: expectedRevision + 1 };
          return { state, nextState, card, expectedRevision, finished: nextState.status === 'finished' };
        },
        commit: (prepared) => sync.commitDraw({
          moveId, expectedRevision: prepared.expectedRevision, playerIndex, source,
          card: prepared.card, state: prepared.nextState, signal,
        }),
        animate: (prepared) => prepared.finished ? undefined : effects.animateDraw({
          moveId, playerIndex, source, card: prepared.card,
          fromState: prepared.state, toState: prepared.nextState, signal,
        }),
        publish: async (prepared, committed) => {
          const authoritativeState = committed?.state || prepared.nextState;
          setState(authoritativeState);
          await effects.render({
            moveId, playerIndex, source, card: prepared.card,
            finished: prepared.finished, state: authoritativeState,
          });
        },
      })],
    });
  };
}