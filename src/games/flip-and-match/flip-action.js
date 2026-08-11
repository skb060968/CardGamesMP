import { flipCard as runFlipCard } from '../../core/card-actions.js';
import { executeCommittedAction } from '../../core/committed-action.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function defaultMoveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createFlipAndMatchFlipAction({
  coordinator,
  rules,
  sync,
  effects,
  getState,
  setState,
  createMoveId = defaultMoveId,
}) {
  requireFunction(getState, 'getState');
  requireFunction(setState, 'setState');
  requireFunction(createMoveId, 'createMoveId');
  requireFunction(rules?.flipCard, 'rules.flipCard');
  requireFunction(rules?.checkGameEnd, 'rules.checkGameEnd');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(sync?.commitFlip, 'sync.commitFlip');
  requireFunction(effects?.revealCard, 'effects.revealCard');
  requireFunction(effects?.collectMatchedPair, 'effects.collectMatchedPair');
  requireFunction(effects?.render, 'effects.render');

  return function performFlip({ cardIndex, playerIndex }) {
    const moveId = createMoveId();

    return runFlipCard(coordinator, {
      moveId,
      steps: [({ signal }) => executeCommittedAction({
        signal,
        prepare: () => {
          const state = getState();
          if (!state || state.status !== 'playing') throw new Error('Game is not active');
          if (state.currentPlayerIndex !== playerIndex) throw new Error('It is not this player’s turn');
          if (!Number.isInteger(cardIndex) || !state.board?.[cardIndex]) {
            throw new RangeError('Invalid card index');
          }

          const card = state.board[cardIndex].card;
          const { newState, matched, matchedIndex } = rules.flipCard(state, cardIndex, playerIndex);
          const validation = rules.validateState(newState);
          if (!validation?.valid) throw new Error(validation?.error || 'Invalid game state');

          const end = rules.checkGameEnd(newState);
          const resolvedState = end.finished ? {
            ...newState,
            status: 'finished',
            winnerIndex: end.winnerIndex,
            isTie: end.isTie,
            tiedIndices: end.tiedIndices,
          } : newState;
          const expectedRevision = Number.isSafeInteger(state.revision) ? state.revision : 0;
          const nextState = { ...resolvedState, revision: expectedRevision + 1 };

          return {
            state, nextState, card, matched, matchedIndex, end, expectedRevision,
          };
        },
        commit: (prepared) => sync.commitFlip({
          moveId,
          expectedRevision: prepared.expectedRevision,
          playerIndex,
          cardIndex,
          card: prepared.card,
          matched: prepared.matched,
          matchedIndex: prepared.matchedIndex,
          state: prepared.nextState,
          signal,
        }),
        animate: async (prepared) => {
          const context = {
            moveId, playerIndex, cardIndex,
            card: prepared.card,
            matched: prepared.matched,
            matchedIndex: prepared.matchedIndex,
            fromState: prepared.state,
            toState: prepared.nextState,
            signal,
          };
          await effects.revealCard(context);
          if (prepared.matched) await effects.collectMatchedPair(context);
        },
        publish: async (prepared, committed) => {
          const authoritativeState = committed?.state || prepared.nextState;
          setState(authoritativeState);
          await effects.render({
            moveId,
            playerIndex,
            cardIndex,
            matched: prepared.matched,
            matchedIndex: prepared.matchedIndex,
            end: prepared.end,
            state: authoritativeState,
          });
        },
      })],
    });
  };
}
