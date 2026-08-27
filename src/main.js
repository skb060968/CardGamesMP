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
import { clearDiagnostics, formatDiagnostics, recordDiagnostic } from './platform/diagnostics.js';
import { GAMES } from './games/registry.js';

const AVAILABLE_IDS = new Set(['patte-par-patta', 'flip-and-match', 'simple-rummy', 'perfect-ten', 'poker', 'bluff']);
const AVAILABLE_GAMES = GAMES.map((game) => ({ ...game, available: AVAILABLE_IDS.has(game.id) }));
const element = (id) => document.getElementById(id);
const selectedEmoji = (screenId) =>
  document.querySelector(`#${screenId} .emoji-btn.selected`)?.dataset.emoji || '👲';

let runtime = null;
let activeGameId = null;
let firebaseClientPromise = null;
let voiceWidget = null;

/* Games whose controls row hosts the voice pill inline. The single shared
 * widget node is relocated into the matching slot; other games use the
 * floating dock. */
const VOICE_SLOT_BY_GAME = Object.freeze({
  'patte-par-patta': 'ppp-voice-slot',
  'flip-and-match': 'fm-voice-slot',
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

/**
 * Builds a lightweight on-device diagnostics viewer so an operator can read or
 * copy the recorded failure log directly on any phone (no console needed).
 * Opened by a discreet 5-tap gesture on the landing page.
 */
function showDiagnosticsOverlay() {
  if (document.getElementById('diagnostics-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'diagnostics-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Diagnostics log');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '10000', display: 'flex',
    flexDirection: 'column', gap: '10px', padding: '16px',
    background: 'rgba(8, 13, 20, 0.92)', color: '#f8fafc',
    font: '13px/1.4 ui-monospace, Menlo, Consolas, monospace',
  });

  const title = document.createElement('strong');
  title.textContent = 'Diagnostics (recent failures)';
  title.style.fontSize = '15px';

  const area = document.createElement('textarea');
  area.readOnly = true;
  area.value = formatDiagnostics();
  Object.assign(area.style, {
    flex: '1', width: '100%', resize: 'none', borderRadius: '10px',
    border: '1px solid #334155', padding: '10px', background: '#0f172a',
    color: '#e2e8f0', font: 'inherit', whiteSpace: 'pre', overflow: 'auto',
  });

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
  const makeButton = (label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      flex: '1', minWidth: '90px', padding: '11px 14px', borderRadius: '10px',
      border: '0', fontWeight: '700', cursor: 'pointer',
    });
    return button;
  };
  const copyButton = makeButton('Copy');
  copyButton.style.background = '#38bdf8';
  copyButton.style.color = '#082f49';
  const clearButton = makeButton('Clear');
  clearButton.style.background = '#f59e0b';
  clearButton.style.color = '#451a03';
  const closeButton = makeButton('Close');
  closeButton.style.background = '#334155';
  closeButton.style.color = '#f8fafc';

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(area.value);
      copyButton.textContent = 'Copied';
    } catch (_) {
      area.focus();
      area.select();
      copyButton.textContent = 'Select + copy';
    }
    setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
  });
  clearButton.addEventListener('click', () => {
    clearDiagnostics();
    area.value = formatDiagnostics();
  });
  closeButton.addEventListener('click', () => overlay.remove());

  row.append(copyButton, clearButton, closeButton);
  overlay.append(title, area, row);
  document.body.appendChild(overlay);
}

/**
 * Wires the discreet 5-tap gesture (within 2s) that opens the diagnostics
 * viewer. Attached at the document level so it is reachable on ANY screen —
 * including mid-game and on the results/aborted screens — because the log is
 * most useful exactly when a failure just happened. Taps on interactive
 * controls (buttons, cards, inputs, board dots) are ignored so it never
 * interferes with gameplay; an accidental open is harmless and dismissible.
 */
function setupDiagnosticsGesture() {
  const interactive = 'button, a, input, textarea, select, label, [role="button"],'
    + ' .game-card, [data-hand-index], [data-draw-source], [data-card-index],'
    + ' [data-action], .card, svg, canvas';
  let taps = 0;
  let timer = null;
  document.addEventListener('click', (event) => {
    if (document.getElementById('diagnostics-overlay')) return;
    if (event.target.closest(interactive)) return;
    taps += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { taps = 0; }, 2000);
    if (taps >= 5) {
      taps = 0;
      clearTimeout(timer);
      showDiagnosticsOverlay();
    }
  }, true);
}

