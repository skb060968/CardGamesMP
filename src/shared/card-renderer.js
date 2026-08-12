/**
 * Card Renderer for Card Games Platform
 *
 * Creates card face, card back, and mini card indicator DOM elements.
 * Card faces use CSS classes defined in style.css with Unicode suit symbols.
 */

const RED_SUITS = new Set(['♥', '♦']);

/**
 * Creates a card face DOM element with rank and colored suit symbol.
 * Layout: rank top-left, large suit centered, rank bottom-right (rotated 180°).
 *
 * @param {{ rank: string, suit: string }} card
 * @returns {HTMLElement}
 */
export function renderCardFace(card) {
  const { rank, suit } = card;
  const colorClass = RED_SUITS.has(suit) ? 'red' : 'black';

  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.setAttribute('data-rank', rank);
  cardEl.setAttribute('data-suit', suit);

  const face = document.createElement('div');
  face.className = `card-face ${colorClass}`;

  const rankTop = document.createElement('span');
  rankTop.className = 'rank-top';
  rankTop.textContent = rank;

  const suitCenter = document.createElement('span');
  suitCenter.className = 'suit-center';
  suitCenter.textContent = suit;

  const rankBottom = document.createElement('span');
  rankBottom.className = 'rank-bottom';
  rankBottom.textContent = rank;

  face.appendChild(rankTop);
  face.appendChild(suitCenter);
  face.appendChild(rankBottom);
  cardEl.appendChild(face);

  return cardEl;
}

/**
 * Creates a card back DOM element.
 * Uses /images/card-back.png with CSS gradient fallback (defined in style.css).
 *
 * @returns {HTMLElement}
 */
export function renderCardBack() {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';

  const back = document.createElement('div');
  back.className = 'card-back';

  cardEl.appendChild(back);
  return cardEl;
}

/**
 * Creates a mini card indicator showing card count for opponents.
 *
 * @param {number} count - Number of cards
 * @returns {HTMLElement}
 */
export function renderCardMini(count) {
  const el = document.createElement('span');
  el.className = 'card-mini';
  el.textContent = `🃏 ${count}`;
  return el;
}
