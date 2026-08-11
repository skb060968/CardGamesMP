export function createLifecycleScope() {
  const controller = new AbortController();
  const cleanups = [];
  let disposed = false;

  function registerCleanup(cleanup) {
    if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
    if (disposed) {
      cleanup();
      return () => {};
    }
    cleanups.push(cleanup);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = cleanups.indexOf(cleanup);
      if (index >= 0) cleanups.splice(index, 1);
    };
  }

  function dispose(reason = new DOMException('Scope disposed', 'AbortError')) {
    if (disposed) return [];
    disposed = true;
    controller.abort(reason);
    const errors = [];
    while (cleanups.length) {
      try { cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    return errors;
  }

  return {
    signal: controller.signal,
    registerCleanup,
    dispose,
    get disposed() { return disposed; }
  };
}
