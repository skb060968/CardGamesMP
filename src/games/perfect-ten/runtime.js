import { createSimpleRummyRuntime } from '../simple-rummy/runtime.js';
import { createPerfectTenDrawAction } from './draw-action.js';
import { createPerfectTenDiscardAction } from './discard-action.js';
import { createPerfectTenDrawTransitionValidator } from './draw-transition.js';
import { createPerfectTenDiscardTransitionValidator } from './discard-transition.js';

export function createPerfectTenRuntime(options) {
  return createSimpleRummyRuntime({
    ...options,
    gameId: 'perfect-ten',
    includeWinGroups: false,
    createDrawAction: createPerfectTenDrawAction,
    createDiscardAction: createPerfectTenDiscardAction,
    createDrawTransitionValidator: createPerfectTenDrawTransitionValidator,
    createDiscardTransitionValidator: createPerfectTenDiscardTransitionValidator,
  });
}
