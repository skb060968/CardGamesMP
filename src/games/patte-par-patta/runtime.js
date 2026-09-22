import { createActionCoordinator } from '../../core/action-coordinator.js';
import { firebaseArray } from '../../core/firebase-array.js';
import { generateRoomCode, normalizeRoomCode } from '../../core/room-code.js';
import { createFirebaseRoomStore, isPlayerConnected } from '../../data/firebase-room-store.js';
import { createGameSessionStore } from '../../platform/session-storage.js';
import { createPatteParPattaThrowAction } from './throw-action.js';
import { createPatteParPattaThrowTransitionValidator } from './throw-transition.js';
import { createOutOfTurnTransitionValidator } from '../../shared/out-of-turn-transition.js';
import { createOutOfTurnMoves } from '../../shared/out-of-turn-moves.js';

const GAME_ID = 'patte-par-patta';
const MAX_PLAYERS = 4;

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function waitingState() {
  return {
    status: 'waiting', revision: 0, players: [], playerSlots: [], pile: [],
    currentPlayerIndex: 0, deckSize: 0, winnerIndex: null,
  };
}

function decodeGameState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...source,
    players: firebaseArray(source.players).map((player) => ({
      ...player,
      hand: firebaseArray(player?.hand),
      bounty: firebaseArray(player?.bounty),
    })),
    playerSlots: firebaseArray(source.playerSlots),
    pile: firebaseArray(source.pile),
  };
}

function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.uid)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

/** Drop-at-start (standard): only seats that are connected right now are dealt in. */
function connectedPlayers(room) {
  return sortedPlayers(room).filter(([, player]) => isPlayerConnected(room, player.uid));
}

