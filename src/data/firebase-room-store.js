import {
  get as firebaseGet,
  onDisconnect as firebaseOnDisconnect,
  onValue as firebaseOnValue,
  ref as firebaseRef,
  runTransaction as firebaseRunTransaction,
  set as firebaseSet,
} from 'firebase/database';
import { generateRoomCode as defaultRoomCodeGenerator } from '../core/room-code.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const SLOT_COUNT = 6;

export class RoomLifecycleError extends Error {
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = 'RoomLifecycleError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class RoomCommitError extends RoomLifecycleError {
  constructor(code, message = code, options) {
    super(code, message, options);
    this.name = 'RoomCommitError';
  }
}

export class RoomCollisionError extends RoomLifecycleError {
  constructor(code = 'room-code-collision', message = 'No unique room code could be reserved', options) {
    super(code, message, options);
    this.name = 'RoomCollisionError';
  }
}

export class RoomNotFoundError extends RoomLifecycleError {
  constructor(message = 'Room not found') {
    super('room-not-found', message);
    this.name = 'RoomNotFoundError';
  }
}
export class RoomCapacityError extends RoomLifecycleError {
  constructor(message = 'Room has no available player slots') {
    super('room-full', message);
    this.name = 'RoomCapacityError';
  }
}

export class RoomOwnershipError extends RoomLifecycleError {
  constructor(code = 'player-identity-mismatch', message = 'The authenticated UID does not own this resource') {
    super(code, message);
    this.name = 'RoomOwnershipError';
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function requireToken(value, name) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new TypeError(`${name} contains unsupported Firebase path characters`);
  }
}

function requireIdentity(value, name = 'playerUid') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new TypeError(`${name} must be a non-empty string of at most 128 characters`);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function cloneFirebaseValue(value, name) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`${name} is not serializable`);
  return JSON.parse(json);
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

function readVerdict(verdict) {
  if (verdict?.then) return { valid: false, reason: 'async-transition-validator' };
  if (verdict === true) return { valid: true };
  if (verdict === false) return { valid: false, reason: 'invalid-transition' };
  return verdict?.valid ? { valid: true } : {
    valid: false,
    reason: verdict?.reason || 'invalid-transition',
  };
}

function slotId(index) {
  return `player_${index}`;
}

function uidPathKey(uid) {
  return Array.from(uid, (character) => character.codePointAt(0).toString(16)).join('-');
}

function cleanPlayerData(player) {
  requireObject(player, 'player');
  const copy = cloneFirebaseValue(player, 'player');
  delete copy.uid;
  delete copy.index;
  delete copy.slotId;
  delete copy.isHost;
  delete copy.joinedAt;
  return copy;
}

function lifecycleError(error, operation) {
  if (error instanceof RoomLifecycleError || error instanceof TypeError) return error;
  return new RoomLifecycleError(
    'firebase-operation-failed',
    `${operation} failed`,
    { cause: error, details: { operation } },
  );
}

