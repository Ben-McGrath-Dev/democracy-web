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
import { deriveAttention, notificationPrefs, setBrowserNotifications, markAttentionSeen, dismissAttention, snoozeAttention, clearDismissed, requestBrowserPermission, maybeSendBrowserNotifications } from './attention.js';
import { initRouter, navigate, registerRoute, registerDetailRoute, renderCurrentRoute } from './router.js';
import { RELEASE_CHANNEL, RELEASE_DATE, RELEASE_HIGHLIGHTS, KNOWN_LIMITATIONS, releaseReadiness, buildDiagnosticReport } from './release.js';
import { HELP_GUIDES, GLOSSARY, ONBOARDING_STEPS } from './help.js';
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
requestAnimationFrame(()=>applyUiMode());

let savedGames = [];
let saveChain = Promise.resolve();
let lastSnapshotted = new Map();
let recoverySnapshots = [];
let recoverySnapshotAudit = [];
let ballotKeyAvailability = {};
let attentionItems = [];
let deferredInstallPrompt = null;
let lastFocusedBeforeModal = null;
let lastFocusedBeforeMobileMenu = null;
let lastRuleTestResult = null;
let lastStressResult = null;
const runtimeErrors = [];
const ONBOARDING_KEY = 'democracy-web-onboarding-v2';
const GUIDE_SEEN_KEY = 'democracy-web-guide-seen-v1';
const UI_MODE_KEY = 'democracy-web-ui-mode-v1';
const NAV_GROUPS_KEY = 'democracy-web-nav-groups-v1';
const RECENT_ROUTES_KEY = 'democracy-web-recent-routes-v1';
const LIST_PREFS_KEY = 'democracy-web-list-prefs-v1';
const FORM_DRAFT_PREFIX = 'democracy-web-form-draft-v1:';
const LAW_WORKSPACE_KEY = 'democracy-web-law-workspace-v1';
const CONSTITUTION_SEARCH_KEY = 'democracy-web-constitution-search-v1';
let mobileBackTarget = 'dashboard';

const NAV_DESTINATIONS = [
  ['dashboard','Dashboard','Overview','⌂'],['actions','My Actions','Overview','!'],['activity','Activity','Overview','◷'],['multiplayer','Multiplayer','Overview','◎'],['notifications','Notifications','Overview','◔'],['help','Help & Guides','Overview','?'],
  ['votes','Votes','Politics','✓'],['elections','Elections','Politics','◫'],['parliament','Parliament','Politics','▥'],['government','Government','Politics','◆'],['parties','Parties','Politics','●'],['players','Players','Politics','◉'],
  ['laws','Laws','Law & Constitution','§'],['constitution','Constitution','Law & Constitution','¶'],['committees','Committees','Law & Constitution','◇'],['cases','Cases','Law & Constitution','⚖'],['rulebook','Full Rulebook','Law & Constitution','▤'],
  ['load','Saves','System','▣'],['recovery','Recovery','System','↻'],['testlab','Test Lab','System','⌁'],['release','Release','System','★'],['about','About','System','i'],['create','New Democracy','System','＋']
];


function readLocalValue(key, fallback = null) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value; }
  catch { return fallback; }
}

function writeLocalValue(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}

function safePartyColour(value, fallback = '#475569') {
  const text = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

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

function toast(message, kind = 'normal', { duration } = {}) {
  const region = document.querySelector('#toastRegion');
  if (!region) return;
  const tone = kind === 'normal' ? 'success' : kind;
  const node = document.createElement('div');
  node.className = `toast toast-${tone}`;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss message');
  close.textContent = '×';
  close.addEventListener('click', () => node.remove());
  node.append(text, close);
  region.append(node);
  const lifetime = duration ?? (tone === 'error' ? 8000 : 3800);
  if (lifetime > 0) setTimeout(() => node.remove(), lifetime);
}

function setSaveStatus(text, status = '') {
  const el = document.querySelector('#saveStatus');
  const mobile = document.querySelector('#mobileSaveStatus');
  if (el) { el.textContent = text; el.dataset.status = status; }
  if (mobile) {
    mobile.textContent = status === 'saving' ? 'Saving…' : /saved/i.test(text) ? 'Saved' : text;
    mobile.dataset.status = status;
  }
}

function setMobileMenu(open) {
  const menu = document.querySelector('#mobileMenu');
  const toggle = document.querySelector('.mobile-header [data-action="toggle-mobile-menu"]');
  if (!menu) return;
  if (open) lastFocusedBeforeMobileMenu = document.activeElement;
  menu.classList.toggle('is-open', open);
  menu.setAttribute('aria-hidden', open ? 'false' : 'true');
  toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) requestAnimationFrame(()=>menu.querySelector('.mobile-search')?.focus());
  else lastFocusedBeforeMobileMenu?.focus?.();
}

function readNavGroups() {
  try { return JSON.parse(readLocalValue(NAV_GROUPS_KEY, '{}')) || {}; }
  catch { return {}; }
}

