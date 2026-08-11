import { throwCard as runThrowCard } from '../../core/card-actions.js';
import { executeCommittedAction } from '../../core/committed-action.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function defaultMoveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createPatteParPattaThrowAction({
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
  requireFunction(rules?.throwCard, 'rules.throwCard');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(rules?.checkWinCondition, 'rules.checkWinCondition');
  requireFunction(rules?.advanceTurn, 'rules.advanceTurn');
  requireFunction(sync?.commitThrow, 'sync.commitThrow');
  requireFunction(effects?.animateThrow, 'effects.animateThrow');
  requireFunction(effects?.animateCapture, 'effects.animateCapture');
  requireFunction(effects?.render, 'effects.render');

  return function performThrow({ handIndex, playerIndex }) {
    const moveId = createMoveId();

    return runThrowCard(coordinator, {
      moveId,
      steps: [({ signal }) => executeCommittedAction({
        signal,
        prepare: () => {
          const state = getState();
          if (!state || state.status !== 'playing') throw new Error('Game is not active');
          if (state.currentPlayerIndex !== playerIndex) throw new Error('It is not this player’s turn');
          if (!Number.isInteger(handIndex) || !state.players[playerIndex]?.hand[handIndex]) {
            throw new RangeError('Invalid hand index');
          }

          const card = state.players[playerIndex].hand[handIndex];
          const { newState, captured } = rules.throwCard(state, handIndex);
          const validation = rules.validateState(newState);
          if (!validation?.valid) throw new Error(validation?.error || 'Invalid game state');

          const win = rules.checkWinCondition(newState);
          const resolvedState = win.finished
            ? { ...newState, status: 'finished', winnerIndex: win.winnerIndex }
            : rules.advanceTurn(newState);
          const expectedRevision = Number.isSafeInteger(state.revision) ? state.revision : 0;
          const nextState = { ...resolvedState, revision: expectedRevision + 1 };

          return { state, nextState, card, captured, win, expectedRevision };
        },
        commit: (prepared) => sync.commitThrow({
          moveId,
          expectedRevision: prepared.expectedRevision,
          playerIndex,
          handIndex,
          card: prepared.card,
          captured: prepared.captured,
          state: prepared.nextState,
          signal,
        }),
        animate: async (prepared) => {
          await effects.animateThrow({
            moveId,
            playerIndex,
            handIndex,
            card: prepared.card,
            fromState: prepared.state,
            toState: prepared.nextState,
            signal,
          });
          if (prepared.captured) {
            await effects.animateCapture({
              moveId,
              playerIndex,
              card: prepared.card,
              fromState: prepared.state,
              toState: prepared.nextState,
              signal,
            });
          }
        },
        publish: async (prepared, committed) => {
          const authoritativeState = committed?.state || prepared.nextState;
          setState(authoritativeState);
          await effects.render({
            moveId,
            playerIndex,
            captured: prepared.captured,
            win: prepared.win,
            state: authoritativeState,
          });
        },
      })],
    });
  };
}