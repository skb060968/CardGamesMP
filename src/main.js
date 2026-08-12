import '../style.css';
import './cardgamesmp.css';
import * as pppRules from './games/patte-par-patta/engine.js';
import * as fmRules from './games/flip-and-match/engine.js';
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
import { renderCardFace } from './shared/card-renderer.js';
import {
  announceCapture, announceWin, initAudio, isMuted,
  playSound, toggleMute, warmSpeech,
} from './shared/voice-announcer.js';
import { createShareHandler, showQRCode } from './deep-link-handler.js';
import { renderLandingPage, showScreen, showToast } from './platform-ui.js';
import { createPatteParPattaEffects, createPatteParPattaRuntime } from './games/patte-par-patta/index.js';
import { createFlipAndMatchEffects, createFlipAndMatchRuntime } from './games/flip-and-match/index.js';
import { createFirebaseClient } from './platform/firebase-client.js';
import { createServiceWorkerUpdateClient } from './platform/service-worker-update.js';
import { GAMES } from './games/registry.js';

const AVAILABLE_IDS = new Set(['patte-par-patta', 'flip-and-match']);
const AVAILABLE_GAMES = GAMES.map((game) => ({ ...game, available: AVAILABLE_IDS.has(game.id) }));
const element = (id) => document.getElementById(id);
const selectedEmoji = (screenId) =>
  document.querySelector(`#${screenId} .emoji-btn.selected`)?.dataset.emoji || '👲';

let runtime = null;
let activeGameId = null;
let firebaseClientPromise = null;
function errorMessage(error) {
  const messages = {
    'room-not-found': 'Room not found.',
    'room-full': 'Room is full.',
    'room-not-joinable': 'This round has already started.',
    'revision-conflict': 'Game advanced on another device. State refreshed.',
    'wrong-turn': 'It is not your turn.',
  };
  return messages[error?.code] || error?.message || 'Something went wrong.';
}

function roomEntries(room) {
  return Object.entries(room.players || {})
    .filter(([, player]) => player?.name)
    .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)));
}

function renderPPPLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room);
  element('lobby-room-code').textContent = roomCode;
  renderPPPLobbyPlayers(entries.map(([, player]) => player), false, entries.map(([key]) => key));
  element('btn-start-online').hidden = !isHost;
  element('lobby-waiting').hidden = isHost;
  showScreen('ppp-lobby');
}