function applyNavGroups() {
  const saved = readNavGroups();
  document.querySelectorAll('[data-nav-group]').forEach(group => {
    const name = group.dataset.navGroup;
    const collapsed = saved[name] === true;
    group.dataset.collapsed = collapsed ? 'true' : 'false';
    group.querySelector('.nav-group-toggle')?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

function toggleNavGroup(name) {
  if (!name) return;
  const group = document.querySelector(`[data-nav-group="${CSS.escape(name)}"]`);
  if (!group) return;
  const saved = readNavGroups();
  const collapsed = group.dataset.collapsed !== 'true';
  saved[name] = collapsed;
  writeLocalValue(NAV_GROUPS_KEY, JSON.stringify(saved));
  group.dataset.collapsed = collapsed ? 'true' : 'false';
  group.querySelector('.nav-group-toggle')?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : parts[0]?.slice(0,2) || '?').toUpperCase();
}

function setCountBadge(selector, count) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.textContent = String(count);
  node.hidden = count <= 0;
  node.setAttribute('aria-label', `${count} item${count === 1 ? '' : 's'} need attention`);
}

function updateShellContext(state = getState()) {
  const cloud = getCloudStatus();
  const actorId = localActorId(state);
  const actor = actorId ? state?.players?.[actorId] : null;
  const dot = document.querySelector('#shellConnectionDot');
  const label = document.querySelector('#shellConnectionLabel');
  const mobileDot = document.querySelector('#mobileShellConnectionDot');
  const mobileLabel = document.querySelector('#mobileShellConnectionLabel');
  const row = document.querySelector('#shellActorRow');
  const actorName = document.querySelector('#shellActorName');
  const mobileActorName = document.querySelector('#mobileShellActorName');
  const avatar = document.querySelector('#shellActorAvatar');
  let kind = 'local'; let text = state ? 'Local game' : 'No game loaded';
  if (cloud.roomCode || cloud.authenticated) {
    if (cloud.connection === 'connected' && cloud.authenticated && cloud.stateSynced) { kind = 'online'; text = 'Online · verified'; }
    else if (['connecting','reconnecting','authenticating','syncing'].includes(cloud.connection)) { kind = 'connecting'; text = 'Connecting…'; }
    else if (cloud.connection === 'error') { kind = 'error'; text = 'Connection issue'; }
    else { kind = 'connecting'; text = 'Cloud room'; }
  }
  for (const node of [dot,mobileDot].filter(Boolean)) node.className = `connection-dot ${kind}`;
  if (label) label.textContent = text;
  if (mobileLabel) mobileLabel.textContent = text;
  if (row) row.hidden = !actor;
  if (actorName) actorName.textContent = actor?.displayName ?? '—';
  if (mobileActorName) mobileActorName.textContent = actor ? `You · ${actor.displayName}` : (state ? 'No local player' : 'No game loaded');
  if (avatar && actor) avatar.textContent = initials(actor.displayName);
}

function recentRoutes() {
  try { return JSON.parse(readLocalValue(RECENT_ROUTES_KEY, '[]'))?.filter(Boolean) ?? []; }
  catch { return []; }
}

function rememberRecentRoute(route) {
  if (!route || ['home','create'].includes(route)) return;
  const next = [route, ...recentRoutes().filter(item => item !== route)].slice(0,5);
  writeLocalValue(RECENT_ROUTES_KEY, JSON.stringify(next));
}

function readListPrefs(page) {
  try {
    const all = JSON.parse(readLocalValue(LIST_PREFS_KEY, '{}')) || {};
    return { search:'', filter:'all', sort:'newest', view:'cards', ...(all[page] || {}) };
  } catch { return { search:'', filter:'all', sort:'newest', view:'cards' }; }
}

function writeListPref(page, patch) {
  try {
    const all = JSON.parse(readLocalValue(LIST_PREFS_KEY, '{}')) || {};
    all[page] = { ...readListPrefs(page), ...patch };
    writeLocalValue(LIST_PREFS_KEY, JSON.stringify(all));
  } catch {}
}

function listToolbar(page, { placeholder='Search…', filters=[], sorts=[['newest','Newest'],['oldest','Oldest']], allowView=true } = {}) {
  const pref = readListPrefs(page);
  const filterOptions = [['all','All'], ...filters];
  return `<div class="list-toolbar" data-list-toolbar="${escapeHtml(page)}">
    <label class="list-search"><span aria-hidden="true">⌕</span><input type="search" data-list-search="${escapeHtml(page)}" value="${escapeHtml(pref.search)}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}"></label>
    ${filters.length ? `<label class="list-control"><span>Filter</span><select data-list-filter="${escapeHtml(page)}">${filterOptions.map(([value,label])=>`<option value="${escapeHtml(value)}" ${pref.filter===value?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select></label>` : ''}
    ${sorts.length ? `<label class="list-control"><span>Sort</span><select data-list-sort="${escapeHtml(page)}">${sorts.map(([value,label])=>`<option value="${escapeHtml(value)}" ${pref.sort===value?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select></label>` : ''}
    ${allowView ? `<div class="view-toggle" aria-label="View density"><button type="button" class="btn btn-sm ${pref.view==='cards'?'active':''}" data-action="set-list-view" data-list-page="${escapeHtml(page)}" data-list-view="cards">Cards</button><button type="button" class="btn btn-sm ${pref.view==='compact'?'active':''}" data-action="set-list-view" data-list-page="${escapeHtml(page)}" data-list-view="compact">Compact</button></div>` : ''}
    <button class="btn btn-sm btn-quiet" type="button" data-action="clear-list-tools" data-list-page="${escapeHtml(page)}">Clear</button>
    <span class="list-result-count" data-list-count="${escapeHtml(page)}" aria-live="polite"></span>
  </div>`;
}

function applyListTools(page, root=document) {
  const toolbar = root.querySelector(`[data-list-toolbar="${CSS.escape(page)}"]`);
  const container = root.querySelector(`[data-list-container="${CSS.escape(page)}"]`);
  if (!toolbar || !container) return;
  const pref = readListPrefs(page);
  const q = String(pref.search || '').trim().toLowerCase();
  const filter = pref.filter || 'all';
  const items = [...container.querySelectorAll(':scope > [data-list-item]')];
  let visible = 0;
  for (const item of items) {
    const search = (item.dataset.search || item.textContent || '').toLowerCase();
    const tokens = (item.dataset.filterTokens || '').split('|').filter(Boolean);
    const matches = (!q || search.includes(q)) && (filter === 'all' || tokens.includes(filter));
    item.hidden = !matches;
    if (matches) visible++;
  }
  const numeric = key => Number.isFinite(Number(key)) ? Number(key) : 0;
  const sorted = [...items].sort((a,b)=>{
    if (pref.sort === 'oldest') return numeric(a.dataset.sortDate) - numeric(b.dataset.sortDate);
    if (pref.sort === 'az') return String(a.dataset.sortTitle||'').localeCompare(String(b.dataset.sortTitle||''));
    if (pref.sort === 'za') return String(b.dataset.sortTitle||'').localeCompare(String(a.dataset.sortTitle||''));
    if (pref.sort === 'deadline') return numeric(a.dataset.sortDeadline || Number.MAX_SAFE_INTEGER) - numeric(b.dataset.sortDeadline || Number.MAX_SAFE_INTEGER);
    if (pref.sort === 'relevant') return numeric(b.dataset.sortRelevance) - numeric(a.dataset.sortRelevance) || numeric(b.dataset.sortDate)-numeric(a.dataset.sortDate);
    return numeric(b.dataset.sortDate) - numeric(a.dataset.sortDate);
  });
  sorted.forEach(item=>container.append(item));
  container.classList.toggle('compact-list-view', pref.view === 'compact');
  const count = toolbar.querySelector(`[data-list-count="${CSS.escape(page)}"]`);
  if (count) count.textContent = `${visible} of ${items.length}`;
  let empty = root.querySelector(`[data-filtered-empty="${CSS.escape(page)}"]`);
  if (!empty && items.length) {
    empty = document.createElement('div');
    empty.className = 'empty filtered-empty';
    empty.dataset.filteredEmpty = page;
    empty.innerHTML = '<strong>No matching results</strong><p>Try changing your search or filters.</p><button class="btn" type="button" data-action="clear-list-tools" data-list-page="'+page+'">Clear filters</button>';
    container.insertAdjacentElement('afterend', empty);
  }
  if (empty) empty.hidden = visible !== 0 || items.length === 0;
}

function applyAllListTools(root=document) {
  root.querySelectorAll('[data-list-toolbar]').forEach(node=>applyListTools(node.dataset.listToolbar, root));
}

function applyConstitutionSearch(root=document) {
  const input=root.querySelector?.('[data-constitution-search]');
  const cards=[...(root.querySelectorAll?.('[data-constitution-section]')??[])];
  const toc=[...(root.querySelectorAll?.('[data-constitution-toc]')??[])];
  if (!input || !cards.length) return;
  const q=String(input.value??'').trim().toLowerCase();
  let visible=0;
  cards.forEach(card=>{const match=!q || String(card.dataset.search||'').includes(q);card.hidden=!match;if(match)visible++;});
  toc.forEach(item=>{item.hidden=Boolean(q && !String(item.dataset.search||'').includes(q));});
  const count=root.querySelector('[data-constitution-search-count]'); if(count) count.textContent=`${visible} of ${cards.length} sections`;
  const empty=root.querySelector('[data-constitution-empty]'); if(empty) empty.hidden=visible!==0;
}

function attentionVisible(items, pref=notificationPrefs(), now=Date.now()) {
  return items.filter(item => !pref.dismissed?.[item.id] && !(Number(pref.snoozed?.[item.id]) > now));
}

function attentionCardHtml(item, { compact=false } = {}) {
  const due = item.dueAt ? `<span class="attention-deadline" data-deadline="${escapeHtml(item.dueAt)}">${escapeHtml(formatDuration(Math.max(0,(Date.parse(item.dueAt)-getCloudNowMs())/1000)))}</span>` : '';
  const requestActions = item.requestId ? `<button class="btn btn-primary" data-action="respond-party-membership" data-request-id="${escapeHtml(item.requestId)}" data-response="accept">Accept</button><button class="btn" data-action="respond-party-membership" data-request-id="${escapeHtml(item.requestId)}" data-response="reject">Reject</button>` : `<button class="btn btn-primary" data-route="${escapeHtml(item.route || 'dashboard')}">${escapeHtml(item.actionLabel || 'Open')}</button>`;
  return `<article class="action-card ${item.priority==='urgent'?'urgent':''}${compact?' compact':''}"><div class="action-card-main"><div class="action-card-meta"><span class="pill">${escapeHtml(item.kind)}</span>${item.priority==='urgent'?'<span class="status status-danger">Urgent</span>':''}${due}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.message)}</p>${item.why?`<details class="why-details"><summary>Why am I seeing this?</summary><p>${escapeHtml(item.why)}</p></details>`:''}</div><div class="action-card-actions">${requestActions}${item.priority!=='urgent'?`<button class="btn btn-quiet" data-action="snooze-notification" data-notification-id="${escapeHtml(item.id)}">Remind me later</button>`:''}</div></article>`;
}

function commandEntries(state = getState()) {
  const advanced = getUiMode() === 'advanced';
  const hiddenInSimple = new Set(['recovery','testlab','release','about']);
  const entries = NAV_DESTINATIONS
    .filter(([route]) => advanced || !hiddenInSimple.has(route))
    .map(([route,label,group,icon]) => ({ route, label, subtitle: group, type: 'Page', icon, key: `page:${route}` }));
  if (!state) return entries;
  const push = (route, label, subtitle, type, icon, key) => entries.push({ route, label, subtitle, type, icon, key });
  Object.values(state.players ?? {}).forEach(player => push(`player/${encodeURIComponent(player.id)}`, player.displayName, `${playerStatusLabel(player.status)} player`, 'Player', '◉', `player:${player.id}`));
  Object.values(state.parties ?? {}).forEach(party => push(`party/${encodeURIComponent(party.id)}`, party.name, party.abbreviation ? `${party.abbreviation} · political party` : 'Political party', 'Party', '●', `party:${party.id}`));
  Object.values(state.votes ?? {}).forEach(vote => push(`${vote.electionKind ? 'election' : 'vote'}/${encodeURIComponent(vote.id)}`, vote.title, `${voteStatusLabel(vote.status)} · ${vote.id}`, vote.electionKind ? 'Election' : 'Vote', vote.electionKind ? '◫' : '✓', `vote:${vote.id}`));
  Object.values(state.lawProposals ?? {}).forEach(law => push(`law/${encodeURIComponent(law.id)}`, law.title || law.id, `${proposalStatusLabel(law.status)} · ${law.id}`, 'Law proposal', '§', `law:${law.id}`));
  Object.values(state.laws ?? {}).forEach(law => push(`law/${encodeURIComponent(law.id)}`, law.title || law.id, `Enacted law · ${law.id}`, 'Law', '§', `statute:${law.id}`));
  Object.values(state.cases ?? {}).forEach(record => push(`case/${encodeURIComponent(record.id)}`, record.title || record.id, `${caseStageLabel(record)} · ${record.id}`, 'Case', '⚖', `case:${record.id}`));
  Object.values(state.constitution?.proposals ?? {}).forEach(amendment => push(`amendment/${encodeURIComponent(amendment.id)}`, amendment.sectionTitle || amendment.id, `${statusInfo('amendment',amendment.status).label} · ${amendment.id}`, 'Amendment', '¶', `amendment:${amendment.id}`));
  Object.values(state.constitution?.sections ?? {}).forEach(section => push(`constitution-section/${encodeURIComponent(section.number)}`, `Section ${section.number} — ${section.title}`, `${section.category} constitutional section`, 'Constitution', '¶', `constitution:${section.number}`));
  Object.values(state.committees ?? {}).forEach(committee => push(`committee/${encodeURIComponent(committee.code)}`, committeeLongName(committee.code), `${committee.code} · constitutional committee`, 'Committee', '◇', `committee:${committee.code}`));
  return entries;
}

function commandMatches(entry, query) {
  if (!query) return true;
  const haystack = `${entry.label} ${entry.subtitle} ${entry.type} ${entry.key}`.toLowerCase();
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return terms.every(term => haystack.includes(term));
}

function renderCommandPalette(query = '') {
  const target = document.querySelector('#commandResults');
  if (!target) return;
  const q = query.trim();
  let entries = commandEntries().filter(entry => commandMatches(entry, q));
  if (!q) {
    const recent = recentRoutes();
    const recentEntries = recent.map(route => entries.find(entry => entry.route === route && entry.type === 'Page')).filter(Boolean);
    const suggested = ['dashboard','votes','laws','activity','help'].map(route => entries.find(entry => entry.route === route && entry.type === 'Page')).filter(Boolean);
    entries = [...recentEntries, ...suggested.filter(item => !recentEntries.some(r => r.key === item.key)), ...entries.filter(item => item.type !== 'Page')].slice(0,12);
  } else entries = entries.slice(0,18);
  if (!entries.length) {
    target.innerHTML = `<div class="command-empty"><strong>No matches</strong><p>Try a page name, player, party, law ID or case ID.</p></div>`;
    return;
  }
  target.innerHTML = entries.map((entry,index)=>`<button class="command-result${index===0?' is-selected':''}" type="button" role="option" aria-selected="${index===0?'true':'false'}" data-command-route="${escapeHtml(entry.route)}" data-command-key="${escapeHtml(entry.key)}"><span class="command-result-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.subtitle)}</small></span><span class="command-result-type">${escapeHtml(entry.type)}</span></button>`).join('');
}

function openCommandPalette(initialQuery = '') {
  const palette = document.querySelector('#commandPalette');
  const input = document.querySelector('#commandSearchInput');
  if (!palette || !input) return;
  setMobileMenu(false);
  lastFocusedBeforeModal = document.activeElement;
  palette.hidden = false;
  palette.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  input.value = initialQuery;
  renderCommandPalette(initialQuery);
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function closeCommandPalette() {
  const palette = document.querySelector('#commandPalette');
  if (!palette || palette.hidden) return;
  palette.hidden = true;
  palette.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  lastFocusedBeforeModal?.focus?.();
}

function moveCommandSelection(direction) {
  const results = [...document.querySelectorAll('.command-result')];
  if (!results.length) return;
  let index = results.findIndex(node => node.classList.contains('is-selected'));
  index = index < 0 ? 0 : (index + direction + results.length) % results.length;
  results.forEach((node,i) => { const selected=i===index; node.classList.toggle('is-selected',selected); node.setAttribute('aria-selected',selected?'true':'false'); });
  results[index].scrollIntoView({ block: 'nearest' });
}

function activateCommandSelection() {
  const selected = document.querySelector('.command-result.is-selected') || document.querySelector('.command-result');
  if (!selected) return;
  closeCommandPalette();
  navigate(selected.dataset.commandRoute);
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

function modalDraftKey(key) { return key ? `${FORM_DRAFT_PREFIX}${key}` : null; }

function modalFieldKey(field, index) {
  if ((field.type === 'checkbox' || field.type === 'radio') && field.name) return `${field.name}:${field.value || index}`;
  return field.id || field.name || `field-${index}`;
}

function serializeModalDraft(dialog) {
  const data = {};
  [...dialog.querySelectorAll('input,select,textarea')].forEach((field,index) => {
    if (field.type === 'password' || field.type === 'file' || field.type === 'hidden') return;
    const key = modalFieldKey(field,index);
    if (field.type === 'checkbox' || field.type === 'radio') data[key] = Boolean(field.checked);
    else data[key] = field.value;
  });
  return data;
}

function restoreModalDraft(dialog, key) {
  const storageKey = modalDraftKey(key);
  if (!storageKey) return false;
  let draft;
  try { draft = JSON.parse(readLocalValue(storageKey, 'null')); } catch { draft = null; }
  if (!draft || typeof draft !== 'object') return false;
  [...dialog.querySelectorAll('input,select,textarea')].forEach((field,index) => {
    if (field.type === 'password' || field.type === 'file' || field.type === 'hidden') return;
    const fieldKey = modalFieldKey(field,index);
    if (!(fieldKey in draft)) return;
    if (field.type === 'checkbox' || field.type === 'radio') field.checked = Boolean(draft[fieldKey]);
    else field.value = draft[fieldKey];
  });
  return true;
}

function clearModalDraft(key) {
  const storageKey = modalDraftKey(key);
  if (!storageKey) return;
  try { localStorage.removeItem(storageKey); } catch {}
}

function saveModalDraft(dialog, key) {
  const storageKey = modalDraftKey(key);
  if (!storageKey) return;
  writeLocalValue(storageKey, JSON.stringify(serializeModalDraft(dialog)));
}

function fieldErrorNode(field) {
  const container = field.closest('.field');
  if (!container) return null;
  let node = container.querySelector(':scope > .field-error');
  if (!node) {
    node = document.createElement('span');
    node.className = 'field-error';
    node.setAttribute('aria-live','polite');
    container.append(node);
  }
  return node;
}

function updateCharacterCounter(field) {
  const max = Number(field.getAttribute('maxlength'));
  if (!Number.isFinite(max) || max <= 0) return;
  const container = field.closest('.field');
  if (!container) return;
  let meta = container.querySelector(':scope > .field-meta');
  if (!meta) { meta = document.createElement('div'); meta.className = 'field-meta'; container.append(meta); }
  let counter = meta.querySelector('.char-counter');
  if (!counter) { counter = document.createElement('span'); counter.className = 'char-counter'; meta.append(counter); }
  const length = String(field.value ?? '').length;
  counter.textContent = `${length} / ${max}`;
  counter.classList.toggle('near-limit', length >= max * .85 && length < max);
  counter.classList.toggle('at-limit', length >= max);
}

function enhanceCandidatePickers(container) {
  if (!container) return;
  container.querySelectorAll('.candidate-picker').forEach(picker => {
    const rows=[...picker.querySelectorAll(':scope > .check-row')];
    if (rows.length < 7 || picker.dataset.searchEnhanced === 'true') return;
    picker.dataset.searchEnhanced='true';
    const tools=document.createElement('div');
    tools.className='candidate-picker-tools';
    tools.innerHTML='<label class="candidate-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search choices" aria-label="Search choices"></label><span class="candidate-selected-count">0 selected</span>';
    picker.prepend(tools);
    const input=tools.querySelector('input');
    const count=tools.querySelector('.candidate-selected-count');
    const updateCount=()=>{const selected=rows.filter(row=>row.querySelector('input:checked')).length;count.textContent=`${selected} selected`;};
    input.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();rows.forEach(row=>{row.hidden=Boolean(q)&&!row.textContent.toLowerCase().includes(q);});});
    picker.addEventListener('change',updateCount);
    updateCount();
  });
}

function decorateModalFields(dialog) {
  if (!dialog) return;
  enhanceCandidatePickers(dialog);
  [...dialog.querySelectorAll('input,select,textarea')].forEach(field => {
    if (field.required) field.closest('.field')?.querySelector('label')?.classList.add('field-required');
    if (field.hasAttribute('maxlength')) updateCharacterCounter(field);
    if (field.dataset.formEnhanced === 'true') return;
    field.dataset.formEnhanced = 'true';
    field.addEventListener('input', () => {
      field.removeAttribute('aria-invalid');
      const error = fieldErrorNode(field); if (error) error.textContent = '';
      updateCharacterCounter(field);
    });
    field.addEventListener('blur', () => {
      if (!field.required || field.value) return;
      const error = fieldErrorNode(field); if (error) error.textContent = field.validationMessage || 'This field is required.';
    });
  });
}

function normalizeModalValues(dialog) {
  [...dialog.querySelectorAll('input[type="text"],input:not([type]),textarea')].forEach(field => {
    if (field.readOnly || field.disabled) return;
    field.value = String(field.value ?? '').trim();
  });
}

function validateModalFields(dialog) {
  normalizeModalValues(dialog);
  let firstInvalid = null;
  for (const field of dialog.querySelectorAll('input,select,textarea')) {
    if (field.disabled || field.type === 'hidden') continue;
    const valid = field.checkValidity?.() ?? true;
    const error = fieldErrorNode(field);
    if (!valid) {
      field.setAttribute('aria-invalid','true');
      if (error) error.textContent = field.validationMessage || 'Check this field.';
      firstInvalid ??= field;
    } else {
      field.removeAttribute('aria-invalid');
      if (error) error.textContent = '';
    }
  }
  if (firstInvalid) { firstInvalid.focus(); firstInvalid.scrollIntoView({ block:'center', behavior:'smooth' }); return false; }
  return true;
}

function reviewRows(rows = []) {
  return `<div class="review-list">${rows.filter(row => row?.[0]).map(([label,value])=>`<div class="review-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? '—')}</strong></div>`).join('')}</div>`;
}

function showModal({
  title,
  body,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  eyebrow = '',
  summary = '',
  actorLabel = '',
  consequenceItems = [],
  irreversible = false,
  draftKey = '',
  review = null,
  reviewText = 'Review',
  onConfirm
}) {
  const root = document.querySelector('#modalRoot');
  lastFocusedBeforeModal = document.activeElement;
  let reviewing = false;
  let submitting = false;
  const close = ({ clearDraft = false } = {}) => {
    if (clearDraft) clearModalDraft(draftKey);
    root.innerHTML = '';
    document.body.classList.remove('modal-open');
    lastFocusedBeforeModal?.focus?.();
  };
  const consequenceHtml = consequenceItems?.length ? `<div class="modal-consequences${danger ? ' danger' : ''}"><strong>${danger ? 'Before you continue' : 'This will'}</strong><ul>${consequenceItems.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul>${irreversible ? '<div class="irreversible-note"><span aria-hidden="true">⚠</span><span>This official action cannot be undone from the interface.</span></div>' : ''}</div>` : (irreversible ? '<div class="irreversible-note"><span aria-hidden="true">⚠</span><span>This official action cannot be undone from the interface.</span></div>' : '');
  root.innerHTML = `
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">
        <header class="modal-header"><div class="modal-header-main">${eyebrow ? `<span class="modal-eyebrow">${escapeHtml(eyebrow)}</span>` : ''}<h2 id="modalTitle">${escapeHtml(title)}</h2></div><button class="icon-btn modal-close" type="button" data-modal-close aria-label="Close">×</button></header>
        <div class="modal-body">
          ${actorLabel ? `<div class="modal-context"><span class="avatar avatar-sm">${escapeHtml(initials(actorLabel))}</span><span>Acting as</span><strong>${escapeHtml(actorLabel)}</strong></div>` : ''}
          ${summary ? `<p class="modal-summary">${escapeHtml(summary)}</p>` : ''}
          ${draftKey ? '<div class="draft-notice" data-draft-notice hidden><span>Draft restored from this device.</span><button class="btn btn-sm btn-quiet" type="button" data-clear-modal-draft>Discard draft</button></div>' : ''}
          <div class="modal-error" data-modal-error hidden></div>
          <div class="modal-stage-form">${body}${consequenceHtml}</div>
          <div class="modal-stage-review" hidden></div>
        </div>
        <footer class="modal-footer">
          ${draftKey ? '<span class="modal-footer-note">Draft saves automatically on this device.</span>' : '<span class="modal-footer-note"></span>'}
          <button class="btn" type="button" data-modal-cancel>${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-modal-confirm>${escapeHtml(review ? reviewText : confirmText)}</button>
        </footer>
      </div>
    </div>`;
  document.body.classList.add('modal-open');
  const dialog = root.querySelector('.modal');
  const formStage = root.querySelector('.modal-stage-form');
  const reviewStage = root.querySelector('.modal-stage-review');
  const cancelButton = root.querySelector('.modal-footer [data-modal-cancel]');
  const confirmButton = root.querySelector('.modal-footer [data-modal-confirm]');
  const errorBox = root.querySelector('[data-modal-error]');
  const focusables = () => [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter(node => !node.closest('[hidden]'));
  const showError = message => { if (!errorBox) return; errorBox.textContent = message || 'That action could not be completed.'; errorBox.hidden = false; errorBox.scrollIntoView({block:'nearest'}); };
  const hideError = () => { if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; } };
  decorateModalFields(dialog);
  if (draftKey && restoreModalDraft(dialog, draftKey)) {
    const notice = root.querySelector('[data-draft-notice]'); if (notice) notice.hidden = false;
    dialog.querySelectorAll('[maxlength]').forEach(updateCharacterCounter);
    dialog.querySelectorAll('.candidate-picker').forEach(picker=>picker.dispatchEvent(new Event('change',{bubbles:true})));
  }
  if (draftKey) {
    dialog.addEventListener('input', event => { if (!event.target.matches('input,select,textarea')) return; saveModalDraft(dialog,draftKey); });
    dialog.addEventListener('change', event => { if (!event.target.matches('input,select,textarea')) return; saveModalDraft(dialog,draftKey); });
    root.querySelector('[data-clear-modal-draft]')?.addEventListener('click', () => { clearModalDraft(draftKey); close(); showModal({ title, body, confirmText, cancelText, danger, eyebrow, summary, actorLabel, consequenceItems, irreversible, draftKey, review, reviewText, onConfirm }); toast('Saved draft discarded','info'); });
  }
  const goBackFromReview = () => {
    reviewing = false; reviewStage.hidden = true; formStage.hidden = false; cancelButton.textContent = cancelText; confirmButton.textContent = review ? reviewText : confirmText; hideError();
    requestAnimationFrame(()=>focusables().find(node=>node.matches('input,select,textarea'))?.focus());
  };
  const requestClose = () => { if (reviewing) { goBackFromReview(); return; } close(); };
  dialog.addEventListener('keydown', e => {
    if (e.key==='Escape') { e.preventDefault(); requestClose(); return; }
    if (e.key==='Tab') {
      const f = focusables(); if (!f.length) return; const first=f[0], last=f.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  root.querySelector('.modal-backdrop').addEventListener('mousedown', event => { if (event.target === event.currentTarget && !danger) requestClose(); });
  root.querySelector('[data-modal-close]').addEventListener('click', requestClose);
  root.querySelectorAll('[data-modal-cancel]').forEach(button => button.addEventListener('click', requestClose));
  confirmButton.addEventListener('click', async () => {
    if (submitting) return;
    hideError();
    if (!reviewing && !validateModalFields(dialog)) return;
    if (review && !reviewing) {
      try {
        const html = await review(root);
        if (html === false) return;
        reviewStage.innerHTML = `<div class="review-panel"><div><span class="modal-eyebrow">Final check</span><h3>Review before submitting</h3></div>${html || ''}${consequenceHtml}</div>`;
        formStage.hidden = true; reviewStage.hidden = false; reviewing = true;
        cancelButton.textContent = 'Back'; confirmButton.textContent = confirmText;
        reviewStage.scrollIntoView({block:'start'}); confirmButton.focus();
      } catch (error) { showError(error?.message || 'Check the information and try again.'); }
      return;
    }
    const originalText = confirmButton.textContent;
    try {
      submitting = true; confirmButton.disabled = true; confirmButton.setAttribute('aria-busy','true'); confirmButton.textContent = 'Working…';
      const result = await onConfirm?.(root);
      if (result !== false) close({ clearDraft:true });
    } catch (error) {
      console.error(error); showError(error?.message || 'That action could not be completed.'); toast(error?.message || 'That action could not be completed.','error');
    } finally {
      submitting = false;
      if (root.querySelector('[data-modal-confirm]')) { confirmButton.disabled = false; confirmButton.removeAttribute('aria-busy'); confirmButton.textContent = reviewing ? confirmText : originalText; }
    }
  });
  const preferred = dialog.querySelector('[autofocus]') || dialog.querySelector('input:not([type="hidden"]),select,textarea') || cancelButton;
  requestAnimationFrame(()=>preferred?.focus() || dialog.focus());
  return root;
}

function showConsequenceModal({ title, summary = '', consequences = [], confirmText = 'Confirm', danger = false, irreversible = false, state = getState(), onConfirm }) {
  const actorId = localActorId(state);
  const actor = actorId ? state?.players?.[actorId] : null;
  showModal({ title, body:'', summary, actorLabel:actor?.displayName ?? '', consequenceItems:consequences, confirmText, danger, irreversible, onConfirm });
}

function readBallotChoice(vote, root) {
  if ([VOTE_TYPES.YES_NO,VOTE_TYPES.YES_NO_ABSTAIN,VOTE_TYPES.SINGLE,VOTE_TYPES.PROPORTIONAL].includes(vote.type)) return root.querySelector('#ballotChoice').value;
  if (vote.type === VOTE_TYPES.APPROVAL) return [...root.querySelectorAll('input[name="approvalChoice"]:checked')].map(input=>input.value);
  if (vote.type === VOTE_TYPES.RANKED) {
    const ranked=[...root.querySelectorAll('[data-rank-option]')].map(select=>({id:select.dataset.rankOption,rank:Number(select.value)})).filter(item=>item.rank>0);
    const ranks=ranked.map(item=>item.rank);
    if(new Set(ranks).size!==ranks.length) throw new Error('Each ranking number can only be used once.');
    return ranked.sort((a,b)=>a.rank-b.rank).map(item=>item.id);
  }
  return null;
}

function ballotChoiceSummary(vote, choice) {
  const label = id => vote.options?.find(option=>option.id===id)?.label ?? id;
  if (Array.isArray(choice)) {
    if (!choice.length) return 'No options selected';
    if (vote.type === VOTE_TYPES.RANKED) return choice.map((id,index)=>`${index+1}. ${label(id)}`).join(' · ');
    return choice.map(label).join(', ');
  }
  return choice == null ? 'No choice selected' : label(choice);
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

function guideButton(key, label = 'How this works') {
  return `<button class="btn btn-guide" type="button" data-action="show-guide" data-guide="${escapeHtml(key)}">? ${escapeHtml(label)}</button>`;
}

function processTracker(stages, currentIndex, { compact = false } = {}) {
  return `<div class="process-tracker${compact ? ' process-tracker-compact' : ''}" aria-label="Process progress">${stages.map((stage,index)=>{
    const stateClass = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'future';
    const marker = index < currentIndex ? '✓' : index === currentIndex ? '●' : '○';
    return `<div class="process-step ${stateClass}"><span class="process-marker" aria-hidden="true">${marker}</span><span>${escapeHtml(stage)}</span></div>`;
  }).join('')}</div>`;
}

function showGuide(key) {
  const guide = HELP_GUIDES[key];
  if (!guide) return;
  let seen = {};
  try { seen = JSON.parse(readLocalValue(GUIDE_SEEN_KEY, '{}')) || {}; } catch { seen = {}; }
  seen[key] = true;
  writeLocalValue(GUIDE_SEEN_KEY, JSON.stringify(seen));
  showModal({
    title: guide.title,
    body: `<p class="page-lead">${escapeHtml(guide.summary)}</p><ol class="guide-steps">${guide.steps.map((step,index)=>`<li><span>${index+1}</span><div>${escapeHtml(step)}</div></li>`).join('')}</ol><div class="notice"><strong>Need the exact rule?</strong><p>The Full Rulebook remains the authority for constitutional wording and thresholds.</p><button class="btn" type="button" data-route="rulebook" data-modal-cancel>Open Full Rulebook</button></div>`,
    confirmText: 'Got it',
    cancelText: 'Close'
  });
}

function roleLabelsFor(state, playerId) {
  const player = state?.players?.[playerId];
  if (!player) return [];
  const roles = [];
  if (playerId === state.meta?.hostPlayerId) roles.push('Host');
  if (playerId === state.meta?.deputyHostPlayerId) roles.push('Deputy Host');
  if (playerId === state.government?.primeMinisterId) roles.push('Prime Minister');
  if ((state.government?.ministers ?? []).some(m => m.playerId === playerId)) roles.push('Minister');
  if ((state.legislature?.seats ?? []).some(seat => seat.memberId === playerId)) roles.push('MP');
  const party = player.partyId ? state.parties?.[player.partyId] : null;
  if (party?.leaderId === playerId) roles.push(`${party.abbreviation || party.name} Leader`);
  return roles.length ? roles : ['Citizen'];
}

function attentionActionHtml(item) {
  if (item.requestId) return `<button class="btn btn-primary" data-route="actions">${escapeHtml(item.actionLabel || 'Review request')}</button>`;
  return `<button class="btn btn-primary" data-route="${escapeHtml(item.route || 'dashboard')}">${escapeHtml(item.actionLabel || 'Open')}</button>`;
}

function cloudConnectionStages(cloud) {
  const rank = { offline:0, error:0, disconnected:0, connecting:1, reconnecting:1, authenticating:2, connected:3, syncing:4 };
  const stage = rank[cloud.connection] ?? 0;
  const websocketDone = stage >= 2 || cloud.authenticated;
  const authDone = Boolean(cloud.authenticated);
  const syncDone = Boolean(cloud.stateSynced && cloud.stateHash);
  const roomKnown = Boolean(cloud.roomCode);
  return [
    ['Backend & room', roomKnown ? 'complete' : cloud.connection === 'error' ? 'error' : 'current'],
    ['WebSocket', websocketDone ? 'complete' : roomKnown ? 'current' : 'future'],
    ['Identity', authDone ? 'complete' : websocketDone ? 'current' : 'future'],
    ['Verified state', syncDone ? 'complete' : authDone ? 'current' : 'future']
  ];
}

function connectionJourney(cloud) {
  return `<div class="connection-journey">${cloudConnectionStages(cloud).map(([label,status])=>`<div class="connection-stage ${status}"><span>${status==='complete'?'✓':status==='error'?'!':'•'}</span><strong>${escapeHtml(label)}</strong></div>`).join('')}</div>`;
}


function getUiMode() {
  const stored = readLocalValue(UI_MODE_KEY);
  return stored === 'advanced' ? 'advanced' : 'simple';
}

function applyUiMode(mode = getUiMode()) {
  const next = mode === 'advanced' ? 'advanced' : 'simple';
  document.documentElement.dataset.uiMode = next;
  document.body?.setAttribute('data-ui-mode', next);
  document.querySelectorAll('[data-ui-mode-label]').forEach(node => { node.textContent = next === 'advanced' ? 'Advanced' : 'Simple'; });
  return next;
}

function setUiMode(mode) {
  writeLocalValue(UI_MODE_KEY, mode === 'advanced' ? 'advanced' : 'simple');
  return applyUiMode(mode);
}

function eventMentionsPlayer(event, playerId) {
  if (!event || !playerId) return false;
  if (event.actorId === playerId) return true;
  const data = event.data ?? {};
  return Object.entries(data).some(([key,value]) => {
    if (!/player|leader|host|minister|member|accused|complainant|prime|replacement|juror/i.test(key)) return false;
    return value === playerId || (Array.isArray(value) && value.includes(playerId));
  });
}

function playerPublicActivity(state, playerId, limit = 12) {
  return [...(state.history ?? [])].reverse().filter(event => eventMentionsPlayer(event, playerId)).slice(0, limit);
}

function committeeLongName(code) {
  return ({ AC:'Actions Committee', PC:'Punishment Committee', PAC:"People's Actions Committee", PPC:"People's Punishment Committee" })[code] ?? `${code} Committee`;
}

function committeeMemberLocal(state, code, playerId = localActorId(state)) {
  if (!playerId) return false;
  const committee = state.committees?.[code];
  return Boolean(committee && [...(committee.members ?? []), ...(committee.alternates ?? [])].includes(playerId));
}

function caseStage(caseRecord) {
  const status = String(caseRecord?.status ?? 'open');
  if (status === 'closed' || caseRecord?.ppcPunishment) return 5;
  if (status.includes('ppc') || status === 'awaiting-ppc') return 4;
  if (status.includes('jury') || status === 'awaiting-jury' || status === 'jury-ready') return 3;
  if (status.includes('pac') || caseRecord?.pacPanel?.length) return 2;
  if (caseRecord?.accusedResponse) return 1;
  return 0;
}

function caseStageLabel(caseRecord) {
  return ['Complaint','Response','PAC review','Jury review','PPC outcome','Closed'][caseStage(caseRecord)];
}

function deriveCoachTips(state) {
  if (!state) return [];
  const actorId = localActorId(state);
  const tips = [];
  const openVotes = Object.values(state.votes ?? {}).filter(v => v.status === 'open');
  const eligible = openVotes.filter(v => actorId && v.electorateSnapshot?.includes(actorId));
  const uncast = eligible.filter(v => v.secretBallotMode === 'sealed-v1' ? !v.submittedVoters?.[actorId] : !v.ballots?.[actorId]);
  if (uncast.length) tips.push({ icon:'🗳', title:`You have ${uncast.length} ballot${uncast.length===1?'':'s'} to cast`, text:'Voting before the deadline is the most important action currently waiting for you.', route:uncast[0].electionKind?'elections':'votes', action:'Open voting' });
  const gov = state.government;
  const filled = filledLegislativeSeats(state);
  if (filled.length && (!gov?.primeMinisterId || ['caretaker','forming'].includes(gov?.status))) tips.push({ icon:'◆', title:'Government formation needs attention', text:'Parliament exists but the government is not in a settled running state. Coalition and confidence tools are available on the Government page.', route:'government', action:'Review government' });
  const lawReady = Object.values(state.lawProposals ?? {}).find(p => p.status === 'discussion' && discussionFinished(p, getCloudNowMs()));
  if (lawReady) tips.push({ icon:'§', title:`${lawReady.id} can move forward`, text:'Its discussion period has finished. The proposer or authorised administrator may now freeze/finalise the text for the next stage.', route:'laws', action:'Open legislation' });
  const activeCase = Object.values(state.cases ?? {}).find(c => c.status !== 'closed' && (c.accusedId === actorId || c.complainantId === actorId || c.pacPanel?.includes(actorId) || c.jury?.includes(actorId)));
  if (activeCase) tips.push({ icon:'⚖', title:`You are involved in ${activeCase.id}`, text:`The case is currently at ${caseStageLabel(activeCase)}. Open the case to see what happens next and whether you have an action.`, route:'cases', action:'Open case' });
  if (!tips.length) tips.push({ icon:'💡', title:'Nothing urgent right now', text:'You are caught up. Check recent activity or explore the Help Centre if you want to understand another part of the political system.', route:'activity', action:'View activity' });
  return tips.slice(0,3);
}

function coachPanel(state) {
  const tips = deriveCoachTips(state);
  return `<section class="section coach-panel"><div class="section-header compact-header"><div><span class="page-kicker">Democracy Coach</span><h2>What should I do next?</h2><p class="muted">Contextual suggestions based on the current official state. The Coach never changes rules or state itself.</p></div><span class="pill">${tips.length} suggestion${tips.length===1?'':'s'}</span></div><div class="coach-grid">${tips.map(t=>`<article class="coach-card"><span class="coach-icon" aria-hidden="true">${t.icon}</span><div><strong>${escapeHtml(t.title)}</strong><p>${escapeHtml(t.text)}</p></div><button class="btn" type="button" data-route="${escapeHtml(t.route)}">${escapeHtml(t.action)}</button></article>`).join('')}</div></section>`;
}

function playerStatusLabel(status) {
  const map = { active: 'Active', inactive: 'Temporarily inactive', resigned: 'Resigned', removed: 'Permanently removed' };
  return map[status] ?? status;
}


const STATUS_COPY = {
  vote: {
    draft: ['Draft','This vote has been created but voting has not opened yet.','info'],
    scheduled: ['Scheduled','This vote is waiting for its announced opening time.','info'],
    open: ['Voting open','Eligible voters may submit or change their ballot before the deadline.','active'],
    paused: ['Voting paused','Voting is temporarily paused; the deadline must be handled consistently with the rules.','warning'],
    closed: ['Counted — awaiting certification','Voting has closed and a result exists, but it is not official until certification.','warning'],
    certified: ['Certified','The result is official and forms part of the record.','active'],
    cancelled: ['Cancelled','This vote is no longer proceeding.','muted']
  },
  case: {
    open: ['Complaint opened','The allegation is recorded and the ordinary-law case procedure has begun.','info'],
    'pac-review': ['PAC review','A People’s Actions Committee panel is considering whether the alleged ordinary-law violation is proven.','warning'],
    'pac-voting': ['PAC decision','The PAC panel is making its finding. The PAC determines guilt, not punishment.','warning'],
    'awaiting-jury': ['Waiting for jury','A PAC guilty finding must automatically be reviewed by a jury.','warning'],
    'jury-ready': ['Jury review','The jury decides whether the PAC guilty finding should be upheld.','warning'],
    'awaiting-ppc': ['Waiting for PPC','The jury upheld the guilty finding. The People’s Punishment Committee now determines any lawful punishment.','warning'],
    closed: ['Case closed','The case has reached its final recorded outcome.','active']
  },
  law: {
    petition: ['Sponsorship petition','The proposal is gathering the support required for its route.','info'],
    discussion: ['Public discussion','The proposal remains open for discussion and may still be edited as permitted.','info'],
    frozen: ['Final wording frozen','The wording is fixed for the next formal vote.','warning'],
    'awaiting-parliament': ['Waiting for Parliament','The final wording is ready for the legislature.','warning'],
    parliament: ['Parliamentary vote','The legislature is considering the frozen proposal.','warning'],
    'referendum-window': ['Referendum petition window','The law has passed Parliament and may still be referred to the public under the constitutional procedure.','warning'],
    referendum: ['Public referendum','The proposal is before the electorate.','warning'],
    enacted: ['Enacted','The proposal completed its procedure and became law.','active'],
    rejected: ['Rejected','The proposal failed to pass the required stage.','muted'],
    failed: ['Failed','The proposal did not complete the required procedure successfully.','muted'],
    withdrawn: ['Withdrawn','The proposal is no longer progressing.','muted']
  },
  amendment: {
    petition: ['Sponsorship petition','The amendment is gathering the support required to be formally proposed.','info'],
    discussion: ['Constitutional discussion','The proposal must remain open for the required constitutional discussion period.','info'],
    frozen: ['Final wording frozen','The amendment wording is fixed for the public vote.','warning'],
    voting: ['Public amendment vote','The electorate is voting on the constitutional amendment.','warning'],
    passed: ['Passed','The amendment passed its public vote and awaits or has reached commencement.','active'],
    applied: ['In force','The amendment now forms part of this Democracy’s Constitution.','active'],
    failed: ['Failed','The amendment did not satisfy its constitutional threshold.','muted'],
    rejected: ['Rejected','The amendment did not pass.','muted']
  }
};

function statusInfo(kind, status) {
  const entry = STATUS_COPY[kind]?.[status];
  if (entry) return { label: entry[0], description: entry[1], tone: entry[2] };
  return { label: String(status ?? 'Unknown').replaceAll('-',' ').replace(/\b\w/g,c=>c.toUpperCase()), description:'This is the current recorded state.', tone:'info' };
}

function statusInfoHtml(kind, status) {
  const info = statusInfo(kind,status);
  return `<div class="status-explainer status-explainer-${escapeHtml(info.tone)}"><span class="status status-${escapeHtml(status)}">${escapeHtml(info.label)}</span><span>${escapeHtml(info.description)}</span></div>`;
}

function breadcrumbHtml(items) {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${items.map((item,index)=>`${index?'<span aria-hidden="true">›</span>':''}${item.route?`<button type="button" data-route="${escapeHtml(item.route)}">${escapeHtml(item.label)}</button>`:`<span aria-current="page">${escapeHtml(item.label)}</span>`}`).join('')}</nav>`;
}

function objectHistoryHtml(state, id, limit = 10) {
  const needle=String(id ?? '').toLowerCase();
  const rows=[...(state.history ?? [])].reverse().filter(event=>JSON.stringify(event).toLowerCase().includes(needle)).slice(0,limit);
  return rows.length ? `<ul class="detail-history">${rows.map(event=>`<li><span>${escapeHtml(describeEvent(event,state))}</span><small>${escapeHtml(formatDateTime(event.timestamp))}</small></li>`).join('')}</ul>` : '<div class="empty compact-empty">No matching history entries are recorded yet.</div>';
}

function nextStepForVote(vote, state) {
  const caps=actorCapabilities(state);
  const eligible=Boolean(caps.actorId && vote.electorateSnapshot?.includes(caps.actorId));
  const submitted=vote.secretBallotMode==='sealed-v1' ? Boolean(vote.submittedVoters?.[caps.actorId]) : Boolean(vote.ballots?.[caps.actorId]);
  if (vote.status==='draft') return caps.canAdminVotes ? ['Open voting','Confirm the published details, electorate and deadline, then open voting when the procedure is ready.'] : ['Waiting for voting to open','The authorised election/vote administrator must open this vote.'];
  if (vote.status==='open' && eligible && !submitted) return ['Your ballot is needed',`You are in this vote’s electorate snapshot. Submit your ballot before ${formatDateTime(vote.closesAt)}.`];
  if (vote.status==='open' && eligible && submitted) return ['Your ballot is submitted',`You may review or change it while voting remains open, if this voting method permits changes.`];
  if (vote.status==='open') return ['Voting is in progress',`This vote closes ${formatDateTime(vote.closesAt)}. You are not in its electorate snapshot.`];
  if (vote.status==='closed') return caps.canAdminVotes ? ['Certify the result','The count exists but is not official until an authorised administrator certifies it.'] : ['Waiting for certification','The counted result must be certified by the authorised administrator before it becomes official.'];
  if (vote.status==='certified') return ['Procedure complete','The result is certified and part of the official record.'];
  if (vote.status==='paused') return ['Voting is paused','The administrator must resolve the interruption before the process continues.'];
  return ['No action required','This vote has no current action for you.'];
}

function nextStepForLaw(proposal, state) {
  const caps=actorCapabilities(state);
  const owns=caps.actorId===proposal.proposerId;
  if (proposal.status==='petition') return ['Gather required support','The proposal remains at its sponsorship or initiative petition stage until the required threshold is met.'];
  if (proposal.status==='discussion') {
    if (!discussionFinished(proposal,getCloudNowMs())) return [owns?'You may still edit the proposal':'Discussion remains open',`The discussion period ends ${formatDateTime(proposal.discussionEndsAt)}. The wording is not frozen yet.`];
    return [owns||caps.hostLike?'Freeze the final wording':'Discussion is complete','The required discussion period has ended. The final text can now be frozen by an authorised player.'];
  }
  if (['frozen','awaiting-parliament'].includes(proposal.status)) return ['Parliament is next','The final wording is frozen. Parliament must decide the bill using the required legislative majority.'];
  if (proposal.status==='parliament') return ['Parliamentary decision in progress','The legislature is voting on the frozen wording.'];
  if (proposal.status==='referendum-window') return ['Referendum window open','A qualifying public petition or legislative referral may send the passed law to a public referendum during this window.'];
  if (proposal.status==='referendum') return ['Public referendum in progress','The electorate now decides whether the law takes effect.'];
  if (proposal.status==='enacted') return ['Law enacted','This proposal completed its procedure and is now part of the statute book.'];
  return ['Procedure complete',`This proposal is recorded as ${statusInfo('law',proposal.status).label.toLowerCase()}.`];
}

function nextStepForCase(c, state) {
  const actorId=localActorId(state);
  if (c.status==='open') return actorId===c.accusedId && !c.accusedResponse ? ['Your response is required','The accused has a right to know the allegation, see the evidence relied upon and provide a response before the PAC process continues.'] : ['PAC panel comes next','A three-person eligible PAC panel must investigate the alleged ordinary-law violation and allow the accused a reasonable opportunity to respond.'];
  if (['pac-review','pac-voting'].includes(c.status)) return ['PAC determines guilt','The People’s Actions Committee panel decides Guilty or Not Guilty using the constitutional standard of proof. It does not determine punishment.'];
  if (c.status==='awaiting-jury') return ['Jury review is mandatory','Every PAC Guilty finding is automatically reviewed by a five-person eligible jury.'];
  if (c.status==='jury-ready') return ['Jury decides whether to uphold','An ordinary majority of the jury decides whether the PAC Guilty finding is upheld.'];
  if (c.status==='awaiting-ppc') return ['PPC determines punishment','Because the jury upheld the Guilty finding, the People’s Punishment Committee may now determine only a lawful, proportionate punishment.'];
  if (c.status==='closed') return ['Case complete','The final outcome is recorded. Repeat proceedings are limited by the Constitution’s finality rules.'];
  return ['Follow the recorded procedure','The current case status determines the next constitutional step.'];
}

function nextStepPanel(title, text) {
  return `<section class="next-step-panel"><span class="page-kicker">What happens next?</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></section>`;
}

function partyBadge(state, player) {
  const party = player.partyId ? state.parties[player.partyId] : null;
  if (!party) return '<span class="muted">Independent</span>';
  return `<span class="party-inline"><span class="colour-dot" style="--party-colour:${safePartyColour(party.colour)}"></span>${escapeHtml(party.abbreviation || party.name)}</span>`;
}

function actorCapabilities(state) {
  const actorId = localActorId(state);
  const player = actorId ? state?.players?.[actorId] : null;
  const party = player?.partyId ? state.parties?.[player.partyId] : null;
  const hostLike = isHostLikeLocal(state, actorId);
  const mp = Boolean(actorId && (state.legislature?.seats ?? []).some(seat => seat.memberId === actorId));
  const partyLeader = Boolean(actorId && party?.leaderId === actorId);
  const coalitionLeader = Boolean(actorId && (state.government?.coalitionPartyIds ?? []).some(id => state.parties?.[id]?.leaderId === actorId));
  const primeMinister = state.government?.primeMinisterId === actorId;
  return {
    actorId, player, party, hostLike, mp, partyLeader, coalitionLeader, primeMinister,
    governmentAuthority: hostLike || primeMinister || coalitionLeader,
    canAdminVotes: hostLike,
    roles: actorId ? roleLabelsFor(state, actorId) : []
  };
}

function emptyState(title, text, { route = '', actionLabel = '', icon = '◇' } = {}) {
  return `<div class="empty empty-state-rich"><span class="empty-state-icon" aria-hidden="true">${escapeHtml(icon)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>${route ? `<button class="btn" type="button" data-route="${escapeHtml(route)}">${escapeHtml(actionLabel || 'Open')}</button>` : ''}</div>`;
}

function unavailableAction(label, reason, { kind = '' } = {}) {
  return `<span class="disabled-action"><button class="btn ${kind}" type="button" disabled>${escapeHtml(label)}</button><span class="disabled-reason">${escapeHtml(reason)}</span></span>`;
}

function resultBars(rows, { max = null } = {}) {
  const maximum = max ?? Math.max(1, ...rows.map(row => Number(row.value) || 0));
  return `<div class="result-bars">${rows.map(row => {
    const value = Number(row.value) || 0;
    const width = maximum ? Math.max(value > 0 ? 3 : 0, value / maximum * 100) : 0;
    return `<div class="result-bar-row${row.winner ? ' winner' : ''}${row.muted ? ' muted-row' : ''}"><div class="result-bar-label"><span>${row.swatch ? `<span class="colour-dot" style="--party-colour:${safePartyColour(row.swatch)}"></span>` : ''}${escapeHtml(row.label)}</span><strong>${escapeHtml(row.display ?? String(value))}</strong></div><div class="result-bar-track"><span style="width:${width.toFixed(2)}%"></span></div>${row.note ? `<small>${escapeHtml(row.note)}</small>` : ''}</div>`;
  }).join('')}</div>`;
}

function proposalStageIndex(status) {
  const map = { petition:0, discussion:1, frozen:2, 'awaiting-parliament':2, parliament:3, 'referendum-window':4, referendum:4, enacted:5, rejected:5, failed:5 };
  return map[status] ?? 0;
}

function amendmentStageIndex(status) {
  const map = { petition:0, discussion:1, frozen:2, voting:3, passed:4, applied:4, failed:4, rejected:4 };
  return map[status] ?? 0;
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

function voteStatusLabel(status) { return statusInfo('vote', status).label; }

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
  const turnoutHtml = result.turnout ? `<div class="result-summary"><span><strong>${result.turnout.cast}/${result.turnout.electorate}</strong> turnout</span><span>${formatPercent(result.turnout.rate)}</span></div>` : '';

  if (result.kind === 'yes-no') {
    const total = Math.max(1, (result.counts.yes ?? 0) + (result.counts.no ?? 0) + (result.counts.abstain ?? 0));
    const bars = resultBars([
      { label:'Yes', value:result.counts.yes ?? 0, display:`${result.counts.yes ?? 0} · ${formatPercent((result.counts.yes ?? 0)/total)}`, winner:result.passed },
      { label:'No', value:result.counts.no ?? 0, display:`${result.counts.no ?? 0} · ${formatPercent((result.counts.no ?? 0)/total)}`, winner:!result.passed },
      { label:'Abstain', value:result.counts.abstain ?? 0, display:String(result.counts.abstain ?? 0), muted:true }
    ], { max: total });
    return `${turnoutHtml}<div class="result-outcome ${result.passed?'passed':'failed'}"><strong>${result.passed ? 'Passed' : 'Failed'}</strong><span>Approval ${formatPercent(result.approvalRate)}${result.requiredYes ? ` · ${result.requiredYes} Yes required` : ''}</span></div>${bars}`;
  }
  if (result.kind === 'ranked-choice') {
    const rounds = result.rounds.map((round,index) => {
      const active = Object.entries(round.counts).sort((a,b)=>b[1]-a[1]);
      const max = Math.max(1,...active.map(([,count])=>count));
      return `<article class="ranked-round"><div class="section-header compact-header"><div><span class="page-kicker">Round ${round.number}</span><h3>${index === result.rounds.length-1 ? 'Final active preferences' : 'Preference count'}</h3></div><span class="pill">${round.activeBallots} active ballots</span></div>${resultBars(active.map(([id,count])=>({label:optionLabel(vote,id),value:count,winner:id===result.winnerId})),{max})}</article>`;
    }).join('');
    const outcome = result.winnerId ? `<div class="result-outcome passed"><strong>${escapeHtml(optionLabel(vote,result.winnerId))}</strong><span>Elected after ${result.rounds.length} round${result.rounds.length===1?'':'s'}</span></div>` : `<div class="result-outcome failed"><strong>Tie-break required</strong><span>${(result.tie ?? []).map(id=>escapeHtml(optionLabel(vote,id))).join(', ')}</span></div>`;
    return `${turnoutHtml}${outcome}<div class="ranked-rounds">${rounds}</div>`;
  }
  if (result.kind === 'proportional') {
    const totalVotes = Math.max(1,Object.values(result.rawCounts ?? {}).reduce((a,b)=>a+b,0));
    const rows = vote.options.map(option => ({
      label: option.label,
      value: result.rawCounts[option.id] ?? 0,
      display: `${result.rawCounts[option.id] ?? 0} votes · ${result.seats[option.id] ?? 0} seat${(result.seats[option.id] ?? 0)===1?'':'s'}`,
      note: result.qualifyingIds.includes(option.id) ? 'Passed 10% threshold' : 'Below threshold',
      muted: !result.qualifyingIds.includes(option.id)
    }));
    return `${turnoutHtml}${resultBars(rows,{max:totalVotes})}<details class="result-method"><summary>How were the seats calculated?</summary><p>Only lists meeting the election threshold qualify. Seats are allocated using largest remainder: whole quotas first, then remaining seats by the largest fractional remainders.</p><div class="table-wrap"><table class="data-table compact-table"><thead><tr><th>List</th><th>Votes</th><th>Quota</th><th>Remainder</th><th>Seats</th></tr></thead><tbody>${vote.options.map(option=>`<tr><td>${escapeHtml(option.label)}</td><td>${result.rawCounts[option.id] ?? 0}</td><td>${result.quotas?.[option.id] === undefined ? '—' : Number(result.quotas[option.id]).toFixed(2)}</td><td>${result.remainders?.[option.id] === undefined ? '—' : Number(result.remainders[option.id]).toFixed(3)}</td><td><strong>${result.seats[option.id] ?? 0}</strong></td></tr>`).join('')}</tbody></table></div></details>`;
  }
  if (result.kind === 'approval') {
    const ordered=[...vote.options].sort((a,b)=>(result.counts[b.id]??0)-(result.counts[a.id]??0));
    const max=Math.max(1,...ordered.map(o=>result.counts[o.id]??0));
    const bars=resultBars(ordered.map(option=>({label:option.label,value:result.counts[option.id]??0,winner:result.winners.includes(option.id),note:result.winners.includes(option.id)?'Elected':result.tie?.includes(option.id)?'Tie at cutoff':''})),{max});
    return `${turnoutHtml}${result.tie ? `<div class="notice"><strong>Tie at the election cutoff</strong><p>${result.tie.map(id=>escapeHtml(optionLabel(vote,id))).join(', ')} require a tie-break.</p></div>` : ''}${bars}`;
  }
  if (result.kind === 'single-choice') {
    const ordered=[...vote.options].sort((a,b)=>(result.counts[b.id]??0)-(result.counts[a.id]??0));
    const max=Math.max(1,...ordered.map(o=>result.counts[o.id]??0));
    return `${turnoutHtml}${resultBars(ordered.map(option=>({label:option.label,value:result.counts[option.id]??0,winner:option.id===result.winnerId})),{max})}<div class="result-outcome ${result.winnerId?'passed':'failed'}"><strong>${result.winnerId ? `Winner: ${escapeHtml(optionLabel(vote,result.winnerId))}` : 'Tie'}</strong>${!result.winnerId?`<span>${(result.tie??[]).map(id=>escapeHtml(optionLabel(vote,id))).join(', ')}</span>`:''}</div>`;
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
  const caps = actorCapabilities(state);
  const eligible = Boolean(caps.actorId && vote.electorateSnapshot?.includes(caps.actorId));
  const submitted = vote.secretBallotMode === 'sealed-v1' ? Boolean(vote.submittedVoters?.[caps.actorId]) : Boolean(vote.ballots?.[caps.actorId]);
  const canAdmin = caps.canAdminVotes;
  const adminButtons = vote.status === 'draft'
    ? (canAdmin ? `<button class="btn btn-primary" data-action="open-vote" data-vote-id="${vote.id}">Open Vote</button>` : unavailableAction('Open Vote','Only the Constitutional Host or Deputy Host can administer voting.'))
    : vote.status === 'open'
      ? (canAdmin ? `<button class="btn" data-action="pause-vote" data-vote-id="${vote.id}">Pause</button><button class="btn" data-action="close-vote" data-vote-id="${vote.id}">Close & Count</button>` : '')
      : vote.status === 'paused'
        ? (canAdmin ? `<button class="btn btn-primary" data-action="resume-vote" data-vote-id="${vote.id}">Resume</button><button class="btn" data-action="close-vote" data-vote-id="${vote.id}">Close & Count</button>` : '')
        : vote.status === 'closed'
          ? (canAdmin ? `<button class="btn btn-primary" data-action="certify-vote" data-vote-id="${vote.id}">Certify Result</button>` : unavailableAction('Certify Result','Only the Constitutional Host or Deputy Host can certify the official result.'))
          : '';
  const ballotButton = vote.status === 'open'
    ? (eligible ? `<button class="btn btn-primary" data-action="cast-ballot" data-vote-id="${vote.id}">${submitted ? 'Review / Change My Ballot' : 'Cast My Ballot'}</button>` : unavailableAction('Cast Ballot','You are not in this vote’s electorate snapshot.'))
    : '';
  return `<article class="card vote-card${vote.electionKind ? ' election-card' : ''}" data-list-item data-search="${escapeHtml(`${vote.title} ${vote.id} ${vote.type} ${vote.electionKind||''}`)}" data-filter-tokens="${escapeHtml([vote.status, eligible&&!submitted?'mine':'', vote.electionKind||vote.type].filter(Boolean).join('|'))}" data-sort-title="${escapeHtml(vote.title.toLowerCase())}" data-sort-date="${Date.parse(vote.createdAt)||0}" data-sort-deadline="${Date.parse(vote.closesAt)||Number.MAX_SAFE_INTEGER}" data-sort-relevance="${eligible&&!submitted?2:vote.status==='open'?1:0}">
    <div class="section-header compact-header"><div><span class="pill">${escapeHtml(vote.electionKind ? electionKindLabel(vote.electionKind, vote.committee) : vote.type)}</span><h2>${escapeHtml(vote.title)}</h2><p class="muted">${vote.secret ? (vote.secretBallotMode === 'sealed-v1' ? 'Sealed secret ballot' : 'Secret ballot') : 'Public ballot'} · ${escapeHtml(voteStatusLabel(vote.status))}</p></div><span class="status status-${escapeHtml(vote.status)}">${escapeHtml(voteStatusLabel(vote.status))}</span></div>
    ${vote.status === 'open' ? `<div class="vote-progress"><div><strong>${cast}/${electorate}</strong><span> ballots</span></div><div data-deadline="${escapeHtml(vote.closesAt)}">${escapeHtml(formatDuration(seconds))}</div></div>${eligible ? `<div class="personal-vote-state ${submitted?'done':''}"><strong>${submitted?'Your ballot is submitted':'Your vote is needed'}</strong><span>${submitted?'You can change it while voting remains open.':'You are eligible in this vote.'}</span></div>` : ''}` : ''}
    <p class="muted small">${escapeHtml(ballotSummary(vote, state))}</p>
    ${['closed','certified'].includes(vote.status) ? `<div class="result-box visual-result">${voteResultHtml(vote)}</div>` : ''}
    <div class="btn-row section role-action-row">
      ${ballotButton}${adminButtons}
      ${vote.secretBallotMode === 'sealed-v1' && ['closed','certified'].includes(vote.status) ? `<button class="btn" data-action="verify-secret-vote" data-vote-id="${vote.id}">Verify Sealed Ballots</button>` : ''}
      <button class="btn" data-route="${vote.electionKind ? 'election' : 'vote'}/${encodeURIComponent(vote.id)}">Open details</button>
      <button class="btn" data-action="share-vote" data-vote-id="${vote.id}">Share</button>
    </div>
  </article>`;
}

function votesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const caps = actorCapabilities(state);
  const votes = Object.values(state.votes ?? {}).filter(v => !v.electionKind).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
  const yourBallots = caps.actorId ? votes.filter(v => v.status==='open' && v.electorateSnapshot?.includes(caps.actorId) && !(v.secretBallotMode==='sealed-v1' ? v.submittedVoters?.[caps.actorId] : v.ballots?.[caps.actorId])) : [];
  const yourHtml = yourBallots.length ? `<section class="section your-ballots"><div class="section-header compact-header"><div><span class="page-kicker">Needs you</span><h2>Your ballots</h2><p class="muted">These votes are open and still waiting for your ballot.</p></div><span class="badge">${yourBallots.length}</span></div><div class="action-ballot-list">${yourBallots.map(v=>`<article class="action-ballot"><div><strong>${escapeHtml(v.title)}</strong><span>${escapeHtml(v.secret?'Secret ballot':'Public ballot')} · closes ${escapeHtml(formatDateTime(v.closesAt))}</span></div><div class="btn-row"><button class="btn btn-primary" data-action="cast-ballot" data-vote-id="${v.id}">Vote now</button><button class="btn" data-route="vote/${encodeURIComponent(v.id)}">Details</button></div></article>`).join('')}</div></section>` : `<section class="section caught-up-strip"><span aria-hidden="true">✓</span><div><strong>No ballots are waiting for you</strong><p class="muted">Open votes and historical results remain available below.</p></div></section>`;
  return `<section class="section-header"><div><h1>Votes</h1><p class="muted">Your active ballots first, followed by referendums, motions and completed results.</p></div><div class="btn-row">${guideButton('votes')}<button class="btn btn-primary" data-action="create-vote">Create Vote</button></div></section>${yourHtml}
    ${votes.length?listToolbar('votes',{placeholder:'Search votes…',filters:[['mine','Needs my vote'],['open','Open'],['paused','Paused'],['closed','Awaiting certification'],['certified','Certified']],sorts:[['relevant','Most relevant to me'],['deadline','Deadline soonest'],['newest','Newest'],['oldest','Oldest'],['az','A–Z']]}):''}
    <div class="grid" data-list-container="votes">${votes.map(v => voteCard(v,state)).join('') || emptyState('No votes yet','When a referendum, motion or other vote is created it will appear here.',{icon:'✓'})}</div>`;
}

function electionsPage() {
  const state = getState();
  if (!state) return noGamePage();
  const caps = actorCapabilities(state);
  const elections = Object.values(state.votes ?? {}).filter(v => v.electionKind).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
  const removal = state.hostRemoval;
  const removalHtml = state.meta.hostPlayerId ? `<section class="card section"><div class="section-header compact-header"><div><h2>Host Removal</h2><p class="muted">Current Host: ${escapeHtml(state.players[state.meta.hostPlayerId]?.displayName ?? state.meta.hostPlayerId)}</p></div>${(!removal || ['passed','failed'].includes(removal.status)) ? '<button class="btn btn-danger" data-action="start-host-removal">Start Removal Petition</button>' : ''}</div>${removal && ['petition','voting'].includes(removal.status) ? `<p><strong>Status:</strong> ${escapeHtml(removal.status)}</p><p><strong>Signatures:</strong> ${removal.signatures?.length ?? 0}/${signatureThreshold(state,0.20)}</p><div class="btn-row">${removal.status==='petition'?'<button class="btn" data-action="sign-host-removal">Sign Petition</button>':''}${removal.voteId?'<button class="btn" data-route="votes">View Removal Vote</button>':''}</div>` : '<p class="muted">A removal petition needs 20% of active players. The public vote then requires 90% approval and 50% turnout.</p>'}</section>` : '';
  const createButton = caps.hostLike ? '<button class="btn btn-primary" data-action="create-election">Create Election</button>' : unavailableAction('Create Election','Only the Constitutional Host or Deputy Host can administer official elections.');
  const active = elections.filter(v=>['draft','open','paused','closed'].includes(v.status));
  const history = elections.filter(v=>v.status==='certified');
  const focus = active[0];
  const focusHtml = focus ? `<section class="election-focus card"><div class="section-header compact-header"><div><span class="page-kicker">Current election</span><h2>${escapeHtml(focus.title)}</h2><p class="muted">${escapeHtml(electionKindLabel(focus.electionKind,focus.committee))} · ${escapeHtml(voteStatusLabel(focus.status))}</p></div><span class="status status-${escapeHtml(focus.status)}">${escapeHtml(voteStatusLabel(focus.status))}</span></div>${processTracker(['Setup','Candidates','Voting','Counted','Certified'],focus.status==='draft'?1:focus.status==='open'||focus.status==='paused'?2:focus.status==='closed'?3:4,{compact:true})}<div class="election-focus-grid"><div><span class="meta-label">Eligible voters</span><strong>${focus.electorateSnapshot?.length??'Set on open'}</strong></div><div><span class="meta-label">Deadline</span><strong>${focus.closesAt?escapeHtml(formatDateTime(focus.closesAt)):'Not open yet'}</strong></div><div><span class="meta-label">Your ballot</span><strong>${caps.actorId&&focus.electorateSnapshot?.includes(caps.actorId)?((focus.secretBallotMode==='sealed-v1'?focus.submittedVoters?.[caps.actorId]:focus.ballots?.[caps.actorId])?'Submitted':'Needed'):'Not eligible / not open'}</strong></div></div><div class="btn-row">${focus.status==='open'&&caps.actorId&&focus.electorateSnapshot?.includes(caps.actorId)?`<button class="btn btn-primary" data-action="cast-ballot" data-vote-id="${focus.id}">${(focus.secretBallotMode==='sealed-v1'?focus.submittedVoters?.[caps.actorId]:focus.ballots?.[caps.actorId])?'Review ballot':'Vote now'}</button>`:''}<button class="btn" data-route="election/${encodeURIComponent(focus.id)}">Open election</button></div></section>` : '';
  return `<section class="section-header"><div><h1>Elections</h1><p class="muted">General, Host, Deputy Host and committee elections with a clearer setup → voting → certification lifecycle.</p></div><div class="btn-row">${guideButton('elections')}${createButton}</div></section>
    ${caps.actorId ? `<div class="role-context"><span class="page-kicker">Your election role</span><strong>${escapeHtml(caps.roles.join(' · '))}</strong><span>${caps.hostLike ? 'You can administer elections. Ballots are still cast only as your own player identity.' : 'You can participate in elections where your player is in the electorate.'}</span></div>` : ''}
    ${focusHtml}${removalHtml}
    <section class="section"><div class="section-header compact-header"><div><h2>${active.length?'All elections':'Election history'}</h2><p class="muted">${active.length?`${active.length} active · ${history.length} certified`:`${history.length} certified election${history.length===1?'':'s'}`}</p></div></div>${elections.length?listToolbar('elections',{placeholder:'Search elections…',filters:[['mine','Needs my vote'],['open','Voting open'],['draft','Setup'],['closed','Awaiting certification'],['certified','Certified']],sorts:[['relevant','Most relevant to me'],['deadline','Deadline soonest'],['newest','Newest'],['oldest','Oldest']]}):''}<div class="grid" data-list-container="elections">${elections.map(v => voteCard(v,state)).join('') || emptyState('No elections yet','When the Constitutional Host creates an election, nominations, voting and results will appear here.',{icon:'🗳'})}</div></section>`;
}

function parliamentPage() {
  const state = getState();
  if (!state) return noGamePage();
  const caps = actorCapabilities(state);
  const seats = state.legislature?.seats ?? [];
  const filled = filledLegislativeSeats(state);
  const counts = partySeatCounts(state);
  const required = majorityThreshold(filled.length);
  const total = state.legislature.totalSeats || 0;
  const yourSeat = caps.actorId ? seats.find(seat=>seat.memberId===caps.actorId) : null;
  const orderedParties = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const partyRows = orderedParties.map(([partyId,count]) => {
    const party = state.parties[partyId];
    const pct = filled.length ? Math.round(count / filled.length * 100) : 0;
    return `<div class="parliament-party-row"><div><span class="colour-dot" style="--party-colour:${safePartyColour(party?.colour)}"></span><strong>${escapeHtml(party?.name ?? 'Unknown list')}</strong><span class="muted">${count} seat${count===1?'':'s'} · ${pct}%</span></div><div class="seat-share-track"><span style="width:${pct}%;--party-colour:${safePartyColour(party?.colour)}"></span></div>${count >= required ? '<span class="pill">Majority</span>' : ''}</div>`;
  }).join('');
  const seatRows = seats.map(seat => {
    const member = seat.memberId ? state.players[seat.memberId] : null;
    const party = seat.partyId ? state.parties[seat.partyId] : null;
    const canVacate = caps.hostLike || member?.id === caps.actorId;
    return `<tr${member?.id===caps.actorId?' class="is-local-row"':''}><td>${seat.number}</td><td>${party ? `<span class="colour-dot" style="--party-colour:${safePartyColour(party.colour)}"></span>${escapeHtml(party.name)}` : '—'}</td><td>${member ? `<strong>${escapeHtml(member.displayName)}</strong>${member.id===caps.actorId?' <span class="pill">You</span>':''}` : '<span class="muted">Vacant</span>'}</td><td>${member && canVacate ? `<button class="btn btn-danger" data-action="resign-mp-seat" data-player-id="${member.id}">${member.id===caps.actorId?'Resign Seat':'Vacate Seat'}</button>` : member ? '<span class="muted">No action available</span>' : '—'}</td></tr>`;
  }).join('');
  const seatDots = seats.map(seat=>{ const party=seat.partyId?state.parties[seat.partyId]:null; const member=seat.memberId?state.players[seat.memberId]:null; return member ? `<button class="seat-dot${member.id===caps.actorId?' is-you':''}" style="--party-colour:${safePartyColour(party?.colour, '#d0d5dd')}" title="Seat ${seat.number}: ${escapeHtml(member.displayName)} — ${escapeHtml(party?.name??'Independent')}" aria-label="Seat ${seat.number}: ${escapeHtml(member.displayName)}, ${escapeHtml(party?.name??'Independent')}" data-route="player/${encodeURIComponent(member.id)}"></button>` : `<span class="seat-dot vacant" style="--party-colour:#d0d5dd" title="Seat ${seat.number}: Vacant" aria-label="Seat ${seat.number}: Vacant"></span>`; }).join('');
  const memberCards = seats.map(seat=>{const member=seat.memberId?state.players[seat.memberId]:null;const party=seat.partyId?state.parties[seat.partyId]:null;return `<article class="mp-mobile-card${member?.id===caps.actorId?' is-you':''}"><div><span class="meta-label">Seat ${seat.number}</span><strong>${escapeHtml(member?.displayName??'Vacant')}</strong><span>${party?`<span class="colour-dot" style="--party-colour:${safePartyColour(party.colour)}"></span>${escapeHtml(party.name)}`:'No party'}</span></div>${member?`<button class="btn" data-route="player/${encodeURIComponent(member.id)}">Profile</button>`:''}</article>`}).join('');
  const legislativeVotes = Object.values(state.votes ?? {}).filter(v => v.settings?.electorateMode === 'legislature').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const createVote = caps.governmentAuthority && filled.length ? '<button class="btn btn-primary" data-action="create-legislative-vote">New Parliamentary Vote</button>' : unavailableAction('New Parliamentary Vote', !filled.length ? 'Parliament is created after a certified General Election.' : 'Only the Government, coalition leadership, Host or Deputy Host can create a parliamentary vote.');
  return `<section class="section-header"><div><h1>Parliament</h1><p class="muted">${filled.length}/${total} seats filled · ${filled.length ? `${required} needed for a majority` : 'awaiting a General Election'}</p></div><div class="btn-row">${guideButton('parliament')}${createVote}</div></section>
    ${!total ? emptyState('Parliament has not been elected yet','Certify a General Election to allocate seats and begin the parliamentary term.',{route:'elections',actionLabel:'Open Elections',icon:'🏛'}) : `
    ${yourSeat ? `<div class="role-context success"><span class="page-kicker">Your parliamentary role</span><strong>MP · Seat ${yourSeat.number}</strong><span>You can participate in parliamentary electorates and your seat is highlighted below.</span></div>` : caps.actorId ? `<div class="role-context"><span class="page-kicker">Your parliamentary role</span><strong>Not currently an MP</strong><span>You can follow divisions and composition, but parliamentary ballots are limited to sitting MPs.</span></div>` : ''}
    <div class="grid grid-4">${statCard(total,'Total Seats')}${statCard(filled.length,'Filled Seats')}${statCard(required,'Majority')}${statCard(Math.max(0,total-filled.length),'Vacancies')}</div>
    <section class="section parliament-visual card"><div class="section-header compact-header"><div><h2>Composition</h2><p class="muted">Seat share across the current Parliament.</p></div><span class="pill">Majority ${required}</span></div><div class="seat-map" aria-label="Parliament seat map">${seatDots}</div><div class="parliament-party-list">${partyRows || '<p class="muted">No seats are currently filled.</p>'}</div></section>
    <section class="section grid grid-2"><div class="card"><h2>Term</h2><dl class="kv"><dt>Started</dt><dd>${escapeHtml(formatDateTime(state.legislature.termStartedAt))}</dd><dt>Ends</dt><dd>${escapeHtml(formatDateTime(state.legislature.termEndsAt))}</dd><dt>Source election</dt><dd>${escapeHtml(state.legislature.sourceElectionId ?? '—')}</dd></dl></div><div class="card"><h2>Majority line</h2><div class="majority-meter"><span style="width:${filled.length?Math.min(100,required/filled.length*100):0}%"></span></div><p class="muted">A normal legislative majority requires ${required} Yes votes when all ${filled.length} currently filled seats are counted.</p></div></section>
    <section class="section card parliament-members"><div class="section-header compact-header"><div><h2>Members of Parliament</h2><p class="muted">Tap a member on mobile to open their profile. Seats remain tied to their electoral list.</p></div></div><div class="desktop-mp-table table-wrap"><table class="data-table"><thead><tr><th>Seat</th><th>Party</th><th>MP</th><th>Actions</th></tr></thead><tbody>${seatRows}</tbody></table></div><div class="mobile-mp-list">${memberCards}</div></section>`}
    <section class="section"><div class="section-header"><div><h2>Parliamentary Votes</h2><p class="muted">Only sitting MPs in the electorate snapshot can cast a parliamentary ballot.</p></div></div><div class="grid">${legislativeVotes.map(v=>voteCard(v,state)).join('') || emptyState('No parliamentary votes yet','When a parliamentary motion is created it will appear here with its electorate, deadline and result.',{icon:'✓'})}</div></section>`;
}

function governmentPage() {
  const state = getState();
  if (!state) return noGamePage();
  const caps = actorCapabilities(state);
  const gov = state.government;
  const majority = governmentMajorityStatus(state);
  const pm = gov.primeMinisterId ? state.players[gov.primeMinisterId] : null;
  const coalition = (gov.coalitionPartyIds ?? []).map(id=>state.parties[id]).filter(Boolean);
  const seatCounts = partySeatCounts(state);
  const activePartiesWithSeats = Object.keys(seatCounts).map(id=>state.parties[id]).filter(p=>p?.status==='active');
  const ministers = (gov.ministers ?? []).map(m => ({...m, player:state.players[m.playerId]}));
  const actionButtons = state.legislature.totalSeats
    ? (caps.governmentAuthority
      ? `<button class="btn btn-primary" data-action="form-government">${gov.primeMinisterId ? 'Replace Government' : 'Form Government'}</button>${gov.status==='active' ? '<button class="btn" data-action="create-confidence-vote">Confidence Vote</button><button class="btn" data-action="create-no-confidence-vote">Constructive No Confidence</button>' : ''}${['active','caretaker'].includes(gov.status) ? '<button class="btn" data-action="set-caretaker">Set Caretaker</button>' : ''}${gov.status==='caretaker' && gov.caretakerDeadline ? '<button class="btn" data-action="check-caretaker-deadline">Check 72h Deadline</button>' : ''}`
      : unavailableAction(gov.primeMinisterId?'Manage Government':'Form Government','Government actions are available to the Prime Minister, coalition party leaders, Host or Deputy Host.'))
    : unavailableAction('Form Government','Parliament must exist before a government can be formed.');
  const coalitionRows = coalition.map(p=>({label:p.name,value:seatCounts[p.id]??0,display:`${seatCounts[p.id]??0} seats`,swatch:p.colour}));
  const oppositionSeats = Math.max(0, majority.filledSeats - majority.coalitionSeats);
  return `<section class="section-header"><div><h1>Government</h1><p class="muted">${gov.status==='active'?'A governing coalition is currently in office.':gov.status==='caretaker'?'The government is operating in caretaker status.':'No active government is currently formed.'}</p></div><div class="btn-row">${guideButton('government')}${actionButtons}</div></section>
    ${caps.actorId ? `<div class="role-context${caps.primeMinister||caps.coalitionLeader?' success':''}"><span class="page-kicker">Your government role</span><strong>${escapeHtml(caps.roles.join(' · '))}</strong><span>${caps.governmentAuthority?'You have authority to access government management controls.':'You can view government composition and confidence status.'}</span></div>` : ''}
    ${pm ? `<section class="government-hero"><div><span class="page-kicker">${gov.status==='caretaker'?'Caretaker government':'Government in office'}</span><h2>Government of ${escapeHtml(pm.displayName)}</h2><p>${coalition.length?coalition.map(p=>escapeHtml(p.name)).join(' + '):'No coalition parties recorded'}</p></div><div class="government-hero-majority"><strong>${majority.coalitionSeats}/${majority.filledSeats}</strong><span>${majority.hasMajority?'majority held':`${Math.max(0,majority.required-majority.coalitionSeats)} seat${Math.max(0,majority.required-majority.coalitionSeats)===1?'':'s'} short`}</span></div></section>` : ''}
    <div class="grid grid-4">${statCard(pm?.displayName ?? '—','Prime Minister')}${statCard(coalition.map(p=>p.abbreviation||p.name).join(' + ') || '—','Coalition')}${statCard(`${majority.coalitionSeats}/${majority.filledSeats}`,'Government Seats')}${statCard(majority.required || '—','Majority Needed')}</div>
    <section class="section government-command card"><div class="section-header compact-header"><div><h2>${pm?'Government majority':'Government formation'}</h2><p class="muted">${pm?`${majority.hasMajority?'The coalition controls a majority.':'The coalition does not currently control a majority.'}`:'Select parties whose combined seats meet the parliamentary majority threshold.'}</p></div>${pm?`<span class="status ${majority.hasMajority?'status-active':'status-error'}">${majority.hasMajority?'Majority':'Minority'}</span>`:''}</div>${pm?`<div class="government-balance"><div class="balance-side government"><strong>${majority.coalitionSeats}</strong><span>Government</span></div><div class="balance-track"><span style="width:${majority.filledSeats?majority.coalitionSeats/majority.filledSeats*100:0}%"></span><i style="left:${majority.filledSeats?majority.required/majority.filledSeats*100:50}%"></i></div><div class="balance-side opposition"><strong>${oppositionSeats}</strong><span>Other seats</span></div></div>${coalitionRows.length?resultBars(coalitionRows,{max:Math.max(1,majority.filledSeats)}):''}`:emptyState('No government formed','A coalition controlling a majority of filled parliamentary seats can form a government.',{icon:'◆'})}</section>
    <section class="section grid grid-2"><div class="card"><h2>Government details</h2>${pm ? `<dl class="kv"><dt>Prime Minister</dt><dd>${escapeHtml(pm.displayName)}</dd><dt>Coalition</dt><dd>${coalition.map(p=>escapeHtml(p.name)).join(' + ')}</dd><dt>Formed</dt><dd>${escapeHtml(formatDateTime(gov.formedAt))}</dd><dt>Status</dt><dd>${escapeHtml(gov.status)}</dd>${gov.caretakerDeadline?`<dt>Caretaker deadline</dt><dd>${escapeHtml(formatDateTime(gov.caretakerDeadline))}</dd>`:''}</dl>` : '<p class="muted">No administration is currently in office.</p>'}</div>
    <div class="card"><div class="section-header"><div><h2>Ministers</h2><p class="muted">${ministers.length}/5 appointed</p></div>${pm && ministers.length < 5 && caps.governmentAuthority ? '<button class="btn" data-action="appoint-minister">Appoint</button>' : ''}</div>${ministers.length ? `<ul class="list">${ministers.map(m=>`<li class="list-row"><div><strong>${escapeHtml(m.player?.displayName ?? 'Unknown')}</strong><div class="muted">${escapeHtml(m.portfolio)}</div></div>${caps.governmentAuthority?`<button class="btn btn-danger" data-action="dismiss-minister" data-player-id="${m.playerId}">Dismiss</button>`:''}</li>`).join('')}</ul>` : emptyState('No ministers appointed','The Prime Minister or coalition leadership can appoint up to five ministers.',{icon:'•'})}</div></section>
    ${activePartiesWithSeats.length ? `<section class="section card"><h2>Parliamentary parties</h2><div class="party-seat-chips">${activePartiesWithSeats.sort((a,b)=>(seatCounts[b.id]??0)-(seatCounts[a.id]??0)).map(p=>`<span class="party-seat-chip${gov.coalitionPartyIds?.includes(p.id)?' in-government':''}"><span class="colour-dot" style="--party-colour:${safePartyColour(p.colour)}"></span><strong>${escapeHtml(p.name)}</strong><span>${seatCounts[p.id] ?? 0}</span></span>`).join('')}</div></section>` : ''}`;
}


function lawWorkspaceView(activeCount = 0) {
  const value = readLocalValue(LAW_WORKSPACE_KEY, activeCount ? 'progress' : 'statutes');
  return ['progress','statutes','archive'].includes(value) ? value : (activeCount ? 'progress' : 'statutes');
}

function constitutionSectionEffective(state, sectionNumber) {
  const section = state.constitution?.sections?.[sectionNumber];
  if (!section) return null;
  const override = state.constitution?.sectionOverrides?.[sectionNumber];
  return {
    ...section,
    effectiveTitle: override?.title ?? section.title,
    effectiveText: override?.text ?? section.text,
    override,
    editable: section.category !== 'BASE' || Boolean(state.constitution?.editableOverrides?.[sectionNumber])
  };
}

function committeePurpose(code) {
  return ({
    AC:'Constitutional oversight, election administration review, law constitutionality and constitutional interpretation.',
    PC:'Determines proportionate punishment after an Actions Committee constitutional finding.',
    PAC:"Investigates alleged ordinary-law violations through case panels and decides Guilty or Not Guilty.",
    PPC:"Determines lawful punishment after a PAC Guilty finding has been upheld by the required jury process."
  })[code] ?? 'Constitutional committee.';
}

function committeeMatterStage(matter) {
  if (matter?.decision || ['closed','decided','complete'].includes(String(matter?.status ?? '').toLowerCase())) return 3;
  if (matter?.voteId) return 2;
  if ((matter?.recusedIds ?? matter?.recusedPlayerIds ?? []).length) return 1;
  return 0;
}

function caseRoleFor(record, state, actorId = localActorId(state)) {
  if (!actorId) return 'Observer';
  if (actorId === record.accusedId) return 'Accused';
  if (actorId === record.complainantId) return 'Complainant';
  if (record.pacPanel?.includes(actorId)) return 'PAC panel member';
  if (record.jury?.includes(actorId)) return 'Juror';
  if (committeeMemberLocal(state,'PPC',actorId) && record.status === 'awaiting-ppc') return 'PPC member';
  return 'Observer';
}

function caseActionButtons(record, state, { includeOpenDetails = false } = {}) {
  const actorId = localActorId(state);
  const hostLike = isHostLikeLocal(state,actorId);
  const ppcMember = committeeMemberLocal(state,'PPC',actorId);
  const canRespond = actorId===record.accusedId && !record.accusedResponse;
  const canPacVote = (hostLike || record.pacPanel?.includes(actorId)) && ['pac-review','pac-voting'].includes(record.status) && !record.pacVoteId;
  const canJuryVote = (hostLike || record.jury?.includes(actorId)) && record.status==='jury-ready' && !record.juryVoteId;
  const canPunish = ppcMember && record.status==='awaiting-ppc';
  const buttons = [];
  if (includeOpenDetails) buttons.push(`<button class="btn" data-route="case/${encodeURIComponent(record.id)}">Open details</button>`);
  if (canRespond) buttons.push(`<button class="btn btn-primary" data-action="case-response" data-case-id="${record.id}">Submit My Response</button>`);
  if (record.status==='open'&&hostLike) buttons.push(`<button class="btn" data-action="assign-pac-panel" data-case-id="${record.id}">Assign PAC Panel</button>`);
  if (canPacVote) buttons.push(`<button class="btn btn-primary" data-action="create-pac-vote" data-case-id="${record.id}">Open PAC Vote</button>`);
  if (record.status==='awaiting-jury'&&hostLike) buttons.push(`<button class="btn" data-action="select-jury" data-case-id="${record.id}">Select Jury</button>`);
  if (canJuryVote) buttons.push(`<button class="btn btn-primary" data-action="create-jury-vote" data-case-id="${record.id}">Open Jury Vote</button>`);
  if (canPunish) buttons.push(`<button class="btn btn-primary" data-action="record-ppc-punishment" data-case-id="${record.id}">Record PPC Punishment</button>`);
  if (record.pacVoteId) buttons.push(`<button class="btn" data-route="vote/${encodeURIComponent(record.pacVoteId)}">PAC vote</button>`);
  if (record.juryVoteId) buttons.push(`<button class="btn" data-route="vote/${encodeURIComponent(record.juryVoteId)}">Jury vote</button>`);
  return buttons.join('');
}

function caseNeedsActorAction(record, state) {
  const actorId = localActorId(state);
  if (!actorId) return false;
  const hostLike = isHostLikeLocal(state,actorId);
  return Boolean(
    (actorId===record.accusedId && !record.accusedResponse) ||
    (record.status==='open' && hostLike) ||
    ((hostLike || record.pacPanel?.includes(actorId)) && ['pac-review','pac-voting'].includes(record.status) && !record.pacVoteId) ||
    (record.status==='awaiting-jury' && hostLike) ||
    ((hostLike || record.jury?.includes(actorId)) && record.status==='jury-ready' && !record.juryVoteId) ||
    (committeeMemberLocal(state,'PPC',actorId) && record.status==='awaiting-ppc')
  );
}

function lawProposalCard(proposal, state) {
  const caps = actorCapabilities(state);
  const vote = proposal.legislativeVoteId ? state.votes[proposal.legislativeVoteId] : null;
  const referendum = proposal.referendumVoteId ? state.votes[proposal.referendumVoteId] : null;
  const petitionNeeded = signatureThreshold(state, 0.20);
  const initiativeNeeded = signatureThreshold(state, 0.20);
  const sponsorNeeded = signatureThreshold(state, 0.10);
  const canFinalize = proposal.status === 'discussion' && discussionFinished(proposal);
  const ownsProposal = caps.actorId && proposal.proposerId === caps.actorId;
  const mayFinalize = ownsProposal || caps.hostLike;
  const stage = proposalStageIndex(proposal.status);
  return `<article class="card proposal-card" data-list-item data-search="${escapeHtml(`${proposal.title} ${proposal.id} ${proposal.reason} ${proposal.status}`)}" data-filter-tokens="${escapeHtml([proposal.status,!['enacted','failed','rejected','withdrawn'].includes(proposal.status)?'active':'',proposal.proposerId===caps.actorId?'mine':''].filter(Boolean).join('|'))}" data-sort-title="${escapeHtml(proposal.title.toLowerCase())}" data-sort-date="${Date.parse(proposal.createdAt)||0}" data-sort-relevance="${proposal.proposerId===caps.actorId?2:!['enacted','failed','rejected','withdrawn'].includes(proposal.status)?1:0}">
    <div class="section-header compact-header"><div><span class="pill">${escapeHtml(proposal.id)}</span><h2>${escapeHtml(proposal.title)}</h2><p class="muted">${escapeHtml(proposalStatusLabel(proposal.status))} · ${escapeHtml(proposal.changeKind)}${proposal.pathway === 'citizen-initiative' ? ' · citizens\' initiative' : ''}</p></div><span class="status status-${escapeHtml(proposal.status)}">${escapeHtml(proposalStatusLabel(proposal.status))}</span></div>
    ${processTracker(['Proposal','Discussion','Frozen','Parliament','Referendum','Enacted'],stage,{compact:true})}
    <div class="proposal-overview-grid"><div><span class="meta-label">Sponsor / proposer</span><strong>${escapeHtml(state.players?.[proposal.proposerId]?.displayName ?? proposal.proposerId ?? '—')}</strong></div><div><span class="meta-label">Route</span><strong>${escapeHtml(proposal.pathway === 'citizen-initiative' ? 'Citizens\' initiative' : proposal.sponsorRoute ?? 'Legislative')}</strong></div><div><span class="meta-label">Current stage</span><strong>${escapeHtml(proposalStatusLabel(proposal.status))}</strong></div></div>
    <p><strong>Reason:</strong> ${escapeHtml(proposal.reason)}</p>
    <details class="document-details"><summary>Read proposed wording</summary><div class="proposal-text law-document">${escapeHtml(proposal.text).replaceAll('\n','<br>')}</div></details>
    ${proposal.sponsorRoute === 'petition' && proposal.status === 'petition' ? `<div class="petition-progress"><span>Sponsorship petition</span><strong>${proposal.proposalSignatures?.length ?? 0}/${sponsorNeeded}</strong><div><i style="width:${Math.min(100,(proposal.proposalSignatures?.length??0)/Math.max(1,sponsorNeeded)*100)}%"></i></div></div>` : ''}
    ${proposal.discussionEndsAt && proposal.status === 'discussion' ? `<div class="stage-callout"><strong>${canFinalize?'Discussion complete':'Discussion in progress'}</strong><span>${canFinalize?'The proposal can now be frozen and advanced.':`Ends ${escapeHtml(formatDateTime(proposal.discussionEndsAt))}`}</span></div>` : ''}
    ${proposal.status === 'referendum-window' ? `<div class="petition-progress"><span>Referendum petition</span><strong>${proposal.petitionSignatures.length}/${petitionNeeded}</strong><div><i style="width:${Math.min(100,proposal.petitionSignatures.length/Math.max(1,petitionNeeded)*100)}%"></i></div><small>Window closes ${escapeHtml(formatDateTime(proposal.referendumDeadline))}</small></div>` : ''}
    ${proposal.pathway === 'citizen-initiative' && ['petition','discussion','frozen'].includes(proposal.status) ? `<div class="petition-progress"><span>Initiative signatures</span><strong>${proposal.initiativeSignatures.length}/${initiativeNeeded}</strong><div><i style="width:${Math.min(100,proposal.initiativeSignatures.length/Math.max(1,initiativeNeeded)*100)}%"></i></div></div>` : ''}
    ${vote ? `<div class="linked-process"><span>Parliament vote</span><strong>${escapeHtml(voteStatusLabel(vote.status))}</strong></div>` : ''}
    ${referendum ? `<div class="linked-process"><span>Referendum</span><strong>${escapeHtml(voteStatusLabel(referendum.status))}</strong></div>` : ''}
    <div class="btn-row section role-action-row">
      <button class="btn" data-route="law/${encodeURIComponent(proposal.id)}">Open details</button>
      ${proposal.sponsorRoute === 'petition' && proposal.status === 'petition' ? `<button class="btn btn-primary" data-action="sign-law-proposal" data-proposal-id="${proposal.id}">Sign Sponsorship Petition</button>` : ''}
      ${proposal.status === 'discussion' ? `${ownsProposal?`<button class="btn" data-action="edit-law-proposal" data-proposal-id="${proposal.id}">Edit My Proposal</button>`:''}${mayFinalize ? (canFinalize ? `<button class="btn btn-primary" data-action="finalize-law-proposal" data-proposal-id="${proposal.id}">Freeze & Continue</button>` : unavailableAction('Freeze & Continue',`Discussion remains open until ${formatDateTime(proposal.discussionEndsAt)}.`,{kind:'btn-primary'})) : ''}` : ''}
      ${proposal.pathway === 'citizen-initiative' && proposal.status === 'petition' ? `<button class="btn" data-action="sign-citizen-initiative" data-proposal-id="${proposal.id}">Sign Initiative</button>` : ''}
      ${proposal.status === 'referendum-window' ? `<button class="btn" data-action="sign-law-referendum" data-proposal-id="${proposal.id}">Sign Referendum Petition</button>${caps.hostLike?`<button class="btn" data-action="refer-law" data-proposal-id="${proposal.id}">Refer to Public Vote</button>`:''}${caps.hostLike?(referendumWindowExpired(proposal)?`<button class="btn btn-primary" data-action="check-law-window" data-proposal-id="${proposal.id}">Complete 48h Window</button>`:unavailableAction('Complete 48h Window',`The referendum window remains open until ${formatDateTime(proposal.referendumDeadline)}.`,{kind:'btn-primary'})):''}` : ''}
    </div>
  </article>`;
}

function lawsPage() {
  const state = getState();
  if (!state) return noGamePage();
  const caps = actorCapabilities(state);
  const proposals = Object.values(state.lawProposals ?? {}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const laws = Object.values(state.laws ?? {}).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const activeProposals = proposals.filter(p=>!['enacted','failed','rejected','withdrawn'].includes(p.status));
  const archivedProposals = proposals.filter(p=>['enacted','failed','rejected','withdrawn'].includes(p.status));
  const workspace = lawWorkspaceView(activeProposals.length);
  const tabs = `<div class="workspace-tabs" role="tablist" aria-label="Legislation view">
    <button class="workspace-tab${workspace==='progress'?' active':''}" type="button" role="tab" aria-selected="${workspace==='progress'}" data-action="set-law-workspace" data-law-workspace="progress"><span>In progress</span><b>${activeProposals.length}</b></button>
    <button class="workspace-tab${workspace==='statutes'?' active':''}" type="button" role="tab" aria-selected="${workspace==='statutes'}" data-action="set-law-workspace" data-law-workspace="statutes"><span>Statute book</span><b>${laws.length}</b></button>
    <button class="workspace-tab${workspace==='archive'?' active':''}" type="button" role="tab" aria-selected="${workspace==='archive'}" data-action="set-law-workspace" data-law-workspace="archive"><span>Archive</span><b>${archivedProposals.length}</b></button>
  </div>`;
  const statuteCards = laws.map(law=>`<article class="card law-card statute-card" data-list-item data-search="${escapeHtml(`${law.title} ${law.id} ${law.status} ${law.text}`)}" data-filter-tokens="${escapeHtml(law.status)}" data-sort-title="${escapeHtml(law.title.toLowerCase())}" data-sort-date="${Date.parse(law.enactedAt)||0}"><div class="law-card-head"><div><span class="pill">${escapeHtml(law.id)} · version ${law.version}</span><h3>${escapeHtml(law.title)}</h3></div><span class="status ${law.status==='in-force'?'status-active':''}">${escapeHtml(law.status)}</span></div><p class="law-preview">${escapeHtml(String(law.text??'').replace(/\s+/g,' ').slice(0,220))}${String(law.text??'').length>220?'…':''}</p><div class="law-meta"><span><strong>Enacted</strong>${escapeHtml(formatDateTime(law.enactedAt))}</span><span><strong>History</strong>${law.history?.length ?? 0} event(s)</span></div><div class="btn-row"><button class="btn btn-primary" data-route="law/${encodeURIComponent(law.id)}">Read law</button>${law.status==='in-force' ? `<button class="btn" data-action="amend-law" data-law-id="${law.id}">Amend</button><button class="btn btn-danger" data-action="repeal-law" data-law-id="${law.id}">Repeal</button>` : ''}</div></article>`).join('');
  return `<section class="section-header"><div><span class="page-kicker">Legislation</span><h1>Laws</h1><p class="muted">Follow legislation from proposal through Parliament, referendum and enactment.</p></div><div class="btn-row">${guideButton('laws')}<button class="btn btn-primary" data-action="create-law-proposal">Propose Law</button><button class="btn" data-action="create-citizen-initiative">Citizens' Initiative</button></div></section>
    ${caps.actorId ? `<div class="role-context"><span class="page-kicker">Your legislative role</span><strong>${escapeHtml(caps.roles.join(' · '))}</strong><span>Anyone can propose legislation through an allowed route. Editing stays with the original proposer; administrative progression remains role-restricted.</span></div>` : ''}
    <section class="legislation-overview card"><div><span class="page-kicker">Legislative Pipeline</span><h2>Proposal → Discussion → Parliament → Referendum → Law</h2><p class="muted">The workspace separates live legislation from the authoritative statute book and historical proposals.</p></div>${processTracker(['Proposal','Discussion','Frozen','Parliament','Referendum','Enacted'],0,{compact:true})}</section>
    <div class="grid grid-4">${statCard(laws.filter(l=>l.status==='in-force').length,'Laws In Force')}${statCard(activeProposals.length,'Active Proposals')}${statCard(proposals.filter(p=>p.status==='referendum').length,'Active Referendums')}${statCard(proposals.filter(p=>p.proposerId===caps.actorId).length,'Your Proposals')}</div>
    ${tabs}
    <section class="law-workspace-panel${workspace==='progress'?' active':''}" ${workspace==='progress'?'':'hidden'} data-law-workspace-panel="progress"><div class="section-header"><div><h2>Legislation in progress</h2><p class="muted">Live proposals are ordered around what still needs to happen.</p></div></div>${activeProposals.length?listToolbar('laws',{placeholder:'Search active proposals…',filters:[['mine','My proposals'],['discussion','Discussion'],['petition','Petition'],['referendum-window','Referendum window']],sorts:[['relevant','Most relevant to me'],['newest','Newest'],['oldest','Oldest'],['az','A–Z']]}):''}<div class="grid legislation-grid" data-list-container="laws">${activeProposals.map(p=>lawProposalCard(p,state)).join('') || emptyState('No legislation in progress',"Start with Propose Law or Citizens' Initiative.",{icon:'+'})}</div></section>
    <section class="law-workspace-panel${workspace==='statutes'?' active':''}" ${workspace==='statutes'?'':'hidden'} data-law-workspace-panel="statutes"><div class="section-header"><div><h2>Statute book</h2><p class="muted">The currently enacted laws, presented as readable documents rather than proposal history.</p></div></div>${laws.length?listToolbar('statutes',{placeholder:'Search the statute book…',filters:[['in-force','In force']],sorts:[['az','A–Z'],['newest','Newest enacted'],['oldest','Oldest enacted']]}):''}<div class="grid statute-grid" data-list-container="statutes">${statuteCards || emptyState('No enacted laws yet','Successful legislation will appear here as the current statute book.',{icon:'§'})}</div></section>
    <section class="law-workspace-panel${workspace==='archive'?' active':''}" ${workspace==='archive'?'':'hidden'} data-law-workspace-panel="archive"><div class="section-header"><div><h2>Proposal archive</h2><p class="muted">Enacted, failed, rejected and withdrawn proposals remain part of the official legislative record.</p></div></div><div class="grid legislation-grid">${archivedProposals.map(p=>lawProposalCard(p,state)).join('') || emptyState('No archived proposals','Completed and unsuccessful proposals will be retained here.',{icon:'↺'})}</div></section>`;
}

function amendmentCard(proposal, state) {
  const caps = actorCapabilities(state);
  const vote = proposal.voteId ? state.votes[proposal.voteId] : null;
  const ready = proposal.status === 'discussion' && discussionFinished(proposal);
  const sponsorNeeded = signatureThreshold(state, 0.10);
  const ownsProposal = caps.actorId && proposal.proposerId === caps.actorId;
  const mayFinalize = ownsProposal || caps.hostLike;
  return `<article class="card proposal-card constitution-proposal"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(proposal.id)} · ${escapeHtml(proposal.category)}</span><h2>Section ${escapeHtml(proposal.section)}${proposal.sectionTitle ? ` — ${escapeHtml(proposal.sectionTitle)}` : ''}</h2><p class="muted">${escapeHtml(amendmentStatusLabel(proposal.status))}</p></div><span class="status status-${escapeHtml(proposal.status)}">${escapeHtml(amendmentStatusLabel(proposal.status))}</span></div>
    ${processTracker(['Proposal','Discussion','Frozen','Public vote','Applied'],amendmentStageIndex(proposal.status),{compact:true})}
    <div class="constitutional-diff"><div class="diff-pane before"><span class="diff-label">Current wording</span><div class="proposal-text">${escapeHtml(proposal.currentText).replaceAll('\n','<br>')}</div></div><div class="diff-arrow" aria-hidden="true">→</div><div class="diff-pane after"><span class="diff-label">Proposed wording</span><div class="proposal-text">${escapeHtml(proposal.proposedText).replaceAll('\n','<br>')}</div></div></div>
    <p><strong>Reason:</strong> ${escapeHtml(proposal.reason)}</p>
    ${proposal.sponsorRoute==='petition' && proposal.status==='petition' ? `<div class="petition-progress"><span>Sponsorship petition</span><strong>${proposal.proposalSignatures?.length ?? 0}/${sponsorNeeded}</strong><div><i style="width:${Math.min(100,(proposal.proposalSignatures?.length??0)/Math.max(1,sponsorNeeded)*100)}%"></i></div></div><div class="btn-row"><button class="btn btn-primary" data-action="sign-amendment-petition" data-proposal-id="${proposal.id}">Sign Petition</button></div>` : ''}
    ${proposal.status==='discussion' ? `<div class="stage-callout"><strong>${ready?'Discussion complete':'Discussion in progress'}</strong><span>${ready?'The wording can now be frozen and sent to a public amendment vote.':`Ends ${escapeHtml(formatDateTime(proposal.discussionEndsAt))}`}</span></div><div class="btn-row">${ownsProposal?`<button class="btn" data-action="edit-amendment" data-proposal-id="${proposal.id}">Edit My Amendment</button>`:''}${mayFinalize?(ready?`<button class="btn btn-primary" data-action="finalize-amendment" data-proposal-id="${proposal.id}">Freeze & Open Amendment Vote</button>`:unavailableAction('Freeze & Open Amendment Vote',`Discussion remains open until ${formatDateTime(proposal.discussionEndsAt)}.`,{kind:'btn-primary'})):''}</div>` : ''}
    ${vote ? `<div class="linked-process"><span>Public amendment vote</span><strong>${escapeHtml(voteStatusLabel(vote.status))}</strong></div>` : ''}
    <div class="btn-row section"><button class="btn" data-route="amendment/${encodeURIComponent(proposal.id)}">Open details</button></div>
  </article>`;
}

function constitutionPage() {
  const state = getState();
  if (!state) return noGamePage();
  const caps = actorCapabilities(state);
  const proposals = Object.values(state.constitution.proposals ?? {}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const unlocks = Object.values(state.constitution.unlockProposals ?? {}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const amendments = [...(state.constitution.amendments ?? [])].reverse();
  const editableOverrides = state.constitution.editableOverrides ?? {};
  const activeCount = Object.values(state.players).filter(p=>p.status==='active').length;
  const unlockNeeded = Math.max(1, Math.ceil(activeCount * .25));
  const sections = Object.values(state.constitution.sections ?? {}).sort((a,b)=>Number(a.number)-Number(b.number));
  const savedSearch = readLocalValue(CONSTITUTION_SEARCH_KEY,'');
  const sectionCards = sections.map(sec=>{
    const effective = constitutionSectionEffective(state,sec.number);
    const related = amendments.filter(a=>String(a.section)===String(sec.number));
    return `<article class="constitution-section-card" id="constitution-section-${escapeHtml(sec.number)}" data-constitution-section data-search="${escapeHtml(`${sec.number} ${effective.effectiveTitle} ${effective.effectiveText} ${sec.category}`.toLowerCase())}"><div class="section-number">§${escapeHtml(sec.number)}</div><div class="constitution-section-body"><div class="section-meta"><span class="pill">${escapeHtml(sec.category)}</span>${effective.override?'<span class="pill">Amended</span>':''}${effective.editable?'<span class="pill">Editable</span>':'<span class="pill">Protected</span>'}${related.length?`<span class="pill">${related.length} amendment${related.length===1?'':'s'}</span>`:''}</div><h3>${escapeHtml(effective.effectiveTitle)}</h3><p class="constitution-preview">${escapeHtml(effective.effectiveText)}</p><div class="btn-row"><button class="btn btn-primary" data-route="constitution-section/${encodeURIComponent(sec.number)}">Open section</button><details class="inline-details"><summary>Quick read</summary><div class="proposal-text">${escapeHtml(effective.effectiveText).replaceAll('\n','<br>')}</div></details></div></div></article>`;
  }).join('');
  const toc = sections.map(sec=>{ const effective=constitutionSectionEffective(state,sec.number); return `<button class="constitution-toc-link" type="button" data-route="constitution-section/${encodeURIComponent(sec.number)}" data-constitution-toc data-search="${escapeHtml(`${sec.number} ${effective.effectiveTitle} ${sec.category}`.toLowerCase())}"><span>§${escapeHtml(sec.number)}</span><strong>${escapeHtml(effective.effectiveTitle)}</strong><small>${escapeHtml(sec.category)}</small></button>`; }).join('');
  const propose = '<button class="btn btn-primary" data-action="create-amendment">Propose Amendment</button>';
  const baseUnlock = '<button class="btn" data-action="create-base-unlock">Base Rule Unlock</button>';
  return `<section class="section-header"><div><span class="page-kicker">Authoritative text</span><h1>Constitution</h1><p class="muted">Current constitutional text, protected provisions and amendment history · version ${state.constitution.version ?? 1}</p></div><div class="btn-row">${guideButton('constitution')}${propose}${baseUnlock}<button class="btn" data-route="rulebook">Full Rulebook</button></div></section>
    ${caps.actorId ? `<div class="role-context"><span class="page-kicker">Your constitutional role</span><strong>${escapeHtml(caps.roles.join(' · '))}</strong><span>Any active player may propose an amendment through a valid route. Host and committee powers appear only when your current role permits them.</span></div>` : ''}
    <div class="grid grid-4">${statCard(state.constitution.version ?? 1,'Constitution Version')}${statCard(amendments.length,'Applied Amendments')}${statCard(Object.keys(editableOverrides).length,'Base Rules Unlocked')}${statCard(proposals.filter(p=>['discussion','voting'].includes(p.status)).length,'Active Amendments')}</div>
    <section class="section constitution-workspace"><aside class="constitution-toc card"><div class="constitution-toc-head"><span class="page-kicker">Contents</span><h2>Constitution</h2><label class="constitution-search"><span class="sr-only">Search constitutional sections</span><input type="search" placeholder="Search sections…" value="${escapeHtml(savedSearch)}" data-constitution-search></label><div class="constitution-search-count" data-constitution-search-count>${sections.length} sections</div></div><div class="constitution-toc-list">${toc}</div></aside><div class="constitution-reading"><div class="section-header"><div><h2>Current Constitution</h2><p class="muted">Search by section number, title, category or wording. Each section has a stable deep link.</p></div></div><div class="constitution-browser" data-constitution-browser>${sectionCards || emptyState('No constitutional sections','This save does not currently contain structured constitutional sections.',{icon:'§'})}</div><div class="empty filtered-empty" data-constitution-empty hidden><strong>No matching sections</strong><p>Try a broader term or clear the search.</p><button class="btn" type="button" data-action="clear-constitution-search">Clear search</button></div></div></section>
    <section class="section"><div class="section-header"><div><h2>Protected Base Rule Unlocks</h2><p class="muted">Base provisions must be unlocked through their protected procedure before ordinary amendment.</p></div></div><div class="grid">${unlocks.map(u=>{const vote=u.voteId?state.votes[u.voteId]:null;const canAc=Boolean(caps.actorId && state.committees?.AC && [...(state.committees.AC.members||[]),...(state.committees.AC.alternates||[])].includes(caps.actorId));return `<article class="card"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(u.id)} · BASE</span><h3>Section ${escapeHtml(u.section)}${u.sectionTitle?` — ${escapeHtml(u.sectionTitle)}`:''}</h3><p class="muted">${escapeHtml(u.status)} · initiated by ${escapeHtml(u.initiatedBy)}</p></div></div>${processTracker(['Initiated','AC review','Public vote','Editable'],u.status==='awaiting-ac'?1:u.status==='voting'?2:['passed','editable'].includes(u.status)?3:0,{compact:true})}<p>${escapeHtml(u.reason)}</p>${u.initiatedBy==='petition'?`<div class="petition-progress"><span>Public petition</span><strong>${u.signatures.length}/${unlockNeeded}</strong><div><i style="width:${Math.min(100,u.signatures.length/Math.max(1,unlockNeeded)*100)}%"></i></div></div>`:''}${vote?`<div class="linked-process"><span>Public unlock vote</span><strong>${escapeHtml(voteStatusLabel(vote.status))} · 75% approval + 50% turnout</strong></div>`:''}<div class="btn-row">${u.status==='petition'?`<button class="btn" data-action="sign-base-unlock" data-proposal-id="${u.id}">Sign Petition</button>`:''}${u.status==='awaiting-ac'?(canAc?`<button class="btn btn-primary" data-action="create-base-unlock-ac-vote" data-proposal-id="${u.id}">Open AC 2/3 Vote</button>`:unavailableAction('Open AC 2/3 Vote','Only an AC member can begin this committee decision.')):''}</div></article>`}).join('') || emptyState('No Base-rule unlocks','Protected-rule unlock proposals will appear here.',{icon:'🔒'})}</div></section>
    <section class="section"><div class="section-header"><div><h2>Amendment Pipeline</h2><p class="muted">Compare current and proposed wording side by side and follow each amendment through its public process.</p></div></div><div class="grid">${proposals.map(p=>amendmentCard(p,state)).join('') || emptyState('No constitutional amendments','Use Propose Amendment when a constitutional change is needed.',{icon:'+'})}</div></section>
    <section class="section card constitutional-changelog"><div class="section-header compact-header"><div><h2>Constitutional Changelog</h2><p class="muted">Every applied amendment remains part of the historical record and links back to the affected section.</p></div></div>${amendments.length ? `<div class="amendment-history-list">${amendments.map(a=>`<article><span class="amendment-number">#${a.number}</span><div><strong>${escapeHtml(a.id)}</strong><span>Section ${escapeHtml(a.section)} · effective ${escapeHtml(formatDateTime(a.effectiveAt))}</span></div><button class="btn btn-quiet" data-route="constitution-section/${encodeURIComponent(a.section)}">Open section</button></article>`).join('')}</div>` : emptyState('No amendments applied yet','When an amendment passes and takes effect, it will be recorded here.',{icon:'↺'})}</section>`;
}


function committeesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const actorId = localActorId(state);
  const committees = Object.values(state.committees ?? {}).sort((a,b)=>{
    const am=committeeMemberLocal(state,a.code,actorId)?1:0, bm=committeeMemberLocal(state,b.code,actorId)?1:0;
    return bm-am || String(a.code).localeCompare(String(b.code));
  });
  const openMatterCount = committees.reduce((sum,c)=>sum+(c.matters??[]).filter(m=>m.status==='open').length,0);
  const actorCommittees = committees.filter(c=>committeeMemberLocal(state,c.code,actorId)).map(c=>c.code);
  const cards = committees.map(c => {
    const memberPlayers = (c.members ?? []).map(id => state.players[id]).filter(Boolean);
    const alternatePlayers = (c.alternates ?? []).map(id => state.players[id]).filter(Boolean);
    const chair = c.chairId ? state.players[c.chairId] : null;
    const matters = [...(c.matters ?? [])].sort((a,b)=>(a.status==='open'?0:1)-(b.status==='open'?0:1));
    const isMember = committeeMemberLocal(state, c.code, actorId);
    const memberChips = memberPlayers.map(p=>`<button class="person-chip${p.id===actorId?' is-you':''}" data-route="player/${encodeURIComponent(p.id)}"><strong>${escapeHtml(p.displayName)}</strong>${p.id===c.chairId?'<small>Chair</small>':''}${p.id===actorId?'<small>You</small>':''}</button>`).join('');
    const altChips = alternatePlayers.map(p=>`<button class="person-chip alternate${p.id===actorId?' is-you':''}" data-route="player/${encodeURIComponent(p.id)}"><strong>${escapeHtml(p.displayName)}</strong><small>Alternate${p.id===actorId?' · You':''}</small></button>`).join('');
    const matterCards = matters.map(m=>{
      const recused = (m.recusedIds ?? m.recusedPlayerIds ?? []).map(id=>state.players[id]).filter(Boolean);
      const vote = m.voteId ? state.votes?.[m.voteId] : null;
      return `<article class="committee-matter${m.status==='open'?' is-open':''}"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(m.status ?? 'open')}</span><h4>${escapeHtml(m.title)}</h4><p class="muted">${escapeHtml(m.description || 'No description recorded.')}</p></div>${m.decision?`<span class="status status-active">${escapeHtml(m.decision)}</span>`:''}</div>${processTracker(['Opened','Recusals','Vote','Decision'],committeeMatterStage(m),{compact:true})}${recused.length?`<div class="recusal-strip"><strong>Recused</strong>${recused.map(p=>`<button class="pill pill-button" data-route="player/${encodeURIComponent(p.id)}">${escapeHtml(p.displayName)}</button>`).join('')}</div>`:''}${vote?`<div class="linked-process"><span>Formal committee vote</span><strong>${escapeHtml(voteStatusLabel(vote.status))}</strong></div>`:''}<div class="btn-row">${m.status==='open' && isMember?`<button class="btn" data-action="recuse-committee-member" data-committee="${c.code}" data-matter-id="${m.id}">Record Recusal</button><button class="btn btn-primary" data-action="create-committee-vote" data-committee="${c.code}" data-matter-id="${m.id}">Open Vote</button>`:m.status==='open'?unavailableAction('Committee actions','Only a member or alternate of this committee can act on this matter.'):''}${m.voteId?`<button class="btn" data-route="vote/${encodeURIComponent(m.voteId)}">View Vote</button>`:''}</div></article>`;
    }).join('');
    return `<article class="card committee-card${isMember?' is-yours':''}"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(c.code)}</span><h2>${escapeHtml(committeeLongName(c.code))}</h2><p class="committee-purpose">${escapeHtml(committeePurpose(c.code))}</p></div>${isMember?'<span class="status status-active">Your committee</span>':''}</div><div class="committee-summary"><div><span class="meta-label">Chair</span><strong>${escapeHtml(chair?.displayName ?? 'Not elected')}</strong></div><div><span class="meta-label">Members</span><strong>${memberPlayers.length}</strong></div><div><span class="meta-label">Alternates</span><strong>${alternatePlayers.length}</strong></div><div><span class="meta-label">Open matters</span><strong>${matters.filter(m=>m.status==='open').length}</strong></div></div><div class="people-section"><span class="meta-label">Seated members</span><div class="person-chip-row">${memberChips || '<span class="muted">Not seated</span>'}</div></div>${alternatePlayers.length?`<div class="people-section"><span class="meta-label">Alternates</span><div class="person-chip-row">${altChips}</div></div>`:''}<div class="btn-row section"><button class="btn btn-primary" data-route="committee/${encodeURIComponent(c.code)}">Open committee</button>${isMember?`<button class="btn" data-action="set-committee-chair" data-committee="${c.code}">Set Chair</button><button class="btn" data-action="create-committee-matter" data-committee="${c.code}">New Matter</button>`:unavailableAction('New Matter','Only a member or alternate of this committee may create committee actions.')}</div><div class="committee-matters"><div class="section-header compact-header"><div><h3>${matters.some(m=>m.status==='open')?'Active matters':'Matters'}</h3><p class="muted">Open work appears first; recusals and formal decisions stay attached to the matter.</p></div></div>${matterCards || emptyState('No committee matters','When this committee opens a formal matter it will appear here.',{icon:'◇'})}</div></article>`;
  }).join('');
  const yourWork = actorCommittees.length ? `<section class="section your-committee-strip"><div><span class="page-kicker">Your committee work</span><h2>${actorCommittees.map(escapeHtml).join(' · ')}</h2><p class="muted">You are seated on ${actorCommittees.length} committee${actorCommittees.length===1?'':'s'}. Open matters requiring formal decisions are shown first inside those committees.</p></div><div class="your-committee-count"><strong>${openMatterCount}</strong><span>open matter${openMatterCount===1?'':'s'} across all committees</span></div></section>` : '';
  return `<section class="section-header"><div><span class="page-kicker">Constitutional institutions</span><h1>Committees</h1><p class="muted">AC, PC, PAC and PPC membership, constitutional roles, recusals and formal decisions.</p></div>${guideButton('committees')}</section>${actorId?`<div class="role-context"><span class="page-kicker">Your committee role</span><strong>${escapeHtml(actorCommittees.length?actorCommittees.join(' · '):'Not currently seated')}</strong><span>${actorCommittees.length?'Committee actions are shown only on committees where your verified player is a member or alternate.':'You can follow committee work, but formal committee actions are reserved for seated members and alternates.'}</span></div>`:''}${yourWork}<div class="grid committee-grid">${cards || emptyState('No committees configured','Committee seats will appear after committee elections are certified.',{route:'elections',actionLabel:'Open Elections',icon:'◇'})}</div>`;
}

function casesPage() {
  const state = getState();
  if (!state) return noGamePage();
  const actorId = localActorId(state);
  const cases = Object.values(state.cases ?? {}).sort((a,b)=>new Date(b.openedAt)-new Date(a.openedAt));
  const active = cases.filter(c=>c.status!=='closed');
  const actionCases = cases.filter(c=>caseNeedsActorAction(c,state));
  const cards = cases.map(c=>{
    const accused=state.players[c.accusedId];
    const complainant=state.players[c.complainantId];
    const law=state.laws[c.lawId];
    const stage=caseStage(c);
    const role=caseRoleFor(c,state,actorId);
    const involved=role!=='Observer';
    const needAction=caseNeedsActorAction(c,state);
    return `<article class="card case-card${involved?' is-involved':''}${needAction?' needs-action':''}" data-list-item data-search="${escapeHtml(`${c.id} ${accused?.displayName||''} ${complainant?.displayName||''} ${law?.title||''} ${c.status}`)}" data-filter-tokens="${escapeHtml([c.status,c.status==='closed'?'closed':'active',involved?'mine':'',needAction?'needs-action':''].filter(Boolean).join('|'))}" data-sort-title="${escapeHtml(c.id.toLowerCase())}" data-sort-date="${Date.parse(c.openedAt)||0}" data-sort-relevance="${needAction?3:involved?2:c.status!=='closed'?1:0}"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(c.id)}</span><h2>${escapeHtml(accused?.displayName ?? c.accusedId)} · ${escapeHtml(law?.title ?? c.lawId)}</h2><p class="muted">Opened ${escapeHtml(formatDateTime(c.openedAt))}${complainant?` · complainant ${escapeHtml(complainant.displayName)}`:''}</p></div><span class="status ${c.status==='closed'?'status-active':'status-open'}">${escapeHtml(caseStageLabel(c))}</span></div>${processTracker(['Complaint','Response','PAC','Jury','PPC','Closed'],stage,{compact:true})}${involved?`<div class="personal-case-state"><strong>${needAction?'Your action is needed':`Your role: ${escapeHtml(role)}`}</strong><span>${role==='Accused'?'You are the accused.':role==='Complainant'?'You are the complainant.':role==='PAC panel member'?'You are on the PAC panel.':role==='Juror'?'You are a juror.':role==='PPC member'?'You are serving on the PPC for the punishment stage.':'You have a formal role.'}</span></div>`:''}<div class="case-summary-grid"><div><span class="meta-label">Accused</span><strong>${escapeHtml(accused?.displayName??c.accusedId)}</strong></div><div><span class="meta-label">Law</span><strong>${escapeHtml(law?.title??c.lawId)}</strong></div><div><span class="meta-label">Current stage</span><strong>${escapeHtml(caseStageLabel(c))}</strong></div></div><div class="case-allegation-preview"><span class="meta-label">Allegation</span><p>${escapeHtml(String(c.conduct??'').slice(0,260))}${String(c.conduct??'').length>260?'…':''}</p></div>${c.status==='closed'?`<div class="case-outcome-strip"><strong>Case closed</strong><span>${escapeHtml(c.ppcPunishment?.text || c.juryResult || c.pacFinding || 'Final outcome recorded')}</span></div>`:''}<div class="btn-row section">${caseActionButtons(c,state,{includeOpenDetails:true})}</div></article>`;
  }).join('');
  const actionStrip = actionCases.length ? `<section class="section case-action-queue"><div class="section-header compact-header"><div><span class="page-kicker">Needs you</span><h2>Your case actions</h2><p class="muted">These cases currently have a procedural action available to your verified player.</p></div><span class="badge">${actionCases.length}</span></div><div class="case-action-list">${actionCases.map(c=>{const accused=state.players?.[c.accusedId];const law=state.laws?.[c.lawId];return `<article><div><strong>${escapeHtml(c.id)} · ${escapeHtml(accused?.displayName??c.accusedId)}</strong><span>${escapeHtml(law?.title??c.lawId)} · ${escapeHtml(caseStageLabel(c))}</span></div><div class="btn-row">${caseActionButtons(c,state,{includeOpenDetails:true})}</div></article>`}).join('')}</div></section>` : '';
  return `<section class="section-header"><div><span class="page-kicker">Ordinary-law procedure</span><h1>Cases</h1><p class="muted">Follow each case from allegation through PAC investigation, mandatory jury review of Guilty findings, and any PPC punishment.</p></div><div class="btn-row">${guideButton('cases')}<button class="btn btn-primary" data-action="open-case">Open Case</button></div></section>${actionStrip}<div class="grid grid-4">${statCard(active.length,'Active Cases')}${statCard(cases.filter(c=>c.pacFinding).length,'PAC Findings')}${statCard(cases.filter(c=>c.juryResult).length,'Jury Results')}${statCard(cases.filter(c=>c.status==='closed').length,'Closed')}</div><section class="section">${cases.length?listToolbar('cases',{placeholder:'Search cases, players or laws…',filters:[['needs-action','Needs my action'],['mine','Involving me'],['active','Open / active'],['awaiting-jury','Awaiting jury'],['closed','Closed']],sorts:[['relevant','Most relevant to me'],['newest','Newest'],['oldest','Oldest'],['az','Case ID']]}):''}<div class="grid case-grid" data-list-container="cases">${cards || emptyState('No cases have been opened','Complaints and their complete procedural history will appear here.',{icon:'⚖'})}</div></section>`;
}



function detailNotFound(parentRoute, type, id) {
  return `${breadcrumbHtml([{label:parentRoute[0].toUpperCase()+parentRoute.slice(1),route:parentRoute},{label:id}])}<section class="detail-hero"><span class="page-kicker">${escapeHtml(type)}</span><h1>Not found</h1><p class="muted">No ${escapeHtml(type.toLowerCase())} with ID ${escapeHtml(id)} exists in the current verified state.</p><div class="btn-row"><button class="btn btn-primary" data-route="${escapeHtml(parentRoute)}">Back to ${escapeHtml(parentRoute)}</button></div></section>`;
}

function voteDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage();
  const vote=state.votes?.[id]; if(!vote) return detailNotFound('votes','Vote',id);
  const parent=vote.electionKind?'elections':'votes';
  const [nextTitle,nextText]=nextStepForVote(vote,state);
  const caps=actorCapabilities(state);
  const eligible=Boolean(caps.actorId && vote.electorateSnapshot?.includes(caps.actorId));
  const submitted=vote.secretBallotMode==='sealed-v1'?Boolean(vote.submittedVoters?.[caps.actorId]):Boolean(vote.ballots?.[caps.actorId]);
  const related=[vote.settings?.lawProposalId,vote.settings?.amendmentProposalId,vote.settings?.caseId].filter(Boolean);
  return `${breadcrumbHtml([{label:parent==='elections'?'Elections':'Votes',route:parent},{label:vote.title}])}
    <section class="detail-hero"><div><span class="page-kicker">${escapeHtml(vote.electionKind?electionKindLabel(vote.electionKind,vote.committee):vote.type)} · ${escapeHtml(vote.id)}</span><h1>${escapeHtml(vote.title)}</h1><p class="muted">${vote.secret?'Secret ballot':'Public ballot'} · ${vote.electorateSnapshot?.length??0} eligible voter${(vote.electorateSnapshot?.length??0)===1?'':'s'}</p></div><div class="detail-hero-actions"><button class="btn" data-action="share-vote" data-vote-id="${escapeHtml(vote.id)}">Share</button><button class="btn" data-route="${parent}">Back to ${parent==='elections'?'Elections':'Votes'}</button></div></section>
    ${statusInfoHtml('vote',vote.status)}
    ${caps.actorId?`<section class="personal-state-strip"><span class="page-kicker">Your status</span><strong>${eligible?(submitted?'Ballot submitted':'Eligible to vote'):'Not in this electorate'}</strong><span>${eligible?(submitted?'Your latest valid ballot is recorded for this vote.':'No ballot is currently recorded from you.'):'Eligibility was fixed when this electorate snapshot was created.'}</span></section>`:''}
    ${nextStepPanel(nextTitle,nextText)}
    <section class="detail-grid"><article class="card"><h2>Procedure</h2>${processTracker(['Draft','Open','Counted','Certified'],Math.max(0,['draft','open','closed','certified'].indexOf(vote.status)),{compact:false})}<dl class="kv"><dt>Created</dt><dd>${escapeHtml(formatDateTime(vote.createdAt))}</dd><dt>Opens</dt><dd>${escapeHtml(formatDateTime(vote.opensAt))}</dd><dt>Closes</dt><dd>${escapeHtml(formatDateTime(vote.closesAt))}</dd><dt>Electorate</dt><dd>${vote.electorateSnapshot?.length??0}</dd></dl></article><article class="card"><h2>Ballot</h2><p>${escapeHtml(vote.secret?'Individual choices are private.':'Individual choices may be visible in the official record.')}</p><div class="option-list">${(vote.options??[]).map(o=>`<div class="list-row"><span>${escapeHtml(o.label)}</span><code>${escapeHtml(o.id)}</code></div>`).join('')}</div></article></section>
    ${['closed','certified'].includes(vote.status)?`<section class="card section"><h2>Result</h2>${voteResultHtml(vote)}</section>`:''}
    ${related.length?`<section class="card section"><h2>Related records</h2><div class="meta-row">${related.map(x=>`<code>${escapeHtml(x)}</code>`).join('')}</div></section>`:''}
    <section class="card section"><div class="section-header compact-header"><div><h2>Official history</h2><p class="muted">Events that reference ${escapeHtml(vote.id)}.</p></div></div>${objectHistoryHtml(state,vote.id)}</section>`;
}

function lawDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage();
  const proposal=state.lawProposals?.[id]; const law=state.laws?.[id];
  if(!proposal && !law) return detailNotFound('laws','Law or proposal',id);
  if(proposal){
    const [nextTitle,nextText]=nextStepForLaw(proposal,state);
    const proposer=state.players?.[proposal.proposerId];
    const caps=actorCapabilities(state);
    const owns=Boolean(caps.actorId && proposal.proposerId===caps.actorId);
    const vote=proposal.legislativeVoteId?state.votes?.[proposal.legislativeVoteId]:null;
    const referendum=proposal.referendumVoteId?state.votes?.[proposal.referendumVoteId]:null;
    return `${breadcrumbHtml([{label:'Laws',route:'laws'},{label:proposal.title}])}<section class="detail-hero law-detail-hero"><div><span class="page-kicker">Proposal ${escapeHtml(proposal.id)}</span><h1>${escapeHtml(proposal.title)}</h1><p class="muted">Proposed by ${escapeHtml(proposer?.displayName??proposal.proposerId??'Unknown')} · ${escapeHtml(proposalStatusLabel(proposal.status))}</p></div><div class="detail-hero-actions"><button class="btn" data-action="copy-current-link">Copy link</button><button class="btn" data-route="laws">Back to Laws</button></div></section>${statusInfoHtml('law',proposal.status)}${nextStepPanel(nextTitle,nextText)}<section class="legislation-detail-layout"><article class="card law-document-panel"><div class="document-heading"><span class="page-kicker">Proposed text</span><h2>${escapeHtml(proposal.title)}</h2><span>${escapeHtml(proposal.id)}</span></div><div class="proposal-text law-document law-document-full">${escapeHtml(proposal.text??'').replaceAll('\n','<br>')}</div></article><aside class="card procedure-aside"><h2>Procedure</h2>${processTracker(['Proposal','Discussion','Frozen','Parliament','Referendum','Enacted'],proposalStageIndex(proposal.status),{compact:false})}<dl class="kv"><dt>Reason</dt><dd>${escapeHtml(proposal.reason??'—')}</dd><dt>Route</dt><dd>${escapeHtml(proposal.pathway==='citizen-initiative'?"Citizens' initiative":proposal.sponsorRoute??'Legislative')}</dd><dt>Created</dt><dd>${escapeHtml(formatDateTime(proposal.createdAt))}</dd><dt>Proposer</dt><dd>${escapeHtml(proposer?.displayName??proposal.proposerId??'Unknown')}</dd></dl>${owns?'<span class="pill">Your proposal</span>':''}</aside></section>${vote||referendum?`<section class="section"><div class="section-header compact-header"><div><h2>Linked political stages</h2><p class="muted">Votes created by this proposal stay connected to the legislative record.</p></div></div><div class="linked-stage-grid">${vote?`<button class="linked-stage-card" data-route="vote/${encodeURIComponent(vote.id)}"><span>Parliamentary vote</span><strong>${escapeHtml(voteStatusLabel(vote.status))}</strong><small>${escapeHtml(vote.title)}</small></button>`:''}${referendum?`<button class="linked-stage-card" data-route="vote/${encodeURIComponent(referendum.id)}"><span>Referendum</span><strong>${escapeHtml(voteStatusLabel(referendum.status))}</strong><small>${escapeHtml(referendum.title)}</small></button>`:''}</div></section>`:''}<section class="card section"><div class="section-header compact-header"><div><h2>Official history</h2><p class="muted">Every recorded state change involving this proposal.</p></div></div>${objectHistoryHtml(state,proposal.id)}</section>`;
  }
  const proposalRecord=Object.values(state.lawProposals??{}).find(p=>p.enactedLawId===law.id || p.resultLawId===law.id || (p.status==='enacted' && p.title===law.title));
  return `${breadcrumbHtml([{label:'Laws',route:'laws'},{label:law.title}])}<section class="detail-hero law-detail-hero"><div><span class="page-kicker">${escapeHtml(law.id)} · Version ${escapeHtml(law.version)}</span><h1>${escapeHtml(law.title)}</h1><p class="muted">${law.status==='in-force'?'Law in force':escapeHtml(law.status)} · enacted ${escapeHtml(formatDateTime(law.enactedAt))}</p></div><div class="detail-hero-actions"><button class="btn" data-action="copy-current-link">Copy link</button>${law.status==='in-force'?`<button class="btn" data-action="amend-law" data-law-id="${law.id}">Propose Amendment</button><button class="btn btn-danger" data-action="repeal-law" data-law-id="${law.id}">Propose Repeal</button>`:''}<button class="btn" data-route="laws">Back to Laws</button></div></section><section class="status-explainer status-explainer-active"><span class="status status-active">Law in force</span><span>This is the authoritative current wording stored in the statute book.</span></section><section class="legislation-detail-layout"><article class="card law-document-panel"><div class="document-heading"><span class="page-kicker">Current enacted wording</span><h2>${escapeHtml(law.title)}</h2><span>Version ${escapeHtml(law.version)}</span></div><div class="proposal-text law-document law-document-full">${escapeHtml(law.text??'').replaceAll('\n','<br>')}</div></article><aside class="card procedure-aside"><h2>Law details</h2><dl class="kv"><dt>Enacted</dt><dd>${escapeHtml(formatDateTime(law.enactedAt))}</dd><dt>Version</dt><dd>${escapeHtml(law.version)}</dd><dt>Status</dt><dd>${escapeHtml(law.status)}</dd><dt>Recorded versions</dt><dd>${law.history?.length ?? 0}</dd></dl><h3>What happens next?</h3><p>An in-force law remains authoritative beneath the Constitution until it is validly amended, repealed or found unconstitutional through the constitutional challenge procedure.</p>${proposalRecord?`<button class="btn" data-route="law/${encodeURIComponent(proposalRecord.id)}">View originating proposal</button>`:''}</aside></section>${law.history?.length?`<section class="card section"><h2>Version history</h2><div class="version-history">${law.history.map((item,index)=>`<article><span>v${escapeHtml(item.version??index+1)}</span><div><strong>${escapeHtml(item.title??law.title)}</strong><small>${escapeHtml(formatDateTime(item.enactedAt??item.at??law.enactedAt))}</small></div></article>`).join('')}</div></section>`:''}<section class="card section"><h2>Official history</h2>${objectHistoryHtml(state,law.id)}</section>`;
}

function amendmentDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage();
  const p=state.constitution?.proposals?.[id]; if(!p) return detailNotFound('constitution','Constitutional amendment',id);
  const info=statusInfo('amendment',p.status);
  let next=['Follow the amendment procedure','The amendment must follow the Constitution’s discussion, wording-freeze and public-vote requirements.'];
  if(p.status==='discussion') next=discussionFinished(p,getCloudNowMs())?['Freeze the final wording','The required discussion period has ended. An authorised player may freeze the wording and open the public amendment vote.']:['Discussion continues',`The constitutional discussion period ends ${formatDateTime(p.discussionEndsAt)}.`];
  if(p.status==='voting') next=['Public vote in progress','The amendment requires at least 66% approval of valid votes cast and at least 25% turnout.'];
  if(['passed','applied'].includes(p.status)) next=['Amendment approved','Once effective, the new wording is part of this save’s authoritative Constitution.'];
  return `${breadcrumbHtml([{label:'Constitution',route:'constitution'},{label:p.id}])}<section class="detail-hero"><div><span class="page-kicker">${escapeHtml(p.id)} · Section ${escapeHtml(p.section)}</span><h1>${escapeHtml(p.sectionTitle||`Amendment to Section ${p.section}`)}</h1><p class="muted">${escapeHtml(info.label)}</p></div><button class="btn" data-route="constitution">Back to Constitution</button></section>${statusInfoHtml('amendment',p.status)}${nextStepPanel(...next)}<section class="card section"><h2>Wording comparison</h2><div class="constitutional-diff"><div class="diff-pane before"><span class="diff-label">Current wording</span><div class="proposal-text">${escapeHtml(p.currentText??'').replaceAll('\n','<br>')}</div></div><div class="diff-arrow">→</div><div class="diff-pane after"><span class="diff-label">Proposed wording</span><div class="proposal-text">${escapeHtml(p.proposedText??'').replaceAll('\n','<br>')}</div></div></div></section><section class="card section"><h2>Official history</h2>${objectHistoryHtml(state,p.id)}</section>`;
}

function constitutionSectionDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage();
  const effective=constitutionSectionEffective(state,id); if(!effective) return detailNotFound('constitution','Constitutional section',id);
  const amendments=[...(state.constitution?.amendments??[])].filter(a=>String(a.section)===String(id)).reverse();
  const active=Object.values(state.constitution?.proposals??{}).filter(p=>String(p.section)===String(id) && !['applied','failed','rejected'].includes(p.status));
  return `${breadcrumbHtml([{label:'Constitution',route:'constitution'},{label:`Section ${id}`}])}<section class="detail-hero constitution-detail-hero"><div><span class="page-kicker">Section ${escapeHtml(id)} · ${escapeHtml(effective.category)}</span><h1>${escapeHtml(effective.effectiveTitle)}</h1><p class="muted">${effective.editable?'Editable under the constitutional amendment procedure':'Protected Base provision'}</p></div><div class="detail-hero-actions"><button class="btn" data-action="copy-current-link">Copy link</button><button class="btn" data-route="constitution">Back to Constitution</button></div></section><section class="constitution-section-detail-layout"><article class="card constitution-document"><div class="document-heading"><span class="page-kicker">Authoritative wording</span><h2>§${escapeHtml(id)} — ${escapeHtml(effective.effectiveTitle)}</h2>${effective.override?'<span class="status status-active">Amended text</span>':''}</div><div class="proposal-text law-document law-document-full">${escapeHtml(effective.effectiveText).replaceAll('\n','<br>')}</div>${effective.override?`<p class="muted">Current override effective ${escapeHtml(formatDateTime(effective.override.effectiveAt))}.</p>`:''}</article><aside class="card procedure-aside"><h2>Section status</h2><dl class="kv"><dt>Category</dt><dd>${escapeHtml(effective.category)}</dd><dt>Amendability</dt><dd>${effective.editable?'Editable':'Protected until valid unlock'}</dd><dt>Applied amendments</dt><dd>${amendments.length}</dd><dt>Active proposals</dt><dd>${active.length}</dd></dl><div class="btn-row"><button class="btn btn-primary" data-action="create-amendment">Propose Amendment</button><button class="btn" data-route="rulebook">Open Full Rulebook</button></div></aside></section>${active.length?`<section class="section card"><h2>Active proposals affecting this section</h2><div class="linked-stage-grid">${active.map(p=>`<button class="linked-stage-card" data-route="amendment/${encodeURIComponent(p.id)}"><span>${escapeHtml(p.id)}</span><strong>${escapeHtml(amendmentStatusLabel(p.status))}</strong><small>${escapeHtml(p.sectionTitle??effective.effectiveTitle)}</small></button>`).join('')}</div></section>`:''}<section class="section card"><h2>Amendment history</h2>${amendments.length?`<div class="amendment-history-list">${amendments.map(a=>`<article><span class="amendment-number">#${a.number}</span><div><strong>${escapeHtml(a.id)}</strong><span>Approved ${escapeHtml(formatDateTime(a.approvedAt))} · effective ${escapeHtml(formatDateTime(a.effectiveAt))}</span></div>${state.constitution?.proposals?.[a.id]?`<button class="btn btn-quiet" data-route="amendment/${encodeURIComponent(a.id)}">Open amendment</button>`:''}</article>`).join('')}</div>`:emptyState('No applied amendments','This section still uses its original wording.',{icon:'¶'})}</section>`;
}

function caseDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage();
  const c=state.cases?.[id]; if(!c) return detailNotFound('cases','Case',id);
  const [nextTitle,nextText]=nextStepForCase(c,state); const actorId=localActorId(state);
  const accused=state.players?.[c.accusedId], complainant=state.players?.[c.complainantId], law=state.laws?.[c.lawId];
  const role=caseRoleFor(c,state,actorId); const needsAction=caseNeedsActorAction(c,state);
  const panel=(c.pacPanel??[]).map(x=>state.players?.[x]).filter(Boolean), jury=(c.jury??[]).map(x=>state.players?.[x]).filter(Boolean);
  const finalOutcome=c.ppcPunishment?.text || c.juryResult || c.pacFinding || (c.status==='closed'?'Closed without a recorded finding':'');
  return `${breadcrumbHtml([{label:'Cases',route:'cases'},{label:c.id}])}<section class="detail-hero case-detail-hero"><div><span class="page-kicker">${escapeHtml(c.id)}</span><h1>${escapeHtml(accused?.displayName??c.accusedId)} · ${escapeHtml(law?.title??c.lawId)}</h1><p class="muted">Opened ${escapeHtml(formatDateTime(c.openedAt))} · ${escapeHtml(caseStageLabel(c))}</p></div><div class="detail-hero-actions"><button class="btn" data-action="copy-current-link">Copy link</button><button class="btn" data-route="cases">Back to Cases</button></div></section>${c.status==='closed'?`<section class="case-closed-summary"><div><span class="page-kicker">Final case status</span><h2>Case closed</h2><p>${escapeHtml(finalOutcome||'The case has reached a final recorded outcome.')}</p></div><span class="status status-active">Closed</span></section>`:statusInfoHtml('case',c.status)}${actorId?`<section class="personal-state-strip${needsAction?' needs-action':''}"><span class="page-kicker">Your role in this case</span><strong>${escapeHtml(role)}${needsAction?' · action required':''}</strong><span>${role==='Observer'?'You have no formal decision-making role in this case at its current stage.':'Any action shown to you is limited to this formal role and the constitutional procedure.'}</span></section>`:''}${nextStepPanel(nextTitle,nextText)}${needsAction?`<section class="case-required-action card"><div><span class="page-kicker">Required action</span><h2>Your next procedural step</h2><p>Only actions currently available to your verified role are shown here.</p></div><div class="btn-row">${caseActionButtons(c,state)}</div></section>`:''}${processTracker(['Complaint','Response','PAC','Jury','PPC','Closed'],caseStage(c),{compact:false})}<section class="case-participants card"><div><h2>Participants</h2><p class="muted">People with a formal role in the case are shown separately from the evidence and findings.</p></div><div class="case-participant-grid"><button class="person-chip" data-route="player/${encodeURIComponent(c.complainantId)}"><strong>${escapeHtml(complainant?.displayName??c.complainantId??'—')}</strong><small>Complainant</small></button><button class="person-chip" data-route="player/${encodeURIComponent(c.accusedId)}"><strong>${escapeHtml(accused?.displayName??c.accusedId??'—')}</strong><small>Accused</small></button>${panel.map(p=>`<button class="person-chip${p.id===actorId?' is-you':''}" data-route="player/${encodeURIComponent(p.id)}"><strong>${escapeHtml(p.displayName)}</strong><small>PAC panel${p.id===actorId?' · You':''}</small></button>`).join('')}${jury.map(p=>`<button class="person-chip${p.id===actorId?' is-you':''}" data-route="player/${encodeURIComponent(p.id)}"><strong>${escapeHtml(p.displayName)}</strong><small>Juror${p.id===actorId?' · You':''}</small></button>`).join('')}</div></section><section class="case-record-grid case-panels"><article class="card case-record-block"><span class="case-record-step">1</span><div><span class="page-kicker">Complaint</span><h2>Allegation</h2><p>${escapeHtml(c.conduct??'—')}</p>${c.evidence?`<h3>Evidence</h3><p>${escapeHtml(c.evidence)}</p>`:''}<dl class="kv"><dt>Law</dt><dd>${law?`<button class="link-button" data-route="law/${encodeURIComponent(law.id)}">${escapeHtml(law.title)}</button>`:escapeHtml(c.lawId??'—')}</dd></dl></div></article><article class="card case-record-block"><span class="case-record-step">2</span><div><span class="page-kicker">Response</span><h2>Accused response</h2><p>${escapeHtml(c.accusedResponse??'No response recorded yet.')}</p></div></article><article class="card case-record-block"><span class="case-record-step">3</span><div><span class="page-kicker">PAC finding</span><h2>${escapeHtml(c.pacFinding??'No finding yet')}</h2><p>${c.pacFinding==='Guilty'?'Every Guilty PAC finding proceeds automatically to jury review.':'The PAC decides whether the alleged ordinary-law violation is proven; it does not impose punishment.'}</p>${c.pacVoteId?`<button class="btn" data-route="vote/${encodeURIComponent(c.pacVoteId)}">Open PAC vote</button>`:''}</div></article><article class="card case-record-block"><span class="case-record-step">4</span><div><span class="page-kicker">Jury review</span><h2>${escapeHtml(c.juryResult??'No jury result yet')}</h2><p>The jury independently decides whether a PAC Guilty finding is upheld.</p>${c.juryVoteId?`<button class="btn" data-route="vote/${encodeURIComponent(c.juryVoteId)}">Open jury vote</button>`:''}</div></article><article class="card case-record-block full"><span class="case-record-step">5</span><div><span class="page-kicker">PPC outcome</span><h2>${c.ppcPunishment?'Punishment recorded':'No PPC punishment recorded'}</h2><p>${escapeHtml(c.ppcPunishment?.text??'The PPC acts only after a Guilty finding has been upheld through the required jury process.')}</p></div></article></section><section class="card section"><h2>Official history</h2>${objectHistoryHtml(state,c.id)}</section>`;
}

function playerDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage(); const p=state.players?.[id]; if(!p) return detailNotFound('players','Player',id);
  const roles=roleLabelsFor(state,p.id), party=p.partyId?state.parties?.[p.partyId]:null, self=localActorId(state)===p.id;
  return `${breadcrumbHtml([{label:'Players',route:'players'},{label:p.displayName}])}<section class="detail-hero"><div class="profile-detail-heading"><span class="profile-avatar">${escapeHtml(p.displayName.slice(0,1).toUpperCase())}</span><div><span class="page-kicker">Player ${escapeHtml(p.id)}${self?' · You':''}</span><h1>${escapeHtml(p.displayName)}</h1><p class="muted">${escapeHtml(roles.join(' · '))}</p></div></div><button class="btn" data-route="players">Back to Players</button></section><section class="detail-grid"><article class="card"><h2>Current position</h2><dl class="kv"><dt>Status</dt><dd>${escapeHtml(playerStatusLabel(p.status))}</dd><dt>Party</dt><dd>${party?`<button class="link-button" data-route="party/${encodeURIComponent(party.id)}">${escapeHtml(party.name)}</button>`:'Independent'}</dd><dt>Joined</dt><dd>${escapeHtml(formatDateTime(p.joinedAt))}</dd></dl></article><article class="card"><h2>Current roles</h2><div class="member-chips">${roles.map(r=>`<span class="pill">${escapeHtml(r)}</span>`).join('')}</div></article></section><section class="card section"><h2>Official activity involving ${escapeHtml(p.displayName)}</h2>${objectHistoryHtml(state,p.id,20)}</section>`;
}

function partyDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage(); const party=state.parties?.[id]; if(!party) return detailNotFound('parties','Political party',id);
  const leader=state.players?.[party.leaderId], members=(party.members??[]).map(x=>state.players?.[x]).filter(Boolean); const seats=partySeatCounts(state)[party.id]??0;
  return `${breadcrumbHtml([{label:'Parties',route:'parties'},{label:party.name}])}<section class="detail-hero"><div><span class="page-kicker">${escapeHtml(party.abbreviation||party.id)}</span><h1><span class="colour-dot" style="--party-colour:${safePartyColour(party.colour)}"></span>${escapeHtml(party.name)}</h1><p class="muted">${party.status==='active'?'Active political party':'Former / dissolved party'}</p></div><button class="btn" data-route="parties">Back to Parties</button></section><section class="detail-grid"><article class="card"><h2>Party overview</h2><p>${escapeHtml(party.description||'No party description.')}</p><dl class="kv"><dt>Leader</dt><dd>${leader?`<button class="link-button" data-route="player/${encodeURIComponent(leader.id)}">${escapeHtml(leader.displayName)}</button>`:'Vacant'}</dd><dt>Members</dt><dd>${members.length}</dd><dt>Parliamentary seats</dt><dd>${seats}</dd><dt>Created</dt><dd>${escapeHtml(formatDateTime(party.createdAt))}</dd></dl></article><article class="card"><h2>Members</h2><div class="person-chip-row">${members.map(m=>`<button class="person-chip" data-route="player/${encodeURIComponent(m.id)}"><strong>${escapeHtml(m.displayName)}</strong>${m.id===party.leaderId?'<small>Leader</small>':''}</button>`).join('')||'<span class="muted">No current members.</span>'}</div></article></section><section class="card section"><h2>Official history</h2>${objectHistoryHtml(state,party.id,20)}</section>`;
}

function committeeDetailPage({ id }) {
  const state=getState(); if(!state) return noGamePage(); const code=String(id).toUpperCase(); const c=state.committees?.[code]; if(!c) return detailNotFound('committees','Committee',code);
  const members=(c.members??[]).map(x=>state.players?.[x]).filter(Boolean), alts=(c.alternates??[]).map(x=>state.players?.[x]).filter(Boolean), chair=state.players?.[c.chairId], matters=[...(c.matters??[])].sort((a,b)=>(a.status==='open'?0:1)-(b.status==='open'?0:1)), actorId=localActorId(state), seated=committeeMemberLocal(state,code,actorId);
  const open=matters.filter(m=>m.status==='open'); const next=open.length?[`${open.length} open matter${open.length===1?'':'s'}`,seated?'You are seated on this committee. Review open matters and participate only where you are eligible and not recused.':'You can follow the public record; formal decisions are made by eligible committee members.']:['No open matters','This committee currently has no unresolved formal matter.'];
  const matterHtml=matters.map(m=>{const recused=(m.recusedIds??m.recusedPlayerIds??[]).map(x=>state.players?.[x]).filter(Boolean), vote=m.voteId?state.votes?.[m.voteId]:null;return `<article class="committee-matter detail-matter${m.status==='open'?' is-open':''}"><div class="section-header compact-header"><div><span class="pill">${escapeHtml(m.status??'open')}</span><h3>${escapeHtml(m.title)}</h3><p>${escapeHtml(m.description||'No description recorded.')}</p></div>${m.decision?`<span class="status status-active">${escapeHtml(m.decision)}</span>`:''}</div>${processTracker(['Opened','Recusals','Vote','Decision'],committeeMatterStage(m),{compact:true})}${recused.length?`<div class="recusal-strip"><strong>Recused</strong>${recused.map(p=>`<button class="pill pill-button" data-route="player/${encodeURIComponent(p.id)}">${escapeHtml(p.displayName)}</button>`).join('')}</div>`:''}<div class="btn-row">${m.status==='open'&&seated?`<button class="btn" data-action="recuse-committee-member" data-committee="${code}" data-matter-id="${m.id}">Record Recusal</button><button class="btn btn-primary" data-action="create-committee-vote" data-committee="${code}" data-matter-id="${m.id}">Open Vote</button>`:''}${vote?`<button class="btn" data-route="vote/${encodeURIComponent(vote.id)}">${escapeHtml(voteStatusLabel(vote.status))} vote</button>`:''}</div></article>`}).join('');
  return `${breadcrumbHtml([{label:'Committees',route:'committees'},{label:code}])}<section class="detail-hero committee-detail-hero"><div><span class="page-kicker">${escapeHtml(code)}</span><h1>${escapeHtml(committeeLongName(code))}</h1><p class="muted">Permanent constitutional committee</p></div><div class="detail-hero-actions"><button class="btn" data-action="copy-current-link">Copy link</button><button class="btn" data-route="committees">Back to Committees</button></div></section><section class="constitutional-role-card"><span class="page-kicker">Constitutional role</span><h2>${escapeHtml(committeeLongName(code))}</h2><p>${escapeHtml(committeePurpose(code))}</p></section>${actorId?`<section class="personal-state-strip"><span class="page-kicker">Your committee status</span><strong>${seated?'Seated member / alternate':'Not seated'}</strong><span>${seated?'Your formal participation is still subject to recusal and Decision Membership rules.':'You may follow proceedings but cannot make committee decisions.'}</span></section>`:''}${nextStepPanel(...next)}<section class="committee-detail-summary"><article class="card"><span class="meta-label">Chair</span><strong>${escapeHtml(chair?.displayName??'Not elected')}</strong></article><article class="card"><span class="meta-label">Members</span><strong>${members.length}</strong></article><article class="card"><span class="meta-label">Alternates</span><strong>${alts.length}</strong></article><article class="card"><span class="meta-label">Open matters</span><strong>${open.length}</strong></article></section><section class="detail-grid committee-detail-grid"><article class="card"><div class="section-header compact-header"><div><h2>Membership</h2><p class="muted">Tap or click any player to open their profile.</p></div>${seated?`<div class="btn-row"><button class="btn" data-action="set-committee-chair" data-committee="${code}">Set Chair</button><button class="btn btn-primary" data-action="create-committee-matter" data-committee="${code}">New Matter</button></div>`:''}</div><span class="meta-label">Members</span><div class="person-chip-row">${members.map(m=>`<button class="person-chip${m.id===actorId?' is-you':''}" data-route="player/${encodeURIComponent(m.id)}"><strong>${escapeHtml(m.displayName)}</strong>${m.id===c.chairId?'<small>Chair</small>':''}${m.id===actorId?'<small>You</small>':''}</button>`).join('')||'<span class="muted">No seated members.</span>'}</div>${alts.length?`<div class="people-section"><span class="meta-label">Alternates</span><div class="person-chip-row">${alts.map(m=>`<button class="person-chip alternate${m.id===actorId?' is-you':''}" data-route="player/${encodeURIComponent(m.id)}"><strong>${escapeHtml(m.displayName)}</strong><small>Alternate${m.id===actorId?' · You':''}</small></button>`).join('')}</div></div>`:''}</article><article class="card"><h2>Decision rules</h2><p>Unless another constitutional section states otherwise, a committee decision requires an ordinary majority of its Decision Membership.</p><p>Required recusals are applied before Decision Membership is determined. Committee members normally have 72 hours to vote, with the constitutional deadlock procedure applying where required.</p><button class="btn" data-route="rulebook">Open exact constitutional rules</button></article></section><section class="card section"><div class="section-header compact-header"><div><h2>Matters</h2><p class="muted">Active matters appear first; their recusals, vote and final decision stay in one procedural record.</p></div><span class="badge">${open.length}</span></div>${matterHtml || emptyState('No committee matters','This committee currently has no recorded formal matters.',{icon:'◇'})}</section>`;
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
      <div class="btn-row form-actions-sticky"><button class="btn btn-primary" type="submit">Create Game</button><button class="btn" type="button" data-route="home">Cancel</button></div>
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
  const visible = attentionVisible(attentionItems, pref, getCloudNowMs());
  const unread = visible.filter(item => !pref.seen?.[item.id]).length;
  const badge = document.querySelector('#notificationBadge');
  if (badge) { badge.textContent = String(unread); badge.hidden = unread === 0; }
  const voteCount = visible.filter(item => item.kind === 'vote' && item.id.startsWith('vote-unvoted:')).length;
  const caseCount = visible.filter(item => item.kind === 'case').length;
  setCountBadge('#voteBadge', voteCount); setCountBadge('#mobileVoteBadge', voteCount); setCountBadge('#dockVoteBadge', voteCount);
  setCountBadge('#caseBadge', caseCount); setCountBadge('#mobileCaseBadge', caseCount); setCountBadge('#dockCaseBadge', caseCount);
  setCountBadge('#actionBadge', visible.length); setCountBadge('#mobileActionBadge', visible.length); setCountBadge('#dockActionBadge', visible.length);
  if (notify) maybeSendBrowserNotifications(visible);
  return visible;
}

function actionsPage() {
  const state = getState();
  if (!state) return noGamePage();
  const pref = notificationPrefs();
  const now = getCloudNowMs();
  const derivedItems = refreshAttention(state,false);
  const items = attentionVisible(derivedItems, pref, now);
  const required = items.filter(item => ['vote','party','case','government'].includes(item.kind));
  const upcoming = [];
  const seen = new Set(derivedItems.map(item=>item.id));
  for (const vote of Object.values(state.votes ?? {})) {
    if (vote.status !== 'open' || !vote.closesAt) continue;
    const due = Date.parse(vote.closesAt);
    if (!Number.isFinite(due) || due < now) continue;
    const id=`upcoming:${vote.id}`;
    if (seen.has(`vote-unvoted:${vote.id}`) || seen.has(`vote-closing:${vote.id}`)) continue;
    upcoming.push({id,kind:vote.electionKind?'election':'vote',priority:'normal',title:vote.title,message:`Voting closes ${formatDateTime(vote.closesAt)}.`,route:vote.electionKind?'elections':'votes',dueAt:vote.closesAt,actionLabel:'Open',why:'This is an open political deadline in your Democracy.'});
  }
  if (state.government?.caretakerDeadline && !seen.has(`caretaker:${state.government.caretakerSince||'active'}`)) upcoming.push({id:'upcoming:caretaker',kind:'government',priority:'normal',title:'Caretaker deadline',message:`Government formation deadline ${formatDateTime(state.government.caretakerDeadline)}.`,route:'government',dueAt:state.government.caretakerDeadline,actionLabel:'Open government',why:'The current caretaker period has a defined government-formation deadline.'});
  upcoming.sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt));
  const updates=[...(state.history??[])].reverse().slice(0,8);
  return `<section class="section-header"><div><span class="page-kicker">Personal agenda</span><h1>My Actions</h1><p class="muted">Everything that needs you, deadlines worth watching, and the latest official changes — in one place.</p></div><div class="btn-row"><button class="btn" data-route="dashboard">Dashboard</button><button class="btn" data-route="notifications">Notification settings</button></div></section>
    <div class="my-actions-summary"><div><strong>${required.length}</strong><span>need your action</span></div><div><strong>${upcoming.length}</strong><span>coming up</span></div><div><strong>${updates.length}</strong><span>recent updates</span></div></div>
    <section class="section my-actions-section"><div class="section-header compact-header"><div><h2>Needs you now</h2><p class="muted">Items tied to your player identity or current political responsibilities.</p></div>${required.some(i=>i.priority==='urgent')?'<span class="status status-danger">Urgent items</span>':''}</div><div class="my-actions-list">${required.map(i=>attentionCardHtml(i)).join('') || `<div class="caught-up"><span>✓</span><div><strong>You're caught up</strong><p>Nothing currently requires an action from your player.</p></div></div>`}</div></section>
    <section class="section my-actions-section"><div class="section-header compact-header"><div><h2>Coming up</h2><p class="muted">Known deadlines that may become relevant soon.</p></div></div><div class="my-actions-list">${upcoming.slice(0,10).map(i=>attentionCardHtml(i,{compact:true})).join('') || '<div class="empty compact-empty">No upcoming deadlines are currently scheduled.</div>'}</div></section>
    <section class="section card"><div class="section-header compact-header"><div><h2>For your information</h2><p class="muted">Recent official changes in this Democracy.</p></div><button class="btn" data-route="activity">Full activity</button></div><ol class="activity-timeline">${updates.map(event=>`<li class="activity-event"><span class="activity-dot"></span><div><div class="activity-title">${escapeHtml(describeEvent(event,state))}</div><div class="muted">${escapeHtml(formatDateTime(event.timestamp))}</div></div></li>`).join('') || '<li class="empty">No official activity yet.</li>'}</ol></section>`;
}

function notificationsPage() {
  const state=getState(); if(!state)return noGamePage();
  const pref=notificationPrefs(); const items=attentionVisible(refreshAttention(state,false),pref,getCloudNowMs());
  markAttentionSeen(items.map(i=>i.id));
  requestAnimationFrame(()=>refreshAttention(state,false));
  const support='Notification' in window;
  return `<section class="section-header"><div><h1>Notifications</h1><p class="muted">Deadlines and actions that may need your attention. The game remains fully usable with notifications disabled.</p></div><div class="btn-row"><button class="btn btn-primary" data-route="actions">Open My Actions</button><button class="btn" data-action="clear-dismissed-notifications">Reset dismissed</button></div></section>
  <section class="card"><div class="section-header compact-header"><div><h2>Browser notifications</h2><p class="muted">Optional reminders while the site is open or installed. Permission is controlled by your browser.</p></div><span class="status">${support?escapeHtml(Notification.permission):'unsupported'}</span></div><label class="check-row"><input type="checkbox" data-action="toggle-browser-notifications" ${pref.browser?'checked':''} ${support?'':'disabled'}> Send browser notifications for new attention items</label></section>
  <section class="section"><div class="grid">${items.map(i=>`<article class="card attention-item ${i.priority==='urgent'?'urgent':''}"><div><span class="pill">${escapeHtml(i.kind)}</span><h2>${escapeHtml(i.title)}</h2><p class="muted">${escapeHtml(i.message)}</p></div><div class="btn-row">${i.requestId ? `<button class="btn btn-primary" data-action="respond-party-membership" data-request-id="${escapeHtml(i.requestId)}" data-response="accept">Accept</button><button class="btn" data-action="respond-party-membership" data-request-id="${escapeHtml(i.requestId)}" data-response="reject">Reject</button>` : `<button class="btn btn-primary" data-route="${escapeHtml(i.route)}">Open</button>`}<button class="btn" data-action="dismiss-notification" data-notification-id="${escapeHtml(i.id)}">Dismiss</button></div></article>`).join('')||'<div class="empty"><h2>All caught up</h2><p>There are no current alerts for this player.</p></div>'}</div></section>`;
}

function dashboardPage() {
  const state = getState();
  if (!state) return `<section class="empty"><h2>No game loaded</h2><p>Create or load a Democracy to see your political dashboard.</p><button class="btn btn-primary" data-route="create">Create Game</button></section>`;
  const actorId = localActorId(state);
  const actor = actorId ? state.players[actorId] : null;
  const roles = roleLabelsFor(state, actorId);
  const activePlayers = Object.values(state.players).filter(p => p.status === 'active');
  const activeParties = Object.values(state.parties).filter(p => p.status === 'active');
  const openVotes = Object.values(state.votes ?? {}).filter(v => v.status === 'open').sort((a,b)=>new Date(a.closesAt)-new Date(b.closesAt));
  const host = state.meta.hostPlayerId ? state.players[state.meta.hostPlayerId] : null;
  const pm = state.government?.primeMinisterId ? state.players[state.government.primeMinisterId] : null;
  const filled = filledLegislativeSeats(state).length;
  const totalSeats = state.legislature?.totalSeats || 0;
  const majority = filled ? majorityThreshold(filled) : 0;
  const activeCases = Object.values(state.cases ?? {}).filter(c => !['closed','dismissed','not-guilty'].includes(c.status));
  const visibleAttention = attentionVisible(refreshAttention(state,false), notificationPrefs(), getCloudNowMs());
  const urgentAttention = visibleAttention.filter(item => item.priority === 'urgent');
  const now = getCloudNowMs();
  const upcoming = [
    ...openVotes.filter(v=>v.closesAt).map(v=>({label:v.title,when:new Date(v.closesAt).getTime(),route:v.electionKind?'elections':'votes',kind:v.electionKind?'Election':'Vote'})),
    ...(state.government?.caretakerDeadline ? [{label:'Caretaker government formation deadline',when:new Date(state.government.caretakerDeadline).getTime(),route:'government',kind:'Government'}] : [])
  ].filter(item=>Number.isFinite(item.when)&&item.when>=now).sort((a,b)=>a.when-b.when).slice(0,5);
  const govMajority = governmentMajorityStatus(state);
  const party = actor?.partyId ? state.parties[actor.partyId] : null;
  return `<section class="dashboard-welcome"><div><span class="page-kicker">Your democracy</span><h1>${actor ? `Hello, ${escapeHtml(actor.displayName)}` : escapeHtml(state.meta.name)}</h1><p>${actor ? `${escapeHtml(roles.join(' · '))}${party ? ` · ${escapeHtml(party.name)}` : ' · Independent'}` : 'Official political overview'}</p><small>${escapeHtml(state.meta.name)} · State #${state.stateVersion}</small></div><div class="dashboard-actions"><button class="btn" data-route="help">Help</button><button class="btn" data-action="share-game">Share</button><button class="btn" data-action="export-current">Backup</button></div></section>
    <section class="section attention-command ${visibleAttention.length?'has-items':'clear'}"><div class="section-header compact-header"><div><span class="page-kicker">Your next actions · My Actions</span><h2>${visibleAttention.length ? `${visibleAttention.length} thing${visibleAttention.length===1?'':'s'} need your attention` : 'You are all caught up'}</h2><p class="muted">Democracy Web surfaces actions for your player so you do not have to hunt through pages.</p></div>${urgentAttention.length?`<span class="status status-error">${urgentAttention.length} urgent</span>`:'<span class="status status-active">Clear</span>'}</div>${visibleAttention.length ? `<div class="attention-stack">${visibleAttention.slice(0,5).map(item=>`<article class="attention-command-row ${item.priority==='urgent'?'urgent':''}"><div><span class="pill">${escapeHtml(item.kind)}</span><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p></div>${attentionActionHtml(item)}</article>`).join('')}</div><div class="btn-row section"><button class="btn btn-primary" data-route="actions">Open My Actions</button><button class="btn" data-route="notifications">Notification settings</button></div>` : '<div class="empty compact-empty">No votes, requests, deadlines or cases currently require action from you.</div>'}</section>
    ${coachPanel(state)}
    <div class="grid grid-4 section">${statCard(activePlayers.length,'Active players')}${statCard(openVotes.length,'Open votes')}${statCard(host?.displayName ?? '—','Host')}${statCard(pm?.displayName ?? '—','Prime Minister')}</div>
    <section class="section grid grid-2"><article class="card political-snapshot"><div class="section-header compact-header"><div><h2>Political snapshot</h2><p class="muted">The current balance of power.</p></div></div><dl class="kv"><dt>Parliament</dt><dd>${filled}/${totalSeats} seats${majority?` · majority ${majority}`:''}</dd><dt>Government</dt><dd>${escapeHtml(state.government?.status || 'Not formed')}${govMajority?.filledSeats ? ` · ${govMajority.coalitionSeats}/${govMajority.filledSeats} seats` : ''}</dd><dt>Parties</dt><dd>${activeParties.length} active</dd><dt>Constitution</dt><dd>Version ${escapeHtml(String(state.constitution?.version ?? 1))}</dd><dt>Active cases</dt><dd>${activeCases.length}</dd></dl></article><article class="card"><div class="section-header compact-header"><div><h2>Coming up</h2><p class="muted">Nearest known political deadlines.</p></div></div>${upcoming.length?`<ul class="timeline-list">${upcoming.map(item=>`<li><span class="timeline-dot"></span><div><small>${escapeHtml(item.kind)}</small><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(formatDateTime(new Date(item.when).toISOString()))}</span></div><button class="btn" data-route="${escapeHtml(item.route)}">Open</button></li>`).join('')}</ul>`:'<div class="empty compact-empty">No upcoming deadlines are currently scheduled.</div>'}</article></section>
    <section class="section"><div class="section-header compact-header"><div><h2>Explore your Democracy</h2><p class="muted">Jump straight to the part of the political system you need.</p></div></div><div class="quick-links"><button class="quick-link" data-route="elections"><strong>🗳 Elections</strong><span>Campaigns, ballots and results</span></button><button class="quick-link" data-route="parliament"><strong>🏛 Parliament</strong><span>Seats and legislative votes</span></button><button class="quick-link" data-route="government"><strong>◆ Government</strong><span>Coalitions and ministers</span></button><button class="quick-link" data-route="parties"><strong>● Parties</strong><span>${activeParties.length} active parties</span></button><button class="quick-link" data-route="laws"><strong>§ Laws</strong><span>Legislation and referendums</span></button><button class="quick-link" data-route="constitution"><strong>¶ Constitution</strong><span>Rules and amendments</span></button><button class="quick-link" data-route="committees"><strong>◇ Committees</strong><span>AC, PC, PAC and PPC</span></button><button class="quick-link" data-route="cases"><strong>⚖ Cases</strong><span>${activeCases.length} active</span></button></div></section>
    <section class="section card"><div class="section-header compact-header"><div><h2>Recent official activity</h2><p class="muted">The latest certified changes to the political record.</p></div><button class="btn" data-route="help">Need help?</button></div>${historyList(state,8)}</section>`;
}

function playersPage() {
  const state = getState();
  if (!state) return noGamePage();
  const players = Object.values(state.players).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const actorId = localActorId(state);
  const online = isOnlineGame();
  const hostLike = isHostLikeLocal(state, actorId);
  const rows = players.map(player => {
    const self = player.id === actorId;
    const roles = roleLabelsFor(state,player.id);
    const party = player.partyId ? state.parties[player.partyId] : null;
    const tokens=[player.status,self?'mine':'',player.partyId?'party':'independent',(state.legislature?.seats??[]).some(seat=>seat.memberId===player.id)?'mp':''].filter(Boolean).join('|');
    return `<tr data-list-item data-search="${escapeHtml(`${player.displayName} ${party?.name||'Independent'} ${roles.join(' ')}`)}" data-filter-tokens="${escapeHtml(tokens)}" data-sort-title="${escapeHtml(player.displayName.toLowerCase())}" data-sort-date="${Date.parse(player.joinedAt)||0}" data-sort-relevance="${self?3:player.status==='active'?1:0}"><td><strong>${escapeHtml(player.displayName)}</strong>${player.roles?.includes('creator') ? ' <span class="pill">Creator</span>' : ''}${self ? ' <span class="pill">You</span>' : ''}</td><td><span class="status status-${escapeHtml(player.status)}">${escapeHtml(playerStatusLabel(player.status))}</span></td><td>${partyBadge(state, player)}</td><td>${escapeHtml(formatDateTime(player.joinedAt))}</td><td><div class="btn-row compact"><button class="btn" data-route="player/${encodeURIComponent(player.id)}">View profile</button>${!online || self ? `<button class="btn" data-action="rename-player" data-player-id="${player.id}">Rename</button>` : ''}${(!online || hostLike) && player.status === 'active' ? `<button class="btn" data-action="set-inactive" data-player-id="${player.id}">Inactive</button>` : ''}${(!online || hostLike) && player.status === 'inactive' ? `<button class="btn" data-action="set-active" data-player-id="${player.id}">Activate</button>` : ''}${(!online || self) && !['resigned','removed'].includes(player.status) ? `<button class="btn btn-danger" data-action="resign-player" data-player-id="${player.id}">Resign</button>` : ''}</div></td></tr>`;
  }).join('');
  return `<section class="section-header"><div><h1>Players</h1><p class="muted">In multiplayer, player-originated actions are bound to the cryptographic identity connected to this browser.</p></div>${!online || hostLike ? '<button class="btn btn-primary" data-action="add-player">Add Player</button>' : ''}</section>
    ${players.length?listToolbar('players',{placeholder:'Search players, parties or roles…',filters:[['mine','Me'],['active','Active'],['inactive','Inactive'],['mp','MPs'],['party','In a party'],['independent','Independent']],sorts:[['az','A–Z'],['za','Z–A'],['relevant','Most relevant'],['newest','Newest joined'],['oldest','Oldest joined']],allowView:false}):''}
    <div class="card table-wrap"><table class="data-table"><thead><tr><th>Player</th><th>Status</th><th>Party</th><th>Joined</th><th>Actions</th></tr></thead><tbody data-list-container="players">${rows}</tbody></table></div><div data-filtered-empty="players" class="empty filtered-empty" hidden><strong>No matching players</strong><p>Try changing your search or filters.</p></div><section class="section"><div class="section-header compact-header"><div><h2>Player profiles</h2><p class="muted">Roles, party, current office and public political activity at a glance.</p></div><button class="btn" data-route="activity">Full Activity Timeline</button></div><div class="player-profile-grid">${players.map(player=>{const roles=roleLabelsFor(state,player.id);const party=player.partyId?state.parties[player.partyId]:null;return `<button class="profile-preview" type="button" data-route="player/${encodeURIComponent(player.id)}"><span class="profile-avatar small">${escapeHtml(player.displayName.slice(0,1).toUpperCase())}</span><span><strong>${escapeHtml(player.displayName)}</strong><small>${escapeHtml(roles.join(' · '))}</small><small>${escapeHtml(party?.name??'Independent')}</small></span></button>`}).join('')}</div></section>`;
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
    <div class="party-heading"><span class="party-swatch" style="--party-colour:${safePartyColour(party.colour)}"></span><div><h2>${escapeHtml(party.name)} ${party.abbreviation ? `<span class="muted">(${escapeHtml(party.abbreviation)})</span>` : ''}</h2><p class="muted">${party.status === 'active' ? 'Active party' : `Dissolved ${escapeHtml(formatDateTime(party.dissolvedAt))}`}</p></div></div>
    <p>${escapeHtml(party.description || 'No party description.')}</p>
    <dl class="kv"><dt>Leader</dt><dd>${escapeHtml(leader?.displayName ?? 'Vacant')}</dd><dt>Members</dt><dd>${members.length}</dd><dt>Created</dt><dd>${escapeHtml(formatDateTime(party.createdAt))}</dd></dl>
    ${members.length ? `<div class="member-chips">${members.map(m => `<span class="pill">${escapeHtml(m.displayName)}${m.id===actorId?' · You':''}</span>`).join('')}</div>` : ''}
    ${party.status !== 'active' ? `<div class="btn-row section"><button class="btn" data-route="party/${encodeURIComponent(party.id)}">Open details</button></div>` : ''}
    ${party.status === 'active' ? `<div class="btn-row section"><button class="btn" data-route="party/${encodeURIComponent(party.id)}">Open details</button>
      ${canRequest ? `<button class="btn btn-primary" data-action="request-party-join" data-party-id="${party.id}">Request to Join</button>` : ''}
      ${pending && !actor?.partyId ? `<span class="pill">Membership request pending</span>` : ''}
      ${isMember ? `<button class="btn" data-action="leave-party-self">Leave Party</button>` : ''}
      ${!online || isLeader ? `<button class="btn" data-action="edit-party" data-party-id="${party.id}">Edit</button><button class="btn" data-action="manage-party-members" data-party-id="${party.id}">Members</button><button class="btn" data-action="change-party-leader" data-party-id="${party.id}">Leader</button><button class="btn btn-danger" data-action="dissolve-party" data-party-id="${party.id}">Dissolve</button>` : ''}
    </div>` : ''}
  </article>`;
}

