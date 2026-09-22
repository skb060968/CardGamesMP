// On-device diagnostics: self-installs error capture + the 5-tap viewer. MUST be the
// first import so startup failures are recorded too (platform standard, §14a).
import { recordDiagnostic, setDiagnosticsContext } from './platform/diagnostics.js';
import '../style.css';
import './cardgamesmp.css';
import * as pppRules from './games/patte-par-patta/engine.js';
import * as fmRules from './games/flip-and-match/engine.js';
import * as srRules from './games/simple-rummy/engine.js';
import * as ptRules from './games/perfect-ten/engine.js';
import * as pkRules from './games/poker/engine.js';
import * as blRules from './games/bluff/engine.js';
import {
  renderGameplay as renderPPPGameplay,
  renderLobbyPlayers as renderPPPLobbyPlayers,
  renderResults as renderPPPResults,
  setEventMessage as setPPPEventMessage,
} from './games/patte-par-patta/ui.js';
import {
  renderGameplay as renderFMGameplay,
  renderLobbyPlayers as renderFMLobbyPlayers,
  renderResults as renderFMResults,
  setEventMessage as setFMEventMessage,
} from './games/flip-and-match/ui.js';
import {
  renderGameplay as renderSRGameplay,
  renderLobbyPlayers as renderSRLobbyPlayers,
  renderResults as renderSRResults,
  setEventMessage as setSREventMessage,
} from './games/simple-rummy/ui.js';
import {
  renderGameplay as renderPTGameplay,
  renderLobbyPlayers as renderPTLobbyPlayers,
  renderResults as renderPTResults,
  setEventMessage as setPTEventMessage,
} from './games/perfect-ten/ui.js';
import {
  renderGameplay as renderPKGameplay,
  renderLobbyPlayers as renderPKLobbyPlayers,
  renderResults as renderPKResults,
  setEventMessage as setPKEventMessage,
} from './games/poker/ui.js';
import {
  clearSelection as clearBLSelection,
  hideChallengeResult as hideBLChallengeResult,
  renderChallengeResult as renderBLChallengeResult,
  renderGameplay as renderBLGameplay,
  renderLobbyPlayers as renderBLLobbyPlayers,
  renderResults as renderBLResults,
  setEventMessage as setBLEventMessage,
} from './games/bluff/ui.js';
import { renderCardBack, renderCardFace } from './shared/card-renderer.js';
import {
  announceBluffPlacement, announceCapture, announceWin, initAudio, isMuted,
  playSound, toggleMute, warmSpeech,
} from './shared/voice-announcer.js';
import { createShareHandler, showQRCode } from './deep-link-handler.js';
import { normalizeRoomCode } from './core/room-code.js';
import { renderLandingPage, showConfirm, showScreen, showToast } from './platform-ui.js';
import { createPatteParPattaEffects, createPatteParPattaRuntime } from './games/patte-par-patta/index.js';
import { createFlipAndMatchEffects, createFlipAndMatchRuntime } from './games/flip-and-match/index.js';
import { createSimpleRummyEffects, createSimpleRummyRuntime } from './games/simple-rummy/index.js';
import { createPerfectTenEffects, createPerfectTenRuntime } from './games/perfect-ten/index.js';
import { createPokerEffects, createPokerRuntime } from './games/poker/index.js';
import { createBluffEffects, createBluffRuntime } from './games/bluff/index.js';
import { createFirebaseClient } from './platform/firebase-client.js';
import { mountVoiceChat } from './platform/voice-chat-widget.js';
import { createServiceWorkerUpdateClient } from './platform/service-worker-update.js';
import { isPlayerConnected } from './data/firebase-room-store.js';
import { GAMES } from './games/registry.js';

const AVAILABLE_IDS = new Set(['patte-par-patta', 'flip-and-match', 'simple-rummy', 'perfect-ten', 'poker', 'bluff']);
const AVAILABLE_GAMES = GAMES.map((game) => ({ ...game, available: AVAILABLE_IDS.has(game.id) }));
const element = (id) => document.getElementById(id);
const selectedEmoji = (screenId) =>
  document.querySelector(`#${screenId} .emoji-btn.selected`)?.dataset.emoji || '👲';

let runtime = null;
let activeGameId = null;
setDiagnosticsContext(() => ({
  game: activeGameId,
  room: runtime?.roomCode,
  seat: runtime?.playerSlotIndex,
  host: runtime?.isHost,
  revision: runtime?.currentState?.revision,
  status: runtime?.currentState?.status,
}));
let firebaseClientPromise = null;
let voiceWidget = null;

/* Games whose controls row hosts the voice pill inline. The single shared
 * widget node is relocated into the matching slot; other games use the
 * floating dock. */
const VOICE_SLOT_BY_GAME = Object.freeze({
  'patte-par-patta': 'ppp-voice-slot',
  'flip-and-match': 'fm-voice-slot',
  'simple-rummy': 'sr-voice-slot',
  'perfect-ten': 'pt-voice-slot',
  'poker': 'pk-voice-slot',
  'bluff': 'bl-voice-slot',
});

/* ======= VOICE CHAT (optional, LiveKit, voice-only) =======
 * One shared floating widget for all six games — they use a single room
 * connection at a time. Mounted once; revealed on room connect, hidden and
 * torn down on leave/disconnect. Identity + room read live from `runtime`.
 */
function initVoiceWidget() {
  if (voiceWidget) return;
  voiceWidget = mountVoiceChat({
    mount: '#voice-widget',
    game: 'cardsmp',
    getRoomCode: () => runtime?.roomCode || null,
    getIdentity: () => (runtime && runtime.playerIndex >= 0 ? `player_${runtime.playerIndex}` : null),
    getDisplayName: () => (runtime && runtime.playerIndex >= 0 ? `Player ${runtime.playerIndex + 1}` : 'Player'),
    getIdToken: async () => {
      const client = await firebaseClient();
      return client.user.getIdToken();
    },
    notify: (message) => showToast(message, 3000),
  });
}

/** Reveal the voice widget once connected to a room. Converted games host the
 *  pill inside their own controls row; the rest use the floating dock. The
 *  single shared widget node is relocated into the active game's slot. */
function showVoiceDock() {
  initVoiceWidget();
  const widget = element('voice-widget');
  const dock = element('voice-dock');
  const slotId = VOICE_SLOT_BY_GAME[activeGameId] || null;
  const slot = slotId ? element(slotId) : null;
  if (slot && widget) {
    if (widget.parentElement !== slot) slot.appendChild(widget);
    if (dock) dock.hidden = true;
  } else {
    if (widget && dock && widget.parentElement !== dock) dock.appendChild(widget);
    if (dock) dock.hidden = false;
  }
}

