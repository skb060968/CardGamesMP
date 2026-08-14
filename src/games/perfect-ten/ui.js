import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { getCollectedRanks } from './engine.js';

const TARGET_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

function clear(container) {
  if (container) container.innerHTML = '';
  return container;
}

function appendText(parent, className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function renderBackStack(container, count) {
  if (!container) return;
  container.innerHTML = '';
  const visible = Math.min(count, 5);
  for (let index = 0; index < visible; index += 1) {
    const card = renderCardBack();
    card.classList.add('pt-strip-card');
    card.style.zIndex = String(index);
    container.appendChild(card);
  }
}

export function renderRankTracker(hand) {
  const tracker = document.createElement('div');
  tracker.className = 'pt-rank-tracker';
  const collected = getCollectedRanks(hand);
  TARGET_RANKS.forEach((rank) => {
    const cell = document.createElement('div');
    const present = collected.has(rank);
    cell.className = `pt-rank-cell ${present ? 'pt-rank-collected' : 'pt-rank-missing'}`;
    cell.textContent = rank;
    cell.setAttribute('aria-label', `Rank ${rank}: ${present ? 'collected' : 'missing'}`);
    tracker.appendChild(cell);
  });
  return tracker;
}

function renderOpponents(state, localPlayerIndex) {
  const container = clear(document.getElementById('pt-opponents-area'));
  if (!container) return;
  state.players.forEach((player, playerIndex) => {
    if (playerIndex === localPlayerIndex) return;
    const block = document.createElement('div');
    block.className = 'pt-opponent pt-player-chip';
    block.dataset.playerIndex = String(playerIndex);
    if (playerIndex === state.currentPlayerIndex) block.classList.add('pt-chip-active');
    appendText(block, 'pt-player-emoji pt-chip-emoji', player.emoji || '😀');
    appendText(block, 'pt-player-name pt-chip-info', player.name || `Player ${playerIndex + 1}`);
    const cards = document.createElement('div');
    cards.className = 'pt-opponent-hand pt-opponent-hand-strip';
    renderBackStack(cards, player.hand.length);
    block.appendChild(cards);
    appendText(block, 'pt-card-count', `🎯 ${getCollectedRanks(player.hand).size}/10`);
    container.appendChild(block);
  });
}

function renderDrawPile(state, canDraw, onDraw) {
  const container = clear(document.getElementById('pt-draw-pile'));
  container?.parentElement?.classList.toggle('pt-pile-tappable', canDraw);
  if (container && (state.drawPile.length > 0 || canDraw)) {
    const card = renderCardBack();
    card.classList.add('pt-pile-card');
    if (state.drawPile.length === 0) card.classList.add('pt-stock-exhausted');
    card.dataset.drawSource = 'drawPile';
    if (canDraw) card.addEventListener('click', () => onDraw?.('drawPile'));
    container.appendChild(card);
  }
  const count = document.getElementById('pt-draw-count');
  if (count) count.textContent = `Stock: ${state.drawPile.length}`;
}

function renderDiscardPile(state, canDraw, onDraw) {
  const container = clear(document.getElementById('pt-discard-pile'));
  container?.parentElement?.classList.toggle('pt-pile-tappable', canDraw);
  const top = state.discardPile[state.discardPile.length - 1];
  if (container && top) {
    const card = renderCardFace(top);
    card.classList.add('pt-pile-card');
    card.dataset.drawSource = 'discardPile';
    if (canDraw) card.addEventListener('click', () => onDraw?.('discardPile'));
    container.appendChild(card);
  }
  const count = document.getElementById('pt-discard-count');
  if (count) count.textContent = `Discard: ${state.discardPile.length}`;
}
function renderLocalHand(state, localPlayerIndex, canDiscard, onDiscard, controls = {}) {
  const container = clear(document.getElementById('pt-hand'));
  const player = state.players[localPlayerIndex];
  if (!container || !player) return;
  const renderGeneration = String((Number(container.dataset.renderGeneration) || 0) + 1);
  container.dataset.renderGeneration = renderGeneration;

  const byId = new Map(player.hand.map((card, handIndex) => [card.id, { card, handIndex }]));
  const ordered = [];
  const included = new Set();
  const requestedOrder = Array.isArray(controls.handOrder) ? controls.handOrder : [];
  requestedOrder.forEach((cardId) => {
    const entry = byId.get(cardId);
    if (entry && !included.has(cardId)) {
      ordered.push(entry);
      included.add(cardId);
    }
  });
  player.hand.forEach((card, handIndex) => {
    if (!included.has(card.id)) ordered.push({ card, handIndex });
  });

  const cardElements = [];
  let drag = null;
  let suppressDiscardUntil = 0;
  const clearDragStyles = () => cardElements.forEach((card) => {
    card.classList.remove('pt-card-dragging', 'pt-card-drop-target');
  });
  const nearestVisualIndex = (clientX) => {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    cardElements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(clientX - (rect.left + rect.width / 2));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    return nearestIndex;
  };
  const finishDrag = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const completed = drag.moved;
    const { source, cardId, targetVisualIndex } = drag;
    drag = null;
    try {
      if (source.hasPointerCapture?.(event.pointerId)) source.releasePointerCapture(event.pointerId);
    } catch (_) { /* pointer capture may already be released */ }
    clearDragStyles();
    if (!completed) return;
    suppressDiscardUntil = Date.now() + 500;
    event.preventDefault();
    event.stopPropagation();
    if (cancelled) return;
    const nextOrder = controls.onReorder?.(cardId, targetVisualIndex);
    const changed = Array.isArray(nextOrder)
      && (nextOrder.length !== requestedOrder.length
        || nextOrder.some((id, index) => id !== requestedOrder[index]));
    if (changed) {
      setTimeout(() => {
        if (container.isConnected && container.dataset.renderGeneration === renderGeneration) {
          renderLocalHand(state, localPlayerIndex, canDiscard, onDiscard, {
            ...controls, handOrder: nextOrder,
          });
        }
      }, 0);
    }
  };

  ordered.forEach(({ card, handIndex }, visualIndex) => {
    const cardElement = renderCardFace(card);
    cardElement.classList.add('pt-arc-card', 'pt-reorderable');
    cardElement.dataset.handIndex = String(handIndex);
    cardElement.dataset.visualIndex = String(visualIndex);
    cardElement.dataset.cardId = card.id;
    if (canDiscard) cardElement.classList.add('pt-discardable');
    cardElement.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = {
        pointerId: event.pointerId, cardId: card.id, source: cardElement,
        startX: event.clientX, startY: event.clientY, moved: false,
        targetVisualIndex: visualIndex,
      };
      try { cardElement.setPointerCapture(event.pointerId); } catch (_) { /* optional API */ }
    });
    cardElement.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(deltaX) < 8 || Math.abs(deltaX) < Math.abs(deltaY)) return;
        drag.moved = true;
        drag.source.classList.add('pt-card-dragging');
      }
      event.preventDefault();
      drag.targetVisualIndex = nearestVisualIndex(event.clientX);
      cardElements.forEach((element, index) => element.classList.toggle(
        'pt-card-drop-target', index === drag.targetVisualIndex && element !== drag.source,
      ));
    });
    cardElement.addEventListener('pointerup', (event) => finishDrag(event));
    cardElement.addEventListener('pointercancel', (event) => finishDrag(event, true));
    cardElement.addEventListener('click', (event) => {
      if (Date.now() < suppressDiscardUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (canDiscard) onDiscard?.(handIndex);
    });
    cardElements.push(cardElement);
    container.appendChild(cardElement);
  });

  const name = document.getElementById('pt-self-name');
  if (name) name.textContent = `${player.emoji || '😀'} ${player.name || 'You'}`;
  const count = document.getElementById('pt-self-count');
  if (count) count.textContent = `🎯 ${getCollectedRanks(player.hand).size}/10`;
  const trackerArea = clear(document.getElementById('pt-rank-tracker-area'));
  if (trackerArea) trackerArea.appendChild(renderRankTracker(player.hand));
}
function wireSortControls(onSort, enabled, onOrderChanged) {
  const rankButton = document.getElementById('pt-sort-rank');
  if (!rankButton) return;
  rankButton.disabled = !enabled || typeof onSort !== 'function';
  rankButton.onclick = () => {
    const nextOrder = onSort?.('rank');
    if (Array.isArray(nextOrder)) onOrderChanged?.(nextOrder);
  };
}

