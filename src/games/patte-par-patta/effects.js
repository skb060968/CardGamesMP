import {
  animateElementSweep,
  animateThrowToPile,
  shakeElement,
} from '../../core/dom-card-effects.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function temporaryThrowState(state, playerIndex, handIndex, card) {
  return {
    ...state,
    players: state.players.map((player, index) => (
      index === playerIndex
        ? { ...player, hand: player.hand.filter((_, cardIndex) => cardIndex !== handIndex) }
        : { ...player }
    )),
    pile: [...state.pile, card],
  };
}

export function createPatteParPattaEffects({
  document: documentRef = globalThis.document,
  renderCardFace,
  renderGameplay,
  renderResults,
  onFinished = async () => {},
  playSound = () => {},
  announceCapture = () => {},
  setEventMessage = () => {},
} = {}) {
  requireFunction(renderCardFace, 'renderCardFace');
  requireFunction(renderGameplay, 'renderGameplay');
  requireFunction(renderResults, 'renderResults');
  requireFunction(onFinished, 'onFinished');
  requireFunction(playSound, 'playSound');
  requireFunction(announceCapture, 'announceCapture');
  requireFunction(setEventMessage, 'setEventMessage');

  return Object.freeze({
    async animateThrow({
      playerIndex, localPlayerIndex = playerIndex, handIndex, card, fromState, signal,
    }) {
      playSound('throw');
      const source = documentRef?.querySelector(
        `.player-slot[data-player-index="${playerIndex}"] .player-slot-deck .card`,
      );
      const pile = documentRef?.getElementById('pile-area');
      if (!source || !pile) {
        renderGameplay(
          temporaryThrowState(fromState, playerIndex, handIndex, card),
          localPlayerIndex,
        );
        return;
      }
      source.style.visibility = 'hidden';
      try {
        await animateThrowToPile({
          document: documentRef,
          deckRect: source.getBoundingClientRect(),
          pileRect: pile.getBoundingClientRect(),
          faceElement: renderCardFace(card),
          signal,
        });
        renderGameplay(
          temporaryThrowState(fromState, playerIndex, handIndex, card),
          localPlayerIndex,
        );
      } finally {
        source.style.removeProperty('visibility');
      }
    },


    async animateCapture({ playerIndex, fromState, signal }) {
      playSound('capture');
      const pile = documentRef?.getElementById('pile-card');
      if (pile) {
        await shakeElement({
          element: pile,
          className: 'pile-capture-shake',
          duration: 1000,
          signal,
        });
        const playerDeck = documentRef?.querySelector(
          `.player-slot[data-player-index="${playerIndex}"] .player-slot-deck`,
        );
        const target = playerDeck?.querySelector('.card') || playerDeck;
        if (target) {
          await animateElementSweep({
            element: pile,
            targetRect: target.getBoundingClientRect(),
            duration: 1200,
            signal,
          });
        }
        pile.style.visibility = 'hidden';
      }
      const player = fromState?.players?.[playerIndex];
      if (player) {
        announceCapture(player.name);
        setEventMessage(`${player.emoji} ${player.name} captured the pile!`);
      }
    },

    async render({ state, playerIndex, win }) {
      documentRef?.getElementById('pile-card')?.style.removeProperty('visibility');
      if (state.status === 'finished') {
        renderResults(state);
        await onFinished({ state, playerIndex, win });
        return;
      }
      renderGameplay(state, playerIndex);
    },
  });
}