function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

export async function executeCommittedAction({
  signal,
  prepare,
  commit,
  animate = async () => {},
  publish,
  onAnimationError = console.warn,
}) {
  requireFunction(prepare, 'prepare');
  requireFunction(commit, 'commit');
  requireFunction(animate, 'animate');
  requireFunction(publish, 'publish');
  requireFunction(onAnimationError, 'onAnimationError');

  if (signal?.aborted) throw new Error('Action cancelled before preparation');
  const prepared = await prepare();
  if (signal?.aborted) throw new Error('Action cancelled before commit');

  const committed = await commit(prepared);
  let animationError = null;
  try {
    await animate(prepared, committed, { signal });
  } catch (error) {
    animationError = error;
  } finally {
    // A successful authoritative commit must always reach local state, even
    // when an animation is interrupted, removed, or fails to render.
    await publish(prepared, committed);
  }

  if (animationError) {
    try { onAnimationError(animationError); } catch (_) {}
  }
  return committed;
}