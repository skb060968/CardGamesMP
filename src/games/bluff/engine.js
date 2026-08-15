import { createDeck } from '../../shared/deck.js';

// Bluff intentionally uses the platform's full shared-state model. Card faces are
// hidden by UI convention only; this module does not claim server-enforced secrecy.

export const BLUFF_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const MAX_PLACEMENT_CARDS = 4;
export const DECK_SIZE = 52;
export const PRNG_ALGORITHM = 'xorshift32';

const UINT32_MAX = 0xffffffff;
const STATE_KEYS = new Set([
  'players', 'playerSlots', 'centerPile', 'currentPlayerIndex', 'phase',
  'lastPlacement', 'status', 'winnerIndex', 'deckSize', 'currentRank',
  'roundStartPlayer', 'playersActedThisRound', 'prng', 'revision',
]);
const PLAYER_KEYS = new Set(['name', 'emoji', 'hand', 'connected']);
const SLOTTED_PLAYER_KEYS = new Set([...PLAYER_KEYS, 'slotId']);
const CARD_KEYS = new Set(['id', 'rank', 'suit', 'deckIndex']);
const PRNG_KEYS = new Set(['algorithm', 'seed', 'state', 'counter']);
const PLACEMENT_KEYS = new Set([
  'playerIndex', 'actualCards', 'declaredRank', 'count', 'placerEmpty',
  'placementMoveId', 'placementRevision',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function invalid(error) { return { valid: false, error }; }
function cloneCard(card) {
  return { id: card.id, rank: card.rank, suit: card.suit, deckIndex: card.deckIndex };
}
function clonePlayer(player) { return { ...player, hand: player.hand.map(cloneCard) }; }
function clonePlacement(placement) {
  return placement ? { ...placement, actualCards: placement.actualCards.map(cloneCard) } : null;
}
function cardSignature(card) { return `${card.id}|${card.rank}|${card.suit}|${card.deckIndex}`; }
function sameCards(left, right) {
  return left.length === right.length
    && left.every((card, index) => cardSignature(card) === cardSignature(right[index]));
}

function makeDeck() {
  return createDeck().map((card, index) => ({
    id: `d0-c${index}`, rank: card.rank, suit: card.suit, deckIndex: 0,
  }));
}

function generatedSeed() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('crypto.getRandomValues is unavailable');
  const words = new Uint32Array(1);
  globalThis.crypto.getRandomValues(words);
  return words[0] || 0x6d2b79f5;
}

function normalizeSeed(value) {
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

function cloneState(state) {
  return {
    ...state,
    players: state.players.map(clonePlayer),
    playerSlots: [...state.playerSlots],
    centerPile: state.centerPile.map(cloneCard),
    lastPlacement: clonePlacement(state.lastPlacement),
    playersActedThisRound: [...state.playersActedThisRound],
    prng: { ...state.prng },
  };
}

function assertValid(state) {
  const verdict = validateState(state);
  if (!verdict.valid) throw new Error(verdict.error);
}

function assertPlayerIndex(state, playerIndex, label = 'playerIndex') {
  if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= state.players.length) {
    throw new RangeError(`Invalid ${label}: ${playerIndex}`);
  }
}

function assertActiveTurn(state, playerIndex) {
  assertValid(state);
  if (state.status !== 'playing' || state.phase !== 'placing') throw new Error('Game is not in placing phase');
  assertPlayerIndex(state, playerIndex);
  if (state.currentPlayerIndex !== playerIndex) throw new Error('Not this player’s turn');
}

function nextPlayer(state, playerIndex) { return (playerIndex + 1) % state.players.length; }
function placementIdFor(state, playerIndex) {
  return `bluff-placement-r${state.revision + 1}-p${playerIndex}`;
}
function requirePlacementPin(state, moveId, revision) {
  const placement = state.lastPlacement;
  if (!placement) throw new Error('No placement to resolve');
  if (typeof moveId !== 'string' || !moveId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid placement pin');
  if (placement.placementMoveId !== moveId || placement.placementRevision !== revision) {
    throw new Error('Stale placement reference');
  }
  return placement;
}

function finishProvisionalWinner(state) {
  const placement = state.lastPlacement;
  if (!placement?.placerEmpty) return null;
  const result = {
    ...cloneState(state),
    phase: 'finished',
    status: 'finished',
    winnerIndex: placement.playerIndex,
    lastPlacement: null,
    currentRank: null,
    roundStartPlayer: state.currentPlayerIndex,
    playersActedThisRound: [],
    revision: state.revision + 1,
  };
  assertValid(result);
  return result;
}

export function createGame(playerInfos, seedOrOptions) {
  if (!Array.isArray(playerInfos) || playerInfos.length < MIN_PLAYERS || playerInfos.length > MAX_PLAYERS) {
    throw new Error('Bluff requires 2-4 players');
  }
  playerInfos.forEach((info, index) => {
    if (!isRecord(info) || typeof info.name !== 'string' || !info.name.trim()
      || typeof info.emoji !== 'string') throw new TypeError(`Invalid player info at index ${index}`);
    if ('slotId' in info && (typeof info.slotId !== 'string' || !/^player_[0-5]$/.test(info.slotId))) {
      throw new TypeError(`Invalid slotId at player ${index}`);
    }
  });
  const suppliedSlots = playerInfos.map((info) => info.slotId).filter((slot) => slot !== undefined);
  if (suppliedSlots.length !== 0 && suppliedSlots.length !== playerInfos.length) {
    throw new TypeError('Either every player or no player must provide slotId');
  }
  if (new Set(suppliedSlots).size !== suppliedSlots.length) throw new TypeError('Duplicate slotId');

  const seed = normalizeSeed(seedOrOptions);
  const shuffled = shuffleWithState(makeDeck(), {
    algorithm: PRNG_ALGORITHM, seed, state: seed, counter: 0,
  });
  const cardsPerPlayer = Math.floor(DECK_SIZE / playerInfos.length);
  const players = playerInfos.map((info, index) => ({
    name: info.name.trim(),
    emoji: info.emoji,
    hand: shuffled.cards.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer).map(cloneCard),
    connected: true,
    ...(suppliedSlots.length ? { slotId: info.slotId } : {}),
  }));
  const state = {
    players,
    playerSlots: suppliedSlots.length ? [...suppliedSlots] : [],
    centerPile: shuffled.cards.slice(cardsPerPlayer * players.length).map(cloneCard),
    currentPlayerIndex: 0,
    phase: 'placing',
    lastPlacement: null,
    status: 'playing',
    winnerIndex: null,
    deckSize: DECK_SIZE,
    currentRank: null,
    roundStartPlayer: 0,
    playersActedThisRound: [],
    prng: shuffled.prng,
    revision: 0,
  };
  assertValid(state);
  return state;
}

export function placeCards(state, playerIndex, cardIds, declaredRank) {
  assertActiveTurn(state, playerIndex);
  if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > MAX_PLACEMENT_CARDS
    || cardIds.some((id) => typeof id !== 'string' || !id)
    || new Set(cardIds).size !== cardIds.length) throw new Error('cardIds must contain 1-4 unique card IDs');
  if (!BLUFF_RANKS.includes(declaredRank)) throw new Error(`Invalid declared rank: ${declaredRank}`);
  const accepted = finishProvisionalWinner(state);
  if (accepted) return accepted;
  if (state.currentRank !== null && declaredRank !== state.currentRank) {
    throw new Error(`Must declare ${state.currentRank} this round`);
  }
  const player = state.players[playerIndex];
  const handById = new Map(player.hand.map((card) => [card.id, card]));
  const actualCards = cardIds.map((cardId) => {
    const card = handById.get(cardId);
    if (!card) throw new Error(`Card is not in player hand: ${cardId}`);
    return cloneCard(card);
  });
  const selected = new Set(cardIds);
  const placementRevision = state.revision + 1;
  const requestedMoveId = arguments[4];
  const placementMoveId = requestedMoveId == null
    ? placementIdFor(state, playerIndex)
    : requestedMoveId;
  if (typeof placementMoveId !== 'string' || !placementMoveId.trim()) {
    throw new TypeError('placementMoveId must be a non-empty string');
  }
  const next = nextPlayer(state, playerIndex);
  const currentRank = state.currentRank ?? declaredRank;
  const acted = state.playersActedThisRound.includes(playerIndex)
    ? [...state.playersActedThisRound]
    : [...state.playersActedThisRound, playerIndex];
  const result = {
    ...cloneState(state),
    players: state.players.map((item, index) => index === playerIndex
      ? { ...item, hand: item.hand.filter((card) => !selected.has(card.id)).map(cloneCard) }
      : clonePlayer(item)),
    centerPile: [...state.centerPile.map(cloneCard), ...actualCards.map(cloneCard)],
    currentPlayerIndex: next,
    lastPlacement: {
      playerIndex,
      actualCards: actualCards.map(cloneCard),
      declaredRank: currentRank,
      count: actualCards.length,
      placerEmpty: player.hand.length === actualCards.length,
      placementMoveId,
      placementRevision,
    },
    currentRank,
    roundStartPlayer: state.currentRank === null ? playerIndex : state.roundStartPlayer,
    playersActedThisRound: acted,
    revision: placementRevision,
  };
  assertValid(result);
  return result;
}