export function createFirebaseRoomStore({
  database,
  namespace = 'card-games-mp',
  gameId,
  roomCode,
  playerUid,
  maxPlayers = SLOT_COUNT,
  encodeState = (state) => state,
  decodeState = (state) => state,
  validateTransition = () => ({ valid: false, reason: 'transition-validator-required' }),
  now = Date.now,
  generateRoomCode = defaultRoomCodeGenerator,
  api = {},
}) {
  const makeRef = api.ref || firebaseRef;
  const transact = api.runTransaction || firebaseRunTransaction;
  const readValue = api.get || firebaseGet;
  const listenValue = api.onValue || firebaseOnValue;
  const disconnectAt = api.onDisconnect || firebaseOnDisconnect;
  const writeValue = api.set || firebaseSet;
  requireFunction(makeRef, 'api.ref');
  requireFunction(transact, 'api.runTransaction');
  requireFunction(readValue, 'api.get');
  requireFunction(listenValue, 'api.onValue');
  requireFunction(disconnectAt, 'api.onDisconnect');
  requireFunction(writeValue, 'api.set');
  requireFunction(encodeState, 'encodeState');
  requireFunction(decodeState, 'decodeState');
  requireFunction(validateTransition, 'validateTransition');
  requireFunction(now, 'now');
  requireFunction(generateRoomCode, 'generateRoomCode');
  requireToken(namespace, 'namespace');
  requireToken(gameId, 'gameId');
  requireToken(roomCode, 'roomCode');
  requireIdentity(playerUid);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > SLOT_COUNT) {
    throw new TypeError(`maxPlayers must be an integer from 1 through ${SLOT_COUNT}`);
  }

  let selectedRoomCode = roomCode;
  const basePath = `${namespace}/rooms/${gameId}`;
  const roomPath = (code = selectedRoomCode) => `${basePath}/${code}`;
  const roomRef = (code = selectedRoomCode) => makeRef(database, roomPath(code));
  const childRef = (path) => makeRef(database, `${roomPath()}/${path}`);

  async function primeExistingRoom(operation) {
    let unsubscribe = null;
    let timer = null;
    let settled = false;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
    };

    try {
      const value = await new Promise((resolve, reject) => {
        const finish = (callback, result) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          callback(result);
        };
        timer = setTimeout(() => finish(
          reject,
          new RoomLifecycleError('room-sync-timeout', `${operation} could not load the room`),
        ), 10000);
        unsubscribe = listenValue(
          roomRef(),
          (snapshot) => finish(resolve, snapshot.val()),
          (error) => finish(reject, lifecycleError(error, operation)),
        );
      });
      if (!value) {
        cleanup();
        throw new RoomNotFoundError();
      }
      return cleanup;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async function transactExistingRoom(operation, update) {
    requireFunction(update, 'transaction update');
    const stopPriming = await primeExistingRoom(operation);
    try {
      return await transact(roomRef(), update, { applyLocally: false });
    } finally {
      stopPriming();
    }
  }

  function encodeGame(state) {
    const encoded = cloneFirebaseValue(encodeState(state), 'state');
    let decoded;
    try {
      decoded = decodeState(encoded);
    } catch (error) {
      throw new TypeError(`state could not be decoded: ${error?.message || 'unknown error'}`);
    }
    if (!Number.isSafeInteger(decoded?.revision) || decoded.revision < 0) {
      throw new TypeError('state.revision must be a non-negative safe integer');
    }
    return encoded;
  }

  function decodeRoom(currentRoom) {
    if (!currentRoom) return null;
    try {
      return { ...currentRoom, game: decodeState(currentRoom.game) };
    } catch (error) {
      throw new RoomLifecycleError('invalid-current-state', 'Stored game state could not be decoded', { cause: error });
    }
  }

  function createPlayer(player, index, joinedAt, isHost = false) {
    return {
      ...cleanPlayerData(player),
      uid: playerUid,
      index,
      slotId: slotId(index),
      isHost,
      joinedAt,
    };
  }

  async function createRoom({
    state,
    player = {},
    status = 'waiting',
    maxAttempts = 8,
    generateCode = generateRoomCode,
  } = {}) {
    requireToken(status, 'status');
    requireFunction(generateCode, 'generateCode');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new TypeError('maxAttempts must be an integer between 1 and 100');
    }
    const encodedState = encodeGame(state);
    const createdAt = now();
    const host = createPlayer(player, 0, createdAt, true);
    let candidate = selectedRoomCode;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        candidate = generateCode({ attempt, previousCode: candidate });
        requireToken(candidate, 'generated roomCode');
      }
      const initialRoom = {
        meta: {
          hostUid: playerUid,
          hostSlot: 'player_0',
          status,
          createdAt,
          lastActivity: createdAt,
        },
        players: { player_0: host },
        game: encodedState,
      };
      let result;
      try {
        result = await transact(roomRef(candidate), (currentRoom) => (
          currentRoom == null ? initialRoom : undefined
        ), { applyLocally: false });
      } catch (error) {
        throw lifecycleError(error, 'create-room');
      }
      if (result.committed) {
        selectedRoomCode = candidate;
        return {
          roomCode: candidate,
          path: roomPath(),
          playerIndex: 0,
          slotId: 'player_0',
          room: decodeRoom(result.snapshot.val()),
        };
      }
    }

    throw new RoomCollisionError(
      'room-code-collision-limit',
      `Unable to reserve a room code after ${maxAttempts} attempts`,
      { details: { attempts: maxAttempts } },
    );
  }

  async function joinRoom({ player = {} } = {}) {
    const joinedAt = now();
    const safePlayer = cleanPlayerData(player);
    let initialRoom;
    try {
      initialRoom = (await readValue(roomRef())).val();
    } catch (error) {
      throw lifecycleError(error, 'join-room-read');
    }
    if (!initialRoom) throw new RoomNotFoundError();
    if (initialRoom.meta?.status === 'closed') {
      throw new RoomLifecycleError('room-closed', 'Join rejected: room-closed');
    }

    const existingPlayers = initialRoom.players || {};
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      if (existingPlayers[slotId(index)]?.uid === playerUid) {
        return {
          playerIndex: index,
          slotId: slotId(index),
          idempotent: true,
          room: decodeRoom(initialRoom),
        };
      }
    }
    if (initialRoom.meta?.status !== 'waiting' && initialRoom.meta?.status !== 'lobby') {
      throw new RoomLifecycleError('room-not-joinable', 'Join rejected: room-not-joinable');
    }

    for (let index = 0; index < maxPlayers; index += 1) {
      const key = slotId(index);
      if (existingPlayers[key]) continue;
      const candidate = {
        ...safePlayer,
        uid: playerUid,
        index,
        slotId: key,
        isHost: false,
        joinedAt,
      };
      let result;
      try {
        // Claim only one stable slot. A null initial transaction value is
        // correct for an empty slot and no longer gets confused with a
        // missing whole room. Concurrent claimers are retried by Firebase.
        result = await transact(childRef(`players/${key}`), (currentPlayer) => (
          currentPlayer == null ? candidate : undefined
        ), { applyLocally: false });
      } catch (error) {
        throw lifecycleError(error, 'join-room-slot');
      }
      if (!result.committed) continue;

      const room = await readRoom();
      if (room.players?.[key]?.uid !== playerUid) {
        throw new RoomOwnershipError('slot-claim-lost', 'Joined slot ownership could not be confirmed');
      }
      return {
        playerIndex: index,
        slotId: key,
        idempotent: false,
        room,
      };
    }

    // A concurrent request from this same UID may have claimed a slot while
    // this request was trying another one. Re-read before reporting capacity.
    const latestRoom = await readRoom();
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      if (latestRoom.players?.[slotId(index)]?.uid === playerUid) {
        return {
          playerIndex: index,
          slotId: slotId(index),
          idempotent: true,
          room: latestRoom,
        };
      }
    }
    throw new RoomCapacityError();
  }

  async function readRoom() {
    try {
      const snapshot = await readValue(roomRef());
      const value = snapshot.val();
      if (!value) throw new RoomNotFoundError();
      return decodeRoom(value);
    } catch (error) {
      throw lifecycleError(error, 'read-room');
    }
  }

  function subscribeRoom(handlers, onError) {
    if (typeof handlers !== 'function') requireObject(handlers, 'handlers');
    if (onError !== undefined) requireFunction(onError, 'onError');
    let stopped = false;
    const seen = new Map();
    const emitError = (error) => {
      if (stopped) return;
      const typed = lifecycleError(error, 'subscribe-room');
      if (typeof handlers === 'object' && typeof handlers.onError === 'function') handlers.onError(typed);
      else if (onError) onError(typed);
    };
    const emit = (event) => {
      if (stopped) return;
      if (typeof handlers === 'function') { handlers(event); return; }
      const callback = {
        revision: handlers.onRevision,
        move: handlers.onMove,
        status: handlers.onStatus,
        player: handlers.onPlayer,
      }[event.type];
      if (typeof callback === 'function') callback(event.value, event);
    };
    const listeners = [
      ['game', 'revision'],
      ['lastMove', 'move'],
      ['meta/status', 'status'],
      ...Array.from({ length: SLOT_COUNT }, (_, index) => [`players/${slotId(index)}`, 'player', index]),
    ];
    const unsubscribers = listeners.map(([path, type, playerIndex]) => listenValue(
      childRef(path),
      (snapshot) => {
        let value = snapshot.val();
        if (type === 'revision' && value !== null) {
          try {
            value = decodeState(value)?.revision ?? null;
          } catch (error) {
            emitError(new RoomLifecycleError(
              'invalid-current-state',
              'Subscribed game state could not be decoded',
              { cause: error },
            ));
            return;
          }
        }
        const seenKey = type === 'player' ? `${type}:${playerIndex}` : type;
        if (seen.has(seenKey) && sameValue(seen.get(seenKey), value)) return;
        seen.set(seenKey, cloneFirebaseValue(value, `${type} subscription value`));
        emit({
          type,
          value,
          ...(type === 'player' ? { playerIndex, slotId: slotId(playerIndex) } : {}),
        });
      },
      emitError,
    ));
    return () => {
      if (stopped) return;
      stopped = true;
      for (const unsubscribe of unsubscribers) if (typeof unsubscribe === 'function') unsubscribe();
    };
  }

  async function requireOwnedSlot(requestedIndex) {
    const room = await readRoom();
    if (requestedIndex !== undefined) {
      if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= SLOT_COUNT) {
        throw new TypeError('playerIndex must be an integer from 0 through 5');
      }
      if (room.players?.[slotId(requestedIndex)]?.uid !== playerUid) throw new RoomOwnershipError();
      return requestedIndex;
    }
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      if (room.players?.[slotId(index)]?.uid === playerUid) return index;
    }
    throw new RoomOwnershipError('player-not-joined', 'UID does not own a slot in this room');
  }

  function startPresence({ playerIndex, connectionId = defaultRoomCodeGenerator(), onError } = {}) {
    requireToken(connectionId, 'connectionId');
    if (onError !== undefined) requireFunction(onError, 'onError');
    let stopped = false;
    let generation = 0;
    let disconnectOperation = null;
    let connectionReference = null;
    let sequence = Promise.resolve();
    const connectedReference = makeRef(database, '.info/connected');
    const reportError = (error) => {
      const callback = onError || api.onPresenceError;
      if (typeof callback === 'function') callback(lifecycleError(error, 'presence'));
    };

    const unsubscribe = listenValue(connectedReference, (snapshot) => {
      if (stopped || snapshot.val() !== true) return;
      const currentGeneration = ++generation;
      sequence = sequence.then(async () => {
        if (stopped || currentGeneration !== generation) return;
        const ownedIndex = await requireOwnedSlot(playerIndex);
        if (stopped || currentGeneration !== generation) return;
        connectionReference = childRef(`presence/${uidPathKey(playerUid)}/${connectionId}`);
        const operation = disconnectAt(connectionReference);
        disconnectOperation = operation;
        await operation.remove();
        if (stopped || currentGeneration !== generation) {
          await operation.cancel();
          return;
        }
        await writeValue(connectionReference, {
          uid: playerUid,
          playerIndex: ownedIndex,
          slotId: slotId(ownedIndex),
          connectedAt: now(),
        });
      }).catch(reportError);
    }, reportError);

    return async () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      if (typeof unsubscribe === 'function') unsubscribe();
      await sequence.catch(() => {});
      try {
        if (disconnectOperation) await disconnectOperation.cancel();
        if (connectionReference) await writeValue(connectionReference, null);
      } catch (error) {
        throw lifecycleError(error, 'stop-presence');
      }
    };
  }

  async function leaveRoom({ playerIndex } = {}) {
    if (playerIndex !== undefined && (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= SLOT_COUNT)) {
      throw new TypeError('playerIndex must be an integer from 0 through 5');
    }
    let rejectionCode = 'transaction-aborted';
    let removedIndex = -1;
    let result;
    try {
      result = await transactExistingRoom('leave-room', (currentRoom) => {
        rejectionCode = 'transaction-aborted';
        removedIndex = -1;
        if (!currentRoom) { rejectionCode = 'room-not-found'; return undefined; }
        const players = currentRoom.players || {};
        if (playerIndex !== undefined) {
          if (players[slotId(playerIndex)]?.uid !== playerUid) {
            rejectionCode = 'player-identity-mismatch';
            return undefined;
          }
          removedIndex = playerIndex;
        } else {
          for (let index = 0; index < SLOT_COUNT; index += 1) {
            if (players[slotId(index)]?.uid === playerUid) { removedIndex = index; break; }
          }
          if (removedIndex < 0) { rejectionCode = 'player-not-joined'; return undefined; }
        }
        const nextPlayers = { ...players };
        delete nextPlayers[slotId(removedIndex)];
        const nextPresence = { ...(currentRoom.presence || {}) };
        delete nextPresence[uidPathKey(playerUid)];
        return {
          ...currentRoom,
          players: nextPlayers,
          presence: nextPresence,
          meta: { ...currentRoom.meta, lastActivity: now() },
        };
      });
    } catch (error) {
      throw lifecycleError(error, 'leave-room');
    }
    if (!result.committed) {
      if (rejectionCode === 'room-not-found') throw new RoomNotFoundError();
      throw new RoomOwnershipError(rejectionCode, `Leave rejected: ${rejectionCode}`);
    }
    return { playerIndex: removedIndex, slotId: slotId(removedIndex), room: decodeRoom(result.snapshot.val()) };
  }

  async function removePlayer({ playerIndex, expectedUid } = {}) {
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= SLOT_COUNT) {
      throw new TypeError('playerIndex must be an integer from 0 through 5');
    }
    requireIdentity(expectedUid, 'expectedUid');

    const key = slotId(playerIndex);
    let rejectionCode = 'transaction-aborted';
    let result;
    try {
      result = await transactExistingRoom('remove-player', (currentRoom) => {
        rejectionCode = 'transaction-aborted';
        if (!currentRoom) { rejectionCode = 'room-not-found'; return undefined; }
        if (currentRoom.meta?.hostUid !== playerUid) {
          rejectionCode = 'host-identity-mismatch';
          return undefined;
        }
        if (currentRoom.meta?.status !== 'waiting') {
          rejectionCode = 'room-not-waiting';
          return undefined;
        }
        const target = currentRoom.players?.[key];
        if (!target) { rejectionCode = 'player-not-found'; return undefined; }
        if (target.uid !== expectedUid) {
          rejectionCode = 'player-identity-mismatch';
          return undefined;
        }
        if (key === currentRoom.meta?.hostSlot || target.uid === currentRoom.meta?.hostUid || target.isHost === true) {
          rejectionCode = 'cannot-remove-host';
          return undefined;
        }

        const nextPlayers = { ...(currentRoom.players || {}) };
        delete nextPlayers[key];
        const nextPresence = { ...(currentRoom.presence || {}) };
        delete nextPresence[uidPathKey(target.uid)];
        return {
          ...currentRoom,
          players: nextPlayers,
          presence: nextPresence,
          meta: { ...currentRoom.meta, lastActivity: now() },
        };
      });
    } catch (error) {
      throw lifecycleError(error, 'remove-player');
    }

    if (!result.committed) {
      if (rejectionCode === 'room-not-found') throw new RoomNotFoundError();
      if (rejectionCode === 'host-identity-mismatch') {
        throw new RoomOwnershipError(rejectionCode, `Remove rejected: ${rejectionCode}`);
      }
      throw new RoomLifecycleError(rejectionCode, `Remove rejected: ${rejectionCode}`);
    }
    return {
      playerIndex,
      slotId: key,
      uid: expectedUid,
      room: decodeRoom(result.snapshot.val()),
    };
  }

  async function deleteRoom() {
    let rejectionCode = 'transaction-aborted';
    let result;
    try {
      result = await transactExistingRoom('delete-room', (currentRoom) => {
        if (!currentRoom) { rejectionCode = 'room-not-found'; return undefined; }
        if (currentRoom.meta?.hostUid !== playerUid) {
          rejectionCode = 'host-identity-mismatch';
          return undefined;
        }
        return null;
      });
    } catch (error) {
      throw lifecycleError(error, 'delete-room');
    }
    if (!result.committed) {
      if (rejectionCode === 'room-not-found') throw new RoomNotFoundError();
      throw new RoomOwnershipError(rejectionCode, `Delete rejected: ${rejectionCode}`);
    }
    return { roomCode: selectedRoomCode, deleted: true };
  }

  async function resetRoom({ state, status = 'waiting', expectedRoster = null } = {}) {
    requireToken(status, 'status');
    let safeRoster = null;
    if (expectedRoster !== null) {
      requireObject(expectedRoster, 'expectedRoster');
      safeRoster = cloneFirebaseValue(expectedRoster, 'expectedRoster');
      for (const [key, uid] of Object.entries(safeRoster)) {
        if (!/^player_[0-5]$/.test(key)) throw new TypeError(`Invalid expected roster slot: ${key}`);
        requireIdentity(uid, `expectedRoster.${key}`);
      }
    }
    const encodedState = encodeGame(state);
    const resetAt = now();
    let rejectionCode = 'transaction-aborted';
    let result;
    try {
      result = await transactExistingRoom('reset-room', (currentRoom) => {
        rejectionCode = 'transaction-aborted';
        if (!currentRoom) { rejectionCode = 'room-not-found'; return undefined; }
        if (currentRoom.meta?.hostUid !== playerUid) {
          rejectionCode = 'host-identity-mismatch';
          return undefined;
        }
        if (safeRoster !== null) {
          const currentRoster = {};
          for (let index = 0; index < SLOT_COUNT; index += 1) {
            const key = slotId(index);
            const uid = currentRoom.players?.[key]?.uid;
            if (uid) currentRoster[key] = uid;
          }
          if (!sameValue(currentRoster, safeRoster)) {
            rejectionCode = 'roster-conflict';
            return undefined;
          }
        }
        return {
          ...currentRoom,
          game: encodedState,
          lastMove: null,
          presence: {},
          meta: {
            ...currentRoom.meta,
            status,
            resetAt,
            lastActivity: resetAt,
          },
        };
      });
    } catch (error) {
      throw lifecycleError(error, 'reset-room');
    }
    if (!result.committed) {
      if (rejectionCode === 'room-not-found') throw new RoomNotFoundError();
      if (rejectionCode === 'host-identity-mismatch') {
        throw new RoomOwnershipError(rejectionCode, `Reset rejected: ${rejectionCode}`);
      }
      throw new RoomLifecycleError(rejectionCode, `Reset rejected: ${rejectionCode}`);
    }
    return decodeRoom(result.snapshot.val());
  }

  async function commitThrow({
    moveId,
    expectedRevision,
    playerIndex,
    handIndex,
    card,
    captured,
    state,
  }) {
    requireToken(moveId, 'moveId');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative safe integer');
    }
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= SLOT_COUNT) {
      throw new TypeError('playerIndex must be an integer from 0 through 5');
    }
    if (!Number.isInteger(handIndex) || handIndex < 0) throw new TypeError('Invalid handIndex');
    if (typeof captured !== 'boolean') throw new TypeError('captured must be boolean');

    const encodedNextState = encodeGame(state);
    const nextState = decodeState(encodedNextState);
    const actionCard = cloneFirebaseValue(card, 'card');
    if (nextState.revision !== expectedRevision + 1) {
      throw new RoomCommitError('invalid-next-revision');
    }

    const action = { moveId, expectedRevision, playerIndex, handIndex, card: actionCard, captured };
    const commitTime = now();
    let rejectionCode = 'transaction-aborted';
    let idempotent = false;
    let result;

    try {
      result = await transactExistingRoom('commit-throw', (currentRoom) => {
        rejectionCode = 'transaction-aborted';
        idempotent = false;
        if (!currentRoom) { rejectionCode = 'room-not-found'; return undefined; }

        const previousMove = currentRoom.lastMove;
        if (previousMove?.id === moveId) {
          const sameMove = previousMove.playerIndex === playerIndex
            && previousMove.handIndex === handIndex
            && previousMove.expectedRevision === expectedRevision
            && previousMove.captured === captured
            && sameValue(previousMove.card, actionCard)
            && sameValue(currentRoom.game, encodedNextState);
          if (!sameMove) { rejectionCode = 'move-id-collision'; return undefined; }
          idempotent = true;
          return currentRoom;
        }

        if (currentRoom.meta?.status !== 'active') {
          rejectionCode = 'room-not-active';
          return undefined;
        }
        let currentState;
        try {
          currentState = decodeState(currentRoom.game);
        } catch (_) {
          rejectionCode = 'invalid-current-state';
          return undefined;
        }
        const mappedSlot = currentState?.playerSlots?.[playerIndex]
          || currentState?.players?.[playerIndex]?.slotId
          || slotId(playerIndex);
        if (!Array.from({ length: SLOT_COUNT }, (_, index) => slotId(index)).includes(mappedSlot)) {
          rejectionCode = 'invalid-player-slot';
          return undefined;
        }
        const player = currentRoom.players?.[mappedSlot];
        if (!player || player.uid !== playerUid) {
          rejectionCode = 'player-identity-mismatch';
          return undefined;
        }
        if (currentState?.revision !== expectedRevision) {
          rejectionCode = 'revision-conflict';
          return undefined;
        }
        if (currentState.currentPlayerIndex !== playerIndex) {
          rejectionCode = 'wrong-turn';
          return undefined;
        }

        let verdict;
        try {
          verdict = readVerdict(validateTransition({ currentState, nextState, action }));
        } catch (_) {
          verdict = { valid: false, reason: 'transition-validator-failed' };
        }
        if (!verdict.valid) {
          rejectionCode = verdict.reason;
          return undefined;
        }

        return {
          ...currentRoom,
          game: encodedNextState,
          lastMove: {
            id: moveId,
            type: 'throw-card',
            expectedRevision,
            revision: nextState.revision,
            playerIndex,
            handIndex,
            card: actionCard,
            captured,
            createdAt: commitTime,
          },
          meta: {
            ...currentRoom.meta,
            status: 'active',
            lastActivity: commitTime,
          },
        };
      });
    } catch (error) {
      if (error instanceof RoomLifecycleError) {
        throw new RoomCommitError(error.code, `Throw commit failed: ${error.code}`, { cause: error });
      }
      throw new RoomCommitError('firebase-operation-failed', 'Throw commit failed', { cause: error });
    }

    if (!result.committed) {
      throw new RoomCommitError(rejectionCode, `Throw commit rejected: ${rejectionCode}`);
    }
    const committedRoom = result.snapshot.val();
    if (!committedRoom?.game) throw new RoomCommitError('missing-committed-state');

    return {
      state: decodeState(committedRoom.game),
      move: committedRoom.lastMove,
      idempotent,
    };
  }

  async function commitFlip({
    moveId,
    expectedRevision,
    playerIndex,
    cardIndex,
    card,
    matched,
    matchedIndex,
    state,
  }) {
    requireToken(moveId, 'moveId');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative safe integer');
    }
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= SLOT_COUNT) {
      throw new TypeError('playerIndex must be an integer from 0 through 5');
    }
    if (!Number.isInteger(cardIndex) || cardIndex < 0) throw new TypeError('Invalid cardIndex');
    if (typeof matched !== 'boolean') throw new TypeError('matched must be boolean');
    if (matched) {
      if (!Number.isInteger(matchedIndex) || matchedIndex < 0 || matchedIndex === cardIndex) {
        throw new TypeError('Invalid matchedIndex');
      }
    } else if (matchedIndex !== null) {
      throw new TypeError('matchedIndex must be null when no pair was matched');
    }

    const encodedNextState = encodeGame(state);
    const nextState = decodeState(encodedNextState);
    const actionCard = cloneFirebaseValue(card, 'card');
    if (nextState.revision !== expectedRevision + 1) {
      throw new RoomCommitError('invalid-next-revision');
    }

    const action = {
      moveId, expectedRevision, playerIndex, cardIndex,
      card: actionCard, matched, matchedIndex,
    };
    const commitTime = now();
    let rejectionCode = 'transaction-aborted';
    let idempotent = false;
    let result;

    try {
      result = await transactExistingRoom('commit-flip', (currentRoom) => {
        rejectionCode = 'transaction-aborted';
        idempotent = false;
        if (!currentRoom) { rejectionCode = 'room-not-found'; return undefined; }

        const previousMove = currentRoom.lastMove;
        if (previousMove?.id === moveId) {
          const sameMove = previousMove.type === 'flip-card'
            && previousMove.playerIndex === playerIndex
            && previousMove.cardIndex === cardIndex
            && previousMove.expectedRevision === expectedRevision
            && previousMove.matched === matched
            && (matched
              ? previousMove.matchedIndex === matchedIndex
              : previousMove.matchedIndex == null)
            && sameValue(previousMove.card, actionCard)
            && sameValue(currentRoom.game, encodedNextState);
          if (!sameMove) { rejectionCode = 'move-id-collision'; return undefined; }
          idempotent = true;
          return currentRoom;
        }

        if (currentRoom.meta?.status !== 'active') {
          rejectionCode = 'room-not-active';
          return undefined;
        }
        let currentState;
        try {
          currentState = decodeState(currentRoom.game);
        } catch (_) {
          rejectionCode = 'invalid-current-state';
          return undefined;
        }
        const mappedSlot = currentState?.playerSlots?.[playerIndex]
          || currentState?.players?.[playerIndex]?.slotId
          || slotId(playerIndex);
        if (!Array.from({ length: SLOT_COUNT }, (_, index) => slotId(index)).includes(mappedSlot)) {
          rejectionCode = 'invalid-player-slot';
          return undefined;
        }
        const player = currentRoom.players?.[mappedSlot];
        if (!player || player.uid !== playerUid) {
          rejectionCode = 'player-identity-mismatch';
          return undefined;
        }
        if (currentState?.revision !== expectedRevision) {
          rejectionCode = 'revision-conflict';
          return undefined;
        }
        if (currentState.currentPlayerIndex !== playerIndex) {
          rejectionCode = 'wrong-turn';
          return undefined;
        }

        let verdict;
        try {
          verdict = readVerdict(validateTransition({ currentState, nextState, action }));
        } catch (_) {
          verdict = { valid: false, reason: 'transition-validator-failed' };
        }
        if (!verdict.valid) {
          rejectionCode = verdict.reason;
          return undefined;
        }

        return {
          ...currentRoom,
          game: encodedNextState,
          lastMove: {
            id: moveId,
            type: 'flip-card',
            expectedRevision,
            revision: nextState.revision,
            playerIndex,
            cardIndex,
            card: actionCard,
            matched,
            matchedIndex,
            createdAt: commitTime,
          },
          meta: {
            ...currentRoom.meta,
            status: 'active',
            lastActivity: commitTime,
          },
        };
      });
    } catch (error) {
      if (error instanceof RoomLifecycleError) {
        throw new RoomCommitError(error.code, `Flip commit failed: ${error.code}`, { cause: error });
      }
      throw new RoomCommitError('firebase-operation-failed', 'Flip commit failed', { cause: error });
    }

    if (!result.committed) {
      throw new RoomCommitError(rejectionCode, `Flip commit rejected: ${rejectionCode}`);
    }
    const committedRoom = result.snapshot.val();
    if (!committedRoom?.game) throw new RoomCommitError('missing-committed-state');

    return {
      state: decodeState(committedRoom.game),
      move: committedRoom.lastMove,
      idempotent,
    };
  }

  return Object.freeze({
    get path() { return roomPath(); },
    get roomCode() { return selectedRoomCode; },
    slotCount: SLOT_COUNT,
    maxPlayers,
    createRoom,
    joinRoom,
    readRoom,
    subscribeRoom,
    startPresence,
    leaveRoom,
    removePlayer,
    deleteRoom,
    resetRoom,
    commitThrow,
    commitFlip,
  });
}
