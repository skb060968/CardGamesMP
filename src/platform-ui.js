/**
 * Platform UI — Landing Page & Screen Management
 *
 * Manages screen transitions, landing page game card grid,
 * toast notifications, and custom modal dialogs.
 */

/**
 * Hides all .screen elements, then shows the one matching screenId.
 * @param {string} screenId
 */
export function showScreen(screenId) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach((s) => s.setAttribute('hidden', ''));

  const target = document.getElementById(screenId);
  if (target) {
    target.removeAttribute('hidden');
  }
}

/**
 * Renders the landing page with 6 selectable game cards in a 2×3 grid
 * and one shared Play button below. Tap a card to select it, then tap Play.
 * First available game is pre-selected.
 *
 * @param {Array<{id: string, name: string, image: string, available: boolean}>} games
 * @param {Function} onGameSelect - callback(gameId)
 */
export function renderLandingPage(games, onGameSelect) {
  const grid = document.getElementById('game-cards-grid');
  const playBtn = document.getElementById('landing-play-btn');
  if (!grid) return;

  grid.innerHTML = '';

  let selectedId = null;

  // Pre-select first available game
  const firstAvailable = games.find((g) => g.available);
  if (firstAvailable) selectedId = firstAvailable.id;

  const cards = [];

  games.forEach((game) => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.dataset.gameId = game.id;
    if (!game.available) card.classList.add('coming-soon');
    if (game.id === selectedId) card.classList.add('selected');

    const img = document.createElement('img');
    img.src = game.image;
    img.alt = game.name;

    if (!game.available) {
      const badge = document.createElement('span');
      badge.className = 'coming-soon-badge';
      badge.textContent = 'Coming Soon';
      card.appendChild(badge);
    }

    card.appendChild(img);

    // Tap to select
    if (game.available) {
      card.addEventListener('click', () => {
        selectedId = game.id;
        cards.forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        if (playBtn) {
          playBtn.disabled = false;
        }
      });
    }

    cards.push(card);
    grid.appendChild(card);
  });

  // Setup play button
  if (playBtn) {
    playBtn.disabled = !selectedId;
    playBtn.textContent = '▶ PLAY';

    // Remove old listeners by cloning
    const newBtn = playBtn.cloneNode(true);
    playBtn.parentNode.replaceChild(newBtn, playBtn);

    newBtn.addEventListener('click', () => {
      if (selectedId) onGameSelect(selectedId);
    });
  }
}

/**
 * Shows a temporary toast message, auto-removes after duration.
 * @param {string} message
 * @param {number} [duration=1500]
 */
export function showToast(message, duration = 1500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'game-toast';
  toast.textContent = message;
  toast.setAttribute('role', 'alert');

  if (container) {
    container.appendChild(toast);
  } else {
    document.body.appendChild(toast);
  }

  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, duration);
}

/**
 * Shows a custom modal dialog (replaces browser prompt/confirm).
 * @param {{title: string, inputPlaceholder?: string, showCancel?: boolean}} options
 * @returns {Promise<string|null>} input value or null if cancelled
 */
export function showModal(options) {
  const overlay = document.getElementById('custom-modal');
  const titleEl = document.getElementById('modal-title');
  const inputEl = document.getElementById('modal-input');
  const okBtn = document.getElementById('modal-ok');
  const cancelBtn = document.getElementById('modal-cancel');

  if (!overlay || !titleEl || !okBtn || !cancelBtn) {
    return Promise.resolve(null);
  }

  titleEl.textContent = options.title || '';

  if (options.inputPlaceholder) {
    inputEl.placeholder = options.inputPlaceholder;
    inputEl.value = '';
    inputEl.style.display = '';
  } else {
    inputEl.style.display = 'none';
  }

  cancelBtn.style.display = options.showCancel === false ? 'none' : '';

  // Optional custom button labels; originals are restored on cleanup so other
  // dialogs that rely on the default labels are unaffected.
  const originalOkText = okBtn.textContent;
  const originalCancelText = cancelBtn.textContent;
  if (options.confirmText) okBtn.textContent = options.confirmText;
  if (options.cancelText) cancelBtn.textContent = options.cancelText;

  overlay.removeAttribute('hidden');

  // Focus the input or OK button
  if (options.inputPlaceholder) {
    inputEl.focus();
  } else {
    okBtn.focus();
  }

  return new Promise((resolve) => {
    function cleanup() {
      overlay.setAttribute('hidden', '');
      okBtn.textContent = originalOkText;
      cancelBtn.textContent = originalCancelText;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    }

    function onOk() {
      cleanup();
      resolve(options.inputPlaceholder ? inputEl.value : 'ok');
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/**
 * Self-contained confirmation dialog. Builds its own <dialog> element (so it
 * needs no pre-existing markup) and never uses window.confirm, so the browser
 * does not prefix it with the site address. Resolves true when confirmed,
 * false when cancelled or dismissed.
 * @param {string} message
 * @param {{confirmText?: string, cancelText?: string}} [options]
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, { confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';

    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirm-cancel';
    cancel.textContent = cancelText;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'confirm-ok';
    confirm.textContent = confirmText;

    actions.append(cancel, confirm);
    dialog.append(text, actions);
    document.body.append(dialog);

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      try { dialog.close(); } catch (_) {}
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(false); });

    dialog.showModal();
    confirm.focus();
  });
}
