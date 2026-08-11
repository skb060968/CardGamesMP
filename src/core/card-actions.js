function createCardAction(type) {
  return (coordinator, { moveId = null, steps = [] } = {}) => {
    if (!coordinator?.runLocal) throw new TypeError('A valid action coordinator is required');
    if (!Array.isArray(steps) || steps.some((step) => typeof step !== 'function')) {
      throw new TypeError(`${type} steps must be functions`);
    }
    return coordinator.runLocal({ type, moveId, steps });
  };
}

export const drawCard = createCardAction('draw-card');
export const flipCard = createCardAction('flip-card');
export const throwCard = createCardAction('throw-card');
export const discardCard = createCardAction('discard-card');
export const collectCards = createCardAction('collect-cards');