import { CLOUD_BACKEND } from './cloud-config.js';
import { CLOUD_MESSAGE, CLOUD_PROTOCOL_VERSION, parseProtocolMessage, protocolEnvelope } from '../shared/protocol.js';
import { cloudAuthPayload } from '../shared/cloud-auth.js';
import { cloudActionPayload, cloudJoinDecisionPayload, cloudPlayerIdForFingerprint, cloudCommitHash, sameCloudAction, verifyCloudSignedPayload } from '../shared/cloud-action.js';
import { canonicalStateHash } from '../shared/integrity.js';
import { authorizePeerAction } from '../shared/permissions.js';
import { reduceDeterministic } from '../shared/reducer.js';
import { estimateCloudClock, cloudNow } from '../shared/cloud-time.js';
import { ensureIdentity, signPayload } from './identity.js';
import { getState, loadState } from './state.js';

const SETTINGS_KEY = 'democracy-web.cloud-backend.v2';
const LEGACY_SETTINGS_KEY = 'democracy-web.cloud-backend.v1';
const SETTINGS_URL_KEY = 'democracy-web.cloud-backend-url';
const SESSION_KEY = 'democracy-web.cloud-session.v1';
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const listeners = new Set();
let socket = null;
let reconnectTimer = null;
let timeSyncTimer = null;
let clockAnchorServerMs = null;
let clockAnchorPerfMs = null;
let intentionalClose = false;
let reconnectAttempt = 0;
let lifecycleInstalled = false;
let status = {
  connection: 'offline',
  roomCode: null,
  connectionId: null,
  authenticated: false,
  authRole: null,
  fingerprint: null,
  localPlayerId: null,
  displayName: null,
  connectedClients: 0,
  authenticatedClients: 0,
  joinStatus: null,
  joinRequestId: null,
  joinRequests: [],
  stateSynced: false,
  stateVersion: 0,
  stateHash: null,
  commitSequence: 0,
  lastCommitHash: null,
  serverTimeOffsetMs: 0,
  clockRttMs: null,
  lastTimeSyncAt: null,
  recoverySource: null,
  snapshotSequence: 0,
  reconnectAttempt: 0,
  nextReconnectAt: null,
  lastConnectedAt: null,
  autoReconnect: false,
  lastError: '',
  backend: null,
  protocol: CLOUD_PROTOCOL_VERSION
};

function emit() { const snap = getCloudStatus(); for (const fn of listeners) { try { fn(snap); } catch {} } }
function setStatus(patch) { status = { ...status, ...patch }; emit(); }
function cloneRequests(value) { return (value || []).map(item => ({ ...item, publicJwk: item.publicJwk ? structuredClone(item.publicJwk) : null })); }

function browserDefaultCloudBackend() {
  try {
    if (typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
      return 'http://localhost:8787';
    }
  } catch {}
  return CLOUD_BACKEND.apiBase;
}

function normalizeCloudBackendUrl(value) {
  let text = String(value ?? '').trim();
  const markdown = text.match(/^\[https?:\/\/[^\]]+\]\((https?:\/\/[^)]+)\)$/i);
  if (markdown) text = markdown[1];
  return text.replace(/\/$/, '');
}

export function getCloudSettings() {
  let saved = {};
  let cachedUrl = '';
  try {
    cachedUrl = normalizeCloudBackendUrl(localStorage.getItem(SETTINGS_URL_KEY) || '');
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(LEGACY_SETTINGS_KEY) || '{}') || {};
  } catch {}
  const apiBase = normalizeCloudBackendUrl(cachedUrl || saved.apiBase || browserDefaultCloudBackend());
  return {
    enabled: saved.enabled ?? CLOUD_BACKEND.enabled,
    apiBase
  };
}

