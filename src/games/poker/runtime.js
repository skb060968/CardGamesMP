import { createActionCoordinator } from '../../core/action-coordinator.js';
import { firebaseArray } from '../../core/firebase-array.js';
import { generateRoomCode, normalizeRoomCode } from '../../core/room-code.js';
import { createFirebaseRoomStore } from '../../data/firebase-room-store.js';
import { createGameSessionStore } from '../../platform/session-storage.js';
import { createPokerAction } from './poker-action.js';
import { createPokerTransitionValidator } from './poker-transition.js';

const GAME_ID = 'poker';
const MAX_PLAYERS = 4;

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

function waitingState() {
  return {
    status: 'waiting', revision: 0, players: [], playerSlots: [], deck: [], pot: 0,
    currentPlayerIndex: 0, winnerIndex: null, showEligible: false, finishReason: null,
    deckSize: 0, prng: null,
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
    deck: firebaseArray(source.deck),
    winnerIndex: source.winnerIndex ?? null,
    finishReason: source.finishReason ?? null,
    prng: source.prng ?? null,
  };
}

function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.uid)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

export function createPokerRuntime({
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
  requireFunction(rules?.performAction, 'rules.performAction');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(rules?.serializeState, 'rules.serializeState');
  requireFunction(effects?.animateAction, 'effects.animateAction');
  requireFunction(effects?.render, 'effects.render');
  requireFunction(roomStoreFactory, 'roomStoreFactory');
  requireFunction(codeGenerator, 'codeGenerator');

  const sessions = createGameSessionStore(GAME_ID, storage);
  const validateTransition = createPokerTransitionValidator(rules);
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

  const reportError = (error) => callbacks.onError?.(error);

  const updateIdentity = (room) => {
    host = room?.meta?.hostUid === uid;
    gamePlayerIndex = Array.isArray(room?.game?.playerSlots)
      ? room.game.playerSlots.indexOf(`player_${roomSlotIndex}`)
      : roomSlotIndex;
  };

  const ownsSeat = (room) => room?.players?.[`player_${roomSlotIndex}`]?.uid === uid;

  const renderState = (parameters = {}) => effects.render({
    ...parameters,
    state: parameters.state || state,
    playerIndex: gamePlayerIndex,
    onAction: async (action) => {
      callbacks.onBeforeAction?.(action);
      try {
        const result = await actLocal(action);
        if (!result?.ok) callbacks.onActionUnavailable?.(result);
        return result;
      } catch (error) {
        reportError(error);
        return { ok: false, error };
      }
    },
  });

  const coordinator = createActionCoordinator({
    onError: reportError,
    applyRemote: async ({ room, move }, { signal }) => {
      const incoming = room?.game;
      if (!incoming || (state && incoming.revision <= state.revision)) return;
      const previous = state;
      const exactlyNext = previous && incoming.revision === previous.revision + 1;
      try {
        if (exactlyNext && move?.type === 'poker-action' && move.playerIndex !== gamePlayerIndex) {
          await effects.animateAction({
            moveId: move.id,
            playerIndex: move.playerIndex,
            localPlayerIndex: gamePlayerIndex,
            action: move.action,
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

  let commitPoker = null;
  const sync = {
    commitPokerAction(payload) {
      if (!commitPoker) throw new Error('Room is not connected');
      return commitPoker(payload);
    },
  };
  const actionEffects = {
    animateAction: (parameters) => effects.animateAction({
      ...parameters,
      localPlayerIndex: gamePlayerIndex,
    }),
    render: renderState,
  };
  const performPokerAction = createPokerAction({
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

  async function refreshRoom(move = null, { forceSnapshot = false } = {}) {
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
    requireFunction(activeStore.commitPokerAction, 'store.commitPokerAction');
    commitPoker = activeStore.commitPokerAction.bind(activeStore);
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
    const created = await activeStore.createRoom({
      state: waitingState(), player, status: 'waiting',
    });
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

  function carriedChips(entries, input) {
    if (input == null) return undefined;
    if (!Array.isArray(input) && (typeof input !== 'object' || input === null)) {
      throw new TypeError('Chip carry input must be an array or slot map');
    }
    return entries.map(([slot], index) => Array.isArray(input) ? input[index] : input[slot]);
  }

  async function launchRound(options = {}, carryInput) {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start a round');
    const entries = sortedPlayers(room).slice(0, MAX_PLAYERS);
    if (entries.length < 2) throw new Error('At least two players are required');
    const infos = entries.map(([slot, player]) => ({
      name: player.name,
      emoji: player.emoji,
      slotId: slot,
    }));
    const baseState = rules.createGame(infos, {
      existingChips: carriedChips(entries, carryInput),
      seed: options.seed,
    });
    const playerSlots = entries.map(([slot]) => slot);
    const nextState = {
      ...baseState,
      revision: 0,
      playerSlots,
      players: baseState.players.map((player, index) => ({
        ...player,
        slotId: playerSlots[index],
      })),
    };
    const validation = rules.validateState(nextState);
    if (!validation?.valid) throw new Error(validation?.error || 'Invalid initial Poker state');
    const roster = Object.fromEntries(entries.map(([slot, player]) => [slot, player.uid]));
    const updated = await store.resetRoom({
      state: nextState,
      status: 'active',
      expectedRoster: roster,
    });
    state = updated.game;
    updateIdentity(updated);
    await renderState({ state });
    callbacks.onState?.(state, { remote: false, newRound: true });
    return state;
  }

  function startRound(options = {}) {
    return launchRound(
      options,
      options.existingChips ?? options.chipsBySlot ?? options.chips,
    );
  }

  async function playAgain(options = {}) {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start another round');
    if (room.game?.status !== 'finished') throw new Error('The current round is not finished');
    const balances = {};
    firebaseArray(room.game.playerSlots).forEach((slot, index) => {
      const chips = room.game.players?.[index]?.chips;
      if (typeof slot === 'string' && Number.isSafeInteger(chips) && chips >= 0) balances[slot] = chips;
    });
    return launchRound(options, balances);
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
        try { await renderState({ state }); }
        catch (error) { reportError(error); }
      }
    }
  }

  async function actLocal(action) {
    ensureConnected();
    if (gamePlayerIndex < 0) throw new Error('Player is not seated in the active round');
    const actionType = typeof action === 'string' ? action : action?.type;
    try {
      return await performPokerAction({ playerIndex: gamePlayerIndex, action: actionType });
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
    commitPoker = null;
    coordinator.dispose();
    callbacks.onDisconnected?.({ deleted: shouldDelete });
  }

  async function close() {
    if (disposed) return;
    disposed = true;
    await disconnectLocal();
    commitPoker = null;
    coordinator.dispose();
    await reconcileChain.catch(() => {});
    callbacks.onDisconnected?.({ deleted: false, localOnly: true });
  }

  return Object.freeze({
    createRoom,
    joinRoom,
    restoreSession,
    startRound,
    playAgain,
    removePlayer: removeLobbyPlayer,
    act: actLocal,
    leaveRoom,
    close,
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