/** Leave any voice call and hide the dock when leaving the room. */
function hideVoiceDock() {
  if (voiceWidget) { try { voiceWidget.stop(); } catch (_) {} }
  const dock = element('voice-dock');
  if (dock) dock.hidden = true;
}

/** Render a game-sound mute button (🔊 / 🔇) to match its muted state. */
function renderMuteButton(button, muted) {
  if (!button) return;
  button.textContent = muted ? '🔇' : '🔊';
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute('aria-label', muted ? 'Unmute game sound' : 'Mute game sound');
}

/** Wire a game-sound mute icon button to the shared audio mute state. */
function wireMuteButton(id) {
  const button = element(id);
  if (!button) return;
  renderMuteButton(button, isMuted());
  button.addEventListener('click', () => renderMuteButton(button, toggleMute()));
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function classifyErrorMessage(error) {
  const chain = errorChain(error);
  const details = chain
    .flatMap((entry) => [entry?.code, entry?.message])
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (/permission(?:_|-|\s)denied/.test(details)) return 'Permission denied.';

  const messages = {
    'room-not-found': 'Room not found.',
    'room-full': 'Room is full.',
    'room-not-joinable': 'This round has already started.',
    'identity-already-in-room': 'This browser tab is already a player in this room. Open the join link in a new tab or another device.',
    'room-not-waiting': 'Players can only be removed while waiting in the lobby.',
    'player-not-found': 'That player has already left.',
    'player-identity-mismatch': 'The lobby changed. Please try again.',
    'cannot-remove-host': 'The host cannot be removed.',
    'roster-conflict': 'The player list changed. Review the lobby and start again.',
    'revision-conflict': 'Game advanced on another device. State refreshed.',
    'wrong-turn': 'It is not your turn.',
  };
  if (messages[error?.code]) return messages[error.code];

  const retryableCodes = new Set([
    'firebase-operation-failed',
    'room-sync-timeout',
    'network-error',
    'network-request-failed',
    'auth/network-request-failed',
    'unavailable',
    'disconnected',
    'timeout',
  ]);
  const hasRetryableCode = chain.some((entry) => retryableCodes.has(
    typeof entry?.code === 'string' ? entry.code.toLowerCase() : '',
  ));
  const hasNetworkFailure = /network|offline|failed to fetch|connection (?:lost|closed|reset)|timed? ?out|unavailable|disconnected/.test(details);
  if (hasRetryableCode || hasNetworkFailure) return 'Action failed — try again.';

  return error?.message || 'Something went wrong.';
}

/**
 * Records a precise diagnostic for a failure and returns the friendly,
 * player-facing message (unchanged). This is the single choke point used by
 * every error toast, so every field failure is captured on-device with its
 * real cause codes even though the player only sees the friendly text.
 * @param {Error} error
 * @param {string} [context] short label describing what was attempted
 * @returns {string}
 */
function errorMessage(error, context = 'action') {
  const friendly = classifyErrorMessage(error);
  try {
    const chain = errorChain(error);
    const codes = chain
      .map((entry) => (typeof entry?.code === 'string' ? entry.code : null))
      .filter(Boolean);
    const blob = chain
      .flatMap((entry) => [entry?.code, entry?.message])
      .filter((value) => typeof value === 'string')
      .join(' ');
    if (/permission(?:_|-|\s)denied/i.test(blob) && !codes.includes('permission_denied')) {
      codes.push('permission_denied');
    }
    const deepest = chain[chain.length - 1];
    recordDiagnostic({
      game: activeGameId,
      label: context,
      codes,
      detail: deepest?.message || error?.message || friendly,
    });
  } catch (_) {
    // Diagnostics must never interfere with the player-facing flow.
  }
  return friendly;
}

function roomEntries(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.name)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

/* ---- Lobby presence (S3 offline badge, S4 connected-only Start gate, S5
   linger-then-prune). Connected state is derived from the room's presence tree
   (fail-open); the host (player_0) and the local player are never hidden. ---- */
const LOBBY_MIN_CONNECTED = 2;
const LOBBY_PRUNE_DELAY_MS = 2500;
let lobbyDisconnectedSince = {};
let lobbyPruneTimer = null;
let rerenderLobby = null;

function isLobbyEntryVisible(key, connected, roomSlotIndex) {
  if (connected) return true;
  if (key === 'player_0') return true;
  if (Number.isInteger(roomSlotIndex) && key === `player_${roomSlotIndex}`) return true;
  const since = lobbyDisconnectedSince[key];
  return typeof since === 'number' && Date.now() - since < LOBBY_PRUNE_DELAY_MS;
}

function trackLobbyDisconnections(entries, roomSlotIndex) {
  const stamp = Date.now();
  const next = {};
  let pruneNeeded = false;
  entries.forEach(({ key, connected }) => {
    if (connected) return;
    next[key] = lobbyDisconnectedSince[key] || stamp;
    const exempt = key === 'player_0'
      || (Number.isInteger(roomSlotIndex) && key === `player_${roomSlotIndex}`);
    if (!exempt && stamp - next[key] < LOBBY_PRUNE_DELAY_MS) pruneNeeded = true;
  });
  lobbyDisconnectedSince = next;
  if (!pruneNeeded || lobbyPruneTimer !== null) return;
  lobbyPruneTimer = setTimeout(() => {
    lobbyPruneTimer = null;
    if (typeof rerenderLobby === 'function') rerenderLobby();
  }, LOBBY_PRUNE_DELAY_MS);
}

/**
 * Shared lobby renderer: annotates each player with presence-derived
 * `connected`, hides players who have been offline past the linger window
 * (never the host or the local player), gates the host Start button on the
 * connected count, and re-renders when the prune window elapses.
 */
function presentLobby(options) {
  const {
    room, roomCode, isHost, roomSlotIndex,
    codeId, startId, waitingId, screenId, renderPlayers, max,
  } = options;

  let entries = roomEntries(room).map(([key, player]) => ({
    key,
    player,
    connected: isPlayerConnected(room, player.uid),
  }));
  if (Number.isInteger(max)) entries = entries.slice(0, max);

  trackLobbyDisconnections(entries, roomSlotIndex);
  const visible = entries.filter((entry) => isLobbyEntryVisible(entry.key, entry.connected, roomSlotIndex));
  const connectedCount = entries.filter((entry) => entry.connected).length;

  const code = element(codeId);
  if (code) code.textContent = roomCode;
  renderPlayers(
    visible.map((entry) => ({ ...entry.player, connected: entry.connected })),
    isHost,
    visible.map((entry) => entry.key),
  );
  const startBtn = element(startId);
  if (startBtn) {
    startBtn.hidden = !isHost;
    if (isHost) startBtn.disabled = connectedCount < LOBBY_MIN_CONNECTED;
  }
  const waiting = element(waitingId);
  if (waiting) waiting.hidden = isHost;
  showScreen(screenId);

  rerenderLobby = () => presentLobby(options);
}

function renderPPPLobby({ room, roomCode, isHost, roomSlotIndex }) {
  presentLobby({
    room, roomCode, isHost, roomSlotIndex,
    codeId: 'lobby-room-code',
    startId: 'btn-start-online',
    waitingId: 'lobby-waiting',
    screenId: 'ppp-lobby',
    renderPlayers: renderPPPLobbyPlayers,
  });
}

function renderFMLobby({ room, roomCode, isHost, roomSlotIndex }) {
  presentLobby({
    room, roomCode, isHost, roomSlotIndex,
    codeId: 'fm-lobby-room-code',
    startId: 'fm-btn-start-online',
    waitingId: 'fm-lobby-waiting',
    screenId: 'fm-lobby',
    renderPlayers: renderFMLobbyPlayers,
  });
}

function renderSRLobby({ room, roomCode, isHost, roomSlotIndex }) {
  presentLobby({
    room, roomCode, isHost, roomSlotIndex,
    codeId: 'sr-lobby-room-code',
    startId: 'sr-btn-start-online',
    waitingId: 'sr-lobby-waiting',
    screenId: 'sr-lobby',
    renderPlayers: renderSRLobbyPlayers,
  });
}

function renderPTLobby({ room, roomCode, isHost, roomSlotIndex }) {
  presentLobby({
    room, roomCode, isHost, roomSlotIndex,
    codeId: 'pt-lobby-room-code',
    startId: 'pt-btn-start-online',
    waitingId: 'pt-lobby-waiting',
    screenId: 'pt-lobby',
    renderPlayers: renderPTLobbyPlayers,
  });
}

function renderPKLobby({ room, roomCode, isHost, roomSlotIndex }) {
  presentLobby({
    room, roomCode, isHost, roomSlotIndex, max: 4,
    codeId: 'pk-lobby-room-code',
    startId: 'pk-btn-start-online',
    waitingId: 'pk-lobby-waiting',
    screenId: 'pk-lobby',
    renderPlayers: renderPKLobbyPlayers,
  });
}

function renderBLLobby({ room, roomCode, isHost, roomSlotIndex }) {
  presentLobby({
    room, roomCode, isHost, roomSlotIndex, max: 4,
    codeId: 'bl-lobby-room-code',
    startId: 'bl-btn-start-online',
    waitingId: 'bl-lobby-waiting',
    screenId: 'bl-lobby',
    renderPlayers: renderBLLobbyPlayers,
  });
}

/* ---- In-game presence (standard): seats whose player has dropped are greyed
   and tagged OFF. The runtime hands us the latest room snapshot (players +
   presence) on every presence/refresh tick; because each game's renderer
   rebuilds the seat DOM, the badges are re-applied after every `onState` too.
   Seat nodes are identified by `[data-player-index]` (game seat index) inside
   the game's gameplay screen; the local seat is never marked offline. ---- */
const GAMEPLAY_SCREEN_BY_GAME = Object.freeze({
  'patte-par-patta': 'ppp-gameplay',
  'flip-and-match': 'fm-gameplay',
  'simple-rummy': 'sr-gameplay',
  'perfect-ten': 'pt-gameplay',
  'poker': 'pk-gameplay',
  'bluff': 'bl-gameplay',
});
let presenceRoom = null;

function syncSeatPresence() {
  const screenId = GAMEPLAY_SCREEN_BY_GAME[activeGameId];
  const screen = screenId ? element(screenId) : null;
  const state = runtime?.currentState;
  if (!screen || !presenceRoom || !Array.isArray(state?.playerSlots)) return;
  state.playerSlots.forEach((slot, seat) => {
    const uid = presenceRoom.players?.[slot]?.uid;
    const offline = seat !== runtime.playerIndex && !isPlayerConnected(presenceRoom, uid);
    screen.querySelectorAll(`[data-player-index="${seat}"]:not(.card)`).forEach((node) => {
      node.classList.toggle('seat-offline', offline);
      const badge = node.querySelector(':scope > .offline-badge');
      if (offline && !badge) {
        const tag = document.createElement('span');
        tag.className = 'offline-badge';
        tag.textContent = 'OFF';
        node.appendChild(tag);
      } else if (!offline && badge) {
        badge.remove();
      }
    });
  });
}

/* ---- Offline-stall watchdog + claim-win + host-loss (STANDARD, §6) ----
   Every connected client re-evaluates these on every presence tick and every
   state change. The watchdog arms against a generation key
   (`revision:currentPlayerIndex`), staggered by connected rank so the first
   connected seat normally fires first and the others find the turn moved. The
   store re-checks presence inside its transaction, so a race loses cleanly. */
const TURN_GRACE_MS = 15000;
const STAGGER_MS = 400;
const RESULTS_BY_GAME = Object.freeze({
  'patte-par-patta': { screenId: 'ppp-results', buttonId: 'btn-play-again', displayId: 'winner-display' },
  'flip-and-match': { screenId: 'fm-results', buttonId: 'fm-btn-play-again', displayId: 'fm-winner-display' },
  'simple-rummy': { screenId: 'sr-results', buttonId: 'sr-btn-play-again', displayId: 'sr-winner-display' },
  'perfect-ten': { screenId: 'pt-results', buttonId: 'pt-btn-play-again', displayId: 'pt-winner-display' },
  'poker': { screenId: 'pk-results', buttonId: 'pk-btn-play-again', displayId: 'pk-winner-display' },
  'bluff': { screenId: 'bl-results', buttonId: 'bl-btn-play-again', displayId: 'bl-winner-display' },
});
let watchdogTimer = null;
let watchdogKey = null;

function clearWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  watchdogKey = null;
}

