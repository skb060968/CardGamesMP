/**
 * Voice Announcer for Card Games Platform
 *
 * Handles voice announcements via Web Speech Synthesis API.
 * Supports mute toggle persisted to localStorage.
 * Follows the same pattern as Tambola's sound-manager.js.
 */

const MUTE_KEY = 'card_games_muted';

// Global flag to disable all speech (used during screen transitions)
let _speechDisabled = false;
// Global flag to disable all sound effects (used during screen transitions)
let _soundsDisabled = false;

const SOUND_FILES = {
  throw: '/sounds/throw.mp3',
  capture: '/sounds/capture.mp3',
};

let audioCtxUnlocked = false;
let audioCtx = null;
const soundBuffers = {};

/**
 * Plays a sound effect by name.
 * @param {string} name - 'throw' or 'capture'
 */
export function playSound(name) {
  if (_soundsDisabled) return; // Don't play if sounds disabled
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;

  // Preferred: AudioContext buffer
  if (audioCtx && audioCtx.state === 'running' && soundBuffers[name]) {
    try {
      const source = audioCtx.createBufferSource();
      source.buffer = soundBuffers[name];
      source.connect(audioCtx.destination);
      source.start(0);
      return;
    } catch (_) {}
  }

  // Fallback: HTML Audio
  try {
    const audio = new Audio(url);
    audio.play().catch(() => {});
  } catch (_) {}
}


/**
 * Speaks a text string via Web Speech Synthesis.
 * Returns a Promise that resolves when speech ends.
 * No-op when muted or Speech Synthesis is unavailable.
 *
 * @param {string} text - The text to speak
 * @returns {Promise<void>}
 */
function speak(text) {
  if (_speechDisabled) return Promise.resolve(); // Don't speak if disabled
  if (isMuted()) return Promise.resolve();
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        // Resume speech synthesis (helps Safari/iOS)
        if (speechSynthesis.paused) speechSynthesis.resume();
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
        setTimeout(resolve, 4000);
      } catch (_) {
        resolve();
      }
    }, 150);
  });
}

/**
 * Cancels all ongoing and queued speech synthesis.
 * Call this when changing screens or cleaning up game state.
 */
export function cancelAllSpeech() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
  } catch (_) {
    // Ignore errors
  }
}

/**
 * Disables all speech output globally. Call before screen transitions.
 */
export function disableSpeech() {
  _speechDisabled = true;
  _soundsDisabled = true; // Also disable sound effects
  cancelAllSpeech();
}

/**
 * Re-enables speech output globally. Call when gameplay resumes.
 */
export function enableSpeech() {
  _speechDisabled = false;
  _soundsDisabled = false; // Also re-enable sound effects
}

/**
 * Pre-warms speech synthesis on user gesture.
 * Call this on every user tap to keep Safari happy.
 */
export function warmSpeech() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const warm = new SpeechSynthesisUtterance('');
    warm.volume = 0;
    speechSynthesis.speak(warm);
    speechSynthesis.cancel();
  } catch (_) {}
}

/**
 * Announces "{playerName} captures!" via Speech Synthesis.
 * @param {string} playerName
 * @returns {Promise<void>}
 */
export function announceCapture(playerName) {
  return speak(`${playerName} captures!`);
}

/**
 * Announces "{playerName} wins the game!" via Speech Synthesis.
 * @param {string} playerName
 * @returns {Promise<void>}
 */
export function announceWin(playerName) {
  return speak(`${playerName} wins the game!`);
}

/**
 * Toggles the mute state and persists it to localStorage.
 * @returns {boolean} The new mute state (true = muted)
 */
export function toggleMute() {
  const newMuted = !isMuted();
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify(newMuted));
  } catch (_) {
    // localStorage full or unavailable — continue without persistence
  }
  return newMuted;
}

/**
 * Reads the current mute state from localStorage.
 * @returns {boolean} true if muted, false otherwise (defaults to false)
 */
export function isMuted() {
  try {
    const stored = localStorage.getItem(MUTE_KEY);
    if (stored !== null) {
      return JSON.parse(stored) === true;
    }
  } catch (_) {
    // Corrupted or unavailable localStorage — default to unmuted
  }
  return false;
}

/**
 * Attaches unlock listeners for AudioContext on first user interaction.
 * Handles click, touchstart, and keydown events with { once: true }.
 */
export function initAudio() {
  if (audioCtxUnlocked) return;
  if (typeof document === 'undefined') return;

  const unlock = () => {
    audioCtxUnlocked = true;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      try {
        audioCtx = new AudioCtx();
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        // Preload sound buffers
        Object.entries(SOUND_FILES).forEach(([name, url]) => {
          fetch(url)
            .then((res) => res.arrayBuffer())
            .then((buf) => audioCtx.decodeAudioData(buf))
            .then((decoded) => { soundBuffers[name] = decoded; })
            .catch(() => {});
        });
      } catch (_) {}
    }
  };

  const events = ['click', 'touchstart', 'keydown'];
  for (const event of events) {
    document.addEventListener(event, unlock, { once: true });
  }
}
