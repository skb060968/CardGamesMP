/**
 * On-device diagnostics ring buffer.
 *
 * Field failures on players' phones are otherwise invisible: a Firebase
 * `permission_denied`, a `revision-conflict`, or a transient network drop all
 * surface to the player as the same friendly toast. This module records the
 * precise classification and context of each failure to localStorage so an
 * operator can open the on-screen viewer on any phone and see (or copy) exactly
 * what went wrong, without changing the player-facing messages.
 *
 * It is intentionally dependency-free and never throws into callers.
 */

const STORAGE_KEY = 'cardgamesmp-diagnostics';
const MAX_ENTRIES = 80;

function readEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeEntries(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch (_) {
    // Storage full or unavailable — diagnostics must never break the app.
  }
}

/**
 * Records a single diagnostic entry.
 * @param {{game?: string|null, label?: string, codes?: string[], detail?: string}} entry
 */
export function recordDiagnostic(entry = {}) {
  try {
    const entries = readEntries();
    entries.push({
      t: new Date().toISOString(),
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      game: entry.game || null,
      label: entry.label || '',
      codes: Array.isArray(entry.codes) ? entry.codes.slice(0, 12) : [],
      detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 300) : '',
    });
    writeEntries(entries);
  } catch (_) {
    // Never propagate diagnostics failures.
  }
}

export function getDiagnostics() {
  return readEntries();
}

export function clearDiagnostics() {
  writeEntries([]);
}

export function formatDiagnostics() {
  const entries = readEntries();
  if (!entries.length) return 'No diagnostics recorded yet.';
  return entries
    .slice()
    .reverse()
    .map((entry) => {
      const when = entry.t || '?';
      const net = entry.online === false ? 'OFFLINE' : entry.online === true ? 'online' : 'net?';
      const game = entry.game || '-';
      const codes = (entry.codes || []).join(' / ') || '-';
      const detail = entry.detail ? ` :: ${entry.detail}` : '';
      return `${when} [${net}] ${game}\n  ${entry.label || ''} :: ${codes}${detail}`;
    })
    .join('\n\n');
}

/**
 * Installs global handlers so uncaught errors and unhandled promise rejections
 * are recorded to the on-device log — the app's own `errorMessage()` choke point
 * only captures failures that reach a toast, so this is the net for render-time
 * crashes and stray rejections that would otherwise only appear in a console.
 * Idempotent and dependency-free; recording never throws.
 */
export function installGlobalErrorCapture() {
  if (typeof window === 'undefined' || window.__cardgamesmpErrorCapture) return;
  window.__cardgamesmpErrorCapture = true;

  window.addEventListener('error', (event) => {
    const error = event?.error;
    const where = event?.filename
      ? `${event.filename}:${event.lineno ?? '?'}:${event.colno ?? '?'}`
      : '';
    recordDiagnostic({
      label: 'uncaught-error',
      codes: error?.name ? [error.name] : [],
      detail: (error && (error.stack || error.message)) || event?.message || where,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    const codes = [];
    if (reason?.name) codes.push(reason.name);
    if (typeof reason?.code === 'string') codes.push(reason.code);
    recordDiagnostic({
      label: 'unhandled-rejection',
      codes,
      detail: (reason && (reason.stack || reason.message)) || String(reason),
    });
  });
}
