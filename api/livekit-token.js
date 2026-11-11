import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AccessToken } from 'livekit-server-sdk';

/**
 * Vercel serverless function: mints a short-lived LiveKit access token for the
 * CardGamesMP voice feature. Steps:
 *   1. Verify the caller's Firebase anonymous ID token (jose) against Google's
 *      public keys and this app's Firebase project.
 *   2. Check the request: voice prefix `cardsmp`, a known game id, a 4-letter
 *      room code and a room slot `player_0`..`player_5`.
 *   3. Check the caller really owns that slot: read
 *      `card-games-mp/rooms/<gameId>/<code>/players/<identity>/uid` through the
 *      Realtime Database REST API with the caller's own ID token.
 *   4. Issue a LiveKit JWT for the room `cardsmp-<gameId>-<code>`.
 *
 * Required Vercel env (server-side, NOT VITE_): LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
 * FIREBASE_DATABASE_URL (or VITE_FIREBASE_DATABASE_URL).
 * Optional: FIREBASE_PROJECT_ID (defaults to this app's project — cards-mp).
 */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'cards-mp';
const VOICE_PREFIX = 'cardsmp';
// Must match the ids in src/games/registry.js.
const GAME_IDS = new Set([
  'patte-par-patta', 'simple-rummy', 'bluff', 'flip-and-match', 'perfect-ten', 'poker',
]);
const ROOM_RE = /^[A-HJ-NP-Z]{4}$/;
// Room slots: the store has six (SLOT_COUNT), matching the rules' player_0..player_5.
const IDENTITY_RE = /^player_[0-5]$/;
const DB_ROOT = 'card-games-mp/rooms';
const MEMBERSHIP_TIMEOUT_MS = 5000;

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

function sanitizeName(value) {
  return String(value || 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Player';
}

function databaseOrigin() {
  const raw = process.env.FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DATABASE_URL || '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch (_) {
    return null;
  }
}

function readBody(req) {
  // Vercel parses JSON bodies lazily; a malformed body throws on access.
  const body = req.body;
  if (body == null || body === '') return {};
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('body must be an object');
  return parsed;
}

/** Returns the uid stored on the seat (or null). Throws on network/HTTP/JSON failure. */
async function readSeatOwner({ origin, gameId, code, identity, idToken }) {
  // gameId, code and identity are already checked against a whitelist / strict regex.
  const url = `${origin}/${DB_ROOT}/${gameId}/${code}/players/${identity}/uid.json?auth=${encodeURIComponent(idToken)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMBERSHIP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`membership-http-${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const origin = databaseOrigin();
    if (!apiKey || !apiSecret || !origin) {
      res.status(500).json({ error: 'voice-not-configured' });
      return;
    }

    const authHeader = req.headers?.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: 'missing-token' });
      return;
    }

    let uid;
    try {
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
        audience: FIREBASE_PROJECT_ID,
      });
      uid = payload.sub;
      if (!uid) throw new Error('no-subject');
    } catch (_) {
      res.status(401).json({ error: 'invalid-token' });
      return;
    }

    let body;
    try {
      body = readBody(req);
    } catch (_) {
      res.status(400).json({ error: 'invalid-json' });
      return;
    }
    const game = typeof body.game === 'string' ? body.game : '';
    const gameId = typeof body.gameId === 'string' ? body.gameId : '';
    const code = typeof body.room === 'string' ? body.room.toUpperCase() : '';
    const identity = typeof body.identity === 'string' ? body.identity : '';
    if (game !== VOICE_PREFIX || !GAME_IDS.has(gameId) || !ROOM_RE.test(code) || !IDENTITY_RE.test(identity)) {
      res.status(400).json({ error: 'invalid-room-or-identity' });
      return;
    }

    let owner;
    try {
      owner = await readSeatOwner({ origin, gameId, code, identity, idToken });
    } catch (_) {
      res.status(503).json({ error: 'membership-check-failed' });
      return;
    }
    if (typeof owner !== 'string' || owner !== uid) {
      res.status(403).json({ error: 'not-in-room' });
      return;
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: sanitizeName(body.name),
      ttl: '2h',
      metadata: JSON.stringify({ uid }),
    });
    token.addGrant({
      roomJoin: true,
      room: `${VOICE_PREFIX}-${gameId}-${code}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    const jwt = await token.toJwt();
    res.status(200).json({ token: jwt });
  } catch (error) {
    res.status(500).json({ error: 'token-failed' });
  }
}
