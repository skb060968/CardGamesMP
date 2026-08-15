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

export function createGameSessionStore(
  gameId,
  storage = globalThis.localStorage,
  legacyStorage = storage === globalThis.localStorage ? globalThis.sessionStorage : null,
) {
  if (typeof gameId !== 'string' || !ID_PATTERN.test(gameId)) throw new TypeError('Invalid gameId');
  if (!storage || typeof storage.getItem !== 'function') throw new TypeError('Session storage is unavailable');
  const key = `${KEY_PREFIX}${gameId}`;
  const stores = [storage];
  if (legacyStorage && legacyStorage !== storage && typeof legacyStorage.getItem === 'function') {
    stores.push(legacyStorage);
  }
  const removeFrom = (target) => { try { target.removeItem(key); } catch { /* storage may be blocked */ } };
  const clear = () => stores.forEach(removeFrom);
  return {
    load(expected = {}) {
      for (const source of stores) {
        let value;
        try { value = JSON.parse(source.getItem(key)); }
        catch { removeFrom(source); continue; }
        if (value == null) continue;
        if (!validSession(value, gameId) ||
            (expected.roomCode !== undefined && value.roomCode !== expected.roomCode) ||
            (expected.uid !== undefined && value.uid !== expected.uid)) {
          removeFrom(source);
          continue;
        }
        if (source !== storage) {
          try {
            storage.setItem(key, JSON.stringify(value));
            removeFrom(source);
          } catch { /* continue with the valid legacy session */ }
        }
        const { schemaVersion, roomCode, playerIndex, uid } = value;
        return { schemaVersion, gameId, roomCode, playerIndex, uid };
      }
      return null;
    },
    save(value) {
      const candidate = { schemaVersion: SCHEMA_VERSION, gameId, roomCode: value?.roomCode,
        playerIndex: value?.playerIndex, uid: value?.uid };
      if (!validSession(candidate, gameId)) throw new TypeError('Invalid game session');
      storage.setItem(key, JSON.stringify(candidate));
      stores.slice(1).forEach(removeFrom);
      return { ...candidate };
    },
    clear
  };
}

export { SCHEMA_VERSION as GAME_SESSION_SCHEMA_VERSION };