function roomEntries(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.name)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

function renderPPPLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room);
  element('lobby-room-code').textContent = roomCode;
  renderPPPLobbyPlayers(entries.map(([, player]) => player), isHost, entries.map(([key]) => key));
  element('btn-start-online').hidden = !isHost;
  element('lobby-waiting').hidden = isHost;
  showScreen('ppp-lobby');
}

function renderFMLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room);
  element('fm-lobby-room-code').textContent = roomCode;
  renderFMLobbyPlayers(entries.map(([, player]) => player), isHost, entries.map(([key]) => key));
  element('fm-btn-start-online').hidden = !isHost;
  element('fm-lobby-waiting').hidden = isHost;
  showScreen('fm-lobby');
}

function renderSRLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room);
  element('sr-lobby-room-code').textContent = roomCode;
  renderSRLobbyPlayers(entries.map(([, player]) => player), isHost, entries.map(([key]) => key));
  element('sr-btn-start-online').hidden = !isHost;
  element('sr-lobby-waiting').hidden = isHost;
  showScreen('sr-lobby');
}

function renderPTLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room);
  element('pt-lobby-room-code').textContent = roomCode;
  renderPTLobbyPlayers(entries.map(([, player]) => player), isHost, entries.map(([key]) => key));
  element('pt-btn-start-online').hidden = !isHost;
  element('pt-lobby-waiting').hidden = isHost;
  showScreen('pt-lobby');
}

function renderPKLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room).slice(0, 4);
  element('pk-lobby-room-code').textContent = roomCode;
  renderPKLobbyPlayers(entries.map(([, player]) => player), isHost, entries.map(([key]) => key));
  element('pk-btn-start-online').hidden = !isHost;
  element('pk-lobby-waiting').hidden = isHost;
  showScreen('pk-lobby');
}

function renderBLLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room).slice(0, 4);
  element('bl-lobby-room-code').textContent = roomCode;
  renderBLLobbyPlayers(entries.map(([, player]) => player), isHost, entries.map(([key]) => key));
  element('bl-btn-start-online').hidden = !isHost;
  element('bl-lobby-waiting').hidden = isHost;
  showScreen('bl-lobby');
}

function showPPPFinished(state, gameRuntime) {
  showScreen('ppp-results');
  const button = element('btn-play-again');
  button.disabled = !gameRuntime.isHost;
  button.textContent = gameRuntime.isHost ? 'Play Again' : 'Waiting for host…';
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner) announceWin(winner.name);
}

function showFMFinished(state, gameRuntime) {
  showScreen('fm-results');
  const button = element('fm-btn-play-again');
  button.disabled = !gameRuntime.isHost;
  button.textContent = gameRuntime.isHost ? 'Play Again' : 'Waiting for host…';
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner && !state.isTie) announceWin(winner.name);
}

function showSRFinished(state, gameRuntime) {
  showScreen('sr-results');
  const button = element('sr-btn-play-again');
  button.disabled = !gameRuntime.isHost;
  button.textContent = gameRuntime.isHost ? 'Play Again' : 'Waiting for host…';
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner) announceWin(winner.name);
}

function showPTFinished(state, gameRuntime) {
  showScreen('pt-results');
  const button = element('pt-btn-play-again');
  button.disabled = !gameRuntime.isHost;
  button.textContent = gameRuntime.isHost ? 'Play Again' : 'Waiting for host…';
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner) announceWin(winner.name);
}

function showPKFinished(state, gameRuntime) {
  showScreen('pk-results');
  const button = element('pk-btn-play-again');
  button.disabled = !gameRuntime.isHost;
  button.textContent = gameRuntime.isHost ? 'Play Again' : 'Waiting for host…';
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner) announceWin(winner.name);
}