function activityPage() {
  const state = getState();
  if (!state) return noGamePage();
  const events = [...(state.history ?? [])].reverse();
  const actorId = localActorId(state);
  const rows = events.slice(0,300).map(event=>{
    const mine = actorId && eventMentionsPlayer(event,actorId);
    const type=String(event.type||'').toLowerCase();
    const category = /vote|ballot|referendum/.test(type)?'voting':/election/.test(type)?'elections':/law/.test(type)?'laws':/constitution|amend/.test(type)?'constitution':/case|pac|jury|ppc/.test(type)?'cases':/party/.test(type)?'parties':/government|minister|prime/.test(type)?'government':/player|host|deputy/.test(type)?'players':'system';
    const description=describeEvent(event,state);
    return `<li class="activity-event${mine?' is-you':''}" data-list-item data-search="${escapeHtml(`${description} ${event.type}`)}" data-filter-tokens="${escapeHtml([category,mine?'mine':''].filter(Boolean).join('|'))}" data-sort-title="${escapeHtml(description.toLowerCase())}" data-sort-date="${Date.parse(event.timestamp)||0}" data-sort-relevance="${mine?2:0}"><span class="activity-dot"></span><div><div class="activity-title">${escapeHtml(description)}${mine?' <span class="pill">Involves you</span>':''}</div><div class="muted">${escapeHtml(formatDateTime(event.timestamp))} · ${escapeHtml(event.type.replaceAll('_',' '))}</div></div></li>`;
  }).join('');
  return `<section class="section-header"><div><span class="page-kicker">Political record</span><h1>Activity</h1><p class="muted">A readable timeline of the official event chain. Secret ballot choices are never exposed here.</p></div><button class="btn" data-route="dashboard">Dashboard</button></section>${historyIntegrityBanner(state)}<section class="section card"><div class="section-header compact-header"><div><h2>Latest official events</h2><p class="muted">Showing up to the latest 300 events, newest first.</p></div><span class="pill">${events.length} total</span></div>${events.length?listToolbar('activity',{placeholder:'Search activity…',filters:[['mine','Relevant to me'],['voting','Voting'],['elections','Elections'],['laws','Laws'],['constitution','Constitution'],['cases','Cases'],['parties','Parties'],['government','Government'],['players','Players'],['system','System']],sorts:[['newest','Newest'],['oldest','Oldest'],['relevant','Relevant to me']],allowView:false}):''}<ol class="activity-timeline" data-list-container="activity">${rows || '<li class="empty">No official events yet.</li>'}</ol></section>`;
}