export function setCloudSettings(next = {}) {
  const current = getCloudSettings();
  const merged = {
    enabled: next.enabled ?? current.enabled,
    apiBase: normalizeCloudBackendUrl(next.apiBase ?? current.apiBase)
  };
  if (!/^https?:\/\//i.test(merged.apiBase)) throw new Error('Cloud backend URL must start with http:// or https://.');
  const parsed = new URL(merged.apiBase);
  const localDev = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localDev) throw new Error('Production Cloud backends must use HTTPS. Plain HTTP is allowed only for localhost development.');
  merged.enabled = true;
  // Persist the URL independently as well as in the settings object. This makes the
  // backend selection robust across rerenders, reloads, upgrades from v1 settings,
  // and a partially-corrupted JSON settings record.
  localStorage.setItem(SETTINGS_URL_KEY, merged.apiBase);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  // Keep the legacy key updated during the 1.1.x transition so older cached tabs do
  // not overwrite the new selection with localhost on their next render.
  localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}



async function preflightCloudRoom(apiBase, roomCode) {
  const response = await fetch(`${apiBase}/rooms/${encodeURIComponent(roomCode)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: { accept: 'application/json' }
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  const error = new Error(
    response.status === 404
      ? `Cloud room ${roomCode} does not exist yet. Publish/create this game in Cloud Multiplayer before connecting to it.`
      : (data?.message || data?.error || `Cloud room preflight failed (${response.status}).`)
  );
  error.permanent = response.status === 404 || response.status === 400 || response.status === 403;
  error.status = response.status;
  throw error;
}

function loadCloudSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function saveCloudSession(roomCode, apiBase) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, apiBase, savedAt: Date.now() }));
}

function clearCloudSession() { localStorage.removeItem(SESSION_KEY); }

function scheduleReconnect({ immediate = false } = {}) {
  if (intentionalClose || reconnectTimer || !status.roomCode || !getCloudSettings().enabled) return;
  const delay = immediate ? 0 : RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  const nextReconnectAt = Date.now() + delay;
  setStatus({ connection: 'reconnecting', reconnectAttempt: reconnectAttempt + 1, nextReconnectAt, autoReconnect: true });
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    try { await connectCloudRoom(status.roomCode, { reconnect: true }); }
    catch (error) {
      if (error?.permanent) {
        setStatus({ connection: 'error', lastError: error.message, autoReconnect: false, nextReconnectAt: null });
        return;
      }
      scheduleReconnect();
    }
  }, delay);
}

function installLifecycleRecovery() {
  if (lifecycleInstalled || typeof window === 'undefined') return;
  lifecycleInstalled = true;
  const recover = () => {
    if (intentionalClose || !status.roomCode) return;
    if (socket?.readyState === WebSocket.OPEN) { try { cloudPing(); } catch {} return; }
    scheduleReconnect({ immediate: true });
  };
  window.addEventListener('online', recover);
  window.addEventListener('pageshow', recover);
  window.addEventListener('focus', recover);
  document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') recover(); });
  window.addEventListener('offline', () => { if (status.roomCode && !intentionalClose) setStatus({ connection: 'reconnecting', lastError: 'Device is offline. Democracy Web will reconnect automatically when the network returns.' }); });
}

export function prepareCloudMigrationState(state) {
  if (!state || typeof state !== 'object') throw new Error('A Democracy state is required for Cloud migration.');
  const migrated = structuredClone(state);
  migrated.network = {
    authorityEpoch: 0,
    ownerPlayerId: null,
    backupOwnerPlayerId: null,
    reconnectTokens: {},
    recentTransitions: []
  };
  return migrated;
}

export async function restoreCloudSession() {
  installLifecycleRecovery();
  if (status.roomCode || socket) return getCloudStatus();
  const saved = loadCloudSession();
  if (!saved?.roomCode || !getCloudSettings().enabled) return getCloudStatus();
  if (saved.apiBase) setCloudSettings({ ...getCloudSettings(), apiBase: saved.apiBase, enabled: true });
  try { return await connectCloudRoom(saved.roomCode, { reconnect: true }); }
  catch (error) {
    if (error?.permanent) {
      setStatus({ connection: 'error', lastError: error.message, autoReconnect: false, nextReconnectAt: null });
      return getCloudStatus();
    }
    scheduleReconnect();
    return getCloudStatus();
  }
}


export function cloudInviteUrl(roomCode = status.roomCode) {
  const code = String(roomCode || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error('No valid Cloud room is connected.');
  const settings = getCloudSettings();
  const url = new URL(globalThis.location?.href || 'http://localhost/');
  url.searchParams.set('room', code);
  url.searchParams.set('cloud', settings.apiBase);
  url.hash = 'multiplayer';
  return url.toString();
}

export function getCloudStatus() { return { ...status, joinRequests: cloneRequests(status.joinRequests) }; }
export function subscribeCloudNetwork(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getCloudNowMs() {
  if (clockAnchorServerMs != null && clockAnchorPerfMs != null && typeof performance !== 'undefined') return clockAnchorServerMs + (performance.now() - clockAnchorPerfMs);
  return cloudNow(Date.now(), status.serverTimeOffsetMs);
}

function updateServerClock(serverAt, clientSentAt = null, receivedAt = Date.now()) {
  const server = Number(serverAt);
  if (!Number.isFinite(server) || server <= 0) return;
  const estimate = estimateCloudClock({ serverAt: server, clientSentAt, receivedAt });
  clockAnchorServerMs = receivedAt + estimate.offsetMs;
  clockAnchorPerfMs = typeof performance !== 'undefined' ? performance.now() : null;
  setStatus({ serverTimeOffsetMs: estimate.offsetMs, clockRttMs: estimate.rttMs == null ? status.clockRttMs : estimate.rttMs, lastTimeSyncAt: receivedAt });
}

function stopTimeSync() {
  if (timeSyncTimer) { clearInterval(timeSyncTimer); timeSyncTimer = null; }
}

function startTimeSync() {
  stopTimeSync();
  try { cloudPing(); } catch {}
  timeSyncTimer = setInterval(() => { try { cloudPing(); } catch {} }, 30_000);
}

function wsUrl(apiBase, roomCode) {
  const url = new URL(`${apiBase}/rooms/${encodeURIComponent(roomCode)}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Cloud WebSocket is not connected.');
  socket.send(JSON.stringify(protocolEnvelope(type, payload)));
}

function reportCloudError(error) {
  const message = error?.message || String(error || 'Cloud multiplayer error.');
  setStatus({ lastError: message });
  try { window.dispatchEvent(new CustomEvent('network:action-rejected', { detail: { message } })); } catch {}
}

export async function createCloudRoom({ roomCode = '', creatorPlayerId = '', displayName = '', initialState = null } = {}) {
  const settings = getCloudSettings();
  if (!settings.enabled) throw new Error('Cloud multiplayer is disabled. Enable it in the Cloud Multiplayer Preview panel first.');
  const identity = await ensureIdentity();
  if (identity.insecureLanTest) throw new Error('Cloud multiplayer requires HTTPS or localhost cryptographic identity; LAN Test identities are not accepted.');
  if (!initialState) throw new Error('A current Democracy state is required to create a Cloud room.');
  const body = {
    roomCode: String(roomCode || '').trim().toUpperCase() || undefined,
    creator: {
      playerId: String(creatorPlayerId || ''),
      displayName: String(displayName || '').slice(0, 80),
      fingerprint: identity.fingerprint,
      publicJwk: identity.publicJwk
    },
    initialState
  };
  const response = await fetch(`${settings.apiBase}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Cloud room creation failed (${response.status}).`);
  return data;
}

async function applySnapshot(payload) {
  const state = payload?.state;
  if (!state || typeof state !== 'object') throw new Error('Cloud snapshot did not contain a game state.');
  const actualHash = canonicalStateHash(state);
  if (actualHash !== payload.stateHash) throw new Error('Cloud snapshot hash verification failed.');
  if (Number(state.stateVersion || 0) !== Number(payload.stateVersion || 0)) throw new Error('Cloud snapshot state-version verification failed.');
  if (payload.serverNow) updateServerClock(payload.serverNow);
  loadState(state);
  setStatus({
    stateSynced: true,
    stateVersion: Number(payload.stateVersion || 0),
    stateHash: payload.stateHash,
    commitSequence: Number(payload.commitSequence ?? payload.sequence ?? 0),
    lastCommitHash: payload.lastCommitHash || null,
    snapshotSequence: Number(payload.snapshotSequence ?? payload.commitSequence ?? payload.sequence ?? 0),
    recoverySource: payload.recoverySource || 'snapshot',
    connection: 'connected',
    lastError: ''
  });
}

async function applyCommittedAction(commit) {
  const current = getState();
  if (!status.localPlayerId || !status.stateSynced || !current) {
    if (status.localPlayerId) send(CLOUD_MESSAGE.RESYNC_REQUEST, { fromSequence: status.commitSequence || 0, preferDelta: true });
    return;
  }
  if (Number(commit.sequence) !== Number(status.commitSequence || 0) + 1) {
    setStatus({ connection: 'syncing', lastError: `Cloud action sequence gap: expected #${Number(status.commitSequence || 0) + 1}, received #${commit.sequence}. Requesting snapshot.` });
    send(CLOUD_MESSAGE.RESYNC_REQUEST, { fromSequence: status.commitSequence || 0 });
    return;
  }
  if ((commit.previousCommitHash || null) !== (status.lastCommitHash || null)) throw new Error('Cloud commit hash chain does not match the locally verified head.');
  if (cloudCommitHash(commit) !== commit.commitHash) throw new Error('Cloud commit hash is invalid.');
  if (Number(commit.expectedStateVersion) !== Number(current.stateVersion || 0)) throw new Error('Cloud commit was based on a different state version.');

  const signer = current.players?.[commit.playerId];
  if (!signer?.identityPublicKey || !signer.identityFingerprint) throw new Error('Cloud commit signer is not a registered cryptographic player.');
  const signedPayload = cloudActionPayload({
    roomCode: status.roomCode,
    playerId: commit.playerId,
    action: commit.submittedAction,
    expectedStateVersion: commit.expectedStateVersion,
    nonce: commit.nonce
  });
  if (!await verifyCloudSignedPayload(signer.identityPublicKey, signedPayload, commit.signature)) throw new Error('Cloud commit player signature is invalid.');
  const applied = authorizePeerAction(current, commit.submittedAction, commit.playerId);
  if (!sameCloudAction(applied, commit.appliedAction)) throw new Error('Cloud server applied an action different from the locally authorized action.');
  const reduced = reduceDeterministic(current, applied, { seed: commit.transitionSeed, timestamp: commit.acceptedAt });
  if (reduced.stateHash !== commit.stateHash || Number(reduced.state.stateVersion || 0) !== Number(commit.stateVersion || 0)) throw new Error('Cloud state divergence detected after replaying the committed action.');

  loadState(reduced.state);
  setStatus({
    stateVersion: commit.stateVersion,
    stateHash: commit.stateHash,
    commitSequence: commit.sequence,
    lastCommitHash: commit.commitHash,
    connection: 'connected',
    lastError: ''
  });
}

async function applyRecoveryBundle(payload) {
  if (payload.serverNow) updateServerClock(payload.serverNow);
  setStatus({ connection: 'syncing' });
  const snapshot = payload.snapshot;
  if (snapshot) {
    await applySnapshot({
      state: snapshot.state,
      stateHash: snapshot.stateHash,
      stateVersion: snapshot.stateVersion,
      commitSequence: snapshot.sequence,
      lastCommitHash: snapshot.lastCommitHash || (snapshot.sequence > 0 ? (payload.commits?.[0]?.previousCommitHash || null) : null),
      snapshotSequence: snapshot.sequence,
      recoverySource: 'persistent-snapshot',
      serverNow: payload.serverNow
    });
  } else if (Number(payload.baseSequence ?? status.commitSequence) !== Number(status.commitSequence || 0)) {
    throw new Error('Cloud recovery delta does not start at the locally verified commit sequence.');
  }

  for (const commit of payload.commits || []) await applyCommittedAction(commit);
  if (Number(status.commitSequence || 0) !== Number(payload.targetSequence || status.commitSequence || 0)) throw new Error('Cloud recovery bundle did not reach the advertised target sequence.');
  if ((payload.targetCommitHash || null) !== (status.lastCommitHash || null)) throw new Error('Cloud recovery bundle final commit hash does not match the advertised recovery head.');
  setStatus({ connection: 'connected', stateSynced: true, recoverySource: snapshot ? 'persistent-snapshot+commits' : 'commit-delta', lastError: '' });
}

export async function connectCloudRoom(roomCode, options = {}) {
  const settings = getCloudSettings();
  if (!settings.enabled) throw new Error('Cloud multiplayer is disabled.');
  const code = String(roomCode || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error('Cloud room code must be six letters/numbers (excluding 0, 1, I and O).');
  const reconnecting = options.reconnect === true;
  const previous = getCloudStatus();
  if (!reconnecting) await leaveCloudRoom({ preserveSession: true });
  else {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const old = socket; socket = null;
    if (old && old.readyState < 2) { try { old.close(1000, 'reconnect'); } catch {} }
  }
  intentionalClose = false;
  installLifecycleRecovery();
  await preflightCloudRoom(settings.apiBase, code);
  saveCloudSession(code, settings.apiBase);
  setStatus({
    connection: 'connecting', roomCode: code, connectionId: null, authenticated: false, authRole: null,
    fingerprint: null, localPlayerId: null, displayName: null, joinStatus: null, joinRequestId: null,
    joinRequests: reconnecting ? previous.joinRequests : [], stateSynced: reconnecting ? previous.stateSynced : false, stateVersion: reconnecting ? previous.stateVersion : 0, stateHash: reconnecting ? previous.stateHash : null, commitSequence: reconnecting ? previous.commitSequence : 0, lastCommitHash: reconnecting ? previous.lastCommitHash : null,
    serverTimeOffsetMs: 0, clockRttMs: null, lastTimeSyncAt: null, recoverySource: null, snapshotSequence: 0,
    lastError: '', backend: settings.apiBase, autoReconnect: true, reconnectAttempt: reconnecting ? reconnectAttempt : 0, nextReconnectAt: null
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl(settings.apiBase, code));
    socket = ws;
    const fail = error => {
      const message = error?.message || String(error || 'Cloud WebSocket connection failed.');
      setStatus({ connection: 'error', lastError: message, authenticated: false });
      if (!settled) { settled = true; reject(new Error(message)); }
    };

    ws.addEventListener('open', () => {
      setStatus({ connection: 'authenticating' });
      ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.HELLO, { client: 'democracy-web', protocol: CLOUD_PROTOCOL_VERSION })));
    });

    ws.addEventListener('message', async event => {
      try {
        const message = parseProtocolMessage(event.data);
        if (message.type === CLOUD_MESSAGE.WELCOME) {
          if (message.payload?.serverNow) updateServerClock(message.payload.serverNow);
          setStatus({
            connectionId: message.payload?.connectionId || null,
            connectedClients: Number(message.payload?.connectedClients || 0),
            authenticatedClients: Number(message.payload?.authenticatedClients || 0),
            stateVersion: Number(message.payload?.stateVersion || 0),
            stateHash: message.payload?.stateHash || null,
            commitSequence: Number(message.payload?.commitSequence || 0),
            lastCommitHash: message.payload?.lastCommitHash || null
          });
          return;
        }
        if (message.type === CLOUD_MESSAGE.AUTH_CHALLENGE) {
          const payload = cloudAuthPayload(message.payload || {});
          const identity = await ensureIdentity();
          if (identity.insecureLanTest) throw new Error('Cloud authentication requires a secure cryptographic identity.');
          const signed = await signPayload(payload);
          ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.AUTH_RESPONSE, {
            challengeId: payload.challengeId,
            fingerprint: identity.fingerprint,
            publicJwk: identity.publicJwk,
            signature: signed.signature,
            resumeFromSequence: reconnecting ? Number(previous.commitSequence || 0) : null,
            resumeLastCommitHash: reconnecting ? (previous.lastCommitHash || null) : null
          })));
          return;
        }
        if (message.type === CLOUD_MESSAGE.AUTH_OK) {
          if (message.payload?.serverNow) updateServerClock(message.payload.serverNow);
          setStatus({
            connection: 'connected', authenticated: true, authRole: message.payload?.role || 'unregistered',
            fingerprint: message.payload?.fingerprint || null, localPlayerId: message.payload?.playerId || null,
            displayName: message.payload?.displayName || null, connectedClients: Number(message.payload?.connectedClients || status.connectedClients || 0),
            authenticatedClients: Number(message.payload?.authenticatedClients || 0), stateVersion: Number(message.payload?.stateVersion || 0),
            stateHash: message.payload?.stateHash || null, commitSequence: Number(message.payload?.commitSequence || 0),
            lastCommitHash: message.payload?.lastCommitHash || null, lastError: '', lastConnectedAt: Date.now(), reconnectAttempt: 0, nextReconnectAt: null, autoReconnect: true
          });
          reconnectAttempt = 0;
          startTimeSync();
          if (!settled) { settled = true; resolve(getCloudStatus()); }
          return;
        }
        if (message.type === CLOUD_MESSAGE.STATE_SNAPSHOT) {
          await applySnapshot(message.payload || {});
          return;
        }
        if (message.type === CLOUD_MESSAGE.RECOVERY_BUNDLE) {
          await applyRecoveryBundle(message.payload || {});
          return;
        }
        if (message.type === CLOUD_MESSAGE.PONG || message.type === CLOUD_MESSAGE.TIME_SYNC) {
          updateServerClock(message.payload?.serverAt ?? message.payload?.serverNow, message.payload?.clientSentAt);
          return;
        }
        if (message.type === CLOUD_MESSAGE.JOIN_REQUEST) {
          setStatus({ joinStatus: message.payload?.status || 'pending', joinRequestId: message.payload?.requestId || null });
          return;
        }
        if (message.type === CLOUD_MESSAGE.JOIN_REQUESTS) {
          setStatus({ joinRequests: cloneRequests(message.payload?.requests || []) });
          return;
        }
        if (message.type === CLOUD_MESSAGE.JOIN_APPROVED) {
          setStatus({ authRole: 'player', localPlayerId: message.payload?.playerId || status.localPlayerId, joinStatus: 'approved', joinRequestId: message.payload?.requestId || status.joinRequestId, stateSynced: false, lastError: '' });
          return;
        }
        if (message.type === CLOUD_MESSAGE.JOIN_REJECTED) {
          setStatus({ joinStatus: 'rejected', joinRequestId: message.payload?.requestId || status.joinRequestId });
          return;
        }
        if (message.type === CLOUD_MESSAGE.ACTION_COMMITTED) {
          await applyCommittedAction(message.payload?.commit || {});
          return;
        }
        if (message.type === CLOUD_MESSAGE.PRESENCE) {
          setStatus({
            connectedClients: Number(message.payload?.connectedClients || 0),
            authenticatedClients: Number(message.payload?.authenticatedClients || 0)
          });
          return;
        }
        if (message.type === CLOUD_MESSAGE.ERROR) {
          const error = new Error(message.payload?.message || message.payload?.code || 'Cloud multiplayer error.');
          if (message.payload?.code === 'action_rejected') reportCloudError(error);
          else throw error;
        }
      } catch (error) { fail(error); }
    });

    ws.addEventListener('error', () => fail(new Error('Cloud WebSocket connection failed. Check the Worker URL and that Wrangler/Cloudflare is reachable.')));
    ws.addEventListener('close', event => {
      if (socket === ws) socket = null;
      if (intentionalClose) {
        setStatus({ connection: 'offline', authenticated: false, connectionId: null, connectedClients: 0, authenticatedClients: 0 });
        return;
      }
      setStatus({ connection: 'reconnecting', authenticated: false, lastError: event.reason || `Cloud WebSocket closed (${event.code}). Reconnecting automatically…` });
      if (!settled) { settled = true; reject(new Error(status.lastError)); }
      scheduleReconnect();
    });
  });
}

