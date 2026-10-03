import { APP_VERSION } from './config.js';
import { createGame, dispatch as localDispatch, getState, hasGame, loadState, subscribe } from './state.js';
import { createCloudRoom, connectCloudRoom, leaveCloudRoom, subscribeCloudNetwork, getCloudStatus, getCloudSettings, setCloudSettings, requestCloudJoin, approveCloudJoin, rejectCloudJoin, submitCloudAction, requestCloudResync, getCloudNowMs, restoreCloudSession, prepareCloudMigrationState, cloudInviteUrl } from './cloud-network.js';
import { ensureIdentity, getStoredIdentitySummary, exportIdentityBlob, importIdentityFile } from './identity.js';
import { securitySummary, hasSecureCrypto } from './security.js';
import { verifyEventChain } from './integrity.js';
import { createBallotBox, encryptSecretChoice, revealBallotBox, verifyRevealedSecretVote, hasBallotBoxKey, exportBallotBoxRecovery, importBallotBoxRecovery } from './secret-ballots.js';
import { describeEvent } from './events.js';
import { escapeHtml, formatDateTime } from './utils.js';
import { VOTE_TYPES, secondsRemaining } from './voting.js';
import { ELECTION_KINDS, electionDefaults } from './elections.js';
import { filledLegislativeSeats, majorityThreshold, partySeatCounts } from './legislature.js';
import { governmentMajorityStatus } from './government.js';
import { discussionFinished, proposalStatusLabel, referendumWindowExpired, signatureThreshold } from './laws.js';
import { amendmentStatusLabel } from './constitution.js';
import { renderMarkdown } from './markdown.js';
import { auditState, offlineReadiness } from './diagnostics.js';
import { runRulePropertySuite, runSyntheticStressSuite } from './testing.js';
import { deriveAttention, notificationPrefs, setBrowserNotifications, markAttentionSeen, dismissAttention, clearDismissed, requestBrowserPermission, maybeSendBrowserNotifications } from './attention.js';
import { initRouter, navigate, registerRoute, renderCurrentRoute } from './router.js';
import { RELEASE_CHANNEL, RELEASE_DATE, RELEASE_HIGHLIGHTS, KNOWN_LIMITATIONS, releaseReadiness, buildDiagnosticReport } from './release.js';
import {
  createSnapshot,
  deleteSavedGame,
  exportGameFile,
  importGameFile,
  listSavedGames,
  listSnapshots,
  restoreSnapshot,
  verifySnapshots,
  loadCurrentGame,
  loadGame,
  saveGame,
  shouldCreateAutomaticSnapshot
} from './storage.js';

const view = document.querySelector('#view');
document.querySelector('#appVersion').textContent = `v${APP_VERSION}`;

let savedGames = [];
let saveChain = Promise.resolve();
let lastSnapshotted = new Map();
let recoverySnapshots = [];
let recoverySnapshotAudit = [];
let ballotKeyAvailability = {};
let attentionItems = [];
let deferredInstallPrompt = null;
let lastFocusedBeforeModal = null;
let lastRuleTestResult = null;
let lastStressResult = null;
const runtimeErrors = [];
const ONBOARDING_KEY = 'democracy-web-onboarding-v1';

function dispatch(action) {
  const cloud = getCloudStatus();
  if (cloud.roomCode || cloud.authenticated) {
    if (!(cloud.connection === 'connected' && cloud.authenticated && cloud.localPlayerId && cloud.stateSynced)) {
      throw new Error('Cloud multiplayer is not fully synchronised yet. Reconnect or wait for verified recovery before changing official state.');
    }
    return submitCloudAction(action);
  }
  return localDispatch(action);
}