function historyIntegrityBanner(state) {
  const integrity = verifyEventChain(state.history ?? []);
  return `<div class="notice ${integrity.ok?'success':'error'}"><strong>History integrity:</strong> ${integrity.ok ? `verified · ${integrity.count} chained event(s)${integrity.headHash ? ` · head ${integrity.headHash.slice(0,12)}…` : ''}` : `FAILED at event ${(integrity.index??0)+1} (${integrity.reason})`}</div>`;
}

function playerProfileHtml(state, player) {
  const party = player.partyId ? state.parties[player.partyId] : null;
  const roles = roleLabelsFor(state,player.id);
  const seat = (state.legislature?.seats ?? []).find(s=>s.memberId===player.id);
  const ministry = (state.government?.ministers ?? []).find(m=>m.playerId===player.id);
  const committees = Object.values(state.committees ?? {}).filter(c=>[...(c.members??[]),...(c.alternates??[])].includes(player.id)).map(c=>c.code);
  const activity = playerPublicActivity(state,player.id,10);
  const partyHistory = (player.partyHistory ?? []).slice().reverse();
  const sponsoredLaws = Object.values(state.lawProposals ?? {}).filter(p=>p.proposerId===player.id).length;
  const amendments = Object.values(state.constitution?.proposals ?? {}).filter(p=>p.proposerId===player.id).length;
  return `<div class="profile-hero"><div class="profile-avatar">${escapeHtml(player.displayName.slice(0,1).toUpperCase())}</div><div><h3>${escapeHtml(player.displayName)}</h3><p>${escapeHtml(roles.join(' · '))}</p><span class="status status-${escapeHtml(player.status)}">${escapeHtml(playerStatusLabel(player.status))}</span></div></div><div class="grid grid-4 profile-stats">${statCard(party?.abbreviation??'Ind.','Party')}${statCard(seat?`#${seat.number}`:'—','Parliament Seat')}${statCard(committees.length,'Committees')}${statCard(activity.length,'Recent Events')}</div><dl class="kv"><dt>Current roles</dt><dd>${escapeHtml(roles.join(', '))}</dd><dt>Government</dt><dd>${escapeHtml(player.id===state.government?.primeMinisterId?'Prime Minister':ministry?`Minister for ${ministry.portfolio}`:'No government office')}</dd><dt>Party</dt><dd>${escapeHtml(party?.name??'Independent')}</dd><dt>Joined Democracy</dt><dd>${escapeHtml(formatDateTime(player.joinedAt))}</dd></dl><div class="grid grid-2"><section><h3>Political record</h3><p class="muted">${sponsoredLaws} law proposal${sponsoredLaws===1?'':'s'} · ${amendments} constitutional proposal${amendments===1?'':'s'}</p>${partyHistory.length?`<ul class="profile-history">${partyHistory.slice(0,8).map(item=>`<li><strong>${escapeHtml(state.parties[item.partyId]?.name??item.partyId)}</strong><span>${escapeHtml(item.reason)}</span></li>`).join('')}</ul>`:'<p class="muted">No party history.</p>'}</section><section><h3>Recent public activity</h3>${activity.length?`<ul class="profile-history">${activity.map(event=>`<li><strong>${escapeHtml(describeEvent(event,state))}</strong><span>${escapeHtml(formatDateTime(event.timestamp))}</span></li>`).join('')}</ul>`:'<p class="muted">No matching public activity yet.</p>'}</section></div>`;
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

  return `<section class="section card multiplayer-shell"><div class="section-header compact-header"><div><span class="page-kicker">Online game</span><h2>Cloud Multiplayer</h2><p class="muted">Create or join a room. Democracy Web handles signed identity, recovery and verification automatically.</p></div><div class="btn-row">${guideButton('multiplayer')}<span class="status ${connected?'status-active':cloud.connection==='error'?'status-error':'status-inactive'}">${escapeHtml(statusLabel)}</span></div></div>
    ${activeSession ? `<section class="connection-overview"><div><strong>Connection progress</strong><p class="muted">Each step must complete before official online actions are enabled.</p></div>${connectionJourney(cloud)}</section>` : ''}
    <div class="form-grid multiplayer-primary">
      ${sessionHtml}
      ${cloud.lastError ? `<div class="notice danger"><strong>Could not complete the connection</strong><p>${escapeHtml(cloud.lastError)}</p><div class="btn-row">${cloud.authenticated?'<button class="btn btn-primary" data-action="cloud-resync">Try verified recovery</button>':''}<button class="btn" data-route="help">Connection guide</button></div></div>` : ''}
      <details class="advanced-details"><summary>Advanced connection settings</summary><div class="advanced-panel"><div class="field"><label for="cloudApiBase">Cloud backend URL</label><input id="cloudApiBase" value="${escapeHtml(settings.apiBase)}" placeholder="https://your-worker.workers.dev" autocomplete="url"><small class="muted">Stored only in this browser.</small></div><dl class="kv"><dt>Connection state</dt><dd>${escapeHtml(cloud.connection||'offline')}</dd><dt>Authentication</dt><dd>${escapeHtml(roleLabel)}</dd><dt>State version</dt><dd>#${Number(cloud.stateVersion||0)}</dd><dt>Commit sequence</dt><dd>#${Number(cloud.commitSequence||0)}</dd><dt>Recovery source</dt><dd>${escapeHtml(cloud.recoverySource||'—')}</dd><dt>Clock RTT</dt><dd>${cloud.clockRttMs==null?'—':`${Number(cloud.clockRttMs)} ms`}</dd></dl><div class="btn-row"><button type="button" class="btn" data-action="cloud-save-settings">Save Backend URL</button><span id="cloudBackendSavedStatus" class="muted" aria-live="polite">Saved in this browser</span></div></div></details>
    </div>
  </section>`;
}

