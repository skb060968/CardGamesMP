import { createDeck } from '../../shared/deck.js';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const HAND_SIZE = 10;
const PRNG_ALGORITHM = 'xorshift32';
const UINT32_MAX = 0xffffffff;
const TARGET_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
const TARGET_RANK_SET = new Set(TARGET_RANKS);
const STATE_KEYS = new Set([
  'players', 'playerSlots', 'drawPile', 'discardPile', 'currentPlayerIndex',
  'turnPhase', 'status', 'winnerIndex', 'deckCount', 'deckSize', 'prng', 'revision',
]);
const PLAYER_KEYS = new Set(['name', 'emoji', 'hand', 'connected', 'slotId']);
const CARD_KEYS = new Set(['id', 'rank', 'suit', 'deckIndex']);
const PRNG_KEYS = new Set(['algorithm', 'seed', 'state', 'counter']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function cloneCard(card) {
  return { id: card.id, rank: card.rank, suit: card.suit, deckIndex: card.deckIndex };
}

function makeDeck(deckCount) {
  const template = createDeck();
  const cards = [];
  for (let deckIndex = 0; deckIndex < deckCount; deckIndex += 1) {
    template.forEach((card, cardIndex) => cards.push({
      id: `d${deckIndex}-c${cardIndex}`,
      rank: card.rank,
      suit: card.suit,
      deckIndex,
    }));
  }
  return cards;
}

function generatedSeed() {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) throw new Error('crypto.getRandomValues is unavailable');
  const words = new Uint32Array(1);
  cryptoObject.getRandomValues(words);
  return words[0] || 0x6d2b79f5;
}

function normalizedSeed(value) {
  const candidate = isRecord(value) ? value.seed : value;
  if (candidate == null) return generatedSeed();
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > UINT32_MAX) {
    throw new TypeError('seed must be an unsigned 32-bit integer');
  }
  return candidate || 0x6d2b79f5;
}

function nextRandom(prng) {
  let value = prng.state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value >>>= 0;
  return {
    value: value / 0x100000000,
    prng: { ...prng, state: value, counter: prng.counter + 1 },
  };
}