/** Game seats (indices into `state.players`) that are connected right now, in seat order. */
function connectedSeats() {
  const state = runtime?.currentState;
  if (!presenceRoom || !Array.isArray(state?.playerSlots)) return [];
  return state.playerSlots
    .map((slot, seat) => ({ seat, uid: presenceRoom.players?.[slot]?.uid }))
    .filter(({ seat, uid }) => seat === runtime.playerIndex || isPlayerConnected(presenceRoom, uid))
    .map(({ seat }) => seat);
}

/** Never treat yourself as the dropped player (§6). */
function seatOffline(seat) {
  const state = runtime?.currentState;
  const slot = state?.playerSlots?.[seat];
  if (!presenceRoom || !slot || seat === runtime.playerIndex) return false;
  return !isPlayerConnected(presenceRoom, presenceRoom.players?.[slot]?.uid);
}

function othersAllOffline() {
  const state = runtime?.currentState;
  if (!Array.isArray(state?.playerSlots) || runtime.playerIndex < 0) return false;
  const others = state.playerSlots.map((_, seat) => seat).filter((seat) => seat !== runtime.playerIndex);
  return others.length > 0 && others.every(seatOffline);
}

function scheduleWatchdog() {
  const state = runtime?.currentState;
  if (!runtime?.connected || !isActiveGameState(activeGameId, state) || runtime.playerIndex < 0) { clearWatchdog(); return; }
  const cur = state.currentPlayerIndex;
  if (!seatOffline(cur)) { clearWatchdog(); return; }
  const key = `${state.revision}:${cur}`;
  if (watchdogKey === key && watchdogTimer) return;
  clearWatchdog();
  watchdogKey = key;
  const rank = Math.max(0, connectedSeats().indexOf(runtime.playerIndex));
  watchdogTimer = setTimeout(async () => {
    watchdogTimer = null;
    const latest = runtime?.currentState;
    if (!runtime?.connected || !isActiveGameState(activeGameId, latest)) return;
    if (`${latest.revision}:${latest.currentPlayerIndex}` !== key || !seatOffline(cur)) return;
    try {
      await runtime.skipStalledTurn();
    } catch (error) {
      // Another seat usually got there first (revision-conflict / target-online).
      console.warn('[CardGamesMP] skip-turn not applied:', error?.code || error?.message || error);
    }
  }, TURN_GRACE_MS + rank * STAGGER_MS);
}

