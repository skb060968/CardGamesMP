import { createActionCoordinator } from '../../core/action-coordinator.js';
import { firebaseArray } from '../../core/firebase-array.js';
import { generateRoomCode, normalizeRoomCode } from '../../core/room-code.js';
import { createFirebaseRoomStore } from '../../data/firebase-room-store.js';
import { createGameSessionStore } from '../../platform/session-storage.js';
import { createFlipAndMatchFlipAction } from './flip-action.js';
import { createFlipAndMatchTransitionValidator } from './flip-transition.js';

const GAME_ID = 'flip-and-match';
const MAX_PLAYERS = 4;

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function waitingState() {
  return {
    status: 'waiting', revision: 0, board: [], players: [], playerSlots: [],
    currentPlayerIndex: 0, winnerIndex: null, isTie: false, tiedIndices: null,
  };
}

function decodeGameState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...source,
    board: firebaseArray(source.board),
    players: firebaseArray(source.players).map((player) => ({
      ...player,
      collected: firebaseArray(player?.collected),
    })),
    playerSlots: firebaseArray(source.playerSlots),
    tiedIndices: source.tiedIndices == null ? null : firebaseArray(source.tiedIndices),
  };
}

function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.uid)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

export function createFlipAndMatchRuntime({
  database,
  uid,
  rules,
  effects,
  storage = globalThis.localStorage,
  roomStoreFactory = createFirebaseRoomStore,
  codeGenerator = generateRoomCode,
  callbacks = {},
}) {
  requireFunction(rules?.createGame, 'rules.createGame');
  requireFunction(rules?.flipCard, 'rules.flipCard');
  requireFunction(rules?.checkGameEnd, 'rules.checkGameEnd');
  requireFunction(rules?.validateState, 'rules.validateState');
  requireFunction(effects?.revealCard, 'effects.revealCard');
  requireFunction(effects?.collectMatchedPair, 'effects.collectMatchedPair');
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

  const reportError = (error) => {
    if (typeof callbacks.onError === 'function') callbacks.onError(error);
  };

  const updateIdentity = (room) => {
    host = room?.meta?.hostUid === uid;
    gamePlayerIndex = Array.isArray(room?.game?.playerSlots)
      ? room.game.playerSlots.indexOf(`player_${roomSlotIndex}`)
      : roomSlotIndex;
  };

  const renderState = (parameters = {}) => effects.render({
    ...parameters,
    playerIndex: gamePlayerIndex,
    onFlip: flipLocalCard,
  });

  const coordinator = createActionCoordinator({
    onError: reportError,
    applyRemote: async ({ room, move }, { signal }) => {
      const incoming = room?.game;
      if (!incoming || (state && incoming.revision <= state.revision)) return;
      const previous = state;
      const actor = move?.playerIndex;
      try {
        if (previous && move?.type === 'flip-card' && actor !== gamePlayerIndex) {
          const context = {
            moveId: move.id,
            playerIndex: actor,
            localPlayerIndex: gamePlayerIndex,
            onFlip: flipLocalCard,
            cardIndex: move.cardIndex,
            card: move.card,
            matched: move.matched,
            matchedIndex: move.matchedIndex,
            fromState: previous,
            toState: incoming,
            signal,
          };
          await effects.revealCard(context);
          if (move.matched) await effects.collectMatchedPair(context);
        }
      } catch (error) {
        reportError(error);
      } finally {
        state = incoming;
        updateIdentity(room);
        try {
          await renderState({
            state,
            moveId: move?.id,
            cardIndex: move?.cardIndex,
            matched: move?.matched,
            matchedIndex: move?.matchedIndex,
          });
        } finally {
          callbacks.onState?.(state, { remote: true, move });
        }
      }
    },
  });

  const sync = {
    commitFlip: (payload) => {
      if (!store) throw new Error('Room is not connected');
      return store.commitFlip(payload);
    },
  };

  const actionEffects = {
    revealCard: (parameters) => effects.revealCard({
      ...parameters,
      localPlayerIndex: gamePlayerIndex,
      onFlip: flipLocalCard,
    }),
    collectMatchedPair: (parameters) => effects.collectMatchedPair({
      ...parameters,
      localPlayerIndex: gamePlayerIndex,
    }),
    render: renderState,
  };

  const performFlip = createFlipAndMatchFlipAction({
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

  const makeStore = (roomCode) => roomStoreFactory({
    database,
    gameId: GAME_ID,
    roomCode: normalizeRoomCode(roomCode),
    playerUid: uid,
    maxPlayers: MAX_PLAYERS,
    decodeState: decodeGameState,
    generateRoomCode: () => normalizeRoomCode(codeGenerator(), 'generated roomCode'),
    validateTransition: createFlipAndMatchTransitionValidator(rules),
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

  async function refreshRoom(move = null) {
    if (!store || disposed) return;
    let room;
    try {
      room = await store.readRoom();
    } catch (error) {
      if (error?.code !== 'room-not-found') throw error;
      await disconnectLocal({ suppressErrors: true });
      sessions.clear();
      disposed = true;
      coordinator.dispose();
      callbacks.onDisconnected?.({ roomDeleted: true });
      return;
    }
    if (room.players?.[`player_${roomSlotIndex}`]?.uid !== uid) {
      await disconnectLocal({ suppressErrors: true });
      sessions.clear();
      disposed = true;
      coordinator.dispose();
      callbacks.onDisconnected?.({ removed: true });
      return;
    }
    updateIdentity(room);
    if (room.meta?.status === 'active' && room.game) {
      if (move?.id) {
        await coordinator.acceptRemote({ moveId: move.id, room, move });
      } else if (
        !state
        || room.game.revision !== state.revision
        || room.game.status !== state.status
      ) {
        state = room.game;
        await renderState({ state });
        callbacks.onState?.(state, { remote: true, move: null });
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
      roomCode: store.roomCode,
      roomSlotIndex,
      gamePlayerIndex,
      isHost: host,
      room,
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
      state: waitingState(),
      player,
      status: 'waiting',
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
      if (room.players?.[`player_${saved.playerIndex}`]?.uid !== uid) {
        sessions.clear();
        return false;
      }
      await attach(activeStore, saved.playerIndex, room);
      return true;
    } catch (error) {
      if (error?.code === 'room-not-found') sessions.clear();
      reportError(error);
      return false;
    }
  }

  async function startRound() {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start a round');
    const entries = sortedPlayers(room).slice(0, MAX_PLAYERS);
    if (entries.length < 2) throw new Error('At least two players are required');

    const baseState = rules.createGame(entries.map(([, player]) => ({
      name: player.name,
      emoji: player.emoji,
    })));
    const nextState = {
      ...baseState,
      revision: 0,
      playerSlots: entries.map(([slot]) => slot),
      players: baseState.players.map((player, index) => ({
        ...player,
        slotId: entries[index][0],
      })),
    };
    const validation = rules.validateState(nextState);
    if (!validation?.valid) throw new Error(validation?.error || 'Invalid initial game state');

    const updated = await store.resetRoom({
      state: nextState,
      status: 'active',
      expectedRoster: Object.fromEntries(entries.map(([slot, player]) => [slot, player.uid])),
    });
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

  function flipLocalCard(cardIndex) {
    ensureConnected();
    if (gamePlayerIndex < 0) throw new Error('Player is not seated in the active round');
    return performFlip({ cardIndex, playerIndex: gamePlayerIndex });
  }

  async function disconnectLocal({ suppressErrors = false } = {}) {
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (stopPresence) {
      const stop = stopPresence;
      stopPresence = null;
      try { await stop(); } catch (error) { if (!suppressErrors) reportError(error); }
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
    createRoom,
    joinRoom,
    restoreSession,
    startRound,
    playAgain: startRound,
    removePlayer: removeLobbyPlayer,
    flipCard: flipLocalCard,
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
