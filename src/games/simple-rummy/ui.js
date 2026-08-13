import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';

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

function renderBackStack(container, count, className) {
  if (!container) return;
  container.innerHTML = '';
  const visible = Math.min(count, 5);
  for (let index = 0; index < visible; index += 1) {
    const card = renderCardBack();
    card.classList.add(className);
    card.style.zIndex = String(index);
    container.appendChild(card);
  }
}

function renderOpponents(state, localPlayerIndex) {
  const container = clear(document.getElementById('sr-opponents-area'));
  if (!container) return;
  state.players.forEach((player, playerIndex) => {
    if (playerIndex === localPlayerIndex) return;
    const block = document.createElement('div');
    block.className = 'sr-opponent sr-player-chip';
    block.dataset.playerIndex = String(playerIndex);
    if (playerIndex === state.currentPlayerIndex) block.classList.add('sr-chip-active');
    appendText(block, 'sr-player-emoji sr-chip-emoji', player.emoji || '😀');
    appendText(block, 'sr-player-name sr-chip-info', player.name || `Player ${playerIndex + 1}`);
    const cards = document.createElement('div');
    cards.className = 'sr-opponent-hand sr-opponent-hand-strip';
    renderBackStack(cards, player.hand.length, 'sr-strip-card');
    block.appendChild(cards);
    appendText(block, 'sr-card-count', `🃏 ${player.hand.length}`);
    container.appendChild(block);
  });
}
function renderDrawPile(state, canDraw, onDraw) {
  const container = clear(document.getElementById('sr-draw-pile'));
  container?.parentElement?.classList.toggle('sr-pile-tappable', canDraw);
  if (container && (state.drawPile.length > 0 || canDraw)) {
    const card = renderCardBack();
    card.classList.add('sr-pile-card');
    if (state.drawPile.length === 0) card.classList.add('sr-stock-exhausted');
    card.dataset.drawSource = 'drawPile';
    if (canDraw) card.addEventListener('click', () => onDraw?.('drawPile'));
    container.appendChild(card);
  }
  const count = document.getElementById('sr-draw-count');
  if (count) count.textContent = `Stock: ${state.drawPile.length}`;
}

function renderDiscardPile(state, canDraw, onDraw) {
  const container = clear(document.getElementById('sr-discard-pile'));
  container?.parentElement?.classList.toggle('sr-pile-tappable', canDraw);
  const top = state.discardPile[state.discardPile.length - 1];
  if (container && top) {
    const card = renderCardFace(top);
    card.classList.add('sr-pile-card');
    card.dataset.drawSource = 'discardPile';
    if (canDraw) card.addEventListener('click', () => onDraw?.('discardPile'));
    container.appendChild(card);
  }
  const count = document.getElementById('sr-discard-count');
  if (count) count.textContent = `Discard: ${state.discardPile.length}`;
}

function renderLocalHand(state, localPlayerIndex, canDiscard, onDiscard, controls = {}) {
  const container = clear(document.getElementById('sr-hand'));
  const player = state.players[localPlayerIndex];
  if (!container || !player) return;

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

  const clearDragStyles = () => {
    cardElements.forEach((element) => {
      element.classList.remove('sr-card-dragging', 'sr-card-drop-target');
    });
  };

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
    if (!cancelled) controls.onReorder?.(cardId, targetVisualIndex);
  };

  ordered.forEach(({ card, handIndex }, visualIndex) => {
    const cardElement = renderCardFace(card);
    cardElement.classList.add('sr-arc-card', 'sr-reorderable');
    cardElement.dataset.handIndex = String(handIndex);
    cardElement.dataset.visualIndex = String(visualIndex);
    cardElement.dataset.cardId = card.id;
    if (canDiscard) cardElement.classList.add('sr-discardable');

    cardElement.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = {
        pointerId: event.pointerId,
        cardId: card.id,
        source: cardElement,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        targetVisualIndex: visualIndex,
      };
      try { cardElement.setPointerCapture(event.pointerId); } catch (_) { /* optional browser API */ }
    });

    cardElement.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(deltaX) < 8 || Math.abs(deltaX) < Math.abs(deltaY)) return;
        drag.moved = true;
        drag.source.classList.add('sr-card-dragging');
      }
      event.preventDefault();
      const targetIndex = nearestVisualIndex(event.clientX);
      drag.targetVisualIndex = targetIndex;
      cardElements.forEach((element, index) => {
        element.classList.toggle('sr-card-drop-target', index === targetIndex && element !== drag.source);
      });
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

  const name = document.getElementById('sr-self-name');
  if (name) name.textContent = `${player.emoji || '😀'} ${player.name || 'You'}`;
  const count = document.getElementById('sr-self-count');
  if (count) count.textContent = `🃏 ${player.hand.length}`;
}

