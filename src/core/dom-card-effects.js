function abortError(signal) {
  return signal?.reason || new DOMException('Animation cancelled', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

export function delay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function aborted() { clearTimeout(timer); cleanup(); reject(abortError(signal)); }
    function cleanup() { signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function nextFrame(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame(done);
    function done() { cleanup(); resolve(); }
    function aborted() { cancelAnimationFrame(frame); cleanup(); reject(abortError(signal)); }
    function cleanup() { signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export async function animateThrowToPile({
  document: documentRef = globalThis.document,
  deckRect,
  pileRect,
  faceElement,
  signal,
}) {
  if (prefersReducedMotion()) return;
  throwIfAborted(signal);
  if (!documentRef?.body || !deckRect || !pileRect) return;

  const floater = documentRef.createElement('div');
  floater.className = 'card throw-floater';
  Object.assign(floater.style, {
    position: 'fixed', left: `${deckRect.left}px`, top: `${deckRect.top}px`,
    width: `${deckRect.width}px`, height: `${deckRect.height}px`, zIndex: '100',
    transition: 'left 300ms ease-out, top 300ms ease-out',
    transformStyle: 'preserve-3d', perspective: '600px',
  });


  const back = documentRef.createElement('div');
  back.className = 'card-back';
  Object.assign(back.style, { width: '100%', height: '100%' });
  floater.appendChild(back);
  documentRef.body.appendChild(floater);

  try {
    await nextFrame(signal);
    void floater.offsetWidth;
    await nextFrame(signal);
    floater.style.left = `${pileRect.left + (pileRect.width - deckRect.width) / 2}px`;
    floater.style.top = `${pileRect.top + (pileRect.height - deckRect.height) / 2}px`;
    await delay(320, signal);
    floater.style.transition = 'transform 400ms ease-in-out';
    floater.style.transform = 'rotateY(90deg)';
    await delay(200, signal);
    floater.replaceChildren();
    if (faceElement) floater.appendChild(faceElement.cloneNode(true));
    floater.style.transform = 'rotateY(0deg)';
    await delay(200, signal);
  } finally {
    floater.remove();
  }
}

export async function shakeElement({ element, className, duration, signal }) {
  if (!element || prefersReducedMotion()) return;
  element.classList.add(className);
  try {
    await delay(duration, signal);
  } finally {
    element.classList.remove(className);
  }
}

export async function animateElementSweep({ element, targetRect, duration = 1200, signal }) {
  if (!element || !targetRect || prefersReducedMotion()) return;
  const fromRect = element.getBoundingClientRect();
  element.style.setProperty('--sweep-x', `${targetRect.left - fromRect.left}px`);
  element.style.setProperty('--sweep-y', `${targetRect.top - fromRect.top}px`);
  element.classList.add('animate-sweep');
  try {
    await delay(duration, signal);
  } finally {
    element.classList.remove('animate-sweep');
    element.style.removeProperty('--sweep-x');
    element.style.removeProperty('--sweep-y');
  }
}

export async function animateCardReveal({
  element,
  // className kept for API compatibility but the multi-phase implementation
  // uses dedicated classes and ignores this parameter.
  className = 'fm-flipping', // eslint-disable-line no-unused-vars
  reveal = () => {},
  signal,
}) {
  if (typeof reveal !== 'function') throw new TypeError('reveal must be a function');
  throwIfAborted(signal);

  if (!element || prefersReducedMotion()) {
    await reveal();
    throwIfAborted(signal);
    return;
  }

  // ── Phase 0: press-down feedback (one frame, ~70ms) ──────────────────
  element.classList.add('fm-pressing');
  try {
    await delay(70, signal);
  } finally {
    element.classList.remove('fm-pressing');
  }

  // ── Phase 1: fold away — back rotates to 90° (edge-on) ───────────────
  element.classList.add('fm-folding');
  try {
    await delay(180, signal);
  } finally {
    element.classList.remove('fm-folding');
  }

  // ── DOM swap at edge-on — card-back element is replaced by card-face ──
  // After reveal() the `element` reference is stale (the old back-card node
  // is removed from the DOM). We immediately query the replacement face card
  // so we can apply the unfold animation to the live element.
  await reveal();
  throwIfAborted(signal);

  // The reveal() callback re-renders the grid cell via renderGameplay().
  // The new face card lives at the same [data-card-index] cell.
  const cell = element.closest('[data-card-index]');
  const faceCard = cell?.querySelector('.fm-grid-card') ?? null;

  // ── Phase 2: unfold with overshoot bounce ─────────────────────────────
  if (faceCard) {
    faceCard.classList.add('fm-unfolding');
    // Kick off the reveal glow in parallel — it runs for 550ms but we only
    // need to wait for the unfold (280ms) before the action is considered done.
    faceCard.classList.add('fm-reveal-glow');
    try {
      await delay(280, signal);
    } finally {
      faceCard.classList.remove('fm-unfolding');
    }
    // Glow animation finishes on its own (550ms total); clean up afterward
    // without blocking the rest of the game flow.
    delay(300, signal).then(() => {
      faceCard.classList.remove('fm-reveal-glow');
    }).catch(() => {
      faceCard.classList.remove('fm-reveal-glow');
    });
  }
}

export async function animateMatchedPairCollection({
  elements,
  targetRect,
  riseClassName = 'fm-match-rise',
  sweepClassName = 'fm-match-sweep',
  riseDuration = 800,
  sweepDuration = 600,
  signal,
}) {
  const cards = Array.from(elements || []).filter(Boolean);
  throwIfAborted(signal);
  if (cards.length === 0 || prefersReducedMotion()) return;

  const setSweepOffset = (card) => {
    if (!targetRect) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty(
      '--sweep-x',
      `${targetRect.left + targetRect.width / 2 - (rect.left + rect.width / 2)}px`,
    );
    card.style.setProperty(
      '--sweep-y',
      `${targetRect.top + targetRect.height / 2 - (rect.top + rect.height / 2)}px`,
    );
  };

  cards.forEach((card) => card.classList.add(riseClassName));
  try {
    await delay(riseDuration, signal);
    cards.forEach((card) => {
      setSweepOffset(card);
      card.classList.remove(riseClassName);
      card.classList.add(sweepClassName);
    });
    await delay(sweepDuration, signal);
  } finally {
    cards.forEach((card) => {
      card.classList.remove(riseClassName, sweepClassName);
      card.style.removeProperty('--sweep-x');
      card.style.removeProperty('--sweep-y');
    });
  }
}