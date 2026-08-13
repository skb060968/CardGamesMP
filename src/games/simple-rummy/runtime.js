import { createActionCoordinator } from '../../core/action-coordinator.js';
import { firebaseArray } from '../../core/firebase-array.js';
import { generateRoomCode, normalizeRoomCode } from '../../core/room-code.js';
import { createFirebaseRoomStore } from '../../data/firebase-room-store.js';
import { createGameSessionStore } from '../../platform/session-storage.js';
import { createSimpleRummyDrawAction } from './draw-action.js';
import { createSimpleRummyDiscardAction } from './discard-action.js';
import { createSimpleRummyDrawTransitionValidator } from './draw-transition.js';
import { createSimpleRummyDiscardTransitionValidator } from './discard-transition.js';

const GAME_ID = 'simple-rummy';
const MAX_PLAYERS = 4;
const HAND_ORDER_VERSION = 1;
const RANK_ORDER = Object.freeze({
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
});
const SUIT_ORDER = Object.freeze({ '♠': 0, '♥': 1, '♦': 2, '♣': 3 });

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function compactFirebaseValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => compactFirebaseValue(item));
  }
  if (typeof value !== 'object') return value;
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    const compacted = compactFirebaseValue(item);
    if (compacted !== null) result[key] = compacted;
  });
  return Object.keys(result).length === 0 ? null : result;
}

function waitingState() {
  return {
    status: 'waiting', revision: 0, players: [], playerSlots: [], drawPile: [],
    discardPile: [], currentPlayerIndex: 0, turnPhase: 'draw', winnerIndex: null,
    winGroups: null, deckCount: 0, deckSize: 0, prng: null,
  };
}

function decodeGameState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...source,
    players: firebaseArray(source.players).map((player) => ({
      ...player,
      hand: firebaseArray(player?.hand),
    })),
    playerSlots: firebaseArray(source.playerSlots),
    drawPile: firebaseArray(source.drawPile),
    discardPile: firebaseArray(source.discardPile),
    winnerIndex: source.winnerIndex ?? null,
    winGroups: source.winGroups == null
      ? null
      : firebaseArray(source.winGroups).map((group) => firebaseArray(group)),
  };
}