function renderDrawResult(state, localPlayerIndex, lastMove) {
  const container = clear(document.getElementById('pt-draw-result'));
  if (!container || lastMove?.type !== 'draw-card') return;
  const actor = state.players[lastMove.playerIndex];
  appendText(container, 'pt-draw-result-label', lastMove.playerIndex === localPlayerIndex
    ? `You drew from ${lastMove.source === 'discardPile' ? 'discard' : 'stock'}`
    : `${actor?.name || 'Player'} drew a card`);
  if (lastMove.card) {
    const card = lastMove.playerIndex === localPlayerIndex
      ? renderCardFace(lastMove.card)
      : renderCardBack();
    card.classList.add('pt-draw-result-card');
    container.appendChild(card);
  }
}

export function renderGameplay(
  state, localPlayerIndex, onDraw, onDiscard, lastMove = null, handControls = {},
) {
  const isLocalTurn = state.currentPlayerIndex === localPlayerIndex;
  const canDraw = state.status === 'playing' && isLocalTurn && state.turnPhase === 'draw';
  const canDiscard = state.status === 'playing' && isLocalTurn && state.turnPhase === 'discard';
  renderOpponents(state, localPlayerIndex);
  renderDrawPile(state, canDraw, onDraw);
  renderDiscardPile(state, canDraw, onDraw);
  renderLocalHand(state, localPlayerIndex, canDiscard, onDiscard, handControls);
  wireSortControls(
    handControls.onSort,
    state.status === 'playing',
    (nextOrder) => renderLocalHand(state, localPlayerIndex, canDiscard, onDiscard, {
      ...handControls, handOrder: nextOrder,
    }),
  );
  renderDrawResult(state, localPlayerIndex, lastMove);
  const bar = document.getElementById('pt-event-bar');
  if (bar) {
    if (state.status !== 'playing') bar.textContent = 'Round finished';
    else if (isLocalTurn) bar.textContent = canDraw ? 'Your turn — draw a card' : 'Choose a card to discard';
    else bar.textContent = `${state.players[state.currentPlayerIndex]?.name || 'Player'}’s turn`;
  }
}

