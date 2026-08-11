const MAX_SEEN_MOVES = 100;

export function createActionCoordinator({ applyRemote, onError = console.error } = {}) {
  if (typeof applyRemote !== 'function') throw new TypeError('applyRemote is required');

  let active = false;
  let disposed = false;
  let queuedRemote = null;
  const lifecycle = new AbortController();
  const seenMoveIds = new Set();

  const remember = (moveId) => {
    if (!moveId) return;
    seenMoveIds.add(moveId);
    if (seenMoveIds.size > MAX_SEEN_MOVES) seenMoveIds.delete(seenMoveIds.values().next().value);
  };

  const run = async ({ type = 'action', moveId = null, steps = [] }) => {
    if (disposed || active) return { ok: false, reason: disposed ? 'disposed' : 'busy' };
    active = true;
    try {
      for (const step of steps) {
        if (lifecycle.signal.aborted) throw new Error('Action cancelled');
        await step({ signal: lifecycle.signal, type, moveId });
      }
      remember(moveId);
      return { ok: true };
    } catch (error) {
      onError(error, { type, moveId });
      return { ok: false, error };
    } finally {
      active = false;
      if (queuedRemote && !disposed) {
        const next = queuedRemote;
        queuedRemote = null;
        queueMicrotask(() => acceptRemote(next));
      }
    }
  };

  const acceptRemote = (snapshot) => {
    if (!snapshot || disposed || seenMoveIds.has(snapshot.moveId)) return Promise.resolve({ ok: false });
    if (active) { queuedRemote = snapshot; return Promise.resolve({ ok: true, queued: true }); }
    return run({
      type: 'remote',
      moveId: snapshot.moveId,
      steps: [({ signal, type, moveId }) => applyRemote(snapshot, { signal, type, moveId })],
    });
  };

  return {
    runLocal: run,
    acceptRemote,
    get busy() { return active; },
    dispose() { disposed = true; queuedRemote = null; lifecycle.abort(); },
  };
}