function refreshClaimButtons() {
  END_GAME_CONTROLS.forEach(({ gameId, claimId }) => {
    const button = element(claimId);
    if (!button) return;
    const mine = gameId === activeGameId;
    button.hidden = !mine || !runtime?.connected
      || !isActiveGameState(gameId, runtime.currentState) || !othersAllOffline();
  });
}

/** Host, or — when the host has dropped — the first connected seat (host-loss inheritance). */
function mayRestart() {
  if (!runtime?.connected || runtime.currentState?.status !== 'finished') return false;
  if (runtime.isHost) return true;
  return runtime.canActForOfflineHost(presenceRoom);
}

function refreshPlayAgainButton() {
  const results = RESULTS_BY_GAME[activeGameId];
  const button = results ? element(results.buttonId) : null;
  if (!button || runtime?.currentState?.status !== 'finished') return;
  if (button.dataset.busy === 'true') return;
  const can = mayRestart();
  // The host always sits in room slot player_0 (hostSlot is pinned by the rules).
  const hostOffline = Boolean(presenceRoom) && !isPlayerConnected(presenceRoom, presenceRoom.players?.player_0?.uid);
  button.disabled = !can;
  button.textContent = can ? 'Play Again' : (hostOffline ? 'Waiting…' : 'Waiting for host…');
}

/** Re-evaluate every stall guard; called on each presence tick and state change. */
function refreshStallGuards() {
  scheduleWatchdog();
  refreshClaimButtons();
  refreshPlayAgainButton();
}

/**
 * Shared results presenter. Adds the standard `.results-note` when the round
 * ended because everyone else went offline (a `claim-win` move).
 */
function presentFinished(gameId, state, gameRuntime, { announce = true } = {}) {
  const { screenId, displayId } = RESULTS_BY_GAME[gameId];
  showScreen(screenId);
  clearWatchdog();
  const display = element(displayId);
  if (display && gameRuntime.lastMove?.type === 'claim-win' && !display.querySelector('.results-note')) {
    const note = document.createElement('div');
    note.className = 'results-note';
    note.textContent = 'Everyone else went offline';
    display.appendChild(note);
  }
  refreshPlayAgainButton();
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner && announce) announceWin(winner.name);
}

const showPPPFinished = (state, gameRuntime) => presentFinished('patte-par-patta', state, gameRuntime);
const showFMFinished = (state, gameRuntime) => presentFinished('flip-and-match', state, gameRuntime, { announce: !state.isTie });
const showSRFinished = (state, gameRuntime) => presentFinished('simple-rummy', state, gameRuntime);
const showPTFinished = (state, gameRuntime) => presentFinished('perfect-ten', state, gameRuntime);
const showPKFinished = (state, gameRuntime) => presentFinished('poker', state, gameRuntime);
const showBLFinished = (state, gameRuntime) => presentFinished('bluff', state, gameRuntime);

async function firebaseClient() {
  if (!firebaseClientPromise) firebaseClientPromise = createFirebaseClient();
  return firebaseClientPromise;
}