function multiplayerPage() {
  const state = getState();
  return `<section class="section-header"><div><h1>Multiplayer</h1><p class="muted">Publish a Democracy, invite players, and let Democracy Web handle the technical connection details.</p></div>${guideButton('multiplayer')}</section>${cloudMultiplayerCard(state)}<details class="section advanced-details"><summary>Player identity details</summary>${identityCard()}</details>`;
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



function helpPage() {
  const sections = Object.entries(HELP_GUIDES);
  return `<section class="section-header"><div><span class="page-kicker">Learn as you play</span><h1>Help & Guides</h1><p class="muted">Short explanations of the main systems. The Full Rulebook remains the source for exact constitutional wording.</p></div><div class="btn-row"><button class="btn btn-primary" data-action="start-onboarding">Replay introduction</button><button class="btn" data-action="toggle-ui-mode">Interface: <span data-ui-mode-label>${getUiMode()==='advanced'?'Advanced':'Simple'}</span></button><button class="btn" data-route="rulebook">Full Rulebook</button></div></section>
    <section class="section help-grid">${sections.map(([key,guide])=>`<article class="card help-card"><span class="help-icon">?</span><h2>${escapeHtml(guide.title)}</h2><p>${escapeHtml(guide.summary)}</p><button class="btn" data-action="show-guide" data-guide="${escapeHtml(key)}">Open guide</button></article>`).join('')}</section>
    <section class="section card"><div class="section-header compact-header"><div><h2>Glossary</h2><p class="muted">Common terms used throughout Democracy Web.</p></div></div><div class="glossary-grid">${GLOSSARY.map(([term,definition])=>`<article><strong>${escapeHtml(term)}</strong><p>${escapeHtml(definition)}</p></article>`).join('')}</div></section>
    <section class="section notice"><strong>Still unsure?</strong><p>Open the relevant page and use its <em>How this works</em> button. Contextual guides are designed to explain the process you are currently looking at.</p></section>`;
}

function releasePage() {
  const state = getState();
  const cloud = getCloudStatus();
  const checks = releaseReadiness(state, cloud);
  const passCount = checks.filter(item => item.ok).length;
  return `<section class="section-header"><div><span class="page-kicker">Frontend preview</span><h1>${escapeHtml(RELEASE_NAME)}</h1><p class="muted">Released ${escapeHtml(RELEASE_DATE)} · ${escapeHtml(RELEASE_CHANNEL)} channel</p></div><div class="btn-row"><button class="btn btn-primary" data-action="start-onboarding">Show Quick Start</button><button class="btn" data-action="copy-diagnostic-report">Copy Diagnostic Report</button><button class="btn" data-action="download-diagnostic-report">Download Diagnostics</button></div></section>
  <section class="section grid grid-3"><article class="card"><span class="page-kicker">Release readiness</span><h2>${passCount}/${checks.length}</h2><p class="muted">Checks currently passing on this browser/save.</p></article><article class="card"><span class="page-kicker">Version</span><h2>v${escapeHtml(APP_VERSION)}</h2><p class="muted">Cloud multiplayer release.</p></article><article class="card"><span class="page-kicker">Diagnostics</span><h2>${runtimeErrors.length}</h2><p class="muted">Runtime error(s) captured this session.</p></article></section>
  <section class="section card"><h2>Readiness checks</h2><ul class="list">${checks.map(item=>`<li class="list-row"><div><strong>${escapeHtml(item.label)}</strong><div class="muted">${escapeHtml(item.detail)}</div></div><span class="pill">${item.ok?'PASS':'CHECK'}</span></li>`).join('')}</ul></section>
  <section class="section grid grid-2"><article class="card"><h2>Release highlights</h2><ul>${RELEASE_HIGHLIGHTS.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></article><article class="card"><h2>Known limitations</h2><ul>${KNOWN_LIMITATIONS.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></article></section>
  <section class="section card"><h2>Feedback / bug reports</h2><p>Democracy Web does not need a feedback server. The diagnostic report contains build, browser, integrity and networking metadata without including ballot contents, private keys, room codes or save text.</p><p class="muted">If something breaks, copy or download the diagnostic report and attach it to your bug report along with the steps that caused the problem.</p></section>`;
}

function showOnboarding(force = false, stepIndex = 0) {
  if (!force && readLocalValue(ONBOARDING_KEY) === 'done') return;
  const step = ONBOARDING_STEPS[Math.min(stepIndex, ONBOARDING_STEPS.length - 1)];
  const finalStep = stepIndex >= ONBOARDING_STEPS.length - 1;
  showModal({
    title: step.title,
    body: `<div class="onboarding-progress" aria-label="Introduction progress">${ONBOARDING_STEPS.map((_,index)=>`<span class="${index<=stepIndex?'active':''}"></span>`).join('')}</div><div class="onboarding-step"><span class="onboarding-count">${stepIndex+1} / ${ONBOARDING_STEPS.length}</span><p>${escapeHtml(step.body)}</p></div>`,
    confirmText: finalStep ? 'Start Democracy' : 'Next',
    cancelText: stepIndex ? 'Close' : 'Skip',
    onConfirm() {
      if (finalStep) {
        writeLocalValue(ONBOARDING_KEY, 'done');
        navigate(hasGame() ? 'dashboard' : 'home');
        return;
      }
      requestAnimationFrame(()=>showOnboarding(true, stepIndex + 1));
    }
  });
}

function diagnosticText() {
  return buildDiagnosticReport({ state: getState(), networkStatus: getCloudStatus(), recentErrors: runtimeErrors });
}

function noGamePage() {
  return `<section class="empty"><h2>No game loaded</h2><p>Load or create a Democracy first.</p><div class="btn-row" style="justify-content:center"><button class="btn btn-primary" data-route="create">Create</button><button class="btn" data-route="load">Load</button></div></section>`;
}

function historyList(state, limit) {
  const integrityBanner = historyIntegrityBanner(state);
  const events = [...state.history].reverse().slice(0, limit);
  if (!events.length) return integrityBanner + '<div class="empty">No official events yet.</div>';
  return integrityBanner + `<ul class="list">${events.map(event => `<li class="list-row"><div><strong>${escapeHtml(describeEvent(event, state))}</strong><div class="muted">${escapeHtml(formatDateTime(event.timestamp))}</div></div><span class="pill">${escapeHtml(event.type)}</span></li>`).join('')}</ul>`;
}

registerRoute('home', homePage);
registerRoute('create', createPage);
registerRoute('load', loadPage);
registerRoute('about', aboutPage);
registerRoute('dashboard', dashboardPage);
registerRoute('actions', actionsPage);
registerRoute('activity', activityPage);
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
registerRoute('help', helpPage);
registerRoute('recovery', recoveryPage);
registerRoute('release', releasePage);
registerDetailRoute('vote','votes', voteDetailPage);
registerDetailRoute('election','elections', voteDetailPage);
registerDetailRoute('law','laws', lawDetailPage);
registerDetailRoute('amendment','constitution', amendmentDetailPage);
registerDetailRoute('constitution-section','constitution', constitutionSectionDetailPage);
registerDetailRoute('case','cases', caseDetailPage);
registerDetailRoute('committee','committees', committeeDetailPage);
registerDetailRoute('player','players', playerDetailPage);
registerDetailRoute('party','parties', partyDetailPage);

initRouter();

document.addEventListener('route:rendered', event => {
  requestAnimationFrame(()=>applyAllListTools());
  requestAnimationFrame(()=>decorateModalFields(document.querySelector('#view')));
  requestAnimationFrame(()=>applyConstitutionSearch(document.querySelector('#view')));
  setMobileMenu(false);
  rememberRecentRoute(event.detail.route);
  updateShellContext(getState());
  const activeButton = document.querySelector(`.side-nav [data-route="${CSS.escape(event.detail.route)}"]`);
  const activeGroup = activeButton?.closest('[data-nav-group]');
  if (activeGroup?.dataset.collapsed === 'true') {
    activeGroup.dataset.collapsed = 'false';
    activeGroup.querySelector('.nav-group-toggle')?.setAttribute('aria-expanded','true');
  }
  const heading=document.querySelector('#view h1, #view h2');
  document.title = heading ? `${heading.textContent} · Democracy Web` : 'Democracy Web';
  const mobileTitle=document.querySelector('#mobilePageTitle'); if(mobileTitle) mobileTitle.textContent=heading?.textContent?.trim() || 'Democracy Web';
  const detailRoute=event.detail.route !== event.detail.parentRoute;
  const parentLabel=NAV_DESTINATIONS.find(([route])=>route===event.detail.parentRoute)?.[1] || 'Democracy Web';
  const mobileKicker=document.querySelector('#mobilePageKicker'); if(mobileKicker) mobileKicker.textContent=detailRoute ? parentLabel : (getState()?.meta?.name || 'Democracy Web');
  const mobileBack=document.querySelector('#mobileBackButton'); if(mobileBack){ mobileBack.hidden=!detailRoute; mobileBackTarget=event.detail.parentRoute || 'dashboard'; }
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
subscribe(state => { refreshAttention(state, true); updateShellContext(state); if (location.hash === '#notifications') renderCurrentRoute(); });
subscribeCloudNetwork(() => { updateShellContext(getState()); if (['#multiplayer','#recovery','#release'].includes(location.hash)) renderCurrentRoute(); });
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
  requestAnimationFrame(()=>applyAllListTools());
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
  const palette = document.querySelector('#commandPalette');
  const paletteOpen = palette && !palette.hidden;
  const mobileMenu = document.querySelector('#mobileMenu');
  if (event.key === 'Escape' && mobileMenu?.classList.contains('is-open') && !paletteOpen) { event.preventDefault(); setMobileMenu(false); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (paletteOpen) closeCommandPalette(); else openCommandPalette();
    return;
  }
  if (!paletteOpen) return;
  if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveCommandSelection(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveCommandSelection(-1); return; }
  if (event.key === 'Enter' && document.activeElement?.id === 'commandSearchInput') { event.preventDefault(); activateCommandSelection(); }
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

document.addEventListener('click', event => {
  const command = event.target.closest('[data-command-route]');
  if (!command) return;
  event.preventDefault();
  closeCommandPalette();
  navigate(command.dataset.commandRoute);
});

document.addEventListener('input', event => {
  if (event.target?.id === 'commandSearchInput') { renderCommandPalette(event.target.value); return; }
  if (event.target?.matches?.('[data-constitution-search]')) { writeLocalValue(CONSTITUTION_SEARCH_KEY,event.target.value); applyConstitutionSearch(document.querySelector('#view')); return; }
  const page=event.target?.dataset?.listSearch; if(page){ writeListPref(page,{search:event.target.value}); applyListTools(page); }
});

document.addEventListener('change', event => {
  const filterPage=event.target?.dataset?.listFilter; if(filterPage){writeListPref(filterPage,{filter:event.target.value});applyListTools(filterPage);return;}
  const sortPage=event.target?.dataset?.listSort; if(sortPage){writeListPref(sortPage,{sort:event.target.value});applyListTools(sortPage);return;}
  if (event.target?.name === 'govParty') {
    const panel=document.querySelector('#coalitionLive'); const state=getState(); if(!panel||!state)return;
    const counts=partySeatCounts(state); const selected=[...document.querySelectorAll('input[name="govParty"]:checked')].map(i=>i.value);
    const seats=selected.reduce((sum,id)=>sum+(counts[id]??0),0); const filled=filledLegislativeSeats(state).length; const required=majorityThreshold(filled);
    const pct=filled?Math.min(100,seats/filled*100):0; panel.classList.toggle('has-majority',seats>=required);
    panel.querySelector('strong').textContent=`${seats} seat${seats===1?'':'s'} / ${required} needed`;
    const bar=panel.querySelector('.coalition-live-track span'); if(bar)bar.style.width=`${pct}%`;
    const marker=panel.querySelector('.coalition-live-track i'); if(marker)marker.style.left=`${filled?Math.min(100,required/filled*100):0}%`;
    const note=panel.querySelector('small'); if(note)note.textContent=seats>=required?`Majority reached with ${seats-required} seat${seats-required===1?'':'s'} above the threshold.`:`${required-seats} more seat${required-seats===1?'':'s'} needed for a majority.`;
  }
});

document.addEventListener('click', async event => {
  const element = event.target.closest('[data-action]');
  const action = element?.dataset.action;
  if (!action) return;

  const state = getState();

  if (action === 'install-app') { if(!deferredInstallPrompt){toast('Install is not currently offered by this browser.');return;} deferredInstallPrompt.prompt(); const result=await deferredInstallPrompt.userChoice; if(result.outcome==='accepted')toast('Democracy Web installed'); deferredInstallPrompt=null; return; }
  if (action === 'toggle-browser-notifications') { const enabled=element.checked; if(enabled){const permission=await requestBrowserPermission(); if(permission!=='granted'){element.checked=false;setBrowserNotifications(false);toast('Browser notification permission was not granted.','error');return;}} setBrowserNotifications(enabled); refreshAttention(state,true); toast(enabled?'Browser notifications enabled':'Browser notifications disabled'); return; }
  if (action === 'dismiss-notification') { dismissAttention(element.dataset.notificationId); refreshAttention(state,false); renderCurrentRoute(); return; }
  if (action === 'snooze-notification') { snoozeAttention(element.dataset.notificationId, getCloudNowMs()+3600000); refreshAttention(state,false); renderCurrentRoute(); toast('Reminder snoozed for 1 hour'); return; }
  if (action === 'clear-list-tools') { writeListPref(element.dataset.listPage,{search:'',filter:'all'}); renderCurrentRoute(); return; }
  if (action === 'set-list-view') { writeListPref(element.dataset.listPage,{view:element.dataset.listView}); renderCurrentRoute(); return; }
  if (action === 'set-law-workspace') { writeLocalValue(LAW_WORKSPACE_KEY,element.dataset.lawWorkspace); renderCurrentRoute(); return; }
  if (action === 'clear-constitution-search') { writeLocalValue(CONSTITUTION_SEARCH_KEY,''); const input=document.querySelector('[data-constitution-search]'); if(input) input.value=''; applyConstitutionSearch(document.querySelector('#view')); input?.focus(); return; }
  if (action === 'copy-current-link') { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast('Could not copy the link.','error'); } return; }
  if (action === 'clear-dismissed-notifications') { clearDismissed(); refreshAttention(state,false); renderCurrentRoute(); toast('Dismissed notifications restored'); return; }
  if (action === 'toggle-mobile-menu') { const menu=document.querySelector('#mobileMenu'); setMobileMenu(!menu?.classList.contains('is-open')); return; }
  if (action === 'mobile-back') { navigate(mobileBackTarget || 'dashboard', { restoreScroll:true }); return; }
  if (action === 'toggle-nav-group') { toggleNavGroup(element.dataset.navGroupName); return; }
  if (action === 'open-command-palette') { openCommandPalette(); return; }
  if (action === 'close-command-palette') { closeCommandPalette(); return; }
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

  if (action === 'start-onboarding') { showOnboarding(true, 0); return; }
  if (action === 'toggle-ui-mode') { const next=setUiMode(getUiMode()==='advanced'?'simple':'advanced'); toast(`${next==='advanced'?'Advanced':'Simple'} interface enabled`); renderCurrentRoute(); return; }
  if (action === 'show-guide') { showGuide(element.dataset.guide); return; }
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
    const snapshotId = element.dataset.snapshotId;
    showConsequenceModal({ title:'Restore this snapshot?', summary:'The current local Democracy state will move back to the selected recovery point.', consequences:['Create a safety snapshot of the current state first.','Replace the currently loaded local state with the selected snapshot.','Official changes made after that snapshot will no longer be present in the restored local copy.'], confirmText:'Restore Snapshot', danger:true, irreversible:false, state, async onConfirm(){
      try { const current=getState(); if(current) await createSnapshot(current,'pre-restore'); const restored=await restoreSnapshot(snapshotId); loadState(restored); await saveGame(restored); await refreshRecoveryData(false); toast(`Restored snapshot #${restored.stateVersion}`); renderCurrentRoute(); }
      catch(error) { toast(error.message,'error'); return false; }
    }});
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
    if (!actorId) { toast('Your local player identity is not ready yet.','error'); return; }
    const party=state.parties?.[state.players?.[actorId]?.partyId];
    showConsequenceModal({title:`Leave ${party?.name ?? 'party'}?`,summary:'Your player will become independent.',consequences:['End your current party membership.','Preserve your party membership history in the official record.'],confirmText:'Leave Party',danger:true,state,onConfirm(){try{dispatch({type:'PLAYER_LEFT_PARTY',actorId,playerId:actorId});toast('You left the party');renderCurrentRoute();}catch(error){toast(error.message,'error');return false;}}});
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
    showModal({ title: 'Rename game', body: `<div class="field"><label for="renameGameInput">Game name</label><input id="renameGameInput" required maxlength="80" value="${escapeHtml(state.meta.name)}"></div>`, confirmText: 'Rename', onConfirm(root) {
      try { dispatch({ type: 'GAME_RENAMED', actorId, name: root.querySelector('#renameGameInput').value }); toast('Game renamed'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'add-player') {
    showModal({ title: 'Add player', body: `<div class="field"><label for="newPlayerName">Display name</label><input id="newPlayerName" required maxlength="50" placeholder="Player name" autofocus></div>`, confirmText: 'Add Player', onConfirm(root) {
      try { dispatch({ type: 'PLAYER_ADDED', actorId, name: root.querySelector('#newPlayerName').value }); toast('Player added'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'rename-player') {
    const playerId = element.dataset.playerId;
    const player = state.players[playerId];
    showModal({ title: 'Rename player', body: `<div class="field"><label for="renamePlayerInput">Display name</label><input id="renamePlayerInput" required maxlength="50" value="${escapeHtml(player.displayName)}"></div>`, confirmText: 'Rename', onConfirm(root) {
      try { dispatch({ type: 'PLAYER_RENAMED', actorId, playerId, name: root.querySelector('#renamePlayerInput').value }); toast('Player renamed'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'set-inactive' || action === 'set-active') {
    const player=state.players?.[element.dataset.playerId];
    if(action==='set-inactive'){
      showConsequenceModal({title:`Mark ${player?.displayName ?? 'player'} inactive?`,summary:'Inactive players remain in the historical record but stop normal active participation.',consequences:['Change the player status to Inactive.','Keep their historical roles, events and records visible.'],confirmText:'Mark Inactive',danger:true,state,onConfirm(){try{dispatch({type:'PLAYER_STATUS_CHANGED',actorId,playerId:element.dataset.playerId,status:'inactive'});toast('Player marked inactive');}catch(error){toast(error.message,'error');return false;}}});
    }else{
      try { dispatch({ type: 'PLAYER_STATUS_CHANGED', actorId, playerId: element.dataset.playerId, status: 'active' }); toast('Player activated'); }
      catch (error) { toast(error.message, 'error'); }
    }
    return;
  }

  if (action === 'resign-player') {
    const player = state.players[element.dataset.playerId];
    showModal({ title: `Resign ${player.displayName}?`, body: '', summary:'This preserves the player and their history but permanently marks them as resigned.', actorLabel:state.players?.[actorId]?.displayName ?? '', consequenceItems:['End any current party membership.','Keep the player and their previous offices/history in the record.','Remove them from normal active-player participation.'], confirmText: 'Resign Player', danger: true, irreversible:true, onConfirm() {
      try { dispatch({ type: 'PLAYER_RESIGNED', actorId, playerId: player.id }); toast('Player resigned'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }

  if (action === 'view-player') {
    const player = state.players[element.dataset.playerId];
    showModal({ title: `Player Profile · ${player.displayName}`, body: playerProfileHtml(state, player), confirmText: 'Close', cancelText: 'Close', onConfirm() {} });
  }

  if (action === 'create-party') {
    const online = isOnlineGame();
    const eligible = Object.values(state.players).filter(p => p.status === 'active' && !p.partyId);
    const self = actorId ? state.players[actorId] : null;
    if (online && (!self || self.status !== 'active' || self.partyId)) { toast('Only your own active independent player can create a party online.', 'error'); return; }
    if (!online && !eligible.length) { toast('No active independent player is available to lead a new party.', 'error'); return; }
    showModal({ title: 'Create political party', body: `
      <div class="form-grid">
        <div class="field"><label for="partyName">Party name</label><input id="partyName" required maxlength="80" placeholder="Reform Party"></div>
        <div class="field"><label for="partyAbbr">Abbreviation</label><input id="partyAbbr" maxlength="10" placeholder="RP"></div>
        ${online ? `<div class="notice"><strong>Founding leader:</strong> ${escapeHtml(self.displayName)}<br><span class="muted">Online parties are always created by the connected player identity.</span></div>` : `<div class="field"><label for="partyLeader">Founding leader</label><select id="partyLeader">${eligible.map(p => `<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`}
        <div class="field"><label for="partyColour">Party colour</label><input id="partyColour" type="color" value="#475569"></div>
        <div class="field"><label for="partyDescription">Programme / description</label><textarea id="partyDescription" maxlength="500"></textarea></div>
      </div>`, eyebrow:'Party formation', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'create-party', review(root) { const leaderName=online?self.displayName:root.querySelector('#partyLeader')?.selectedOptions?.[0]?.textContent; return reviewRows([['Party',root.querySelector('#partyName').value],['Abbreviation',root.querySelector('#partyAbbr').value||'None'],['Founding leader',leaderName],['Colour',root.querySelector('#partyColour').value],['Description',root.querySelector('#partyDescription').value||'None']]); }, confirmText: 'Create Party', onConfirm(root) {
        try { const leaderId = online ? actorId : root.querySelector('#partyLeader').value; dispatch({ type: 'PARTY_CREATED', actorId, leaderId, name: root.querySelector('#partyName').value, abbreviation: root.querySelector('#partyAbbr').value, colour: root.querySelector('#partyColour').value, description: root.querySelector('#partyDescription').value }); toast('Party created'); }
        catch (error) { toast(error.message, 'error'); return false; }
      }});
    return;
  }

  if (action === 'edit-party') {
    const party = state.parties[element.dataset.partyId];
    showModal({ title: `Edit ${party.name}`, body: `
      <div class="form-grid">
        <div class="field"><label for="partyName">Party name</label><input id="partyName" required maxlength="80" value="${escapeHtml(party.name)}"></div>
        <div class="field"><label for="partyAbbr">Abbreviation</label><input id="partyAbbr" maxlength="10" value="${escapeHtml(party.abbreviation)}"></div>
        <div class="field"><label for="partyColour">Party colour</label><input id="partyColour" type="color" value="${safePartyColour(party.colour)}"></div>
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
      try { dispatch({ type: 'PARTY_MEMBER_REMOVED', actorId, playerId: button.dataset.partyMemberRemove, partyId: party.id }); toast('Player removed from party'); root.innerHTML = ''; document.body.classList.remove('modal-open'); renderCurrentRoute(); }
      catch (error) { toast(error.message, 'error'); }
    }));
    root.querySelector('[data-party-invite-member]')?.addEventListener('click', () => {
      const playerId = root.querySelector('#memberToInvite').value;
      if (!playerId) return toast('Select a player first.', 'error');
      try { dispatch({ type: 'PARTY_INVITE_SENT', actorId, playerId, partyId: party.id }); toast('Party invitation sent'); root.innerHTML = ''; document.body.classList.remove('modal-open'); refreshAttention(getState(), false); renderCurrentRoute(); }
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
    showModal({ title: `Dissolve ${party.name}?`, body: '', summary:'The party will remain in official history but will stop operating as an active political party.', actorLabel:state.players?.[actorId]?.displayName ?? '', consequenceItems:['Make every current member independent.','Prevent further edits to the dissolved party.','Preserve the party and its history in official records.'], confirmText: 'Dissolve Party', danger: true, irreversible:true, onConfirm() {
      try { dispatch({ type: 'PARTY_DISSOLVED', actorId, partyId: party.id }); toast('Party dissolved'); }
      catch (error) { toast(error.message, 'error'); return false; }
    }});
  }


  if (action === 'create-vote') {
    showModal({ title: 'Create vote', body: `
      <div class="form-grid">
        <div class="field"><label for="voteTitle">Title</label><input id="voteTitle" required maxlength="100" placeholder="Motion or referendum title"></div>
        <div class="field"><label for="voteType">Voting method</label><select id="voteType"><option value="yes-no">Yes / No</option><option value="yes-no-abstain">Yes / No / Abstain</option><option value="single-choice">Single choice</option><option value="ranked-choice">Ranked choice</option><option value="approval">Approval voting</option></select></div>
        <div class="field"><label for="voteOptions">Options / candidates</label><textarea id="voteOptions" placeholder="One option per line. Not required for Yes/No."></textarea></div>
        <div class="field"><label for="voteDuration">Duration (minutes)</label><input id="voteDuration" type="number" min="1" required value="1440"></div>
        <label class="check-row"><input id="voteSecret" type="checkbox"> Secret ballot</label>
      </div>`, eyebrow:'Vote setup', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'create-vote', review(root) { const method=root.querySelector('#voteType').selectedOptions[0]?.textContent; const type=root.querySelector('#voteType').value; const lines=root.querySelector('#voteOptions').value.split('\n').map(x=>x.trim()).filter(Boolean); const options=[VOTE_TYPES.YES_NO,VOTE_TYPES.YES_NO_ABSTAIN].includes(type)?'Built-in Yes / No choices':`${lines.length} option${lines.length===1?'':'s'}`; return reviewRows([['Title',root.querySelector('#voteTitle').value],['Voting method',method],['Options',options],['Duration',`${root.querySelector('#voteDuration').value} minutes`],['Ballot',root.querySelector('#voteSecret').checked?'Secret':'Public']]); }, confirmText: 'Create Draft', onConfirm(root) {
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
    showModal({ title:'Start Host removal petition?', body:'', summary:'This begins the constitutional Host removal process. A petition requires 20% of active players before the public removal vote can open.', actorLabel:state.players?.[actorId]?.displayName ?? '', consequenceItems:['Create an official Host-removal petition.','Allow eligible active players to sign it.','Open the public removal vote only if the constitutional signature threshold is reached.'], confirmText:'Start Petition', danger:true, irreversible:true, onConfirm(){ try { dispatch({type:'HOST_REMOVAL_PROPOSED',actorId}); toast('Host removal petition started'); } catch(error){ toast(error.message,'error'); return false; } }});
    return;
  }

  if (action === 'sign-host-removal') {
    const removal=state.hostRemoval;
    const eligible=Object.values(state.players).filter(p=>p.status==='active' && !(removal?.signatures??[]).includes(p.id));
    if (!eligible.length) { toast('No eligible unsigned players remain.'); return; }
    const online=isOnlineGame();
    if (online && (!actorId || !eligible.some(p=>p.id===actorId))) { toast('Your player has already signed or is not eligible to sign.', 'error'); return; }
    const body=online
      ? `<div class="field"><label>Signer</label><div class="readonly-value">${escapeHtml(state.players?.[actorId]?.displayName ?? 'Your player')}</div></div>`
      : `<div class="field"><label>Player</label><select id="hostRemovalSigner">${eligible.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`;
    showModal({ title:'Sign Host removal petition', body, confirmText:'Sign', onConfirm(root){ try { dispatch({type:'HOST_REMOVAL_SIGNED',actorId,playerId:online?actorId:root.querySelector('#hostRemovalSigner').value}); toast('Petition signed'); } catch(error){ toast(error.message,'error'); return false; } }});
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
        <div class="field"><label for="electionDuration">Duration (minutes)</label><input id="electionDuration" type="number" min="1" required value="2880"></div>
      </div>`, eyebrow:'Election setup', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'create-election', review(root) { const kind=root.querySelector('#electionKind').value; const label=root.querySelector('#electionKind').selectedOptions[0]?.textContent; const committee=kind===ELECTION_KINDS.COMMITTEE?root.querySelector('#committeeType').selectedOptions[0]?.textContent:null; const selected=[...root.querySelectorAll('input[name="candidate"]:checked')].map(input=>state.players[input.value]?.displayName ?? input.value); if(kind!==ELECTION_KINDS.GENERAL&&selected.length<2) throw new Error('Select at least two candidates before reviewing this election.'); if(kind===ELECTION_KINDS.GENERAL&&!activeParties.length) throw new Error('A general election requires at least one active political party.'); return reviewRows([['Election',label],...(committee?[['Committee',committee]]:[]),[kind===ELECTION_KINDS.GENERAL?'Electoral lists':'Candidates',kind===ELECTION_KINDS.GENERAL?activeParties.map(p=>p.name).join(', '):selected.join(', ')],['Duration',`${root.querySelector('#electionDuration').value} minutes`],['Ballot','Secret']]); }, confirmText: 'Create Election Draft', onConfirm(root) {
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
    const vote = state.votes[element.dataset.voteId];
    if (!vote) return;
    showConsequenceModal({ title:`Open ${vote.title}?`, summary:'Opening starts the official voting period.', consequences:['Freeze the eligible electorate snapshot used by this vote.','Start the configured voting deadline.','Allow eligible players to submit ballots.'].concat(vote.secret ? ['Prepare sealed-ballot encryption when secure browser cryptography is available.'] : []), confirmText:'Open Voting', state, async onConfirm(){
      try { let secretBoxPublicKey=null; if(vote.secret && hasSecureCrypto()){ const box=await createBallotBox(vote.id); secretBoxPublicKey=box.publicJwk; } dispatch({type:'VOTE_OPENED',actorId,voteId:vote.id,...(secretBoxPublicKey?{secretBoxPublicKey}:{})}); toast(vote.secret&&!secretBoxPublicKey?'Voting opened (LAN Test Mode: sealed encryption unavailable)':'Voting opened'); }
      catch(error){ toast(error.message,'error'); return false; }
    }});
    return;
  }

  if (action === 'pause-vote') {
    const vote=state.votes[element.dataset.voteId];
    showConsequenceModal({title:`Pause ${vote?.title ?? 'vote'}?`,summary:'Eligible voters will temporarily be unable to submit ballots.',consequences:['Pause ballot submission until voting is resumed.','Keep ballots already submitted in the official record.'],confirmText:'Pause Voting',state,onConfirm(){try{dispatch({type:'VOTE_PAUSED',actorId,voteId:element.dataset.voteId});toast('Voting paused');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'resume-vote') {
    try { dispatch({type:'VOTE_RESUMED', actorId, voteId:element.dataset.voteId}); toast('Voting resumed'); }
    catch(error) { toast(error.message,'error'); }
  }

  if (action === 'close-vote') {
    const vote=state.votes[element.dataset.voteId];
    if(!vote)return;
    showConsequenceModal({title:`Close and count ${vote.title}?`,summary:'Ballot submission will end and the result will be counted.',consequences:['Stop any further ballots from being submitted.','Count the ballots already received.'].concat(vote.secretBallotMode==='sealed-v1'?['Reveal the sealed ballot box locally for counting while preserving voter secrecy.']:[]),confirmText:'Close & Count',danger:true,irreversible:true,state,async onConfirm(){
      try { if(vote.secretBallotMode==='sealed-v1'&&!Array.isArray(vote.revealedChoices)){const reveal=await revealBallotBox(vote);const revealedChoices = [...reveal.choices];for(let i=revealedChoices.length-1;i>0;i-=1){const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[revealedChoices[i],revealedChoices[j]]=[revealedChoices[j],revealedChoices[i]];}dispatch({type:'VOTE_CLOSED',actorId,voteId:vote.id,revealedChoices});}else{dispatch({type:'VOTE_CLOSED',actorId,voteId:vote.id});}toast('Vote closed and counted'); }
      catch(error){toast(error.message,'error');return false;}
    }});
    return;
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
    const vote=state.votes[element.dataset.voteId];
    if(!vote)return;
    const effects=['Make the counted result official in the Democracy record.'];
    if(vote.electionKind==='general') effects.push('Apply the General Election result to Parliament and its seat allocation.');
    if(vote.electionKind==='host') effects.push('Apply the certified Host election result to the constitutional Host office.');
    if(vote.electionKind==='deputy-host') effects.push('Apply the certified result to the Deputy Host office.');
    if(vote.electionKind==='committee') effects.push(`Apply the certified result to the ${vote.committee ?? 'committee'} membership.`);
    if(vote.settings?.lawProposalId||vote.settings?.constitutionalProposalId||vote.settings?.caseId||vote.settings?.committeeMatterId) effects.push('Advance any linked law, constitutional, case, or committee procedure that depends on this result.');
    showConsequenceModal({title:`Certify ${vote.title}?`,summary:'Certification is the point at which this counted result becomes official.',consequences:effects,confirmText:'Certify Result',danger:true,irreversible:true,state,onConfirm(){try{dispatch({type:'VOTE_CERTIFIED',actorId,voteId:vote.id});toast('Result certified');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'resign-mp-seat') {
    const player = state.players[element.dataset.playerId];
    showModal({ title: `Vacate ${player?.displayName ?? 'MP'}'s seat?`, body: '', summary:'This permanently vacates the current parliamentary seat.', actorLabel:state.players?.[actorId]?.displayName ?? '', consequenceItems:['End the current MP’s occupancy of this seat.','Automatically seat the next eligible candidate from the same election list when one is available.','Record the vacancy/replacement in official state.'], confirmText: 'Vacate Seat', danger: true, irreversible:true, onConfirm() {
      try { dispatch({type:'MP_RESIGNED_SEAT', actorId, playerId:element.dataset.playerId}); toast('Legislative seat updated'); }
      catch(error) { toast(error.message,'error'); return false; }
    }});
  }

  if (action === 'create-legislative-vote') {
    showModal({ title:'New Parliamentary Vote', body:`<div class="form-grid"><div class="field"><label for="legVoteTitle">Motion title</label><input id="legVoteTitle" required maxlength="120" placeholder="Motion of confidence / parliamentary motion"></div><div class="field"><label for="legVoteDuration">Duration (minutes)</label><input id="legVoteDuration" type="number" min="1" required value="1440"></div><p class="muted">The electorate will be the sitting MPs when the vote opens. Passage requires more than half of all filled seats to vote Yes.</p></div>`, eyebrow:'Parliamentary motion', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'legislative-vote', consequenceItems:['Create a draft parliamentary vote.','Snapshot the sitting MPs only when the vote is later opened.'], review(root){return reviewRows([['Motion',root.querySelector('#legVoteTitle').value],['Voting duration',`${root.querySelector('#legVoteDuration').value} minutes`],['Electorate','Sitting MPs when voting opens'],['Threshold','More than half of all filled seats must vote Yes']]);}, confirmText:'Create Draft', onConfirm(root){
      try { dispatch({type:'LEGISLATIVE_VOTE_CREATED', actorId, title:root.querySelector('#legVoteTitle').value, durationMinutes:Number(root.querySelector('#legVoteDuration').value)}); toast('Parliamentary vote draft created'); }
      catch(error){ toast(error.message,'error'); return false; }
    }});
    return;
  }

  if (action === 'form-government') {
    const counts = partySeatCounts(state);
    const parties = Object.keys(counts).map(id=>state.parties[id]).filter(Boolean);
    if (!parties.length) return toast('No political parties hold filled seats.', 'error');
    const possiblePMs = Object.values(state.players).filter(p=>p.status==='active');
    const filledSeats = filledLegislativeSeats(state).length;
    const requiredSeats = majorityThreshold(filledSeats);
    const initialCoalitionSeats = (state.government.coalitionPartyIds ?? []).reduce((sum,id)=>sum+(counts[id]??0),0);
    showModal({ title: state.government.primeMinisterId ? 'Form replacement government' : 'Form government', body:`<div class="form-grid"><div class="field"><label>Governing parties</label><div class="candidate-picker">${parties.map(p=>`<label class="check-row"><input type="checkbox" name="govParty" value="${p.id}" ${state.government.coalitionPartyIds?.includes(p.id)?'checked':''}> <span class="colour-dot" style="--party-colour:${safePartyColour(p.colour)}"></span>${escapeHtml(p.name)} (${counts[p.id]} seats)</label>`).join('')}</div></div><div class="coalition-live${initialCoalitionSeats>=requiredSeats?' has-majority':''}" id="coalitionLive" aria-live="polite"><div><span>Selected coalition</span><strong>${initialCoalitionSeats} seat${initialCoalitionSeats===1?'':'s'} / ${requiredSeats} needed</strong></div><div class="coalition-live-track"><span style="width:${filledSeats?Math.min(100,initialCoalitionSeats/filledSeats*100):0}%"></span><i style="left:${filledSeats?Math.min(100,requiredSeats/filledSeats*100):0}%"></i></div><small>${initialCoalitionSeats>=requiredSeats?'Majority reached.':`${Math.max(0,requiredSeats-initialCoalitionSeats)} more seat${Math.max(0,requiredSeats-initialCoalitionSeats)===1?'':'s'} needed for a majority.`}</small></div><div class="field"><label for="govPM">Prime Minister</label><select id="govPM">${possiblePMs.map(p=>`<option value="${p.id}" ${p.id===state.government.primeMinisterId?'selected':''}>${escapeHtml(p.displayName)} — ${escapeHtml(state.parties[p.partyId]?.name ?? 'Independent')}</option>`).join('')}</select></div><p class="muted">The selected parties must control a majority of all filled legislative seats.</p></div>`, eyebrow:'Government formation', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'form-government', consequenceItems:state.government.primeMinisterId?['Replace the current government if the selected coalition is valid.','Update the Prime Minister and governing coalition.']:['Create the first active government for the current Parliament.','Set the Prime Minister and governing coalition.'], review(root){const partyIds=[...root.querySelectorAll('input[name="govParty"]:checked')].map(x=>x.value);if(!partyIds.length)throw new Error('Select at least one governing party.');const seats=partyIds.reduce((sum,id)=>sum+(counts[id]??0),0);const filled=filledLegislativeSeats(state).length;const required=majorityThreshold(filled);if(seats<required)throw new Error(`The selected coalition has ${seats} seat${seats===1?'':'s'}; ${required} are required for a majority.`);return reviewRows([['Coalition',partyIds.map(id=>state.parties[id]?.name??id).join(' + ')],['Coalition seats',`${seats} of ${filled}`],['Majority needed',String(required)],['Prime Minister',root.querySelector('#govPM').selectedOptions[0]?.textContent]]);}, confirmText:'Form Government', onConfirm(root){
      try { const partyIds=[...root.querySelectorAll('input[name="govParty"]:checked')].map(x=>x.value); dispatch({type:'GOVERNMENT_FORMED', actorId, partyIds, primeMinisterId:root.querySelector('#govPM').value}); toast('Government formed'); }
      catch(error){ toast(error.message,'error'); return false; }
    }});
  }

  if (action === 'create-confidence-vote') {
    showConsequenceModal({title:'Create a Vote of Confidence?',summary:'This creates a parliamentary vote draft; voting does not begin until the draft is opened.',consequences:['Create a 24-hour parliamentary confidence-vote draft.','Use the sitting MPs as the electorate when voting is opened.'],confirmText:'Create Confidence Vote',state,onConfirm(){try{dispatch({type:'LEGISLATIVE_VOTE_CREATED',actorId,title:'Vote of Confidence',durationMinutes:1440,motionKind:'confidence'});toast('Confidence vote draft created');navigate('parliament');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'create-no-confidence-vote') {
    const counts = partySeatCounts(state);
    const parties = Object.keys(counts).map(id=>state.parties[id]).filter(Boolean);
    const possiblePMs = Object.values(state.players).filter(p=>p.status==='active');
    showModal({ title:'Constructive No-Confidence Motion', body:`<div class="form-grid"><div class="field"><label>Replacement coalition</label><div class="candidate-picker">${parties.map(p=>`<label class="check-row"><input type="checkbox" name="replacementParty" value="${p.id}"> <span class="colour-dot" style="--party-colour:${safePartyColour(p.colour)}"></span>${escapeHtml(p.name)} (${counts[p.id]} seats)</label>`).join('')}</div></div><div class="field"><label for="replacementPM">Proposed replacement Prime Minister</label><select id="replacementPM">${possiblePMs.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)} — ${escapeHtml(state.parties[p.partyId]?.name ?? 'Independent')}</option>`).join('')}</select></div><p class="muted">If the motion passes with a legislative majority, the proposed coalition immediately replaces the current government.</p></div>`, eyebrow:'Parliamentary motion', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'constructive-no-confidence', consequenceItems:['Create a parliamentary vote on replacing the current government.','If the motion later passes, the proposed coalition and Prime Minister replace the current government immediately.'], review(root){const ids=[...root.querySelectorAll('input[name="replacementParty"]:checked')].map(x=>x.value);if(!ids.length)throw new Error('Select at least one replacement party.');const seats=ids.reduce((sum,id)=>sum+(counts[id]??0),0);return reviewRows([['Replacement coalition',ids.map(id=>state.parties[id]?.name??id).join(' + ')],['Current seats',String(seats)],['Proposed Prime Minister',root.querySelector('#replacementPM').selectedOptions[0]?.textContent],['Vote duration','1440 minutes']]);}, confirmText:'Create Motion', onConfirm(root){
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
    if(!eligible.length){toast('No eligible active player is available for a new ministerial appointment.','error');return;}
    showModal({ title:'Appoint Minister', body:`<div class="form-grid"><div class="field"><label for="ministerPlayer">Player</label><select id="ministerPlayer">${eligible.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div><div class="field"><label for="ministerPortfolio">Portfolio</label><input id="ministerPortfolio" required maxlength="60" placeholder="Finance"></div></div>`, eyebrow:'Government appointment', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:'appoint-minister', consequenceItems:['Create an official ministerial appointment for the selected player.','Record the portfolio and appointment in government history.'], review(root){return reviewRows([['Minister',root.querySelector('#ministerPlayer').selectedOptions[0]?.textContent],['Portfolio',root.querySelector('#ministerPortfolio').value]]);}, confirmText:'Appoint Minister', onConfirm(root){
      try { dispatch({type:'MINISTER_APPOINTED', actorId, playerId:root.querySelector('#ministerPlayer').value, portfolio:root.querySelector('#ministerPortfolio').value}); toast('Minister appointed'); }
      catch(error){toast(error.message,'error'); return false;}
    }});
    return;
  }

  if (action === 'dismiss-minister') {
    const minister=state.players?.[element.dataset.playerId];
    showConsequenceModal({title:`Dismiss ${minister?.displayName ?? 'minister'}?`,summary:'This removes the player from their ministerial office.',consequences:['End the selected ministerial appointment.','Keep the appointment and dismissal in official history.'],confirmText:'Dismiss Minister',danger:true,state,onConfirm(){try{dispatch({type:'MINISTER_DISMISSED',actorId,playerId:element.dataset.playerId});toast('Minister dismissed');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'set-caretaker') {
    showConsequenceModal({title:'Move the Government into caretaker status?',summary:'Caretaker status changes how the current government is represented and starts the constitutional formation context.',consequences:['Mark the current government as caretaker.','Expose the caretaker deadline and formation guidance in the Government interface.'],confirmText:'Set Caretaker',danger:true,state,onConfirm(){try{dispatch({type:'GOVERNMENT_SET_CARETAKER',actorId,reason:'manual'});toast('Government is now caretaker');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }


  if (action === 'create-law-proposal' || action === 'create-citizen-initiative') {
    const pathway = action === 'create-citizen-initiative' ? 'citizen-initiative' : 'legislative';
    showModal({ title: pathway === 'citizen-initiative' ? "Create Citizens' Initiative" : 'Propose Law', body:`<div class="form-grid"><div class="field"><label for="lawTitle">Title</label><input id="lawTitle" required maxlength="120" placeholder="Public Parks Act"></div>${pathway==='legislative'?`<div class="field"><label for="lawSponsorRoute">Proposal route</label><select id="lawSponsorRoute"><option value="petition">10% public sponsorship petition</option><option value="government">Running Government</option><option value="represented-party">Electoral List with a Parliament seat</option></select></div>`:''}<div class="field"><label for="lawText">Complete proposed wording</label><textarea id="lawText" rows="8" required></textarea></div><div class="field"><label for="lawReason">Reason</label><textarea id="lawReason" rows="4" required></textarea></div><p class="muted">A 24-hour discussion period begins immediately. The wording may be edited until it is frozen.</p></div>`, eyebrow:pathway==='citizen-initiative'?"Citizens' initiative":'Legislation', actorLabel:state.players?.[actorId]?.displayName ?? '', draftKey:pathway==='citizen-initiative'?'citizen-initiative':'law-proposal', review(root){return reviewRows([['Title',root.querySelector('#lawTitle').value],['Route',pathway==='legislative'?root.querySelector('#lawSponsorRoute').selectedOptions[0]?.textContent:"Citizens' initiative"],['Proposed wording',`${root.querySelector('#lawText').value.length} characters`],['Reason',root.querySelector('#lawReason').value],['Discussion period','24 hours']]);}, consequenceItems:['Publish the proposal into the official record.','Begin the 24-hour discussion process or sponsorship route required by the selected pathway.'], confirmText:'Publish Proposal', onConfirm(root){
      try { dispatch({type:'LAW_PROPOSED', actorId, title:root.querySelector('#lawTitle').value, text:root.querySelector('#lawText').value, reason:root.querySelector('#lawReason').value, pathway, sponsorRoute:pathway==='legislative'?root.querySelector('#lawSponsorRoute').value:'citizen-initiative'}); toast('Law proposal published'); }
      catch(error){toast(error.message,'error'); return false;}
    }});
  }

  if (action === 'edit-law-proposal') {
    const p=state.lawProposals[element.dataset.proposalId];
    showModal({title:`Edit ${p.id}`,body:`<div class="form-grid"><div class="field"><label>Title</label><input id="editLawTitle" required maxlength="120" value="${escapeHtml(p.title)}"></div><div class="field"><label>Wording</label><textarea id="editLawText" rows="8" required>${escapeHtml(p.text)}</textarea></div><div class="field"><label>Reason</label><textarea id="editLawReason" rows="4" required>${escapeHtml(p.reason)}</textarea></div></div>`,eyebrow:'Edit proposal',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:`edit-law:${p.id}`,review(root){return reviewRows([['Proposal',p.id],['Title',root.querySelector('#editLawTitle').value],['Wording',`${root.querySelector('#editLawText').value.length} characters`],['Reason',root.querySelector('#editLawReason').value]]);},confirmText:'Save Changes',onConfirm(root){try{dispatch({type:'LAW_PROPOSAL_UPDATED',actorId,proposalId:p.id,title:root.querySelector('#editLawTitle').value,text:root.querySelector('#editLawText').value,reason:root.querySelector('#editLawReason').value});toast('Proposal updated');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'finalize-law-proposal') {
    const proposal=state.lawProposals?.[element.dataset.proposalId];
    showConsequenceModal({title:`Freeze ${proposal?.title ?? 'this proposal'}?`,summary:'Finalising ends the editable discussion stage and locks the wording used by the next formal step.',consequences:['Freeze the current title, wording and reason.','Prevent further proposal edits.','Advance the proposal into its next constitutional stage when the rules permit.'],confirmText:'Freeze Proposal',danger:true,irreversible:true,state,onConfirm(){try{dispatch({type:'LAW_PROPOSAL_FINALIZED',actorId,proposalId:element.dataset.proposalId});toast('Proposal frozen');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }


  if (action === 'sign-law-proposal') {
    const active=Object.values(state.players).filter(p=>p.status==='active');
    const online=isOnlineGame();
    const body=online
      ? `<div class="field"><label>Signer</label><div class="readonly-value">${escapeHtml(state.players?.[actorId]?.displayName ?? 'Your player')}</div></div>`
      : `<div class="field"><label>Player</label><select id="lawProposalSigner">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`;
    showModal({title:'Sign Law Proposal Petition',body,confirmText:'Sign',onConfirm(root){try{dispatch({type:'LAW_PROPOSAL_PETITION_SIGNED',actorId,proposalId:element.dataset.proposalId,playerId:online?actorId:root.querySelector('#lawProposalSigner').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'sign-law-referendum' || action === 'sign-initiative') {
    const proposalId=element.dataset.proposalId;
    const active=Object.values(state.players).filter(p=>p.status==='active');
    const online=isOnlineGame();
    const body=online
      ? `<div class="field"><label>Signer</label><div class="readonly-value">${escapeHtml(state.players?.[actorId]?.displayName ?? 'Your player')}</div></div>`
      : `<div class="field"><label for="signaturePlayer">Player</label><select id="signaturePlayer">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`;
    showModal({title:'Add Signature',body,confirmText:'Sign',onConfirm(root){try{dispatch({type:action==='sign-law-referendum'?'LAW_REFERENDUM_PETITION_SIGNED':'CITIZEN_INITIATIVE_SIGNED',actorId,proposalId,playerId:online?actorId:root.querySelector('#signaturePlayer').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'refer-law') {
    const proposal=state.lawProposals?.[element.dataset.proposalId] ?? state.proposals?.[element.dataset.proposalId];
    showConsequenceModal({title:'Refer this proposal to a public referendum?',summary:'This moves the proposal into a binding public vote where the rules allow it.',consequences:['Create the linked public referendum.','Move the proposal forward to its referendum stage.'],confirmText:'Create Referendum',state,onConfirm(){try{dispatch({type:'LAW_REFERRED_TO_REFERENDUM',actorId,proposalId:element.dataset.proposalId});toast('Public referendum created');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'check-law-window') {
    showConsequenceModal({title:'Bring this law into force?',summary:'The referendum petition window will be checked before enactment.',consequences:['Verify that the constitutional referendum window has expired without a successful referral.','If eligible, add the final text to the statute book as law in force.'],confirmText:'Bring Into Force',danger:true,irreversible:true,state,onConfirm(){try{dispatch({type:'CHECK_LAW_REFERENDUM_WINDOW',actorId,proposalId:element.dataset.proposalId});toast('Law brought into force');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'amend-law' || action === 'repeal-law') {
    const law=state.laws[element.dataset.lawId];
    const repeal=action==='repeal-law';
    showModal({title:`${repeal?'Repeal':'Amend'} ${law.id}`,body:`<div class="form-grid"><div class="field"><label>Title</label><input id="changeLawTitle" required maxlength="120" value="${escapeHtml(law.title)}" ${repeal?'readonly':''}></div><div class="field"><label>${repeal?'Repeal wording / statement':'Replacement wording'}</label><textarea id="changeLawText" rows="8" required>${escapeHtml(repeal?`Repeal ${law.id} — ${law.title}.`:law.text)}</textarea></div><div class="field"><label>Reason</label><textarea id="changeLawReason" rows="4" required></textarea></div><div class="field"><label>Proposal route</label><select id="changeLawSponsorRoute"><option value="petition">10% public sponsorship petition</option><option value="government">Running Government</option><option value="represented-party">Electoral List with a Parliament seat</option></select></div></div>`,eyebrow:repeal?'Law repeal':'Law amendment',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:`${repeal?'repeal':'amend'}-law:${law.id}`,review(root){return reviewRows([['Law',`${law.id} — ${law.title}`],['Change',repeal?'Repeal':'Amend'],['Route',root.querySelector('#changeLawSponsorRoute').selectedOptions[0]?.textContent],['Replacement text',`${root.querySelector('#changeLawText').value.length} characters`],['Reason',root.querySelector('#changeLawReason').value]]);},consequenceItems:['Publish a new proposal linked to the existing law.','Start the normal legislative sponsorship/discussion process rather than changing the law immediately.'],confirmText:'Publish Proposal',onConfirm(root){try{dispatch({type:'LAW_PROPOSED',actorId,title:root.querySelector('#changeLawTitle').value,text:root.querySelector('#changeLawText').value,reason:root.querySelector('#changeLawReason').value,changeKind:repeal?'repeal':'amend',targetLawId:law.id,pathway:'legislative',sponsorRoute:root.querySelector('#changeLawSponsorRoute').value});toast('Proposal published');}catch(error){toast(error.message,'error');return false;}}});
  }


  if (action === 'create-base-unlock') {
    showModal({title:'Propose Base Rule Unlock',body:`<div class="form-grid"><div class="field"><label>Base section number</label><input id="unlockSection" required placeholder="4"></div><div class="field"><label>Section title</label><input id="unlockTitle"></div><div class="field"><label>Initiation route</label><select id="unlockRoute"><option value="host">Host proposal</option><option value="petition">25% public petition</option></select></div><div class="field"><label>Reason</label><textarea id="unlockReason" rows="4" required></textarea></div><p class="muted">After initiation, the Actions Committee must approve by at least two-thirds of its full non-recused membership through a real committee vote. A public vote then requires 75% approval and 50% turnout.</p></div>`,eyebrow:'Protected constitutional procedure',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:'base-rule-unlock',review(root){return reviewRows([['Base section',root.querySelector('#unlockSection').value],['Section title',root.querySelector('#unlockTitle').value||'Not specified'],['Initiation route',root.querySelector('#unlockRoute').selectedOptions[0]?.textContent],['Reason',root.querySelector('#unlockReason').value],['Next stage','Actions Committee approval']]);},consequenceItems:['Create the protected Base Rule unlock proposal.','Require the Actions Committee stage before any public vote can occur.'],confirmText:'Create Unlock Proposal',onConfirm(root){try{dispatch({type:'CONSTITUTION_BASE_UNLOCK_PROPOSED',actorId,section:root.querySelector('#unlockSection').value,sectionTitle:root.querySelector('#unlockTitle').value,initiatedBy:root.querySelector('#unlockRoute').value,reason:root.querySelector('#unlockReason').value});toast('Base-rule unlock proposed');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'sign-base-unlock') {
    const active=Object.values(state.players).filter(p=>p.status==='active');
    const online=isOnlineGame();
    const body=online
      ? `<div class="field"><label>Signer</label><div class="readonly-value">${escapeHtml(state.players?.[actorId]?.displayName ?? 'Your player')}</div></div>`
      : `<div class="field"><label>Player</label><select id="unlockSigner">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`;
    showModal({title:'Sign Base Rule Petition',body,confirmText:'Sign',onConfirm(root){try{dispatch({type:'CONSTITUTION_BASE_UNLOCK_SIGNED',actorId,proposalId:element.dataset.proposalId,playerId:online?actorId:root.querySelector('#unlockSigner').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'create-amendment') {
    showModal({title:'Propose Constitutional Amendment',body:`<div class="form-grid"><div class="field"><label>Section number</label><input id="amdSection" required placeholder="20"></div><div class="field"><label>Section title</label><input id="amdTitle" placeholder="Legislative Term"></div><div class="field"><label>Proposal route</label><select id="amdSponsorRoute"><option value="petition">10% public petition</option><option value="government">Running Government</option><option value="represented-party">Electoral List with a Parliament seat</option></select></div><div class="field"><label>Category</label><select id="amdCategory"><option value="EDITABLE">EDITABLE</option><option value="BASE">BASE (cannot be directly amended)</option></select></div><div class="field"><label>Current wording</label><textarea id="amdCurrent" rows="6" required></textarea></div><div class="field"><label>Proposed wording</label><textarea id="amdProposed" rows="6" required></textarea></div><div class="field"><label>Reason</label><textarea id="amdReason" rows="4" required></textarea></div><p class="muted">Normal amendments require 48 hours of discussion, 66% approval and 25% turnout. Base provisions must first be made editable through their separate protected procedure.</p></div>`,eyebrow:'Constitutional amendment',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:'constitutional-amendment',review(root){if(root.querySelector('#amdCategory').value==='BASE')throw new Error('Base provisions cannot be directly amended. Use the protected Base Rule unlock procedure first.');return reviewRows([['Section',root.querySelector('#amdSection').value],['Title',root.querySelector('#amdTitle').value||'Not specified'],['Route',root.querySelector('#amdSponsorRoute').selectedOptions[0]?.textContent],['Category',root.querySelector('#amdCategory').value],['Current wording',`${root.querySelector('#amdCurrent').value.length} characters`],['Proposed wording',`${root.querySelector('#amdProposed').value.length} characters`],['Reason',root.querySelector('#amdReason').value],['Discussion','48 hours']]);},consequenceItems:['Publish the amendment proposal into the official constitutional process.','Begin the required sponsorship/discussion path before the amendment can be frozen for a public vote.'],confirmText:'Publish Amendment',onConfirm(root){try{dispatch({type:'CONSTITUTION_AMENDMENT_PROPOSED',actorId,section:root.querySelector('#amdSection').value,sectionTitle:root.querySelector('#amdTitle').value,category:root.querySelector('#amdCategory').value,currentText:root.querySelector('#amdCurrent').value,proposedText:root.querySelector('#amdProposed').value,reason:root.querySelector('#amdReason').value,sponsorRoute:root.querySelector('#amdSponsorRoute').value});toast('Amendment published');}catch(error){toast(error.message,'error');return false;}}});
  }


  if (action === 'sign-amendment-petition') {
    const active=Object.values(state.players).filter(p=>p.status==='active');
    const online=isOnlineGame();
    const body=online
      ? `<div class="field"><label>Signer</label><div class="readonly-value">${escapeHtml(state.players?.[actorId]?.displayName ?? 'Your player')}</div></div>`
      : `<div class="field"><label>Player</label><select id="amdSigner">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`;
    showModal({title:'Sign Amendment Petition',body,confirmText:'Sign',onConfirm(root){try{dispatch({type:'CONSTITUTION_AMENDMENT_PETITION_SIGNED',actorId,proposalId:element.dataset.proposalId,playerId:online?actorId:root.querySelector('#amdSigner').value});toast('Signature recorded');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'edit-amendment') {
    const p=state.constitution.proposals[element.dataset.proposalId];
    showModal({title:`Edit ${p.id}`,body:`<div class="form-grid"><div class="field"><label>Proposed wording</label><textarea id="editAmdText" rows="8" required>${escapeHtml(p.proposedText)}</textarea></div><div class="field"><label>Reason</label><textarea id="editAmdReason" rows="4" required>${escapeHtml(p.reason)}</textarea></div></div>`,eyebrow:'Edit constitutional proposal',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:`edit-amendment:${p.id}`,review(root){return reviewRows([['Amendment',p.id],['Proposed wording',`${root.querySelector('#editAmdText').value.length} characters`],['Reason',root.querySelector('#editAmdReason').value]]);},confirmText:'Save Changes',onConfirm(root){try{dispatch({type:'CONSTITUTION_AMENDMENT_UPDATED',actorId,proposalId:p.id,proposedText:root.querySelector('#editAmdText').value,reason:root.querySelector('#editAmdReason').value});toast('Amendment updated');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'finalize-amendment') {
    const proposal=state.constitution?.proposals?.[element.dataset.proposalId];
    showConsequenceModal({title:`Freeze ${proposal?.id ?? 'amendment'} for voting?`,summary:'Finalising ends the editable discussion stage and creates the constitutional vote.',consequences:['Freeze the proposed wording so it can no longer be edited.','Create the linked constitutional public vote using the required thresholds.'],confirmText:'Freeze & Create Vote',danger:true,irreversible:true,state,onConfirm(){try{dispatch({type:'CONSTITUTION_AMENDMENT_FINALIZED',actorId,proposalId:element.dataset.proposalId});toast('Amendment frozen and vote created');}catch(error){toast(error.message,'error');return false;}}});
    return;
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
      ballotFields = `<div class="field"><label>Rank candidates</label><small>Choose 1 for your first preference. Leave anyone blank if you do not want to rank them.</small><div class="ranked-ballot-list">${vote.options.map((o,index)=>{const candidate=state.players?.[o.id];const party=candidate?.partyId?state.parties?.[candidate.partyId]:null;return `<div class="rank-row"><span><strong>${escapeHtml(o.label)}</strong>${party?`<small>${escapeHtml(party.name)}</small>`:''}</span><label><span class="sr-only">Rank for ${escapeHtml(o.label)}</span><select data-rank-option="${o.id}"><option value="">—</option>${vote.options.map((_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label></div>`}).join('')}</div></div>`;
    }
    const onlineBallot = isOnlineGame();
    const ballotActor = localActorId(state);
    const voterControl = onlineBallot
      ? `<div class="field"><label>Voter</label><input id="ballotVoter" type="hidden" value="${escapeHtml(ballotActor || '')}"><div class="readonly-value">${escapeHtml(state.players?.[ballotActor]?.displayName || 'Local identity not ready')}</div></div>`
      : `<div class="field"><label for="ballotVoter">Voter</label><select id="ballotVoter">${eligible.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}${(vote.secretBallotMode === 'sealed-v1' ? vote.submittedVoters?.[p.id] : vote.ballots[p.id]) ? ' — ballot already submitted' : ''}</option>`).join('')}</select></div>`;
    if (onlineBallot && (!ballotActor || !vote.electorateSnapshot?.includes(ballotActor))) return toast('Your local player is not eligible to vote in this ballot.', 'error');
    showModal({ title: vote.title, body:`<div class="form-grid">${voterControl}${ballotFields}<p class="muted">${vote.secretBallotMode === 'sealed-v1' ? 'This is a sealed secret ballot. Your choice is encrypted in this browser before submission and cannot be changed after it is submitted.' : vote.secret ? 'This is a secret ballot. Individual choices are hidden from normal result displays.' : 'This is a public ballot.'}</p></div>`, eyebrow:'Official ballot', actorLabel:onlineBallot?(state.players?.[ballotActor]?.displayName ?? ''):'', review(root){const choice=readBallotChoice(vote,root);const voterId=root.querySelector('#ballotVoter').value;return reviewRows([['Voter',state.players?.[voterId]?.displayName ?? voterId],['Your ballot',ballotChoiceSummary(vote,choice)],['Privacy',vote.secretBallotMode==='sealed-v1'?'Sealed secret ballot':vote.secret?'Secret ballot':'Public ballot'],['Deadline',formatDateTime(vote.closesAt)]]);}, consequenceItems:vote.secretBallotMode==='sealed-v1'?['Encrypt your ballot in this browser before submission.','Record that this voter has submitted without exposing the choice in normal result displays.']:['Submit this ballot to the official vote record.'], irreversible:vote.secretBallotMode==='sealed-v1', confirmText:'Submit Ballot', async onConfirm(root){
      try {
        const choice=readBallotChoice(vote,root);
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
    showModal({title:`New ${code} Matter`,body:`<div class="field"><label>Title</label><input id="matterTitle" required maxlength="120"></div><div class="field"><label>Description</label><textarea id="matterDescription" rows="5" maxlength="1200"></textarea></div>`,eyebrow:committeeLongName(code),actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:`committee-matter:${code}`,consequenceItems:[`Open a formal matter in the ${committeeLongName(code)} record.`,'Allow the committee to apply recusals and later open a formal committee vote.'],review(root){return reviewRows([['Committee',`${code} — ${committeeLongName(code)}`],['Matter',root.querySelector('#matterTitle').value],['Description',root.querySelector('#matterDescription').value||'No description supplied'],['Initial status','Open']]);},confirmText:'Create Matter',onConfirm(root){try{dispatch({type:'COMMITTEE_MATTER_CREATED',actorId,committee:code,title:root.querySelector('#matterTitle').value,description:root.querySelector('#matterDescription').value});toast('Matter created');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'recuse-committee-member') {
    const code=element.dataset.committee; const c=state.committees[code];
    showModal({title:'Recuse Committee Member',body:`<div class="field"><label>Member</label><select id="recuseMember">${c.members.map(id=>`<option value="${id}">${escapeHtml(state.players[id]?.displayName??id)}</option>`).join('')}</select></div>`,eyebrow:`${code} decision membership`,actorLabel:state.players?.[actorId]?.displayName ?? '',summary:'A recused member is excluded from the Decision Membership for this matter.',consequenceItems:['Exclude the selected member from participating in this matter’s formal decision.','Change the membership used to calculate the committee majority for this matter.'],review(root){return reviewRows([['Committee',`${code} — ${committeeLongName(code)}`],['Matter',element.dataset.matterId],['Member to recuse',root.querySelector('#recuseMember').selectedOptions[0]?.textContent]]);},confirmText:'Record Recusal',danger:true,onConfirm(root){try{dispatch({type:'COMMITTEE_MEMBER_RECUSED',actorId,committee:code,matterId:element.dataset.matterId,playerId:root.querySelector('#recuseMember').value});toast('Recusal recorded');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'create-committee-vote') {
    const code=element.dataset.committee; const matterId=element.dataset.matterId; const committee=state.committees?.[code]; const matter=committee?.matters?.find(m=>m.id===matterId); const eligible=(committee?.members??[]).filter(id=>!(matter?.recusedIds??[]).includes(id));
    showConsequenceModal({title:`Open ${code} vote?`,summary:`This starts the formal decision vote for “${matter?.title ?? matterId}”.`,consequences:[`Use the ${eligible.length} non-recused committee member${eligible.length===1?'':'s'} as the eligible Decision Membership.`,'Open a 72-hour formal committee vote.','Link the resulting vote permanently to this committee matter.'],confirmText:'Open Committee Vote',state,onConfirm(){try{dispatch({type:'COMMITTEE_VOTE_CREATED',actorId,committee:code,matterId});toast('Committee vote created');navigate('votes');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'create-base-unlock-ac-vote') {
    const proposalId=element.dataset.proposalId;
    showConsequenceModal({title:'Open Actions Committee approval vote?',summary:'This is the protected AC stage for a Base Rule unlock proposal.',consequences:['Open a 72-hour Actions Committee vote.','Require at least two-thirds approval of the full eligible Actions Committee membership before the proposal can advance.','Link this formal AC vote to the Base Rule unlock proposal.'],confirmText:'Open AC Vote',state,onConfirm(){try{dispatch({type:'CONSTITUTION_BASE_UNLOCK_AC_VOTE_CREATED',actorId,proposalId});toast('Actions Committee approval vote created');navigate('votes');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }

  if (action === 'open-case') {
    const active=Object.values(state.players).filter(p=>p.status==='active'); const laws=Object.values(state.laws).filter(l=>l.status==='in-force');
    if(active.length<2||!laws.length){toast('At least two active players and one law in force are required.','error');return;}
    const online=isOnlineGame();
    const complainantField=online
      ? `<div class="field"><label>Complainant</label><div class="readonly-value">${escapeHtml(state.players?.[actorId]?.displayName ?? 'Your player')}</div></div>`
      : `<div class="field"><label>Complainant</label><select id="caseComplainant">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>`;
    showModal({title:'Open Law Case',body:`<div class="form-grid"><div class="field"><label>Accused</label><select id="caseAccused">${active.map(p=>`<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join('')}</select></div>${complainantField}<div class="field"><label>Law</label><select id="caseLaw">${laws.map(l=>`<option value="${l.id}">${escapeHtml(l.id)} — ${escapeHtml(l.title)}</option>`).join('')}</select></div><div class="field"><label>Alleged conduct</label><textarea id="caseConduct" rows="4" required></textarea></div><div class="field"><label>Evidence</label><textarea id="caseEvidence" rows="5"></textarea></div></div>`,eyebrow:'Ordinary-law case',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:'open-law-case',review(root){const accused=root.querySelector('#caseAccused').selectedOptions[0]?.textContent;const complainant=online?(state.players?.[actorId]?.displayName??'Your player'):root.querySelector('#caseComplainant').selectedOptions[0]?.textContent;if(online&&root.querySelector('#caseAccused').value===actorId)throw new Error('The complainant and accused should be different players.');return reviewRows([['Complainant',complainant],['Accused',accused],['Law',root.querySelector('#caseLaw').selectedOptions[0]?.textContent],['Alleged conduct',root.querySelector('#caseConduct').value],['Evidence',root.querySelector('#caseEvidence').value||'No evidence text supplied'],['Next stage','Case opened for response and PAC procedure']]);},consequenceItems:['Create an official case record naming the complainant, accused player and law.','Begin the ordinary-law case procedure; this does not itself determine guilt.'],confirmText:'Open Case',onConfirm(root){try{dispatch({type:'CASE_OPENED',actorId,accusedId:root.querySelector('#caseAccused').value,complainantId:online?actorId:root.querySelector('#caseComplainant').value,lawId:root.querySelector('#caseLaw').value,conduct:root.querySelector('#caseConduct').value,evidence:root.querySelector('#caseEvidence').value});toast('Case opened');}catch(error){toast(error.message,'error');return false;}}});
  }

  if (action === 'case-response') {
    showModal({title:'Record Accused Response',body:'<div class="field"><label>Response</label><textarea id="caseResponse" rows="6"></textarea></div>',eyebrow:'Case response',actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:`case-response:${element.dataset.caseId}`,review(root){return reviewRows([['Case',element.dataset.caseId],['Response',root.querySelector('#caseResponse').value||'Blank response']]);},confirmText:'Record Response',onConfirm(root){try{dispatch({type:'CASE_RESPONSE_SUBMITTED',actorId,caseId:element.dataset.caseId,response:root.querySelector('#caseResponse').value});toast('Response recorded');}catch(error){toast(error.message,'error');return false;}}});
  }
  if (action === 'assign-pac-panel') {
    const caseId=element.dataset.caseId;
    showConsequenceModal({title:`Assign PAC panel for ${caseId}?`,summary:'The panel is selected from eligible, non-conflicted players using the case procedure.',consequences:['Select three eligible PAC panel members.','Move the case into PAC review.','Exclude the accused, complainant and recorded conflicts from the panel pool.'],confirmText:'Assign PAC Panel',state,onConfirm(){try{dispatch({type:'CASE_PAC_PANEL_ASSIGNED',actorId,caseId});toast('PAC panel assigned');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }
  if (action === 'create-pac-vote') {
    const caseId=element.dataset.caseId; const c=state.cases?.[caseId];
    showConsequenceModal({title:`Open PAC finding vote for ${caseId}?`,summary:'PAC determines whether the accused is Guilty or Not Guilty under the cited ordinary law. PAC does not determine punishment.',consequences:[`Restrict voting to the assigned ${c?.pacPanel?.length ?? 0}-person PAC panel.`,'Open a 72-hour formal vote where Yes means Guilty.','If PAC finds Guilty, jury review is mandatory before any PPC punishment stage.'],confirmText:'Open PAC Vote',state,onConfirm(){try{dispatch({type:'CASE_PAC_VOTE_CREATED',actorId,caseId});toast('PAC vote created');navigate('votes');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }
  if (action === 'select-jury') {
    const caseId=element.dataset.caseId;
    showConsequenceModal({title:`Select jury for ${caseId}?`,summary:'Jury review is mandatory after a PAC Guilty finding.',consequences:['Select five eligible jurors using the case eligibility rules.','Move the case into the jury-ready stage.','Preserve previous-juror and conflict exclusions used by the case procedure.'],confirmText:'Select Jury',state,onConfirm(){try{dispatch({type:'CASE_JURY_SELECTED',actorId,caseId});toast('Jury selected');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }
  if (action === 'create-jury-vote') {
    const caseId=element.dataset.caseId; const c=state.cases?.[caseId];
    showConsequenceModal({title:`Open jury review for ${caseId}?`,summary:'The jury decides whether to uphold the PAC Guilty finding; it does not select punishment.',consequences:[`Restrict the secret vote to the selected ${c?.jury?.length ?? 0}-person jury.`,'Open a 72-hour jury review vote where Yes means Uphold Guilty finding.','Only an upheld Guilty finding can advance to PPC punishment.'],confirmText:'Open Jury Vote',state,onConfirm(){try{dispatch({type:'CASE_JURY_VOTE_CREATED',actorId,caseId});toast('Jury vote created');navigate('votes');}catch(error){toast(error.message,'error');return false;}}});
    return;
  }
  if (action === 'record-ppc-punishment') {showModal({title:'Record PPC Punishment',body:'<div class="field"><label>Punishment authorised by law</label><textarea id="ppcPunishment" rows="5"></textarea></div>',eyebrow:"People's Punishment Committee",actorLabel:state.players?.[actorId]?.displayName ?? '',draftKey:`ppc-punishment:${element.dataset.caseId}`,summary:'PPC determines punishment only after the jury has upheld the PAC guilty finding.',consequenceItems:['Record the punishment selected by PPC for this case.','Close/advance the case according to the ordinary-law procedure.'],review(root){return reviewRows([['Case',element.dataset.caseId],['Punishment',root.querySelector('#ppcPunishment').value||'No punishment text entered']]);},confirmText:'Record Punishment',danger:true,irreversible:true,onConfirm(root){try{dispatch({type:'CASE_PPC_PUNISHMENT_RECORDED',actorId,caseId:element.dataset.caseId,punishment:root.querySelector('#ppcPunishment').value});toast('Punishment recorded');}catch(error){toast(error.message,'error');return false;}}});return;}

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
    showModal({ title:`Delete ${game?.name ?? 'save'}?`, body:'', summary:'This deletes only the browser copy of this saved Democracy.', consequenceItems:['Remove the local save from this browser.','Leave any separately exported backup or Cloud room unchanged.'], confirmText:'Delete Save', danger:true, irreversible:true, onConfirm() { return deleteSavedGame(element.dataset.gameId).then(()=>refreshSavedGames(true)).then(()=>toast('Save deleted')).catch(error=>{toast(error.message,'error');return false;}); }});
    return;
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
  applyNavGroups();
  updateShellContext(getState());
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
