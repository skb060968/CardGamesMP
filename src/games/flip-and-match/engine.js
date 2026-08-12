/**
 * Flip & Match — Game Engine
 *
 * Pure game logic: create board, flip cards, detect matches,
 * collect pairs, determine winner, validate state, serialize.
 * No DOM or Firebase dependencies.
 */

import { createDeck, shuffle, serializeCard, deserializeCard } from '../../shared/deck.js';

/* ======= GAME CREATION ======= */

/**
 * Creates initial Flip & Match game state.
 * Shuffles a 52-card deck and lays all cards face-down on the board.
 * @param {Array<{name: string, emoji: string}>} playerInfos — 2 to 4 players
 * @returns {object} GameState
 */
export function createGame(playerInfos) {
  const n = playerInfos.length;
  if (n < 2 || n > 4) {
    throw new Error(`Invalid player count: ${n}. Must be 2-4 players.`);
  }

  const deck = createDeck();
  shuffle(deck);

  const board = deck.map((card) => ({
    card,
    state: 'down', // 'down' | 'up' | 'collected'
  }));

  const players = playerInfos.map((info) => ({
    name: info.name,
    emoji: info.emoji,
    collected: [],
    connected: true,
  }));

  return {
    board,
    players,
    currentPlayerIndex: 0,
    status: 'playing',
    winnerIndex: null,
    isTie: false,
    tiedIndices: null,
  };
}

/* ======= CARD FLIP ======= */

/**
 * Flips a face-down card on the board. If the revealed card's rank
 * matches an existing face-up card, both are collected by the current player.
 * Advances the turn to the next player.
 *
 * @param {object} state — current GameState
 * @param {number} cardIndex — board position to flip (0–51)
 * @param {number} playerIndex — the player attempting the flip
 * @returns {{ newState: object, matched: boolean, matchedIndex: number|null }}
 */
export function flipCard(state, cardIndex, playerIndex) {
  if (state.status !== 'playing') {
    throw new Error('Game is not active');
  }

  if (playerIndex !== state.currentPlayerIndex) {
    throw new Error('Not your turn');
  }

  if (cardIndex < 0 || cardIndex >= state.board.length) {
    throw new Error(`Card index ${cardIndex} out of range`);
  }

  const slot = state.board[cardIndex];

  if (slot.state === 'up') {
    throw new Error('Card is already face-up');
  }

  if (slot.state === 'collected') {
    throw new Error('Card has been collected');
  }

  const flippedCard = slot.card;
  const flippedRank = flippedCard.rank;

  // Find existing face-up card with matching rank
  let matchedIndex = null;
  for (let i = 0; i < state.board.length; i++) {
    if (i === cardIndex) continue;
    if (state.board[i].state === 'up' && state.board[i].card.rank === flippedRank) {
      matchedIndex = i;
      break;
    }
  }

  // Build new board
  const newBoard = state.board.map((s, i) => {
    if (i === cardIndex) {
      if (matchedIndex != null) {
        return { ...s, state: 'collected' };
      }
      return { ...s, state: 'up' };
    }
    if (i === matchedIndex) {
      return { ...s, state: 'collected' };
    }
    return { ...s };
  });

  // Build new players
  const newPlayers = state.players.map((p, i) => {
    if (i === playerIndex && matchedIndex != null) {
      return {
        ...p,
        collected: [...p.collected, flippedCard, state.board[matchedIndex].card],
      };
    }
    return { ...p };
  });

  // Advance turn only if no match was made — matcher keeps their turn
  const nextPlayer = matchedIndex != null
    ? state.currentPlayerIndex
    : (state.currentPlayerIndex + 1) % state.players.length;

  return {
    newState: {
      ...state,
      board: newBoard,
      players: newPlayers,
      currentPlayerIndex: nextPlayer,
    },
    matched: matchedIndex != null,
    matchedIndex,
  };
}

/* ======= GAME END DETECTION ======= */

