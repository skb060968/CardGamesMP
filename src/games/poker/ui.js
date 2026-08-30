import { renderCardBack, renderCardFace } from '../../shared/card-renderer.js';
import { evaluateHand } from './engine.js';

function clear(element) {
  if (element) element.innerHTML = '';
  return element;
}

function appendText(parent, className, text, tag = 'span') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function activePlayers(state) {
  return state.players.map((player, index) => ({ ...player, index }))
    .filter((player) => !player.folded);
}

function actionButton(container, label, className, type, onAction) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${className} pk-action-btn`;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await onAction?.({ type });
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  });
  container.appendChild(button);
}

function renderAllPlayers(state, localPlayerIndex) {
  const container = clear(document.getElementById('pk-all-players'));
  if (!container) return;
  state.players.forEach((player, index) => {
    if (index === localPlayerIndex) return;
    const block = document.createElement('div');
    block.className = 'game-player-block';
    block.dataset.playerIndex = String(index);
    block.classList.toggle('game-block-active', state.status === 'betting' && index === state.currentPlayerIndex);
    block.classList.toggle('pk-broke', player.broke);
    if (player.folded && !player.broke) block.style.opacity = '0.4';
    appendText(block, 'game-block-emoji', player.emoji || '😀');
    appendText(block, 'game-block-name', player.name || `Player ${index + 1}`);
    const strip = document.createElement('div');
    strip.className = 'game-card-strip';

    if (player.broke) appendText(strip, 'pk-broke-badge', 'BROKE');
    else for (let cardIndex = 0; cardIndex < player.hand.length; cardIndex += 1) {
      const mini = document.createElement('div');
      mini.className = 'game-strip-card';
      strip.appendChild(mini);
    }
    block.appendChild(strip);
    appendText(block, 'game-block-extra', `💰${player.chips}`);
    container.appendChild(block);
  });
}

function renderSelfBar(state, localPlayerIndex) {
  const player = state.players[localPlayerIndex];
  if (!player) return;
  const emoji = document.getElementById('pk-self-emoji');
  const name = document.getElementById('pk-self-name');
  const bar = document.getElementById('pk-self-bar');
  if (emoji) emoji.textContent = player.emoji || '😀';
  if (name) name.textContent = player.name || 'You';
  if (!bar) return;
  bar.classList.toggle('self-bar-active', state.status === 'betting' && state.currentPlayerIndex === localPlayerIndex);
  const info = bar.querySelector('.game-self-info') || bar;
  info.querySelector('.pk-self-chips')?.remove();
  appendText(info, 'pk-self-chips', `💰${player.chips}`);
}

function renderPot(state) {
  const container = clear(document.getElementById('pk-pot-area'));
  if (container) appendText(container, 'pk-pot-display', `🏆 Pot: ${state.pot}`, 'div');
}

function renderCards(state, localPlayerIndex, revealAll = false, target = 'pk-cards-area') {
  const container = clear(document.getElementById(target));
  if (!container) return;
  const displayOrder = state.players
    .map((_, index) => index)
    .filter((index) => index !== localPlayerIndex);
  if (state.players[localPlayerIndex]) displayOrder.push(localPlayerIndex);

  displayOrder.forEach((index) => {
    const player = state.players[index];
    const group = document.createElement('div');
    group.className = 'pk-player-cards';
    group.classList.toggle('pk-cards-folded', player.folded);
    group.classList.toggle('pk-cards-active', state.status === 'betting' && index === state.currentPlayerIndex);
    group.classList.toggle('pk-cards-winner', state.status === 'finished' && index === state.winnerIndex);
    const displayName = index === localPlayerIndex ? 'You' : player.name;
    const label = appendText(group, 'pk-card-label', `${player.emoji || '😀'} ${displayName}`, 'div');
    if (player.currentBet > 0) appendText(label, 'pk-bet-badge', ` (bet: ${player.currentBet})`);
    const row = document.createElement('div');
    row.className = 'pk-cards-row';
    const faceUp = revealAll || index === localPlayerIndex;
    player.hand.forEach((card) => {
      const cardElement = faceUp ? renderCardFace(card) : renderCardBack();
      cardElement.style.cursor = 'default';
      row.appendChild(cardElement);
    });
    group.appendChild(row);
    if (revealAll && !player.broke && player.hand.length === 3) {
      const ranking = appendText(group, 'pk-hand-rank', evaluateHand(player.hand).label, 'div');
      ranking.classList.toggle('pk-hand-rank-winner', index === state.winnerIndex);
    }
    container.appendChild(group);
  });
}

function renderActions(state, localPlayerIndex, onAction) {
  const container = clear(document.getElementById('pk-actions-area'));
  if (!container) return;
  const player = state.players[localPlayerIndex];
  const myTurn = state.status === 'betting' && state.currentPlayerIndex === localPlayerIndex;
  if (!player || !myTurn || player.folded) {
    if (player?.broke) appendText(container, 'pk-wait-text', 'You are out of chips — sitting out this round', 'p');
    else if (state.status === 'betting' && player && !player.folded) {
      appendText(container, 'pk-wait-text', `Waiting for ${state.players[state.currentPlayerIndex]?.name || 'Opponent'}...`, 'p');
    }
    return;
  }
  const row = document.createElement('div');
  row.className = 'pk-action-buttons';
  const active = activePlayers(state);
  const maxBet = Math.max(...active.map((item) => item.currentBet));
  const needToCall = maxBet - player.currentBet;
  const allActed = active.every((item) => item.hasActed);
  if (maxBet === 0) {
    if (player.chips >= 10) actionButton(row, 'Bet (10)', 'primary', 'bet', onAction);
  } else if (needToCall > 0) {
    const canCall = player.chips >= needToCall;
    const raiseCost = needToCall + 10;
    const canRaise = player.chips >= raiseCost;
    if (canCall) actionButton(row, `Call (${needToCall})`, 'secondary', 'call', onAction);
    if (canRaise) actionButton(row, `Raise (${raiseCost})`, 'primary pk-raise-btn', 'raise', onAction);
    if (allActed || (!canCall && !canRaise)) actionButton(row, 'Fold', 'secondary pk-fold-btn', 'fold', onAction);
  } else if (allActed) {
    if (player.chips >= 10) actionButton(row, 'Raise (10)', 'primary pk-raise-btn', 'raise', onAction);
    if (state.showEligible) actionButton(row, '👁 Show', 'primary pk-show-btn', 'show', onAction);
    actionButton(row, 'Fold', 'secondary pk-fold-btn', 'fold', onAction);
  }
  container.appendChild(row);
}

export function renderGameplay(state, localPlayerIndex, callbacks = {}) {
  renderAllPlayers(state, localPlayerIndex);
  renderSelfBar(state, localPlayerIndex);
  renderPot(state);
  renderCards(state, localPlayerIndex, false);
  renderActions(state, localPlayerIndex, callbacks.onAction);
  const eventBar = document.getElementById('pk-event-bar');
  if (eventBar && !eventBar.textContent) {
    eventBar.textContent = state.currentPlayerIndex === localPlayerIndex
      ? 'Your turn' : `${state.players[state.currentPlayerIndex]?.name || 'Player'}’s turn`;
  }
}

export function renderResults(state, isFoldWin = state.finishReason === 'fold') {
  const display = clear(document.getElementById('pk-winner-display'));
  if (display) {
    if (state.winnerIndex == null) appendText(display, 'winner-name', 'Game ended — no winner', 'div');
    else {
      const winner = state.players[state.winnerIndex];
      const potGain = Math.max(0, winner.chips - winner.roundStartChips);
      appendText(display, 'winner-emoji', winner.emoji || '🏆', 'div');
      appendText(display, 'winner-name', `${winner.name} wins!`, 'div');
      appendText(display, 'winner-bounty', isFoldWin ? 'All others folded' : evaluateHand(winner.hand).label, 'div');
      appendText(
        display,
        'pk-winner-chips',
        `💰 ${winner.chips} chips${potGain > 0 ? ` · +${potGain} pot gain` : ''}`,
        'div',
      );
    }
  }
  const list = clear(document.getElementById('pk-results-list'));
  if (!list) return;
  state.players.forEach((player, index) => {
    const item = document.createElement('li');
    item.className = 'pk-results-row';
    const top = document.createElement('div');
    top.className = 'pk-results-top';
    appendText(top, '', `${player.emoji || '😀'} ${player.name}`);
    appendText(top, 'bounty-value', `💰 ${player.chips} chips`);
    item.appendChild(top);
    if (player.broke) {
      appendText(item, 'pk-results-folded', '— broke, sat out —', 'div');
    } else {
      const hand = document.createElement('div');
      hand.className = `pk-results-hand${player.folded ? ' pk-results-hand-folded' : ''}`;
      player.hand.forEach((card) => {
        const cardElement = renderCardFace(card);
        cardElement.classList.add('pk-results-card');
        cardElement.style.cursor = 'default';
        hand.appendChild(cardElement);
      });
      const label = player.folded ? 'Folded' : evaluateHand(player.hand).label;
      const rank = appendText(hand, `pk-results-rank${player.folded ? ' pk-results-folded-tag' : ''}`, label);
      rank.classList.toggle('pk-results-rank-winner', index === state.winnerIndex);
      item.appendChild(hand);
    }
    list.appendChild(item);
  });
}

export function setEventMessage(message) {
  const bar = document.getElementById('pk-event-bar');
  if (bar) bar.textContent = message || '';
}

export function renderLobbyPlayers(players, isHost, playerKeys = []) {
  const list = clear(document.getElementById('pk-lobby-player-list'));
  if (!list) return;
  players.forEach((player, index) => {
    const item = document.createElement('li');
    if (player.connected === false) item.classList.add('disconnected');
    appendText(item, 'pk-lobby-emoji', player.emoji || '😀');
    const name = appendText(item, 'pk-lobby-name', player.name || `Player ${index + 1}`);
    name.style.flex = '1';
    if (player.connected === false) appendText(item, 'offline-badge', 'OFFLINE');
    if (index === 0) appendText(item, 'host-badge', 'HOST');
    else if (isHost && playerKeys[index]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'remove-player-btn';
      button.textContent = '✕';
      button.title = `Remove ${player.name || `Player ${index + 1}`}`;
      button.setAttribute('aria-label', button.title);
      button.dataset.playerIndex = String(Number.parseInt(playerKeys[index].replace('player_', ''), 10));
      button.dataset.playerUid = player.uid;
      button.dataset.playerName = player.name || `Player ${index + 1}`;
      item.appendChild(button);
    }
    list.appendChild(item);
  });
}

export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = clear(document.getElementById('pk-ready-indicators'));
  if (!container) return;
  container.hidden = false;
  const ready = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers || []);
  const left = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);
  playerNames.forEach((name, index) => {
    const indicator = document.createElement('div');
    indicator.className = 'ready-dot';
    indicator.classList.toggle('ready', ready.has(index));
    indicator.classList.toggle('not-ready', left.has(index));
    appendText(indicator, 'dot', '', 'div');
    appendText(indicator, 'dot-name', name);
    container.appendChild(indicator);
  });
}