export function renderResults(state) {
  const display = clear(document.getElementById('pt-winner-display'));
  if (display) {
    const message = document.createElement('div');
    message.className = 'winner-name';
    if (state.winnerIndex == null) message.textContent = 'Game ended — no winner';
    else {
      const winner = state.players[state.winnerIndex];
      message.textContent = `${winner?.emoji || '🏆'} ${winner?.name || 'Player'} wins!`;
    }
    display.appendChild(message);
    if (state.winnerIndex != null) {
      const detail = document.createElement('div');
      detail.className = 'winner-bounty';
      detail.textContent = 'Collected all 10 ranks! 🎯';
      display.appendChild(detail);
      display.appendChild(renderRankTracker(state.players[state.winnerIndex].hand));
    }
  }
  const list = clear(document.getElementById('pt-results-list'));
  if (list) {
    state.players.forEach((player, index) => {
      const item = document.createElement('li');
      appendText(item, 'pt-result-player', `${player.emoji || '😀'} ${player.name}`);
      appendText(item, 'pt-result-status', index === state.winnerIndex
        ? 'Winner' : `${getCollectedRanks(player.hand).size}/10 ranks`);
      list.appendChild(item);
    });
  }
}

export function setEventMessage(message) {
  const bar = document.getElementById('pt-event-bar');
  if (bar) bar.textContent = message || '';
}
export function renderLobbyPlayers(players, isHost, playerKeys = []) {
  const list = clear(document.getElementById('pt-lobby-player-list'));
  if (!list) return;
  players.forEach((player, index) => {
    const item = document.createElement('li');
    appendText(item, 'pt-lobby-emoji', player.emoji || '😀');
    const name = appendText(item, 'pt-lobby-name', player.name || `Player ${index + 1}`);
    name.style.flex = '1';
    if (index === 0) appendText(item, 'host-badge', 'HOST');
    else if (isHost && playerKeys[index]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'remove-player-btn';
      button.textContent = '✕';
      button.title = `Remove ${player.name || `Player ${index + 1}`}`;
      button.setAttribute('aria-label', button.title);
      button.dataset.playerIndex = String(Number.parseInt(playerKeys[index].replace('player_', ''), 10));
      button.dataset.playerUid = player.uid;
      button.dataset.playerName = player.name || `Player ${index + 1}`;
      item.appendChild(button);
    }
    list.appendChild(item);
  });
}

export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = clear(document.getElementById('pt-ready-indicators'));
  if (!container) return;
  container.hidden = false;
  const ready = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers || []);
  const left = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);
  playerNames.forEach((name, index) => {
    const indicator = document.createElement('div');
    indicator.className = 'ready-dot';
    if (ready.has(index)) indicator.classList.add('ready');
    if (left.has(index)) indicator.classList.add('not-ready');
    const dot = document.createElement('div');
    dot.className = 'dot';
    indicator.appendChild(dot);
    appendText(indicator, 'dot-name', name);
    container.appendChild(indicator);
  });
}
