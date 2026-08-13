function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function center(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

async function animateFloater({ documentRef, source, target, face, signal, duration = 450 }) {
  if (signal?.aborted) throw abortError();
  if (!source || !target || !face || !documentRef?.body) return;
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return;
  const from = center(sourceRect);
  const to = center(targetRect);
  const floater = face;
  floater.classList.add('sr-card-floater');
  Object.assign(floater.style, {
    position: 'fixed', left: `${sourceRect.left}px`, top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`, height: `${sourceRect.height}px`, margin: '0',
    pointerEvents: 'none', zIndex: '10000',
  });
  source.style.visibility = 'hidden';
  documentRef.body.appendChild(floater);
  let onAbort;
  let traveled = false;
  try {
    if (typeof floater.animate === 'function') {
      const animation = floater.animate([
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) rotate(5deg)`, opacity: 1 },
      ], { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
      const aborted = new Promise((_, reject) => {
        onAbort = () => { animation.cancel(); reject(abortError()); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      await (signal ? Promise.race([animation.finished, aborted]) : animation.finished);
    } else {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, duration);
        onAbort = () => { clearTimeout(timer); reject(abortError()); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    traveled = true;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    source.style.removeProperty('visibility');
    floater.remove();
    if (traveled) source.remove();
  }
}
export function createSimpleRummyEffects({
  document: documentRef = globalThis.document,
  renderCardFace,
  renderCardBack,
  renderGameplay,
  renderResults,
  onFinished = async () => {},
  playSound = () => {},
  setEventMessage = () => {},
} = {}) {
  requireFunction(renderCardFace, 'renderCardFace');
  requireFunction(renderCardBack, 'renderCardBack');
  requireFunction(renderGameplay, 'renderGameplay');
  requireFunction(renderResults, 'renderResults');
  requireFunction(onFinished, 'onFinished');
  requireFunction(playSound, 'playSound');
  requireFunction(setEventMessage, 'setEventMessage');

  let finishedRevision = null;

  const opponentTarget = (playerIndex) => documentRef?.querySelector(
    `.sr-opponent[data-player-index="${playerIndex}"] .sr-opponent-hand`,
  );

  return Object.freeze({
    async animateDraw({
      playerIndex, localPlayerIndex = playerIndex, source, card, signal,
    }) {
      playSound('throw');
      const sourceElement = documentRef?.querySelector(
        source === 'discardPile' ? '#sr-discard-pile .card' : '#sr-draw-pile .card',
      );
      const target = playerIndex === localPlayerIndex
        ? documentRef?.getElementById('sr-hand')
        : opponentTarget(playerIndex);
      const reveal = playerIndex === localPlayerIndex || source === 'discardPile';
      const face = reveal ? renderCardFace(card) : renderCardBack();
      try {
        await animateFloater({ documentRef, source: sourceElement, target, face, signal });
      } finally {
        sourceElement?.style.removeProperty('visibility');
        documentRef?.querySelectorAll('.sr-card-floater').forEach((element) => element.remove());
      }
      setEventMessage(playerIndex === localPlayerIndex ? 'Card drawn — choose a discard' : 'Opponent drew a card');
    },

    async animateDiscard({
      playerIndex, localPlayerIndex = playerIndex, handIndex, card, signal,
    }) {
      playSound('throw');
      const sourceElement = playerIndex === localPlayerIndex
        ? documentRef?.querySelector(`#sr-hand [data-hand-index="${handIndex}"]`)
        : documentRef?.querySelector(
          `.sr-opponent[data-player-index="${playerIndex}"] .sr-opponent-hand .card:last-child`,
        );
      const target = documentRef?.getElementById('sr-discard-pile');
      const face = renderCardFace(card);
      try {
        await animateFloater({ documentRef, source: sourceElement, target, face, signal });
      } finally {
        sourceElement?.style.removeProperty('visibility');
        documentRef?.querySelectorAll('.sr-card-floater').forEach((element) => element.remove());
      }
      setEventMessage('Card discarded');
    },

    async render({
      state, playerIndex, onDraw, onDiscard, move, source, card, handIndex, won, winGroups,
    }) {
      documentRef?.querySelectorAll('.sr-card-floater').forEach((element) => element.remove());
      if (state.status === 'finished') {
        renderResults(state);
        if (finishedRevision !== state.revision) {
          finishedRevision = state.revision;
          await onFinished({ state, playerIndex, won: won === true, winGroups: winGroups ?? state.winGroups });
        }
        return;
      }
      finishedRevision = null;
      let lastMove = move || null;
      if (!lastMove && source) {
        lastMove = { type: 'draw-card', playerIndex, source, card };
      } else if (!lastMove && Number.isInteger(handIndex)) {
        lastMove = { type: 'discard-card', playerIndex, handIndex, card };
      }
      renderGameplay(state, playerIndex, onDraw, onDiscard, lastMove);
    },
  });
}