async function buildRuntime(gameId) {
  const client = await firebaseClient();
  let candidate;
  const commonCallbacks = {
    onError: (error) => {
      console.error(`[CardGamesMP:${gameId}]`, error);
      showToast(errorMessage(error, `runtime:${gameId}`), 3000);
    },
    onDisconnected: ({ removed = false, roomDeleted = false, leftSeat = false } = {}) => {
      if (runtime === candidate) {
        runtime = null;
        activeGameId = null;
        presenceRoom = null;
        clearWatchdog();
        hideVoiceDock();
        showScreen('landing-page');
        if (removed) showToast('The host removed you from the lobby.', 3500);
        else if (roomDeleted) showToast('The room was closed by the host.', 3500);
        else if (leftSeat) showToast('You left the game. The others keep playing.', 3000);
      }
    },
    onPresence: ({ room }) => {
      if (runtime !== candidate) return;
      presenceRoom = room;
      syncSeatPresence();
      refreshStallGuards();
    },
  };

  if (gameId === 'patte-par-patta') {
    const effects = createPatteParPattaEffects({
      renderCardFace,
      renderGameplay: renderPPPGameplay,
      renderResults: renderPPPResults,
      playSound,
      announceCapture,
      setEventMessage: setPPPEventMessage,
      onFinished: ({ state }) => showPPPFinished(state, candidate),
    });
    candidate = createPatteParPattaRuntime({
      database: client.database,
      uid: client.uid,
      rules: pppRules,
      effects,
      callbacks: {
        ...commonCallbacks,
        onConnected: ({ roomCode }) => { element('lobby-room-code').textContent = roomCode; },
        onLobby: renderPPPLobby,
        onState: (state) => { if (state.status === 'playing') showScreen('ppp-gameplay'); syncSeatPresence(); refreshStallGuards(); },
      },
    });
    return candidate;
  }

  if (gameId === 'flip-and-match') {
    const effects = createFlipAndMatchEffects({
      renderGameplay: renderFMGameplay,
      renderResults: renderFMResults,
      playSound,
      announceCapture,
      setEventMessage: setFMEventMessage,
      onFinished: (state) => showFMFinished(state, candidate),
    });
    candidate = createFlipAndMatchRuntime({
      database: client.database,
      uid: client.uid,
      rules: fmRules,
      effects,
      callbacks: {
        ...commonCallbacks,
        onConnected: ({ roomCode }) => { element('fm-lobby-room-code').textContent = roomCode; },
        onLobby: renderFMLobby,
        onState: (state) => { if (state.status === 'playing') showScreen('fm-gameplay'); syncSeatPresence(); refreshStallGuards(); },
      },
    });
    return candidate;
  }

  if (gameId === 'simple-rummy') {
    const effects = createSimpleRummyEffects({
      renderCardFace,
      renderCardBack,
      renderGameplay: renderSRGameplay,
      renderResults: renderSRResults,
      playSound,
      setEventMessage: setSREventMessage,
      onFinished: ({ state }) => showSRFinished(state, candidate),
    });
    candidate = createSimpleRummyRuntime({
      database: client.database,
      uid: client.uid,
      rules: srRules,
      effects,
      callbacks: {
        ...commonCallbacks,
        onConnected: ({ roomCode }) => { element('sr-lobby-room-code').textContent = roomCode; },
        onLobby: renderSRLobby,
        onState: (state) => { if (state.status === 'playing') showScreen('sr-gameplay'); syncSeatPresence(); refreshStallGuards(); },
      },
    });
    return candidate;
  }

  if (gameId === 'perfect-ten') {
    const effects = createPerfectTenEffects({
      renderCardFace,
      renderCardBack,
      renderGameplay: renderPTGameplay,
      renderResults: renderPTResults,
      playSound,
      setEventMessage: setPTEventMessage,
      onFinished: ({ state }) => showPTFinished(state, candidate),
    });
    candidate = createPerfectTenRuntime({
      database: client.database,
      uid: client.uid,
      rules: ptRules,
      effects,
      callbacks: {
        ...commonCallbacks,
        onConnected: ({ roomCode }) => { element('pt-lobby-room-code').textContent = roomCode; },
        onLobby: renderPTLobby,
        onState: (state) => { if (state.status === 'playing') showScreen('pt-gameplay'); syncSeatPresence(); refreshStallGuards(); },
      },
    });
    return candidate;
  }

  if (gameId === 'poker') {
    const effects = createPokerEffects({
      renderGameplay: renderPKGameplay,
      renderResults: renderPKResults,
      playSound,
      setEventMessage: setPKEventMessage,
      onFinished: ({ state }) => showPKFinished(state, candidate),
    });
    candidate = createPokerRuntime({
      database: client.database,
      uid: client.uid,
      rules: pkRules,
      effects,
      callbacks: {
        ...commonCallbacks,
        onBeforeAction: warmSpeech,
        onActionUnavailable: (result) => {
          if (result?.reason === 'busy') showToast('Finishing the current Poker action…');
          else if (result?.reason === 'disposed') showToast('This Poker session has ended.');
        },
        onConnected: ({ roomCode }) => { element('pk-lobby-room-code').textContent = roomCode; },
        onLobby: renderPKLobby,
        onState: (state) => { if (state.status === 'betting') showScreen('pk-gameplay'); syncSeatPresence(); refreshStallGuards(); },
      },
    });
    return candidate;
  }

  if (gameId === 'bluff') {
    const effects = createBluffEffects({
      renderGameplay: renderBLGameplay,
      renderResults: renderBLResults,
      renderChallengeResult: renderBLChallengeResult,
      hideChallengeResult: hideBLChallengeResult,
      clearSelection: clearBLSelection,
      setEventMessage: setBLEventMessage,
      playSound,
      announcePlacement: announceBluffPlacement,
      onFinished: ({ state }) => showBLFinished(state, candidate),
    });
    candidate = createBluffRuntime({
      database: client.database,
      uid: client.uid,
      rules: blRules,
      effects,
      callbacks: {
        ...commonCallbacks,
        onBeforeAction: warmSpeech,
        onActionUnavailable: (result) => {
          if (result?.reason === 'busy') showToast('Finishing the current Bluff action…');
          else if (result?.reason === 'disposed') showToast('This Bluff session has ended.');
        },
        onConnected: ({ roomCode }) => { element('bl-lobby-room-code').textContent = roomCode; },
        onLobby: renderBLLobby,
        onState: (state) => { if (state.status === 'playing') showScreen('bl-gameplay'); syncSeatPresence(); refreshStallGuards(); },
      },
    });
    return candidate;
  }
  throw new Error(`Unsupported game: ${gameId}`);
}

async function ensureRuntime(gameId) {
  if (runtime) {
    if (activeGameId !== gameId) throw new Error('Leave the current room before opening another game.');
    return runtime;
  }
  runtime = await buildRuntime(gameId);
  activeGameId = gameId;
  return runtime;
}

async function connectToRoom(gameId, operation) {
  const activeRuntime = await ensureRuntime(gameId);
  try {
    const result = await operation(activeRuntime);
    showVoiceDock();
    return result;
  } catch (error) {
    if (!activeRuntime.connected) {
      if (runtime === activeRuntime) {
        runtime = null;
        activeGameId = null;
      }
      await activeRuntime.close().catch(() => {});
    }
    throw error;
  }
}

