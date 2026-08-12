export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function normalizeRoomCode(value, name = 'roomCode') {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) {
    throw new TypeError(`${name} must be exactly ${ROOM_CODE_LENGTH} valid letters`);
  }
  return code;
}

export function generateRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join('');
}
