const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

/**
 * Creates a standard 52-card deck.
 * @returns {Array<{rank: string, suit: string}>}
 */
export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Shuffles array in-place using Fisher-Yates algorithm.
 * @param {Array} cards
 * @returns {Array} same array, shuffled
 */
export function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/**
 * Deals cards equally to N players, discards remainder.
 * @param {Array} deck
 * @param {number} numPlayers
 * @returns {Array<Array>} array of N hands
 */
export function dealCards(deck, numPlayers) {
  const cardsPerPlayer = Math.floor(deck.length / numPlayers);
  const hands = [];
  for (let i = 0; i < numPlayers; i++) {
    hands.push(deck.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer));
  }
  return hands;
}

/**
 * Serializes a card to "rank+suit" string, e.g. "A♠", "10♥"
 * @param {{rank: string, suit: string}} card
 * @returns {string}
 */
export function serializeCard(card) {
  return card.rank + card.suit;
}

/**
 * Deserializes a "rank+suit" string back to a Card object.
 * Handles "10" rank (2 chars).
 * @param {string} str
 * @returns {{rank: string, suit: string}}
 */
export function deserializeCard(str) {
  const suit = str.slice(-1);
  const rank = str.slice(0, -1);
  return { rank, suit };
}