function renderFMLobby({ room, roomCode, isHost }) {
  const entries = roomEntries(room);
  element('fm-lobby-room-code').textContent = roomCode;
  renderFMLobbyPlayers(entries.map(([, player]) => player), false, entries.map(([key]) => key));
  element('fm-btn-start-online').hidden = !isHost;
  element('fm-lobby-waiting').hidden = isHost;
  showScreen('fm-lobby');
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

async function firebaseClient() {
  if (!firebaseClientPromise) firebaseClientPromise = createFirebaseClient();
  return firebaseClientPromise;
}

async function buildRuntime(gameId) {
  const client = await firebaseClient();
  let candidate;
  const commonCallbacks = {
    onPlayer: () => candidate?.refresh(),
    onError: (error) => {
      console.error(`[CardGamesMP:${gameId}]`, error);
      showToast(errorMessage(error), 3000);
    },
    onDisconnected: () => {
      if (runtime === candidate) {
        runtime = null;
        activeGameId = null;
        showScreen('landing-page');
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
async function runBusy(button, busyText, operation) {
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await operation();
  } catch (error) {
    console.error('[CardGamesMP]', error);
    showToast(errorMessage(error), 3000);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
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
  if (current?.connected) await current.leaveRoom();
  else await current?.close();
  showScreen('landing-page');
}

function wirePPP() {
  element('btn-create-room').addEventListener('click', () => showScreen('ppp-create-room'));
  element('btn-join-room').addEventListener('click', () => showScreen('ppp-join-room'));
  element('btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('btn-back-create').addEventListener('click', () => showScreen('ppp-online-choice'));
  element('btn-back-join').addEventListener('click', () => showScreen('ppp-online-choice'));

  element('btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('create-name-input').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await (await ensureRuntime('patte-par-patta')).createRoom({
      player: { name, emoji: selectedEmoji('ppp-create-room') },
    });
  }));
  element('btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = element('room-code-input').value.trim().toUpperCase();
    const name = element('join-name-input').value.trim();
    if (roomCode.length !== 6) throw new Error('Enter a valid 6-character room code.');
    if (!name) throw new Error('Please enter your name.');
    await (await ensureRuntime('patte-par-patta')).joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('ppp-join-room') },
    });
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
  const mute = element('mute-toggle');
  mute.checked = isMuted();
  mute.addEventListener('change', () => { mute.checked = toggleMute(); });
}
function wireFlipAndMatch() {
  element('fm-btn-create-room').addEventListener('click', () => showScreen('fm-create-room'));
  element('fm-btn-join-room').addEventListener('click', () => showScreen('fm-join-room'));
  element('fm-btn-back-online').addEventListener('click', () => showScreen('landing-page'));
  element('fm-btn-back-create').addEventListener('click', () => showScreen('fm-online-choice'));
  element('fm-btn-back-join').addEventListener('click', () => showScreen('fm-online-choice'));

  element('fm-btn-create-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Creating…', async () => {
    const name = element('fm-create-name').value.trim();
    if (!name) throw new Error('Please enter your name.');
    await (await ensureRuntime('flip-and-match')).createRoom({
      player: { name, emoji: selectedEmoji('fm-create-room') },
    });
  }));
  element('fm-btn-join-submit').addEventListener('click', (event) => runBusy(event.currentTarget, 'Joining…', async () => {
    const roomCode = element('fm-room-code').value.trim().toUpperCase();
    const name = element('fm-join-name').value.trim();
    if (roomCode.length !== 6) throw new Error('Enter a valid 6-character room code.');
    if (!name) throw new Error('Please enter your name.');
    await (await ensureRuntime('flip-and-match')).joinRoom({
      roomCode, player: { name, emoji: selectedEmoji('fm-join-room') },
    });
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
  const mute = element('fm-mute-toggle');
  mute.checked = isMuted();
  mute.addEventListener('change', () => { mute.checked = toggleMute(); });
}

async function restoreSession() {
  for (const gameId of AVAILABLE_IDS) {
    const candidate = await buildRuntime(gameId);
    if (await candidate.restoreSession()) {
      runtime = candidate;
      activeGameId = gameId;
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
async function bootstrap() {
  initAudio();
  wireEmojiPickers();
  wirePPP();
  wireFlipAndMatch();
  renderLandingPage(AVAILABLE_GAMES, (gameId) => {
    if (gameId === 'patte-par-patta') showScreen('ppp-online-choice');
    if (gameId === 'flip-and-match') showScreen('fm-online-choice');
  });
  showScreen('landing-page');
  setupServiceWorkerUpdates().catch((error) => console.warn('[CardGamesMP] Service worker unavailable:', error));

  const params = new URLSearchParams(location.search);
  const linkedRoom = params.get('room')?.trim().toUpperCase();
  const linkedGame = AVAILABLE_IDS.has(params.get('game')) ? params.get('game') : 'patte-par-patta';
  if (linkedRoom) {
    const isFlipAndMatch = linkedGame === 'flip-and-match';
    element(isFlipAndMatch ? 'fm-room-code' : 'room-code-input').value = linkedRoom;
    history.replaceState({}, '', location.pathname);
    showScreen(isFlipAndMatch ? 'fm-join-room' : 'ppp-join-room');
    return;
  }

  try {
    await restoreSession();
  } catch (error) {
    console.warn('[CardGamesMP] Session restoration unavailable:', error);
  }
}

bootstrap();