function shuffleWithState(cards, initialPrng) {
  const shuffled = cards.map(cloneCard);
  let prng = { ...initialPrng };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const step = nextRandom(prng);
    prng = step.prng;
    const swapIndex = Math.floor(step.value * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return { cards: shuffled, prng };
}

function invalid(error) {
  return { valid: false, error };
}

function assertValid(state) {
  const result = validateState(state);
  if (!result.valid) throw new Error(result.error);
}

function cardSignature(card) {
  return `${card.id}|${String(card.rank)}|${String(card.suit)}|${card.deckIndex}`;
}

export function getCollectedRanks(hand) {
  const collected = new Set();
  if (!Array.isArray(hand)) return collected;
  hand.forEach((card) => {
    if (isRecord(card) && TARGET_RANK_SET.has(String(card.rank))) collected.add(String(card.rank));
  });
  return collected;
}

export function checkWinCondition(hand) {
  return Array.isArray(hand) && hand.length === HAND_SIZE
    && getCollectedRanks(hand).size === TARGET_RANKS.length;
}
export function createGame(playerInfos, seedOrOptions) {
  if (!Array.isArray(playerInfos) || playerInfos.length < MIN_PLAYERS || playerInfos.length > MAX_PLAYERS) {
    throw new Error('Perfect Ten requires 2-4 players');
  }
  playerInfos.forEach((info, index) => {
    if (!isRecord(info) || typeof info.name !== 'string' || !info.name.trim()
      || typeof info.emoji !== 'string') {
      throw new TypeError(`Invalid player info at index ${index}`);
    }
  });
  const deckCount = playerInfos.length === 4 ? 2 : 1;
  const seed = normalizedSeed(seedOrOptions);
  const initialPrng = { algorithm: PRNG_ALGORITHM, seed, state: seed, counter: 0 };
  const shuffled = shuffleWithState(makeDeck(deckCount), initialPrng);
  const hands = playerInfos.map(() => []);
  let cursor = 0;
  for (let round = 0; round < HAND_SIZE; round += 1) {
    for (let playerIndex = 0; playerIndex < playerInfos.length; playerIndex += 1) {
      hands[playerIndex].push(shuffled.cards[cursor]);
      cursor += 1;
    }
  }
  const discardPile = [shuffled.cards[cursor]];
  cursor += 1;
  const state = {
    players: playerInfos.map((info, index) => ({
      name: info.name.trim(), emoji: info.emoji, hand: hands[index], connected: true,
    })),
    playerSlots: [],
    drawPile: shuffled.cards.slice(cursor),
    discardPile,
    currentPlayerIndex: 0,
    turnPhase: 'draw',
    status: 'playing',
    winnerIndex: null,
    deckCount,
    deckSize: 52 * deckCount,
    prng: shuffled.prng,
    revision: 0,
  };
  assertValid(state);
  return state;
}

export function drawCard(state, source) {
  assertValid(state);
  if (state.status !== 'playing') throw new Error('Game is not active');
  if (state.turnPhase !== 'draw') throw new Error('Cannot draw outside draw phase');
  if (source !== 'drawPile' && source !== 'discardPile') throw new RangeError('Invalid draw source');

  let drawPile = state.drawPile.map(cloneCard);
  let discardPile = state.discardPile.map(cloneCard);
  let prng = { ...state.prng };

  const reshuffleIfNeeded = () => {
    if (drawPile.length !== 0 || discardPile.length <= 1) return;
    const top = discardPile[discardPile.length - 1];
    const reshuffled = shuffleWithState(discardPile.slice(0, -1), prng);
    drawPile = reshuffled.cards;
    discardPile = [top];
    prng = reshuffled.prng;
  };

  reshuffleIfNeeded();
  if (source === 'drawPile' && drawPile.length === 0) {
    const finished = {
      ...state,
      status: 'finished',
      turnPhase: 'finished',
      winnerIndex: null,
    };
    assertValid(finished);
    return finished;
  }
  const pile = source === 'drawPile' ? drawPile : discardPile;
  if (pile.length === 0) throw new Error(`Cannot draw from empty ${source}`);
  const card = pile[pile.length - 1];
  if (source === 'drawPile') drawPile = pile.slice(0, -1);
  else discardPile = pile.slice(0, -1);
  reshuffleIfNeeded();

  const playerIndex = state.currentPlayerIndex;
  const nextState = {
    ...state,
    players: state.players.map((player, index) => index === playerIndex
      ? { ...player, hand: [...player.hand.map(cloneCard), cloneCard(card)] }
      : { ...player, hand: player.hand.map(cloneCard) }),
    drawPile,
    discardPile,
    prng,
    turnPhase: 'discard',
  };
  assertValid(nextState);
  return nextState;
}
export function discardCard(state, handIndex) {
  assertValid(state);
  if (state.status !== 'playing') throw new Error('Game is not active');
  if (state.turnPhase !== 'discard') throw new Error('Cannot discard outside discard phase');
  const playerIndex = state.currentPlayerIndex;
  const hand = state.players[playerIndex].hand;
  if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= hand.length) {
    throw new RangeError('Invalid hand index');
  }
  const card = hand[handIndex];
  const newHand = hand.filter((_, index) => index !== handIndex).map(cloneCard);
  const won = checkWinCondition(newHand);
  let nextDrawPile = state.drawPile.map(cloneCard);
  let nextDiscardPile = [...state.discardPile.map(cloneCard), cloneCard(card)];
  let nextPrng = { ...state.prng };
  if (!won && nextDrawPile.length === 0 && nextDiscardPile.length > 1) {
    const top = nextDiscardPile[nextDiscardPile.length - 1];
    const reshuffled = shuffleWithState(nextDiscardPile.slice(0, -1), nextPrng);
    nextDrawPile = reshuffled.cards;
    nextDiscardPile = [top];
    nextPrng = reshuffled.prng;
  }
  const newState = {
    ...state,
    players: state.players.map((player, index) => index === playerIndex
      ? { ...player, hand: newHand }
      : { ...player, hand: player.hand.map(cloneCard) }),
    drawPile: nextDrawPile,
    discardPile: nextDiscardPile,
    prng: nextPrng,
    currentPlayerIndex: won ? playerIndex : (playerIndex + 1) % state.players.length,
    turnPhase: won ? 'finished' : 'draw',
    status: won ? 'finished' : 'playing',
    winnerIndex: won ? playerIndex : null,
  };
  assertValid(newState);
  return { newState, won };
}

