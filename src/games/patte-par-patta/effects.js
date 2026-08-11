import {
  animateElementSweep,
  animateThrowToPile,
  shakeElement,
} from '../../core/dom-card-effects.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
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
    async animateThrow({ playerIndex, card, signal }) {
      playSound('throw');
      const source = documentRef?.querySelector(
        `.player-slot[data-player-index="${playerIndex}"] .player-slot-deck .card`,
      );
      const pile = documentRef?.getElementById('pile-area');
      if (!source || !pile) return;
      await animateThrowToPile({
        document: documentRef,
        deckRect: source.getBoundingClientRect(),
        pileRect: pile.getBoundingClientRect(),
        faceElement: renderCardFace(card),
        signal,
      });
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
        const target = documentRef?.querySelector(
          `.player-slot[data-player-index="${playerIndex}"] .player-slot-deck .card`,
        );
        if (target) {
          await animateElementSweep({
            element: pile,
            targetRect: target.getBoundingClientRect(),
            duration: 1200,
            signal,
          });
        }
      }
      const player = fromState?.players?.[playerIndex];
      if (player) {
        announceCapture(player.name);
        setEventMessage(`${player.emoji} ${player.name} captured the pile!`);
      }
    },

    async render({ state, playerIndex, win }) {
      if (state.status === 'finished') {
        renderResults(state);
        await onFinished({ state, playerIndex, win });
        return;
      }
      renderGameplay(state, playerIndex);
    },
  });
}