/**
 * Runtime side of the standard out-of-turn moves (pairs with
 * `out-of-turn-transition.js`). Builds the deterministic next state with the
 * engine and hands it to the store, which re-checks presence in-transaction.
 *
 *   skipStalledTurn()  watchdog — advance past the offline current player
 *   claimWin()         everyone else offline — end the round as winner
 */
function moveId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createOutOfTurnMoves({
  rules, getStore, getState, getActorIndex, afterCommit, activeStatus = 'playing',
}) {
  async function commit(kind) {
    const store = getStore();
    const state = getState();
    const actorIndex = getActorIndex();
    if (!store) throw new Error('Room is not connected');
    if (!state || state.status !== activeStatus) throw new Error('No round in progress');
    if (!Number.isInteger(actorIndex) || actorIndex < 0) throw new Error('Player is not seated in the active round');
    const produced = kind === 'skip-turn' ? rules.skipTurn(state) : rules.claimWin(state, actorIndex);
    // Some engines bump `revision` themselves (Bluff); the rest leave it to us.
    const nextState = produced.revision === state.revision + 1
      ? produced
      : { ...produced, revision: state.revision + 1 };
    const payload = { moveId: moveId(), expectedRevision: state.revision, actorIndex, state: nextState };
    const result = kind === 'skip-turn' ? await store.commitSkip(payload) : await store.commitClaim(payload);
    await afterCommit?.(result);
    return result;
  }
  return Object.freeze({
    skipStalledTurn: () => commit('skip-turn'),
    claimWin: () => commit('claim-win'),
  });
}
