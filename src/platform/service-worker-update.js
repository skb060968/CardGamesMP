const CONTROLLER_CHANGE_FALLBACK_MS = 5000;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export async function createServiceWorkerUpdateClient(options = {}) {
  if (!('serviceWorker' in navigator)) return null;
  const { scriptUrl = '/sw.js', scope = '/', signal, onUpdateAvailable = () => {} } = options;
  const registration = await navigator.serviceWorker.register(scriptUrl, { scope });
  let waiting = registration.waiting;
  let disposed = false;

  const announce = (worker) => {
    if (!disposed && worker?.state === 'installed' && navigator.serviceWorker.controller) {
      waiting = worker;
      onUpdateAvailable({ apply: applyUpdate, registration });
    }
  };
  const onUpdateFound = () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => announce(worker), { signal });
  };
  registration.addEventListener('updatefound', onUpdateFound, { signal });
  // Platform standard: check for a new worker every 5 minutes.
  const updateTimer = setInterval(() => {
    Promise.resolve().then(() => registration.update()).catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);

  async function applyUpdate({ reload = true } = {}) {
    waiting = registration.waiting || waiting;
    if (!waiting) return false;
    const changed = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      // Safety net (platform standard): reload anyway if the new worker never takes control.
      setTimeout(resolve, CONTROLLER_CHANGE_FALLBACK_MS);
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    await changed;
    if (reload) location.reload();
    return true;
  }

  function dispose() {
    disposed = true;
    clearInterval(updateTimer);
    registration.removeEventListener('updatefound', onUpdateFound);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (waiting && navigator.serviceWorker.controller) onUpdateAvailable({ apply: applyUpdate, registration });
  return { registration, applyUpdate, dispose, get updateWaiting() { return Boolean(registration.waiting || waiting); } };
}