function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.uid)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}
export function createSimpleRummyRuntime({
  database,
  uid,
  rules,
  effects,
  storage = globalThis.sessionStorage,
  roomStoreFactory = createFirebaseRoomStore,
  codeGenerator = generateRoomCode,
  callbacks = {},
}) {
  requireFunction(rules?.createGame, 'rules.createGame');
  requireFunction(rules?.drawCard, 'rules.drawCard');
  requireFunction(rules?.discardCard, 'rules.discardCard');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(rules?.serializeState, 'rules.serializeState');
  requireFunction(effects?.animateDraw, 'effects.animateDraw');
  requireFunction(effects?.animateDiscard, 'effects.animateDiscard');
  requireFunction(effects?.render, 'effects.render');
  requireFunction(roomStoreFactory, 'roomStoreFactory');
  requireFunction(codeGenerator, 'codeGenerator');

  const sessions = createGameSessionStore(GAME_ID, storage);
  let state = null;
  let store = null;
  let roomSlotIndex = -1;
  let gamePlayerIndex = -1;
  let host = false;
  let unsubscribeRoom = null;
  let stopPresence = null;
  let disposed = false;
  let reconcileChain = Promise.resolve();
  let rosterRefreshQueued = false;
  let handOrderKey = null;
  let handOrder = [];

  const reportError = (error) => callbacks.onError?.(error);

  const sameOrder = (left, right) => left.length === right.length
    && left.every((cardId, index) => cardId === right[index]);

  const loadHandOrder = (key) => {
    if (!key) return [];
    try {
      const value = JSON.parse(storage.getItem(key));
      if (value?.version !== HAND_ORDER_VERSION || !Array.isArray(value.order)) return [];
      const unique = new Set();
      return value.order.filter((cardId) => {
        if (typeof cardId !== 'string' || !cardId || unique.has(cardId)) return false;
        unique.add(cardId);
        return true;
      });
    } catch (_) {
      return [];
    }
  };

  const persistHandOrder = () => {
    if (!handOrderKey) return;
    try {
      storage.setItem(handOrderKey, JSON.stringify({
        version: HAND_ORDER_VERSION,
        order: handOrder,
      }));
    } catch (_) { /* visual ordering must never block gameplay */ }
  };

  const selectHandOrderRound = (room) => {
    const roundToken = room?.meta?.resetAt ?? room?.game?.prng?.seed ?? null;
    const nextKey = store && roundToken != null
      ? `cardgamesmp:ui-order:${GAME_ID}:${encodeURIComponent(uid)}:${encodeURIComponent(store.roomCode)}:${roundToken}`
      : null;
    if (nextKey === handOrderKey) return;
    handOrderKey = nextKey;
    handOrder = loadHandOrder(nextKey);
  };

  const reconcileHandOrder = (gameState = state) => {
    const hand = gameState?.players?.[gamePlayerIndex]?.hand;
    if (!Array.isArray(hand)) return [];
    const currentIds = hand.map((card) => card?.id).filter((cardId) => typeof cardId === 'string');
    const currentSet = new Set(currentIds);
    const reconciled = handOrder.filter((cardId) => currentSet.has(cardId));
    const included = new Set(reconciled);
    currentIds.forEach((cardId) => {
      if (!included.has(cardId)) {
        reconciled.push(cardId);
        included.add(cardId);
      }
    });
    if (!sameOrder(reconciled, handOrder)) {
      handOrder = reconciled;
      persistHandOrder();
    }
    return [...handOrder];
  };

  const rerenderHandOrder = () => {
    if (!state) return;
    // Defer replacement of the dragged node until the browser has emitted the
    // click that follows pointerup; the old node suppresses that click safely.
    setTimeout(() => {
      if (state && !disposed) renderState({ state }).catch(reportError);
    }, 0);
  };

  function reorderVisualCard(cardId, targetVisualIndex) {
    const current = reconcileHandOrder();
    const sourceIndex = current.indexOf(cardId);
    if (sourceIndex < 0 || !Number.isInteger(targetVisualIndex)) return;
    const targetIndex = Math.max(0, Math.min(targetVisualIndex, current.length - 1));
    if (sourceIndex === targetIndex) return;
    current.splice(sourceIndex, 1);
    current.splice(targetIndex, 0, cardId);
    handOrder = current;
    persistHandOrder();
    rerenderHandOrder();
  }

  function sortVisualCards(mode) {
    if (mode !== 'rank' && mode !== 'suit') return;
    const current = reconcileHandOrder();
    const cards = new Map(
      (state?.players?.[gamePlayerIndex]?.hand || []).map((card) => [card.id, card]),
    );
    const compare = (leftId, rightId) => {
      const left = cards.get(leftId);
      const right = cards.get(rightId);
      if (!left || !right) return left ? -1 : right ? 1 : leftId.localeCompare(rightId);
      const rankDifference = (RANK_ORDER[left.rank] ?? 99) - (RANK_ORDER[right.rank] ?? 99);
      const suitDifference = (SUIT_ORDER[left.suit] ?? 99) - (SUIT_ORDER[right.suit] ?? 99);
      const primary = mode === 'rank' ? rankDifference : suitDifference;
      const secondary = mode === 'rank' ? suitDifference : rankDifference;
      return primary || secondary || (left.deckIndex ?? 0) - (right.deckIndex ?? 0)
        || left.id.localeCompare(right.id);
    };
    const sorted = [...current].sort(compare);
    if (sameOrder(sorted, handOrder)) return;
    handOrder = sorted;
    persistHandOrder();
    rerenderHandOrder();
  }

  const expectedRoster = (room) => room?.expectedRoster || room?.meta?.expectedRoster || null;

  const updateIdentity = (room) => {
    host = room?.meta?.hostUid === uid;
    const slots = room?.game?.playerSlots;
    gamePlayerIndex = Array.isArray(slots)
      ? slots.indexOf(`player_${roomSlotIndex}`)
      : roomSlotIndex;
    selectHandOrderRound(room);
  };

  const ownsSeat = (room) => {
    const slot = `player_${roomSlotIndex}`;
    if (room?.players?.[slot]?.uid !== uid) return false;
    const roster = expectedRoster(room);
    return !roster || roster[slot] == null || roster[slot] === uid;
  };

  const renderState = (parameters = {}) => {
    const renderableState = parameters.state || state;
    return effects.render({
      ...parameters,
      playerIndex: gamePlayerIndex,
      handOrder: reconcileHandOrder(renderableState),
      onDraw: drawLocal,
      onDiscard: discardLocal,
      onSort: sortVisualCards,
      onReorder: reorderVisualCard,
    });
  };

  const coordinator = createActionCoordinator({
    onError: reportError,
    applyRemote: async ({ room, move }, { signal }) => {
      const incoming = room?.game;
      if (!incoming || (state && incoming.revision <= state.revision)) return;
      const previous = state;
      const actor = move?.playerIndex;
      const exactlyNext = previous && incoming.revision === previous.revision + 1;
      try {
        if (exactlyNext && actor !== gamePlayerIndex && move?.type === 'draw-card' && move.card) {
          await effects.animateDraw({
            moveId: move.id, playerIndex: actor, localPlayerIndex: gamePlayerIndex,
            source: move.source, card: move.card, fromState: previous,
            toState: incoming, signal,
          });
        } else if (exactlyNext && actor !== gamePlayerIndex && move?.type === 'discard-card') {
          await effects.animateDiscard({
            moveId: move.id, playerIndex: actor, localPlayerIndex: gamePlayerIndex,
            handIndex: move.handIndex, card: move.card, fromState: previous,
            toState: incoming, signal,
          });
        }
      } catch (error) {
        reportError(error);
      } finally {
        state = incoming;
        updateIdentity(room);
        try {
          await renderState({ state, move });
        } finally {
          callbacks.onState?.(state, { remote: true, move });
        }
      }
    },
  });

  const sync = {
    commitDraw(payload) {
      if (!store) throw new Error('Room is not connected');
      return store.commitDraw(payload);
    },
    commitDiscard(payload) {
      if (!store) throw new Error('Room is not connected');
      return store.commitDiscard(payload);
    },
  };

  const actionEffects = {
    animateDraw: (parameters) => effects.animateDraw({
      ...parameters, localPlayerIndex: gamePlayerIndex,
    }),
    animateDiscard: (parameters) => effects.animateDiscard({
      ...parameters, localPlayerIndex: gamePlayerIndex,
    }),
    render: renderState,
  };

  const performDraw = createSimpleRummyDrawAction({
    coordinator, rules, sync, effects: actionEffects,
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
      callbacks.onState?.(state, { remote: false });
    },
  });
  const performDiscard = createSimpleRummyDiscardAction({
    coordinator, rules, sync, effects: actionEffects,
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
      callbacks.onState?.(state, { remote: false });
    },
  });

  const validateDraw = createSimpleRummyDrawTransitionValidator(rules);
  const validateDiscard = createSimpleRummyDiscardTransitionValidator(rules);
  const validateTransition = (parameters) => {
    if (parameters?.action?.type === 'draw-card') return validateDraw(parameters);
    if (parameters?.action?.type === 'discard-card') return validateDiscard(parameters);
    return { valid: false, reason: 'unsupported-action' };
  };

  const encodeGameState = (gameState) => {
    const serializable = gameState?.status === 'waiting'
      ? gameState
      : rules.serializeState(gameState);
    const compacted = compactFirebaseValue(serializable);
    if (!compacted || Array.isArray(compacted)) throw new TypeError('Invalid game state');
    return compacted;
  };

  const makeStore = (roomCode) => roomStoreFactory({
    database,
    gameId: GAME_ID,
    roomCode: normalizeRoomCode(roomCode),
    playerUid: uid,
    maxPlayers: MAX_PLAYERS,
    encodeState: encodeGameState,
    decodeState: decodeGameState,
    generateRoomCode: () => normalizeRoomCode(codeGenerator(), 'generated roomCode'),
    validateTransition,
  });

  const enqueue = (task) => {
    reconcileChain = reconcileChain.then(task).catch(reportError);
    return reconcileChain;
  };

  const queueRosterRefresh = (player, event) => {
    callbacks.onPlayer?.(player, event);
    if (rosterRefreshQueued) return;
    rosterRefreshQueued = true;
    enqueue(async () => {
      rosterRefreshQueued = false;
      await refreshRoom();
    });
  };

  async function disconnectLocal({ suppressErrors = false } = {}) {
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (stopPresence) {
      const stop = stopPresence;
      stopPresence = null;
      try { await stop(); } catch (error) { if (!suppressErrors) reportError(error); }
    }
  }

  async function handleLostRoom(details) {
    await disconnectLocal({ suppressErrors: true });
    sessions.clear();
    disposed = true;
    coordinator.dispose();
    callbacks.onDisconnected?.(details);
  }

  async function refreshRoom(move = null) {
    if (!store || disposed) return;
    let room;
    try {
      room = await store.readRoom();
    } catch (error) {
      if (error?.code !== 'room-not-found') throw error;
      await handleLostRoom({ roomDeleted: true });
      return;
    }
    if (!ownsSeat(room)) {
      await handleLostRoom({ removed: true });
      return;
    }
    updateIdentity(room);
    if (room.meta?.status === 'active' && room.game) {
      const incoming = room.game;
      if (state && incoming.revision <= state.revision) return;
      const exactlyNext = state && incoming.revision === state.revision + 1;
      if (move?.id && exactlyNext) {
        await coordinator.acceptRemote({ moveId: move.id, room, move });
      } else {
        state = incoming;
        try {
          await renderState({ state, move: null });
        } finally {
          callbacks.onState?.(state, { remote: true, move: null, snapshot: true });
        }
      }
      return;
    }
    state = room.game;
    callbacks.onLobby?.({ room, roomCode: store.roomCode, isHost: host, roomSlotIndex });
  }

  async function attach(activeStore, playerIndex, room) {
    if (store) throw new Error('Runtime is already connected to a room');
    store = activeStore;
    roomSlotIndex = playerIndex;
    state = room.game;
    updateIdentity(room);
    sessions.save({ roomCode: store.roomCode, playerIndex: roomSlotIndex, uid });
    unsubscribeRoom = store.subscribeRoom({
      onMove: (move) => enqueue(() => refreshRoom(move?.id ? move : null)),
      onStatus: () => enqueue(() => refreshRoom()),
      onPlayer: queueRosterRefresh,
      onError: reportError,
    });
    stopPresence = store.startPresence({ playerIndex: roomSlotIndex, onError: reportError });
    callbacks.onConnected?.({
      roomCode: store.roomCode, roomSlotIndex, gamePlayerIndex, isHost: host, room,
    });
    if (room.meta?.status === 'active') {
      await renderState({ state });
      callbacks.onState?.(state, { remote: true, restored: true });
    } else {
      callbacks.onLobby?.({ room, roomCode: store.roomCode, isHost: host, roomSlotIndex });
    }
    return { roomCode: store.roomCode, roomSlotIndex, gamePlayerIndex, isHost: host, room };
  }

  function ensureConnected() {
    if (disposed) throw new Error('Runtime is disposed');
    if (!store) throw new Error('Runtime is not connected to a room');
  }

  async function createRoom({ player }) {
    if (store || disposed) throw new Error('Runtime cannot create another room');
    const activeStore = makeStore(codeGenerator());
    const created = await activeStore.createRoom({ state: waitingState(), player, status: 'waiting' });
    return attach(activeStore, created.playerIndex, created.room);
  }

  async function joinRoom({ roomCode, player }) {
    if (store || disposed) throw new Error('Runtime cannot join another room');
    const activeStore = makeStore(normalizeRoomCode(roomCode));
    const joined = await activeStore.joinRoom({ player });
    return attach(activeStore, joined.playerIndex, joined.room);
  }

  async function restoreSession() {
    if (store || disposed) return false;
    const saved = sessions.load({ uid });
    if (!saved) return false;
    try {
      const activeStore = makeStore(saved.roomCode);
      const room = await activeStore.readRoom();
      roomSlotIndex = saved.playerIndex;
      if (!ownsSeat(room)) {
        roomSlotIndex = -1;
        sessions.clear();
        return false;
      }
      roomSlotIndex = -1;
      await attach(activeStore, saved.playerIndex, room);
      return true;
    } catch (error) {
      roomSlotIndex = -1;
      sessions.clear();
      reportError(error);
      return false;
    }
  }

  async function startRound(options = {}) {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start a round');
    const entries = sortedPlayers(room).slice(0, MAX_PLAYERS);
    if (entries.length < 2) throw new Error('At least two players are required');
    const infos = entries.map(([, player]) => ({ name: player.name, emoji: player.emoji }));
    const baseState = rules.createGame(infos, options.seed == null ? undefined : { seed: options.seed });
    const nextState = {
      ...baseState,
      revision: 0,
      playerSlots: entries.map(([slot]) => slot),
      players: baseState.players.map((player, index) => ({ ...player, slotId: entries[index][0] })),
    };
    const validation = rules.validateState(nextState);
    if (!validation?.valid) throw new Error(validation?.error || 'Invalid initial game state');
    const roster = Object.fromEntries(entries.map(([slot, player]) => [slot, player.uid]));
    const updated = await store.resetRoom({ state: nextState, status: 'active', expectedRoster: roster });
    state = updated.game;
    updateIdentity(updated);
    await renderState({ state });
    callbacks.onState?.(state, { remote: false, newRound: true });
    return state;
  }

  async function removeLobbyPlayer({ playerIndex, expectedUid }) {
    ensureConnected();
    if (!host) throw new Error('Only the host can remove a player');
    const result = await store.removePlayer({ playerIndex, expectedUid });
    await refreshRoom();
    return result;
  }

  async function authoritativeFinally() {
    if (!store || disposed) return;
    try {
      const room = await store.readRoom();
      if (room?.meta?.status === 'active' && room.game
        && (!state || room.game.revision >= state.revision)) {
        state = room.game;
        updateIdentity(room);
      }
    } catch (error) {
      reportError(error);
    } finally {
      if (state) {
        try { await renderState({ state }); } catch (error) { reportError(error); }
      }
    }
  }

  async function drawLocal(source) {
    ensureConnected();
    if (gamePlayerIndex < 0) throw new Error('Player is not seated in the active round');
    try {
      return await performDraw({ source, playerIndex: gamePlayerIndex });
    } finally {
      await authoritativeFinally();
    }
  }

  async function discardLocal(handIndex) {
    ensureConnected();
    if (gamePlayerIndex < 0) throw new Error('Player is not seated in the active round');
    try {
      return await performDiscard({ handIndex, playerIndex: gamePlayerIndex });
    } finally {
      await authoritativeFinally();
    }
  }

  async function leaveRoom({ deleteIfHost = true } = {}) {
    ensureConnected();
    const activeStore = store;
    const shouldDelete = deleteIfHost && host;
    await disconnectLocal();
    if (shouldDelete) await activeStore.deleteRoom();
    else await activeStore.leaveRoom({ playerIndex: roomSlotIndex });
    sessions.clear();
    disposed = true;
    coordinator.dispose();
    callbacks.onDisconnected?.({ deleted: shouldDelete });
  }

  async function close() {
    if (disposed) return;
    disposed = true;
    await disconnectLocal();
    coordinator.dispose();
    await reconcileChain.catch(() => {});
    callbacks.onDisconnected?.({ deleted: false, localOnly: true });
  }

  return Object.freeze({
    createRoom, joinRoom, restoreSession, startRound, playAgain: startRound,
    removePlayer: removeLobbyPlayer, draw: drawLocal, discard: discardLocal,
    leaveRoom, close, refresh: () => refreshRoom(),
    get roomCode() { return store?.roomCode || null; },
    get currentState() { return state; },
    get playerSlotIndex() { return roomSlotIndex; },
    get playerIndex() { return gamePlayerIndex; },
    get isHost() { return host; },
    get connected() { return Boolean(store) && !disposed; },
    get busy() { return coordinator.busy; },
  });
}
