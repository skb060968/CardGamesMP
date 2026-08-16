import { createActionCoordinator } from '../../core/action-coordinator.js';
import { ref as firebaseRef, runTransaction as firebaseRunTransaction } from 'firebase/database';

import { firebaseArray } from '../../core/firebase-array.js';
import { generateRoomCode, normalizeRoomCode } from '../../core/room-code.js';
import { createFirebaseRoomStore } from '../../data/firebase-room-store.js';
import { createGameSessionStore } from '../../platform/session-storage.js';
import { createBluffAction } from './bluff-action.js';
import { createBluffTransitionValidator } from './bluff-transition.js';

const GAME_ID = 'bluff';
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
  if (Array.isArray(value)) return value.length ? value.map(compactFirebaseValue) : null;
  if (typeof value !== 'object') return value;
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    const compacted = compactFirebaseValue(item);
    if (compacted !== null) result[key] = compacted;
  });
  return Object.keys(result).length ? result : null;
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
}
function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
function waitingState() {
  return {
    players: [], playerSlots: [], centerPile: [], currentPlayerIndex: 0,
    phase: 'placing', lastPlacement: null, status: 'waiting', winnerIndex: null,
    deckSize: 0, currentRank: null, roundStartPlayer: 0,
    playersActedThisRound: [], prng: null, revision: 0,
  };
}
function decodeGameState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rawPlacement = source.lastPlacement;
  return {
    ...source,
    players: firebaseArray(source.players).map((player) => ({
      ...player, hand: firebaseArray(player?.hand),
    })),
    playerSlots: firebaseArray(source.playerSlots),
    centerPile: firebaseArray(source.centerPile),
    playersActedThisRound: firebaseArray(source.playersActedThisRound),
    lastPlacement: rawPlacement ? {
      ...rawPlacement, actualCards: firebaseArray(rawPlacement.actualCards),
    } : null,
    winnerIndex: source.winnerIndex ?? null,
    currentRank: source.currentRank ?? null,
    prng: source.prng ?? null,
  };
}
function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.uid)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