export function passCard(state, playerIndex) {
  assertActiveTurn(state, playerIndex);
  const accepted = finishProvisionalWinner(state);
  if (accepted) return accepted;
  if (state.currentRank === null) throw new Error('Cannot pass before the round rank is set');
  const next = nextPlayer(state, playerIndex);
  const resetRound = playerIndex === state.roundStartPlayer;
  const result = {
    ...cloneState(state),
    currentPlayerIndex: next,
    lastPlacement: null,
    currentRank: resetRound ? null : state.currentRank,
    roundStartPlayer: resetRound ? next : state.roundStartPlayer,
    playersActedThisRound: resetRound ? [] : [...state.playersActedThisRound],
    revision: state.revision + 1,
  };
  assertValid(result);
  return result;
}

export function acceptPlacement(state, playerIndex, placementMoveId, placementRevision) {
  assertActiveTurn(state, playerIndex);
  const placement = requirePlacementPin(state, placementMoveId, placementRevision);
  if (placement.playerIndex === playerIndex) throw new Error('Placer cannot accept their own placement');
  const winner = finishProvisionalWinner(state);
  if (winner) return winner;
  const result = {
    ...cloneState(state),
    lastPlacement: null,
    revision: state.revision + 1,
  };
  assertValid(result);
  return result;
}

