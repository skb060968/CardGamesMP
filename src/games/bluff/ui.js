import { renderCardBack, renderCardFace } from '../../shared/card-renderer.js';

import { BLUFF_RANKS } from './engine.js';

let selectedCardIds = new Set();

function clear(element) { if (element) element.innerHTML = ''; return element; }
function appendText(parent, className, text, tag = 'span') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}
function orderedHand(hand, handOrder) {
  const byId = new Map(hand.map((card) => [card.id, card]));
  const result = [];
  const included = new Set();
  (Array.isArray(handOrder) ? handOrder : []).forEach((id) => {
    const card = byId.get(id);
    if (card && !included.has(id)) { result.push(card); included.add(id); }
  });
  hand.forEach((card) => { if (!included.has(card.id)) result.push(card); });
  return result;
}
function reconcileSelection(hand) {
  const available = new Set(hand.map((card) => card.id));
  selectedCardIds = new Set([...selectedCardIds].filter((id) => available.has(id)));
}
function heap(count) {
  const wrap = document.createElement('div');
  wrap.className = 'bl-heap-wrap';
  const cards = document.createElement('div');
  cards.className = 'bl-heap';
  const offsets = [[0, 0, -4], [3, -2, 2], [6, -1, 5]];
  offsets.forEach(([x, y, rotate], index) => {
    const card = document.createElement('div');
    card.className = 'bl-heap-card';
    card.style.transform = `translate(${x}px, ${y}px) rotate(${rotate}deg)`;
    card.style.zIndex = String(index);
    cards.appendChild(card);
  });
  wrap.appendChild(cards);
  appendText(wrap, 'bl-heap-badge', String(count));
  return wrap;
}
function renderOpponents(state, localPlayerIndex) {
  const container = clear(document.getElementById('bl-all-players'));
  if (!container) return;
  state.players.forEach((player, index) => {
    if (index === localPlayerIndex) return;
    const block = document.createElement('div');
    block.className = 'game-player-block';
    block.dataset.playerIndex = String(index);
    block.classList.toggle('game-block-active', state.status === 'playing' && index === state.currentPlayerIndex);
    appendText(block, 'game-block-emoji', player.emoji || '😀');
    appendText(block, 'game-block-name', player.name || `Player ${index + 1}`);
    block.appendChild(heap(player.hand.length));
    container.appendChild(block);
  });
}
function renderSelf(state, localPlayerIndex) {
  const player = state.players[localPlayerIndex];
  if (!player) return;
  const bar = document.getElementById('bl-self-bar');
  const emoji = document.getElementById('bl-self-emoji');
  const name = document.getElementById('bl-self-name');
  if (emoji) emoji.textContent = player.emoji || '😀';
  if (name) name.textContent = player.name || 'You';
  bar?.classList.toggle('self-bar-active', state.status === 'playing' && state.currentPlayerIndex === localPlayerIndex);
  const info = bar?.querySelector('.game-self-info');
  info?.querySelector('.bl-heap-wrap')?.remove();
  info?.appendChild(heap(player.hand.length));
}
function renderRoundIndicator(state) {
  let indicator = document.getElementById('bl-round-rank-indicator');
  const pile = document.getElementById('bl-pile-area');
  if (!indicator && pile?.parentNode) {
    indicator = document.createElement('div');
    indicator.id = 'bl-round-rank-indicator';
    pile.parentNode.insertBefore(indicator, pile);
  }
  if (!indicator) return;
  clear(indicator);
  if (state.lastPlacement) {
    const placement = state.lastPlacement;
    const player = state.players[placement.playerIndex];
    indicator.className = 'bl-round-rank-indicator bl-placement-banner';
    const line = document.createElement('div');
    line.className = 'bl-banner-line';
    appendText(line, 'bl-banner-who', `${player?.emoji || ''} ${player?.name || 'Player'}`.trim());
    appendText(line, 'bl-banner-what', `${placement.count} × ${placement.declaredRank}${placement.count > 1 ? 's' : ''}`);
    indicator.appendChild(line);
  } else if (state.currentRank) {
    indicator.className = 'bl-round-rank-indicator bl-round-rank-active';
    indicator.textContent = `Round: ${state.currentRank}s`;
  } else {
    indicator.className = 'bl-round-rank-indicator bl-round-rank-pick';
    indicator.textContent = '🎯 Pick a rank';
  }
}
function renderPile(state) {
  const container = clear(document.getElementById('bl-pile-area'));
  if (!container) return;
  const pile = document.createElement('div');
  pile.id = 'bl-pile-card-inner';
  pile.className = 'bl-pile-card';
  if (state.centerPile.length) pile.appendChild(renderCardBack());
  else appendText(pile, 'sr-pile-empty', '—', 'div');
  container.appendChild(pile);
  appendText(container, 'pile-count', `Pile: ${state.centerPile.length}`, 'p');
}
function wireCardDrag(elements, onReorder) {
  if (typeof onReorder !== 'function') return;
  let drag = null;
  let suppressClickUntil = 0;
  const nearest = (x) => {
    let target = 0;
    let distance = Infinity;
    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const next = Math.abs(x - (rect.left + rect.width / 2));
      if (next < distance) { distance = next; target = index; }
    });
    return target;
  };
  elements.forEach((element, visualIndex) => {
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        cardId: element.dataset.cardId, target: visualIndex, moved: false, source: element };
      try { element.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
    });
    element.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy))) return;
      drag.moved = true;
      event.preventDefault();
      drag.target = nearest(event.clientX);
      elements.forEach((item, index) => item.classList.toggle('sr-card-selected', index === drag.target));
    });
    const finish = (event, cancelled = false) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const completed = drag;
      drag = null;
      elements.forEach((item) => item.classList.remove('sr-card-selected'));
      if (!completed.moved) return;
      suppressClickUntil = Date.now() + 400;
      event.preventDefault();
      if (!cancelled) onReorder(completed.cardId, completed.target);
    };
    element.addEventListener('pointerup', (event) => finish(event));
    element.addEventListener('pointercancel', (event) => finish(event, true));
  });
  return () => Date.now() < suppressClickUntil;
}
function renderHand(state, localPlayerIndex, handOrder, canSelect, callbacks) {
  const container = clear(document.getElementById('bl-hand-area'));
  const player = state.players[localPlayerIndex];
  if (!container || !player) return;
  reconcileSelection(player.hand);
  const cards = orderedHand(player.hand, handOrder);
  const grid = document.createElement('div');
  grid.className = 'bl-hand-grid';
  const large = cards.length <= 30;
  grid.style.setProperty('--bl-grid-card-w', large ? '56px' : '48px');
  grid.style.setProperty('--bl-grid-card-h', large ? '78px' : '67px');
  grid.style.setProperty('--bl-grid-card-mx', large ? '-3px' : '-4px');
  const elements = cards.map((card, visualIndex) => {
    const element = renderCardFace(card);
    element.classList.add('bl-hand-card');
    element.dataset.cardId = card.id;
    element.dataset.visualIndex = String(visualIndex);
    element.classList.toggle('bl-card-selected', selectedCardIds.has(card.id));
    grid.appendChild(element);
    return element;
  });
  container.appendChild(grid);
  const dragSuppressed = wireCardDrag(elements, callbacks.onReorder) || (() => false);
  elements.forEach((element) => element.addEventListener('click', () => {
    if (dragSuppressed() || !canSelect) return;
    const cardId = element.dataset.cardId;
    if (selectedCardIds.has(cardId)) selectedCardIds.delete(cardId);
    else if (selectedCardIds.size < 4) selectedCardIds.add(cardId);
    element.classList.toggle('bl-card-selected', selectedCardIds.has(cardId));
    const button = document.querySelector('#bl-actions-area .bl-place-btn');
    if (button) {
      const count = selectedCardIds.size;
      button.disabled = count === 0;
      button.textContent = count ? `Place ${count} Card${count > 1 ? 's' : ''}` : 'Place Cards';
    }
  }));
}
function actionButton(container, label, className, action, onAction) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${className}`;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try { await onAction?.(action); }
    finally {
      if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  });
  container.appendChild(button);
  return button;
}
function placementPin(placement) {
  return {
    placementMoveId: placement.placementMoveId,
    placementRevision: placement.placementRevision,
  };
}
function renderActions(state, localPlayerIndex, callbacks) {
  const container = clear(document.getElementById('bl-actions-area'));
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'bl-action-row';
  const myTurn = state.status === 'playing' && state.currentPlayerIndex === localPlayerIndex;
  const placement = state.lastPlacement;
  const canChallenge = state.status === 'playing' && placement && placement.playerIndex !== localPlayerIndex;
  if (myTurn) {
    const place = actionButton(row, 'Place Cards', 'primary bl-place-btn', null, async () => {
      const cardIds = [...selectedCardIds];
      if (!cardIds.length) return;
      const submit = (declaredRank) => callbacks.onAction?.({
        type: 'place', payload: { cardIds, declaredRank },
      });
      if (state.currentRank) await submit(state.currentRank);
      else renderRankSelector(submit);
    });
    place.disabled = selectedCardIds.size === 0;
    if (selectedCardIds.size) place.textContent = `Place ${selectedCardIds.size} Card${selectedCardIds.size > 1 ? 's' : ''}`;
    if (state.currentRank) {
      actionButton(row, '⏭ Pass', 'bl-pass-btn', { type: 'pass', payload: null }, callbacks.onAction);
    }
    if (placement) {
      actionButton(
        row,
        placement.placerEmpty ? 'Accept Winner' : 'Accept',
        'secondary bl-accept-btn',
        { type: 'accept', payload: placementPin(placement) },
        callbacks.onAction,
      );
    }
  }
  if (canChallenge) {
    actionButton(
      row, 'BLUFF!', 'primary bl-bluff-btn',
      { type: 'challenge', payload: placementPin(placement) }, callbacks.onAction,
    );
  }
  if (!myTurn && !canChallenge && state.status === 'playing') {
    appendText(row, 'bl-wait-text', `Waiting for ${state.players[state.currentPlayerIndex]?.name || 'Player'}...`, 'p');
  }
  container.appendChild(row);
}
function renderChallengePrompt(state, localPlayerIndex) {
  const area = clear(document.getElementById('bl-challenge-area'));
  if (!area) return;
  const placement = state.lastPlacement;
  const visible = state.status === 'playing' && placement && placement.playerIndex !== localPlayerIndex;
  area.hidden = !visible;
  if (!visible) return;
  const placer = state.players[placement.playerIndex];
  appendText(
    area,
    'bl-challenge-announcement bl-challenge-announcement-prominent',
    `${placer?.emoji || ''} ${placer?.name || 'Player'} placed ${placement.count} × ${placement.declaredRank}`.trim(),
    'p',
  );
  appendText(area, 'bl-wait-text', 'Challenge now, or let the current player act.', 'p');
}
function wireSort(callbacks, state) {
  let host = document.getElementById('bl-sort-host');
  const hand = document.getElementById('bl-hand-area');
  if (!host && hand?.parentNode) {
    host = document.createElement('div');
    host.id = 'bl-sort-host';
    host.className = 'bl-sort-host';
    hand.parentNode.insertBefore(host, hand.nextSibling);
  }
  clear(host);
  if (!host) return;
  const button = actionButton(host, '🔢 Sort by Rank', 'secondary bl-sort-btn', null, () => callbacks.onSort?.('rank'));
  button.disabled = state.status !== 'playing';
}

export function renderGameplay(state, localPlayerIndex, callbacks = {}) {
  const player = state.players[localPlayerIndex];
  if (!player) return;
  renderOpponents(state, localPlayerIndex);
  renderSelf(state, localPlayerIndex);
  renderRoundIndicator(state);
  renderPile(state);
  renderHand(
    state,
    localPlayerIndex,
    callbacks.handOrder,
    state.status === 'playing' && state.currentPlayerIndex === localPlayerIndex,
    callbacks,
  );
  renderActions(state, localPlayerIndex, callbacks);
  renderChallengePrompt(state, localPlayerIndex);
  wireSort(callbacks, state);
  const bar = document.getElementById('bl-event-bar');
  if (bar && !bar.textContent) {
    bar.textContent = state.currentPlayerIndex === localPlayerIndex
      ? 'Your turn' : `${state.players[state.currentPlayerIndex]?.name || 'Player'}’s turn`;
  }
}

export function getSelectedCardIds() { return [...selectedCardIds]; }
export function clearSelection() { selectedCardIds = new Set(); }
export function renderRankSelector(onRankSelect) {
  const overlay = clear(document.getElementById('bl-rank-selector'));
  if (!overlay) return;
  overlay.hidden = false;
  const box = document.createElement('div');
  box.className = 'bl-rank-box';
  appendText(box, '', 'Declare a Rank', 'h3');
  const grid = document.createElement('div');
  grid.className = 'bl-rank-grid';
  BLUFF_RANKS.forEach((rank) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bl-rank-btn';
    button.textContent = rank;
    button.addEventListener('click', async () => {
      hideRankSelector();
      await onRankSelect?.(rank);
    });
    grid.appendChild(button);
  });
  box.appendChild(grid);
  const cancel = actionButton(box, 'Cancel', 'secondary bl-rank-cancel', null, () => hideRankSelector());
  cancel.setAttribute('aria-label', 'Cancel rank selection');
  overlay.appendChild(box);
}
export function hideRankSelector() {
  const overlay = clear(document.getElementById('bl-rank-selector'));
  if (overlay) overlay.hidden = true;
}
export function renderChallengeResult({ revealedCards, declaredRank, bluffCaught, loserName }) {
  const overlay = clear(document.getElementById('bl-challenge-result'));
  if (!overlay) return null;
  overlay.hidden = false;
  const box = document.createElement('div');
  box.className = 'bl-result-box';
  appendText(
    box,
    bluffCaught ? 'bl-result-caught' : 'bl-result-truthful',
    bluffCaught ? '🚨 Bluff Caught!' : '✅ Was Truthful!',
    'h3',
  );
  appendText(box, 'bl-result-declared', `Declared: ${revealedCards.length} × ${declaredRank}`, 'p');
  const row = document.createElement('div');
  row.className = 'bl-result-cards';
  revealedCards.forEach((card) => row.appendChild(renderCardFace(card)));
  box.appendChild(row);
  appendText(box, 'bl-result-loser', `${loserName} takes the pile!`, 'p');
  overlay.appendChild(box);
  return overlay;
}
export function hideChallengeResult() {
  const overlay = clear(document.getElementById('bl-challenge-result'));
  if (overlay) overlay.hidden = true;
}
export function setEventMessage(message) {
  const bar = document.getElementById('bl-event-bar');
  if (bar) bar.textContent = message || '';
}
export function renderResults(state) {
  clearSelection();
  const display = clear(document.getElementById('bl-winner-display'));
  if (display) {
    const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
    if (winner) {
      appendText(display, 'winner-emoji', winner.emoji || '🏆', 'div');
      appendText(display, 'winner-name', `${winner.name} wins!`, 'div');
    } else appendText(display, 'winner-name', 'Game ended — no winner', 'div');
  }
  const list = clear(document.getElementById('bl-results-list'));
  if (!list) return;
  state.players.forEach((player, index) => {
    const item = document.createElement('li');
    appendText(item, 'bl-result-player', `${player.emoji || '😀'} ${player.name}`);
    appendText(item, 'bounty-value', index === state.winnerIndex ? 'Winner' : `🃏 ${player.hand.length} cards`);
    list.appendChild(item);
  });
}
export function renderLobbyPlayers(players, isHost, playerKeys = []) {
  const list = clear(document.getElementById('bl-lobby-player-list'));
  if (!list) return;
  players.slice(0, 4).forEach((player, index) => {
    const item = document.createElement('li');
    appendText(item, 'bl-lobby-emoji', player.emoji || '😀');
    const name = appendText(item, 'bl-lobby-name', player.name || `Player ${index + 1}`);
    name.style.flex = '1';
    if (index === 0) appendText(item, 'host-badge', 'HOST');
    else if (isHost && playerKeys[index]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'remove-player-btn';
      button.textContent = '✕';
      button.title = `Remove ${player.name || `Player ${index + 1}`}`;
      button.dataset.playerIndex = String(Number.parseInt(playerKeys[index].replace('player_', ''), 10));
      button.dataset.playerUid = player.uid;
      button.dataset.playerName = player.name || `Player ${index + 1}`;
      item.appendChild(button);
    }
    list.appendChild(item);
  });
}
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = clear(document.getElementById('bl-ready-indicators'));
  if (!container) return;
  container.hidden = false;
  const ready = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers || []);
  const left = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);
  playerNames.slice(0, 4).forEach((name, index) => {
    const indicator = document.createElement('div');
    indicator.className = 'ready-dot';
    indicator.classList.toggle('ready', ready.has(index));
    indicator.classList.toggle('not-ready', left.has(index));
    appendText(indicator, 'dot', '', 'div');
    appendText(indicator, 'dot-name', name);
    container.appendChild(indicator);
  });
}
