/**
 * Voice Announcer for Card Games Platform
 *
 * Handles voice announcements via Web Speech Synthesis API.
 * Supports mute toggle persisted to localStorage.
 * Follows the same pattern as Tambola's sound-manager.js.
 */

const MUTE_KEY = 'card_games_muted';

/**
 * English voice selection.
 *
 * The Web Speech API can only use voices from the TTS engine the device has selected in
 * system settings; it cannot switch engines (e.g. force Google over Samsung). What it CAN
 * do is pick the best voice among those the engine exposes, instead of letting the OS fall
 * back to its default — which on many phones is a low-quality "compact" voice, or a
 * wrong-locale one. We prefer Google / neural voices, English (India) then (US/UK/any),
 * and avoid the "compact"/"eloquence" voices that mispronounce words.
 */
const EN_LANG = 'en-IN';           // preferred spoken locale for the English announcements
let _enVoice = null;

function _scoreVoice(v) {
  const n = (v.name || '').toLowerCase();
  const lang = (v.lang || '').replace('_', '-').toLowerCase();
  if (!/^en-/.test(lang)) return -100;                 // English only
  let s = 0;
  if (/compact|eloquence/.test(n)) s -= 50;            // the robotic ones
  if (/natural|neural/.test(n)) s += 6;                // Microsoft/Edge "Natural"
  if (/google/.test(n)) s += 5;                        // Google TTS neural
  if (/siri|enhanced|premium/.test(n)) s += 5;         // Apple enhanced
  if (!v.localService) s += 3;                         // network/cloud voice
  if (lang === 'en-in') s += 3;                        // match our preferred locale
  else if (lang === 'en-us' || lang === 'en-gb') s += 1;
  return s;
}

function pickEnglishVoice() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;
  let best = null, bestScore = -Infinity;
  for (const v of voices) {
    const s = _scoreVoice(v);
    if (s > bestScore) { bestScore = s; best = v; }
  }
  return bestScore > -100 ? best : null;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  // getVoices() is empty until the list loads asynchronously; refresh on voiceschanged.
  _enVoice = pickEnglishVoice();
  try {
    speechSynthesis.addEventListener('voiceschanged', () => { _enVoice = pickEnglishVoice(); });
  } catch (_) {
    speechSynthesis.onvoiceschanged = () => { _enVoice = pickEnglishVoice(); };
  }
}

// Keeps mute functional for the current session if localStorage is unavailable.
let _mutedFallback = false;
let _useMuteFallback = false;

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
function speak(text, lang) {
  if (_speechDisabled) return Promise.resolve(); // Don't speak if disabled
  if (isMuted()) return Promise.resolve();
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      if (_speechDisabled || isMuted()) {
        resolve();
        return;
      }
      try {
        // Resume speech synthesis (helps Safari/iOS)
        if (speechSynthesis.paused) speechSynthesis.resume();
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        if (lang) {
          utterance.lang = lang;                       // caller-specified (e.g. Bluff's hi-IN) wins
        } else {
          // English announcements: force a sensible locale and the best voice we found,
          // rather than the device default which is often the compact/mispronouncing one.
          if (!_enVoice) _enVoice = pickEnglishVoice();
          if (_enVoice) utterance.voice = _enVoice;
          utterance.lang = (_enVoice && _enVoice.lang) || EN_LANG;
        }
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

const BLUFF_SPOKEN_RANK = Object.freeze({
  A: 'इक्के', '2': 'दुक्की', '3': 'तिक्की', '4': 'चौकी', '5': 'पंजी',
  '6': 'छक्की', '7': 'सत्ती', '8': 'अट्ठी', '9': 'नहली', '10': 'दहली',
  J: 'गुलाम', Q: 'रानी', K: 'राजा',
});
const BLUFF_SPOKEN_COUNT = Object.freeze({ 1: 'एक', 2: 'दो', 3: 'तीन', 4: 'चार' });

export function announceBluffPlacement(count, rank) {
  const spokenCount = BLUFF_SPOKEN_COUNT[count];
  const spokenRank = count === 1 && rank === 'A' ? 'इक्का' : BLUFF_SPOKEN_RANK[rank];
  if (!spokenCount || !spokenRank) return Promise.resolve();
  return speak(`${spokenCount} ${spokenRank}`, 'hi-IN');
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
  _mutedFallback = newMuted;
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify(newMuted));
    _useMuteFallback = false;
  } catch (_) {
    // Preserve the selected state for this page session when storage is unavailable.
    _useMuteFallback = true;
  }
  if (newMuted) cancelAllSpeech();
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('cardgames:mutechange', {
      detail: { muted: newMuted },
    }));
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
      _mutedFallback = JSON.parse(stored) === true;
      _useMuteFallback = false;
      return _mutedFallback;
    }
    if (!_useMuteFallback) _mutedFallback = false;
  } catch (_) {
    // Keep the in-memory state when storage is corrupted or unavailable.
    _useMuteFallback = true;
  }
  return _mutedFallback;
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