async function runBusy(button, busyText, operation) {
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await operation();
  } catch (error) {
    console.error('[CardGamesMP]', error);
    showToast(errorMessage(error, busyText || 'action'), 3000);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function wireLobbyRemoval(listId, gameId) {
  element(listId).addEventListener('click', (event) => {
    const button = event.target.closest('.remove-player-btn');
    const activeRuntime = runtime;
    if (!button || activeGameId !== gameId || !activeRuntime?.isHost) return;
    const playerIndex = Number(button.dataset.playerIndex);
    const expectedUid = button.dataset.playerUid;
    if (!Number.isInteger(playerIndex) || !expectedUid) return;
    const playerName = button.dataset.playerName || 'Player';
    runBusy(button, '…', async () => {
      await activeRuntime.removePlayer({ playerIndex, expectedUid });
      showToast(`${playerName} was removed from the lobby.`, 2500);
    });
  });
}

function wireEmojiPickers() {
  document.querySelectorAll('.emoji-picker').forEach((picker) => {
    picker.addEventListener('click', (event) => {
      const button = event.target.closest('.emoji-btn');
      if (!button) return;
      picker.querySelectorAll('.emoji-btn').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
    });
  });
}

async function leaveCurrentRoom() {
  const current = runtime;
  runtime = null;
  activeGameId = null;
  hideVoiceDock();
  if (current?.connected) await current.leaveRoom();
  else await current?.close();
  showScreen('landing-page');
}

/** Play Again (host, or the inheriting seat when the host is gone) → back to the lobby. */
async function handlePlayAgain(event) {
  const button = event.currentTarget;
  if (!mayRestart()) { refreshPlayAgainButton(); return; }
  button.dataset.busy = 'true';   // keeps presence ticks from repainting the label mid-flight
  try {
    await runBusy(button, 'Back to lobby…', () => runtime.playAgain());
  } finally {
    delete button.dataset.busy;
    refreshPlayAgainButton();
  }
}

/** Standard How-to-Play screen per game: `<p>-btn-how-to` opens `<p>-how-to`, back returns to `<p>-online-choice`. */
function wireHowToScreens() {
  for (const prefix of ['ppp', 'fm', 'sr', 'pt', 'pk', 'bl']) {
    element(`${prefix}-btn-how-to`).addEventListener('click', () => showScreen(`${prefix}-how-to`));
    element(`${prefix}-btn-back-how-to`).addEventListener('click', () => showScreen(`${prefix}-online-choice`));
  }
}

function wirePPP() {
  wireLobbyRemoval('lobby-player-list', 'patte-par-patta');
  element('btn-create-room').addEventListener('click', () => showScreen('ppp-create-room'));
  element('btn-join-room').addEventListener('click', () => showScreen('ppp-join-room'));
  element('btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('btn-back-create').addEventListener('click', () => showScreen('ppp-online-choice'));
  element('btn-back-join').addEventListener('click', () => showScreen('ppp-online-choice'));

  element('btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('create-name-input').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('patte-par-patta', (activeRuntime) => activeRuntime.createRoom({
      player: { name, emoji: selectedEmoji('ppp-create-room') },
    }));
  }));
  element('btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = normalizeRoomCode(element('room-code-input').value);
    const name = element('join-name-input').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('patte-par-patta', (activeRuntime) => activeRuntime.joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('ppp-join-room') },
    }));
  }));
  element('btn-start-online').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.startRound()));
  element('btn-leave-lobby').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));

  element('ppp-gameplay').addEventListener('click', async (event) => {
    const card = event.target.closest('.player-slot-deck .card');
    if (!card || activeGameId !== 'patte-par-patta' || runtime.playerIndex < 0) return;
    warmSpeech();
    const result = await runtime.throwCard(Number(card.dataset.handIndex || 0));
    if (result && !result.ok && result.reason === 'busy') showToast('Finishing the current animation…');
  });
  element('btn-play-again').addEventListener('click', handlePlayAgain);
  element('btn-home').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('btn-share-code').addEventListener('click', () => {
    if (runtime?.roomCode) createShareHandler(runtime.roomCode, 'Patte Par Patta', 'patte-par-patta')();
  });
  element('btn-qr-code').addEventListener('click', () => {
    if (runtime?.roomCode) showQRCode(runtime.roomCode, 'Patte Par Patta', 'patte-par-patta');
  });
  wireMuteButton('mute-toggle');
}
function wireFlipAndMatch() {
  wireLobbyRemoval('fm-lobby-player-list', 'flip-and-match');
  element('fm-btn-create-room').addEventListener('click', () => showScreen('fm-create-room'));
  element('fm-btn-join-room').addEventListener('click', () => showScreen('fm-join-room'));
  element('fm-btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('fm-btn-back-create').addEventListener('click', () => showScreen('fm-online-choice'));
  element('fm-btn-back-join').addEventListener('click', () => showScreen('fm-online-choice'));

  element('fm-btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('fm-create-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('flip-and-match', (activeRuntime) => activeRuntime.createRoom({
      player: { name, emoji: selectedEmoji('fm-create-room') },
    }));
  }));
  element('fm-btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = normalizeRoomCode(element('fm-room-code').value);
    const name = element('fm-join-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('flip-and-match', (activeRuntime) => activeRuntime.joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('fm-join-room') },
    }));
  }));
  element('fm-btn-start-online').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.startRound()));
  element('fm-btn-leave-lobby').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('fm-btn-play-again').addEventListener('click', handlePlayAgain);
  element('fm-btn-home').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('fm-btn-share-code').addEventListener('click', () => {
    if (runtime?.roomCode) createShareHandler(runtime.roomCode, 'Flip & Match', 'flip-and-match')();
  });
  element('fm-btn-qr-code').addEventListener('click', () => {
    if (runtime?.roomCode) showQRCode(runtime.roomCode, 'Flip & Match', 'flip-and-match');
  });
  wireMuteButton('fm-mute-toggle');
}

function wireSimpleRummy() {
  wireLobbyRemoval('sr-lobby-player-list', 'simple-rummy');
  element('sr-btn-create-room').addEventListener('click', () => showScreen('sr-create-room'));
  element('sr-btn-join-room').addEventListener('click', () => showScreen('sr-join-room'));
  element('sr-btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('sr-btn-back-create').addEventListener('click', () => showScreen('sr-online-choice'));
  element('sr-btn-back-join').addEventListener('click', () => showScreen('sr-online-choice'));

  element('sr-btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('sr-create-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('simple-rummy', (activeRuntime) => activeRuntime.createRoom({
      player: { name, emoji: selectedEmoji('sr-create-room') },
    }));
  }));
  element('sr-btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = normalizeRoomCode(element('sr-room-code').value);
    const name = element('sr-join-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('simple-rummy', (activeRuntime) => activeRuntime.joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('sr-join-room') },
    }));
  }));
  element('sr-btn-start-online').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.startRound()));
  element('sr-btn-leave-lobby').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('sr-gameplay').addEventListener('click', (event) => {
    if (activeGameId === 'simple-rummy' && event.target.closest('[data-draw-source], [data-hand-index]')) warmSpeech();
  });
  element('sr-btn-play-again').addEventListener('click', handlePlayAgain);
  element('sr-btn-home').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('sr-btn-share-code').addEventListener('click', () => {
    if (runtime?.roomCode) createShareHandler(runtime.roomCode, 'Simple Rummy', 'simple-rummy')();
  });
  element('sr-btn-qr-code').addEventListener('click', () => {
    if (runtime?.roomCode) showQRCode(runtime.roomCode, 'Simple Rummy', 'simple-rummy');
  });
  wireMuteButton('sr-mute-toggle');
}

function wirePerfectTen() {
  wireLobbyRemoval('pt-lobby-player-list', 'perfect-ten');
  element('pt-btn-create-room').addEventListener('click', () => showScreen('pt-create-room'));
  element('pt-btn-join-room').addEventListener('click', () => showScreen('pt-join-room'));
  element('pt-btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('pt-btn-back-create').addEventListener('click', () => showScreen('pt-online-choice'));
  element('pt-btn-back-join').addEventListener('click', () => showScreen('pt-online-choice'));

  element('pt-btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('pt-create-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('perfect-ten', (activeRuntime) => activeRuntime.createRoom({
      player: { name, emoji: selectedEmoji('pt-create-room') },
    }));
  }));
  element('pt-btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = normalizeRoomCode(element('pt-room-code').value);
    const name = element('pt-join-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('perfect-ten', (activeRuntime) => activeRuntime.joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('pt-join-room') },
    }));
  }));
  element('pt-btn-start-online').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.startRound()));
  element('pt-btn-leave-lobby').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('pt-gameplay').addEventListener('click', (event) => {
    if (activeGameId === 'perfect-ten' && event.target.closest('[data-draw-source], [data-hand-index]')) warmSpeech();
  });
  element('pt-btn-play-again').addEventListener('click', handlePlayAgain);
  element('pt-btn-home').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('pt-btn-share-code').addEventListener('click', () => {
    if (runtime?.roomCode) createShareHandler(runtime.roomCode, 'Perfect Ten', 'perfect-ten')();
  });
  element('pt-btn-qr-code').addEventListener('click', () => {
    if (runtime?.roomCode) showQRCode(runtime.roomCode, 'Perfect Ten', 'perfect-ten');
  });
  wireMuteButton('pt-mute-toggle');
}

