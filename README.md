# CardGamesMP hardened scaffold

This is a parallel implementation. The working application in the parent folder remains unchanged; proven parent rule, UI, audio, CSS, and resource modules are imported read-only while synchronization and runtime orchestration are rebuilt here.

## Current foundation

- Six-game registry using the existing images in `../public`.
- Existing `../style.css` is bundled without copying it.
- Shared card-action entry points for draw, flip, throw, discard, and collect.
- Commit-safe action execution that always publishes authoritative state after a successful write.
- Stable, immutable rank/suit sorting with configurable Ace-low or Ace-high policy.
- One action coordinator per active game session.
- Duplicate Firebase echoes can be rejected by `moveId`.
- The newest remote snapshot is retained while a local action or animation is active.
- Session disposal aborts pending cooperative steps.

## Migration rules

1. Preserve each game's existing rule engine and visual timing during its first migration.
2. Pass explicit ordered steps to card actions; do not impose one global write/animation order.
3. Every synchronized move must have a stable `moveId` and monotonic revision.
4. Firebase adapters validate identity and authority before controllers receive state.
5. Transactional writes must compare the expected revision and validate the complete game-specific transition.
6. Animations may render state but never become the source of authoritative game state.
7. Migrate and validate one game at a time; do not modify the legacy platform as part of migration.

## Patte Par Patta vertical slice

`createPatteParPattaThrowAction` now owns the hardened throw pipeline while keeping game rules, Firebase, and visual effects injectable. Its fixed safety boundary is:

1. Check turn and hand index, derive and validate the next state.
2. Commit with `moveId` and `expectedRevision`.
3. Run the existing throw animation, followed by capture animation when applicable.
4. Publish authoritative committed state and render it even if animation fails.

## Transactional room lifecycle

`createFirebaseRoomStore` now provides collision-safe creation, transactional joining with stable reusable slots, selective room subscriptions, reconnect-safe presence, ownership-checked leave, host-only deletion/reset, and revision-protected move commits under the isolated `card-games-mp` namespace.

## Authentication and visual effects

`createFirebaseClient` validates configuration and establishes an authenticated Firebase user before any room store is created. Patte Par Patta now has an injected visual-effects adapter built on cancellation-safe shared DOM helpers while retaining the established throw, flip, shake, and sweep timings. Temporary elements and CSS classes are removed even when navigation aborts an animation.

## Patte Par Patta runtime

`createPatteParPattaRuntime` now composes authenticated room storage, stable room-slot to game-player mapping, create/join/restore flows, reconnect presence, selective move reconciliation, local and remote throw playback, host-controlled round creation, Play Again, leave/delete behavior, session persistence, and deterministic teardown. New joins are blocked during active rounds while existing UIDs can reconnect.

## Browser-playable vertical slice

The isolated entry point now wires the hardened runtime to the proven Patte Par Patta engine, UI renderer, audio, sharing, QR, CSS, and visual resources as read-only imports. The new page provides landing, create, join, lobby, gameplay, results, session restoration, deep-link joining, mute, share, QR, host round start, Play Again, and leave/home flows. Other game cards remain explicitly unavailable.

## Flip & Match vertical slice

Flip & Match is now the second browser-playable hardened game. It uses a revision-protected `commitFlip` transaction, independent transition replay, stable room-slot mapping, queued remote reconciliation, cancellation-safe reveal/match collection effects, six-character rooms, deep links, session restoration, host start/Play Again, and the existing rules/UI/audio/assets as read-only imports.

## Hardened PWA lifecycle

The isolated build emits `public-new/sw.js` as `/sw.js` instead of using the legacy auto-activating worker. Updates remain waiting until the user chooses Update. The toast shows an `Updating…` progress state, disables duplicate actions, waits for the active runtime action/animation to finish, and then reloads on `controllerchange`. The worker uses a network-first shell and retains a cached root page for offline navigation.

A dedicated, undeployed `CardGamesMP/firebase-rules.json` defines the isolated namespace and validates authenticated creation, waiting-room joins, immutable player identities, host lifecycle changes, stable slots, revisions, throw/flip move shapes, and presence. It does not modify production rules.

## Next slices

Migrate Simple Rummy and Perfect Ten using their existing hardened draw/discard action modules, then migrate Bluff and Poker. Shared ready/Play Again coordination and explicit host kick/end-game operations also remain to be implemented.