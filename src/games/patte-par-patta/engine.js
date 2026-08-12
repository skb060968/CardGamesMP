/**
 * Patte Par Patta — Game Engine
 *
 * Extracted from the standalone Patte Par Patta project.
 * Pure game logic: create, throw, advance turn, win/draw check, validate.
 */

import { createDeck, shuffle, dealCards } from '../../shared/deck.js';

/**
 * Creates initial game state with shuffled and dealt cards.
 * @param {Array<{name: string, emoji: string}>} playerInfos
 * @param {number} deckCount - 1 or 2
 * @returns {object} GameState
 */
export function createGame(playerInfos, deckCount = 1) {
  if (playerInfos.length < 2 || playerInfos.length > 4) {
    throw new Error(`Invalid player count: ${playerInfos.length}. Must be 2-4 players.`);
  }

  let deck = createDeck();
  if (deckCount === 2) {
    deck = [...deck, ...createDeck()];
  }
  shuffle(deck);

  const numPlayers = playerInfos.length;
  const cardsPerPlayer = Math.floor(deck.length / numPlayers);
  const hands = dealCards(deck, numPlayers);

  // Remainder cards go to the pile
  const totalDealt = cardsPerPlayer * numPlayers;
  const pile = deck.slice(totalDealt);

  const players = playerInfos.map((info, i) => ({
    name: info.name,
    emoji: info.emoji,
    hand: hands[i],
    bounty: [],
    eliminated: false,
    connected: true,
  }));

  // deckSize = total cards actually in play (dealt + pile)
  const actualDeckSize = totalDealt + pile.length;

  return {
    players,
    pile,
    currentPlayerIndex: 0,
    deckSize: actualDeckSize,
    status: 'playing',
    winnerIndex: null,
  };
}

/**
 * Throws the card at handIndex from current player's hand onto pile.
 * Pure function — returns new state.
 * @param {object} state - GameState
 * @param {number} handIndex - index of card in current player's hand
 * @returns {{ newState: object, captured: boolean }}
 */
export function throwCard(state, handIndex) {
  const playerIdx = state.currentPlayerIndex;
  const player = state.players[playerIdx];
  const thrownCard = player.hand[handIndex];

  const newHand = [...player.hand.slice(0, handIndex), ...player.hand.slice(handIndex + 1)];

  const pileTop = state.pile.length > 0 ? state.pile[state.pile.length - 1] : null;
  const captured = pileTop !== null && thrownCard.rank === pileTop.rank;

  let newPile;
  let newHand2;
  let newBounty;

  if (captured) {
    newPile = [];
    // Captured cards go back into the player's hand (enlarged pool to play from)
    newHand2 = [...newHand, ...state.pile, thrownCard];
    newBounty = [...player.bounty];
  } else {
    newPile = [...state.pile, thrownCard];
    newHand2 = newHand;
    newBounty = [...player.bounty];
  }

  const eliminated = newHand2.length === 0;

  const newPlayers = state.players.map((p, i) => {
    if (i === playerIdx) {
      return {
        ...p,
        hand: newHand2,
        bounty: newBounty,
        eliminated,
      };
    }
    return { ...p };
  });

  const newState = {
    ...state,
    players: newPlayers,
    pile: newPile,
  };

  return { newState, captured };
}

/**
 * Returns the index of the next active (non-eliminated) player after currentPlayerIndex.
 * Wraps around. If only one active player, returns that player's index.
 * @param {object} state - GameState
 * @returns {number}
 */
export function getNextActivePlayer(state) {
  const n = state.players.length;
  let idx = (state.currentPlayerIndex + 1) % n;
  for (let i = 0; i < n; i++) {
    if (!state.players[idx].eliminated) {
      return idx;
    }
    idx = (idx + 1) % n;
  }
  // Fallback: return current (shouldn't happen if at least 1 active)
  return state.currentPlayerIndex;
}

/**
 * Advances turn to next active player. Returns new state.
 * @param {object} state - GameState
 * @returns {object} GameState
 */
export function advanceTurn(state) {
  return {
    ...state,
    currentPlayerIndex: getNextActivePlayer(state),
  };
}

/**
 * Checks if the game should end.
 *
 * Rules:
 * - If 0 active players remain → draw (all eliminated)
 * - If 1 active player remains:
 *   - If they were the current player (just threw) → they win if hand > 0, draw if hand ≤ 1
 *   - If they were NOT the current player → don't end yet, let them play their turn
 * - If 2+ active players remain → game continues
 *
 * @param {object} state - GameState (after a throw, before advanceTurn)
 * @returns {{ finished: boolean, winnerIndex: number|null, draw: boolean }}
 */
export function checkWinCondition(state) {
  const activePlayers = state.players
    .map((p, i) => ({ ...p, index: i }))
    .filter((p) => !p.eliminated);

  if (activePlayers.length === 0) {
    return { finished: true, winnerIndex: null, draw: true };
  }

  if (activePlayers.length === 1) {
    const lastPlayer = activePlayers[0];

    // The current player just threw. If THEY are the last one standing,
    // they win (they have cards from a capture) or it's a draw (≤1 card).
    if (lastPlayer.index === state.currentPlayerIndex) {
      if (lastPlayer.hand.length <= 1) {
        return { finished: true, winnerIndex: null, draw: true };
      }
      return { finished: true, winnerIndex: lastPlayer.index, draw: false };
    }

    // Someone else just got eliminated, but the last player hasn't played yet.
    // Don't end — let them take their turn first.
    return { finished: false, winnerIndex: null, draw: false };
  }

  return { finished: false, winnerIndex: null, draw: false };
}

/**
 * Validates state integrity: total cards across all hands + pile + all bounties === deckSize.
 * @param {object} state - GameState
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  let total = state.pile.length;
  for (const player of state.players) {
    total += player.hand.length + player.bounty.length;
  }
  if (total !== state.deckSize) {
    return {
      valid: false,
      error: `Card count mismatch: expected ${state.deckSize}, found ${total}`,
    };
  }
  return { valid: true };
}