function wirePoker() {
  wireLobbyRemoval('pk-lobby-player-list', 'poker');
  element('pk-btn-create-room').addEventListener('click', () => showScreen('pk-create-room'));
  element('pk-btn-join-room').addEventListener('click', () => showScreen('pk-join-room'));
  element('pk-btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('pk-btn-back-create').addEventListener('click', () => showScreen('pk-online-choice'));
  element('pk-btn-back-join').addEventListener('click', () => showScreen('pk-online-choice'));

  element('pk-btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('pk-create-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('poker', (activeRuntime) => activeRuntime.createRoom({
      player: { name, emoji: selectedEmoji('pk-create-room') },
    }));
  }));
  element('pk-btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = normalizeRoomCode(element('pk-room-code').value);
    const name = element('pk-join-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('poker', (activeRuntime) => activeRuntime.joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('pk-join-room') },
    }));
  }));
  element('pk-btn-start-online').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.startRound()));
  element('pk-btn-leave-lobby').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('pk-btn-play-again').addEventListener('click', handlePlayAgain);
  element('pk-btn-home').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('pk-btn-share-code').addEventListener('click', () => {
    if (runtime?.roomCode) createShareHandler(runtime.roomCode, 'Poker', 'poker')();
  });
  element('pk-btn-qr-code').addEventListener('click', () => {
    if (runtime?.roomCode) showQRCode(runtime.roomCode, 'Poker', 'poker');
  });
  wireMuteButton('pk-mute-toggle');
}

function wireBluff() {
  wireLobbyRemoval('bl-lobby-player-list', 'bluff');
  element('bl-btn-create-room').addEventListener('click', () => showScreen('bl-create-room'));
  element('bl-btn-join-room').addEventListener('click', () => showScreen('bl-join-room'));
  element('bl-btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('bl-btn-back-create').addEventListener('click', () => showScreen('bl-online-choice'));
  element('bl-btn-back-join').addEventListener('click', () => showScreen('bl-online-choice'));

  element('bl-btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('bl-create-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('bluff', (activeRuntime) => activeRuntime.createRoom({
      player: { name, emoji: selectedEmoji('bl-create-room') },
    }));
  }));
  element('bl-btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = normalizeRoomCode(element('bl-room-code').value);
    const name = element('bl-join-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await connectToRoom('bluff', (activeRuntime) => activeRuntime.joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('bl-join-room') },
    }));
  }));
  element('bl-btn-start-online').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.startRound()));
  element('bl-btn-leave-lobby').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('bl-btn-play-again').addEventListener('click', handlePlayAgain);
  element('bl-btn-home').addEventListener('click', () => leaveCurrentRoom().catch((error) => showToast(errorMessage(error), 3000)));
  element('bl-btn-share-code').addEventListener('click', () => {
    if (runtime?.roomCode) createShareHandler(runtime.roomCode, 'Bluff', 'bluff')();
  });
  element('bl-btn-qr-code').addEventListener('click', () => {
    if (runtime?.roomCode) showQRCode(runtime.roomCode, 'Bluff', 'bluff');
  });
  wireMuteButton('bl-mute-toggle');
}