export function requestCloudJoin(displayName) {
  if (!status.authenticated || status.authRole !== 'unregistered') throw new Error('Only an authenticated unregistered identity can request to join.');
  const name = String(displayName || '').trim();
  if (!name) throw new Error('Enter a display name.');
  if (name.length > 50) throw new Error('Player names must be 50 characters or fewer.');
  send(CLOUD_MESSAGE.JOIN_REQUEST, { displayName: name });
  setStatus({ joinStatus: 'requesting' });
}

export function approveCloudJoin(requestId) {
  const request = status.joinRequests.find(item => item.requestId === requestId);
  if (!request) throw new Error('That join request is no longer pending.');
  const action = {
    type: 'PLAYER_ADDED',
    joinRequestId: request.requestId,
    playerId: cloudPlayerIdForFingerprint(request.fingerprint),
    name: request.displayName,
    identityFingerprint: request.fingerprint,
    identityPublicKey: request.publicJwk
  };
  return submitCloudAction(action);
}

export function rejectCloudJoin(requestId) {
  if (!status.localPlayerId || !status.authenticated) throw new Error('You must be an approved player to reject join requests.');
  const request = status.joinRequests.find(item => item.requestId === requestId);
  if (!request) throw new Error('That join request is no longer pending.');
  const nonce = crypto.randomUUID();
  const signedPayload = cloudJoinDecisionPayload({ roomCode: status.roomCode, playerId: status.localPlayerId, requestId, decision: 'reject', nonce });
  (async () => {
    try {
      const proof = await signPayload(signedPayload);
      send(CLOUD_MESSAGE.JOIN_DECISION, { signedPayload, signature: proof.signature });
    } catch (error) { reportCloudError(error); }
  })();
  return getState();
}