function toast(message, kind = 'normal') {
  const region = document.querySelector('#toastRegion');
  const node = document.createElement('div');
  node.className = `toast${kind === 'error' ? ' toast-error' : ''}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 3200);
}

function setSaveStatus(text, status = '') {
  const el = document.querySelector('#saveStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.status = status;
}

function setMobileMenu(open) {
  const menu = document.querySelector('#mobileMenu');
  const toggle = document.querySelector('.mobile-header [data-action="toggle-mobile-menu"]');
  if (!menu) return;
  menu.classList.toggle('is-open', open);
  menu.setAttribute('aria-hidden', open ? 'false' : 'true');
  toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
  document.body.style.overflow = open ? 'hidden' : '';
}

async function shareText({ title = 'Democracy Web', text = '', url = location.href } = {}) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return true; } catch (error) { if (error?.name === 'AbortError') return false; }
  }
  const payload = [text, url].filter(Boolean).join('\n');
  await navigator.clipboard.writeText(payload);
  toast('Share text copied');
  return true;
}

function showModal({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, onConfirm }) {
  const root = document.querySelector('#modalRoot');
  lastFocusedBeforeModal = document.activeElement;
  const close = () => { root.innerHTML = ''; lastFocusedBeforeModal?.focus?.(); };
  root.innerHTML = `
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">
        <h2 id="modalTitle">${escapeHtml(title)}</h2>
        <div>${body}</div>
        <div class="btn-row" style="margin-top:18px;justify-content:flex-end">
          <button class="btn" data-modal-cancel>${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal-confirm>${escapeHtml(confirmText)}</button>
        </div>
      </div>
    </div>`;
  const dialog=root.querySelector('.modal');
  const focusables=()=>[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')];
  dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();return;}if(e.key==='Tab'){const f=focusables();if(!f.length)return;const first=f[0],last=f.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
  root.querySelector('.modal-backdrop').addEventListener('mousedown',e=>{if(e.target===e.currentTarget)close()});
  root.querySelector('[data-modal-cancel]').addEventListener('click', close);
  root.querySelector('[data-modal-confirm]').addEventListener('click', async () => {
    const button = root.querySelector('[data-modal-confirm]');
    try {
      button.disabled = true;
      const result = await onConfirm?.(root);
      if (result !== false) close();
    } finally {
      if (root.querySelector('[data-modal-confirm]')) button.disabled = false;
    }
  });
  requestAnimationFrame(()=>focusables()[0]?.focus() || dialog.focus());
}

function localActorId(state = getState()) {
  if (!state) return null;
  const cloud = getCloudStatus();
  if (cloud.connection === 'connected' && cloud.localPlayerId && state.players?.[cloud.localPlayerId]) return cloud.localPlayerId;
  if (cloud.roomCode || cloud.authenticated) return null;
  const creator = Object.values(state.players).find(p => p.roles?.includes('creator') && p.status !== 'resigned' && p.status !== 'removed');
  return creator?.id ?? Object.values(state.players).find(p => p.status === 'active')?.id ?? Object.keys(state.players)[0] ?? null;
}

function isHostLikeLocal(state, playerId = localActorId(state)) {
  if (!playerId) return false;
  if ([state.meta?.hostPlayerId, state.meta?.deputyHostPlayerId].includes(playerId)) return true;
  return !state.meta?.hostPlayerId && state.players?.[playerId]?.roles?.includes('creator');
}

function isOnlineGame() { const cloud=getCloudStatus(); return cloud.connection === 'connected' && cloud.authenticated; }

function statCard(value, label) {
  return `<div class="card stat"><span class="value">${escapeHtml(value)}</span><span class="label">${escapeHtml(label)}</span></div>`;
}

function playerStatusLabel(status) {
  const map = { active: 'Active', inactive: 'Temporarily inactive', resigned: 'Resigned', removed: 'Permanently removed' };
  return map[status] ?? status;
}

function partyBadge(state, player) {
  const party = player.partyId ? state.parties[player.partyId] : null;
  if (!party) return '<span class="muted">Independent</span>';
  return `<span class="party-inline"><span class="colour-dot" style="--party-colour:${escapeHtml(party.colour)}"></span>${escapeHtml(party.abbreviation || party.name)}</span>`;
}



function optionLabel(vote, id) {
  return vote.options?.find(option => option.id === id)?.label ?? id ?? '—';
}

function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 1000) / 10}%`;
}

function formatDuration(seconds) {
  if (seconds === null) return 'No deadline';
  if (seconds <= 0) return 'Deadline passed';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function voteStatusLabel(status) {
  const labels = { draft: 'Draft', scheduled: 'Scheduled', open: 'Open', paused: 'Paused', closed: 'Closed', certified: 'Certified', cancelled: 'Cancelled' };
  return labels[status] ?? status;
}

function electionKindLabel(kind, committee) {
  if (kind === ELECTION_KINDS.GENERAL) return 'General Election';
  if (kind === ELECTION_KINDS.HOST) return 'Host Election';
  if (kind === ELECTION_KINDS.DEPUTY_HOST) return 'Deputy Host Election';
  if (kind === ELECTION_KINDS.COMMITTEE) return `${committee ?? ''} Committee Election`.trim();
  return 'Vote';
}

function voteResultHtml(vote) {
  const result = vote.result;
  if (!result) return '<p class="muted">No result calculated yet.</p>';
  const turnoutHtml = result.turnout ? `<p class="muted">Turnout: ${result.turnout.cast}/${result.turnout.electorate} (${formatPercent(result.turnout.rate)})</p>` : '';

  if (result.kind === 'yes-no') {
    return `${turnoutHtml}<div class="result-grid"><div><strong>${result.counts.yes}</strong><span>Yes</span></div><div><strong>${result.counts.no}</strong><span>No</span></div><div><strong>${result.counts.abstain ?? 0}</strong><span>Abstain</span></div></div><p><strong>${result.passed ? 'PASSED' : 'FAILED'}</strong> · Approval ${formatPercent(result.approvalRate)}</p>`;
  }
  if (result.kind === 'ranked-choice') {
    const rounds = result.rounds.map(round => `<div class="round"><strong>Round ${round.number}</strong>${Object.entries(round.counts).map(([id, count]) => `<span>${escapeHtml(optionLabel(vote, id))}: ${count}</span>`).join('')}</div>`).join('');
    const outcome = result.winnerId ? `<p><strong>Winner: ${escapeHtml(optionLabel(vote, result.winnerId))}</strong></p>` : `<p><strong>Tie requiring a tie-break:</strong> ${(result.tie ?? []).map(id => escapeHtml(optionLabel(vote, id))).join(', ')}</p>`;
    return `${turnoutHtml}${outcome}<div class="rounds">${rounds}</div>`;
  }
  if (result.kind === 'proportional') {
    const rows = vote.options.map(option => `<tr><td>${escapeHtml(option.label)}</td><td>${result.rawCounts[option.id] ?? 0}</td><td>${result.qualifyingIds.includes(option.id) ? 'Yes' : 'No'}</td><td><strong>${result.seats[option.id] ?? 0}</strong></td></tr>`).join('');
    return `${turnoutHtml}<div class="table-wrap"><table class="data-table compact-table"><thead><tr><th>List</th><th>Votes</th><th>Qualified</th><th>Seats</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (result.kind === 'approval') {
    const rows = [...vote.options].sort((a,b) => (result.counts[b.id] ?? 0) - (result.counts[a.id] ?? 0)).map(option => `<tr><td>${escapeHtml(option.label)}</td><td>${result.counts[option.id] ?? 0}</td><td>${result.winners.includes(option.id) ? '<strong>Elected</strong>' : result.tie?.includes(option.id) ? 'Tie-break' : ''}</td></tr>`).join('');
    return `${turnoutHtml}${result.tie ? `<p><strong>Tie at the election cutoff:</strong> ${result.tie.map(id => escapeHtml(optionLabel(vote,id))).join(', ')}</p>` : ''}<div class="table-wrap"><table class="data-table compact-table"><thead><tr><th>Candidate</th><th>Approvals</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (result.kind === 'single-choice') {
    return `${turnoutHtml}${vote.options.map(option => `<div class="result-line"><span>${escapeHtml(option.label)}</span><strong>${result.counts[option.id] ?? 0}</strong></div>`).join('')}<p>${result.winnerId ? `<strong>Winner: ${escapeHtml(optionLabel(vote,result.winnerId))}</strong>` : `<strong>Tie:</strong> ${(result.tie ?? []).map(id=>escapeHtml(optionLabel(vote,id))).join(', ')}`}</p>`;
  }
  return '<p class="muted">Result format is not supported by this UI.</p>';
}

function ballotSummary(vote, state) {
  const count = vote.secretBallotMode === 'sealed-v1' ? Object.keys(vote.submittedVoters ?? {}).length : Object.keys(vote.ballots ?? {}).length;
  if (vote.secret) return `${count} ballot${count === 1 ? '' : 's'} submitted${vote.secretBallotMode === 'sealed-v1' ? ' · sealed' : ''}`;
  if (!count) return 'No ballots submitted';
  return Object.values(vote.ballots).map(record => `${state.players[record.voterId]?.displayName ?? 'Unknown'}: ${Array.isArray(record.choice) ? record.choice.map(id => optionLabel(vote,id)).join(' > ') : optionLabel(vote, record.choice)}`).join(' · ');
}

function voteCard(vote, state) {
  const seconds = secondsRemaining(vote, getCloudNowMs());
  const cast = vote.secretBallotMode === 'sealed-v1' ? Object.keys(vote.submittedVoters ?? {}).length : Object.keys(vote.ballots ?? {}).length;
  const electorate = vote.electorateSnapshot?.length ?? 0;
  return `<article class="card vote-card">
    <div class="section-header compact-header"><div><span class="pill">${escapeHtml(vote.electionKind ? electionKindLabel(vote.electionKind, vote.committee) : vote.type)}</span><h2>${escapeHtml(vote.title)}</h2><p class="muted">${vote.secret ? (vote.secretBallotMode === 'sealed-v1' ? 'Sealed secret ballot' : 'Secret ballot') : 'Public ballot'} · ${escapeHtml(voteStatusLabel(vote.status))}</p></div><span class="status status-${escapeHtml(vote.status)}">${escapeHtml(voteStatusLabel(vote.status))}</span></div>
    ${vote.status === 'open' ? `<div class="vote-progress"><div><strong>${cast}/${electorate}</strong><span> ballots</span></div><div data-deadline="${escapeHtml(vote.closesAt)}">${escapeHtml(formatDuration(seconds))}</div></div>` : ''}
    <p class="muted small">${escapeHtml(ballotSummary(vote, state))}</p>
    ${['closed','certified'].includes(vote.status) ? `<div class="result-box">${voteResultHtml(vote)}</div>` : ''}
    <div class="btn-row section">
      ${vote.status === 'draft' ? `<button class="btn btn-primary" data-action="open-vote" data-vote-id="${vote.id}">Open Vote</button>` : ''}
      ${vote.status === 'open' ? `<button class="btn btn-primary" data-action="cast-ballot" data-vote-id="${vote.id}">Cast / Change Ballot</button><button class="btn" data-action="pause-vote" data-vote-id="${vote.id}">Pause</button><button class="btn" data-action="close-vote" data-vote-id="${vote.id}">Close & Count</button>` : ''}
      ${vote.status === 'paused' ? `<button class="btn btn-primary" data-action="resume-vote" data-vote-id="${vote.id}">Resume</button><button class="btn" data-action="close-vote" data-vote-id="${vote.id}">Close & Count</button>` : ''}
      ${vote.status === 'closed' ? `<button class="btn btn-primary" data-action="certify-vote" data-vote-id="${vote.id}">Certify Result</button>` : ''}
      ${vote.secretBallotMode === 'sealed-v1' && ['closed','certified'].includes(vote.status) ? `<button class="btn" data-action="verify-secret-vote" data-vote-id="${vote.id}">Verify Sealed Ballots</button>` : ''}
      <button class="btn" data-action="share-vote" data-vote-id="${vote.id}">Share</button>
    </div>
  </article>`;
}

function votesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const votes = Object.values(state.votes ?? {}).filter(v => !v.electionKind).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
  return `<section class="section-header"><div><h1>Votes</h1><p class="muted">Generic voting engine for referendums, motions and future procedures.</p></div><button class="btn btn-primary" data-action="create-vote">Create Vote</button></section><div class="grid">${votes.map(v => voteCard(v,state)).join('') || '<div class="empty">No non-election votes have been created.</div>'}</div>`;
}

function electionsPage() {
  const state = getState();
  if (!state) return noGamePage();
  const elections = Object.values(state.votes ?? {}).filter(v => v.electionKind).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
  const removal = state.hostRemoval;
  const removalHtml = state.meta.hostPlayerId ? `<section class="card section"><div class="section-header compact-header"><div><h2>Host Removal</h2><p class="muted">Current Host: ${escapeHtml(state.players[state.meta.hostPlayerId]?.displayName ?? state.meta.hostPlayerId)}</p></div>${!removal || ['passed','failed'].includes(removal.status) ? '<button class="btn btn-danger" data-action="start-host-removal">Start Removal Petition</button>' : ''}</div>${removal && ['petition','voting'].includes(removal.status) ? `<p><strong>Status:</strong> ${escapeHtml(removal.status)}</p><p><strong>Signatures:</strong> ${removal.signatures?.length ?? 0}/${signatureThreshold(state,0.20)}</p><div class="btn-row">${removal.status==='petition'?'<button class="btn" data-action="sign-host-removal">Sign Petition</button>':''}${removal.voteId?'<button class="btn" data-route="votes">View Removal Vote</button>':''}</div>` : '<p class="muted">A removal petition needs 20% of active players. The public vote then requires 90% approval and 50% turnout.</p>'}</section>` : '';
  return `<section class="section-header"><div><h1>Elections</h1><p class="muted">General, Host, Deputy Host and committee elections use the shared voting engine.</p></div><button class="btn btn-primary" data-action="create-election">Create Election</button></section>${removalHtml}<div class="grid">${elections.map(v => voteCard(v,state)).join('') || '<div class="empty">No elections have been created.</div>'}</div>`;
}

function parliamentPage() {
  const state = getState();
  if (!state) return noGamePage();
  const seats = state.legislature?.seats ?? [];
  const filled = filledLegislativeSeats(state);
  const counts = partySeatCounts(state);
  const required = majorityThreshold(filled.length);
  const partyRows = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([partyId,count]) => {
    const party = state.parties[partyId];
    return `<tr><td><span class="colour-dot" style="--party-colour:${escapeHtml(party?.colour ?? '#475569')}"></span>${escapeHtml(party?.name ?? 'Unknown list')}</td><td><strong>${count}</strong></td><td>${count >= required ? '<span class="pill">Majority</span>' : ''}</td></tr>`;
  }).join('');
  const seatRows = seats.map(seat => {
    const member = seat.memberId ? state.players[seat.memberId] : null;
    const party = seat.partyId ? state.parties[seat.partyId] : null;
    return `<tr><td>${seat.number}</td><td>${party ? `<span class="colour-dot" style="--party-colour:${escapeHtml(party.colour)}"></span>${escapeHtml(party.name)}` : '—'}</td><td>${member ? `<strong>${escapeHtml(member.displayName)}</strong>` : '<span class="muted">Vacant</span>'}</td><td>${member ? `<button class="btn btn-danger" data-action="resign-mp-seat" data-player-id="${member.id}">Vacate Seat</button>` : '—'}</td></tr>`;
  }).join('');
  const legislativeVotes = Object.values(state.votes ?? {}).filter(v => v.settings?.electorateMode === 'legislature').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return `<section class="section-header"><div><h1>Parliament</h1><p class="muted">${filled.length}/${state.legislature.totalSeats || 0} seats filled · majority ${filled.length ? required : '—'}</p></div><button class="btn btn-primary" data-action="create-legislative-vote" ${filled.length ? '' : 'disabled'}>New Parliamentary Vote</button></section>
    ${!state.legislature.totalSeats ? '<div class="empty"><h2>No legislature yet</h2><p>Certify a General Election to create Parliament.</p></div>' : `
    <div class="grid grid-3"><div class="card stat"><span class="value">${state.legislature.totalSeats}</span><span class="label">Total Seats</span></div><div class="card stat"><span class="value">${filled.length}</span><span class="label">Filled Seats</span></div><div class="card stat"><span class="value">${required}</span><span class="label">Majority</span></div></div>
    <section class="section grid grid-2"><div class="card"><h2>Composition</h2><div class="table-wrap"><table class="data-table compact-table"><thead><tr><th>Party</th><th>Seats</th><th></th></tr></thead><tbody>${partyRows || '<tr><td colspan="3">No filled seats.</td></tr>'}</tbody></table></div></div><div class="card"><h2>Term</h2><dl class="kv"><dt>Started</dt><dd>${escapeHtml(formatDateTime(state.legislature.termStartedAt))}</dd><dt>Ends</dt><dd>${escapeHtml(formatDateTime(state.legislature.termEndsAt))}</dd><dt>Source election</dt><dd>${escapeHtml(state.legislature.sourceElectionId ?? '—')}</dd></dl></div></section>
    <section class="section card table-wrap"><table class="data-table"><thead><tr><th>Seat</th><th>Party</th><th>MP</th><th>Actions</th></tr></thead><tbody>${seatRows}</tbody></table></section>`}
    <section class="section"><div class="section-header"><div><h2>Parliamentary Votes</h2><p class="muted">Only sitting MPs are included in the electorate snapshot.</p></div></div><div class="grid">${legislativeVotes.map(v=>voteCard(v,state)).join('') || '<div class="empty">No parliamentary votes yet.</div>'}</div></section>`;
}

function governmentPage() {
  const state = getState();
  if (!state) return noGamePage();
  const gov = state.government;
  const majority = governmentMajorityStatus(state);
  const pm = gov.primeMinisterId ? state.players[gov.primeMinisterId] : null;
  const coalition = (gov.coalitionPartyIds ?? []).map(id=>state.parties[id]).filter(Boolean);
  const activePartiesWithSeats = Object.keys(partySeatCounts(state)).map(id=>state.parties[id]).filter(p=>p?.status==='active');
  const ministers = (gov.ministers ?? []).map(m => ({...m, player:state.players[m.playerId]}));
  return `<section class="section-header"><div><h1>Government</h1><p class="muted">Status: ${escapeHtml(gov.status ?? 'not-formed')}${gov.caretakerDeadline ? ` · formation deadline ${escapeHtml(formatDateTime(gov.caretakerDeadline))}` : ''}${gov.earlyElectionRequired ? ' · early election required' : ''}</p></div><div class="btn-row">${state.legislature.totalSeats ? `<button class="btn btn-primary" data-action="form-government">${gov.primeMinisterId ? 'Replace Government' : 'Form Government'}</button>` : ''}${gov.status==='active' ? '<button class="btn" data-action="create-confidence-vote">Confidence Vote</button><button class="btn" data-action="create-no-confidence-vote">Constructive No Confidence</button>' : ''}${['active','caretaker'].includes(gov.status) ? '<button class="btn" data-action="set-caretaker">Set Caretaker</button>' : ''}${gov.status==='caretaker' && gov.caretakerDeadline ? '<button class="btn" data-action="check-caretaker-deadline">Check 72h Deadline</button>' : ''}</div></section>
    <div class="grid grid-4">${statCard(pm?.displayName ?? '—','Prime Minister')}${statCard(coalition.map(p=>p.abbreviation||p.name).join(' + ') || '—','Coalition')}${statCard(`${majority.coalitionSeats}/${majority.filledSeats}`,'Government Seats')}${statCard(majority.required || '—','Majority Needed')}</div>
    <section class="section grid grid-2"><div class="card"><h2>Government</h2>${pm ? `<dl class="kv"><dt>Prime Minister</dt><dd>${escapeHtml(pm.displayName)}</dd><dt>Coalition</dt><dd>${coalition.map(p=>escapeHtml(p.name)).join(' + ')}</dd><dt>Formed</dt><dd>${escapeHtml(formatDateTime(gov.formedAt))}</dd><dt>Majority</dt><dd>${majority.hasMajority ? 'Yes' : 'No'}</dd></dl>` : `<div class="empty">No government has been formed from the current Parliament.</div>`}</div>
    <div class="card"><div class="section-header"><div><h2>Ministers</h2><p class="muted">${ministers.length}/5 appointed</p></div>${pm && ministers.length < 5 ? '<button class="btn" data-action="appoint-minister">Appoint</button>' : ''}</div>${ministers.length ? `<ul class="list">${ministers.map(m=>`<li class="list-row"><div><strong>${escapeHtml(m.player?.displayName ?? 'Unknown')}</strong><div class="muted">${escapeHtml(m.portfolio)}</div></div><button class="btn btn-danger" data-action="dismiss-minister" data-player-id="${m.playerId}">Dismiss</button></li>`).join('')}</ul>` : '<div class="empty">No ministers appointed.</div>'}</div></section>
    ${activePartiesWithSeats.length ? `<section class="section card"><h2>Parties represented in Parliament</h2><div class="member-chips">${activePartiesWithSeats.map(p=>`<span class="pill"><span class="colour-dot" style="--party-colour:${escapeHtml(p.colour)}"></span>${escapeHtml(p.name)} · ${partySeatCounts(state)[p.id] ?? 0}</span>`).join('')}</div></section>` : ''}`;
}


function lawProposalCard(proposal, state) {
  const vote = proposal.legislativeVoteId ? state.votes[proposal.legislativeVoteId] : null;
  const referendum = proposal.referendumVoteId ? state.votes[proposal.referendumVoteId] : null;
  const petitionNeeded = signatureThreshold(state, 0.20);
  const initiativeNeeded = signatureThreshold(state, 0.20);
  const sponsorNeeded = signatureThreshold(state, 0.10);
  const canFinalize = proposal.status === 'discussion' && discussionFinished(proposal);
  return `<article class="card">
    <div class="section-header compact-header"><div><span class="pill">${escapeHtml(proposal.id)}</span><h2>${escapeHtml(proposal.title)}</h2><p class="muted">${escapeHtml(proposalStatusLabel(proposal.status))} · ${escapeHtml(proposal.changeKind)}${proposal.pathway === 'citizen-initiative' ? ' · citizens\' initiative' : ''}</p></div><span class="status status-${escapeHtml(proposal.status)}">${escapeHtml(proposalStatusLabel(proposal.status))}</span></div>
    <p><strong>Reason:</strong> ${escapeHtml(proposal.reason)}</p>
    <details><summary>Proposed wording</summary><div class="proposal-text">${escapeHtml(proposal.text).replaceAll('\n','<br>')}</div></details>
    ${proposal.sponsorRoute === 'petition' && proposal.status === 'petition' ? `<p class="muted">Sponsorship petition: ${proposal.proposalSignatures?.length ?? 0}/${sponsorNeeded}</p>` : ''}
    ${proposal.discussionEndsAt && proposal.status === 'discussion' ? `<p class="muted">Discussion ends ${escapeHtml(formatDateTime(proposal.discussionEndsAt))}${canFinalize ? ' · ready to freeze' : ''}</p>` : ''}
    ${proposal.status === 'referendum-window' ? `<p class="muted">Referendum petition: ${proposal.petitionSignatures.length}/${petitionNeeded} · window closes ${escapeHtml(formatDateTime(proposal.referendumDeadline))}</p>` : ''}
    ${proposal.pathway === 'citizen-initiative' && ['petition','discussion','frozen'].includes(proposal.status) ? `<p class="muted">Initiative signatures: ${proposal.initiativeSignatures.length}/${initiativeNeeded}</p>` : ''}
    ${vote ? `<p class="muted">Parliament vote: ${escapeHtml(voteStatusLabel(vote.status))}</p>` : ''}
    ${referendum ? `<p class="muted">Referendum: ${escapeHtml(voteStatusLabel(referendum.status))}</p>` : ''}
    <div class="btn-row section">
      ${proposal.sponsorRoute === 'petition' && proposal.status === 'petition' ? `<button class="btn btn-primary" data-action="sign-law-proposal" data-proposal-id="${proposal.id}">Sign Sponsorship Petition</button>` : ''}
      ${proposal.status === 'discussion' ? `<button class="btn" data-action="edit-law-proposal" data-proposal-id="${proposal.id}">Edit</button><button class="btn btn-primary" data-action="finalize-law-proposal" data-proposal-id="${proposal.id}" ${canFinalize ? '' : 'disabled'}>Freeze & Continue</button>` : ''}
      ${proposal.pathway === 'citizen-initiative' && ['petition','discussion','frozen'].includes(proposal.status) ? `<button class="btn" data-action="sign-initiative" data-proposal-id="${proposal.id}">Sign Initiative</button>` : ''}
      ${proposal.status === 'referendum-window' ? `<button class="btn" data-action="sign-law-referendum" data-proposal-id="${proposal.id}">Sign Referendum Petition</button><button class="btn" data-action="refer-law" data-proposal-id="${proposal.id}">Refer to Public Vote</button><button class="btn btn-primary" data-action="check-law-window" data-proposal-id="${proposal.id}" ${referendumWindowExpired(proposal) ? '' : 'disabled'}>Complete 48h Window</button>` : ''}
    </div>
  </article>`;
}

function lawsPage() {
  const state = getState();
  if (!state) return noGamePage();
  const proposals = Object.values(state.lawProposals ?? {}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const laws = Object.values(state.laws ?? {}).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return `<section class="section-header"><div><h1>Laws</h1><p class="muted">Propose, debate, pass, amend, repeal and refer ordinary laws.</p></div><div class="btn-row"><button class="btn btn-primary" data-action="create-law-proposal">Propose Law</button><button class="btn" data-action="create-citizen-initiative">Citizens' Initiative</button></div></section>
    <div class="grid grid-3">${statCard(laws.filter(l=>l.status==='in-force').length,'Laws In Force')}${statCard(proposals.length,'Proposals')}${statCard(proposals.filter(p=>p.status==='referendum').length,'Active Referendums')}</div>
    <section class="section"><div class="section-header"><div><h2>Current Laws</h2><p class="muted">Historical versions are preserved on each law.</p></div></div>${laws.length ? `<div class="grid">${laws.map(law=>`<article class="card"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(law.id)} · v${law.version}</span><h3>${escapeHtml(law.title)}</h3></div><span class="status">${escapeHtml(law.status)}</span></div><div class="proposal-text">${escapeHtml(law.text).replaceAll('\n','<br>')}</div><p class="muted">Enacted ${escapeHtml(formatDateTime(law.enactedAt))} · ${law.history?.length ?? 0} history event(s)</p><div class="btn-row">${law.status==='in-force' ? `<button class="btn" data-action="amend-law" data-law-id="${law.id}">Amend</button><button class="btn btn-danger" data-action="repeal-law" data-law-id="${law.id}">Repeal</button>` : ''}</div></article>`).join('')}</div>` : '<div class="empty">No enacted laws yet.</div>'}</section>
    <section class="section"><h2>Proposals</h2><div class="grid">${proposals.map(p=>lawProposalCard(p,state)).join('') || '<div class="empty">No law proposals yet.</div>'}</div></section>`;
}

function amendmentCard(proposal, state) {
  const vote = proposal.voteId ? state.votes[proposal.voteId] : null;
  const ready = proposal.status === 'discussion' && discussionFinished(proposal);
  const sponsorNeeded = signatureThreshold(state, 0.10);
  return `<article class="card"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(proposal.id)} · ${escapeHtml(proposal.category)}</span><h2>Section ${escapeHtml(proposal.section)}${proposal.sectionTitle ? ` — ${escapeHtml(proposal.sectionTitle)}` : ''}</h2><p class="muted">${escapeHtml(amendmentStatusLabel(proposal.status))}</p></div></div>
    <div class="grid grid-2"><div><h3>Current wording</h3><div class="proposal-text">${escapeHtml(proposal.currentText).replaceAll('\n','<br>')}</div></div><div><h3>Proposed wording</h3><div class="proposal-text">${escapeHtml(proposal.proposedText).replaceAll('\n','<br>')}</div></div></div>
    <p><strong>Reason:</strong> ${escapeHtml(proposal.reason)}</p>
    ${proposal.sponsorRoute==='petition' && proposal.status==='petition' ? `<p class="muted">Sponsorship petition: ${proposal.proposalSignatures?.length ?? 0}/${sponsorNeeded}</p><div class="btn-row"><button class="btn btn-primary" data-action="sign-amendment-petition" data-proposal-id="${proposal.id}">Sign Petition</button></div>` : ''}
    ${proposal.status==='discussion' ? `<p class="muted">Discussion ends ${escapeHtml(formatDateTime(proposal.discussionEndsAt))}</p><div class="btn-row"><button class="btn" data-action="edit-amendment" data-proposal-id="${proposal.id}">Edit</button><button class="btn btn-primary" data-action="finalize-amendment" data-proposal-id="${proposal.id}" ${ready?'':'disabled'}>Freeze & Open Amendment Vote</button></div>` : ''}
    ${vote ? `<p class="muted">Public amendment vote: ${escapeHtml(voteStatusLabel(vote.status))}</p>` : ''}
  </article>`;
}

function constitutionPage() {
  const state = getState();
  if (!state) return noGamePage();
  const proposals = Object.values(state.constitution.proposals ?? {}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const unlocks = Object.values(state.constitution.unlockProposals ?? {}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const amendments = [...(state.constitution.amendments ?? [])].reverse();
  const overrides = Object.values(state.constitution.sectionOverrides ?? {});
  const editableOverrides = state.constitution.editableOverrides ?? {};
  const activeCount = Object.values(state.players).filter(p=>p.status==='active').length;
  const unlockNeeded = Math.max(1, Math.ceil(activeCount * .25));
  return `<section class="section-header"><div><h1>Constitution</h1><p class="muted">Live amendment layer · Constitution version ${state.constitution.version ?? 1}</p></div><div class="btn-row"><button class="btn btn-primary" data-action="create-amendment">Propose Amendment</button><button class="btn" data-action="create-base-unlock">Base Rule Unlock</button><button class="btn" data-route="rulebook">Open Full Rulebook</button></div></section>
    <div class="grid grid-4">${statCard(state.constitution.version ?? 1,'Constitution Version')}${statCard(amendments.length,'Applied Amendments')}${statCard(Object.keys(editableOverrides).length,'Base Rules Unlocked')}${statCard(proposals.filter(p=>['discussion','voting'].includes(p.status)).length,'Active Amendments')}</div>
    <section class="section card"><h2>Save Constitution</h2><p class="muted">These starting provisions live inside this save and can be amended by votes without changing the static Full Rulebook.</p><div class="grid">${Object.values(state.constitution.sections ?? {}).map(sec=>`<article><span class="pill">Section ${escapeHtml(sec.number)} · ${escapeHtml(sec.category)}</span><h3>${escapeHtml(sec.title)}</h3><div class="proposal-text">${escapeHtml(sec.text).replaceAll('\n','<br>')}</div></article>`).join('')}</div></section>
    ${overrides.length ? `<section class="section card"><h2>Current amended sections</h2><div class="grid">${overrides.map(o=>`<article><span class="pill">Section ${escapeHtml(o.section)} · ${escapeHtml(o.category)}</span><h3>${escapeHtml(o.title || `Section ${o.section}`)}</h3><div class="proposal-text">${escapeHtml(o.text).replaceAll('\n','<br>')}</div><p class="muted">Effective ${escapeHtml(formatDateTime(o.effectiveAt))}</p></article>`).join('')}</div></section>` : ''}
    <section class="section"><h2>Protected Base Rule Unlocks</h2><div class="grid">${unlocks.map(u=>{const vote=u.voteId?state.votes[u.voteId]:null;return `<article class="card"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(u.id)} · BASE</span><h3>Section ${escapeHtml(u.section)}${u.sectionTitle?` — ${escapeHtml(u.sectionTitle)}`:''}</h3><p class="muted">${escapeHtml(u.status)} · initiated by ${escapeHtml(u.initiatedBy)}</p></div></div><p>${escapeHtml(u.reason)}</p>${u.initiatedBy==='petition'?`<p class="muted">Petition: ${u.signatures.length}/${unlockNeeded}</p>`:''}${vote?`<p class="muted">Public unlock vote: ${escapeHtml(voteStatusLabel(vote.status))} · 75% approval + 50% turnout required</p>`:''}<div class="btn-row">${u.status==='petition'?`<button class="btn" data-action="sign-base-unlock" data-proposal-id="${u.id}">Sign Petition</button>`:''}${u.status==='awaiting-ac'?`<button class="btn btn-primary" data-action="create-base-unlock-ac-vote" data-proposal-id="${u.id}">Open AC 2/3 Vote</button>`:''}</div></article>`}).join('') || '<div class="empty">No protected-rule unlock proposals.</div>'}</div></section>
    <section class="section"><h2>Amendment Proposals</h2><div class="grid">${proposals.map(p=>amendmentCard(p,state)).join('') || '<div class="empty">No constitutional amendments have been proposed.</div>'}</div></section>
    <section class="section card"><h2>Constitutional Changelog</h2>${amendments.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>Proposal</th><th>Section</th><th>Approved</th><th>Effective</th></tr></thead><tbody>${amendments.map(a=>`<tr><td>${a.number}</td><td>${escapeHtml(a.id)}</td><td>${escapeHtml(a.section)}</td><td>${escapeHtml(formatDateTime(a.approvedAt))}</td><td>${escapeHtml(formatDateTime(a.effectiveAt))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No amendments applied yet.</div>'}</section>`;
}


function committeesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const cards = Object.values(state.committees ?? {}).map(c => {
    const members = (c.members ?? []).map(id => state.players[id]?.displayName ?? id);
    const chair = c.chairId ? state.players[c.chairId]?.displayName ?? c.chairId : 'Not elected';
    const matters = c.matters ?? [];
    return `<article class="card"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(c.code)}</span><h3>${escapeHtml(c.code)} Committee</h3></div></div><p><strong>Chair:</strong> ${escapeHtml(chair)}</p><p><strong>Members:</strong> ${escapeHtml(members.join(', ') || 'Not seated')}</p><p><strong>Alternates:</strong> ${escapeHtml((c.alternates ?? []).map(id=>state.players[id]?.displayName ?? id).join(', ') || 'None')}</p><div class="btn-row"><button class="btn" data-action="set-committee-chair" data-committee="${c.code}">Set Chair</button><button class="btn btn-primary" data-action="create-committee-matter" data-committee="${c.code}">New Matter</button></div>${matters.length ? `<div class="section"><h4>Matters</h4>${matters.map(m=>`<div class="card"><strong>${escapeHtml(m.title)}</strong><p class="muted">${escapeHtml(m.status)}${m.decision?` · ${escapeHtml(m.decision)}`:''}</p><p>${escapeHtml(m.description || '')}</p><div class="btn-row">${m.status==='open'?`<button class="btn" data-action="recuse-committee-member" data-committee="${c.code}" data-matter-id="${m.id}">Recuse Member</button><button class="btn btn-primary" data-action="create-committee-vote" data-committee="${c.code}" data-matter-id="${m.id}">Open Vote</button>`:''}${m.voteId?`<button class="btn" data-route="votes">View Vote</button>`:''}</div></div>`).join('')}</div>`:''}</article>`;
  }).join('');
  return `<section class="section-header"><div><h1>Committees</h1><p class="muted">AC, PC, PAC and PPC membership, chairs, recusals and decisions.</p></div></section><div class="grid">${cards}</div>`;
}

function casesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const cases = Object.values(state.cases ?? {}).sort((a,b)=>new Date(b.openedAt)-new Date(a.openedAt));
  return `<section class="section-header"><div><h1>Cases</h1><p class="muted">Ordinary-law cases move through PAC review, jury review and PPC punishment.</p></div><button class="btn btn-primary" data-action="open-case">Open Case</button></section><div class="grid">${cases.map(c=>{const accused=state.players[c.accusedId]?.displayName??c.accusedId;const law=state.laws[c.lawId]?.title??c.lawId;return `<article class="card"><span class="pill">${escapeHtml(c.id)}</span><h3>${escapeHtml(accused)} · ${escapeHtml(law)}</h3><p class="muted">Status: ${escapeHtml(c.status)}</p><p><strong>Allegation:</strong> ${escapeHtml(c.conduct)}</p>${c.accusedResponse?`<p><strong>Response:</strong> ${escapeHtml(c.accusedResponse)}</p>`:''}<p><strong>PAC:</strong> ${escapeHtml(c.pacFinding ?? 'Pending')}</p><p><strong>Jury:</strong> ${escapeHtml(c.juryResult ?? 'Pending')}</p>${c.ppcPunishment?`<p><strong>Punishment:</strong> ${escapeHtml(c.ppcPunishment.text)}</p>`:''}<div class="btn-row">${!c.accusedResponse?`<button class="btn" data-action="case-response" data-case-id="${c.id}">Record Response</button>`:''}${c.status==='open'?`<button class="btn" data-action="assign-pac-panel" data-case-id="${c.id}">Assign PAC Panel</button>`:''}${['pac-review','pac-voting'].includes(c.status)&&!c.pacVoteId?`<button class="btn btn-primary" data-action="create-pac-vote" data-case-id="${c.id}">Open PAC Vote</button>`:''}${c.status==='awaiting-jury'?`<button class="btn" data-action="select-jury" data-case-id="${c.id}">Select Jury</button>`:''}${c.status==='jury-ready'?`<button class="btn btn-primary" data-action="create-jury-vote" data-case-id="${c.id}">Open Jury Vote</button>`:''}${c.status==='awaiting-ppc'?`<button class="btn btn-primary" data-action="record-ppc-punishment" data-case-id="${c.id}">Record PPC Punishment</button>`:''}</div></article>`}).join('') || '<div class="empty">No cases have been opened.</div>'}</div>`;
}


function testLabPage() {
  const state = getState();
  if (!state) return noGamePage();
  const audit = auditState(state);
  const readiness = offlineReadiness(state);
  const passed = readiness.filter(item => item.pass).length;
  const auditRows = audit.issues.length
    ? audit.issues.map(item => `<li class="list-row"><div><strong>${escapeHtml(item.code)}</strong><div class="muted">${escapeHtml(item.message)}</div></div><span class="pill">${escapeHtml(item.level.toUpperCase())}</span></li>`).join('')
    : '<li class="list-row"><span>No structural problems detected.</span><strong>✓</strong></li>';
  const readinessRows = readiness.map(item => `<li class="list-row"><div><strong>${escapeHtml(item.label)}</strong><div class="muted">${escapeHtml(item.detail)}</div></div><strong>${item.pass ? '✓' : '—'}</strong></li>`).join('');
  const ruleSummary = lastRuleTestResult ? `${lastRuleTestResult.ok ? 'PASS' : 'FAIL'} · ${lastRuleTestResult.assertions.toLocaleString()} assertions` : 'Not run';
  const stressSummary = lastStressResult ? `${(lastStressResult.stateKiB ?? 0).toFixed(1)} KiB state · ${Math.round(lastStressResult.benchmark?.operationsPerSecond ?? 0).toLocaleString()} count ops/s` : 'Not run';
  const fanoutRows = lastStressResult ? lastStressResult.fanout.map(row => `<tr><td>${row.players}</td><td>${row.peers}</td><td>${(row.oneFullBroadcastBytes/1024).toFixed(1)} KiB</td><td>${(row.tenFullBroadcastsBytes/1024/1024).toFixed(2)} MiB</td></tr>`).join('') : '';
  return `<section class="section-header"><div><h1>Test & Stress Lab</h1><p class="muted">Phases 12, 27 and 28 tools for test data, structural audits, randomized rule invariants and synthetic multiplayer load measurements.</p></div></section>
    <div class="grid grid-4">${statCard(audit.errors,'Audit Errors')}${statCard(audit.warnings,'Audit Warnings')}${statCard(`${passed}/${readiness.length}`,'Readiness Checks')}${statCard(state.history?.length ?? 0,'Official Events')}</div>
    <section class="section grid grid-2"><article class="card"><h2>Phase 27 — Rule Property Tests</h2><p class="muted">Runs 2,000 deterministic randomized scenarios against election allocation, ranked-choice counting, turnout, legislative majorities and committee thresholds.</p><p><strong>${ruleSummary}</strong></p>${lastRuleTestResult && !lastRuleTestResult.ok ? `<ul class="list">${lastRuleTestResult.failures.slice(0,8).map(f=>`<li class="list-row"><span>${escapeHtml(f.name)}</span><code>${escapeHtml(f.detail||'')}</code></li>`).join('')}</ul>` : ''}<div class="btn-row"><button class="btn btn-primary" data-action="run-rule-tests">Run Rule Tests</button></div></article><article class="card"><h2>Phase 28 — Synthetic Multiplayer Stress</h2><p class="muted">Measures current save size, Cloud snapshot broadcast fan-out, election-counting throughput and integrity-audit cost at 2/10/25/50/100-player scales.</p><p><strong>${stressSummary}</strong></p><div class="btn-row"><button class="btn btn-primary" data-action="run-stress-tests">Run Stress Test</button></div></article></section>
    ${lastStressResult ? `<section class="section card"><h2>State Broadcast Cost</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Players</th><th>Recipients</th><th>1 snapshot broadcast</th><th>10 snapshot broadcasts</th></tr></thead><tbody>${fanoutRows}</tbody></table></div><p class="muted">${escapeHtml(lastStressResult.note)}</p></section>` : ''}
    <section class="card section"><div class="section-header compact-header"><div><h2>Test Data</h2><p class="muted">These tools deliberately change the current save. Export a backup first if this is a real game.</p></div></div><div class="btn-row"><button class="btn btn-primary" data-action="generate-test-players">Generate Players to 30</button><button class="btn" data-action="generate-test-parties">Create 3 Test Parties</button><button class="btn" data-action="distribute-test-players">Distribute Independents</button></div></section>
    <section class="card section"><div class="section-header compact-header"><div><h2>Offline Alpha Readiness</h2><p class="muted">This is a progress checklist, not a requirement that every real game contain all of these at once.</p></div><span class="pill">${passed}/${readiness.length}</span></div><ul class="list">${readinessRows}</ul></section>
    <section class="card section"><div class="section-header compact-header"><div><h2>State Integrity Audit</h2><p class="muted">Cross-checks references between players, parties, Parliament, government, committees, votes and cases.</p></div><button class="btn" data-action="rerun-audit">Run Again</button></div><ul class="list">${auditRows}</ul></section>`;
}

function homePage() {
  const state = getState();
  if (state) {
    const activePlayers = Object.values(state.players).filter(p => p.status === 'active').length;
    const activeParties = Object.values(state.parties).filter(p => p.status === 'active').length;
    const openVotes = Object.values(state.votes ?? {}).filter(v => v.status === 'open').length;
    return `<section class="dashboard-hero"><div><span class="page-kicker">Current Democracy</span><h1>${escapeHtml(state.meta.name)}</h1><p class="muted">${escapeHtml(state.meta.description || 'Political simulation in progress.')}</p></div><div class="dashboard-actions"><button class="btn" data-action="share-game">Share</button><button class="btn btn-primary" data-route="dashboard">Open Dashboard</button></div></section>
      <div class="grid grid-4 section">${statCard(activePlayers,'Active Players')}${statCard(activeParties,'Active Parties')}${statCard(openVotes,'Open Votes')}${statCard(`#${state.stateVersion}`,'State')}</div>
      <section class="section"><div class="quick-links"><button class="quick-link" data-route="votes"><strong>Votes</strong><span>${openVotes} currently open</span></button><button class="quick-link" data-route="parliament"><strong>Parliament</strong><span>${state.legislature?.totalSeats || 0} seats</span></button><button class="quick-link" data-route="government"><strong>Government</strong><span>${escapeHtml(state.government?.status || 'Not formed')}</span></button><button class="quick-link" data-route="laws"><strong>Laws</strong><span>${Object.keys(state.laws ?? {}).length} in the statute book</span></button></div></section>
      <section class="section card"><div class="section-header compact-header"><div><h2>Recent official activity</h2><p class="muted">The latest changes to this Democracy.</p></div><button class="btn" data-route="dashboard">Full dashboard</button></div>${historyList(state,8)}</section>`;
  }
  return `<section class="hero"><div><span class="pill">Free · Cloud connected · Browser based</span><h1>Run a democracy.<br>Not a spreadsheet.</h1><p>Official elections, Parliament, governments, laws, constitutional procedure and cases in one shared political game. Keep the campaigning in WhatsApp or Discord; Democracy Web keeps the official record.</p><div class="btn-row" style="margin-top:22px"><button class="btn btn-primary" data-route="create">Create Democracy</button><button class="btn" data-route="load">Open Saved Game</button></div></div><div class="hero-panel"><h3>Built for real groups</h3><ul class="list"><li class="list-row"><span>Free static hosting</span><strong>✓</strong></li><li class="list-row"><span>Cloud multiplayer</span><strong>✓</strong></li><li class="list-row"><span>Automatic elections & counts</span><strong>✓</strong></li><li class="list-row"><span>Constitution & legislation</span><strong>✓</strong></li><li class="list-row"><span>Committees & cases</span><strong>✓</strong></li><li class="list-row"><span>Mobile-friendly sharing</span><strong>✓</strong></li></ul></div></section>`;
}
function createPage() {
  return `
    <section class="section-header"><div><h1>Create Democracy</h1><p class="muted">Create another local Democracy. Existing saves remain available on this browser.</p></div></section>
    <form id="createGameForm" class="card form-grid">
      <div class="field"><label for="gameName">Country / game name</label><input id="gameName" name="gameName" required maxlength="80" placeholder="Republic of Beans"></div>
      <div class="field"><label for="creatorName">Your display name</label><input id="creatorName" name="creatorName" required maxlength="50" placeholder="Ben"></div>
      <div class="field"><label for="description">Description</label><textarea id="description" name="description" maxlength="500" placeholder="Optional short description"></textarea></div>
      <div class="field"><label for="constitutionPreset">Constitution preset</label><select id="constitutionPreset" name="constitutionPreset"><option value="democracy-v2">Democracy Constitution v2</option></select><small>Additional constitutional presets can be added later.</small></div>
      <div class="btn-row"><button class="btn btn-primary" type="submit">Create Game</button><button class="btn" type="button" data-route="home">Cancel</button></div>
    </form>`;
}

function loadPage() {
  const cards = savedGames.length ? savedGames.map(game => `
    <article class="card save-card">
      <div>
        <h3>${escapeHtml(game.name)}</h3>
        <p class="muted">Updated ${escapeHtml(formatDateTime(game.updatedAt))}</p>
        <div class="meta-row"><span>${game.playerCount} players</span><span>${game.partyCount} parties</span><span>State #${game.stateVersion}</span></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" data-action="load-save" data-game-id="${escapeHtml(game.id)}">Load</button>
        <button class="btn" data-action="export-save" data-game-id="${escapeHtml(game.id)}">Export</button>
        <button class="btn btn-danger" data-action="delete-save" data-game-id="${escapeHtml(game.id)}">Delete</button>
      </div>
    </article>`).join('') : '<div class="empty">No locally saved Democracies yet.</div>';

  return `
    <section class="section-header">
      <div><h1>Saved Democracies</h1><p class="muted">Games are stored locally in this browser using IndexedDB.</p></div>
      <div class="btn-row"><button class="btn" data-action="refresh-saves">Refresh</button><button class="btn btn-primary" data-action="import-save">Import Save</button></div>
    </section>
    <input id="importGameInput" type="file" accept=".democracy,.json,application/json" hidden>
    <div class="save-list">${cards}</div>
    <section class="card section"><h3>Backups</h3><p class="muted">Exported <code>.democracy</code> files contain the canonical game state and official event history. Automatic IndexedDB snapshots are also created periodically as state changes.</p></section>`;
}

function aboutPage() {
  return `<section class="card"><h1>About Democracy Web</h1><p>Democracy Web separates the political simulation from the chat platform. WhatsApp or Discord can remain the place for campaigns, arguments and coalition negotiations; this site becomes the official source of truth for game mechanics.</p><div class="grid grid-3 section"><div class="card"><h3>Static first</h3><p class="muted">Built for GitHub Pages with no traditional backend required.</p></div><div class="card"><h3>Rules first</h3><p class="muted">Political actions flow through a central action/state architecture.</p></div><div class="card"><h3>Durable</h3><p class="muted">IndexedDB autosaves, snapshots and portable save files preserve long-running games.</p></div></div><div class="section btn-row"><button class="btn btn-primary" data-action="install-app" id="installAppButton" ${deferredInstallPrompt?'':'disabled'}>Install Democracy Web</button><span class="muted">Install availability depends on your browser.</span></div></section>`;
}

function rulebookPage() {
  return `<section class="section-header"><div><h1>Full Rulebook</h1><p class="muted">The complete Democracy Constitution and rules, loaded from <code>full-rules.md</code>.</p></div><button class="btn" data-action="reload-rulebook">Reload</button></section><article id="rulebookContent" class="card rulebook"><div class="empty">Loading full rulebook…</div></article>`;
}

async function loadRulebook() {
  const target = document.querySelector('#rulebookContent');
  if (!target) return;
  try {
    const response = await fetch('./full-rules.md', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const markdown = await response.text();
    target.innerHTML = renderMarkdown(markdown);
  } catch (error) {
    console.error(error);
    target.innerHTML = `<div class="empty"><h2>Rulebook unavailable</h2><p>Could not load <code>full-rules.md</code>. Make sure the file is in the project root and the site is being opened through HTTP rather than <code>file://</code>.</p></div>`;
  }
}


function refreshAttention(state = getState(), notify = false) {
  attentionItems = deriveAttention(state, localActorId(state), getCloudNowMs());
  const pref = notificationPrefs();
  const visible = attentionItems.filter(item => !pref.dismissed?.[item.id]);
  const unread = visible.filter(item => !pref.seen?.[item.id]).length;
  const badge = document.querySelector('#notificationBadge');
  if (badge) { badge.textContent = String(unread); badge.hidden = unread === 0; }
  if (notify) maybeSendBrowserNotifications(visible);
  return visible;
}

function notificationsPage() {
  const state=getState(); if(!state)return noGamePage();
  const pref=notificationPrefs(); const items=refreshAttention(state,false).filter(i=>!pref.dismissed?.[i.id]);
  markAttentionSeen(items.map(i=>i.id));
  requestAnimationFrame(()=>refreshAttention(state,false));
  const support='Notification' in window;
  return `<section class="section-header"><div><h1>Notifications</h1><p class="muted">Deadlines and actions that may need your attention. The game remains fully usable with notifications disabled.</p></div><button class="btn" data-action="clear-dismissed-notifications">Reset dismissed</button></section>
  <section class="card"><div class="section-header compact-header"><div><h2>Browser notifications</h2><p class="muted">Optional reminders while the site is open or installed. Permission is controlled by your browser.</p></div><span class="status">${support?escapeHtml(Notification.permission):'unsupported'}</span></div><label class="check-row"><input type="checkbox" data-action="toggle-browser-notifications" ${pref.browser?'checked':''} ${support?'':'disabled'}> Send browser notifications for new attention items</label></section>
  <section class="section"><div class="grid">${items.map(i=>`<article class="card attention-item ${i.priority==='urgent'?'urgent':''}"><div><span class="pill">${escapeHtml(i.kind)}</span><h2>${escapeHtml(i.title)}</h2><p class="muted">${escapeHtml(i.message)}</p></div><div class="btn-row">${i.requestId ? `<button class="btn btn-primary" data-action="respond-party-membership" data-request-id="${escapeHtml(i.requestId)}" data-response="accept">Accept</button><button class="btn" data-action="respond-party-membership" data-request-id="${escapeHtml(i.requestId)}" data-response="reject">Reject</button>` : `<button class="btn btn-primary" data-route="${escapeHtml(i.route)}">Open</button>`}<button class="btn" data-action="dismiss-notification" data-notification-id="${escapeHtml(i.id)}">Dismiss</button></div></article>`).join('')||'<div class="empty"><h2>All caught up</h2><p>There are no current alerts for this player.</p></div>'}</div></section>`;
}

function dashboardPage() {
  const state = getState();
  if (!state) return `<section class="empty"><h2>No game loaded</h2><button class="btn btn-primary" data-route="create">Create Game</button></section>`;
  const players = Object.values(state.players);
  const activePlayers = players.filter(p => p.status === 'active');
  const activeParties = Object.values(state.parties).filter(p => p.status === 'active');
  const openVotes = Object.values(state.votes ?? {}).filter(v => v.status === 'open').sort((a,b)=>new Date(a.closesAt)-new Date(b.closesAt));
  const host = state.meta.hostPlayerId ? state.players[state.meta.hostPlayerId] : null;
  const pm = state.government?.primeMinisterId ? state.players[state.government.primeMinisterId] : null;
  const filled = filledLegislativeSeats(state).length;
  const totalSeats = state.legislature?.totalSeats || 0;
  const activeCases = Object.values(state.cases ?? {}).filter(c => !['closed','dismissed','not-guilty'].includes(c.status));
  const attention = [
    ...openVotes.slice(0,4).map(v=>`<li class="list-row"><div><strong>${escapeHtml(v.title)}</strong><div class="muted">Vote closes ${escapeHtml(formatDateTime(v.closesAt))}</div></div><button class="btn" data-route="${v.electionKind?'elections':'votes'}">Open</button></li>`),
    ...(state.government?.status === 'caretaker' ? [`<li class="list-row"><div><strong>Caretaker government</strong><div class="muted">A new majority may need to be formed.</div></div><button class="btn" data-route="government">Review</button></li>`] : []),
    ...(activeCases.length ? [`<li class="list-row"><div><strong>${activeCases.length} active case${activeCases.length===1?'':'s'}</strong><div class="muted">Case procedure may require action.</div></div><button class="btn" data-route="cases">Cases</button></li>`] : [])
  ];
  return `<section class="dashboard-hero"><div><span class="page-kicker">Official dashboard</span><h1>${escapeHtml(state.meta.name)}</h1><p class="muted">State #${state.stateVersion} · ${escapeHtml(state.government?.status || 'No government')} · autosaved locally</p></div><div class="dashboard-actions"><button class="btn" data-route="notifications">Notifications <span class="inline-badge">${refreshAttention(state,false).filter(i=>!notificationPrefs().dismissed?.[i.id]).length}</span></button><button class="btn" data-action="share-game">Share Game</button><button class="btn" data-action="export-current">Export Backup</button></div></section>
    <div class="grid grid-4 section">${statCard(activePlayers.length,'Active Players')}${statCard(openVotes.length,'Open Votes')}${statCard(host?.displayName ?? '—','Host')}${statCard(pm?.displayName ?? '—','Prime Minister')}</div>
    <section class="section grid grid-2"><article class="card attention-card ${attention.length?'':'good'}"><div class="section-header compact-header"><div><h2>${attention.length?'Needs attention':'All caught up'}</h2><p class="muted">Time-sensitive political activity.</p></div><span class="pill">${attention.length}</span></div>${attention.length?`<ul class="list">${attention.join('')}</ul>`:'<p class="muted">No open vote, caretaker-government warning or active case needs attention right now.</p>'}</article><article class="card"><h2>Political state</h2><dl class="kv"><dt>Parliament</dt><dd>${filled}/${totalSeats} seats filled</dd><dt>Government</dt><dd>${escapeHtml(state.government?.status || 'Not formed')}</dd><dt>Parties</dt><dd>${activeParties.length} active</dd><dt>Constitution</dt><dd>Version ${escapeHtml(String(state.constitution?.version ?? 1))}</dd></dl></article></section>
    <section class="section"><div class="quick-links"><button class="quick-link" data-route="elections"><strong>Elections</strong><span>Open and certify elections</span></button><button class="quick-link" data-route="parliament"><strong>Parliament</strong><span>Seats and legislative votes</span></button><button class="quick-link" data-route="government"><strong>Government</strong><span>Coalitions and ministers</span></button><button class="quick-link" data-route="parties"><strong>Parties</strong><span>${activeParties.length} active parties</span></button><button class="quick-link" data-route="laws"><strong>Laws</strong><span>Legislation and referendums</span></button><button class="quick-link" data-route="constitution"><strong>Constitution</strong><span>Current save constitution</span></button><button class="quick-link" data-route="committees"><strong>Committees</strong><span>AC, PC, PAC and PPC</span></button><button class="quick-link" data-route="cases"><strong>Cases</strong><span>${activeCases.length} active</span></button></div></section>
    <section class="section card share-card"><div><h2 style="margin:0">Bring the politics to the group chat</h2><p class="muted">Share the lobby or copy a compact country-status message for WhatsApp or Discord.</p></div><div class="btn-row"><button class="btn" data-action="copy-status-summary">Copy Status</button><button class="btn btn-primary" data-action="share-game">Share</button></div></section>
    <section class="section card"><div class="section-header compact-header"><div><h2>Official history</h2><p class="muted">Latest certified state changes.</p></div></div>${historyList(state,12)}</section>`;
}
function playersPage() {
  const state = getState();
  if (!state) return noGamePage();
  const players = Object.values(state.players).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const actorId = localActorId(state);
  const online = isOnlineGame();
  const hostLike = isHostLikeLocal(state, actorId);
  return `
    <section class="section-header">
      <div><h1>Players</h1><p class="muted">In multiplayer, player-originated actions are bound to the cryptographic identity connected to this browser.</p></div>
      ${!online || hostLike ? '<button class="btn btn-primary" data-action="add-player">Add Player</button>' : ''}
    </section>
    <div class="card table-wrap"><table class="data-table"><thead><tr><th>Player</th><th>Status</th><th>Party</th><th>Joined</th><th>Actions</th></tr></thead><tbody>
      ${players.map(player => {
        const self = player.id === actorId;
        return `<tr>
          <td><strong>${escapeHtml(player.displayName)}</strong>${player.roles?.includes('creator') ? ' <span class="pill">Creator</span>' : ''}${self && online ? ' <span class="pill">You</span>' : ''}</td>
          <td><span class="status status-${escapeHtml(player.status)}">${escapeHtml(playerStatusLabel(player.status))}</span></td>
          <td>${partyBadge(state, player)}</td>
          <td>${escapeHtml(formatDateTime(player.joinedAt))}</td>
          <td><div class="btn-row compact">
            <button class="btn" data-action="view-player" data-player-id="${player.id}">View</button>
            ${!online || self ? `<button class="btn" data-action="rename-player" data-player-id="${player.id}">Rename</button>` : ''}
            ${(!online || hostLike) && player.status === 'active' ? `<button class="btn" data-action="set-inactive" data-player-id="${player.id}">Inactive</button>` : ''}
            ${(!online || hostLike) && player.status === 'inactive' ? `<button class="btn" data-action="set-active" data-player-id="${player.id}">Activate</button>` : ''}
            ${(!online || self) && !['resigned','removed'].includes(player.status) ? `<button class="btn btn-danger" data-action="resign-player" data-player-id="${player.id}">Resign</button>` : ''}
          </div></td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`;
}

function partiesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const parties = Object.values(state.parties).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1));
  const actorId = localActorId(state);
  const actor = actorId ? state.players[actorId] : null;
  return `
    <section class="section-header">
      <div><h1>Political Parties</h1><p class="muted">Party membership requires consent. Leaders invite; players accept or request membership.</p></div>
      ${actor?.status === 'active' && !actor.partyId ? '<button class="btn btn-primary" data-action="create-party">Create Party</button>' : ''}
    </section>
    <div class="grid grid-2">
      ${parties.map(party => partyCard(state, party)).join('') || '<div class="empty">No political parties have been created.</div>'}
    </div>`;
}

function partyCard(state, party) {
  const leader = party.leaderId ? state.players[party.leaderId] : null;
  const members = party.members.map(id => state.players[id]).filter(Boolean);
  const actorId = localActorId(state);
  const actor = actorId ? state.players[actorId] : null;
  const online = isOnlineGame();
  const isLeader = party.leaderId === actorId;
  const isMember = actor?.partyId === party.id;
  const pending = Object.values(state.partyMembershipRequests ?? {}).find(r => r.status === 'pending' && r.playerId === actorId);
  const canRequest = party.status === 'active' && actor?.status === 'active' && !actor.partyId && !pending;
  return `<article class="card party-card ${party.status === 'dissolved' ? 'is-dissolved' : ''}">
    <div class="party-heading"><span class="party-swatch" style="--party-colour:${escapeHtml(party.colour)}"></span><div><h2>${escapeHtml(party.name)} ${party.abbreviation ? `<span class="muted">(${escapeHtml(party.abbreviation)})</span>` : ''}</h2><p class="muted">${party.status === 'active' ? 'Active party' : `Dissolved ${escapeHtml(formatDateTime(party.dissolvedAt))}`}</p></div></div>
    <p>${escapeHtml(party.description || 'No party description.')}</p>
    <dl class="kv"><dt>Leader</dt><dd>${escapeHtml(leader?.displayName ?? 'Vacant')}</dd><dt>Members</dt><dd>${members.length}</dd><dt>Created</dt><dd>${escapeHtml(formatDateTime(party.createdAt))}</dd></dl>
    ${members.length ? `<div class="member-chips">${members.map(m => `<span class="pill">${escapeHtml(m.displayName)}${m.id===actorId?' · You':''}</span>`).join('')}</div>` : ''}
    ${party.status === 'active' ? `<div class="btn-row section">
      ${canRequest ? `<button class="btn btn-primary" data-action="request-party-join" data-party-id="${party.id}">Request to Join</button>` : ''}
      ${pending && !actor?.partyId ? `<span class="pill">Membership request pending</span>` : ''}
      ${isMember ? `<button class="btn" data-action="leave-party-self">Leave Party</button>` : ''}
      ${!online || isLeader ? `<button class="btn" data-action="edit-party" data-party-id="${party.id}">Edit</button><button class="btn" data-action="manage-party-members" data-party-id="${party.id}">Members</button><button class="btn" data-action="change-party-leader" data-party-id="${party.id}">Leader</button><button class="btn btn-danger" data-action="dissolve-party" data-party-id="${party.id}">Dissolve</button>` : ''}
    </div>` : ''}
  </article>`;
}

function identityCard() {
  const identity = getStoredIdentitySummary();
  const fp = identity?.fingerprint ? `${identity.fingerprint.slice(0,16)}…${identity.fingerprint.slice(-8)}` : 'Not generated yet';
  return `<section class="section card"><h2>Player Identity</h2><p class="muted">The signing key is held by this browser, not inside the Democracy save. Secure identities use a non-extractable Web Crypto key stored in IndexedDB.</p><dl class="kv"><dt>Algorithm</dt><dd>${escapeHtml(identity?.algorithm || 'ECDSA P-256 / SHA-256')}</dd><dt>Fingerprint</dt><dd><code>${escapeHtml(fp)}</code></dd><dt>Private key</dt><dd>${escapeHtml(identity?.privateKeyStorage || 'Not generated')}</dd><dt>Created</dt><dd>${identity?.createdAt ? escapeHtml(formatDateTime(identity.createdAt)) : '—'}</dd></dl><div class="btn-row"><button class="btn" data-action="generate-identity">${identity?'Verify Identity':'Generate Identity'}</button><button class="btn" data-action="import-identity">Import Legacy Identity</button></div><p class="muted"><strong>1.0.3 security change:</strong> raw private-key export is disabled for newly secured identities, preventing the signing key from being copied out of browser storage as plaintext JWK.</p></section>`;
}

function cloudMultiplayerCard(state) {
  const cloud = getCloudStatus();
  const settings = getCloudSettings();
  const creator = state ? Object.values(state.players ?? {}).find(player => player.roles?.includes('creator')) : null;
  const activeSession = Boolean(cloud.roomCode);
  const connected = cloud.connection === 'connected';
  const statusLabel = ({
    offline:'Offline', connecting:'Connecting…', authenticating:'Authenticating…', connected:'Connected',
    syncing:'Resynchronising…', reconnecting:'Reconnecting…', disconnected:'Disconnected', error:'Error'
  })[cloud.connection] || cloud.connection;
  const roleLabel = cloud.authRole === 'creator' ? 'Creator' : cloud.authRole === 'player' ? 'Approved player' : cloud.authRole === 'unregistered' ? 'Authenticated · awaiting approval' : '—';
  const joinRequests = cloud.joinRequests || [];
  const requestsHtml = joinRequests.length ? `<div class="section"><div class="section-header compact-header"><div><h3>Join Requests</h3><p class="muted">Each request is tied to a verified public key. Approval becomes a signed canonical player-add transition.</p></div><span class="badge">${joinRequests.length}</span></div>${joinRequests.map(req=>`<article class="notice"><div class="split"><div><strong>${escapeHtml(req.displayName)}</strong><br><small class="muted">Identity ${escapeHtml(req.fingerprint.slice(0,12))}… · ${formatDateTime(req.requestedAt)}</small></div><div class="btn-row"><button class="btn btn-primary" data-action="cloud-approve-join" data-request-id="${escapeHtml(req.requestId)}">Approve</button><button class="btn" data-action="cloud-reject-join" data-request-id="${escapeHtml(req.requestId)}">Reject</button></div></div></article>`).join('')}</div>` : '';

  let sessionHtml = '';
  if (activeSession) {
    const invite = (() => { try { return cloudInviteUrl(cloud.roomCode); } catch { return ''; } })();
    sessionHtml = `<div class="grid grid-4"><div><span class="page-kicker">Room</span><strong>${escapeHtml(cloud.roomCode||'—')}</strong></div><div><span class="page-kicker">Identity</span><strong>${escapeHtml(roleLabel)}</strong></div><div><span class="page-kicker">State</span><strong>#${Number(cloud.stateVersion||0)}</strong></div><div><span class="page-kicker">Commit</span><strong>#${Number(cloud.commitSequence||0)}</strong></div></div>`;
    if (cloud.authRole === 'unregistered') {
      const joinState = cloud.joinStatus === 'pending' || cloud.joinStatus === 'requesting'
        ? `<div class="notice"><strong>Join request pending</strong><p>The authorised Host, Deputy Host, or pre-Host creator must approve this verified identity before it receives the canonical game state.</p></div>`
        : cloud.joinStatus === 'rejected'
          ? `<div class="notice danger"><strong>Join request rejected</strong><p>You may submit a new request if the Host asks you to try again.</p></div>`
          : `<article class="notice"><strong>Request to join this Democracy</strong><p>Your browser has proved ownership of its cryptographic identity but is not yet a player in this room.</p><div class="field"><label>Display name</label><input id="cloudJoinDisplayName" maxlength="50" placeholder="Your player name"></div><button class="btn btn-primary" data-action="cloud-request-join">Request to Join</button></article>`;
      sessionHtml += joinState;
    } else {
      sessionHtml += `<div class="grid grid-3"><div><span class="page-kicker">Local player</span><strong>${escapeHtml(cloud.displayName||cloud.localPlayerId||'—')}</strong></div><div><span class="page-kicker">Connected clients</span><strong>${Number(cloud.connectedClients||0)}</strong></div><div><span class="page-kicker">State integrity</span><strong>${cloud.stateSynced && cloud.stateHash ? 'Verified' : 'Waiting…'}</strong></div></div>
        <div class="grid grid-3 section"><div><span class="page-kicker">Canonical clock</span><strong>${cloud.lastTimeSyncAt ? `${Number(cloud.serverTimeOffsetMs||0)>=0?'+':''}${Number(cloud.serverTimeOffsetMs||0)} ms` : 'Syncing…'}</strong><br><small class="muted">RTT ${cloud.clockRttMs == null ? '—' : `${Number(cloud.clockRttMs)} ms`}</small></div><div><span class="page-kicker">Recovery</span><strong>${escapeHtml(cloud.recoverySource||'Waiting…')}</strong></div><div><span class="page-kicker">Persistent snapshot</span><strong>#${Number(cloud.snapshotSequence||0)}</strong></div></div>
        ${cloud.connection==='reconnecting' ? `<div class="notice"><strong>Automatic reconnect active</strong><p>Attempt ${Number(cloud.reconnectAttempt||0)}${cloud.nextReconnectAt ? ` · next retry in ${Math.max(0,Math.ceil((cloud.nextReconnectAt-Date.now())/1000))}s` : ''}. The last verified state remains available read-only until recovery completes.</p></div>` : ''}
        ${requestsHtml}
        <div class="btn-row"><button class="btn" data-action="cloud-resync">Request Verified Resync</button></div>`;
    }
    if (invite) sessionHtml += `<section class="section notice"><strong>Invite</strong><div class="field"><label>Cloud invite link</label><input readonly value="${escapeHtml(invite)}"></div><div class="btn-row"><button class="btn btn-primary" data-action="copy-cloud-invite">Copy Invite Link</button><button class="btn" data-action="copy-cloud-room">Copy Room Code</button></div><p class="muted">The invite includes the room code and Cloud backend address. Player identity is still verified cryptographically after connection.</p></section>`;
    sessionHtml += `<div class="btn-row"><button class="btn btn-danger" data-action="cloud-leave">Disconnect Cloud</button></div>`;
  } else {
    sessionHtml = `<div class="grid grid-2"><article class="notice"><strong>Publish current save to Cloud</strong><p>Creates a Durable Object room from the current verified save. Political state and history are preserved; obsolete P2P transport metadata is normalised.</p><div class="field"><label>Optional room code</label><input id="cloudCreateRoom" maxlength="6" placeholder="Leave blank to generate"></div><button class="btn btn-primary" type="button" data-action="cloud-create" ${state&&creator?'':'disabled'}>Publish & Connect</button></article><article class="notice"><strong>Join Cloud room</strong><p>Existing players are recognised by their signing key. New identities authenticate first, then request approval.</p><div class="field"><label>Room code</label><input id="cloudJoinRoom" maxlength="6" value="${escapeHtml(new URL(location.href).searchParams.get('room')||'')}" placeholder="ABC234"></div><button class="btn" type="button" data-action="cloud-connect">Connect</button></article></div>`;
  }

  return `<section class="section card"><div class="section-header compact-header"><div><span class="page-kicker">Democracy Web 1.1</span><h2>Cloud Multiplayer</h2><p class="muted">Cloudflare Durable Objects are now the production multiplayer transport. Signed actions, deterministic client verification, durable snapshots, and automatic reconnect replace the former WebRTC/P2P stack.</p></div><span class="status ${connected?'status-active':cloud.connection==='error'?'status-error':'status-inactive'}">${escapeHtml(statusLabel)}</span></div>
    <div class="form-grid">
      <div class="field"><label for="cloudApiBase">Cloud backend URL</label><input id="cloudApiBase" value="${escapeHtml(settings.apiBase)}" placeholder="https://your-worker.workers.dev" autocomplete="url"><small class="muted">Saved in this browser. For local development use <code>http://localhost:8787</code>; production defaults to the deployed Democracy Web Worker.</small></div>
      ${sessionHtml}
      ${cloud.lastError ? `<div class="notice danger"><strong>Cloud error</strong><p>${escapeHtml(cloud.lastError)}</p></div>` : ''}
      <div class="btn-row"><button type="button" class="btn" data-action="cloud-save-settings">Save Backend URL</button><span id="cloudBackendSavedStatus" class="muted" aria-live="polite">Saved in this browser</span></div>
    </div>
  </section>`;
}

function multiplayerPage() {
  const state = getState();
  return `<section class="section-header"><div><h1>Multiplayer</h1><p class="muted">Reliable signed multiplayer over Cloudflare WebSockets. No WebRTC, TURN, Nostr relays, or Lobby Owner network migration.</p></div></section>${cloudMultiplayerCard(state)}${identityCard()}`;
}

function recoveryPage() {
  const state = getState();
  if (!state) return noGamePage();
  const cloud = getCloudStatus();
  const snapshotRows = recoverySnapshots.map(snap => {
    const audit = recoverySnapshotAudit.find(a => a.snapshotId === snap.snapshotId);
    return `<tr><td>#${escapeHtml(String(snap.stateVersion))}</td><td>${escapeHtml(formatDateTime(snap.createdAt))}</td><td>${escapeHtml(snap.reason || 'snapshot')}</td><td>${audit ? (audit.ok ? '<span class="status status-active">Verified</span>' : '<span class="status status-removed">Invalid</span>') : '—'}</td><td><button class="btn" data-action="restore-snapshot" data-snapshot-id="${escapeHtml(snap.snapshotId)}" ${audit && !audit.ok ? 'disabled' : ''}>Restore</button></td></tr>`;
  }).join('');
  const sealedVotes = Object.values(state.votes ?? {}).filter(v => v.secretBallotMode === 'sealed-v1' && !v.revealedAt);
  const ballotRows = sealedVotes.map(v => `<tr><td>${escapeHtml(v.id)}</td><td>${escapeHtml(v.title)}</td><td>${Object.keys(v.submittedVoters ?? {}).length}</td><td>${ballotKeyAvailability[v.id] ? '<span class="status status-active">Key available</span>' : '<span class="status status-inactive">No local key</span>'}</td><td><div class="btn-row compact"><button class="btn" data-action="export-ballot-recovery" data-vote-id="${escapeHtml(v.id)}" ${ballotKeyAvailability[v.id] ? '' : 'disabled'}>Export Recovery</button><button class="btn" data-action="import-ballot-recovery" data-vote-id="${escapeHtml(v.id)}">Import Recovery</button></div></td></tr>`).join('');
  const cloudState = cloud.roomCode ? `${cloud.connection}${cloud.stateSynced ? ' · verified' : ''}` : 'offline';
  return `<section class="section-header"><div><h1>Recovery & Diagnostics</h1><p class="muted">Cloud recovery uses verified commit deltas first and persistent Durable Object snapshots when a full repair is needed. Local snapshots remain available for offline backup and rollback.</p></div><button class="btn" data-action="refresh-recovery">Refresh</button></section>
  <div class="grid grid-4">${statCard(`#${state.stateVersion}`,'Local State')}${statCard(`#${Number(cloud.commitSequence||0)}`,'Cloud Commit')}${statCard(cloudState,'Cloud')}${statCard(recoverySnapshots.length,'Local Snapshots')}</div>
  <section class="section grid grid-2"><article class="card"><h2>Cloud Recovery</h2><dl class="kv"><dt>Room</dt><dd>${escapeHtml(cloud.roomCode || 'None')}</dd><dt>Connection</dt><dd>${escapeHtml(cloud.connection || 'offline')}</dd><dt>Player</dt><dd>${escapeHtml(cloud.displayName || cloud.localPlayerId || '—')}</dd><dt>State integrity</dt><dd>${cloud.stateSynced && cloud.stateHash ? 'Verified' : 'Not synchronised'}</dd><dt>Recovery source</dt><dd>${escapeHtml(cloud.recoverySource || '—')}</dd><dt>Persistent snapshot</dt><dd>#${Number(cloud.snapshotSequence || 0)}</dd><dt>Last error</dt><dd>${escapeHtml(cloud.lastError || 'None')}</dd></dl><div class="btn-row"><button class="btn btn-primary" data-action="cloud-resync" ${cloud.roomCode && cloud.authenticated ? '' : 'disabled'}>Request Verified Resync</button></div></article>
  <article class="card"><h2>Recovery Rules</h2><ul><li>Clients only accept snapshots whose canonical hash verifies.</li><li>Missed actions are replayed from the last verified commit when possible.</li><li>Large gaps fall back to the latest persistent Cloud snapshot plus later signed commits.</li><li>Local snapshot restore creates a pre-restore safety snapshot first.</li><li>Sealed-ballot private keys are never placed in normal Cloud game state.</li></ul></article></section>
  <section class="section card"><h2>Verified Local Snapshots</h2><p class="muted">These are browser-local safety copies. Restoring rewinds the local save and should not be used to overwrite an active Cloud room; use Verified Resync for Cloud recovery.</p>${snapshotRows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>State</th><th>Created</th><th>Reason</th><th>Integrity</th><th></th></tr></thead><tbody>${snapshotRows}</tbody></table></div>` : '<div class="empty">No local snapshots for this game yet.</div>'}</section>
  <section class="section card"><h2>Sealed Ballot Recovery</h2><p class="muted">Export a password-protected recovery package before a critical secret vote closes. It contains the ballot-box private key encrypted with PBKDF2 + AES-GCM and can be imported on another browser if the original ballot-box holder is lost.</p>${ballotRows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Vote</th><th>Title</th><th>Ballots</th><th>Local Key</th><th>Recovery</th></tr></thead><tbody>${ballotRows}</tbody></table></div>` : '<div class="empty">No unrevealed sealed secret votes exist.</div>'}</section>`;
}

async function refreshRecoveryData(rerender = true) {
  const state = getState();
  if (!state) return;
  recoverySnapshots = await listSnapshots(state.meta.id);
  recoverySnapshotAudit = await verifySnapshots(state.meta.id);
  ballotKeyAvailability = {};
  for (const vote of Object.values(state.votes ?? {}).filter(v => v.secretBallotMode === 'sealed-v1' && !v.revealedAt)) ballotKeyAvailability[vote.id] = await hasBallotBoxKey(vote.id);
  if (rerender && location.hash === '#recovery') renderCurrentRoute();
}


function releasePage() {
  const state = getState();
  const cloud = getCloudStatus();
  const checks = releaseReadiness(state, cloud);
  const passCount = checks.filter(item => item.ok).length;
  return `<section class="section-header"><div><span class="page-kicker">Stable release</span><h1>Democracy Web 1.1</h1><p class="muted">Released ${escapeHtml(RELEASE_DATE)} · ${escapeHtml(RELEASE_CHANNEL)} channel</p></div><div class="btn-row"><button class="btn btn-primary" data-action="start-onboarding">Show Quick Start</button><button class="btn" data-action="copy-diagnostic-report">Copy Diagnostic Report</button><button class="btn" data-action="download-diagnostic-report">Download Diagnostics</button></div></section>
  <section class="section grid grid-3"><article class="card"><span class="page-kicker">Release readiness</span><h2>${passCount}/${checks.length}</h2><p class="muted">Checks currently passing on this browser/save.</p></article><article class="card"><span class="page-kicker">Version</span><h2>v${escapeHtml(APP_VERSION)}</h2><p class="muted">Cloud multiplayer release.</p></article><article class="card"><span class="page-kicker">Diagnostics</span><h2>${runtimeErrors.length}</h2><p class="muted">Runtime error(s) captured this session.</p></article></section>
  <section class="section card"><h2>Readiness checks</h2><ul class="list">${checks.map(item=>`<li class="list-row"><div><strong>${escapeHtml(item.label)}</strong><div class="muted">${escapeHtml(item.detail)}</div></div><span class="pill">${item.ok?'PASS':'CHECK'}</span></li>`).join('')}</ul></section>
  <section class="section grid grid-2"><article class="card"><h2>1.1 highlights</h2><ul>${RELEASE_HIGHLIGHTS.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></article><article class="card"><h2>Known limitations</h2><ul>${KNOWN_LIMITATIONS.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></article></section>
  <section class="section card"><h2>Feedback / bug reports</h2><p>Democracy Web does not need a feedback server. The diagnostic report contains build, browser, integrity and networking metadata without including ballot contents, private keys, room codes or save text.</p><p class="muted">If something breaks, copy or download the diagnostic report and attach it to your bug report along with the steps that caused the problem.</p></section>`;
}

function showOnboarding(force = false) {
  if (!force && localStorage.getItem(ONBOARDING_KEY) === 'done') return;
  showModal({
    title: 'Welcome to Democracy Web 1.1',
    body: `<div class="form-grid"><div class="notice"><strong>1 · Create or load a Democracy</strong><p>Each save carries its own laws, Constitution, political state and history.</p></div><div class="notice"><strong>2 · Add players and parties</strong><p>Run locally first, or open Multiplayer and share an invite link.</p></div><div class="notice"><strong>3 · Run official politics here</strong><p>Use Votes, Elections, Parliament, Government, Laws, Committees and Cases for binding game actions. Keep campaigning in WhatsApp/Discord if you want.</p></div><div class="notice"><strong>4 · Protect long-running games</strong><p>Autosave is automatic, but export regular backups. Production multiplayer should use HTTPS.</p></div></div>`,
    confirmText: 'Start Democracy',
    cancelText: 'Skip',
    onConfirm() { localStorage.setItem(ONBOARDING_KEY, 'done'); navigate(hasGame() ? 'dashboard' : 'home'); }
  });
  localStorage.setItem(ONBOARDING_KEY, 'done');
}

function diagnosticText() {
  return buildDiagnosticReport({ state: getState(), networkStatus: getCloudStatus(), recentErrors: runtimeErrors });
}

function noGamePage() {
  return `<section class="empty"><h2>No game loaded</h2><p>Load or create a Democracy first.</p><div class="btn-row" style="justify-content:center"><button class="btn btn-primary" data-route="create">Create</button><button class="btn" data-route="load">Load</button></div></section>`;
}

function historyList(state, limit) {
  const integrity = verifyEventChain(state.history ?? []);
  const integrityBanner = `<div class="notice ${integrity.ok?'success':'error'}"><strong>History integrity:</strong> ${integrity.ok ? `verified · ${integrity.count} chained event(s)${integrity.headHash ? ` · head ${integrity.headHash.slice(0,12)}…` : ''}` : `FAILED at event ${(integrity.index??0)+1} (${integrity.reason})`}</div>`;
  const events = [...state.history].reverse().slice(0, limit);
  if (!events.length) return integrityBanner + '<div class="empty">No official events yet.</div>';
  return integrityBanner + `<ul class="list">${events.map(event => `<li class="list-row"><div><strong>${escapeHtml(describeEvent(event, state))}</strong><div class="muted">${escapeHtml(formatDateTime(event.timestamp))}</div></div><span class="pill">${escapeHtml(event.type)}</span></li>`).join('')}</ul>`;
}

registerRoute('home', homePage);
registerRoute('create', createPage);
registerRoute('load', loadPage);
registerRoute('about', aboutPage);
registerRoute('dashboard', dashboardPage);
registerRoute('players', playersPage);
registerRoute('parties', partiesPage);
registerRoute('votes', votesPage);
registerRoute('elections', electionsPage);
registerRoute('parliament', parliamentPage);
registerRoute('government', governmentPage);
registerRoute('laws', lawsPage);
registerRoute('constitution', constitutionPage);
registerRoute('rulebook', rulebookPage);
registerRoute('committees', committeesPage);
registerRoute('cases', casesPage);
registerRoute('testlab', testLabPage);
registerRoute('multiplayer', multiplayerPage);
registerRoute('notifications', notificationsPage);
registerRoute('recovery', recoveryPage);
registerRoute('release', releasePage);

initRouter();

document.addEventListener('route:rendered', event => {
  setMobileMenu(false);
  const heading=document.querySelector('#view h1, #view h2');
  document.title = heading ? `${heading.textContent} · Democracy Web` : 'Democracy Web';
  const announcer=document.querySelector('#connectionAnnouncer'); if(announcer&&heading) announcer.textContent=`${heading.textContent} page loaded`; 
  if (event.detail.route === 'rulebook') loadRulebook();
  if (event.detail.route === 'recovery') refreshRecoveryData(false).then(()=>{ if(location.hash==='#recovery') renderCurrentRoute(); }).catch(error=>toast(error.message,'error'));
});

async function refreshSavedGames(rerender = false) {
  try {
    savedGames = await listSavedGames();
    if (rerender && location.hash === '#load') renderCurrentRoute();
  } catch (error) {
    console.error(error);
    toast('Could not read local saves.', 'error');
  }
}

function queueAutosave(state) {
  if (!state) return;
  setSaveStatus('Saving…', 'saving');
  saveChain = saveChain.then(async () => {
    await saveGame(state);
    if (shouldCreateAutomaticSnapshot(state) && lastSnapshotted.get(state.meta.id) !== state.stateVersion) {
      await createSnapshot(state, 'automatic');
      lastSnapshotted.set(state.meta.id, state.stateVersion);
    }
    await refreshSavedGames(false);
    setSaveStatus('Saved ✓', 'saved');
  }).catch(error => {
    console.error(error);
    setSaveStatus('Save failed', 'error');
    toast(`Autosave failed: ${error.message}`, 'error');
  });
}

subscribe(queueAutosave);
subscribe(state => { refreshAttention(state, true); if (location.hash === '#notifications') renderCurrentRoute(); });
subscribeCloudNetwork(() => { if (['#multiplayer','#recovery','#release'].includes(location.hash)) renderCurrentRoute(); });
window.addEventListener('network:action-rejected', e => toast(e.detail?.message || 'Online action rejected', 'error'));


function downloadState(state) {
  const blob = exportGameFile(state);
  const safeName = state.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'democracy';
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName}-${date}.democracy`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('route:rendered', event => {
  if (event.detail.route === 'create') {
    document.querySelector('#createGameForm')?.addEventListener('submit', e => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      createGame({ gameName: data.get('gameName'), creatorName: data.get('creatorName'), description: data.get('description'), constitutionPreset: data.get('constitutionPreset') });
      toast('Democracy created');
      navigate('dashboard');
    });
  }

  if (event.detail.route === 'load') {
    document.querySelector('#importGameInput')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const state = await importGameFile(file);
        loadState(state);
        await saveGame(state);
        await createSnapshot(state, 'import');
        await refreshSavedGames(false);
        toast('Save imported');
        navigate('dashboard');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        e.target.value = '';
      }
    });
  }
});

