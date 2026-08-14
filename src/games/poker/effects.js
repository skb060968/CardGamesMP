function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function playerSource(documentRef, playerIndex, localPlayerIndex) {
  if (playerIndex === localPlayerIndex) return documentRef?.getElementById('pk-self-bar');
  return documentRef?.querySelector(
    `#pk-all-players .game-player-block[data-player-index="${playerIndex}"]`,
  );
}

function actionMessage(action, actorName, local) {
  const subject = local ? 'You' : actorName || 'Player';
  const verb = { bet: 'bet 10 chips', call: 'called', raise: 'raised', fold: 'folded', show: 'called Show!' }[action];
  return verb ? `${subject} ${verb}` : '';
}

async function animateCoins({ documentRef, source, target, count, signal, duration = 500 }) {
  if (signal?.aborted) throw abortError();
  if (!documentRef?.body || !source || !target || count <= 0) return;
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !targetRect.width) return;
  const coins = [];
  const animations = [];
  let onAbort;
  try {
    for (let index = 0; index < count; index += 1) {
      const coin = documentRef.createElement('div');
      coin.className = 'pk-flying-coin';
      const spread = (index - (count - 1) / 2) * 6;
      Object.assign(coin.style, {
        position: 'fixed',
        left: `${sourceRect.left + sourceRect.width / 2 + spread}px`,
        top: `${sourceRect.top + sourceRect.height / 2}px`,
        pointerEvents: 'none', zIndex: '10000',
      });

      documentRef.body.appendChild(coin);
      coins.push(coin);
      const destinationX = targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2 + spread);
      const destinationY = targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2);
      if (typeof coin.animate === 'function') {
        const animation = coin.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${destinationX}px, ${destinationY}px) scale(.75)`, opacity: 0.6 },
        ], { duration, delay: index * 60, easing: 'cubic-bezier(.4,.1,.6,1)', fill: 'forwards' });
        animations.push(animation);
      }
    }
    if (animations.length) {
      const completed = Promise.all(animations.map((animation) => animation.finished));
      const aborted = new Promise((_, reject) => {
        onAbort = () => {
          animations.forEach((animation) => animation.cancel());
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      await (signal ? Promise.race([completed, aborted]) : completed);
    } else {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, duration + count * 60);
        onAbort = () => { clearTimeout(timer); reject(abortError()); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    animations.forEach((animation) => {
      try { animation.cancel(); } catch (_) { /* already completed */ }
    });
    coins.forEach((coin) => coin.remove());
  }
}

export function createPokerEffects({
  document: documentRef = globalThis.document,
  renderGameplay,
  renderResults,
  playSound = () => {},
  setEventMessage = () => {},
  onFinished = async () => {},
} = {}) {
  requireFunction(renderGameplay, 'renderGameplay');
  requireFunction(renderResults, 'renderResults');
  requireFunction(playSound, 'playSound');
  requireFunction(setEventMessage, 'setEventMessage');
  requireFunction(onFinished, 'onFinished');
  let finishedRevision = null;

  return Object.freeze({
    async animateAction({ playerIndex, localPlayerIndex = playerIndex, action, fromState, toState, signal }) {
      if (signal?.aborted) throw abortError();
      const actor = fromState?.players?.[playerIndex];
      const local = playerIndex === localPlayerIndex;
      if (action === 'show') playSound('capture');
      const chipsAdded = Math.max(
        0,
        (toState?.players?.[playerIndex]?.currentBet || 0) - (actor?.currentBet || 0),
      );
      if (chipsAdded > 0) {
        playSound('throw');
        const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (!reducedMotion) {
          await animateCoins({
            documentRef,
            source: playerSource(documentRef, playerIndex, localPlayerIndex),
            target: documentRef?.getElementById('pk-pot-area'),
            count: Math.max(1, Math.min(8, Math.round(chipsAdded / 10))),
            signal,
          });
        }
      }
      setEventMessage(actionMessage(action, actor?.name, local));
    },

    async render({ state, playerIndex, onAction, action, move }) {
      documentRef?.querySelectorAll('.pk-flying-coin').forEach((coin) => coin.remove());
      if (state.status === 'finished') {
        renderResults(state, state.finishReason === 'fold');
        if (finishedRevision !== state.revision) {
          finishedRevision = state.revision;
          await onFinished({ state, playerIndex, action: action || move?.action || null });
        }
        return;
      }
      finishedRevision = null;
      renderGameplay(state, playerIndex, { onAction });
    },
  });
}
