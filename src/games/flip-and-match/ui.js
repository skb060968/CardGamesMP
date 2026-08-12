/**
 * Flip & Match — UI Module
 *
 * Renders gameplay screen with new layout:
 *   Top: opponent player blocks with won-cards deck
 *   Middle: 7×8 card grid (52 cards + 4 blank corners)
 *   Bottom: self block with won-cards deck + controls
 *
 * Also handles match animation rendering, results, lobby, ready indicators.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { calculatePot, getPlayerMetric, renderPotDisplay } from '../../shared/win-pot-calculator.js';

/* ======= CONSTANTS ======= */

const GRID_COLS = 7;
const GRID_ROWS = 8;
const TOTAL_CELLS = GRID_COLS * GRID_ROWS; // 56
const BLANK_CORNERS = new Set([0, 6, 49, 55]); // [0,0], [0,6], [7,0], [7,6]

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Flip & Match gameplay screen.
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {Function} onFlip - callback(cardIndex) when a face-down card is tapped
 * @param {object} lastMove - optional, for showing flip animation on remote devices
 */
export function renderGameplay(state, localPlayerIndex, onFlip, lastMove = null) {
  const opponentsArea = document.getElementById('fm-opponents-area');
  const gridArea = document.getElementById('fm-grid-area');
  const selfArea = document.getElementById('fm-self-area');

  if (opponentsArea) {
    renderOpponentBlocks(opponentsArea, state.players, state.currentPlayerIndex, localPlayerIndex);
  }

  if (gridArea) {
    const isMyTurn = state.currentPlayerIndex === localPlayerIndex;
    renderGrid(gridArea, state.board, isMyTurn, onFlip, lastMove);
  }

  if (selfArea) {
    renderSelfBlock(selfArea, state.players, state.currentPlayerIndex, localPlayerIndex);
  }
}

/* ======= OPPONENT BLOCKS (TOP) ======= */

/**
 * Renders player blocks for all players except self at the top.
 */
function renderOpponentBlocks(container, players, currentPlayerIndex, localPlayerIndex) {
  container.innerHTML = '';

  players.forEach((player, i) => {
    if (i === localPlayerIndex) return; // skip self

    const block = document.createElement('div');
    block.className = 'fm-player-block';
    if (i === currentPlayerIndex) block.classList.add('fm-active-turn');

    // Emoji
    const emoji = document.createElement('span');
    emoji.className = 'fm-block-emoji';
    emoji.textContent = player.emoji;

    // Name
    const name = document.createElement('span');
    name.className = 'fm-block-name';
    name.textContent = player.name;

    // Won count
    const count = player.collected ? player.collected.length : 0;
    const countEl = document.createElement('span');
    countEl.className = 'fm-block-count';
    countEl.textContent = `🃏 ${count}`;

    // Won cards mini deck
    const deck = buildWonCardsDeck(count);

    block.appendChild(emoji);
    block.appendChild(name);
    block.appendChild(countEl);
    block.appendChild(deck);
    container.appendChild(block);
  });
}

/* ======= SELF BLOCK (BOTTOM) ======= */

/**
 * Renders the self player block at the bottom.
 */
function renderSelfBlock(container, players, currentPlayerIndex, localPlayerIndex) {
  container.innerHTML = '';

  const player = players[localPlayerIndex];
  if (!player) return;

  const block = document.createElement('div');
  block.className = 'fm-self-block';
  if (currentPlayerIndex === localPlayerIndex) block.classList.add('fm-active-turn');

  // Left side: emoji + name + count
  const info = document.createElement('div');
  info.className = 'fm-self-info';

  const emoji = document.createElement('span');
  emoji.className = 'fm-block-emoji';
  emoji.textContent = player.emoji;

  const name = document.createElement('span');
  name.className = 'fm-block-name';
  name.textContent = 'You';

  const count = player.collected ? player.collected.length : 0;
  const countEl = document.createElement('span');
  countEl.className = 'fm-block-count';
  countEl.textContent = `🃏 ${count}`;

  info.appendChild(emoji);
  info.appendChild(name);
  info.appendChild(countEl);

  // Right side: won cards mini deck
  const deck = buildWonCardsDeck(count);

  block.appendChild(info);
  block.appendChild(deck);
  container.appendChild(block);
}

/* ======= WON CARDS MINI DECK ======= */

/**
 * Builds a small horizontal strip of face-down mini cards showing won cards.
 * Shows max 6 overlapping cards + a count badge.
 */
