export const ACE_LOW_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
export const ACE_HIGH_RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);
export const STANDARD_SUITS = Object.freeze(['♠', '♥', '♦', '♣']);

function createIndex(values, label) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be an array of unique values`);
  }
  return new Map(values.map((value, index) => [value, index]));
}

function compareKnownValues(left, right, indexes) {
  const leftIndex = indexes.get(left);
  const rightIndex = indexes.get(right);
  if (leftIndex == null && rightIndex == null) return 0;
  if (leftIndex == null) return 1;
  if (rightIndex == null) return -1;
  return leftIndex - rightIndex;
}

export function createCardComparator({
  primary = 'rank',
  ranks = ACE_LOW_RANKS,
  suits = STANDARD_SUITS,
  rankDirection = 'asc',
  suitDirection = 'asc',
} = {}) {
  if (primary !== 'rank' && primary !== 'suit') throw new TypeError('primary must be rank or suit');
  const rankIndexes = createIndex(ranks, 'ranks');
  const suitIndexes = createIndex(suits, 'suits');
  const rankFactor = rankDirection === 'desc' ? -1 : 1;
  const suitFactor = suitDirection === 'desc' ? -1 : 1;
  const compareRank = (a, b) => compareKnownValues(a.rank, b.rank, rankIndexes) * rankFactor;
  const compareSuit = (a, b) => compareKnownValues(a.suit, b.suit, suitIndexes) * suitFactor;
  return primary === 'rank'
    ? (a, b) => compareRank(a, b) || compareSuit(a, b)
    : (a, b) => compareSuit(a, b) || compareRank(a, b);
}

export function sortCards(cards, options) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  const compare = createCardComparator(options);
  return cards.map((card, index) => ({ card, index }))
    .sort((a, b) => compare(a.card, b.card) || a.index - b.index)
    .map(({ card }) => card);
}

export const sortByRankThenSuit = (cards, options = {}) => sortCards(cards, { ...options, primary: 'rank' });
export const sortBySuitThenRank = (cards, options = {}) => sortCards(cards, { ...options, primary: 'suit' });