/**
 * Checks if the game has ended (no face-down cards remain).
 * Determines winner by highest collected count.
 * @param {object} state
 * @returns {{ finished: boolean, winnerIndex: number|null, isTie: boolean, tiedIndices: number[]|null }}
 */
export function checkGameEnd(state) {
  const hasFaceDown = state.board.some((s) => s.state === 'down');

  if (hasFaceDown) {
    return { finished: false, winnerIndex: null, isTie: false, tiedIndices: null };
  }

  // No face-down cards remain — game is over
  let maxCount = -1;
  let winners = [];

  state.players.forEach((p, i) => {
    const count = p.collected.length;
    if (count > maxCount) {
      maxCount = count;
      winners = [i];
    } else if (count === maxCount) {
      winners.push(i);
    }
  });

  if (winners.length > 1) {
    return { finished: true, winnerIndex: winners[0], isTie: true, tiedIndices: winners };
  }

  return { finished: true, winnerIndex: winners[0], isTie: false, tiedIndices: null };
}

/* ======= STATE VALIDATION ======= */

/**
 * Validates game state integrity:
 * 1. Total cards across board + collected = 52
 * 2. At most one face-up card per rank
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  // Count total cards
  let boardCount = 0;
  for (const slot of state.board) {
    if (slot.state === 'down' || slot.state === 'up') {
      boardCount++;
    }
  }

  let collectedCount = 0;
  for (const player of state.players) {
    collectedCount += player.collected.length;
  }

  const total = boardCount + collectedCount;
  if (total !== 52) {
    return { valid: false, error: `Card count mismatch: expected 52, found ${total}` };
  }

  // Check at most one face-up card per rank
  const faceUpRanks = {};
  for (const slot of state.board) {
    if (slot.state === 'up') {
      const rank = slot.card.rank;
      if (faceUpRanks[rank]) {
        return { valid: false, error: `Duplicate face-up rank: ${rank}` };
      }
      faceUpRanks[rank] = true;
    }
  }

  return { valid: true };
}

/* ======= SERIALIZATION ======= */

/**
 * Serializes game state for Firebase storage.
 * @param {object} state
 * @returns {object} Firebase-compatible plain object
 */
export function serializeState(state) {
  const board = state.board.map((slot) => ({
    card: serializeCard(slot.card),
    state: slot.state,
  }));

  const collected = {};
  const collectedCounts = {};

  state.players.forEach((p, i) => {
    const key = `player_${i}`;
    collected[key] = p.collected.map(serializeCard);
    collectedCounts[key] = p.collected.length;
  });

  return {
    board,
    currentPlayerIndex: state.currentPlayerIndex,
    status: state.status,
    winnerIndex: state.winnerIndex != null ? state.winnerIndex : null,
    isTie: state.isTie || false,
    tiedIndices: state.tiedIndices || null,
    collected,
    collectedCounts,
  };
}

/**
 * Deserializes game state from Firebase data.
 * @param {object} gameData — serialized game data from Firebase
 * @param {object} playersData — player info from Firebase
 * @returns {object} GameState
 */
export function deserializeState(gameData, playersData) {
  const playerKeys = Object.keys(playersData).sort();

  const rawBoard = gameData.board || [];
  const boardArr = Array.isArray(rawBoard) ? rawBoard : Object.values(rawBoard);

  const board = boardArr.map((slot) => ({
    card: deserializeCard(slot.card),
    state: slot.state,
  }));

  const players = playerKeys.map((key, i) => {
    const pData = playersData[key];
    const rawCollected = (gameData.collected && gameData.collected[key]) || [];
    const collectedArr = Array.isArray(rawCollected)
      ? rawCollected.map(deserializeCard)
      : Object.values(rawCollected).map(deserializeCard);

    return {
      name: pData.name || `Player ${i + 1}`,
      emoji: pData.emoji || '😀',
      collected: collectedArr,
      connected: pData.connected !== false,
    };
  });

  return {
    board,
    players,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    status: gameData.status || 'playing',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
    isTie: gameData.isTie || false,
    tiedIndices: gameData.tiedIndices || null,
  };
}