document.addEventListener('change', event => {
  if (event.target?.id !== 'cloudApiBase') return;
  try {
    const saved = setCloudSettings({ enabled: true, apiBase: event.target.value });
    event.target.value = saved.apiBase;
    const label = document.querySelector('#cloudBackendSavedStatus');
    if (label) label.textContent = 'Saved in this browser ✓';
  } catch (error) { toast(error.message, 'error'); }
});

document.addEventListener('keydown', event => {
  if (event.target?.id !== 'cloudApiBase' || event.key !== 'Enter') return;
  event.preventDefault();
  try {
    const saved = setCloudSettings({ enabled: true, apiBase: event.target.value });
    event.target.value = saved.apiBase;
    event.target.blur();
    const label = document.querySelector('#cloudBackendSavedStatus');
    if (label) label.textContent = 'Saved in this browser ✓';
    toast('Cloud backend URL saved in this browser');
  } catch (error) { toast(error.message, 'error'); }
});

document.addEventListener('click', async event => {
  const element = event.target.closest('[data-action]');
  const action = element?.dataset.action;
  if (!action) return;

  const state = getState();

  if (action === 'install-app') { if(!deferredInstallPrompt){toast('Install is not currently offered by this browser.');return;} deferredInstallPrompt.prompt(); const result=await deferredInstallPrompt.userChoice; if(result.outcome==='accepted')toast('Democracy Web installed'); deferredInstallPrompt=null; return; }
  if (action === 'toggle-browser-notifications') { const enabled=element.checked; if(enabled){const permission=await requestBrowserPermission(); if(permission!=='granted'){element.checked=false;setBrowserNotifications(false);toast('Browser notification permission was not granted.','error');return;}} setBrowserNotifications(enabled); refreshAttention(state,true); toast(enabled?'Browser notifications enabled':'Browser notifications disabled'); return; }
  if (action === 'dismiss-notification') { dismissAttention(element.dataset.notificationId); refreshAttention(state,false); renderCurrentRoute(); return; }
  if (action === 'clear-dismissed-notifications') { clearDismissed(); refreshAttention(state,false); renderCurrentRoute(); toast('Dismissed notifications restored'); return; }
  if (action === 'toggle-mobile-menu') { const menu=document.querySelector('#mobileMenu'); setMobileMenu(!menu?.classList.contains('is-open')); return; }
  if (action === 'share-game') {
    if (!state) return;
    const cloud = getCloudStatus();
    const link = cloud.roomCode ? cloudInviteUrl(cloud.roomCode) : location.href.split('#')[0]+'#dashboard';
    const gov=state.government?.primeMinisterId ? state.players[state.government.primeMinisterId]?.displayName : 'Not formed';
    await shareText({title:state.meta.name,text:`🏛 ${state.meta.name}
Prime Minister: ${gov||'—'}
Open votes: ${Object.values(state.votes??{}).filter(v=>v.status==='open').length}${cloud.roomCode?`
Cloud room: ${cloud.roomCode}`:''}`,url:link}); return;
  }
  if (action === 'copy-status-summary') {
    if (!state) return;
    const filled=filledLegislativeSeats(state).length; const total=state.legislature?.totalSeats||0; const pm=state.government?.primeMinisterId?state.players[state.government.primeMinisterId]?.displayName:'Not formed'; const host=state.meta.hostPlayerId?state.players[state.meta.hostPlayerId]?.displayName:'—';
    const summary=`🏛 ${state.meta.name}\nHost: ${host||'—'}\nPrime Minister: ${pm||'—'}\nParliament: ${filled}/${total} seats\nOpen votes: ${Object.values(state.votes??{}).filter(v=>v.status==='open').length}\nState #${state.stateVersion}`;
    try { await navigator.clipboard.writeText(summary); toast('Country status copied'); } catch { toast('Could not access clipboard','error'); } return;
  }
  if (action === 'share-vote') {
    const vote=state?.votes?.[element.dataset.voteId]; if(!vote)return; const remaining=vote.status==='open'?`Closes ${formatDateTime(vote.closesAt)}`:`Status: ${voteStatusLabel(vote.status)}`; const target=vote.electionKind?'elections':'votes'; await shareText({title:vote.title,text:`🗳 ${state.meta.name}\n${vote.title}\n${remaining}`,url:location.href.split('#')[0]+`#${target}`}); return;
  }

  if (action === 'start-onboarding') { showOnboarding(true); return; }
  if (action === 'copy-diagnostic-report') {
    try { await navigator.clipboard.writeText(diagnosticText()); toast('Diagnostic report copied'); }
    catch { toast('Could not access clipboard', 'error'); }
    return;
  }
  if (action === 'download-diagnostic-report') {
    const blob = new Blob([diagnosticText()], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `democracy-web-${APP_VERSION}-diagnostics.json`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Diagnostics downloaded'); return;
  }

  if (action === 'refresh-recovery') {
    try { await refreshRecoveryData(true); toast('Recovery diagnostics refreshed'); } catch(error) { toast(error.message,'error'); }
    return;
  }
  if (action === 'restore-snapshot') {
    try {
      const current=getState();
      if(current) await createSnapshot(current,'pre-restore');
      const restored=await restoreSnapshot(element.dataset.snapshotId);
      loadState(restored); await saveGame(restored); await refreshRecoveryData(false); toast(`Restored snapshot #${restored.stateVersion}`); renderCurrentRoute();
    } catch(error) { toast(error.message,'error'); }
    return;
  }
  if (action === 'export-ballot-recovery') {
    const voteId=element.dataset.voteId;
    showModal({title:'Export Sealed Ballot Recovery',body:'<div class="field"><label>Recovery passphrase</label><input id="recoveryPassphrase" type="password" minlength="8" autocomplete="new-password"></div><p class="muted">Use at least 8 characters. The passphrase is not stored by Democracy Web.</p>',confirmText:'Export Recovery',async onConfirm(root){try{const pass=root.querySelector('#recoveryPassphrase').value;const payload=await exportBallotBoxRecovery(voteId,pass);const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${voteId}-ballot-recovery.dbr`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Encrypted ballot recovery exported');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }
  if (action === 'import-ballot-recovery') {
    const voteId=element.dataset.voteId; const vote=state?.votes?.[voteId];
    const input=document.createElement('input'); input.type='file'; input.accept='.dbr,application/json'; input.style.display='none'; document.body.append(input);
    input.addEventListener('change',async()=>{const file=input.files?.[0];input.remove();if(!file)return;let payload;try{payload=JSON.parse(await file.text());}catch{toast('Invalid recovery file','error');return;}showModal({title:'Import Sealed Ballot Recovery',body:'<div class="field"><label>Recovery passphrase</label><input id="importRecoveryPass" type="password" autocomplete="current-password"></div>',confirmText:'Import Recovery',async onConfirm(root){try{await importBallotBoxRecovery(payload,root.querySelector('#importRecoveryPass').value,vote?.secretBoxPublicKey);await refreshRecoveryData(false);toast('Ballot-box key recovered on this browser');renderCurrentRoute();}catch(error){toast(error.message,'error');return false;}}});}); input.click();
    return;
  }

  const actorId = localActorId(state);

  if (action === 'respond-party-membership') {
    try {
      if (!actorId) throw new Error('Your local player identity is not ready yet.');
      dispatch({ type: 'PARTY_MEMBERSHIP_RESPONDED', actorId, requestId: element.dataset.requestId, response: element.dataset.response });
      toast(element.dataset.response === 'accept' ? 'Party membership accepted' : 'Party membership rejected');
      refreshAttention(getState(), false);
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (action === 'request-party-join') {
    try {
      if (!actorId) throw new Error('Your local player identity is not ready yet.');
      dispatch({ type: 'PARTY_JOIN_REQUESTED', actorId, playerId: actorId, partyId: element.dataset.partyId });
      toast('Join request sent to the party leader');
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (action === 'leave-party-self') {
    try {
      if (!actorId) throw new Error('Your local player identity is not ready yet.');
      dispatch({ type: 'PLAYER_LEFT_PARTY', actorId, playerId: actorId });
      toast('You left the party');
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (action === 'generate-identity') {
    try { const identity = await ensureIdentity(); toast(`Identity ready: ${identity.fingerprint.slice(0,12)}…`); renderCurrentRoute(); } catch(error) { toast(error.message,'error'); }
    return;
  }
  if (action === 'export-identity') {
    try { const blob = await exportIdentityBlob(); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='democracy-player-identity.democracy-id'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Player identity exported'); } catch(error) { toast(error.message,'error'); }
    return;
  }
  if (action === 'import-identity') {
    const input=document.createElement('input'); input.type='file'; input.accept='.democracy-id,.json,application/json'; input.onchange=async()=>{ try { if(!input.files?.[0])return; const result=await importIdentityFile(input.files[0]); toast(`Identity imported: ${result.fingerprint.slice(0,12)}…`); renderCurrentRoute(); } catch(error){ toast(error.message,'error'); } }; input.click();
    return;
  }

  if (action === 'cloud-save-settings') {
    try {
      const saved = setCloudSettings({ enabled: true, apiBase: document.querySelector('#cloudApiBase')?.value || '' });
      const input = document.querySelector('#cloudApiBase');
      if (input) input.value = saved.apiBase;
      const label = document.querySelector('#cloudBackendSavedStatus');
      if (label) label.textContent = 'Saved in this browser ✓';
      toast('Cloud backend URL saved in this browser');
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'cloud-create') {
    try {
      const st = getState();
      const creator = st ? Object.values(st.players ?? {}).find(player => player.roles?.includes('creator')) : null;
      if (!st || !creator) throw new Error('Load a Democracy with a creator player first.');
      const identity = await ensureIdentity();
      if (identity.insecureLanTest) throw new Error('Cloud multiplayer requires HTTPS or localhost cryptographic identity.');
      if (creator.identityFingerprint && creator.identityFingerprint !== identity.fingerprint) throw new Error('This browser identity does not own the creator player in this save. Use the browser profile that created/bound that player.');
      if (!creator.identityFingerprint) {
        localDispatch({ type: 'PLAYER_IDENTITY_BOUND', actorId: creator.id, playerId: creator.id, identityFingerprint: identity.fingerprint, identityPublicKey: identity.publicJwk });
      }
      setCloudSettings({ enabled: true, apiBase: document.querySelector('#cloudApiBase')?.value || getCloudSettings().apiBase });
      const migratedState = prepareCloudMigrationState(getState());
      const created = await createCloudRoom({ roomCode: document.querySelector('#cloudCreateRoom')?.value || '', creatorPlayerId: creator.id, displayName: creator.displayName, initialState: migratedState });
      await connectCloudRoom(created.roomCode);
      toast(`Cloud room ${created.roomCode} created and authenticated`);
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'cloud-connect') {
    try {
      setCloudSettings({ enabled: true, apiBase: document.querySelector('#cloudApiBase')?.value || getCloudSettings().apiBase });
      await connectCloudRoom(document.querySelector('#cloudJoinRoom')?.value || '');
      toast('Cloud room authenticated');
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'cloud-leave') {
    await leaveCloudRoom();
    toast('Disconnected from Cloud multiplayer');
    renderCurrentRoute();
    return;
  }
  if (action === 'copy-cloud-invite') {
    try { await navigator.clipboard.writeText(cloudInviteUrl()); toast('Cloud invite link copied'); }
    catch (error) { toast(error.message || 'Could not copy Cloud invite link', 'error'); }
    return;
  }
  if (action === 'copy-cloud-room') {
    try { const room = getCloudStatus().roomCode; if (!room) throw new Error('No Cloud room is connected.'); await navigator.clipboard.writeText(room); toast('Cloud room code copied'); }
    catch (error) { toast(error.message || 'Could not copy room code', 'error'); }
    return;
  }

  if (action === 'cloud-request-join') {
    try { requestCloudJoin(document.querySelector('#cloudJoinDisplayName')?.value || ''); toast('Cloud join request sent'); renderCurrentRoute(); }
    catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'cloud-approve-join') {
    try { approveCloudJoin(element.dataset.requestId); toast('Signed join approval submitted'); }
    catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'cloud-reject-join') {
    try { rejectCloudJoin(element.dataset.requestId); toast('Signed join rejection submitted'); }
    catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'cloud-resync') {
    try { requestCloudResync(); toast('Verified Cloud state resync requested'); }
    catch (error) { toast(error.message, 'error'); }
    return;
  }


  if (action === 'generate-test-players') {
    if (!state) return;
    const currentActive = Object.values(state.players).filter(p => p.status === 'active').length;
    if (currentActive >= 30) { toast('There are already at least 30 active players.'); return; }
    showModal({ title: 'Generate test players?', body: `<p>This will add ${30-currentActive} synthetic players to the current save. This is intended for offline testing.</p>`, confirmText: 'Generate', onConfirm() {
      try {
        for (let i = currentActive + 1; i <= 30; i++) dispatch({ type: 'PLAYER_ADDED', actorId, name: `Test Player ${String(i).padStart(2,'0')}` });
        toast('Test players generated');
        renderCurrentRoute();
      } catch (error) { toast(error.message, 'error'); return false; }
    }});
    return;
  }

  if (action === 'generate-test-parties') {
    if (!state) return;
    const activeParties = Object.values(state.parties).filter(p => p.status === 'active');
    if (activeParties.length >= 3) { toast('There are already at least three active parties.'); return; }
    const independent = Object.values(state.players).filter(p => p.status === 'active' && !p.partyId);
    const needed = 3 - activeParties.length;
    if (independent.length < needed) { toast('Not enough active independent players to found three parties.', 'error'); return; }
    const presets = [
      ['Civic Party','CIV','#475569'],
      ['Reform Party','REF','#64748b'],
      ['Progress Party','PRO','#334155']
    ];
    try {
      for (let i = 0; i < needed; i++) {
        const fresh = getState();
        const leaders = Object.values(fresh.players).filter(p => p.status === 'active' && !p.partyId);
        const [name, abbreviation, colour] = presets[activeParties.length + i] ?? [`Test Party ${i+1}`,`T${i+1}`,'#475569'];
        dispatch({ type:'PARTY_CREATED', actorId, leaderId:leaders[0].id, name, abbreviation, colour, description:'Automatically generated Phase 12 test party.' });
      }
      toast('Test parties created');
      renderCurrentRoute();
    } catch (error) { toast(error.message,'error'); }
    return;
  }

  if (action === 'distribute-test-players') {
    if (!state) return;
    const parties = Object.values(state.parties).filter(p => p.status === 'active');
    if (!parties.length) { toast('Create at least one active party first.', 'error'); return; }
    const independents = Object.values(state.players).filter(p => p.status === 'active' && !p.partyId);
    try {
      independents.forEach((player, index) => dispatch({ type:'PLAYER_JOINED_PARTY', actorId, playerId:player.id, partyId:parties[index % parties.length].id }));
      toast(`${independents.length} independent player(s) distributed`);
      renderCurrentRoute();
    } catch (error) { toast(error.message,'error'); }
    return;
  }

  if (action === 'rerun-audit') {
    const result = auditState(state);
    toast(result.ok ? `Audit passed${result.warnings ? ` with ${result.warnings} warning(s)` : ''}` : `Audit found ${result.errors} error(s)`, result.ok ? 'normal' : 'error');
    renderCurrentRoute();
    return;
  }

  if (action === 'run-rule-tests') {
    try {
      toast('Running randomized rule tests…');
      lastRuleTestResult = runRulePropertySuite({ iterations: 2000 });
      toast(lastRuleTestResult.ok ? `Rule suite passed: ${lastRuleTestResult.assertions.toLocaleString()} assertions` : `Rule suite found ${lastRuleTestResult.failures.length} failure(s)`, lastRuleTestResult.ok ? 'normal' : 'error');
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (action === 'run-stress-tests') {
    try {
      toast('Running synthetic multiplayer stress test…');
      lastStressResult = runSyntheticStressSuite(getState(), { samples: 600 });
      toast(lastStressResult.ok ? `Stress test complete: ${lastStressResult.stateKiB.toFixed(1)} KiB state` : 'Stress test found state-integrity errors', lastStressResult.ok ? 'normal' : 'error');
      renderCurrentRoute();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (action === 'rename-game') {
    showModal({ title: 'Rename game', body: `<div class="field"><label for="renameGameInput">Game name</label><input id="renameGameInput" maxlength="80" value="${escapeHtml(state.meta.name)}"></div>`, confirmText: 'Rename', onConfirm(root) {
      try { dispatch({ type: 'GAME_RENAMED', actorId, name: root.querySelector('#renameGameInput').value }); toast('Game renamed'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'add-player') {
    showModal({ title: 'Add player', body: `<div class="field"><label for="newPlayerName">Display name</label><input id="newPlayerName" maxlength="50" placeholder="Player name" autofocus></div>`, confirmText: 'Add Player', onConfirm(root) {
      try { dispatch({ type: 'PLAYER_ADDED', actorId, name: root.querySelector('#newPlayerName').value }); toast('Player added'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'rename-player') {
    const playerId = element.dataset.playerId;
    const player = state.players[playerId];
    showModal({ title: 'Rename player', body: `<div class="field"><label for="renamePlayerInput">Display name</label><input id="renamePlayerInput" maxlength="50" value="${escapeHtml(player.displayName)}"></div>`, confirmText: 'Rename', onConfirm(root) {
      try { dispatch({ type: 'PLAYER_RENAMED', actorId, playerId, name: root.querySelector('#renamePlayerInput').value }); toast('Player renamed'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'set-inactive' || action === 'set-active') {
    try { dispatch({ type: 'PLAYER_STATUS_CHANGED', actorId, playerId: element.dataset.playerId, status: action === 'set-active' ? 'active' : 'inactive' }); toast('Player status updated'); }
    catch (error) { toast(error.message, 'error'); }
  }

  if (action === 'resign-player') {
    const player = state.players[element.dataset.playerId];
    showModal({ title: `Resign ${player.displayName}?`, body: '<p>This preserves the player and their history but marks them as resigned. Any current party membership ends.</p>', confirmText: 'Resign Player', danger: true, onConfirm() {
      try { dispatch({ type: 'PLAYER_RESIGNED', actorId, playerId: player.id }); toast('Player resigned'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'view-player') {
    const player = state.players[element.dataset.playerId];
    const party = player.partyId ? state.parties[player.partyId] : null;
    const history = (player.partyHistory ?? []).slice().reverse().map(item => `<li>${escapeHtml(state.parties[item.partyId]?.name ?? item.partyId)} — ${escapeHtml(item.reason)}</li>`).join('');
    showModal({ title: player.displayName, body: `<dl class="kv"><dt>Status</dt><dd>${escapeHtml(playerStatusLabel(player.status))}</dd><dt>Party</dt><dd>${escapeHtml(party?.name ?? 'Independent')}</dd><dt>Joined game</dt><dd>${escapeHtml(formatDateTime(player.joinedAt))}</dd><dt>Last active</dt><dd>${escapeHtml(formatDateTime(player.lastActiveAt))}</dd></dl><h3>Party history</h3>${history ? `<ul>${history}</ul>` : '<p class="muted">No party history yet.</p>'}`, confirmText: 'Close', cancelText: 'Close', onConfirm() {} });
  }

  if (action === 'create-party') {
    const online = isOnlineGame();
    const eligible = Object.values(state.players).filter(p => p.status === 'active' && !p.partyId);
    const self = actorId ? state.players[actorId] : null;
    if (online && (!self || self.status !== 'active' || self.partyId)) { toast('Only your own active independent player can create a party online.', 'error'); return; }
    if (!online && !eligible.length) { toast('No active independent player is available to lead a new party.', 'error'); return; }
    showModal({ title: 'Create political party', body: `
      <div class="form-grid">
        <div class="field"><label for="partyName">Party name</label><input id="partyName" maxlength="80" placeholder="Reform Party"></div>
        <div class="field"><label for="partyAbbr">Abbreviation</label><input id="partyAbbr" maxlength="10" placeholder="RP"></div>
        ${online ? `<div class="notice"><strong>Founding leader:</strong> ${escapeHtml(self.displayName)}<br><span class="muted">Online parties are always created by the connected player identity.</span></div>` : `<div class="field"><label for="partyLeader">Founding leader</label><select id="partyLeader">${eligible.map(p => `<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`}
        <div class="field"><label for="partyColour">Party colour</label><input id="partyColour" type="color" value="#475569"></div>
        <div class="field"><label for="partyDescription">Programme / description</label><textarea id="partyDescription" maxlength="500"></textarea></div>
      </div>`, confirmText: 'Create Party', onConfirm(root) {
        try { const leaderId = online ? actorId : root.querySelector('#partyLeader').value; dispatch({ type: 'PARTY_CREATED', actorId, leaderId, name: root.querySelector('#partyName').value, abbreviation: root.querySelector('#partyAbbr').value, colour: root.querySelector('#partyColour').value, description: root.querySelector('#partyDescription').value }); toast('Party created'); }
        catch (error) { toast(error.message, 'error'); return false; }
      }});
    return;
  }

  if (action === 'edit-party') {
    const party = state.parties[element.dataset.partyId];
    showModal({ title: `Edit ${party.name}`, body: `
      <div class="form-grid">
        <div class="field"><label for="partyName">Party name</label><input id="partyName" maxlength="80" value="${escapeHtml(party.name)}"></div>
        <div class="field"><label for="partyAbbr">Abbreviation</label><input id="partyAbbr" maxlength="10" value="${escapeHtml(party.abbreviation)}"></div>
        <div class="field"><label for="partyColour">Party colour</label><input id="partyColour" type="color" value="${escapeHtml(party.colour)}"></div>
        <div class="field"><label for="partyDescription">Programme / description</label><textarea id="partyDescription" maxlength="500">${escapeHtml(party.description)}</textarea></div>
      </div>`, confirmText: 'Save', onConfirm(root) {
        try { dispatch({ type: 'PARTY_UPDATED', actorId, partyId: party.id, name: root.querySelector('#partyName').value, abbreviation: root.querySelector('#partyAbbr').value, colour: root.querySelector('#partyColour').value, description: root.querySelector('#partyDescription').value }); toast('Party updated'); }
        catch (error) { toast(error.message, 'error'); return false; }
      }});
  }

  if (action === 'manage-party-members') {
    const party = state.parties[element.dataset.partyId];
    const members = party.members.map(id => state.players[id]).filter(Boolean);
    const available = Object.values(state.players).filter(p => p.status === 'active' && !p.partyId && p.id !== party.leaderId && !Object.values(state.partyMembershipRequests ?? {}).some(r => r.status === 'pending' && r.playerId === p.id));
    showModal({ title: `${party.name} members`, body: `
      <h3>Current members</h3>
      <ul class="list">${members.map(p => `<li class="list-row"><span>${escapeHtml(p.displayName)}${party.leaderId === p.id ? ' <span class="pill">Leader</span>' : ''}</span>${party.leaderId !== p.id ? `<button class="btn" data-party-member-remove="${p.id}">Remove</button>` : ''}</li>`).join('') || '<li class="empty">No members.</li>'}</ul>
      <div class="field section"><label for="memberToInvite">Invite independent player</label><select id="memberToInvite"><option value="">Select a player</option>${available.map(p => `<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>
      <button class="btn btn-primary" data-party-invite-member ${available.length ? '' : 'disabled'}>Send Invitation</button>
      <p class="muted">Invitations do not add anyone immediately. The player receives a notification and must accept.</p>`, confirmText: 'Done', cancelText: 'Done', onConfirm() {} });

    const root = document.querySelector('#modalRoot');
    root.querySelectorAll('[data-party-member-remove]').forEach(button => button.addEventListener('click', () => {
      try { dispatch({ type: 'PARTY_MEMBER_REMOVED', actorId, playerId: button.dataset.partyMemberRemove, partyId: party.id }); toast('Player removed from party'); root.innerHTML = ''; renderCurrentRoute(); }
      catch (error) { toast(error.message, 'error'); }
    }));
    root.querySelector('[data-party-invite-member]')?.addEventListener('click', () => {
      const playerId = root.querySelector('#memberToInvite').value;
      if (!playerId) return toast('Select a player first.', 'error');
      try { dispatch({ type: 'PARTY_INVITE_SENT', actorId, playerId, partyId: party.id }); toast('Party invitation sent'); root.innerHTML = ''; refreshAttention(getState(), false); renderCurrentRoute(); }
      catch (error) { toast(error.message, 'error'); }
    });
    return;
  }

  if (action === 'change-party-leader') {
    const party = state.parties[element.dataset.partyId];
    const members = party.members.map(id => state.players[id]).filter(p => p?.status === 'active');
    showModal({ title: `Change ${party.name} leader`, body: `<div class="field"><label for="newPartyLeader">New leader</label><select id="newPartyLeader">${members.map(p => `<option value="${p.id}" ${p.id === party.leaderId ? 'selected' : ''}>${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`, confirmText: 'Change Leader', onConfirm(root) {
      try { dispatch({ type: 'PARTY_LEADER_CHANGED', actorId, partyId: party.id, leaderId: root.querySelector('#newPartyLeader').value }); toast('Party leader changed'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'dissolve-party') {
    const party = state.parties[element.dataset.partyId];
    showModal({ title: `Dissolve ${party.name}?`, body: '<p>The party will remain in official history, but all current members will become independent and the party cannot be edited.</p>', confirmText: 'Dissolve Party', danger: true, onConfirm() {
      try { dispatch({ type: 'PARTY_DISSOLVED', actorId, partyId: party.id }); toast('Party dissolved'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }


  if (action === 'create-vote') {
    showModal({ title: 'Create vote', body: `
      <div class="form-grid">
        <div class="field"><label for="voteTitle">Title</label><input id="voteTitle" maxlength="100" placeholder="Motion or referendum title"></div>
        <div class="field"><label for="voteType">Voting method</label><select id="voteType"><option value="yes-no">Yes / No</option><option value="yes-no-abstain">Yes / No / Abstain</option><option value="single-choice">Single choice</option><option value="ranked-choice">Ranked choice</option><option value="approval">Approval voting</option></select></div>
        <div class="field"><label for="voteOptions">Options / candidates</label><textarea id="voteOptions" placeholder="One option per line. Not required for Yes/No."></textarea></div>
        <div class="field"><label for="voteDuration">Duration (minutes)</label><input id="voteDuration" type="number" min="1" value="1440"></div>
        <label class="check-row"><input id="voteSecret" type="checkbox"> Secret ballot</label>
      </div>`, confirmText: 'Create Draft', onConfirm(root) {
        try {
          const type = root.querySelector('#voteType').value;
          let options = root.querySelector('#voteOptions').value.split('\n').map(x=>x.trim()).filter(Boolean).map((label,index)=>({id:`option-${index+1}`,label}));
          if (type === VOTE_TYPES.YES_NO || type === VOTE_TYPES.YES_NO_ABSTAIN) options = [{id:'yes',label:'Yes'},{id:'no',label:'No'}, ...(type===VOTE_TYPES.YES_NO_ABSTAIN?[{id:'abstain',label:'Abstain'}]:[])];
          dispatch({ type:'VOTE_CREATED', actorId, title:root.querySelector('#voteTitle').value, voteType:type, options, durationMinutes:Number(root.querySelector('#voteDuration').value), secret:root.querySelector('#voteSecret').checked, settings:{} });
          toast('Vote draft created');
        } catch(error) { toast(error.message,'error'); return false; }
      }});
  }


  if (action === 'start-host-removal') {
    if (!state.meta.hostPlayerId) { toast('There is no current Host.', 'error'); return; }
    showModal({ title:'Start Host removal petition?', body:'<p>This begins the constitutional Host removal process. A petition requires 20% of active players before the public removal vote can open.</p>', confirmText:'Start Petition', danger:true, onConfirm(){ try { dispatch({type:'HOST_REMOVAL_PROPOSED',actorId}); toast('Host removal petition started'); } catch(error){ toast(error.message,'error'); return false; } }});
    return;
  }

  if (action === 'sign-host-removal') {
    const removal=state.hostRemoval;
    const eligible=Object.values(state.players).filter(p=>p.status==='active' && !(removal?.signatures??[]).includes(p.id));
    if (!eligible.length) { toast('No eligible unsigned players remain.'); return; }
    showModal({ title:'Sign Host removal petition', body:`<div class="field"><label>Player</label><select id="hostRemovalSigner">${eligible.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`, confirmText:'Sign', onConfirm(root){ try { dispatch({type:'HOST_REMOVAL_SIGNED',actorId,playerId:root.querySelector('#hostRemovalSigner').value}); toast('Petition signed'); } catch(error){ toast(error.message,'error'); return false; } }});
    return;
  }

  if (action === 'create-election') {
    const activePlayers = Object.values(state.players).filter(p=>p.status==='active');
    const activeParties = Object.values(state.parties).filter(p=>p.status==='active');
    showModal({ title: 'Create election', body: `
      <div class="form-grid">
        <div class="field"><label for="electionKind">Election</label><select id="electionKind"><option value="general">General Election</option><option value="host">Host Election</option><option value="deputy-host">Deputy Host Election</option><option value="committee">Committee Election</option></select></div>
        <div class="field"><label for="committeeType">Committee (committee election only)</label><select id="committeeType"><option value="AC">Actions Committee (AC)</option><option value="PC">Punishment Committee (PC)</option><option value="PAC">People's Actions Committee (PAC)</option><option value="PPC">People's Punishment Committee (PPC)</option></select></div>
        <div class="field"><label for="electionCandidates">Candidate player IDs (Host/Deputy/Committee)</label><div class="candidate-picker">${activePlayers.map(p=>`<label class="check-row"><input type="checkbox" name="candidate" value="${p.id}"> ${escapeHtml(p.displayName)}</label>`).join('')}</div></div>
        <div class="field"><label>General election lists</label><p class="muted">${activeParties.length ? activeParties.map(p=>escapeHtml(p.name)).join(', ') : 'Create at least one active party first.'}</p></div>
        <div class="field"><label for="electionDuration">Duration (minutes)</label><input id="electionDuration" type="number" min="1" value="2880"></div>
      </div>`, confirmText: 'Create Election Draft', onConfirm(root) {
        try {
          const kind = root.querySelector('#electionKind').value;
          const committee = kind === ELECTION_KINDS.COMMITTEE ? root.querySelector('#committeeType').value : null;
          const defaults = electionDefaults(kind, activePlayers.length, committee);
          let options;
          let settings = {...defaults.settings};
          if (kind === ELECTION_KINDS.GENERAL) {
            if (!activeParties.length) throw new Error('A general election requires at least one active political party.');
            options = activeParties.map(p=>({id:p.id,label:p.name,entityId:p.id}));
            settings.candidateLists = Object.fromEntries(activeParties.map(p=>[p.id,[...p.members]]));
          } else {
            const ids = [...root.querySelectorAll('input[name="candidate"]:checked')].map(input=>input.value);
            if (ids.length < 2) throw new Error('Select at least two candidates.');
            if (kind === ELECTION_KINDS.COMMITTEE && ids.length < defaults.settings.seatCount) throw new Error(`Select at least ${defaults.settings.seatCount} candidates to fill the committee seats.`);
            options = ids.map(id=>({id,label:state.players[id].displayName,entityId:id}));
          }
          dispatch({ type:'VOTE_CREATED', actorId, title:defaults.title, voteType:defaults.type, electionKind:kind, committee, options, durationMinutes:Number(root.querySelector('#electionDuration').value), secret:true, settings });
          toast('Election draft created');
        } catch(error) { toast(error.message,'error'); return false; }
      }});
  }

  if (action === 'open-vote') {
    try {
      const vote = state.votes[element.dataset.voteId];
      let secretBoxPublicKey = null;
      if (vote?.secret && hasSecureCrypto()) {
        const box = await createBallotBox(vote.id);
        secretBoxPublicKey = box.publicJwk;
      }
      dispatch({type:'VOTE_OPENED', actorId, voteId:element.dataset.voteId, ...(secretBoxPublicKey ? {secretBoxPublicKey} : {})});
      toast(vote?.secret && !secretBoxPublicKey ? 'Voting opened (LAN Test Mode: sealed encryption unavailable)' : 'Voting opened');
    } catch(error) { toast(error.message,'error'); }
  }

  if (action === 'pause-vote') {
    try { dispatch({type:'VOTE_PAUSED', actorId, voteId:element.dataset.voteId}); toast('Voting paused'); }
    catch(error) { toast(error.message,'error'); }
  }

  if (action === 'resume-vote') {
    try { dispatch({type:'VOTE_RESUMED', actorId, voteId:element.dataset.voteId}); toast('Voting resumed'); }
    catch(error) { toast(error.message,'error'); }
  }

  if (action === 'close-vote') {
    try {
      const vote = state.votes[element.dataset.voteId];
      if (vote?.secretBallotMode === 'sealed-v1' && !Array.isArray(vote.revealedChoices)) {
        const reveal = await revealBallotBox(vote);
        const revealedChoices = [...reveal.choices];
        for (let i = revealedChoices.length - 1; i > 0; i -= 1) {
          const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
          [revealedChoices[i], revealedChoices[j]] = [revealedChoices[j], revealedChoices[i]];
        }
        dispatch({type:'VOTE_CLOSED', actorId, voteId:vote.id, revealedChoices});
      } else {
        dispatch({type:'VOTE_CLOSED', actorId, voteId:element.dataset.voteId});
      }
      toast('Vote closed and counted');
    } catch(error) { toast(error.message,'error'); }
  }

  if (action === 'verify-secret-vote') {
    try {
      const vote = state.votes[element.dataset.voteId];
      const audit = await verifyRevealedSecretVote(vote);
      if (!audit.ok) throw new Error(`Sealed-ballot verification failed: ${audit.reason ?? 'unknown error'}`);
      toast(`Verified ${audit.count} sealed ballot${audit.count === 1 ? '' : 's'} against the locally held ballot-box key`);
    } catch(error) { toast(error.message,'error'); }
    return;
  }

  if (action === 'certify-vote') {
    try { dispatch({type:'VOTE_CERTIFIED', actorId, voteId:element.dataset.voteId}); toast('Result certified'); }
    catch(error) { toast(error.message,'error'); }
  }

  if (action === 'resign-mp-seat') {
    const player = state.players[element.dataset.playerId];
    showModal({ title: `Vacate ${player?.displayName ?? 'MP'}'s seat?`, body: '<p>The next eligible candidate from the same election list will automatically take the seat where available.</p>', confirmText: 'Vacate Seat', danger: true, onConfirm() {
      try { dispatch({type:'MP_RESIGNED_SEAT', actorId, playerId:element.dataset.playerId}); toast('Legislative seat updated'); }
      catch(error) { toast(error.message,'error'); return false; }
    }});
  }

  if (action === 'create-legislative-vote') {
    showModal({ title:'New Parliamentary Vote', body:`<div class="form-grid"><div class="field"><label for="legVoteTitle">Motion title</label><input id="legVoteTitle" maxlength="120" placeholder="Motion of confidence / parliamentary motion"></div><div class="field"><label for="legVoteDuration">Duration (minutes)</label><input id="legVoteDuration" type="number" min="1" value="1440"></div><p class="muted">The electorate will be the sitting MPs when the vote opens. Passage requires more than half of all filled seats to vote Yes.</p></div>`, confirmText:'Create Draft', onConfirm(root){
      try { dispatch({type:'LEGISLATIVE_VOTE_CREATED', actorId, title:root.querySelector('#legVoteTitle').value, durationMinutes:Number(root.querySelector('#legVoteDuration').value)}); toast('Parliamentary vote draft created'); }
      catch(error){ toast(error.message,'error'); return false; }
    }});
  }

  if (action === 'form-government') {
    const counts = partySeatCounts(state);
    const parties = Object.keys(counts).map(id=>state.parties[id]).filter(Boolean);
    if (!parties.length) return toast('No political parties hold filled seats.', 'error');
    const possiblePMs = Object.values(state.players).filter(p=>p.status==='active');
    showModal({ title: state.government.primeMinisterId ? 'Form replacement government' : 'Form government', body:`<div class="form-grid"><div class="field"><label>Governing parties</label><div class="candidate-picker">${parties.map(p=>`<label class="check-row"><input type="checkbox" name="govParty" value="${p.id}" ${state.government.coalitionPartyIds?.includes(p.id)?'checked':''}> <span class="colour-dot" style="--party-colour:${escapeHtml(p.colour)}"></span>${escapeHtml(p.name)} (${counts[p.id]} seats)</label>`).join('')}</div></div><div class="field"><label for="govPM">Prime Minister</label><select id="govPM">${possiblePMs.map(p=>`<option value="${p.id}" ${p.id===state.government.primeMinisterId?'selected':''}>${escapeHtml(p.displayName)} — ${escapeHtml(state.parties[p.partyId]?.name ?? 'Independent')}</option>`).join('')}</select></div><p class="muted">The selected parties must control a majority of all filled legislative seats.</p></div>`, confirmText:'Form Government', onConfirm(root){
      try { const partyIds=[...root.querySelectorAll('input[name="govParty"]:checked')].map(x=>x.value); dispatch({type:'GOVERNMENT_FORMED', actorId, partyIds, primeMinisterId:root.querySelector('#govPM').value}); toast('Government formed'); }
      catch(error){ toast(error.message,'error'); return false; }
    }});
  }

  if (action === 'create-confidence-vote') {
    try { dispatch({type:'LEGISLATIVE_VOTE_CREATED', actorId, title:'Vote of Confidence', durationMinutes:1440, motionKind:'confidence'}); toast('Confidence vote draft created'); navigate('parliament'); }
    catch(error){ toast(error.message,'error'); }
  }

  if (action === 'create-no-confidence-vote') {
    const counts = partySeatCounts(state);
    const parties = Object.keys(counts).map(id=>state.parties[id]).filter(Boolean);
    const possiblePMs = Object.values(state.players).filter(p=>p.status==='active');
    showModal({ title:'Constructive No-Confidence Motion', body:`<div class="form-grid"><div class="field"><label>Replacement coalition</label><div class="candidate-picker">${parties.map(p=>`<label class="check-row"><input type="checkbox" name="replacementParty" value="${p.id}"> <span class="colour-dot" style="--party-colour:${escapeHtml(p.colour)}"></span>${escapeHtml(p.name)} (${counts[p.id]} seats)</label>`).join('')}</div></div><div class="field"><label for="replacementPM">Proposed replacement Prime Minister</label><select id="replacementPM">${possiblePMs.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)} — ${escapeHtml(state.parties[p.partyId]?.name ?? 'Independent')}</option>`).join('')}</select></div><p class="muted">If the motion passes with a legislative majority, the proposed coalition immediately replaces the current government.</p></div>`, confirmText:'Create Motion', onConfirm(root){
      try { const partyIds=[...root.querySelectorAll('input[name="replacementParty"]:checked')].map(x=>x.value); if(!partyIds.length) throw new Error('Select at least one replacement party.'); dispatch({type:'LEGISLATIVE_VOTE_CREATED', actorId, title:'Constructive Vote of No Confidence', durationMinutes:1440, motionKind:'constructive-no-confidence', replacementPartyIds:partyIds, replacementPrimeMinisterId:root.querySelector('#replacementPM').value}); toast('No-confidence motion draft created'); navigate('parliament'); }
      catch(error){ toast(error.message,'error'); return false; }
    }});
  }

  if (action === 'check-caretaker-deadline') {
    try { dispatch({type:'CHECK_GOVERNMENT_FORMATION_DEADLINE', actorId}); toast('Deadline checked'); }
    catch(error){ toast(error.message,'error'); }
  }

  if (action === 'appoint-minister') {
    const eligible = Object.values(state.players).filter(p=>p.status==='active' && !state.government.ministers.some(m=>m.playerId===p.id));
    showModal({ title:'Appoint Minister', body:`<div class="form-grid"><div class="field"><label for="ministerPlayer">Player</label><select id="ministerPlayer">${eligible.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div><div class="field"><label for="ministerPortfolio">Portfolio</label><input id="ministerPortfolio" maxlength="60" placeholder="Finance"></div></div>`, confirmText:'Appoint', onConfirm(root){
      try { dispatch({type:'MINISTER_APPOINTED', actorId, playerId:root.querySelector('#ministerPlayer').value, portfolio:root.querySelector('#ministerPortfolio').value}); toast('Minister appointed'); }
      catch(error){toast(error.message,'error'); return false;}
    }});
  }

  if (action === 'dismiss-minister') {
    try { dispatch({type:'MINISTER_DISMISSED', actorId, playerId:element.dataset.playerId}); toast('Minister dismissed'); }
    catch(error){ toast(error.message,'error'); }
  }

  if (action === 'set-caretaker') {
    try { dispatch({type:'GOVERNMENT_SET_CARETAKER', actorId, reason:'manual'}); toast('Government is now caretaker'); }
    catch(error){ toast(error.message,'error'); }
  }


  if (action === 'create-law-proposal' || action === 'create-citizen-initiative') {
    const pathway = action === 'create-citizen-initiative' ? 'citizen-initiative' : 'legislative';
    showModal({ title: pathway === 'citizen-initiative' ? "Create Citizens' Initiative" : 'Propose Law', body:`<div class="form-grid"><div class="field"><label for="lawTitle">Title</label><input id="lawTitle" maxlength="120" placeholder="Public Parks Act"></div>${pathway==='legislative'?`<div class="field"><label for="lawSponsorRoute">Proposal route</label><select id="lawSponsorRoute"><option value="petition">10% public sponsorship petition</option><option value="government">Running Government</option><option value="represented-party">Electoral List with a Parliament seat</option></select></div>`:''}<div class="field"><label for="lawText">Complete proposed wording</label><textarea id="lawText" rows="8"></textarea></div><div class="field"><label for="lawReason">Reason</label><textarea id="lawReason" rows="4"></textarea></div><p class="muted">A 24-hour discussion period begins immediately. The wording may be edited until it is frozen.</p></div>`, confirmText:'Publish Proposal', onConfirm(root){
      try { dispatch({type:'LAW_PROPOSED', actorId, title:root.querySelector('#lawTitle').value, text:root.querySelector('#lawText').value, reason:root.querySelector('#lawReason').value, pathway, sponsorRoute:pathway==='legislative'?root.querySelector('#lawSponsorRoute').value:'citizen-initiative'}); toast('Law proposal published'); }
      catch(error){toast(error.message,'error'); return false;}
    }});
  }

  if (action === 'edit-law-proposal') {
    const p=state.lawProposals[element.dataset.proposalId];
    showModal({title:`Edit ${p.id}`,body:`<div class="form-grid"><div class="field"><label>Title</label><input id="editLawTitle" value="${escapeHtml(p.title)}"></div><div class="field"><label>Wording</label><textarea id="editLawText" rows="8">${escapeHtml(p.text)}</textarea></div><div class="field"><label>Reason</label><textarea id="editLawReason" rows="4">${escapeHtml(p.reason)}</textarea></div></div>`,confirmText:'Save',onConfirm(root){try{dispatch({type:'LAW_PROPOSAL_UPDATED',actorId,proposalId:p.id,title:root.querySelector('#editLawTitle').value,text:root.querySelector('#editLawText').value,reason:root.querySelector('#editLawReason').value});toast('Proposal updated');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'finalize-law-proposal') {
    try { dispatch({type:'LAW_PROPOSAL_FINALIZED',actorId,proposalId:element.dataset.proposalId}); toast('Proposal frozen'); }
    catch(error){toast(error.message,'error');}
  }


  if (action === 'sign-law-proposal') {
    const active=Object.values(state.players).filter(p=>p.status==='active');
    showModal({title:'Sign Law Proposal Petition',body:`<div class="field"><label>Player</label><select id="lawProposalSigner">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`,confirmText:'Sign',onConfirm(root){try{dispatch({type:'LAW_PROPOSAL_PETITION_SIGNED',actorId,proposalId:element.dataset.proposalId,playerId:root.querySelector('#lawProposalSigner').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'sign-law-referendum' || action === 'sign-initiative') {
    const proposalId=element.dataset.proposalId;
    const active=Object.values(state.players).filter(p=>p.status==='active');
    showModal({title:'Add Signature',body:`<div class="field"><label for="signaturePlayer">Player</label><select id="signaturePlayer">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`,confirmText:'Sign',onConfirm(root){try{dispatch({type:action==='sign-law-referendum'?'LAW_REFERENDUM_PETITION_SIGNED':'CITIZEN_INITIATIVE_SIGNED',actorId,proposalId,playerId:root.querySelector('#signaturePlayer').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'refer-law') {
    try { dispatch({type:'LAW_REFERRED_TO_REFERENDUM',actorId,proposalId:element.dataset.proposalId}); toast('Public referendum created'); }
    catch(error){toast(error.message,'error');}
  }

  if (action === 'check-law-window') {
    try { dispatch({type:'CHECK_LAW_REFERENDUM_WINDOW',actorId,proposalId:element.dataset.proposalId}); toast('Law brought into force'); }
    catch(error){toast(error.message,'error');}
  }

  if (action === 'amend-law' || action === 'repeal-law') {
    const law=state.laws[element.dataset.lawId];
    const repeal=action==='repeal-law';
    showModal({title:`${repeal?'Repeal':'Amend'} ${law.id}`,body:`<div class="form-grid"><div class="field"><label>Title</label><input id="changeLawTitle" value="${escapeHtml(law.title)}" ${repeal?'readonly':''}></div><div class="field"><label>${repeal?'Repeal wording / statement':'Replacement wording'}</label><textarea id="changeLawText" rows="8">${escapeHtml(repeal?`Repeal ${law.id} — ${law.title}.`:law.text)}</textarea></div><div class="field"><label>Reason</label><textarea id="changeLawReason" rows="4"></textarea></div><div class="field"><label>Proposal route</label><select id="changeLawSponsorRoute"><option value="petition">10% public sponsorship petition</option><option value="government">Running Government</option><option value="represented-party">Electoral List with a Parliament seat</option></select></div></div>`,confirmText:'Publish Proposal',onConfirm(root){try{dispatch({type:'LAW_PROPOSED',actorId,title:root.querySelector('#changeLawTitle').value,text:root.querySelector('#changeLawText').value,reason:root.querySelector('#changeLawReason').value,changeKind:repeal?'repeal':'amend',targetLawId:law.id,pathway:'legislative',sponsorRoute:root.querySelector('#changeLawSponsorRoute').value});toast('Proposal published');}catch(error){toast(error.message,'error');return false;}}});
  }


  if (action === 'create-base-unlock') {
    showModal({title:'Propose Base Rule Unlock',body:`<div class="form-grid"><div class="field"><label>Base section number</label><input id="unlockSection" placeholder="4"></div><div class="field"><label>Section title</label><input id="unlockTitle"></div><div class="field"><label>Initiation route</label><select id="unlockRoute"><option value="host">Host proposal</option><option value="petition">25% public petition</option></select></div><div class="field"><label>Reason</label><textarea id="unlockReason" rows="4"></textarea></div><p class="muted">After initiation, the Actions Committee must approve by at least two-thirds of its full non-recused membership through a real committee vote. A public vote then requires 75% approval and 50% turnout.</p></div>`,confirmText:'Create Unlock Proposal',onConfirm(root){try{dispatch({type:'CONSTITUTION_BASE_UNLOCK_PROPOSED',actorId,section:root.querySelector('#unlockSection').value,sectionTitle:root.querySelector('#unlockTitle').value,initiatedBy:root.querySelector('#unlockRoute').value,reason:root.querySelector('#unlockReason').value});toast('Base-rule unlock proposed');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'sign-base-unlock') {
    const active=Object.values(state.players).filter(p=>p.status==='active');
    showModal({title:'Sign Base Rule Petition',body:`<div class="field"><label>Player</label><select id="unlockSigner">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`,confirmText:'Sign',onConfirm(root){try{dispatch({type:'CONSTITUTION_BASE_UNLOCK_SIGNED',actorId,proposalId:element.dataset.proposalId,playerId:root.querySelector('#unlockSigner').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'create-amendment') {
    showModal({title:'Propose Constitutional Amendment',body:`<div class="form-grid"><div class="field"><label>Section number</label><input id="amdSection" placeholder="20"></div><div class="field"><label>Section title</label><input id="amdTitle" placeholder="Legislative Term"></div><div class="field"><label>Proposal route</label><select id="amdSponsorRoute"><option value="petition">10% public petition</option><option value="government">Running Government</option><option value="represented-party">Electoral List with a Parliament seat</option></select></div><div class="field"><label>Category</label><select id="amdCategory"><option value="EDITABLE">EDITABLE</option><option value="BASE">BASE (cannot be directly amended)</option></select></div><div class="field"><label>Current wording</label><textarea id="amdCurrent" rows="6"></textarea></div><div class="field"><label>Proposed wording</label><textarea id="amdProposed" rows="6"></textarea></div><div class="field"><label>Reason</label><textarea id="amdReason" rows="4"></textarea></div><p class="muted">Normal amendments require 48 hours of discussion, 66% approval and 25% turnout. Base provisions must first be made editable through their separate protected procedure.</p></div>`,confirmText:'Publish Amendment',onConfirm(root){try{dispatch({type:'CONSTITUTION_AMENDMENT_PROPOSED',actorId,section:root.querySelector('#amdSection').value,sectionTitle:root.querySelector('#amdTitle').value,category:root.querySelector('#amdCategory').value,currentText:root.querySelector('#amdCurrent').value,proposedText:root.querySelector('#amdProposed').value,reason:root.querySelector('#amdReason').value,sponsorRoute:root.querySelector('#amdSponsorRoute').value});toast('Amendment published');}catch(error){toast(error.message,'error');return false;}}});
  }


  if (action === 'sign-amendment-petition') {
    const active=Object.values(state.players).filter(p=>p.status==='active');
    showModal({title:'Sign Amendment Petition',body:`<div class="field"><label>Player</label><select id="amdSigner">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`,confirmText:'Sign',onConfirm(root){try{dispatch({type:'CONSTITUTION_AMENDMENT_PETITION_SIGNED',actorId,proposalId:element.dataset.proposalId,playerId:root.querySelector('#amdSigner').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'edit-amendment') {
    const p=state.constitution.proposals[element.dataset.proposalId];
    showModal({title:`Edit ${p.id}`,body:`<div class="form-grid"><div class="field"><label>Proposed wording</label><textarea id="editAmdText" rows="8">${escapeHtml(p.proposedText)}</textarea></div><div class="field"><label>Reason</label><textarea id="editAmdReason" rows="4">${escapeHtml(p.reason)}</textarea></div></div>`,confirmText:'Save',onConfirm(root){try{dispatch({type:'CONSTITUTION_AMENDMENT_UPDATED',actorId,proposalId:p.id,proposedText:root.querySelector('#editAmdText').value,reason:root.querySelector('#editAmdReason').value});toast('Amendment updated');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'finalize-amendment') {
    try { dispatch({type:'CONSTITUTION_AMENDMENT_FINALIZED',actorId,proposalId:element.dataset.proposalId}); toast('Amendment frozen and vote created'); }
    catch(error){toast(error.message,'error');}
  }

  if (action === 'cast-ballot') {
    const vote = state.votes[element.dataset.voteId];
    const eligible = (vote.electorateSnapshot ?? []).map(id=>state.players[id]).filter(Boolean);
    if (!eligible.length) return toast('No eligible voters in this electorate.', 'error');
    let ballotFields = '';
    if ([VOTE_TYPES.YES_NO,VOTE_TYPES.YES_NO_ABSTAIN,VOTE_TYPES.SINGLE,VOTE_TYPES.PROPORTIONAL].includes(vote.type)) {
      ballotFields = `<div class="field"><label for="ballotChoice">Choice</label><select id="ballotChoice">${vote.options.map(o=>`<option value="${o.id}">${escapeHtml(o.label)}</option>`).join('')}</select></div>`;
    } else if (vote.type === VOTE_TYPES.APPROVAL) {
      ballotFields = `<div class="field"><label>Approve up to ${vote.settings?.approvalLimit ?? vote.options.length}</label><div class="candidate-picker">${vote.options.map(o=>`<label class="check-row"><input type="checkbox" name="approvalChoice" value="${o.id}"> ${escapeHtml(o.label)}</label>`).join('')}</div></div>`;
    } else if (vote.type === VOTE_TYPES.RANKED) {
      ballotFields = `<div class="field"><label>Rank candidates (1 = first preference; leave blank to omit)</label>${vote.options.map((o,index)=>`<div class="rank-row"><span>${escapeHtml(o.label)}</span><select data-rank-option="${o.id}"><option value="">—</option>${vote.options.map((_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></div>`).join('')}</div>`;
    }
    const onlineBallot = isOnlineGame();
    const ballotActor = localActorId(state);
    const voterControl = onlineBallot
      ? `<div class="field"><label>Voter</label><input id="ballotVoter" type="hidden" value="${escapeHtml(ballotActor || '')}"><div class="readonly-value">${escapeHtml(state.players?.[ballotActor]?.displayName || 'Local identity not ready')}</div></div>`
      : `<div class="field"><label for="ballotVoter">Voter</label><select id="ballotVoter">${eligible.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}${(vote.secretBallotMode === 'sealed-v1' ? vote.submittedVoters?.[p.id] : vote.ballots[p.id]) ? ' — ballot already submitted' : ''}</option>`).join('')}</select></div>`;
    if (onlineBallot && (!ballotActor || !vote.electorateSnapshot?.includes(ballotActor))) return toast('Your local player is not eligible to vote in this ballot.', 'error');
    showModal({ title: vote.title, body:`<div class="form-grid">${voterControl}${ballotFields}<p class="muted">${vote.secretBallotMode === 'sealed-v1' ? 'This is a sealed secret ballot. Your choice is encrypted in this browser before submission and cannot be changed after it is submitted.' : vote.secret ? 'This is a secret ballot. Individual choices are hidden from normal result displays.' : 'This is a public ballot.'}</p></div>`, confirmText:'Submit Ballot', async onConfirm(root){
      try {
        let choice;
        if ([VOTE_TYPES.YES_NO,VOTE_TYPES.YES_NO_ABSTAIN,VOTE_TYPES.SINGLE,VOTE_TYPES.PROPORTIONAL].includes(vote.type)) choice=root.querySelector('#ballotChoice').value;
        else if (vote.type===VOTE_TYPES.APPROVAL) choice=[...root.querySelectorAll('input[name="approvalChoice"]:checked')].map(x=>x.value);
        else if (vote.type===VOTE_TYPES.RANKED) {
          const ranked=[...root.querySelectorAll('[data-rank-option]')].map(sel=>({id:sel.dataset.rankOption,rank:Number(sel.value)})).filter(x=>x.rank>0);
          const ranks=ranked.map(x=>x.rank);
          if(new Set(ranks).size!==ranks.length) throw new Error('Each ranking number can only be used once.');
          choice=ranked.sort((a,b)=>a.rank-b.rank).map(x=>x.id);
        }
        const voterId = root.querySelector('#ballotVoter').value;
        if (vote.secretBallotMode === 'sealed-v1') {
          const encryptedBallot = await encryptSecretChoice(vote.secretBoxPublicKey, choice);
          dispatch({type:'BALLOT_CAST', voteId:vote.id, voterId, encryptedBallot});
          toast('Encrypted ballot sealed and submitted');
        } else {
          dispatch({type:'BALLOT_CAST', voteId:vote.id, voterId, choice});
          toast('Ballot submitted');
        }
      } catch(error){toast(error.message,'error'); return false;}
    }});
  }

  if (action === 'set-committee-chair') {
    const c=state.committees[element.dataset.committee];
    if(!c?.members?.length){toast('Committee has no seated members.','error');return;}
    showModal({title:`Set ${c.code} Chair`,body:`<div class="field"><label>Chair</label><select id="committeeChair">${c.members.map(id=>`<option value="${id}">${escapeHtml(state.players[id]?.displayName??id)}</option>`).join('')}</select></div>`,confirmText:'Set Chair',onConfirm(root){try{dispatch({type:'COMMITTEE_CHAIR_SET',actorId,committee:c.code,playerId:root.querySelector('#committeeChair').value});toast('Chair updated');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'create-committee-matter') {
    const code=element.dataset.committee;
    showModal({title:`New ${code} Matter`,body:`<div class="field"><label>Title</label><input id="matterTitle"></div><div class="field"><label>Description</label><textarea id="matterDescription" rows="5"></textarea></div>`,confirmText:'Create Matter',onConfirm(root){try{dispatch({type:'COMMITTEE_MATTER_CREATED',actorId,committee:code,title:root.querySelector('#matterTitle').value,description:root.querySelector('#matterDescription').value});toast('Matter created');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'recuse-committee-member') {
    const code=element.dataset.committee; const c=state.committees[code];
    showModal({title:'Recuse Committee Member',body:`<div class="field"><label>Member</label><select id="recuseMember">${c.members.map(id=>`<option value="${id}">${escapeHtml(state.players[id]?.displayName??id)}</option>`).join('')}</select></div>`,confirmText:'Recuse',onConfirm(root){try{dispatch({type:'COMMITTEE_MEMBER_RECUSED',actorId,committee:code,matterId:element.dataset.matterId,playerId:root.querySelector('#recuseMember').value});toast('Recusal recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'create-committee-vote') {
    try{dispatch({type:'COMMITTEE_VOTE_CREATED',actorId,committee:element.dataset.committee,matterId:element.dataset.matterId});toast('Committee vote created');navigate('votes');}catch(error){toast(error.message,'error');}
  }

  if (action === 'create-base-unlock-ac-vote') {
    try{dispatch({type:'CONSTITUTION_BASE_UNLOCK_AC_VOTE_CREATED',actorId,proposalId:element.dataset.proposalId});toast('AC approval vote created');navigate('votes');}catch(error){toast(error.message,'error');}
  }

  if (action === 'open-case') {
    const active=Object.values(state.players).filter(p=>p.status==='active'); const laws=Object.values(state.laws).filter(l=>l.status==='in-force');
    if(active.length<2||!laws.length){toast('At least two active players and one law in force are required.','error');return;}
    showModal({title:'Open Law Case',body:`<div class="form-grid"><div class="field"><label>Accused</label><select id="caseAccused">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div><div class="field"><label>Complainant</label><select id="caseComplainant">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div><div class="field"><label>Law</label><select id="caseLaw">${laws.map(l=>`<option value="${l.id}">${escapeHtml(l.id)} — ${escapeHtml(l.title)}</option>`).join('')}</select></div><div class="field"><label>Alleged conduct</label><textarea id="caseConduct" rows="4"></textarea></div><div class="field"><label>Evidence</label><textarea id="caseEvidence" rows="5"></textarea></div></div>`,confirmText:'Open Case',onConfirm(root){try{dispatch({type:'CASE_OPENED',actorId,accusedId:root.querySelector('#caseAccused').value,complainantId:root.querySelector('#caseComplainant').value,lawId:root.querySelector('#caseLaw').value,conduct:root.querySelector('#caseConduct').value,evidence:root.querySelector('#caseEvidence').value});toast('Case opened');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'case-response') {
    showModal({title:'Record Accused Response',body:'<div class="field"><label>Response</label><textarea id="caseResponse" rows="6"></textarea></div>',confirmText:'Record Response',onConfirm(root){try{dispatch({type:'CASE_RESPONSE_SUBMITTED',actorId,caseId:element.dataset.caseId,response:root.querySelector('#caseResponse').value});toast('Response recorded');}catch(error){toast(error.message,'error');return false;}}});
  }
  if (action === 'assign-pac-panel') {try{dispatch({type:'CASE_PAC_PANEL_ASSIGNED',actorId,caseId:element.dataset.caseId});toast('PAC panel assigned');}catch(error){toast(error.message,'error');}}
  if (action === 'create-pac-vote') {try{dispatch({type:'CASE_PAC_VOTE_CREATED',actorId,caseId:element.dataset.caseId});toast('PAC vote created');navigate('votes');}catch(error){toast(error.message,'error');}}
  if (action === 'select-jury') {try{dispatch({type:'CASE_JURY_SELECTED',actorId,caseId:element.dataset.caseId});toast('Jury selected');}catch(error){toast(error.message,'error');}}
  if (action === 'create-jury-vote') {try{dispatch({type:'CASE_JURY_VOTE_CREATED',actorId,caseId:element.dataset.caseId});toast('Jury vote created');navigate('votes');}catch(error){toast(error.message,'error');}}
  if (action === 'record-ppc-punishment') {showModal({title:'Record PPC Punishment',body:'<div class="field"><label>Punishment authorised by law</label><textarea id="ppcPunishment" rows="5"></textarea></div>',confirmText:'Record Punishment',onConfirm(root){try{dispatch({type:'CASE_PPC_PUNISHMENT_RECORDED',actorId,caseId:element.dataset.caseId,punishment:root.querySelector('#ppcPunishment').value});toast('Punishment recorded');}catch(error){toast(error.message,'error');return false;}}});}

  if (action === 'reload-rulebook') {
    loadRulebook();
  }

  if (action === 'refresh-saves') {
    await refreshSavedGames(true);
    toast('Save list refreshed');
  }

  if (action === 'import-save') document.querySelector('#importGameInput')?.click();

  if (action === 'load-save') {
    try { const loaded = await loadGame(element.dataset.gameId); loadState(loaded); toast('Game loaded'); navigate('dashboard'); }
    catch (error) { toast(error.message, 'error'); }
  }

  if (action === 'delete-save') {
    const game = savedGames.find(g => g.id === element.dataset.gameId);
    showModal({ title: `Delete ${game?.name ?? 'save'}?`, body: '<p>This removes the browser copy. Export it first if you may want it later.</p>', confirmText: 'Delete Save', danger: true, onConfirm() {
      deleteSavedGame(element.dataset.gameId).then(() => refreshSavedGames(true)).then(() => toast('Save deleted')).catch(error => toast(error.message, 'error'));
    }});
  }

  if (action === 'export-current' && state) {
    downloadState(state);
    toast('Save exported');
  }

  if (action === 'export-save') {
    try { const loaded = await loadGame(element.dataset.gameId, { setCurrent: false }); downloadState(loaded); toast('Save exported'); }
    catch (error) { toast(error.message, 'error'); }
  }
});

window.addEventListener('error', event => {
  runtimeErrors.push({ at: new Date().toISOString(), type: 'error', message: event.message || 'Unknown runtime error' });
  if (runtimeErrors.length > 20) runtimeErrors.shift();
});
window.addEventListener('unhandledrejection', event => {
  runtimeErrors.push({ at: new Date().toISOString(), type: 'unhandledrejection', message: event.reason?.message || String(event.reason || 'Unhandled promise rejection') });
  if (runtimeErrors.length > 20) runtimeErrors.shift();
});

async function boot() {
  const sec=securitySummary();
  const banner=document.querySelector('#securityBanner');
  if (sec.mode !== 'secure' && banner) { banner.hidden=false; banner.dataset.mode=sec.mode; banner.textContent=sec.mode==='lan-test' ? 'LAN TEST MODE — connection is not HTTPS. Development-only identity proofs are active; sealed secret ballots are disabled.' : 'SECURE CONTEXT REQUIRED — use HTTPS or localhost for cryptographic multiplayer features.'; }
  if ('serviceWorker' in navigator && globalThis.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Service worker registration failed',error));
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt=e; if(location.hash==='#about') renderCurrentRoute(); });
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;toast('Democracy Web installed');});
  window.addEventListener('online',()=>{document.querySelector('#connectionAnnouncer').textContent='Internet connection restored';toast('Connection restored')});
  window.addEventListener('offline',()=>{document.querySelector('#connectionAnnouncer').textContent='Internet connection lost';toast('You are offline; local features remain available.','error')});
  try {
    await refreshSavedGames(false);
    const restored = await loadCurrentGame();
    if (restored) {
      loadState(restored);
      setSaveStatus('Saved ✓', 'saved');
    }
  } catch (error) {
    console.error(error);
    toast('Local storage could not be restored.', 'error');
  }
  refreshAttention(getState(), false);
  setInterval(()=>{ const st=getState(); if(!st)return; const before=attentionItems.map(i=>i.id).join('|'); refreshAttention(st,true); const after=attentionItems.map(i=>i.id).join('|'); if(before!==after && ['#dashboard','#notifications'].includes(location.hash)) renderCurrentRoute(); },60000);
  const launchUrl = new URL(location.href);
  const roomFromUrl = launchUrl.searchParams.get('room');
  const backendFromUrl = launchUrl.searchParams.get('cloud');
  if (backendFromUrl) {
    try { setCloudSettings({ enabled: true, apiBase: backendFromUrl }); }
    catch (error) { console.warn('Invite Cloud backend was rejected', error); toast(error.message, 'error'); }
  }
  if (roomFromUrl && !location.hash) navigate('multiplayer');
  else renderCurrentRoute();
  if (!roomFromUrl) setTimeout(() => showOnboarding(false), 250);
  try {
    if (roomFromUrl) {
      await connectCloudRoom(roomFromUrl);
      toast('Cloud room connected');
    } else {
      await restoreCloudSession();
    }
    if (getCloudStatus().roomCode && location.hash==='#multiplayer') renderCurrentRoute();
  } catch (error) {
    console.warn('Automatic Cloud connection failed', error);
    if (roomFromUrl) toast(error.message || 'Could not connect to Cloud room', 'error');
  }
}

boot();
