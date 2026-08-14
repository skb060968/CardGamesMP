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

async function animateFloater({
  documentRef, source, target, face, signal, duration = 450,
  preserveSource = false, resizeToTarget = false, sourceReplacement,
}) {
  if (signal?.aborted) throw abortError();
  if (!source || !target || !face || !documentRef?.body) return;
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return;
  const from = center(sourceRect);
  const to = center(targetRect);
  const floater = face;
  floater.classList.add('pt-card-floater');
  Object.assign(floater.style, {
    position: 'fixed', left: `${sourceRect.left}px`, top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`, height: `${sourceRect.height}px`, margin: '0',
    pointerEvents: 'none', zIndex: '10000',
  });
  let sourceReplaced = false;
  if (sourceReplacement !== undefined && source.parentNode) {
    if (sourceReplacement) source.parentNode.replaceChild(sourceReplacement, source);
    else source.remove();
    sourceReplaced = true;
  } else if (!preserveSource) {
    source.style.visibility = 'hidden';
  }
  documentRef.body.appendChild(floater);
  let onAbort;
  let traveled = false;
  try {
    if (typeof floater.animate === 'function') {
      const offsetX = resizeToTarget ? targetRect.left - sourceRect.left : to.x - from.x;
      const offsetY = resizeToTarget ? targetRect.top - sourceRect.top : to.y - from.y;
      const animation = floater.animate([{
        transform: 'translate(0, 0) rotate(0deg)',
        width: `${sourceRect.width}px`, height: `${sourceRect.height}px`, opacity: 1,
      }, {
        transform: `translate(${offsetX}px, ${offsetY}px) rotate(5deg)`,
        width: `${resizeToTarget ? targetRect.width : sourceRect.width}px`,
        height: `${resizeToTarget ? targetRect.height : sourceRect.height}px`, opacity: 1,
      }], { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
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
    if (!preserveSource && !sourceReplaced) {
      if (traveled) source.remove();
      else if (source.isConnected) source.style.removeProperty('visibility');
    }
    floater.remove();
  }
}
export function createPerfectTenEffects({
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
    `.pt-opponent[data-player-index="${playerIndex}"] .pt-opponent-hand`,
  );

  return Object.freeze({
    async animateDraw({
      playerIndex, localPlayerIndex = playerIndex, source, card, fromState, toState, signal,
    }) {
      playSound('throw');
      const discardDraw = source === 'discardPile';
      const sourceElement = documentRef?.querySelector(
        discardDraw ? '#pt-discard-pile .card' : '#pt-draw-pile .card',
      );
      const target = playerIndex === localPlayerIndex
        ? documentRef?.getElementById('pt-hand')
        : opponentTarget(playerIndex);
      const reveal = playerIndex === localPlayerIndex || discardDraw;
      const fallbackPile = Array.isArray(fromState?.discardPile)
        ? fromState.discardPile.slice(0, -1)
        : [];
      const remainingPile = Array.isArray(toState?.discardPile)
        ? toState.discardPile
        : fallbackPile;
      let sourceReplacement;
      if (discardDraw) {
        const nextTop = remainingPile[remainingPile.length - 1];
        sourceReplacement = nextTop ? renderCardFace(nextTop) : null;
        sourceReplacement?.classList.add('pt-pile-card');
        const count = documentRef?.getElementById('pt-discard-count');
        if (count) count.textContent = `Discard: ${remainingPile.length}`;
      }
      await animateFloater({
        documentRef,
        source: sourceElement,
        target,
        face: reveal ? renderCardFace(card) : renderCardBack(),
        signal,
        preserveSource: source === 'drawPile',
        sourceReplacement,
      });
      setEventMessage(playerIndex === localPlayerIndex ? 'Card drawn — choose a discard' : 'Opponent drew a card');
    },

    async animateDiscard({ playerIndex, localPlayerIndex = playerIndex, handIndex, card, signal }) {
      playSound('throw');
      const sourceElement = playerIndex === localPlayerIndex
        ? documentRef?.querySelector(`#pt-hand [data-hand-index="${handIndex}"]`)
        : documentRef?.querySelector(
          `.pt-opponent[data-player-index="${playerIndex}"] .pt-opponent-hand .card:last-child`,
        );
      await animateFloater({
        documentRef,
        source: sourceElement,
        target: documentRef?.getElementById('pt-discard-pile'),
        face: renderCardFace(card),
        signal,
        resizeToTarget: true,
      });
      setEventMessage('Card discarded');
    },

    async render({
      state, playerIndex, onDraw, onDiscard, onSort, onReorder, handOrder,
      move, source, card, handIndex, won,
    }) {
      documentRef?.querySelectorAll('.pt-card-floater').forEach((item) => item.remove());
      if (state.status === 'finished') {
        renderResults(state);
        if (finishedRevision !== state.revision) {
          finishedRevision = state.revision;
          await onFinished({ state, playerIndex, won: won === true });
        }
        return;
      }
      finishedRevision = null;
      let lastMove = move || null;
      if (!lastMove && source) lastMove = { type: 'draw-card', playerIndex, source, card };
      else if (!lastMove && Number.isInteger(handIndex)) {
        lastMove = { type: 'discard-card', playerIndex, handIndex, card };
      }
      renderGameplay(state, playerIndex, onDraw, onDiscard, lastMove, {
        handOrder, onSort, onReorder,
      });
    },
  });
}
