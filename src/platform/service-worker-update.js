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

  async function applyUpdate({ reload = true } = {}) {
    waiting = registration.waiting || waiting;
    if (!waiting) return false;
    const changed = new Promise((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    waiting.postMessage({ type: 'SKIP_WAITING' });
    await changed;
    if (reload) location.reload();
    return true;
  }

  function dispose() {
    disposed = true;
    registration.removeEventListener('updatefound', onUpdateFound);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (waiting && navigator.serviceWorker.controller) onUpdateAvailable({ apply: applyUpdate, registration });
  return { registration, applyUpdate, dispose, get updateWaiting() { return Boolean(registration.waiting || waiting); } };
}