export function submitCloudAction(action) {
  if (!status.authenticated || !status.localPlayerId || !['creator', 'player'].includes(status.authRole)) throw new Error('Cloud join approval is required before submitting game actions.');
  if (!status.stateSynced) throw new Error('Wait for the verified Cloud state snapshot before submitting actions.');
  const current = getState();
  if (!current) throw new Error('No verified Cloud game state is loaded.');
  const signedPayload = cloudActionPayload({
    roomCode: status.roomCode,
    playerId: status.localPlayerId,
    action,
    expectedStateVersion: current.stateVersion,
    nonce: crypto.randomUUID()
  });
  (async () => {
    try {
      const proof = await signPayload(signedPayload);
      send(CLOUD_MESSAGE.ACTION_SUBMIT, { signedPayload, signature: proof.signature, fingerprint: proof.fingerprint });
    } catch (error) { reportCloudError(error); }
  })();
  return current;
}

export function requestCloudResync() {
  if (!status.authenticated || !status.localPlayerId) throw new Error('Only approved Cloud players can request a state resync.');
  send(CLOUD_MESSAGE.RESYNC_REQUEST, { fromSequence: status.commitSequence || 0, forceSnapshot: true });
}

export async function leaveCloudRoom(options = {}) {
  intentionalClose = true;
  if (!options.preserveSession) clearCloudSession();
  stopTimeSync();
  clockAnchorServerMs = null;
  clockAnchorPerfMs = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const ws = socket; socket = null;
  if (ws && ws.readyState < 2) { try { ws.close(1000, 'client_leave'); } catch {} }
  setStatus({
    connection: 'offline', roomCode: null, connectionId: null, authenticated: false, authRole: null,
    fingerprint: null, localPlayerId: null, displayName: null, connectedClients: 0, authenticatedClients: 0,
    joinStatus: null, joinRequestId: null, joinRequests: [], stateSynced: false, stateVersion: 0, stateHash: null,
    commitSequence: 0, lastCommitHash: null, serverTimeOffsetMs: 0, clockRttMs: null, lastTimeSyncAt: null, recoverySource: null, snapshotSequence: 0, reconnectAttempt: 0, nextReconnectAt: null, lastConnectedAt: null, autoReconnect: false, lastError: ''
  });
}

installLifecycleRecovery();

export function cloudPing() {
  send(CLOUD_MESSAGE.PING, { clientSentAt: Date.now() });
}