export function createPatteParPattaRuntime({
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
  requireFunction(effects?.render, 'effects.render');
  requireFunction(roomStoreFactory, 'roomStoreFactory');
  requireFunction(codeGenerator, 'codeGenerator');

  const sessions = createGameSessionStore(GAME_ID, storage);
  // Standard out-of-turn moves (skip / claim) are validated first; a null verdict
  // means "not mine", and the game's own throw validator takes over.
  const validateOutOfTurn = createOutOfTurnTransitionValidator(rules);
  const validateThrow = createPatteParPattaThrowTransitionValidator(rules);
  const validateTransition = (parameters) => validateOutOfTurn(parameters) ?? validateThrow(parameters);
  let state = null;
  let lastMove = null;
  let store = null;
  let roomSlotIndex = -1;
  let gamePlayerIndex = -1;
  let host = false;
  let unsubscribeRoom = null;
  let stopPresence = null;
  let stopReconnectWatch = null;
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

  const coordinator = createActionCoordinator({
    onError: reportError,
    applyRemote: async ({ room, move }, { signal }) => {
      const incoming = room?.game;
      if (!incoming || (state && incoming.revision <= state.revision)) return;
      const previous = state;
      const actor = move?.playerIndex;
      try {
        if (previous && move?.type === 'throw-card' && actor !== gamePlayerIndex) {
          await effects.animateThrow({
            moveId: move.id,
            playerIndex: actor,
            localPlayerIndex: gamePlayerIndex,
            handIndex: move.handIndex,
            card: move.card,
            fromState: previous,
            toState: incoming,
            signal,
          });
          if (move.captured) {
            await effects.animateCapture({
              moveId: move.id,
              playerIndex: actor,
              card: move.card,
              fromState: previous,
              toState: incoming,
              signal,
            });
          }
        }
      } catch (error) {
        reportError(error);
      } finally {
        state = incoming;
        updateIdentity(room);
        try {
          await effects.render({ state, playerIndex: gamePlayerIndex, captured: move?.captured });
        } finally {
          callbacks.onState?.(state, { remote: true, move });
        }
      }
    },
  });

  const sync = {
    commitThrow: (payload) => {
      if (!store) throw new Error('Room is not connected');
      return store.commitThrow(payload);
    },
  };
  const performThrow = createPatteParPattaThrowAction({
    coordinator,
    rules,
    sync,
    effects,
    getState: () => state,
    setState: (nextState) => { state = nextState; callbacks.onState?.(state, { remote: false }); },
  });

  const makeStore = (roomCode) => roomStoreFactory({
    database,
    gameId: GAME_ID,
    roomCode: normalizeRoomCode(roomCode),
    playerUid: uid,
    maxPlayers: MAX_PLAYERS,
    decodeState: decodeGameState,
    generateRoomCode: codeGenerator,
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

  async function refreshRoom(move = null, { forceSnapshot = false } = {}) {
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
    lastMove = room.lastMove ?? null;
    if (room.meta?.status === 'active' && room.game) {
      if (move?.id) {
        await coordinator.acceptRemote({ moveId: move.id, room, move });
      } else if (
        forceSnapshot
        || !state
        || room.game.revision !== state.revision
        || room.game.status !== state.status
      ) {
        state = room.game;
        await effects.render({ state, playerIndex: gamePlayerIndex });
        callbacks.onState?.(state, { remote: true, move: null });
      }
      // In-game presence (standard): the room snapshot carries `presence`, so
      // the shell can grey out seats that have dropped mid-round.
      callbacks.onPresence?.({ room, state });
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
      onReset: () => enqueue(() => refreshRoom(null, { forceSnapshot: true })),
      onPresence: () => enqueue(() => refreshRoom()),
      onPlayer: queueRosterRefresh,
      onError: reportError,
    });
    stopPresence = store.startPresence({ playerIndex: roomSlotIndex, onError: reportError });
    // Reconnect reconcile (standard): after an outage, re-read the room and
    // force a full render even if the revision looks unchanged.
    stopReconnectWatch = store.watchReconnect(() => enqueue(() => refreshRoom(null, { forceSnapshot: true })));

    callbacks.onConnected?.({
      roomCode: store.roomCode,
      roomSlotIndex,
      gamePlayerIndex,
      isHost: host,
      room,
    });
    if (room.meta?.status === 'active') {
      await effects.render({ state, playerIndex: gamePlayerIndex });
      callbacks.onState?.(state, { remote: true, restored: true });
      callbacks.onPresence?.({ room, state });
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
    const activeStore = makeStore(roomCode);
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

  async function startRound({ deckCount = 1 } = {}) {
    ensureConnected();
    const room = await store.readRoom();
    if (room.meta?.hostUid !== uid) throw new Error('Only the host can start a round');
    const entries = connectedPlayers(room).slice(0, MAX_PLAYERS);
    if (entries.length < 2) throw new Error('At least two connected players are required');

    const baseState = rules.createGame(entries.map(([, player]) => ({
      name: player.name,
      emoji: player.emoji,
    })), deckCount);
    const nextState = {
      ...baseState,
      revision: 0,
      playerSlots: entries.map(([slot]) => slot),
      players: baseState.players.map((player, index) => ({
        ...player,
        slotId: entries[index][0],
      })),
    };
    const updated = await store.resetRoom({
      state: nextState,
      status: 'active',
      // The roster guard covers every seat (offline ones stay seated, they just
      // sit this round out), so it is built from the full player list.
      expectedRoster: Object.fromEntries(sortedPlayers(room).map(([slot, player]) => [slot, player.uid])),
    });
    state = updated.game;
    updateIdentity(updated);
    await effects.render({ state, playerIndex: gamePlayerIndex });
    callbacks.onState?.(state, { remote: false, newRound: true });
    callbacks.onPresence?.({ room: updated, state });
    return state;
  }

  /**
   * Play Again (standard): the host sends the whole table back to the lobby
   * instead of dealing straight away, so latecomers can join with the same
   * code. Every client's status listener routes to `onLobby`.
   */
  async function returnToLobby() {
    ensureConnected();
    const room = await store.readRoom();
    // Host, or (host-loss inheritance) the first connected seat while the host is offline.
    if (room.meta?.hostUid !== uid && !store.canActForOfflineHost(room)) {
      throw new Error('Only the host can start another round');
    }
    if (room.game?.status !== 'finished') throw new Error('The current round is not finished');
    const updated = await store.resetRoom({ state: waitingState(), status: 'waiting' });
    state = updated.game;
    updateIdentity(updated);
    callbacks.onLobby?.({ room: updated, roomCode: store.roomCode, isHost: host, roomSlotIndex });
    return updated;
  }

  // Standard out-of-turn moves: watchdog skip + last-player claim.
  const outOfTurn = createOutOfTurnMoves({
    rules,
    getStore: () => store,
    getState: () => state,
    getActorIndex: () => gamePlayerIndex,
    afterCommit: () => enqueue(() => refreshRoom()),
  });

  /**
   * Leave a running round without giving up the seat (standard): presence is
   * dropped so the others see the seat go OFF and the watchdog skips it; the
   * room survives and the seat can be dealt back in after a Play Again.
   */
  async function leaveSeat() {
    ensureConnected();
    const activeStore = store;
    await disconnectLocal();
    try { await activeStore.markSelfOffline(); } catch (error) { reportError(error); }
    sessions.clear();
    disposed = true;
    coordinator.dispose();
    callbacks.onDisconnected?.({ deleted: false, leftSeat: true });
  }

  async function removeLobbyPlayer({ playerIndex, expectedUid }) {
    ensureConnected();
    if (!host) throw new Error('Only the host can remove a player');
    const result = await store.removePlayer({ playerIndex, expectedUid });
    await refreshRoom();
    return result;
  }

  async function throwLocalCard(handIndex = 0) {
    ensureConnected();
    if (gamePlayerIndex < 0) throw new Error('Player is not seated in the active round');
    return performThrow({ handIndex, playerIndex: gamePlayerIndex });
  }

  async function disconnectLocal({ suppressErrors = false } = {}) {
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (stopReconnectWatch) { stopReconnectWatch(); stopReconnectWatch = null; }
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
    playAgain: returnToLobby,
    removePlayer: removeLobbyPlayer,
    throwCard: throwLocalCard,
    skipStalledTurn: outOfTurn.skipStalledTurn,
    claimWin: outOfTurn.claimWin,
    leaveSeat,
    canActForOfflineHost: (room) => Boolean(store?.canActForOfflineHost(room)),
    leaveRoom,
    close,
    refresh: () => refreshRoom(),
    get roomCode() { return store?.roomCode || null; },
    get currentState() { return state; },
    get lastMove() { return lastMove; },
    get playerSlotIndex() { return roomSlotIndex; },
    get playerIndex() { return gamePlayerIndex; },
    get isHost() { return host; },
    get connected() { return Boolean(store) && !disposed; },
    get busy() { return coordinator.busy; },
  });
}