function buildWonCardsDeck(count) {
  const deck = document.createElement('div');
  deck.className = 'fm-won-deck';

  if (count === 0) {
    deck.classList.add('fm-won-deck-empty');
    return deck;
  }

  const visible = Math.min(count, 6);
  for (let i = 0; i < visible; i++) {
    const mini = document.createElement('div');
    mini.className = 'fm-mini-card';
    deck.appendChild(mini);
  }

  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'fm-won-badge';
    badge.textContent = String(count);
    deck.appendChild(badge);
  }

  return deck;
}

/* ======= CARD GRID (7×8 with blank corners) ======= */

/**
 * Renders the card grid — 7 columns × 8 rows = 56 cells.
 * 4 corner cells are blank, 52 cells hold cards.
 */
function renderGrid(container, board, isMyTurn, onFlip, lastMove = null) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'fm-grid';

  let cardIdx = 0; // index into the 52-card board array

  for (let cellIdx = 0; cellIdx < TOTAL_CELLS; cellIdx++) {
    const cell = document.createElement('div');
    cell.className = 'fm-cell';

    if (BLANK_CORNERS.has(cellIdx)) {
      // Blank corner cell
      cell.classList.add('fm-blank');
      grid.appendChild(cell);
      continue;
    }

    // Map this grid cell to a board card
    if (cardIdx >= board.length) {
      cell.classList.add('fm-blank');
      grid.appendChild(cell);
      continue;
    }

    const slot = board[cardIdx];
    cell.dataset.cardIndex = String(cardIdx);

    if (slot.state === 'down') {
      const cardEl = renderCardBack();
      cardEl.classList.add('fm-grid-card');

      if (isMyTurn) {
        cell.classList.add('fm-tappable');
        cardEl.style.cursor = 'pointer';
        const idx = cardIdx;
        cardEl.addEventListener('click', () => {
          if (onFlip) {
            // Add flip animation class
            cardEl.classList.add('fm-flipping');
            // Call flip handler after a tiny delay
            setTimeout(() => onFlip(idx), 50);
          }
        });
      } else {
        cardEl.style.cursor = 'default';
      }

      cell.appendChild(cardEl);
    } else if (slot.state === 'up') {
      const cardEl = renderCardFace(slot.card);
      cardEl.classList.add('fm-grid-card');
      cardEl.style.cursor = 'default';
      cell.appendChild(cardEl);
    } else {
      // collected — empty slot
      cell.classList.add('fm-collected');
    }

    cardIdx++;
    grid.appendChild(cell);
  }

  container.appendChild(grid);
}

/* ======= MATCH ANIMATION ======= */

/**
 * Animates a match: both cards rise with gold glow, then sweep toward
 * the winning player's deck area.
 *
 * @param {number} flippedCardIndex - board index of the newly flipped card
 * @param {number} matchedCardIndex - board index of the existing face-up match
 * @param {number} winnerPlayerIndex - player who won the pair
 * @param {number} localPlayerIndex - local player index (to determine sweep target)
 * @returns {Promise<void>} resolves when animation completes
 */
export function animateMatch(flippedCardIndex, matchedCardIndex, winnerPlayerIndex, localPlayerIndex) {
  return new Promise((resolve) => {
    const gridArea = document.getElementById('fm-grid-area');
    if (!gridArea) { resolve(); return; }

    // Find the two cells by data-card-index
    const cell1 = gridArea.querySelector(`[data-card-index="${flippedCardIndex}"]`);
    const cell2 = gridArea.querySelector(`[data-card-index="${matchedCardIndex}"]`);

    if (!cell1 || !cell2) { resolve(); return; }

    const card1 = cell1.querySelector('.fm-grid-card');
    const card2 = cell2.querySelector('.fm-grid-card');

    if (!card1 || !card2) { resolve(); return; }

    // Step 1: Rise + gold glow
    card1.classList.add('fm-match-rise');
    card2.classList.add('fm-match-rise');

    // Determine sweep target position
    const targetEl = getSweepTarget(winnerPlayerIndex, localPlayerIndex);
    const gridRect = gridArea.getBoundingClientRect();

    setTimeout(() => {
      // Step 2: Sweep toward winner's deck
      if (targetEl) {
        const targetRect = targetEl.getBoundingClientRect();
        const card1Rect = card1.getBoundingClientRect();
        const card2Rect = card2.getBoundingClientRect();

        const sweepX1 = targetRect.left + targetRect.width / 2 - (card1Rect.left + card1Rect.width / 2);
        const sweepY1 = targetRect.top + targetRect.height / 2 - (card1Rect.top + card1Rect.height / 2);
        const sweepX2 = targetRect.left + targetRect.width / 2 - (card2Rect.left + card2Rect.width / 2);
        const sweepY2 = targetRect.top + targetRect.height / 2 - (card2Rect.top + card2Rect.height / 2);

        card1.style.setProperty('--sweep-x', `${sweepX1}px`);
        card1.style.setProperty('--sweep-y', `${sweepY1}px`);
        card2.style.setProperty('--sweep-x', `${sweepX2}px`);
        card2.style.setProperty('--sweep-y', `${sweepY2}px`);
      }

      card1.classList.remove('fm-match-rise');
      card2.classList.remove('fm-match-rise');
      card1.classList.add('fm-match-sweep');
      card2.classList.add('fm-match-sweep');

      // Step 3: After sweep, resolve
      setTimeout(() => {
        resolve();
      }, 600);
    }, 800); // hold rise for 800ms
  });
}

