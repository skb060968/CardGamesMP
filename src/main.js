import '../style.css';
import './cardgamesmp.css';
import * as pppRules from './games/patte-par-patta/engine.js';
import * as fmRules from './games/flip-and-match/engine.js';
import * as srRules from './games/simple-rummy/engine.js';
import * as ptRules from './games/perfect-ten/engine.js';
import * as pkRules from './games/poker/engine.js';
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
import { renderCardBack, renderCardFace } from './shared/card-renderer.js';
import {
  announceCapture, announceWin, initAudio, isMuted,
  playSound, toggleMute, warmSpeech,
} from './shared/voice-announcer.js';
import { createShareHandler, showQRCode } from './deep-link-handler.js';
import { normalizeRoomCode } from './core/room-code.js';
import { renderLandingPage, showScreen, showToast } from './platform-ui.js';
import { createPatteParPattaEffects, createPatteParPattaRuntime } from './games/patte-par-patta/index.js';
import { createFlipAndMatchEffects, createFlipAndMatchRuntime } from './games/flip-and-match/index.js';
import { createSimpleRummyEffects, createSimpleRummyRuntime } from './games/simple-rummy/index.js';
import { createPerfectTenEffects, createPerfectTenRuntime } from './games/perfect-ten/index.js';
import { createPokerEffects, createPokerRuntime } from './games/poker/index.js';
import { createFirebaseClient } from './platform/firebase-client.js';
import { createServiceWorkerUpdateClient } from './platform/service-worker-update.js';
import { GAMES } from './games/registry.js';

const AVAILABLE_IDS = new Set(['patte-par-patta', 'flip-and-match', 'simple-rummy', 'perfect-ten', 'poker']);
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
    'identity-already-in-room': 'This browser tab is already a player in this room. Open the join link in a new tab or another device.',
    'room-not-waiting': 'Players can only be removed while waiting in the lobby.',
    'player-not-found': 'That player has already left.',
    'player-identity-mismatch': 'The lobby changed. Please try again.',
    'cannot-remove-host': 'The host cannot be removed.',
    'roster-conflict': 'The player list changed. Review the lobby and start again.',
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
      showToast(errorMessage(error), 3000);
    },
    onDisconnected: ({ removed = false, roomDeleted = false } = {}) => {
      if (runtime === candidate) {
        runtime = null;
        activeGameId = null;
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
    return await operation(activeRuntime);
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
    showToast(errorMessage(error), 3000);
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
  const mute = element('mute-toggle');
  mute.checked = isMuted();
  mute.addEventListener('change', () => { mute.checked = toggleMute(); });
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
  const mute = element('fm-mute-toggle');
  mute.checked = isMuted();
  mute.addEventListener('change', () => { mute.checked = toggleMute(); });
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
  const mute = element('sr-mute-toggle');
  mute.checked = isMuted();
  mute.addEventListener('change', () => { mute.checked = toggleMute(); });
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
  const mute = element('pt-mute-toggle');
  mute.checked = isMuted();
  mute.addEventListener('change', () => { mute.checked = toggleMute(); });
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
  const mute = element('pk-mute-toggle');
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
  wireSimpleRummy();
  wirePerfectTen();
  wirePoker();
  renderLandingPage(AVAILABLE_GAMES, (gameId) => {
    if (gameId === 'patte-par-patta') showScreen('ppp-online-choice');
    if (gameId === 'flip-and-match') showScreen('fm-online-choice');
    if (gameId === 'simple-rummy') showScreen('sr-online-choice');
    if (gameId === 'perfect-ten') showScreen('pt-online-choice');
    if (gameId === 'poker') showScreen('pk-online-choice');
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