export function deriveChallengeOutcome(state, challengerIndex) {
  assertValid(state);
  assertPlayerIndex(state, challengerIndex, 'challengerIndex');
  const placement = state.lastPlacement;
  if (!placement) throw new Error('No placement to challenge');
  if (placement.playerIndex === challengerIndex) throw new Error('Cannot challenge your own placement');
  const bluffCaught = placement.actualCards.some((card) => card.rank !== placement.declaredRank);
  const loserIndex = bluffCaught ? placement.playerIndex : challengerIndex;
  const nextPlayerIndex = bluffCaught
    ? challengerIndex
    : nextPlayer(state, placement.playerIndex);
  return {
    bluffCaught,
    loserIndex,
    nextPlayerIndex,
    winnerIndex: !bluffCaught && placement.placerEmpty ? placement.playerIndex : null,
    revealedCards: placement.actualCards.map(cloneCard),
    declaredRank: placement.declaredRank,
  };
}

export function resolveChallenge(
  state, challengerIndex, placementMoveId, placementRevision,
) {
  assertValid(state);
  if (state.status !== 'playing' || state.phase !== 'placing') throw new Error('Game is not in placing phase');
  assertPlayerIndex(state, challengerIndex, 'challengerIndex');
  const placement = requirePlacementPin(state, placementMoveId, placementRevision);
  if (placement.playerIndex === challengerIndex) throw new Error('Cannot challenge your own placement');
  const outcome = deriveChallengeOutcome(state, challengerIndex);
  const pile = state.centerPile.map(cloneCard);
  const players = state.players.map((player, index) => index === outcome.loserIndex
    ? { ...player, hand: [...player.hand.map(cloneCard), ...pile.map(cloneCard)] }
    : clonePlayer(player));
  const finished = outcome.winnerIndex !== null;
  const result = {
    ...cloneState(state),
    players,
    centerPile: [],
    currentPlayerIndex: outcome.nextPlayerIndex,
    phase: finished ? 'finished' : 'placing',
    lastPlacement: null,
    status: finished ? 'finished' : 'playing',
    winnerIndex: outcome.winnerIndex,
    currentRank: null,
    roundStartPlayer: outcome.nextPlayerIndex,
    playersActedThisRound: [],
    revision: state.revision + 1,
  };
  assertValid(result);
  return result;
}

