/**
 * Patte Par Patta — UI Module
 *
 * Adapted from the standalone Patte Par Patta project with heap rendering.
 * Renders gameplay, lobby, results, and ready indicators.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { calculatePot, getPlayerMetric, renderPotDisplay } from '../../shared/win-pot-calculator.js';

// =========================================================
// Heap Rendering
// =========================================================

/**
 * Renders cards as absolute-positioned elements with random offset (±4px)
 * and rotation (±5°), incrementing zIndex. Creates a realistic messy pile.
 *
 * @param {HTMLElement} container - The container element
 * @param {number} cardCount - Number of cards to render
 * @param {boolean} [faceDown=true] - Whether to render face-down cards
 */
export function renderHeap(container, cardCount, faceDown = true) {
  container.innerHTML = '';
  container.style.position = 'relative';

  // Limit rendered cards for performance, but show enough for heap depth
  const renderCount = Math.min(cardCount, 6);

  for (let i = 0; i < renderCount; i++) {
    const cardEl = faceDown ? renderCardBack() : renderCardFace({ rank: '', suit: '' });
    cardEl.style.position = 'absolute';
    cardEl.style.top = '0';
    cardEl.style.left = '0';

    const offsetX = (Math.random() - 0.5) * 10;  // -5 to +5
    const offsetY = (Math.random() - 0.5) * 10;  // -5 to +5
    const rotation = (Math.random() - 0.5) * 14; // -7 to +7 degrees

    cardEl.style.transform = `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px) rotate(${rotation.toFixed(1)}deg)`;
    cardEl.style.zIndex = String(i);

    container.appendChild(cardEl);
  }
}

/**
 * Renders pile cards face-up as a heap with random offset/rotation.
 * Only renders the last 5 cards for performance.
 *
 * @param {HTMLElement} container - The pile card container
 * @param {Array<{rank: string, suit: string}>} cards - Pile cards
 */
export function renderPileHeap(container, cards) {
  container.innerHTML = '';
  container.style.position = 'relative';

  if (!cards || cards.length === 0) return;

  // Only render last 5 cards for performance
  const visibleCards = cards.slice(-5);

  visibleCards.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.style.position = 'absolute';
    cardEl.style.top = '0';
    cardEl.style.left = '0';
    cardEl.style.cursor = 'default';

    const offsetX = (Math.random() - 0.5) * 10;
    const offsetY = (Math.random() - 0.5) * 10;
    const rotation = (Math.random() - 0.5) * 14;

    cardEl.style.transform = `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px) rotate(${rotation.toFixed(1)}deg)`;
    cardEl.style.zIndex = String(i);

    container.appendChild(cardEl);
  });
}

// =========================================================
// Gameplay Rendering
// =========================================================

/**
 * Renders the full gameplay screen: player slots in two rows,
 * pile center, event bar. Each player slot has emoji, heap,
 * name, count. Active turn gets glow. Eliminated gets dim.
 * Tappable when it's local player's turn.
 *
 * @param {object} state - GameState
 * @param {number} localPlayerIndex - Index of the local player
 */
export function renderGameplay(state, localPlayerIndex) {
  const topRow = document.getElementById('top-players');
  const bottomRow = document.getElementById('bottom-players');
  if (!topRow || !bottomRow) return;

  topRow.innerHTML = '';
  bottomRow.innerHTML = '';

  const n = state.players.length;
  const topCount = Math.floor(n / 2);

  state.players.forEach((player, i) => {
    const slot = _createPlayerSlot(player, i, state, localPlayerIndex);
    if (i < topCount) {
      topRow.appendChild(slot);
    } else {
      bottomRow.appendChild(slot);
    }
  });

  _renderPile(state);
}

/**
 * Creates a player slot element with emoji, heap, name, and card count.
 */
function _createPlayerSlot(player, playerIdx, state, localPlayerIndex) {
  const slot = document.createElement('div');
  slot.className = 'player-slot';
  slot.dataset.playerIndex = playerIdx;

  if (playerIdx === state.currentPlayerIndex) {
    slot.classList.add('active-turn');
  }
  if (player.eliminated) {
    slot.classList.add('eliminated');
  }

  // Only the local player's heap is tappable when it's their turn
  const isTappable = playerIdx === localPlayerIndex && playerIdx === state.currentPlayerIndex;
  if (isTappable) {
    slot.classList.add('my-turn');
  }

  const emoji = document.createElement('span');
  emoji.className = 'player-slot-emoji';
  emoji.textContent = player.emoji;

  const deckWrapper = document.createElement('div');
  deckWrapper.className = 'player-slot-deck heap-container';

  if (!player.eliminated && player.hand.length > 0) {
    renderHeap(deckWrapper, player.hand.length, true);
    // Tag the top card for tap handling
    const topCard = deckWrapper.lastElementChild;
    if (topCard) {
      topCard.dataset.handIndex = '0';
      topCard.dataset.playerIndex = String(playerIdx);
    }
  }

  const name = document.createElement('span');
  name.className = 'player-slot-name';
  name.textContent = player.name;

  const count = document.createElement('span');
  count.className = 'player-slot-count';
  count.textContent = player.eliminated ? 'Out' : `🃏 ${player.hand.length}`;

  slot.appendChild(emoji);
  slot.appendChild(deckWrapper);
  slot.appendChild(name);
  slot.appendChild(count);

  return slot;
}

