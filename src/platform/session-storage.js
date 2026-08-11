const SCHEMA_VERSION = 1;
const KEY_PREFIX = 'cardgamesmp:session:';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROOM_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const UID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,128}$/;

function validSession(value, gameId) {
  return value !== null && typeof value === 'object' &&
    value.schemaVersion === SCHEMA_VERSION && value.gameId === gameId &&
    typeof value.roomCode === 'string' && ROOM_PATTERN.test(value.roomCode) &&
    Number.isInteger(value.playerIndex) && value.playerIndex >= 0 && value.playerIndex <= 31 &&
    typeof value.uid === 'string' && UID_PATTERN.test(value.uid);
}

export function createGameSessionStore(gameId, storage = globalThis.sessionStorage) {
  if (typeof gameId !== 'string' || !ID_PATTERN.test(gameId)) throw new TypeError('Invalid gameId');
  if (!storage || typeof storage.getItem !== 'function') throw new TypeError('Session storage is unavailable');
  const key = `${KEY_PREFIX}${gameId}`;
  const clear = () => { try { storage.removeItem(key); } catch { /* storage may be blocked */ } };
  return {
    load(expected = {}) {
      try {
        const value = JSON.parse(storage.getItem(key));
        if (!validSession(value, gameId) ||
            (expected.roomCode !== undefined && value.roomCode !== expected.roomCode) ||
            (expected.uid !== undefined && value.uid !== expected.uid)) {
          clear();
          return null;
        }
        const { schemaVersion, roomCode, playerIndex, uid } = value;
        return { schemaVersion, gameId, roomCode, playerIndex, uid };
      } catch { clear(); return null; }
    },
    save(value) {
      const candidate = { schemaVersion: SCHEMA_VERSION, gameId, roomCode: value?.roomCode,
        playerIndex: value?.playerIndex, uid: value?.uid };
      if (!validSession(candidate, gameId)) throw new TypeError('Invalid game session');
      storage.setItem(key, JSON.stringify(candidate));
      return { ...candidate };
    },
    clear
  };
}

export { SCHEMA_VERSION as GAME_SESSION_SCHEMA_VERSION };