async function restoreSession() {
  for (const gameId of AVAILABLE_IDS) {
    const candidate = await buildRuntime(gameId);
    if (await candidate.restoreSession()) {
      runtime = candidate;
      activeGameId = gameId;
      syncEndGameControlVisibility();
      showVoiceDock();
      return true;
    }
    await candidate.close();
  }
  return false;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function waitForRuntimeIdle() {
  while (runtime?.busy) await new Promise((resolve) => setTimeout(resolve, 100));
}

async function setupServiceWorkerUpdates() {
  if (!import.meta.env.PROD) return;
  // Standard toast ids (shared across every game in the platform).
  const toast = element('updateToast');
  const message = element('update-toast-message');
  const updateButton = element('btn-update-reload');
  const laterButton = element('btn-update-later');
  let applyWaitingUpdate = null;
  let applying = false;

  laterButton.addEventListener('click', () => { if (!applying) toast.hidden = true; });
  updateButton.addEventListener('click', async () => {
    if (applying || !applyWaitingUpdate) return;
    applying = true;
    toast.hidden = false;
    toast.setAttribute('aria-busy', 'true');
    updateButton.disabled = true;
    laterButton.disabled = true;
    updateButton.textContent = 'Updating…';
    message.textContent = runtime?.busy
      ? 'Finishing the current move before updating…'
      : 'Applying update… The app will reload automatically.';
    try {
      await waitForRuntimeIdle();
      message.textContent = 'Applying update… The app will reload automatically.';
      await nextPaint();
      const applied = await applyWaitingUpdate({ reload: true });
      if (!applied) throw new Error('The update is no longer waiting.');
    } catch (error) {
      console.error('[CardGamesMP] Update failed:', error);
      applying = false;
      toast.setAttribute('aria-busy', 'false');
      updateButton.disabled = false;
      laterButton.disabled = false;
      updateButton.textContent = 'Try again';
      message.textContent = 'Update could not be applied. Please try again.';
    }
  });

  await createServiceWorkerUpdateClient({
    onUpdateAvailable: ({ apply }) => {
      applyWaitingUpdate = apply;
      applying = false;
      toast.hidden = false;
      toast.setAttribute('aria-busy', 'false');
      updateButton.disabled = false;
      laterButton.disabled = false;
      updateButton.textContent = 'Reload Now';
      message.textContent = 'Reload to get the latest version.';
    },
  });
}
let syncEndGameControlVisibility = () => {};

const MUTE_TOGGLE_SELECTOR = 'button.mute-toggle';

function syncMuteToggles(muted = isMuted()) {
  document.querySelectorAll(MUTE_TOGGLE_SELECTOR).forEach((button) => {
    renderMuteButton(button, muted);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('cardgames:mutechange', (event) => {
    syncMuteToggles(event.detail?.muted === true);
  });
  window.addEventListener('storage', (event) => {
    if (event.key === 'card_games_muted') syncMuteToggles();
  });
  requestAnimationFrame(() => syncMuteToggles());
}

const END_GAME_CONTROLS = Object.freeze([
  { gameId: 'patte-par-patta', buttonId: 'btn-end-game', claimId: 'ppp-btn-claim-win', screenId: 'ppp-gameplay', container: '.game-controls' },
  { gameId: 'flip-and-match', buttonId: 'fm-btn-end-game', claimId: 'fm-btn-claim-win', screenId: 'fm-gameplay', container: '.game-controls' },
  { gameId: 'simple-rummy', buttonId: 'sr-btn-end-game', claimId: 'sr-btn-claim-win', screenId: 'sr-gameplay', container: '.game-controls' },
  { gameId: 'perfect-ten', buttonId: 'pt-btn-end-game', claimId: 'pt-btn-claim-win', screenId: 'pt-gameplay', container: '.game-controls' },
  { gameId: 'poker', buttonId: 'pk-btn-end-game', claimId: 'pk-btn-claim-win', screenId: 'pk-gameplay', container: '.game-self-controls' },
  { gameId: 'bluff', buttonId: 'bl-btn-end-game', claimId: 'bl-btn-claim-win', screenId: 'bl-gameplay', container: '.game-self-controls' },
]);

function isActiveGameState(gameId, state) {
  return gameId === 'poker' ? state?.status === 'betting' : state?.status === 'playing';
}

function setupEndGameControls() {
  const controls = END_GAME_CONTROLS.map((definition) => {
    const screen = element(definition.screenId);
    let button = element(definition.buttonId);
    if (!button && screen) {
      const container = screen.querySelector(definition.container);
      if (container) {
        button = document.createElement('button');
        button.id = definition.buttonId;
        button.className = 'btn-end-game';
        button.type = 'button';
        button.hidden = true;
        button.textContent = '✕';
        container.appendChild(button);
      }
    }
    if (!screen || !button) return null;
    button.classList.add('btn-end-game');
    button.type = 'button';
    button.title = 'Leave game';
    button.setAttribute('aria-label', 'Leave game');

    // Standard claim-win button lives beside ✕ and is shown only when every
    // other seat is offline (see refreshClaimButtons).
    let claim = element(definition.claimId);
    if (!claim) {
      claim = document.createElement('button');
      claim.id = definition.claimId;
      claim.className = 'btn-claim-win';
      claim.type = 'button';
      claim.hidden = true;
      claim.textContent = '🏁 Claim win';
      button.parentElement?.insertBefore(claim, button);
    }
    return { definition, screen, button, claim };
  }).filter(Boolean);

  // ✕ is for everyone now: the host ends the room, anyone else leaves their
  // seat (presence dropped, seat kept) so the table can skip them.
  const syncVisibility = () => {
    controls.forEach(({ definition, screen, button }) => {
      const current = activeGameId === definition.gameId ? runtime : null;
      button.hidden = screen.hidden
        || !current?.connected
        || !isActiveGameState(definition.gameId, current.currentState);
    });
    refreshClaimButtons();
  };
  syncEndGameControlVisibility = syncVisibility;

  controls.forEach(({ definition, screen, button, claim }) => {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const current = runtime;
      if (activeGameId !== definition.gameId
        || !current?.connected
        || !isActiveGameState(definition.gameId, current.currentState)) {
        syncVisibility();
        return;
      }
      const confirmed = current.isHost
        ? await showConfirm('End this game for everyone?', { confirmText: 'End game', cancelText: 'Keep playing' })
        : await showConfirm('Leave the game? The others keep playing; your turns will be skipped.', { confirmText: 'Leave', cancelText: 'Keep playing' });
      if (!confirmed) return;

      button.disabled = true;
      try {
        if (current.isHost) {
          await current.leaveRoom({ deleteIfHost: true });
          showToast('Game ended.', 2000);
        } else {
          await current.leaveSeat();
        }
      } catch (error) {
        console.error(`[CardGamesMP:${definition.gameId}] Leave game failed`, error);
        showToast(errorMessage(error), 3000);
      } finally {
        button.disabled = false;
        requestAnimationFrame(syncVisibility);
      }
    });

    claim.addEventListener('click', async () => {
      if (claim.disabled || activeGameId !== definition.gameId || !runtime?.connected || !othersAllOffline()) {
        refreshClaimButtons();
        return;
      }
      claim.disabled = true;
      try {
        await runtime.claimWin();
      } catch (error) {
        console.error(`[CardGamesMP:${definition.gameId}] Claim failed`, error);
        showToast('Could not claim the win right now.', 3000);
      } finally {
        claim.disabled = false;
        refreshClaimButtons();
      }
    });

    const observer = new MutationObserver(() => requestAnimationFrame(syncVisibility));
    observer.observe(screen, { attributes: true, attributeFilter: ['hidden'] });
  });

  requestAnimationFrame(syncVisibility);
}

async function bootstrap() {
  initAudio();
  wireEmojiPickers();
  setupEndGameControls();
  wirePPP();
  wireFlipAndMatch();
  wireSimpleRummy();
  wirePerfectTen();
  wirePoker();
  wireBluff();
  wireHowToScreens();
  renderLandingPage(AVAILABLE_GAMES, (gameId) => {
    if (gameId === 'patte-par-patta') showScreen('ppp-online-choice');
    if (gameId === 'flip-and-match') showScreen('fm-online-choice');
    if (gameId === 'simple-rummy') showScreen('sr-online-choice');
    if (gameId === 'perfect-ten') showScreen('pt-online-choice');
    if (gameId === 'poker') showScreen('pk-online-choice');
    if (gameId === 'bluff') showScreen('bl-online-choice');
  });
  showScreen('landing-page');
  setupServiceWorkerUpdates().catch((error) => console.warn('[CardGamesMP] Service worker unavailable:', error));

  const params = new URLSearchParams(location.search);
  const linkedRoom = params.get('room')?.trim().toUpperCase();
  const requestedGame = params.get('game');
  const linkedGame = AVAILABLE_IDS.has(requestedGame) ? requestedGame : null;
  if (linkedRoom) {
    history.replaceState({}, '', location.pathname);
    if (!linkedGame) {
      showToast('This room link is missing a valid game. Ask the host to share a new link.', 4000);
      return;
    }
    const linkedScreens = {
      'patte-par-patta': { input: 'room-code-input', screen: 'ppp-join-room' },
      'flip-and-match': { input: 'fm-room-code', screen: 'fm-join-room' },
      'simple-rummy': { input: 'sr-room-code', screen: 'sr-join-room' },
      'perfect-ten': { input: 'pt-room-code', screen: 'pt-join-room' },
      poker: { input: 'pk-room-code', screen: 'pk-join-room' },
      bluff: { input: 'bl-room-code', screen: 'bl-join-room' },
    };
    const linked = linkedScreens[linkedGame];
    element(linked.input).value = linkedRoom;
    showScreen(linked.screen);
    return;
  }

  try {
    await restoreSession();
  } catch (error) {
    console.warn('[CardGamesMP] Session restoration unavailable:', error);
  }
}

bootstrap();