export function createBluffRuntime({
  database,
  uid,
  rules,
  effects,
  storage = globalThis.localStorage,
  roomStoreFactory = createFirebaseRoomStore,
  codeGenerator = generateRoomCode,
  callbacks = {},
}) {
  for (const name of [
    'createGame', 'placeCards', 'passCard',
    'resolveChallenge', 'validateState', 'serializeState',
  ]) requireFunction(rules?.[name], `rules.${name}`);
  requireFunction(effects?.animateAction, 'effects.animateAction');
  requireFunction(effects?.render, 'effects.render');
  requireFunction(roomStoreFactory, 'roomStoreFactory');
  requireFunction(codeGenerator, 'codeGenerator');

  const sessions = createGameSessionStore(GAME_ID, storage);
  const validateTransition = createBluffTransitionValidator(rules);
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
  let commitBluff = null;

  const reportError = (error) => callbacks.onError?.(error);
  const sameOrder = (left, right) => left.length === right.length
    && left.every((id, index) => id === right[index]);
  const loadOrder = (key) => {
    if (!key) return [];
    try {
      const parsed = JSON.parse(storage.getItem(key));
      if (parsed?.version !== HAND_ORDER_VERSION || !Array.isArray(parsed.order)) return [];
      const seen = new Set();
      return parsed.order.filter((id) => typeof id === 'string' && id && !seen.has(id) && seen.add(id));
    } catch (_) { return []; }
  };
  const persistOrder = () => {
    if (!handOrderKey) return;
    try {
      storage.setItem(handOrderKey, JSON.stringify({ version: HAND_ORDER_VERSION, order: handOrder }));
    } catch (_) { /* Visual ordering must never block gameplay. */ }
  };
  const selectOrderRound = (room) => {
    const token = room?.meta?.resetAt ?? room?.game?.prng?.seed ?? null;
    const key = store && token != null
      ? `cardgamesmp:ui-order:${GAME_ID}:${encodeURIComponent(uid)}:${encodeURIComponent(store.roomCode)}:${token}`
      : null;
    if (key === handOrderKey) return;
    handOrderKey = key;
    handOrder = loadOrder(key);
  };
  const reconcileHandOrder = (gameState = state) => {
    const hand = gameState?.players?.[gamePlayerIndex]?.hand;
    if (!Array.isArray(hand)) return [];
    const ids = hand.map((card) => card?.id).filter((id) => typeof id === 'string');
    const current = new Set(ids);
    const next = handOrder.filter((id) => current.has(id));
    const included = new Set(next);
    ids.forEach((id) => { if (!included.has(id)) { next.push(id); included.add(id); } });
    if (!sameOrder(next, handOrder)) { handOrder = next; persistOrder(); }
    return [...handOrder];
  };
  function reorderVisualCard(cardId, targetVisualIndex) {
    const order = reconcileHandOrder();
    const sourceIndex = order.indexOf(cardId);
    if (sourceIndex < 0 || !Number.isInteger(targetVisualIndex) || order.length === 0) return order;
    const target = Math.max(0, Math.min(targetVisualIndex, order.length - 1));
    if (sourceIndex !== target) {
      order.splice(sourceIndex, 1);
      order.splice(target, 0, cardId);
      handOrder = order;
      persistOrder();
    }
    return [...handOrder];
  }
  function sortVisualCards(mode = 'rank') {
    const order = reconcileHandOrder();
    if (mode !== 'rank') return order;
    const cards = new Map((state?.players?.[gamePlayerIndex]?.hand || []).map((card) => [card.id, card]));
    handOrder = [...order].sort((leftId, rightId) => {
      const left = cards.get(leftId);
      const right = cards.get(rightId);
      if (!left || !right) return left ? -1 : right ? 1 : leftId.localeCompare(rightId);
      return (RANK_ORDER[left.rank] ?? 99) - (RANK_ORDER[right.rank] ?? 99)
        || (SUIT_ORDER[left.suit] ?? 99) - (SUIT_ORDER[right.suit] ?? 99)
        || left.id.localeCompare(right.id);
    });
    persistOrder();
    return [...handOrder];
  }

  const expectedRoster = (room) => room?.expectedRoster || room?.meta?.expectedRoster || null;
  const updateIdentity = (room) => {
    host = room?.meta?.hostUid === uid;
    const slots = room?.game?.playerSlots;
    gamePlayerIndex = Array.isArray(slots) ? slots.indexOf(`player_${roomSlotIndex}`) : roomSlotIndex;
    selectOrderRound(room);
  };
  const ownsSeat = (room) => {
    const slot = `player_${roomSlotIndex}`;
    if (room?.players?.[slot]?.uid !== uid) return false;
    const roster = expectedRoster(room);
    return !roster || roster[slot] == null || roster[slot] === uid;
  };
  const renderState = (parameters = {}) => {
    const renderable = parameters.state || state;
    return effects.render({
      ...parameters,
      state: renderable,
      playerIndex: gamePlayerIndex,
      handOrder: reconcileHandOrder(renderable),
      onAction: actLocal,
      onSort: (mode) => {
        sortVisualCards(mode);
        return renderState();
      },
      onReorder: reorderVisualCard,
    });
  };

  const coordinator = createActionCoordinator({
    onError: reportError,
    applyRemote: async ({ room, move }, { signal }) => {
      const incoming = room?.game;
      if (!incoming || (state && incoming.revision <= state.revision)) return;
      const previous = state;
      const exactlyNext = previous && incoming.revision === previous.revision + 1;
      try {
        if (exactlyNext && move?.type === 'bluff-action' && move.playerIndex !== gamePlayerIndex) {
          await effects.animateAction({
            moveId: move.id,
            playerIndex: move.playerIndex,
            localPlayerIndex: gamePlayerIndex,
            action: move.action,
            payload: move.payload ?? null,
            fromState: previous,
            toState: incoming,
            signal,
          });
        }
      } catch (error) {
        reportError(error);
      } finally {
        state = incoming;
        updateIdentity(room);
        try { await renderState({ state, move }); }
        finally { callbacks.onState?.(state, { remote: true, move }); }
      }
    },
  });

  const sync = {
    commitBluffAction(payload) {
      if (!commitBluff) throw new Error('Room is not connected');
      return commitBluff(payload);
    },
  };
  const actionEffects = {
    animateAction: (parameters) => effects.animateAction({
      ...parameters, localPlayerIndex: gamePlayerIndex,
    }),
    render: renderState,
  };
  const performAction = createBluffAction({
    coordinator,
    rules,
    sync,
    effects: actionEffects,
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
      callbacks.onState?.(state, { remote: false });
    },
  });

  const encodeGameState = (gameState) => {
    const serializable = gameState?.status === 'waiting' ? gameState : rules.serializeState(gameState);
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
  const createFallbackCommit = (activeStore) => async (payload = {}) => {
    const {
      moveId, expectedRevision, playerIndex, action: actionType,
      payload: actionPayload = null, state: proposedState,
    } = payload;
    if (typeof moveId !== 'string' || !moveId.trim()) throw new TypeError('moveId is required');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative safe integer');
    }
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= MAX_PLAYERS) {
      throw new TypeError('Invalid playerIndex');
    }
    if (!['place', 'pass', 'challenge'].includes(actionType)) {
      throw new TypeError('Unsupported Bluff action');
    }
    const encodedNextState = encodeGameState(proposedState);
    const nextState = decodeGameState(encodedNextState);
    if (nextState.revision !== expectedRevision + 1) throw new Error('invalid-next-revision');
    const safePayload = actionPayload === null
      ? null
      : JSON.parse(JSON.stringify(actionPayload));
    const transitionAction = {
      type: 'bluff-action', moveId, expectedRevision, playerIndex,
      action: actionType, payload: safePayload,
    };
    const commitTime = Date.now();
    let rejection = 'transaction-aborted';
    let idempotent = false;
    const result = await firebaseRunTransaction(
      firebaseRef(database, activeStore.path),
      (currentRoom) => {
        rejection = 'transaction-aborted';
        idempotent = false;
        if (!currentRoom) { rejection = 'room-not-found'; return undefined; }
        const previous = currentRoom.lastMove;
        if (previous?.id === moveId) {
          const sameMove = previous.type === 'bluff-action'
            && previous.expectedRevision === expectedRevision
            && previous.revision === nextState.revision
            && previous.playerIndex === playerIndex
            && previous.action === actionType
            && sameValue(previous.payload ?? null, safePayload)
            && sameValue(currentRoom.game, encodedNextState);
          if (!sameMove) { rejection = 'move-id-collision'; return undefined; }
          idempotent = true;
          return currentRoom;
        }
        if (currentRoom.meta?.status !== 'active') {
          rejection = 'room-not-active';
          return undefined;
        }
        let currentState;
        try { currentState = decodeGameState(currentRoom.game); }
        catch (_) { rejection = 'invalid-current-state'; return undefined; }
        const slot = currentState.playerSlots?.[playerIndex]
          || currentState.players?.[playerIndex]?.slotId;
        if (!/^player_[0-5]$/.test(slot || '')) {
          rejection = 'invalid-player-slot';
          return undefined;
        }
        if (currentRoom.players?.[slot]?.uid !== uid) {
          rejection = 'player-identity-mismatch';
          return undefined;
        }
        if (currentState.revision !== expectedRevision) {
          rejection = 'revision-conflict';
          return undefined;
        }
        const verdict = validateTransition({ currentState, nextState, action: transitionAction });
        if (!verdict?.valid) { rejection = verdict?.reason || 'invalid-transition'; return undefined; }
        const lastMove = {
          id: moveId,
          type: 'bluff-action',
          action: actionType,
          expectedRevision,
          revision: nextState.revision,
          playerIndex,
          createdAt: commitTime,
        };
        if (safePayload !== null) lastMove.payload = safePayload;
        return {
          ...currentRoom,
          game: encodedNextState,
          lastMove,
          meta: { ...currentRoom.meta, status: 'active', lastActivity: commitTime },
        };
      },
      { applyLocally: false },
    );
    if (!result.committed) {
      const error = new Error(`Bluff commit rejected: ${rejection}`);
      error.code = rejection;
      throw error;
    }
    const room = result.snapshot.val();
    if (!room?.game) throw new Error('missing-committed-state');
    return { state: decodeGameState(room.game), move: room.lastMove, idempotent };
  };
  const enqueue = (task) => {
    reconcileChain = reconcileChain.then(task).catch(reportError);
    return reconcileChain;
  };
  const queueRosterRefresh = (player, event) => {
    callbacks.onPlayer?.(player, event);
    if (rosterRefreshQueued) return;
    rosterRefreshQueued = true;
    enqueue(async () => { rosterRefreshQueued = false; await refreshRoom(); });
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
    commitBluff = null;
    coordinator.dispose();
    callbacks.onDisconnected?.(details);
  }
  async function refreshRoom(move = null, { forceSnapshot = false } = {}) {
    if (!store || disposed) return;
    let room;
    try { room = await store.readRoom(); }
    catch (error) {
      if (error?.code !== 'room-not-found') throw error;
      await handleLostRoom({ roomDeleted: true });
      return;
    }
    if (!ownsSeat(room)) { await handleLostRoom({ removed: true }); return; }
    updateIdentity(room);
    if (room.meta?.status === 'active' && room.game) {
      const incoming = room.game;
      if (!forceSnapshot && state && incoming.revision <= state.revision) return;
      const exactlyNext = state && incoming.revision === state.revision + 1;
      if (!forceSnapshot && move?.id && exactlyNext) {
        await coordinator.acceptRemote({ moveId: move.id, room, move });
      } else {
        state = incoming;
        try { await renderState({ state, move: null }); }
        finally {
          callbacks.onState?.(state, {
            remote: true, move: null, snapshot: true, reset: forceSnapshot,
          });
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
    commitBluff = typeof activeStore.commitBluffAction === 'function'
      ? activeStore.commitBluffAction.bind(activeStore)
      : createFallbackCommit(activeStore);
    sessions.save({ roomCode: store.roomCode, playerIndex: roomSlotIndex, uid });
    unsubscribeRoom = store.subscribeRoom({
      onMove: (move) => enqueue(() => refreshRoom(move?.id ? move : null)),
      onStatus: () => enqueue(() => refreshRoom()),
      onReset: () => enqueue(() => refreshRoom(null, { forceSnapshot: true })),
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
    } else callbacks.onLobby?.({ room, roomCode: store.roomCode, isHost: host, roomSlotIndex });
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
      if (!ownsSeat(room)) { roomSlotIndex = -1; sessions.clear(); return false; }
      roomSlotIndex = -1;
      await attach(activeStore, saved.playerIndex, room);
      return true;
    } catch (error) {
      roomSlotIndex = -1;
      if (error?.code === 'room-not-found') sessions.clear();
      reportError(error);
      return false;
    }
  }
  async function launchRound(options = {}) {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start a round');
    const entries = sortedPlayers(room).slice(0, MAX_PLAYERS);
    if (entries.length < 2 || entries.length > MAX_PLAYERS) throw new Error('Bluff requires 2-4 players');
    const infos = entries.map(([slot, player]) => ({
      name: player.name, emoji: player.emoji, slotId: slot,
    }));
    const nextState = rules.createGame(infos, options.seed == null ? undefined : { seed: options.seed });
    const validation = rules.validateState(nextState);
    if (!validation?.valid) throw new Error(validation?.error || 'Invalid initial Bluff state');
    const roster = Object.fromEntries(entries.map(([slot, player]) => [slot, player.uid]));
    const updated = await store.resetRoom({
      state: nextState, status: 'active', expectedRoster: roster,
    });
    state = updated.game;
    updateIdentity(updated);
    await renderState({ state });
    callbacks.onState?.(state, { remote: false, newRound: true });
    return state;
  }
  async function startRound(options = {}) { return launchRound(options); }
  async function playAgain(options = {}) {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start another round');
    if (room.game?.status !== 'finished') throw new Error('The current round is not finished');
    return launchRound(options);
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
    let shouldRender = false;
    try {
      const previousRevision = state?.revision;
      const room = await store.readRoom();
      if (room?.meta?.status === 'active' && room.game
        && (!state || room.game.revision >= state.revision)) {
        state = room.game;
        updateIdentity(room);
        shouldRender = !Number.isSafeInteger(previousRevision) || room.game.revision > previousRevision;
      }
    } catch (error) { reportError(error); }
    finally {
      if (state && shouldRender) {
        try { await renderState({ state }); } catch (error) { reportError(error); }
      }
    }
  }
  async function actLocal(action) {
    ensureConnected();
    if (gamePlayerIndex < 0) throw new Error('Player is not seated in the active round');
    callbacks.onBeforeAction?.(action);
    try {
      const result = await performAction({ playerIndex: gamePlayerIndex, action });
      if (!result?.ok) callbacks.onActionUnavailable?.(result);
      return result;
    } finally { await authoritativeFinally(); }
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
    commitBluff = null;
    coordinator.dispose();
    callbacks.onDisconnected?.({ deleted: shouldDelete });
  }
  async function close() {
    if (disposed) return;
    disposed = true;
    await disconnectLocal();
    commitBluff = null;
    coordinator.dispose();
    await reconcileChain.catch(() => {});
    callbacks.onDisconnected?.({ deleted: false, localOnly: true });
  }

  return Object.freeze({
    createRoom, joinRoom, restoreSession, startRound, playAgain,
    removePlayer: removeLobbyPlayer, act: actLocal, leaveRoom, close,
    sortHand: sortVisualCards, reorderCard: reorderVisualCard,
    refresh: () => refreshRoom(),
    get roomCode() { return store?.roomCode || null; },
    get currentState() { return state; },
    get playerSlotIndex() { return roomSlotIndex; },
    get playerIndex() { return gamePlayerIndex; },
    get isHost() { return host; },
    get connected() { return Boolean(store) && !disposed; },
    get busy() { return coordinator.busy; },
  });
}
