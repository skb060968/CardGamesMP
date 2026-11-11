/**
 * Receiver-side guard for remote game updates (shared by every game runtime).
 *
 * The security rules only check the shape of a move, so a seated player could
 * write any outcome. Before a runtime adopts a remote `room.game` it asks
 * `allow(previousState, room)`: the room store re-runs the game's transition
 * validator for a single N → N+1 step in the same round. A failed check keeps
 * the last good state, stops the game on this device (`halted`) and reports
 * once through `onInvalid`. The halt lifts when the host (or the offline-host
 * inheritor) starts a new round, i.e. `meta/resetAt` changes.
 *
 * `adopt(room)` must be called whenever the runtime takes its state from a
 * room snapshot, so the gate knows which round the held state belongs to.
 */
export function createRemoteGate({ verify, onInvalid } = {}) {
  if (typeof verify !== 'function') throw new TypeError('verify must be a function');
  let round = null;
  let halted = null;

  const roundOf = (room) => room?.meta?.resetAt ?? null;

  return {
    adopt(room) {
      round = roundOf(room);
      if (halted && halted.round !== round) halted = null;
    },

    allow(previousState, room) {
      const roomRound = roundOf(room);
      if (halted) {
        if (roomRound === halted.round) return false;
        halted = null;
      }
      let verdict;
      try {
        verdict = verify({ previousState, previousRound: round, room });
      } catch (error) {
        // A bug in the check itself must never stop honest play.
        console.warn('[CardGamesMP] remote transition check failed to run', error);
        return true;
      }
      if (verdict?.valid !== false) return true;
      halted = { round: roomRound, reason: verdict.reason || 'invalid-transition' };
      try {
        onInvalid?.({ reason: halted.reason, move: room?.lastMove ?? null });
      } catch (_) { /* the caller owns its own error reporting */ }
      return false;
    },

    get halted() { return halted !== null; },
    get reason() { return halted?.reason ?? null; },
  };
}