/**
 * Renders the pile area as a face-up heap with pile count.
 */
function _renderPile(state) {
  const pileCard = document.getElementById('pile-card');
  const pileCount = document.getElementById('pile-count');

  if (pileCard) {
    renderPileHeap(pileCard, state.pile);
  }

  if (pileCount) {
    pileCount.textContent = `Pile: ${state.pile.length}`;
  }
}

/**
 * Sets an event message in the event bar.
 * @param {string} message
 */
export function setEventMessage(message) {
  const bar = document.getElementById('event-bar');
  if (bar) bar.textContent = message;
}

// =========================================================
// Lobby
// =========================================================

/**
 * Renders the player list in the lobby screen with emoji + name + HOST badge.
 *
 * @param {Array<{name: string, emoji: string}>} players
 * @param {boolean} isHost
 */
export function renderLobbyPlayers(players, isHost, playerKeys = []) {
  const list = document.getElementById('lobby-player-list');
  if (!list) return;

  list.innerHTML = '';

  players.forEach((player, index) => {
    const li = document.createElement('li');

    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';

    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);

    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    } else if (isHost && playerKeys[index]) {
      // Show remove button for non-host players when current user is host
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-player-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove player';
      // Store player info in data attributes for event delegation
      const playerIndex = parseInt(playerKeys[index].replace('player_', ''), 10);
      removeBtn.dataset.playerIndex = playerIndex;
      removeBtn.dataset.playerName = player.name;
      li.appendChild(removeBtn);
    }

    list.appendChild(li);
  });
}

// =========================================================
// Results
// =========================================================

/**
 * Renders the results screen: winner or draw display, player status list.
 * @param {object} state - GameState (status === 'finished')
 */
export function renderResults(state) {
  const winnerDisplay = document.getElementById('winner-display');
  const bountyList = document.getElementById('results-bounty-list');

  if (winnerDisplay) {
    winnerDisplay.innerHTML = '';

    if (state.winnerIndex != null) {
      const winner = state.players[state.winnerIndex];
      const emojiEl = document.createElement('div');
      emojiEl.className = 'winner-emoji';
      emojiEl.textContent = winner.emoji;

      const nameEl = document.createElement('div');
      nameEl.className = 'winner-name';
      nameEl.textContent = `${winner.name} wins!`;

      winnerDisplay.appendChild(emojiEl);
      winnerDisplay.appendChild(nameEl);

      const pot = calculatePot('patte-par-patta', state);
      if (pot > 0) {
        winnerDisplay.appendChild(renderPotDisplay(pot));
      }
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      winnerDisplay.appendChild(drawEl);
    }
  }

  if (bountyList) {
    bountyList.innerHTML = '';

    state.players.forEach((player, i) => {
      const li = document.createElement('li');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;

      const statusSpan = document.createElement('span');
      statusSpan.className = 'bounty-value';
      statusSpan.textContent = getPlayerMetric('patte-par-patta', state, i);

      li.appendChild(nameSpan);
      li.appendChild(statusSpan);
      bountyList.appendChild(li);
    });
  }
}

// =========================================================
// Ready Indicators
// =========================================================

/**
 * Renders ready indicators for play-again flow.
 * Green dot for ready, red dot for left, neutral for waiting.
 *
 * @param {string[]} playerNames
 * @param {Set<number>|number[]} readyPlayers
 * @param {Set<number>|number[]} [leftPlayers]
 */
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('ready-indicators');
  if (!container) return;

  container.hidden = false;
  container.innerHTML = '';

  const readySet = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers);
  const leftSet = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);

  playerNames.forEach((name, index) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readySet.has(index)) dot.classList.add('ready');
    if (leftSet.has(index)) dot.classList.add('not-ready');

    const circle = document.createElement('div');
    circle.className = 'dot';

    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = name;

    dot.appendChild(circle);
    dot.appendChild(label);
    container.appendChild(dot);
  });
}
