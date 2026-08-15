import { delay, prefersReducedMotion } from '../../core/dom-card-effects.js';

import { renderCardBack } from '../../shared/card-renderer.js';
import { deriveChallengeOutcome } from './engine.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}
function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
function center(rect) { return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }
function playerTarget(documentRef, playerIndex, localPlayerIndex) {
  if (playerIndex === localPlayerIndex) return documentRef?.getElementById('bl-self-bar');
  return documentRef?.querySelector(
    `#bl-all-players .game-player-block[data-player-index="${playerIndex}"]`,
  );
}
async function animateFloater({ documentRef, source, target, element, signal, duration = 360, delayMs = 0 }) {
  if (signal?.aborted) throw abortError(signal);
  if (!documentRef?.body || !source || !target || !element) return;
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return;
  if (delayMs) await delay(delayMs, signal);
  const from = center(sourceRect);
  const to = center(targetRect);
  element.classList.add('bl-card-floater');
  Object.assign(element.style, {
    position: 'fixed', left: `${sourceRect.left}px`, top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`, height: `${sourceRect.height}px`, margin: '0',
    pointerEvents: 'none', zIndex: '10000',
  });
  documentRef.body.appendChild(element);
  let animation = null;
  let onAbort = null;
  try {
    if (typeof element.animate === 'function') {
      animation = element.animate([
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) rotate(6deg)`, opacity: 0.9 },
      ], { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
      const aborted = new Promise((_, reject) => {
        onAbort = () => { animation.cancel(); reject(abortError(signal)); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      await (signal ? Promise.race([animation.finished, aborted]) : animation.finished);
    } else await delay(duration, signal);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    try { animation?.cancel(); } catch (_) { /* completed */ }
    element.remove();
  }
}
function placementMessage(state, playerIndex, localPlayerIndex) {
  const placement = state?.lastPlacement;
  const actor = state?.players?.[playerIndex];
  if (!placement || placement.playerIndex !== playerIndex) return '';
  const subject = playerIndex === localPlayerIndex ? 'You' : actor?.name || 'Player';
  return `${subject} placed ${placement.count} × ${placement.declaredRank}`;
}

export function createBluffEffects({
  document: documentRef = globalThis.document,
  renderGameplay,
  renderResults,
  renderChallengeResult,
  hideChallengeResult,
  clearSelection = () => {},
  setEventMessage = () => {},
  playSound = () => {},
  onFinished = async () => {},
} = {}) {
  requireFunction(renderGameplay, 'renderGameplay');
  requireFunction(renderResults, 'renderResults');
  requireFunction(renderChallengeResult, 'renderChallengeResult');
  requireFunction(hideChallengeResult, 'hideChallengeResult');
  requireFunction(clearSelection, 'clearSelection');
  requireFunction(setEventMessage, 'setEventMessage');
  requireFunction(playSound, 'playSound');
  requireFunction(onFinished, 'onFinished');
  let finishedRevision = null;

  return Object.freeze({
    async animateAction({
      playerIndex, localPlayerIndex = playerIndex, action, payload, fromState, toState, signal,
    }) {
      if (signal?.aborted) throw abortError(signal);
      const implicitAcceptance = fromState?.lastPlacement?.placerEmpty && toState?.status === 'finished'
        && (action === 'place' || action === 'pass');
      if (action === 'place' && !implicitAcceptance) {
        playSound('throw');
        const target = documentRef?.getElementById('bl-pile-card-inner')
          || documentRef?.getElementById('bl-pile-area');
        const ids = Array.isArray(payload?.cardIds) ? payload.cardIds : [];
        const inferredCount = Math.max(
          1,
          (fromState?.players?.[playerIndex]?.hand?.length || 0)
            - (toState?.players?.[playerIndex]?.hand?.length || 0),
        );
        const count = Math.min(4, ids.length || inferredCount);
        if (!prefersReducedMotion()) {
          const sourceBlock = playerTarget(documentRef, playerIndex, localPlayerIndex);
          const animations = Array.from({ length: count }, (_, index) => {
            const source = playerIndex === localPlayerIndex && ids[index]
              ? documentRef?.querySelector(`#bl-hand-area [data-card-id="${ids[index]}"]`)
              : sourceBlock;
            return animateFloater({
              documentRef,
              source,
              target,
              element: renderCardBack(),
              signal,
              delayMs: index * 55,
            });
          });
          await Promise.all(animations);
        }
        setEventMessage(placementMessage(toState, playerIndex, localPlayerIndex));
        return;
      }
      if (action === 'challenge') {
        const outcome = deriveChallengeOutcome(fromState, playerIndex);
        const loser = fromState.players[outcome.loserIndex];
        const overlay = renderChallengeResult({
          revealedCards: outcome.revealedCards,
          declaredRank: outcome.declaredRank,
          bluffCaught: outcome.bluffCaught,
          loserName: loser?.name || 'Player',
        });
        try {
          playSound('capture');
          await delay(prefersReducedMotion() ? 250 : 900, signal);
          if (!prefersReducedMotion()) {
            await animateFloater({
              documentRef,
              source: documentRef?.getElementById('bl-pile-card-inner')
                || documentRef?.getElementById('bl-pile-area'),
              target: playerTarget(documentRef, outcome.loserIndex, localPlayerIndex),
              element: renderCardBack(),
              signal,
              duration: 440,
            });
          }
          await delay(prefersReducedMotion() ? 100 : 450, signal);
        } finally {
          if (overlay) hideChallengeResult();
        }
        const challenger = fromState.players[playerIndex];
        const placer = fromState.players[fromState.lastPlacement.playerIndex];
        setEventMessage(outcome.bluffCaught
          ? `🚨 ${challenger?.name || 'Player'} caught ${placer?.name || 'Player'} bluffing!`
          : `✅ ${placer?.name || 'Player'} was truthful; ${challenger?.name || 'Player'} takes the pile.`);
        return;
      }
      if (implicitAcceptance || (action === 'accept' && toState?.status === 'finished')) {
        setEventMessage(`${toState.players[toState.winnerIndex]?.name || 'Player'} wins!`);
      } else if (action === 'pass') {
        playSound('capture');
        setEventMessage(playerIndex === localPlayerIndex ? 'You passed' : `${fromState.players[playerIndex]?.name || 'Player'} passed`);
      } else if (action === 'accept') {
        setEventMessage('Placement accepted');
      }
    },

    async render({
      state, playerIndex, onAction, onSort, onReorder, handOrder, action, move,
    }) {
      documentRef?.querySelectorAll('.bl-card-floater').forEach((element) => element.remove());
      hideChallengeResult();
      if (action || move?.action) clearSelection();
      if (state.status === 'finished') {
        renderResults(state);
        if (finishedRevision !== state.revision) {
          finishedRevision = state.revision;
          await onFinished({ state, playerIndex, action: action || move?.action || null });
        }
        return;
      }
      finishedRevision = null;
      renderGameplay(state, playerIndex, { onAction, onSort, onReorder, handOrder });
    },
  });
}
