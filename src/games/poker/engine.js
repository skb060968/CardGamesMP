import { createDeck } from '../../shared/deck.js';

export const BET_AMOUNT = 10;
export const STARTING_CHIPS = 200;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const HAND_SIZE = 3;
const DECK_SIZE = 52;
const UINT32_MAX = 0xffffffff;
const PRNG_ALGORITHM = 'xorshift32';
const ACTIONS = new Set(['bet', 'call', 'raise', 'fold', 'show']);
const STATUSES = new Set(['betting', 'finished']);
const FINISH_REASONS = new Set([null, 'show', 'fold', 'insufficient-players']);
const STATE_KEYS = new Set([
  'players', 'playerSlots', 'deck', 'pot', 'currentPlayerIndex', 'status',
  'winnerIndex', 'showEligible', 'finishReason', 'deckSize', 'prng', 'revision',
]);
const PLAYER_KEYS = new Set([
  'name', 'emoji', 'hand', 'chips', 'currentBet', 'folded', 'hasActed',
  'broke', 'roundStartChips', 'connected', 'slotId',
]);
const CARD_KEYS = new Set(['id', 'rank', 'suit', 'deckIndex']);
const PRNG_KEYS = new Set(['algorithm', 'seed', 'state', 'counter']);
const RANK_VALUES = Object.freeze({
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14,
});
const CATEGORY_LABELS = Object.freeze({
  5: 'Trail', 4: 'Pure Sequence', 3: 'Sequence',
  2: 'Color', 1: 'Pair', 0: 'High Card',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function cloneCard(card) {
  return { id: card.id, rank: card.rank, suit: card.suit, deckIndex: card.deckIndex };
}

function clonePlayer(player) {
  return { ...player, hand: player.hand.map(cloneCard) };
}

function makeDeck() {
  return createDeck().map((card, cardIndex) => ({
    id: `d0-c${cardIndex}`,
    rank: card.rank,
    suit: card.suit,
    deckIndex: 0,
  }));
}

function generatedSeed() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('crypto.getRandomValues is unavailable');
  const words = new Uint32Array(1);
  globalThis.crypto.getRandomValues(words);
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
  let state = prng.state >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return {
    value: state / 0x100000000,
    prng: { ...prng, state, counter: prng.counter + 1 },
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
  const verdict = validateState(state);
  if (!verdict.valid) throw new Error(verdict.error);
}

function cardSignature(card) {
  return `${card.id}|${card.rank}|${card.suit}|${card.deckIndex}`;
}

function readCreateOptions(playerInfos, chipsOrOptions, seedOrOptions) {
  let chipsInput;
  let seedInput = seedOrOptions;
  if (Array.isArray(chipsOrOptions)) {
    chipsInput = chipsOrOptions;
  } else if (chipsOrOptions != null) {
    if (!isRecord(chipsOrOptions)) throw new TypeError('chip carry input must be an array or object');
    chipsInput = chipsOrOptions.existingChips ?? chipsOrOptions.chips ?? chipsOrOptions.chipsBySlot;
    if (seedOrOptions == null) seedInput = chipsOrOptions.seed;
  }
  const chips = playerInfos.map((info, index) => {
    let value;
    if (Array.isArray(chipsInput)) value = chipsInput[index];
    else if (isRecord(chipsInput)) value = chipsInput[info.slotId] ?? chipsInput[index];
    if (value == null) return STARTING_CHIPS;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Invalid chip balance at player ${index}`);
    }
    return value;
  });
  return { chips, seed: normalizedSeed(seedInput) };
}

function activeIndices(state) {
  return state.players.map((player, index) => ({ player, index }))
    .filter(({ player }) => !player.folded)
    .map(({ index }) => index);
}

function nextActivePlayer(state) {
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const index = (state.currentPlayerIndex + offset) % state.players.length;
    if (!state.players[index].folded) return index;
  }
  return state.currentPlayerIndex;
}

function allActivePlayersHaveActed(state) {
  return activeIndices(state).every((index) => state.players[index].hasActed);
}

function checkShowEligible(state) {
  const active = activeIndices(state);
  if (active.length < 2 || !active.every((index) => state.players[index].hasActed)) return false;
  const firstBet = state.players[active[0]].currentBet;
  return active.every((index) => state.players[index].currentBet === firstBet);
}

function rankValue(rank) {
  return RANK_VALUES[rank] || 0;
}

function checkSequence(values) {
  const [low, middle, high] = values;
  if (middle - low === 1 && high - middle === 1) return { isSequence: true, highValue: high };
  if (low === 2 && middle === 3 && high === 14) return { isSequence: true, highValue: 3 };
  return { isSequence: false, highValue: high };
}

export function evaluateHand(hand) {
  if (!Array.isArray(hand) || hand.length !== HAND_SIZE) {
    throw new Error(`Hand must have exactly 3 cards, got ${Array.isArray(hand) ? hand.length : 0}`);
  }
  const values = hand.map((card) => rankValue(card?.rank)).sort((left, right) => left - right);
  if (values.some((value) => value === 0)) throw new Error('Hand contains an invalid rank');
  const sameSuit = hand.every((card) => card?.suit === hand[0]?.suit);
  if (values[0] === values[2]) {
    return { category: 5, label: CATEGORY_LABELS[5], score: 5e6 + values[2] * 10000 + values[1] * 100 + values[0], sortedValues: values };
  }
  const sequence = checkSequence(values);
  if (sequence.isSequence && sameSuit) {
    return { category: 4, label: CATEGORY_LABELS[4], score: 4e6 + sequence.highValue * 10000, sortedValues: values };
  }
  if (sequence.isSequence) {
    return { category: 3, label: CATEGORY_LABELS[3], score: 3e6 + sequence.highValue * 10000, sortedValues: values };
  }
  if (sameSuit) {
    return { category: 2, label: CATEGORY_LABELS[2], score: 2e6 + values[2] * 10000 + values[1] * 100 + values[0], sortedValues: values };
  }
  if (values[0] === values[1] || values[1] === values[2]) {
    const pairRank = values[0] === values[1] ? values[0] : values[1];
    const kicker = values[0] === values[1] ? values[2] : values[0];
    return { category: 1, label: CATEGORY_LABELS[1], score: 1e6 + pairRank * 10000 + kicker * 100, sortedValues: values };
  }
  return { category: 0, label: CATEGORY_LABELS[0], score: values[2] * 10000 + values[1] * 100 + values[0], sortedValues: values };
}

export function handScore(hand) {
  return evaluateHand(hand).score;
}

export function getHandLabel(category) {
  return CATEGORY_LABELS[category] || 'Unknown';
}

export function createGame(playerInfos, chipsOrOptions, seedOrOptions) {
  if (!Array.isArray(playerInfos) || playerInfos.length < MIN_PLAYERS || playerInfos.length > MAX_PLAYERS) {
    throw new Error('Poker requires 2-4 players');
  }
  playerInfos.forEach((info, index) => {
    if (!isRecord(info) || typeof info.name !== 'string' || !info.name.trim()
      || typeof info.emoji !== 'string') throw new TypeError(`Invalid player info at index ${index}`);
  });
  const { chips, seed } = readCreateOptions(playerInfos, chipsOrOptions, seedOrOptions);
  const shuffled = shuffleWithState(makeDeck(), {
    algorithm: PRNG_ALGORITHM, seed, state: seed, counter: 0,
  });
  let cursor = 0;
  const players = playerInfos.map((info, index) => {
    const balance = chips[index];
    const broke = balance < BET_AMOUNT;
    const hand = broke ? [] : shuffled.cards.slice(cursor, cursor += HAND_SIZE).map(cloneCard);
    return {
      name: info.name.trim(), emoji: info.emoji, hand, chips: balance, currentBet: 0,
      folded: broke, hasActed: broke, broke, roundStartChips: balance, connected: true,
    };
  });
  const playable = players.map((player, index) => ({ player, index }))
    .filter(({ player }) => !player.broke).map(({ index }) => index);
  const state = {
    players,
    playerSlots: [],
    deck: shuffled.cards.slice(cursor).map(cloneCard),
    pot: 0,
    currentPlayerIndex: playable[0] ?? 0,
    status: playable.length >= 2 ? 'betting' : 'finished',
    winnerIndex: playable.length === 1 ? playable[0] : null,
    showEligible: false,
    finishReason: playable.length >= 2 ? null : 'insufficient-players',
    deckSize: DECK_SIZE,
    prng: shuffled.prng,
    revision: 0,
  };
  assertValid(state);
  return state;
}

export function resolveShow(state) {
  assertValid(state);
  const active = activeIndices(state);
  if (active.length < 2) throw new Error('Need at least 2 active players for show');
  let winnerIndex = active[0];
  let bestScore = handScore(state.players[winnerIndex].hand);
  for (const index of active.slice(1)) {
    const score = handScore(state.players[index].hand);
    if (score > bestScore || (score === bestScore && index < winnerIndex)) {
      winnerIndex = index;
      bestScore = score;
    }
  }
  const players = state.players.map(clonePlayer);
  players[winnerIndex].chips += state.pot;
  const result = {
    ...state, players, deck: state.deck.map(cloneCard), prng: { ...state.prng },
    pot: 0, status: 'finished', winnerIndex, showEligible: false, finishReason: 'show',
  };
  assertValid(result);
  return result;
}

export function performAction(state, playerIndex, action) {
  assertValid(state);
  if (state.status !== 'betting') throw new Error('Cannot perform action: game is not in betting phase');
  if (playerIndex !== state.currentPlayerIndex) throw new Error('Not this player’s turn');
  if (!isRecord(action) || !ACTIONS.has(action.type)) throw new Error(`Unknown action type: ${action?.type}`);
  const player = state.players[playerIndex];
  if (player.folded || player.broke) throw new Error('Folded or broke player cannot act');
  if (action.type === 'show') {
    if (!state.showEligible) throw new Error('Show is not available yet');
    return resolveShow(state);
  }

  const players = state.players.map(clonePlayer);
  const active = activeIndices(state);
  const maxBet = Math.max(...active.map((index) => state.players[index].currentBet));
  let pot = state.pot;
  if (action.type === 'bet') {
    if (maxBet > 0) throw new Error('Cannot bet — someone has already bet. Use call or raise instead.');
    if (player.chips < BET_AMOUNT) throw new Error('Insufficient chips for bet');
    players[playerIndex].chips -= BET_AMOUNT;
    players[playerIndex].currentBet += BET_AMOUNT;
    players[playerIndex].hasActed = true;
    pot += BET_AMOUNT;
  } else if (action.type === 'call') {
    const cost = maxBet - player.currentBet;
    if (cost <= 0) throw new Error('Nothing to call — bets are already equal');
    if (player.chips < cost) throw new Error('Insufficient chips for call');
    players[playerIndex].chips -= cost;
    players[playerIndex].currentBet += cost;
    players[playerIndex].hasActed = true;
    pot += cost;
  } else if (action.type === 'raise') {
    const cost = maxBet - player.currentBet + BET_AMOUNT;
    if (player.chips < cost) throw new Error('Insufficient chips for raise');
    players[playerIndex].chips -= cost;
    players[playerIndex].currentBet += cost;
    players[playerIndex].hasActed = true;
    pot += cost;
  } else {
    const needToCall = maxBet - player.currentBet;
    if (!allActivePlayersHaveActed(state) && player.chips >= needToCall) {
      throw new Error('Cannot fold in the first round if you have chips to call');
    }
    players[playerIndex].folded = true;
    players[playerIndex].hasActed = true;
    const remaining = players.map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.folded).map(({ index }) => index);
    if (remaining.length === 1) {
      const winnerIndex = remaining[0];
      players[winnerIndex].chips += pot;
      const result = {
        ...state, players, deck: state.deck.map(cloneCard), prng: { ...state.prng },
        pot: 0, status: 'finished', winnerIndex, showEligible: false, finishReason: 'fold',
      };
      assertValid(result);
      return result;
    }
  }

  const temporary = {
    ...state, players, deck: state.deck.map(cloneCard), prng: { ...state.prng }, pot,
  };
  const currentPlayerIndex = nextActivePlayer(temporary);
  const result = {
    ...temporary,
    currentPlayerIndex,
    showEligible: checkShowEligible({ ...temporary, currentPlayerIndex }),
  };
  assertValid(result);
  return result;
}

export function validateState(state) {
  if (!hasOnlyKeys(state, STATE_KEYS)) return invalid('Invalid state object or unexpected state key');
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    return invalid('players must contain 2-4 entries');
  }
  if (!Array.isArray(state.playerSlots)
    || (state.playerSlots.length !== 0 && state.playerSlots.length !== state.players.length)) {
    return invalid('Invalid playerSlots');
  }
  if (state.playerSlots.some((slot) => typeof slot !== 'string' || !/^player_[0-5]$/.test(slot))
    || new Set(state.playerSlots).size !== state.playerSlots.length) return invalid('Invalid playerSlots');
  if (!STATUSES.has(state.status) || !FINISH_REASONS.has(state.finishReason)) return invalid('Invalid status metadata');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) return invalid('Invalid revision');
  if (state.deckSize !== DECK_SIZE || !Array.isArray(state.deck)) return invalid('Invalid deck metadata');
  if (!Number.isSafeInteger(state.pot) || state.pot < 0) return invalid('Invalid pot');
  if (!Number.isInteger(state.currentPlayerIndex) || state.currentPlayerIndex < 0
    || state.currentPlayerIndex >= state.players.length) return invalid('Invalid current player index');
  if (typeof state.showEligible !== 'boolean') return invalid('Invalid showEligible');
  if (!hasOnlyKeys(state.prng, PRNG_KEYS) || state.prng.algorithm !== PRNG_ALGORITHM
    || !Number.isSafeInteger(state.prng.seed) || state.prng.seed <= 0 || state.prng.seed > UINT32_MAX
    || !Number.isSafeInteger(state.prng.state) || state.prng.state <= 0 || state.prng.state > UINT32_MAX
    || !Number.isSafeInteger(state.prng.counter) || state.prng.counter !== DECK_SIZE - 1) {
    return invalid('Invalid PRNG metadata');
  }

  const inventory = new Map(makeDeck().map((card) => [card.id, card]));
  const seen = new Set();
  const validateCard = (card) => {
    if (!hasOnlyKeys(card, CARD_KEYS) || typeof card.id !== 'string'
      || typeof card.rank !== 'string' || typeof card.suit !== 'string'
      || card.deckIndex !== 0) return 'Invalid card schema';
    const expected = inventory.get(card.id);
    if (!expected || cardSignature(expected) !== cardSignature(card)) return `Unknown or altered card: ${card.id}`;
    if (seen.has(card.id)) return `Duplicate physical card instance: ${card.id}`;
    seen.add(card.id);
    return null;
  };

  let expectedChips = 0;
  let actualChips = state.pot;
  let currentBetTotal = 0;
  for (let index = 0; index < state.players.length; index += 1) {
    const player = state.players[index];
    if (!hasOnlyKeys(player, PLAYER_KEYS) || typeof player.name !== 'string' || !player.name.trim()
      || typeof player.emoji !== 'string' || typeof player.connected !== 'boolean'
      || !Array.isArray(player.hand) || typeof player.folded !== 'boolean'
      || typeof player.hasActed !== 'boolean' || typeof player.broke !== 'boolean') {
      return invalid(`Invalid player schema at index ${index}`);
    }
    for (const field of ['chips', 'currentBet', 'roundStartChips']) {
      if (!Number.isSafeInteger(player[field]) || player[field] < 0) return invalid(`Invalid ${field} at player ${index}`);
    }
    if (player.currentBet % BET_AMOUNT !== 0 || player.currentBet > player.roundStartChips) {
      return invalid(`Invalid bet commitment at player ${index}`);
    }
    if (player.folded && !player.hasActed) return invalid(`Folded player ${index} must have acted`);
    if (player.broke !== (player.roundStartChips < BET_AMOUNT)) return invalid(`Invalid broke status at player ${index}`);
    if (player.broke && (!player.folded || !player.hasActed || player.currentBet !== 0)) {
      return invalid(`Broke player ${index} must sit out`);
    }
    if (player.hand.length !== (player.broke ? 0 : HAND_SIZE)) return invalid(`Invalid hand size at player ${index}`);
    if (state.playerSlots.length) {
      if (player.slotId !== state.playerSlots[index]) return invalid(`Invalid slot ownership at player ${index}`);
    } else if ('slotId' in player) return invalid(`Unexpected slot ownership at player ${index}`);
    expectedChips += player.roundStartChips;
    actualChips += player.chips;
    currentBetTotal += player.currentBet;
    if (!Number.isSafeInteger(expectedChips) || !Number.isSafeInteger(actualChips)) return invalid('Chip total exceeds safe range');
    for (const card of player.hand) {
      const error = validateCard(card);
      if (error) return invalid(error);
    }
  }
  for (const card of state.deck) {
    const error = validateCard(card);
    if (error) return invalid(error);
  }
  if (seen.size !== DECK_SIZE) return invalid(`Card conservation mismatch: expected ${DECK_SIZE}, found ${seen.size}`);
  const expectedShuffle = shuffleWithState(makeDeck(), {
    algorithm: PRNG_ALGORITHM,
    seed: state.prng.seed,
    state: state.prng.seed,
    counter: 0,
  });
  if (expectedShuffle.prng.state !== state.prng.state
    || expectedShuffle.prng.counter !== state.prng.counter) return invalid('PRNG replay mismatch');
  let dealCursor = 0;
  for (let index = 0; index < state.players.length; index += 1) {
    const expectedHand = state.players[index].broke
      ? [] : expectedShuffle.cards.slice(dealCursor, dealCursor += HAND_SIZE);
    if (state.players[index].hand.length !== expectedHand.length
      || state.players[index].hand.some((card, cardIndex) => (
        cardSignature(card) !== cardSignature(expectedHand[cardIndex])
      ))) return invalid(`Dealt card order mismatch at player ${index}`);
  }
  const expectedDeck = expectedShuffle.cards.slice(dealCursor);
  if (state.deck.length !== expectedDeck.length
    || state.deck.some((card, index) => cardSignature(card) !== cardSignature(expectedDeck[index]))) {
    return invalid('Undealt deck order mismatch');
  }
  if (actualChips !== expectedChips) return invalid(`Chip conservation mismatch: expected ${expectedChips}, found ${actualChips}`);
  if (state.status === 'betting' && state.pot !== currentBetTotal) return invalid('Pot and committed bets mismatch');
  for (let index = 0; index < state.players.length; index += 1) {
    const player = state.players[index];
    const award = state.status === 'finished' && index === state.winnerIndex ? currentBetTotal : 0;
    const expectedBalance = player.roundStartChips - player.currentBet + award;
    if (player.chips !== expectedBalance) return invalid(`Invalid chip distribution at player ${index}`);
  }

  const active = activeIndices(state);
  if (state.status === 'betting') {
    if (state.finishReason !== null || state.winnerIndex !== null || active.length < 2) return invalid('Invalid betting outcome metadata');
    if (state.players[state.currentPlayerIndex].folded) return invalid('Current player is folded');
    if (state.showEligible !== checkShowEligible(state)) return invalid('Incorrect show eligibility');
  } else {
    if (state.showEligible || state.pot !== 0 || state.finishReason === null) return invalid('Invalid finished state');
    if (state.winnerIndex !== null
      && (!Number.isInteger(state.winnerIndex) || state.winnerIndex < 0 || state.winnerIndex >= state.players.length)) {
      return invalid('Invalid winner index');
    }
    if (state.finishReason === 'insufficient-players') {
      const playable = state.players.map((player, index) => ({ player, index }))
        .filter(({ player }) => !player.broke).map(({ index }) => index);
      const expectedWinner = playable.length === 1 ? playable[0] : null;
      if (playable.length > 1 || state.winnerIndex !== expectedWinner) return invalid('Invalid insufficient-player result');
    } else if (state.finishReason === 'fold') {
      if (active.length !== 1 || state.winnerIndex !== active[0]) return invalid('Invalid fold winner');
    } else if (state.finishReason === 'show') {
      if (active.length < 2 || state.winnerIndex == null) return invalid('Invalid show result');
      let expectedWinner = active[0];
      let score = handScore(state.players[expectedWinner].hand);
      for (const index of active.slice(1)) {
        const candidate = handScore(state.players[index].hand);
        if (candidate > score || (candidate === score && index < expectedWinner)) {
          expectedWinner = index;
          score = candidate;
        }
      }
      if (state.winnerIndex !== expectedWinner) return invalid('Incorrect show winner');
    }
  }
  return { valid: true };
}

export function serializeState(state) {
  assertValid(state);
  const result = {
    ...state,
    players: state.players.map(clonePlayer),
    playerSlots: [...state.playerSlots],
    deck: state.deck.map(cloneCard),
    prng: { ...state.prng },
  };
  const json = JSON.stringify(result);
  if (json === undefined) throw new TypeError('State is not Firebase-safe');
  const parsed = JSON.parse(json);
  if (JSON.stringify(parsed) !== json) throw new TypeError('State is not canonically serializable');
  return parsed;
}