export function validateState(state) {
  if (!hasExactKeys(state, STATE_KEYS)) return invalid('Invalid state schema');
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    return invalid('players must contain 2-4 entries');
  }
  if (!Array.isArray(state.playerSlots)
    || (state.playerSlots.length !== 0 && state.playerSlots.length !== state.players.length)
    || state.playerSlots.some((slot) => typeof slot !== 'string' || !/^player_[0-5]$/.test(slot))
    || new Set(state.playerSlots).size !== state.playerSlots.length) return invalid('Invalid playerSlots');
  if (state.deckSize !== DECK_SIZE || !Array.isArray(state.centerPile)) return invalid('Invalid deck metadata');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) return invalid('Invalid revision');
  if (!Number.isInteger(state.currentPlayerIndex) || state.currentPlayerIndex < 0
    || state.currentPlayerIndex >= state.players.length) return invalid('Invalid current player index');
  if (!Number.isInteger(state.roundStartPlayer) || state.roundStartPlayer < 0
    || state.roundStartPlayer >= state.players.length) return invalid('Invalid round starter');
  if (state.phase !== (state.status === 'finished' ? 'finished' : 'placing')
    || (state.status !== 'playing' && state.status !== 'finished')) return invalid('Invalid phase or status');
  if (state.currentRank !== null && !BLUFF_RANKS.includes(state.currentRank)) return invalid('Invalid currentRank');
  if (!Array.isArray(state.playersActedThisRound)
    || state.playersActedThisRound.some((index) => !Number.isInteger(index) || index < 0 || index >= state.players.length)
    || new Set(state.playersActedThisRound).size !== state.playersActedThisRound.length) {
    return invalid('Invalid playersActedThisRound');
  }
  if (!hasExactKeys(state.prng, PRNG_KEYS) || state.prng.algorithm !== PRNG_ALGORITHM
    || !Number.isSafeInteger(state.prng.seed) || state.prng.seed <= 0 || state.prng.seed > UINT32_MAX
    || !Number.isSafeInteger(state.prng.state) || state.prng.state <= 0 || state.prng.state > UINT32_MAX
    || state.prng.counter !== DECK_SIZE - 1) return invalid('Invalid PRNG metadata');

  const expectedShuffle = shuffleWithState(makeDeck(), {
    algorithm: PRNG_ALGORITHM,
    seed: state.prng.seed,
    state: state.prng.seed,
    counter: 0,
  });
  if (expectedShuffle.prng.state !== state.prng.state
    || expectedShuffle.prng.counter !== state.prng.counter) return invalid('PRNG replay mismatch');
  const inventory = new Map(makeDeck().map((card) => [card.id, card]));
  const seen = new Set();
  const validatePhysicalCard = (card) => {
    if (!hasExactKeys(card, CARD_KEYS) || typeof card.id !== 'string'
      || typeof card.rank !== 'string' || typeof card.suit !== 'string' || card.deckIndex !== 0) {
      return 'Invalid card schema';
    }
    const expected = inventory.get(card.id);
    if (!expected || cardSignature(expected) !== cardSignature(card)) return `Unknown or altered card: ${card.id}`;
    if (seen.has(card.id)) return `Duplicate physical card instance: ${card.id}`;
    seen.add(card.id);
    return null;
  };
  for (let index = 0; index < state.players.length; index += 1) {
    const player = state.players[index];
    const expectedKeys = state.playerSlots.length ? SLOTTED_PLAYER_KEYS : PLAYER_KEYS;
    if (!hasExactKeys(player, expectedKeys) || typeof player.name !== 'string' || !player.name.trim()
      || typeof player.emoji !== 'string' || typeof player.connected !== 'boolean'
      || !Array.isArray(player.hand)) return invalid(`Invalid player schema at index ${index}`);
    if (state.playerSlots.length && player.slotId !== state.playerSlots[index]) {
      return invalid(`Invalid slot ownership at player ${index}`);
    }
    for (const card of player.hand) {
      const error = validatePhysicalCard(card);
      if (error) return invalid(error);
    }
  }
  for (const card of state.centerPile) {
    const error = validatePhysicalCard(card);
    if (error) return invalid(error);
  }
  if (seen.size !== DECK_SIZE) return invalid(`Card conservation mismatch: expected ${DECK_SIZE}, found ${seen.size}`);

  if (state.lastPlacement !== null) {
    const placement = state.lastPlacement;
    if (!hasExactKeys(placement, PLACEMENT_KEYS)
      || !Number.isInteger(placement.playerIndex) || placement.playerIndex < 0
      || placement.playerIndex >= state.players.length
      || !Array.isArray(placement.actualCards) || placement.actualCards.length < 1
      || placement.actualCards.length > MAX_PLACEMENT_CARDS
      || placement.count !== placement.actualCards.length
      || typeof placement.placerEmpty !== 'boolean'
      || !BLUFF_RANKS.includes(placement.declaredRank)
      || typeof placement.placementMoveId !== 'string' || !placement.placementMoveId.trim()
      || placement.placementRevision !== state.revision || placement.placementRevision < 1) {
      return invalid('Invalid lastPlacement schema');
    }
    if (state.status !== 'playing' || state.currentRank !== placement.declaredRank
      || state.currentPlayerIndex !== nextPlayer(state, placement.playerIndex)
      || placement.placerEmpty !== (state.players[placement.playerIndex].hand.length === 0)) {
      return invalid('Invalid lastPlacement state');
    }
    const expectedSuffix = state.centerPile.slice(-placement.actualCards.length);
    if (!sameCards(placement.actualCards, expectedSuffix)) return invalid('Placement cards are not the pile suffix');
    const uniqueRefs = new Set();
    for (const card of placement.actualCards) {
      if (!hasExactKeys(card, CARD_KEYS)) return invalid('Invalid placement card schema');
      const expected = inventory.get(card.id);
      if (!expected || cardSignature(expected) !== cardSignature(card) || uniqueRefs.has(card.id)) {
        return invalid('Invalid placement card reference');
      }
      uniqueRefs.add(card.id);
    }
  }

  if (state.status === 'playing') {
    if (state.winnerIndex !== null) return invalid('Playing state cannot contain a winner');
  } else {
    if (!Number.isInteger(state.winnerIndex) || state.winnerIndex < 0
      || state.winnerIndex >= state.players.length
      || state.players[state.winnerIndex].hand.length !== 0
      || state.lastPlacement !== null || state.currentRank !== null) return invalid('Invalid finished state');
  }

  if (state.revision === 0) {
    if (state.status !== 'playing' || state.currentPlayerIndex !== 0 || state.roundStartPlayer !== 0
      || state.currentRank !== null || state.lastPlacement !== null
      || state.playersActedThisRound.length !== 0 || state.winnerIndex !== null) {
      return invalid('Invalid initial state metadata');
    }
    const handSize = Math.floor(DECK_SIZE / state.players.length);
    for (let index = 0; index < state.players.length; index += 1) {
      const expected = expectedShuffle.cards.slice(index * handSize, (index + 1) * handSize);
      if (!sameCards(state.players[index].hand, expected)) return invalid(`Initial deal mismatch at player ${index}`);
    }
    if (!sameCards(state.centerPile, expectedShuffle.cards.slice(handSize * state.players.length))) {
      return invalid('Initial center remainder mismatch');
    }
  }
  return { valid: true };
}

export function serializeState(state) {
  assertValid(state);
  const serializable = cloneState(state);
  const json = JSON.stringify(serializable);
  if (json === undefined) throw new TypeError('State is not serializable');
  const parsed = JSON.parse(json);
  if (JSON.stringify(parsed) !== json) throw new TypeError('State is not canonically serializable');
  return parsed;
}