function showBLFinished(state, gameRuntime) {
  showScreen('bl-results');
  const button = element('bl-btn-play-again');
  button.disabled = !gameRuntime.isHost;
  button.textContent = gameRuntime.isHost ? 'Play Again' : 'Waiting for host…';
  const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
  if (winner) announceWin(winner.name);
}

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
    onDisconnected: ({ removed = false, roomDeleted = false } = {}) => {
      if (runtime === candidate) {
        runtime = null;
        activeGameId = null;
        hideVoiceDock();
        showScreen('landing-page');
        if (removed) showToast('The host removed you from the lobby.', 3500);
        else if (roomDeleted) showToast('The room was closed by the host.', 3500);
      }
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
        onState: (state) => { if (state.status === 'playing') showScreen('ppp-gameplay'); },
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
        onState: (state) => { if (state.status === 'playing') showScreen('fm-gameplay'); },
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
        onState: (state) => { if (state.status === 'playing') showScreen('sr-gameplay'); },
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
        onState: (state) => { if (state.status === 'playing') showScreen('pt-gameplay'); },
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
        onState: (state) => { if (state.status === 'betting') showScreen('pk-gameplay'); },
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
        onState: (state) => { if (state.status === 'playing') showScreen('bl-gameplay'); },
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
  element('btn-play-again').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.isHost && runtime.playAgain()));
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
  element('fm-btn-play-again').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.isHost && runtime.playAgain()));
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
  element('sr-btn-play-again').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.isHost && runtime.playAgain()));
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
  element('pt-btn-play-again').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.isHost && runtime.playAgain()));
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
  element('pk-btn-play-again').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.isHost && runtime.playAgain()));
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
  element('bl-btn-play-again').addEventListener('click', (event) => runBusy(event.currentTarget, 'Starting…', () => runtime?.isHost && runtime.playAgain()));
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
  const toast = element('update-toast');
  const message = element('update-message');
  const updateButton = element('update-now');
  const laterButton = element('update-later');
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
      updateButton.textContent = 'Update';
      message.textContent = 'A new version is available.';
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
  { gameId: 'patte-par-patta', buttonId: 'btn-end-game', screenId: 'ppp-gameplay', container: '.game-controls' },
  { gameId: 'flip-and-match', buttonId: 'fm-btn-end-game', screenId: 'fm-gameplay', container: '.game-controls' },
  { gameId: 'simple-rummy', buttonId: 'sr-btn-end-game', screenId: 'sr-gameplay', container: '.game-controls' },
  { gameId: 'perfect-ten', buttonId: 'pt-btn-end-game', screenId: 'pt-gameplay', container: '.game-controls' },
  { gameId: 'poker', buttonId: 'pk-btn-end-game', screenId: 'pk-gameplay', container: '.game-self-controls' },
  { gameId: 'bluff', buttonId: 'bl-btn-end-game', screenId: 'bl-gameplay', container: '.game-self-controls' },
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
    button.title = 'End game';
    button.setAttribute('aria-label', 'End game');
    return { definition, screen, button };
  }).filter(Boolean);

  const syncVisibility = () => {
    controls.forEach(({ definition, screen, button }) => {
      const current = activeGameId === definition.gameId ? runtime : null;
      button.hidden = screen.hidden
        || !current?.connected
        || !current.isHost
        || !isActiveGameState(definition.gameId, current.currentState);
    });
  };
  syncEndGameControlVisibility = syncVisibility;

  controls.forEach(({ definition, screen, button }) => {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const current = runtime;
      if (activeGameId !== definition.gameId
        || !current?.connected
        || !current.isHost
        || !isActiveGameState(definition.gameId, current.currentState)) {
        syncVisibility();
        return;
      }
      const confirmed = await showConfirm('End this game for everyone?', {
        confirmText: 'End game',
        cancelText: 'Keep playing',
      });
      if (!confirmed) return;

      button.disabled = true;
      try {
        await current.leaveRoom({ deleteIfHost: true });
        showToast('Game ended.', 2000);
      } catch (error) {
        console.error(`[CardGamesMP:${definition.gameId}] End game failed`, error);
        showToast(errorMessage(error), 3000);
      } finally {
        button.disabled = false;
        requestAnimationFrame(syncVisibility);
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
  renderLandingPage(AVAILABLE_GAMES, (gameId) => {
    if (gameId === 'patte-par-patta') showScreen('ppp-online-choice');
    if (gameId === 'flip-and-match') showScreen('fm-online-choice');
    if (gameId === 'simple-rummy') showScreen('sr-online-choice');
    if (gameId === 'perfect-ten') showScreen('pt-online-choice');
    if (gameId === 'poker') showScreen('pk-online-choice');
    if (gameId === 'bluff') showScreen('bl-online-choice');
  });
  showScreen('landing-page');
  setupDiagnosticsGesture();
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