function wireSortControls(onSort, enabled) {
  const rankButton = document.getElementById('sr-sort-rank');
  const suitButton = document.getElementById('sr-sort-suit');
  if (rankButton) {
    rankButton.disabled = !enabled || typeof onSort !== 'function';
    rankButton.onclick = () => onSort?.('rank');
  }
  if (suitButton) {
    suitButton.disabled = !enabled || typeof onSort !== 'function';
    suitButton.onclick = () => onSort?.('suit');
  }
}

function renderDrawResult(state, localPlayerIndex, lastMove) {
  const container = clear(document.getElementById('sr-draw-result'));
  if (!container || lastMove?.type !== 'draw-card') return;
  const label = document.createElement('span');
  label.className = 'sr-draw-result-label';
  const actor = state.players[lastMove.playerIndex];
  label.textContent = lastMove.playerIndex === localPlayerIndex
    ? `You drew from ${lastMove.source === 'discardPile' ? 'discard' : 'stock'}`
    : `${actor?.name || 'Player'} drew a card`;
  container.appendChild(label);
  if (lastMove.playerIndex === localPlayerIndex && lastMove.card) {
    const card = renderCardFace(lastMove.card);
    card.classList.add('sr-draw-result-card');
    container.appendChild(card);
  } else if (lastMove.card) {
    const card = renderCardBack();
    card.classList.add('sr-draw-result-card');
    container.appendChild(card);
  }
}

export function renderGameplay(
  state,
  localPlayerIndex,
  onDraw,
  onDiscard,
  lastMove = null,
  handControls = {},
) {
  const isLocalTurn = state.currentPlayerIndex === localPlayerIndex;
  const canDraw = state.status === 'playing' && isLocalTurn && state.turnPhase === 'draw';
  const canDiscard = state.status === 'playing' && isLocalTurn && state.turnPhase === 'discard';
  renderOpponents(state, localPlayerIndex);
  renderDrawPile(state, canDraw, onDraw);
  renderDiscardPile(state, canDraw, onDraw);
  renderLocalHand(state, localPlayerIndex, canDiscard, onDiscard, handControls);
  wireSortControls(handControls.onSort, state.status === 'playing');
  renderDrawResult(state, localPlayerIndex, lastMove);
  const bar = document.getElementById('sr-event-bar');
  if (bar) {
    if (state.status !== 'playing') bar.textContent = 'Round finished';
    else if (isLocalTurn) bar.textContent = canDraw ? 'Your turn — draw a card' : 'Choose a card to discard';
    else bar.textContent = `${state.players[state.currentPlayerIndex]?.name || 'Player'}’s turn`;
  }
}

function renderWinningGroups(state) {
  const container = clear(document.getElementById('sr-win-groups'));
  if (!container || !Array.isArray(state.winGroups)) return;
  state.winGroups.forEach((group, groupIndex) => {
    const groupElement = document.createElement('div');
    groupElement.className = 'sr-win-group';
    groupElement.dataset.groupIndex = String(groupIndex);
    group.forEach((card) => {
      const cardElement = renderCardFace(card);
      cardElement.classList.add('sr-win-card');
      groupElement.appendChild(cardElement);
    });
    container.appendChild(groupElement);
  });
}

export function renderResults(state) {
  const display = clear(document.getElementById('sr-winner-display'));
  if (display) {
    const message = document.createElement('div');
    message.className = 'winner-name';
    if (state.winnerIndex == null) {
      message.textContent = 'Game ended — no winner';
    } else {
      const winner = state.players[state.winnerIndex];
      message.textContent = `${winner?.emoji || '🏆'} ${winner?.name || 'Player'} wins!`;
    }
    display.appendChild(message);
  }
  const list = clear(document.getElementById('sr-results-list'));
  if (list) {
    state.players.forEach((player, index) => {
      const item = document.createElement('li');
      appendText(item, 'sr-result-player', `${player.emoji || '😀'} ${player.name}`);
      appendText(item, 'sr-result-status', index === state.winnerIndex ? 'Winner' : `${player.hand.length} cards`);
      list.appendChild(item);
    });
  }
  renderWinningGroups(state);
}

export function setEventMessage(message) {
  const bar = document.getElementById('sr-event-bar');
  if (bar) bar.textContent = message || '';
}

export function renderLobbyPlayers(players, isHost, playerKeys = []) {
  const list = clear(document.getElementById('sr-lobby-player-list'));
  if (!list) return;
  players.forEach((player, index) => {
    const item = document.createElement('li');
    appendText(item, 'sr-lobby-emoji', player.emoji || '😀');
    const name = appendText(item, 'sr-lobby-name', player.name || `Player ${index + 1}`);
    name.style.flex = '1';
    if (index === 0) {
      appendText(item, 'host-badge', 'HOST');
    } else if (isHost && playerKeys[index]) {
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
  const container = clear(document.getElementById('sr-ready-indicators'));
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