/**
 * Gets the DOM element to sweep cards toward (the player's won-deck).
 */
function getSweepTarget(winnerPlayerIndex, localPlayerIndex) {
  if (winnerPlayerIndex === localPlayerIndex) {
    // Self block
    const selfArea = document.getElementById('fm-self-area');
    if (selfArea) return selfArea.querySelector('.fm-won-deck') || selfArea;
  } else {
    // Opponent blocks — find the right one
    const opponentsArea = document.getElementById('fm-opponents-area');
    if (opponentsArea) {
      const blocks = opponentsArea.querySelectorAll('.fm-player-block');
      // We need to figure out which block corresponds to winnerPlayerIndex
      // Blocks are rendered in order skipping localPlayerIndex
      let blockIdx = 0;
      for (let i = 0; i < 4; i++) {
        if (i === localPlayerIndex) continue;
        if (i === winnerPlayerIndex) {
          return blocks[blockIdx]?.querySelector('.fm-won-deck') || blocks[blockIdx] || null;
        }
        blockIdx++;
      }
    }
  }
  return null;
}

/* ======= EVENT BAR ======= */

/**
 * Sets the event message bar text.
 * @param {string} message
 */
export function setEventMessage(message) {
  const bar = document.getElementById('fm-event-bar');
  if (bar) bar.textContent = message || '';
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 */
export function renderResults(state) {
  const display = document.getElementById('fm-winner-display');
  const resultsList = document.getElementById('fm-results-list');

  if (display) {
    display.innerHTML = '';

    if (state.isTie && state.tiedIndices && state.tiedIndices.length > 1) {
      const tieEl = document.createElement('div');
      tieEl.className = 'winner-name';
      const names = state.tiedIndices.map((i) => state.players[i].name).join(' & ');
      tieEl.textContent = `🤝 Tie: ${names}`;
      display.appendChild(tieEl);

      const countEl = document.createElement('div');
      countEl.className = 'winner-bounty';
      countEl.textContent = `${state.players[state.tiedIndices[0]].collected.length} cards each`;
      display.appendChild(countEl);
    } else if (state.winnerIndex != null && state.players[state.winnerIndex]) {
      const winner = state.players[state.winnerIndex];
      const emojiEl = document.createElement('div');
      emojiEl.className = 'winner-emoji';
      emojiEl.textContent = winner.emoji;

      const nameEl = document.createElement('div');
      nameEl.className = 'winner-name';
      nameEl.textContent = `${winner.name} wins!`;

      display.appendChild(emojiEl);
      display.appendChild(nameEl);

      const pot = calculatePot('flip-and-match', state);
      if (pot > 0) {
        display.appendChild(renderPotDisplay(pot));
      }
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';

    // Sort players by collected count descending
    const ranked = state.players
      .map((p, i) => ({ ...p, index: i }))
      .sort((a, b) => b.collected.length - a.collected.length);

    ranked.forEach((player) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = getPlayerMetric('flip-and-match', state, player.index);
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      resultsList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 * @param {Array<{name, emoji}>} players
 */
export function renderLobbyPlayers(players, isHost, playerKeys = []) {
  const list = document.getElementById('fm-lobby-player-list');
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
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-player-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove player';
      const playerIndex = parseInt(playerKeys[index].replace('player_', ''), 10);
      removeBtn.dataset.playerIndex = playerIndex;
      removeBtn.dataset.playerName = player.name;
      li.appendChild(removeBtn);
    }
    list.appendChild(li);
  });
}

/* ======= READY INDICATORS ======= */

/**
 * Renders ready indicators for play-again flow.
 */
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('fm-ready-indicators');
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
