import {
  animateCardReveal,
  animateMatchedPairCollection,
  delay,
} from '../../core/dom-card-effects.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function temporaryRevealState(state, cardIndex) {
  return {
    ...state,
    board: state.board.map((slot, index) => (
      index === cardIndex ? { ...slot, state: 'up' } : { ...slot }
    )),
  };
}

export function createFlipAndMatchEffects({
  document: documentRef = globalThis.document,
  renderGameplay,
  renderResults,
  playSound = () => {},
  announceCapture = () => {},
  setEventMessage = () => {},
  onFinished = async () => {},
} = {}) {
  requireFunction(renderGameplay, 'renderGameplay');
  requireFunction(renderResults, 'renderResults');
  requireFunction(playSound, 'playSound');
  requireFunction(announceCapture, 'announceCapture');
  requireFunction(setEventMessage, 'setEventMessage');
  requireFunction(onFinished, 'onFinished');

  let finishedRevision = null;

  const cardElement = (cardIndex) => documentRef?.querySelector(
    `#fm-grid-area [data-card-index="${cardIndex}"] .fm-grid-card`,
  );

  const sweepTarget = (winnerPlayerIndex, localPlayerIndex) => {
    if (winnerPlayerIndex === localPlayerIndex) {
      const area = documentRef?.getElementById('fm-self-area');
      return area?.querySelector('.fm-won-deck') || area;
    }
    const area = documentRef?.getElementById('fm-opponents-area');
    const blocks = area?.querySelectorAll('.fm-player-block') || [];
    let blockIndex = 0;
    for (let index = 0; index < winnerPlayerIndex; index += 1) {
      if (index !== localPlayerIndex) blockIndex += 1;
    }
    return blocks[blockIndex]?.querySelector('.fm-won-deck') || blocks[blockIndex] || null;
  };

  return Object.freeze({
    async revealCard({
      cardIndex, matched, fromState, playerIndex: actorIndex,
      localPlayerIndex = actorIndex, onFlip, moveId, signal,
    }) {
      playSound('throw');
      const element = cardElement(cardIndex);
      await animateCardReveal({
        element,
        signal,
        reveal: () => {
          renderGameplay(
            temporaryRevealState(fromState, cardIndex),
            localPlayerIndex,
            onFlip,
            { id: moveId, playerIndex: actorIndex, cardIndex, matched },
          );
        },
      });
      if (!matched) setEventMessage('No match — card stays face-up');
    },

    async collectMatchedPair({
      cardIndex, matchedIndex, playerIndex: actorIndex,
      fromState, localPlayerIndex = actorIndex, signal,
    }) {
      const player = fromState.players?.[actorIndex];
      playSound('capture');
      if (player) {
        announceCapture(player.name);
        setEventMessage(`${player.emoji} ${player.name} matched ${fromState.board[cardIndex].card.rank}s!`);
      }
      const first = cardElement(cardIndex);
      const second = cardElement(matchedIndex);
      const target = sweepTarget(actorIndex, localPlayerIndex);
      await animateMatchedPairCollection({
        elements: [first, second],
        targetRect: target?.getBoundingClientRect(),
        signal,
      });
      await delay(500, signal);
    },

    async render({ state, playerIndex, onFlip, moveId, cardIndex, matched, matchedIndex }) {
      if (state.status === 'finished') {
        renderResults(state);
        if (finishedRevision !== state.revision) {
          finishedRevision = state.revision;
          await onFinished(state);
        }
        return;
      }
      finishedRevision = null;
      renderGameplay(state, playerIndex, onFlip, {
        id: moveId,
        playerIndex,
        cardIndex,
        matched,
        matchedIndex,
      });
    },
  });
}