export function validateState(state) {
  if (!hasOnlyKeys(state, STATE_KEYS)) return invalid('Invalid state object or unexpected state key');
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    return invalid('players must contain 2-4 entries');
  }
  const expectedDeckCount = state.players.length === 4 ? 2 : 1;
  if (state.deckCount !== expectedDeckCount || state.deckSize !== expectedDeckCount * 52) {
    return invalid('Invalid deck metadata for player count');
  }
  if (state.status !== 'playing' && state.status !== 'finished') return invalid('Invalid status');
  if (state.turnPhase !== 'draw' && state.turnPhase !== 'discard' && state.turnPhase !== 'finished') {
    return invalid('Invalid turn phase');
  }
  if ((state.status === 'playing') !== (state.turnPhase !== 'finished')) return invalid('Status and phase mismatch');
  if (!Number.isInteger(state.currentPlayerIndex) || state.currentPlayerIndex < 0
    || state.currentPlayerIndex >= state.players.length) return invalid('Invalid current player index');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) return invalid('Invalid revision');
  if (!hasOnlyKeys(state.prng, PRNG_KEYS)
    || state.prng.algorithm !== PRNG_ALGORITHM
    || !Number.isSafeInteger(state.prng.seed) || state.prng.seed <= 0 || state.prng.seed > UINT32_MAX
    || !Number.isSafeInteger(state.prng.state) || state.prng.state <= 0 || state.prng.state > UINT32_MAX
    || !Number.isSafeInteger(state.prng.counter) || state.prng.counter < state.deckSize - 1) {
    return invalid('Invalid PRNG metadata');
  }
  if (!Array.isArray(state.playerSlots)) return invalid('playerSlots must be an array');
  if (state.playerSlots.length !== 0 && state.playerSlots.length !== state.players.length) {
    return invalid('playerSlots length mismatch');
  }
  if (state.playerSlots.some((slot) => typeof slot !== 'string' || !/^player_\d+$/.test(slot))
    || new Set(state.playerSlots).size !== state.playerSlots.length) return invalid('Invalid playerSlots');
  if (!Array.isArray(state.drawPile) || !Array.isArray(state.discardPile)) return invalid('Invalid piles');

  const inventory = new Map(makeDeck(state.deckCount).map((card) => [card.id, card]));
  const seen = new Set();
  const validateCard = (card) => {
    if (!hasOnlyKeys(card, CARD_KEYS) || typeof card.id !== 'string'
      || typeof card.rank !== 'string' || typeof card.suit !== 'string'
      || !Number.isInteger(card.deckIndex)) return 'Invalid card schema';
    const expected = inventory.get(card.id);
    if (!expected || cardSignature(expected) !== cardSignature(card)) return `Unknown or altered card: ${card.id}`;
    if (seen.has(card.id)) return `Duplicate physical card instance: ${card.id}`;
    seen.add(card.id);
    return null;
  };
  for (let index = 0; index < state.players.length; index += 1) {
    const player = state.players[index];
    if (!hasOnlyKeys(player, PLAYER_KEYS) || typeof player.name !== 'string' || !player.name.trim()
      || typeof player.emoji !== 'string' || typeof player.connected !== 'boolean'
      || !Array.isArray(player.hand)) return invalid(`Invalid player schema at index ${index}`);
    if (state.playerSlots.length === state.players.length) {
      if (typeof player.slotId !== 'string' || player.slotId !== state.playerSlots[index]) {
        return invalid(`Invalid slot ownership at player ${index}`);
      }
    } else if ('slotId' in player) {
      return invalid(`Unexpected slot ownership at player ${index}`);
    }
    const expectedHandSize = state.status === 'playing' && state.turnPhase === 'discard'
      && index === state.currentPlayerIndex ? HAND_SIZE + 1 : HAND_SIZE;
    if (player.hand.length !== expectedHandSize) return invalid(`Invalid hand size at player ${index}`);
    for (const card of player.hand) {
      const error = validateCard(card);
      if (error) return invalid(error);
    }
  }
  for (const card of [...state.drawPile, ...state.discardPile]) {
    const error = validateCard(card);
    if (error) return invalid(error);
  }
  if (seen.size !== state.deckSize || seen.size !== inventory.size) {
    return invalid(`Card conservation mismatch: expected ${state.deckSize}, found ${seen.size}`);
  }

  if (state.status === 'playing') {
    if (state.winnerIndex !== null) return invalid('Playing state cannot contain winner data');
  } else if (state.winnerIndex === null) {
    if (state.drawPile.length !== 0 || state.discardPile.length > 1) {
      return invalid('No-winner finish requires exhausted stock with no refill available');
    }
  } else {
    if (!Number.isInteger(state.winnerIndex) || state.winnerIndex < 0 || state.winnerIndex >= state.players.length) {
      return invalid('Invalid winner index');
    }
    if (state.currentPlayerIndex !== state.winnerIndex
      || !checkWinCondition(state.players[state.winnerIndex].hand)) {
      return invalid('Winner does not satisfy Perfect Ten');
    }
  }
  return { valid: true };
}

export function serializeState(state) {
  assertValid(state);
  return {
    ...state,
    players: state.players.map((player) => ({ ...player, hand: player.hand.map(cloneCard) })),
    playerSlots: [...state.playerSlots],
    drawPile: state.drawPile.map(cloneCard),
    discardPile: state.discardPile.map(cloneCard),
    prng: { ...state.prng },
  };
}
