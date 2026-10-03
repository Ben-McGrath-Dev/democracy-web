import {
  dispatch as applyLocalAction,
  dispatchDeterministic,
  simulateDeterministicAction,
  getState,
  loadState,
  subscribe,
  hasGame,
  updateTechnicalNetworkState
} from './state.js';
import { authorizePeerAction } from './permissions.js';
import { ensureIdentity, signPayload, verifySignedPayload, publicKeyFingerprint, rotateIdentity } from './identity.js';
import { canonicalStateHash } from './integrity.js';
import { validateNetworkActionSize, validateIncomingStateSize, validateDisplayName } from './security.js';

const APP_ID = 'democracy-web-p2p-v2';
const SESSION_PREFIX = 'democracy-web.online-session.';
const MIGRATION_DELAY_MS = 900;
const RECOVERY_WINDOW_MS = 850;
const MAX_RECENT_TRANSITIONS = 5000;
const CONTROL_MAX_AGE_MS = 120000;

let room = null;
let role = 'offline';
let roomCode = null;
let ownerPeerId = null;
let localPeerId = null;
let localPlayerId = null;
let peers = new Map();
let peerPlayers = new Map();
let peerInfo = new Map();
let actions = {};
let listeners = new Set();
let lastError = null;
let waitingJoin = false;
let importedModule = null;
let connectionState = 'offline';
let reconnectAttempt = 0;
let reconnectTimer = null;
let migrationTimer = null;
let recoveryPackets = new Map();
let authorityEpoch = 0;
let displayName = null;
let lastOwnerSeenAt = null;
let awaitingInitialState = false;
let expectedOwnerFingerprint = null;
let pendingJoinAck = null;
let discoveredOwner = null;
let discoveredOwnerConflict = false;
const seenActionNonces = new Map();
const seenControlNonces = new Map();
const peerActionWindows = new Map();
const peerJoinWindows = new Map();
const RATE_WINDOW_MS = 10000;
const MAX_ACTIONS_PER_WINDOW = 40;
const MAX_JOINS_PER_WINDOW = 8;

const relayHealth = new Map();
const relaySocketBindings = new WeakSet();
let relayHealthTimer = null;
const RELAY_RETRY_BASE_MS = 1500;
const RELAY_RETRY_MAX_MS = 60000;
const RELAY_UNAVAILABLE_AFTER = 5;

const TURN_SETTINGS_KEY = 'democracy-web.turn-settings.v1';

function cleanTurnUrls(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]+/);
  return [...new Set(raw.map(v => String(v).trim()).filter(Boolean))]
    .filter(url => /^turns?:/i.test(url))
    .slice(0, 8);
}

function readTurnSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(TURN_SETTINGS_KEY) || 'null') || {};
    return {
      urls: cleanTurnUrls(raw.urls),
      username: String(raw.username ?? '').slice(0, 256),
      credential: String(raw.credential ?? '').slice(0, 512),
      forceRelay: Boolean(raw.forceRelay)
    };
  } catch {
    return { urls: [], username: '', credential: '', forceRelay: false };
  }
}

export function getTurnSettings() { return readTurnSettings(); }

export function setTurnSettings({ urls = [], username = '', credential = '', forceRelay = false } = {}) {
  const next = {
    urls: cleanTurnUrls(urls),
    username: String(username ?? '').trim().slice(0, 256),
    credential: String(credential ?? '').slice(0, 512),
    forceRelay: Boolean(forceRelay)
  };
  if (next.forceRelay && !next.urls.length) throw new Error('Add at least one TURN URL before forcing relay mode.');
  localStorage.setItem(TURN_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function clearTurnSettings() { localStorage.removeItem(TURN_SETTINGS_KEY); }


function joinErrorMessage(details) {
  const raw = details?.error ?? details?.message ?? details;
  if (raw instanceof Error) return raw.message || String(raw);
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw); } catch { return String(raw || 'WebRTC peer connection failed'); }
}

function handleTrysteroJoinError(details) {
  const failedPeerId = typeof details?.peerId === 'string' ? details.peerId : null;
  const message = joinErrorMessage(details) || 'WebRTC peer connection failed';
  const peerLabel = failedPeerId ? `peer ${failedPeerId.slice(0, 8)}…` : 'a peer';

  // Trystero's onJoinError is peer-scoped: a failed WebRTC pairing does not mean
  // this browser has left the signaling room. Never mark the Lobby Owner offline
  // just because one joining/reconnecting peer could not establish transport.
  if (role === 'owner') {
    lastError = `Could not establish WebRTC with ${peerLabel}: ${message}`;
    if (room) connectionState = 'connected';
    emit();
    return;
  }

  if (role === 'peer') {
    // Ignore failures for unrelated peers. If the failed pairing could be the
    // verified owner, stay in the secure discovery/retry flow rather than
    // declaring the entire lobby disconnected.
    if (ownerPeerId && failedPeerId && failedPeerId !== ownerPeerId) {
      lastError = `WebRTC attempt with ${peerLabel} failed: ${message}`;
      emit();
      return;
    }
    lastError = `WebRTC connection attempt failed: ${message}${readTurnSettings().urls.length ? '' : ' TURN is not configured.'}`;
    if (waitingJoin || awaitingInitialState) {
      connectionState = expectedOwnerFingerprint ? 'reconnecting' : 'discovering-owner';
      if (expectedOwnerFingerprint) startJoinRetry();
    } else if (room) {
      connectionState = 'reconnecting';
    }
    emit();
  }
}

const SIGNALING_RELAYS = [
  'wss://nos.lol',
  'wss://relay.mostr.pub',
  'wss://relay.sigit.io',
  'wss://purplerelay.com',
  'wss://relay.agorist.space',
  'wss://yabu.me/v2'
];


function relayRetryDelay(failures = 1) {
  return Math.min(RELAY_RETRY_MAX_MS, RELAY_RETRY_BASE_MS * (2 ** Math.max(0, failures - 1)));
}

function websocketCloseReason(event) {
  const code = Number(event?.code || 0);
  const reason = String(event?.reason || '').trim();
  if (reason) return `${code || 'close'} · ${reason}`;
  if (code === 1000) return '1000 · normal closure';
  if (code === 1001) return '1001 · endpoint going away';
  if (code === 1006 || !code) return '1006 · abnormal closure / network failure';
  return `${code} · WebSocket closed`;
}

function ensureRelayRecord(url) {
  if (!relayHealth.has(url)) {
    relayHealth.set(url, {
      url,
      status: 'retrying',
      failures: 0,
      lastFailureReason: null,
      lastFailureAt: null,
      nextRetryAt: null,
      connectedAt: null,
      lastStateChangeAt: Date.now()
    });
  }
  return relayHealth.get(url);
}

function markRelayFailure(url, reason) {
  const rec = ensureRelayRecord(url);
  const failures = (rec.failures || 0) + 1;
  const now = Date.now();
  Object.assign(rec, {
    failures,
    status: failures >= RELAY_UNAVAILABLE_AFTER ? 'unavailable' : 'retrying',
    lastFailureReason: reason || 'Connection failed',
    lastFailureAt: now,
    nextRetryAt: now + relayRetryDelay(failures),
    lastStateChangeAt: now
  });
}

function bindRelaySocket(url, socket) {
  if (!socket || relaySocketBindings.has(socket)) return;
  relaySocketBindings.add(socket);
  const rec = ensureRelayRecord(url);
  rec.status = socket.readyState === 1 ? 'connected' : 'retrying';
  rec.lastStateChangeAt = Date.now();
  if (socket.readyState === 1) {
    rec.connectedAt = Date.now();
    rec.nextRetryAt = null;
  }
  socket.addEventListener?.('open', () => {
    const row = ensureRelayRecord(url);
    Object.assign(row, {
      status: 'connected',
      failures: 0,
      connectedAt: Date.now(),
      nextRetryAt: null,
      lastStateChangeAt: Date.now()
    });
    emit();
  });
  socket.addEventListener?.('error', () => {
    const row = ensureRelayRecord(url);
    if (!row.lastFailureAt || Date.now() - row.lastFailureAt > 300) {
      markRelayFailure(url, 'WebSocket connection error');
    }
    emit();
  });
  socket.addEventListener?.('close', event => {
    const row = ensureRelayRecord(url);
    const reason = websocketCloseReason(event);
    if (!row.lastFailureAt || Date.now() - row.lastFailureAt > 300 || row.lastFailureReason !== reason) {
      markRelayFailure(url, reason);
    }
    emit();
  });
}

function refreshRelayHealth() {
  const sockets = importedModule?.getRelaySockets?.() ?? {};
  const now = Date.now();
  for (const url of SIGNALING_RELAYS) {
    const rec = ensureRelayRecord(url);
    const socket = sockets[url];
    if (socket) {
      bindRelaySocket(url, socket);
      if (socket.readyState === 1) {
        rec.status = 'connected';
        rec.failures = 0;
        rec.connectedAt ||= now;
        rec.nextRetryAt = null;
      } else if (socket.readyState === 0) {
        rec.status = 'retrying';
        rec.nextRetryAt = now;
      } else if (rec.nextRetryAt && now >= rec.nextRetryAt && rec.failures < RELAY_UNAVAILABLE_AFTER) {
        rec.status = 'retrying';
      }
    } else if (role !== 'offline') {
      if (!rec.lastFailureAt && now - rec.lastStateChangeAt > 8000) {
        rec.status = 'unavailable';
        rec.lastFailureReason = 'No relay socket was established';
        rec.lastFailureAt = now;
        rec.nextRetryAt = now + relayRetryDelay(1);
      } else if (rec.nextRetryAt && now >= rec.nextRetryAt) {
        rec.status = rec.failures >= RELAY_UNAVAILABLE_AFTER ? 'unavailable' : 'retrying';
      }
    }
  }
}

function relayHealthSignature() {
  return SIGNALING_RELAYS.map(url => {
    const r = ensureRelayRecord(url);
    return `${url}|${r.status}|${r.failures}|${r.lastFailureReason || ''}|${r.nextRetryAt || ''}|${r.connectedAt || ''}`;
  }).join('\n');
}

function startRelayHealthMonitor() {
  if (relayHealthTimer) return;
  for (const url of SIGNALING_RELAYS) ensureRelayRecord(url);
  refreshRelayHealth();
  relayHealthTimer = setInterval(() => {
    const before = relayHealthSignature();
    refreshRelayHealth();
    if (relayHealthSignature() !== before) emit();
  }, 1000);
}

function stopRelayHealthMonitor() {
  if (relayHealthTimer) clearInterval(relayHealthTimer);
  relayHealthTimer = null;
}

function trysteroRoomConfig() {
  const turn = readTurnSettings();
  const config = {
    appId: APP_ID,
    relayConfig: {
      urls: SIGNALING_RELAYS,
      warnOnRelayFailure: false
    }
  };
  if (turn.urls.length) {
    config.turnConfig = [{
      urls: turn.urls,
      ...(turn.username ? { username: turn.username } : {}),
      ...(turn.credential ? { credential: turn.credential } : {})
    }];
  }
  if (turn.forceRelay) config.rtcConfig = { iceTransportPolicy: 'relay' };
  return config;
}

function enforcePeerRate(map, peerId, limit, label) {
  const now = Date.now();
  const prior = (map.get(peerId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (prior.length >= limit) throw new Error(`${label} rate limit exceeded. Wait a few seconds and try again.`);
  prior.push(now);
  map.set(peerId, prior);
}

function emit() { const s = getNetworkStatus(); for (const fn of listeners) fn(s); }
function normCode(v = '') { return v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  crypto.getRandomValues(new Uint32Array(6)).forEach(n => out += chars[n % chars.length]);
  return out;
}

async function trystero() {
  if (importedModule) return importedModule;
  // TODO 1.0.4: vendor this dependency locally. 1.0.3 focuses on authority/state
  // integrity; the runtime sources remain pinned to a single exact version.
  const sources = [
    'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm',
    'https://esm.sh/trystero@0.25.4?bundle',
    'https://esm.run/trystero@0.25.4'
  ];
  const errors = [];
  for (const source of sources) {
    try {
      importedModule = await import(source);
      return importedModule;
    } catch (error) {
      errors.push(`${source}: ${error?.message || error}`);
    }
  }
  throw new Error(`Could not load the P2P networking module. Tried ${sources.length} pinned providers. ${errors.join(' | ')}`);
}

function sessionKey(code) { return `${SESSION_PREFIX}${normCode(code)}`; }
function readSession(code) { try { return JSON.parse(localStorage.getItem(sessionKey(code)) || 'null'); } catch { return null; } }
function saveSession() {
  if (!roomCode || !localPlayerId) return;
  const state = getState();
  const identitySummary = state?.players?.[localPlayerId]?.identityFingerprint || null;
  localStorage.setItem(sessionKey(roomCode), JSON.stringify({
    roomCode,
    playerId: localPlayerId,
    displayName,
    identityFingerprint: identitySummary,
    ownerFingerprint: state?.players?.[state?.network?.ownerPlayerId]?.identityFingerprint ?? expectedOwnerFingerprint ?? null,
    gameId: state?.meta?.id || null,
    savedAt: new Date().toISOString()
  }));
}
export function getReconnectSession(code) {
  const s = readSession(code);
  return s ? { ...s, hasIdentity: Boolean(s.identityFingerprint) } : null;
}

function clearTimers() {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = null;
  if (migrationTimer) clearTimeout(migrationTimer);
  migrationTimer = null;
}

function cleanup({ forgetSession = false } = {}) {
  clearTimers();
  stopRelayHealthMonitor();
  try { room?.leave?.(); } catch {}
  if (forgetSession && roomCode) localStorage.removeItem(sessionKey(roomCode));
  room = null;
  actions = {};
  peers.clear();
  peerPlayers.clear();
  peerInfo.clear();
  recoveryPackets.clear();
  role = 'offline';
  roomCode = null;
  ownerPeerId = null;
  localPeerId = null;
  localPlayerId = null;
  waitingJoin = false;
  awaitingInitialState = false;
  expectedOwnerFingerprint = null;
  pendingJoinAck = null;
  discoveredOwner = null;
  discoveredOwnerConflict = false;
  connectionState = 'offline';
  reconnectAttempt = 0;
  authorityEpoch = 0;
  displayName = null;
  lastOwnerSeenAt = null;
  lastError = null;
  seenActionNonces.clear();
  seenControlNonces.clear();
  peerActionWindows.clear();
  peerJoinWindows.clear();
  relayHealth.clear();
  emit();
}

function networkMeta() { return getState()?.network ?? {}; }
function setMeta(patch) {
  if (!hasGame()) return;
  const next = updateTechnicalNetworkState(patch);
  authorityEpoch = next.network?.authorityEpoch ?? authorityEpoch;
}
function syncPeerInfo(peerId, info = {}) {
  const prior = peerInfo.get(peerId) || {};
  const merged = { ...prior, ...info, peerId, lastSeenAt: Date.now() };
  peerInfo.set(peerId, merged);
  if (merged.playerId && merged.identityVerified) peerPlayers.set(peerId, merged.playerId);
}

function rememberNonce(map, nonce, maxAgeMs = 300000) {
  if (!nonce) throw new Error('Signed message is missing a nonce.');
  if (map.has(nonce)) throw new Error('Signed message replay detected.');
  map.set(nonce, Date.now());
  if (map.size > 5000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [n, t] of map) if (t < cutoff) map.delete(n);
  }
}

function recentTransitions() { return networkMeta().recentTransitions ?? []; }
function recordTransition(packet) {
  const list = [...recentTransitions(), structuredClone(packet)].slice(-MAX_RECENT_TRANSITIONS);
  setMeta({ recentTransitions: list });
}

function transitionRange(fromVersion, toVersion = getState()?.stateVersion ?? 0) {
  const list = recentTransitions()
    .filter(t => Number(t.previousStateVersion) >= Number(fromVersion) && Number(t.resultStateVersion) <= Number(toVersion))
    .sort((a, b) => a.previousStateVersion - b.previousStateVersion);
  let expected = Number(fromVersion);
  const out = [];
  for (const t of list) {
    if (t.previousStateVersion !== expected) continue;
    out.push(t);
    expected = t.resultStateVersion;
    if (expected === Number(toVersion)) break;
  }
  return expected === Number(toVersion) ? out : null;
}

async function makeSignedControl(kind, fields = {}) {
  if (!localPlayerId) throw new Error('No local player identity is active.');
  const payload = {
    kind,
    roomCode,
    playerId: localPlayerId,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    ...fields
  };
  const proof = await signPayload(payload);
  return { payload, signature: proof.signature, identityFingerprint: proof.fingerprint };
}

async function verifySignedControl(packet, expectedKind, peerId, state = getState()) {
  const payload = packet?.payload;
  if (!payload || payload.kind !== expectedKind || payload.roomCode !== roomCode) throw new Error(`Invalid ${expectedKind} message.`);
  if (Math.abs(Date.now() - Number(payload.timestamp || 0)) > CONTROL_MAX_AGE_MS) throw new Error(`${expectedKind} message expired.`);
  const player = state?.players?.[payload.playerId];
  if (!player?.identityPublicKey || !player.identityFingerprint) throw new Error(`${expectedKind} sender has no bound identity.`);
  if (packet.identityFingerprint !== player.identityFingerprint) throw new Error(`${expectedKind} fingerprint mismatch.`);
  if (!(await verifySignedPayload(player.identityPublicKey, payload, packet.signature))) throw new Error(`${expectedKind} signature is invalid.`);
  rememberNonce(seenControlNonces, payload.nonce);
  syncPeerInfo(peerId, { playerId: payload.playerId, identityVerified: true });
  return payload;
}

async function broadcastPresence(target) {
  if (!actions.presence || !localPlayerId || !getState()?.players?.[localPlayerId]?.identityPublicKey) return;
  try {
    const state = getState();
    const packet = await makeSignedControl('presence', {
      role,
      ownerPlayerId: networkMeta().ownerPlayerId ?? null,
      stateVersion: state?.stateVersion ?? 0,
      stateHash: canonicalStateHash(state),
      authorityEpoch
    });
    const opts = target ? { target } : undefined;
    await actions.presence.send(packet, opts);
  } catch (error) {
    lastError = error.message;
    emit();
  }
}

async function broadcastRoster() {
  if (role !== 'owner' || !actions.roster) return;
  const roster = {};
  for (const [id, info] of peerInfo) {
    if (!info.identityVerified) continue;
    roster[id] = { playerId: info.playerId || null, stateVersion: info.stateVersion ?? 0, stateHash: info.stateHash ?? null, authorityEpoch: info.authorityEpoch ?? authorityEpoch };
  }
  roster[localPeerId] = { playerId: localPlayerId, stateVersion: getState()?.stateVersion ?? 0, stateHash: canonicalStateHash(getState()), authorityEpoch };
  const packet = await makeSignedControl('roster', { roster, authorityEpoch, ownerPlayerId: localPlayerId });
  actions.roster.send(packet).catch?.(() => {});
}


async function sendOwnerOffer(target) {
  if (role !== 'owner' || !localPlayerId || !actions.ownerOffer) return;
  const identity = await ensureIdentity();
  const payload = {
    kind: 'owner-offer', roomCode, playerId: localPlayerId,
    displayName: getState()?.players?.[localPlayerId]?.displayName || displayName || 'Lobby Owner',
    authorityEpoch, timestamp: Date.now(), nonce: crypto.randomUUID(), fingerprint: identity.fingerprint
  };
  const proof = await signPayload(payload);
  await actions.ownerOffer.send({ payload, signature: proof.signature, publicJwk: proof.publicJwk }, { target });
}

async function verifyOwnerOffer(packet) {
  const payload = packet?.payload;
  const publicJwk = packet?.publicJwk;
  if (!payload || payload.kind !== 'owner-offer' || payload.roomCode !== roomCode) throw new Error('Invalid owner discovery response.');
  if (Math.abs(Date.now() - Number(payload.timestamp || 0)) > CONTROL_MAX_AGE_MS) throw new Error('Owner discovery response expired.');
  const fingerprint = await publicKeyFingerprint(publicJwk);
  if (fingerprint !== payload.fingerprint) throw new Error('Owner discovery fingerprint mismatch.');
  if (!(await verifySignedPayload(publicJwk, payload, packet.signature))) throw new Error('Owner discovery signature is invalid.');
  return { peerId: null, playerId: payload.playerId, displayName: payload.displayName || 'Lobby Owner', authorityEpoch: payload.authorityEpoch ?? 0, fingerprint, publicJwk };
}

function startJoinRetry() {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectAttempt = 0;
  const tryJoin = async () => {
    if (role !== 'peer' || !waitingJoin || !actions.join || !expectedOwnerFingerprint) return;
    reconnectAttempt++;
    connectionState = reconnectAttempt > 1 ? 'reconnecting' : 'connecting';
    emit();
    try {
      const identity = await ensureIdentity();
      const joinPayload = {
        kind: 'join', roomCode, displayName: displayName || 'Player', reconnectPlayerId: localPlayerId || null,
        timestamp: Date.now(), nonce: crypto.randomUUID(), fingerprint: identity.fingerprint
      };
      const proof = await signPayload(joinPayload);
      const target = ownerPeerId || undefined;
      await actions.join.send({ joinPayload, signature: proof.signature, publicJwk: proof.publicJwk }, { ...(target ? { target } : {}), metadata: { attempt: reconnectAttempt } });
    } catch (error) {
      lastError = error.message;
      emit();
    }
    if (reconnectAttempt >= 30) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      lastError = 'Could not reach the verified Lobby Owner yet. Check that the host is online, the room code is correct, and TURN is configured if the network blocks direct WebRTC.';
      emit();
    }
  };
  tryJoin();
  reconnectTimer = setInterval(tryJoin, 2000);
}

function candidateEntries() {
  const map = new Map();
  if (localPlayerId) map.set(localPlayerId, { playerId: localPlayerId, peerId: localPeerId, self: true, verified: true });
  for (const [peerId, info] of peerInfo) {
    if (info.playerId && info.identityVerified) map.set(info.playerId, { playerId: info.playerId, peerId, self: false, verified: true });
  }
  const state = getState();
  return [...map.values()].filter(c => state?.players?.[c.playerId]?.status === 'active');
}

function chooseMigrationWinner() {
  const candidates = candidateEntries();
  if (!candidates.length) return null;
  const backup = networkMeta().backupOwnerPlayerId;
  const preferred = backup && candidates.find(c => c.playerId === backup);
  return preferred || candidates.sort((a, b) => a.playerId.localeCompare(b.playerId))[0];
}

async function verifyJoinProof(data) {
  const payload = data?.joinPayload;
  const publicJwk = data?.publicJwk;
  const signature = data?.signature;
  if (!payload || payload.kind !== 'join' || payload.roomCode !== roomCode) throw new Error('Invalid join proof.');
  if (Math.abs(Date.now() - Number(payload.timestamp || 0)) > CONTROL_MAX_AGE_MS) throw new Error('Join proof expired.');
  const calculated = await publicKeyFingerprint(publicJwk);
  if (calculated !== payload.fingerprint) throw new Error('Join identity fingerprint mismatch.');
  if (!(await verifySignedPayload(publicJwk, payload, signature))) throw new Error('Join identity signature is invalid.');
  return { payload, publicJwk, signature, fingerprint: calculated };
}

function expectedNetworkPlayerId(fingerprint) { return `player-net-${String(fingerprint).replace(/[^a-f0-9]/gi, '').slice(0, 24)}`; }

async function verifyOrdinaryTransition(baseState, packet) {
  const envelope = packet?.signedPayload;
  if (!envelope || envelope.kind !== 'game-action' || envelope.roomCode !== roomCode) throw new Error('Invalid transition envelope.');
  if (envelope.expectedStateVersion !== baseState.stateVersion) throw new Error('Transition does not continue from the local state version.');
  if (envelope.expectedAuthorityEpoch !== packet.authorityEpoch) throw new Error('Transition authority epoch mismatch.');
  const player = baseState.players?.[envelope.playerId];
  if (!player?.identityPublicKey || !player.identityFingerprint) throw new Error('Transition actor has no bound identity.');
  if (packet.identityFingerprint !== player.identityFingerprint) throw new Error('Transition actor fingerprint mismatch.');
  if (!(await verifySignedPayload(player.identityPublicKey, envelope, packet.signature))) throw new Error('Transition actor signature is invalid.');
  const sanitized = authorizePeerAction(baseState, envelope.action, envelope.playerId);
  const next = simulateDeterministicAction(baseState, sanitized, { seed: envelope.nonce, timestamp: envelope.timestamp });
  if (next.stateVersion !== packet.resultStateVersion) throw new Error('Transition produced an unexpected state version.');
  const digest = canonicalStateHash(next);
  if (digest !== packet.resultHash) throw new Error('Transition result hash mismatch. Lobby Owner state mutation was rejected.');
  return { next, sanitized };
}

async function verifyJoinTransition(baseState, packet) {
  const proof = await verifyJoinProof(packet.joinProof);
  const action = packet.action;
  if (!action || !['PLAYER_ADDED', 'PLAYER_IDENTITY_BOUND'].includes(action.type)) throw new Error('Invalid join transition action.');
  const expectedId = action.type === 'PLAYER_ADDED' ? expectedNetworkPlayerId(proof.fingerprint) : proof.payload.reconnectPlayerId;
  if (!expectedId || action.playerId !== expectedId) throw new Error('Join transition player ID does not match the signed join identity.');
  if (action.type === 'PLAYER_ADDED') {
    if (action.identityFingerprint !== proof.fingerprint || JSON.stringify(action.identityPublicKey) !== JSON.stringify(proof.publicJwk)) throw new Error('Join transition identity does not match the join proof.');
    if (validateDisplayName(proof.payload.displayName) !== action.name) throw new Error('Join transition name does not match the signed join request.');
  } else {
    const player = baseState.players?.[action.playerId];
    if (!player || player.identityFingerprint) throw new Error('Legacy identity binding is not valid for this player.');
    if (action.identityFingerprint !== proof.fingerprint || JSON.stringify(action.identityPublicKey) !== JSON.stringify(proof.publicJwk)) throw new Error('Identity-binding transition does not match the join proof.');
  }
  const next = simulateDeterministicAction(baseState, action, { seed: proof.payload.nonce, timestamp: proof.payload.timestamp });
  if (next.stateVersion !== packet.resultStateVersion || canonicalStateHash(next) !== packet.resultHash) throw new Error('Join transition result mismatch.');
  return { next, sanitized: action };
}

async function verifyTransitionAgainstState(baseState, packet) {
  if (!packet || packet.kind !== 'state-transition') throw new Error('Invalid state transition packet.');
  if (packet.previousStateVersion !== baseState.stateVersion) throw new Error(`Transition gap: local #${baseState.stateVersion}, packet expects #${packet.previousStateVersion}.`);
  if (packet.systemKind === 'join') return verifyJoinTransition(baseState, packet);
  return verifyOrdinaryTransition(baseState, packet);
}

async function acceptTransition(packet, { fromBatch = false } = {}) {
  const local = getState();
  if (!local) throw new Error('No local state is available for transition verification.');
  if (packet.resultStateVersion <= local.stateVersion) {
    if (packet.resultStateVersion === local.stateVersion && packet.resultHash !== canonicalStateHash(local)) throw new Error('Conflicting transition detected at the current state version.');
    return local;
  }
  if (packet.previousStateVersion !== local.stateVersion) {
    if (!fromBatch && ownerPeerId) actions.stateReq?.send({ want: 'transitions', fromVersion: local.stateVersion, authorityEpoch }, { target: ownerPeerId });
    throw new Error(`Missing verified transitions between state #${local.stateVersion} and #${packet.previousStateVersion}.`);
  }
  const { next } = await verifyTransitionAgainstState(local, packet);
  loadState(next);
  recordTransition(packet);
  connectionState = 'connected';
  broadcastPresence();
  emit();
  return next;
}

async function createAndApplyOrdinaryTransition(envelope, signature, identityFingerprint) {
  const current = getState();
  if (!envelope || envelope.kind !== 'game-action' || envelope.roomCode !== roomCode) throw new Error('Invalid signed action envelope.');
  if (!envelope.playerId || !envelope.nonce || !Number.isFinite(Number(envelope.timestamp))) throw new Error('Signed action envelope is incomplete.');
  if (Math.abs(Date.now() - Number(envelope.timestamp)) > CONTROL_MAX_AGE_MS) throw new Error('Signed action expired.');
  const player = current.players?.[envelope.playerId];
  if (!player?.identityPublicKey || player.identityFingerprint !== identityFingerprint) throw new Error('Action identity does not match the canonical player record.');
  if (!(await verifySignedPayload(player.identityPublicKey, envelope, signature))) throw new Error('Action signature verification failed.');
  rememberNonce(seenActionNonces, envelope.nonce);
  if (envelope.expectedAuthorityEpoch !== authorityEpoch) throw new Error('Lobby authority changed. Resynchronise and try again.');
  if (envelope.expectedStateVersion !== current.stateVersion) throw new Error(`Your state was out of date (you had #${envelope.expectedStateVersion}, current is #${current.stateVersion}).`);
  const sanitized = authorizePeerAction(current, envelope.action, envelope.playerId);
  const next = dispatchDeterministic(sanitized, { seed: envelope.nonce, timestamp: envelope.timestamp });
  const packet = {
    kind: 'state-transition', systemKind: null, authorityEpoch,
    previousStateVersion: current.stateVersion, resultStateVersion: next.stateVersion,
    resultHash: canonicalStateHash(next), signedPayload: envelope, signature, identityFingerprint
  };
  recordTransition(packet);
  actions.transition?.send(packet).catch?.(() => {});
  broadcastPresence();
  return { next, packet };
}

async function createAndApplyJoinTransition(action, joinProof) {
  const current = getState();
  const next = dispatchDeterministic(action, { seed: joinProof.joinPayload.nonce, timestamp: joinProof.joinPayload.timestamp });
  const packet = {
    kind: 'state-transition', systemKind: 'join', authorityEpoch,
    previousStateVersion: current.stateVersion, resultStateVersion: next.stateVersion,
    resultHash: canonicalStateHash(next), action: structuredClone(action), joinProof: structuredClone(joinProof)
  };
  recordTransition(packet);
  actions.transition?.send(packet).catch?.(() => {});
  broadcastPresence();
  return { next, packet };
}

async function signedCheckpoint(reason = 'initial-join') {
  const state = getState();
  const payload = {
    kind: 'state-checkpoint', roomCode, playerId: localPlayerId, authorityEpoch,
    stateVersion: state?.stateVersion ?? 0, stateHash: canonicalStateHash(state), reason,
    timestamp: Date.now(), nonce: crypto.randomUUID()
  };
  const proof = await signPayload(payload);
  return { state, payload, signature: proof.signature, identityFingerprint: proof.fingerprint };
}

async function verifyCheckpoint(packet, peerId, { initial = false } = {}) {
  if (!packet?.state || !packet?.payload) throw new Error('Invalid state checkpoint.');
  validateIncomingStateSize(packet.state);
  const payload = packet.payload;
  if (payload.kind !== 'state-checkpoint' || payload.roomCode !== roomCode) throw new Error('Invalid checkpoint proof.');
  if (payload.stateVersion !== packet.state.stateVersion || payload.stateHash !== canonicalStateHash(packet.state)) throw new Error('Checkpoint state hash mismatch.');
  const owner = packet.state.players?.[payload.playerId];
  if (!owner?.identityPublicKey || owner.identityFingerprint !== packet.identityFingerprint) throw new Error('Checkpoint owner identity is invalid.');
  if (!(await verifySignedPayload(owner.identityPublicKey, payload, packet.signature))) throw new Error('Checkpoint signature verification failed.');
  if (initial && expectedOwnerFingerprint && packet.identityFingerprint !== expectedOwnerFingerprint) throw new Error('Lobby Owner fingerprint does not match the invite/session trust fingerprint.');
  if (!initial) throw new Error('Full-state replacement is disabled after joining. Use signed transition replay or snapshot recovery.');
  ownerPeerId = peerId;
  authorityEpoch = payload.authorityEpoch;
  const safeState = structuredClone(packet.state);
  safeState.network = {
    authorityEpoch: payload.authorityEpoch,
    ownerPlayerId: payload.playerId,
    backupOwnerPlayerId: null,
    reconnectTokens: {},
    recentTransitions: []
  };
  return safeState;
}

async function sendRecoveryState(target = null, manual = false) {
  const state = getState();
  if (!state || !localPlayerId) return;
  const digest = canonicalStateHash(state);
  const control = await makeSignedControl('recovery', { stateVersion: state.stateVersion, stateHash: digest, authorityEpoch, manual });
  const packet = { ...control, state };
  recoveryPackets.set(localPeerId, { state, stateVersion: state.stateVersion, stateHash: digest, playerId: localPlayerId, authorityEpoch, verified: true });
  actions.recovery?.send(packet, target ? { target } : undefined).catch?.(() => {});
}

function bestRecoveryState() {
  const local = getState();
  let best = { state: local, stateVersion: local?.stateVersion ?? 0, stateHash: canonicalStateHash(local), playerId: localPlayerId || '', verified: true };
  for (const p of recoveryPackets.values()) {
    if (!p?.verified) continue;
    if (p.stateVersion > best.stateVersion || (p.stateVersion === best.stateVersion && p.stateHash === best.stateHash && String(p.playerId || '').localeCompare(best.playerId) < 0)) best = p;
  }
  return best;
}

async function claimAuthority() {
  if (role === 'offline' || !localPlayerId) return;
  const winner = chooseMigrationWinner();
  if (!winner || winner.playerId !== localPlayerId) return;
  const best = bestRecoveryState();
  if (best?.state && best.stateVersion > (getState()?.stateVersion ?? 0)) loadState(best.state);
  const previousEpoch = authorityEpoch;
  const nextEpoch = previousEpoch + 1;
  const claim = await makeSignedControl('authority-claim', {
    previousAuthorityEpoch: previousEpoch,
    authorityEpoch: nextEpoch,
    ownerPlayerId: localPlayerId,
    stateVersion: getState()?.stateVersion ?? 0,
    stateHash: canonicalStateHash(getState())
  });
  role = 'owner';
  ownerPeerId = localPeerId;
  connectionState = 'connected';
  authorityEpoch = nextEpoch;
  setMeta({ authorityEpoch: nextEpoch, ownerPlayerId: localPlayerId });
  actions.authority?.send(claim).catch?.(() => {});
  broadcastPresence();
  broadcastRoster();
  saveSession();
  emit();
  window.dispatchEvent(new CustomEvent('network:owner-migrated', { detail: { playerId: localPlayerId, authorityEpoch: nextEpoch } }));
}

function beginMigration() {
  if (role !== 'peer' || migrationTimer) return;
  connectionState = 'migrating';
  ownerPeerId = null;
  waitingJoin = false;
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = null;
  recoveryPackets.clear();
  sendRecoveryState().catch(error => { lastError = error.message; emit(); });
  emit();
  migrationTimer = setTimeout(() => {
    migrationTimer = null;
    const winner = chooseMigrationWinner();
    if (!winner) {
      lastError = 'No verified eligible peer is available to become Lobby Owner.';
      connectionState = 'disconnected';
      emit();
      return;
    }
    if (winner.playerId === localPlayerId) setTimeout(() => claimAuthority().catch(error => { lastError = error.message; emit(); }), RECOVERY_WINDOW_MS);
  }, MIGRATION_DELAY_MS);
}

function setupRoom(r, selfId) {
  room = r;
  localPeerId = selfId;
  startRelayHealthMonitor();
  actions.presence = room.makeAction('dw-presence-v2');
  actions.join = room.makeAction('dw-join-v2');
  actions.joinAck = room.makeAction('dw-join-ack-v3');
  actions.ownerOffer = room.makeAction('dw-owner-offer-v1');
  actions.state = room.makeAction('dw-state-v2');
  actions.game = room.makeAction('dw-game-action-v2');
  actions.transition = room.makeAction('dw-transition-v2');
  actions.transitionBatch = room.makeAction('dw-transition-batch-v2');
  actions.result = room.makeAction('dw-action-result-v2');
  actions.stateReq = room.makeAction('dw-state-request-v2');
  actions.roster = room.makeAction('dw-roster-v2');
  actions.authority = room.makeAction('dw-authority-v2');
  actions.recovery = room.makeAction('dw-recovery-v2');

  room.onPeerJoin = peerId => {
    peers.set(peerId, { peerId, connectedAt: Date.now() });
    syncPeerInfo(peerId, { connectedAt: Date.now() });
    emit();
    broadcastPresence(peerId);
    if (role === 'owner') sendOwnerOffer(peerId).catch(() => {});
    if (role === 'peer' && waitingJoin && expectedOwnerFingerprint) startJoinRetry();
  };

  room.onPeerLeave = peerId => {
    const wasOwner = peerId === ownerPeerId;
    peers.delete(peerId);
    peerPlayers.delete(peerId);
    peerInfo.delete(peerId);
    emit();
    if (role === 'owner') broadcastRoster();
    if (role === 'peer' && wasOwner && !waitingJoin && !awaitingInitialState && connectionState === 'connected') beginMigration();
  };

  actions.presence.onMessage = async (packet, { peerId }) => {
    try {
      const payload = await verifySignedControl(packet, 'presence', peerId);
      syncPeerInfo(peerId, {
        playerId: payload.playerId, identityVerified: true, stateVersion: payload.stateVersion ?? 0,
        stateHash: payload.stateHash ?? null, authorityEpoch: payload.authorityEpoch ?? 0, role: payload.role
      });
      const local = getState();
      if (local && payload.stateVersion === local.stateVersion && payload.stateHash && payload.stateHash !== canonicalStateHash(local)) {
        lastError = `SECURITY: state fork detected from ${local.players?.[payload.playerId]?.displayName ?? payload.playerId} at version #${local.stateVersion}.`;
        connectionState = 'security-error';
      }
      if (payload.role === 'owner' && payload.authorityEpoch === authorityEpoch && payload.playerId === networkMeta().ownerPlayerId) {
        ownerPeerId = peerId;
        lastOwnerSeenAt = Date.now();
        if (role === 'peer' && waitingJoin) startJoinRetry();
      }
      emit();
    } catch {
      // Unauthenticated presence never changes authority or peer/player bindings.
    }
  };

  actions.roster.onMessage = async (packet, { peerId }) => {
    try {
      if (peerId !== ownerPeerId) return;
      const payload = await verifySignedControl(packet, 'roster', peerId);
      if (payload.authorityEpoch !== authorityEpoch || payload.playerId !== networkMeta().ownerPlayerId) return;
      // Roster hints are not identity bindings. Signed peer presence remains authoritative.
      for (const [id, info] of Object.entries(payload.roster || {})) {
        if (id === localPeerId) continue;
        const prior = peerInfo.get(id) || {};
        syncPeerInfo(id, { ...info, playerId: prior.identityVerified ? prior.playerId : null, identityVerified: Boolean(prior.identityVerified) });
      }
      emit();
    } catch {}
  };

  actions.authority.onMessage = async (packet, { peerId }) => {
    try {
      const payload = await verifySignedControl(packet, 'authority-claim', peerId);
      const currentOwnerStillConnected = ownerPeerId && peers.has(ownerPeerId);
      if (currentOwnerStillConnected && connectionState !== 'migrating') throw new Error('Authority claim rejected while the current owner is still connected.');
      if (payload.previousAuthorityEpoch !== authorityEpoch || payload.authorityEpoch !== authorityEpoch + 1) throw new Error('Authority claim must advance exactly one epoch.');
      const winner = chooseMigrationWinner();
      if (!winner || winner.playerId !== payload.playerId || winner.peerId !== peerId) throw new Error('Authority claimant is not the deterministic migration winner.');
      if (payload.stateVersion !== getState()?.stateVersion || payload.stateHash !== canonicalStateHash(getState())) throw new Error('Authority claimant does not share the verified current state.');
      const previousRole = role;
      authorityEpoch = payload.authorityEpoch;
      ownerPeerId = peerId;
      connectionState = 'connected';
      if (peerId !== localPeerId) role = 'peer';
      setMeta({ authorityEpoch, ownerPlayerId: payload.playerId });
      expectedOwnerFingerprint = getState()?.players?.[payload.playerId]?.identityFingerprint ?? expectedOwnerFingerprint;
      saveSession();
      if (previousRole === 'owner' && role === 'peer') window.dispatchEvent(new CustomEvent('network:authority-yielded', { detail: payload }));
      emit();
    } catch (error) {
      lastError = `Rejected authority claim: ${error.message}`;
      emit();
    }
  };

  actions.recovery.onMessage = async (packet, { peerId }) => {
    try {
      const payload = await verifySignedControl(packet, 'recovery', peerId, getState());
      validateIncomingStateSize(packet.state);
      if (payload.stateVersion !== packet.state?.stateVersion || payload.stateHash !== canonicalStateHash(packet.state)) throw new Error('Recovery state hash mismatch.');
      const local = getState();
      if (payload.stateVersion === local?.stateVersion && payload.stateHash !== canonicalStateHash(local)) throw new Error('Recovery peer reports a conflicting state at the same version.');
      if (payload.stateVersion > (local?.stateVersion ?? 0)) {
        const transitions = packet.state?.network?.recentTransitions ?? [];
        let simulated = local;
        for (const t of transitions.filter(t => t.previousStateVersion >= simulated.stateVersion).sort((a, b) => a.previousStateVersion - b.previousStateVersion)) {
          if (t.previousStateVersion !== simulated.stateVersion) continue;
          const verified = await verifyTransitionAgainstState(simulated, t);
          simulated = verified.next;
          if (simulated.stateVersion === payload.stateVersion) break;
        }
        if (!simulated || simulated.stateVersion !== payload.stateVersion || canonicalStateHash(simulated) !== payload.stateHash) throw new Error('Recovery state is ahead but cannot be reconstructed from signed transitions.');
      }
      const safeRecoveryState = structuredClone(packet.state);
      safeRecoveryState.network = structuredClone(local?.network ?? { authorityEpoch, ownerPlayerId: networkMeta().ownerPlayerId ?? null, backupOwnerPlayerId: networkMeta().backupOwnerPlayerId ?? null, reconnectTokens: {}, recentTransitions: [] });
      safeRecoveryState.network.reconnectTokens = {};
      safeRecoveryState.network.recentTransitions = (packet.state?.network?.recentTransitions ?? []).filter(t =>
        Number.isInteger(t?.previousStateVersion) && Number.isInteger(t?.resultStateVersion) && t.resultStateVersion > t.previousStateVersion
      ).slice(-MAX_RECENT_TRANSITIONS);
      recoveryPackets.set(peerId, { state: safeRecoveryState, stateVersion: payload.stateVersion, stateHash: payload.stateHash, playerId: payload.playerId, authorityEpoch: payload.authorityEpoch, verified: true });
      syncPeerInfo(peerId, { playerId: payload.playerId, identityVerified: true, stateVersion: payload.stateVersion, stateHash: payload.stateHash, authorityEpoch: payload.authorityEpoch });
    } catch (error) {
      lastError = `Rejected recovery packet: ${error.message}`;
      emit();
    }
  };


  actions.ownerOffer.onMessage = async (packet, { peerId }) => {
    if (role !== 'peer') return;
    try {
      const candidate = await verifyOwnerOffer(packet);
      candidate.peerId = peerId;
      if (expectedOwnerFingerprint) {
        if (candidate.fingerprint !== expectedOwnerFingerprint) return;
        discoveredOwner = candidate;
        ownerPeerId = peerId;
        if (waitingJoin) startJoinRetry();
        emit();
        return;
      }
      if (discoveredOwner && discoveredOwner.fingerprint !== candidate.fingerprint) {
        discoveredOwnerConflict = true;
        lastError = 'SECURITY: multiple different Lobby Owner identities answered this room code. Do not trust either until you verify with the host.';
        connectionState = 'awaiting-owner-trust';
        emit();
        return;
      }
      discoveredOwner = candidate;
      ownerPeerId = peerId;
      connectionState = 'awaiting-owner-trust';
      lastError = null;
      emit();
    } catch (error) {
      lastError = `Owner discovery rejected: ${error.message}`;
      emit();
    }
  };

  actions.join.onMessage = async (data, { peerId }) => {
    if (role !== 'owner') return;
    try {
      enforcePeerRate(peerJoinWindows, peerId, MAX_JOINS_PER_WINDOW, 'Join');
      const proof = await verifyJoinProof(data);
      const name = validateDisplayName(proof.payload.displayName || '');
      const state = getState();
      let playerId = null;
      let reconnected = false;
      const requested = proof.payload.reconnectPlayerId;
      if (requested && state.players?.[requested]) {
        const player = state.players[requested];
        if (player.identityFingerprint) {
          if (player.identityFingerprint !== proof.fingerprint) throw new Error('This browser identity does not own that player. Import the correct identity file to reconnect.');
          playerId = requested;
          reconnected = true;
        } else {
          const action = { type: 'PLAYER_IDENTITY_BOUND', actorId: requested, playerId: requested, identityFingerprint: proof.fingerprint, identityPublicKey: proof.publicJwk };
          await createAndApplyJoinTransition(action, data);
          playerId = requested;
          reconnected = true;
        }
      }
      if (!playerId) {
        const already = Object.values(state.players).find(p => p.identityFingerprint === proof.fingerprint);
        if (already) throw new Error(`This cryptographic identity already belongs to ${already.displayName}. Reconnect as that player instead.`);
        playerId = expectedNetworkPlayerId(proof.fingerprint);
        if (state.players[playerId]) throw new Error('A player with this network identity already exists. Reconnect instead.');
        const action = { type: 'PLAYER_ADDED', actorId: playerId, playerId, name, identityFingerprint: proof.fingerprint, identityPublicKey: proof.publicJwk };
        await createAndApplyJoinTransition(action, data);
      }
      peerPlayers.set(peerId, playerId);
      syncPeerInfo(peerId, { playerId, identityVerified: true, stateVersion: getState().stateVersion, stateHash: canonicalStateHash(getState()), authorityEpoch });
      const ackPayload = {
        kind: 'join-ack', roomCode, playerId: localPlayerId, joinedPlayerId: playerId,
        ownerPlayerId: localPlayerId, authorityEpoch, stateVersion: getState().stateVersion,
        timestamp: Date.now(), nonce: crypto.randomUUID(), reconnected
      };
      const ackProof = await signPayload(ackPayload);
      const checkpoint = await signedCheckpoint('initial-join');
      await actions.joinAck.send({
        ok: true,
        bootstrap: {
          ackPayload,
          ackSignature: ackProof.signature,
          ackIdentityFingerprint: ackProof.fingerprint,
          checkpoint
        }
      }, { target: peerId });
      broadcastRoster();
      emit();
    } catch (error) {
      actions.joinAck.send({ ok: false, error: error.message }, { target: peerId });
    }
  };

  actions.joinAck.onMessage = async (data, { peerId }) => {
    if (role !== 'peer' || (ownerPeerId && peerId !== ownerPeerId)) return;
    if (!data?.ok) {
      if (reconnectTimer) clearInterval(reconnectTimer);
      reconnectTimer = null;
      lastError = data?.error || 'Join rejected';
      connectionState = 'disconnected';
      emit();
      return;
    }
    try {
      const bootstrap = data.bootstrap;
      const checkpoint = bootstrap?.checkpoint;
      const state = await verifyCheckpoint(checkpoint, peerId, { initial: true });
      const owner = state.players?.[checkpoint.payload.playerId];
      if (!owner || owner.identityFingerprint !== checkpoint.identityFingerprint) throw new Error('Initial owner identity is inconsistent.');
      const ackPayload = bootstrap?.ackPayload;
      if (!ackPayload || ackPayload.kind !== 'join-ack' || ackPayload.roomCode !== roomCode) throw new Error('Missing signed join acknowledgement.');
      if (bootstrap.ackIdentityFingerprint !== owner.identityFingerprint) throw new Error('Join acknowledgement owner fingerprint mismatch.');
      if (!(await verifySignedPayload(owner.identityPublicKey, ackPayload, bootstrap.ackSignature))) throw new Error('Join acknowledgement signature is invalid.');
      if (ackPayload.playerId !== checkpoint.payload.playerId || ackPayload.ownerPlayerId !== checkpoint.payload.playerId) throw new Error('Join acknowledgement owner does not match checkpoint owner.');
      if (ackPayload.authorityEpoch !== checkpoint.payload.authorityEpoch || ackPayload.stateVersion !== checkpoint.payload.stateVersion) throw new Error('Join acknowledgement does not match checkpoint authority/state.');
      const localIdentity = await ensureIdentity();
      const joined = state.players?.[ackPayload.joinedPlayerId];
      if (!joined || joined.identityFingerprint !== localIdentity.fingerprint) throw new Error('Join acknowledgement does not assign this browser to its cryptographic player identity.');
      loadState(state);
      localPlayerId = ackPayload.joinedPlayerId;
      ownerPeerId = peerId;
      setMeta({ authorityEpoch: checkpoint.payload.authorityEpoch, ownerPlayerId: checkpoint.payload.playerId });
      authorityEpoch = checkpoint.payload.authorityEpoch;
      pendingJoinAck = null;
      awaitingInitialState = false;
      waitingJoin = false;
      if (reconnectTimer) clearInterval(reconnectTimer);
      reconnectTimer = null;
      connectionState = 'connected';
      expectedOwnerFingerprint = owner.identityFingerprint;
      discoveredOwner = null;
      discoveredOwnerConflict = false;
      lastError = null;
      saveSession();
      broadcastPresence();
      window.dispatchEvent(new CustomEvent('network:joined', { detail: { playerId: localPlayerId } }));
      emit();
    } catch (error) {
      lastError = `Initial join rejected: ${error.message}`;
      connectionState = 'security-error';
      emit();
    }
  };

  actions.stateReq.onMessage = async (data, { peerId }) => {
    if (role !== 'owner') return;
    const fromVersion = Number(data?.fromVersion ?? -1);
    if (data?.want === 'transitions' && Number.isInteger(fromVersion) && fromVersion >= 0) {
      const batch = transitionRange(fromVersion);
      if (batch) {
        actions.transitionBatch.send({ fromVersion, toVersion: getState()?.stateVersion ?? 0, authorityEpoch, transitions: batch }, { target: peerId }).catch?.(() => {});
      } else {
        actions.result.send({ ok: false, error: 'Secure transition history is unavailable for that state gap. Restore a verified local snapshot or rejoin from a trusted checkpoint.' }, { target: peerId }).catch?.(() => {});
      }
      return;
    }
    // Full-state replacement after joining is intentionally not provided.
    actions.result.send({ ok: false, error: 'Full-state overwrite is disabled after joining; secure resync uses signed transition replay.' }, { target: peerId }).catch?.(() => {});
  };

  actions.state.onMessage = async (_packet, { peerId }) => {
    // Initial joins use one atomic signed bootstrap packet on dw-join-ack-v3.
    // Ignore unsolicited full-state packets so a stale/hostile peer cannot race bootstrap.
    if (role === 'peer' && peerId === ownerPeerId) return;
  };

  actions.transition.onMessage = async (packet, { peerId }) => {
    if (role === 'owner' || peerId !== ownerPeerId) return;
    try {
      if (packet.authorityEpoch !== authorityEpoch) throw new Error('Transition came from a stale or future authority epoch.');
      await acceptTransition(packet);
    } catch (error) {
      lastError = `SECURITY: rejected state transition: ${error.message}`;
      connectionState = 'security-error';
      emit();
    }
  };

  actions.transitionBatch.onMessage = async (data, { peerId }) => {
    if (role === 'owner' || peerId !== ownerPeerId || data?.authorityEpoch !== authorityEpoch || !Array.isArray(data?.transitions)) return;
    try {
      for (const packet of data.transitions) await acceptTransition(packet, { fromBatch: true });
      if ((getState()?.stateVersion ?? 0) !== data.toVersion) throw new Error('Transition batch ended at the wrong state version.');
    } catch (error) {
      lastError = `SECURITY: secure resync failed: ${error.message}`;
      connectionState = 'security-error';
      emit();
    }
  };

  actions.game.onMessage = async (packet, { peerId }) => {
    if (role !== 'owner') return;
    const playerId = peerPlayers.get(peerId);
    const requestId = packet?.requestId;
    try {
      enforcePeerRate(peerActionWindows, peerId, MAX_ACTIONS_PER_WINDOW, 'Action');
      if (!playerId) throw new Error('This peer has not joined as a cryptographically verified player.');
      const envelope = packet?.signedPayload;
      validateNetworkActionSize(envelope?.action ?? {});
      if (!envelope || envelope.kind !== 'game-action' || envelope.playerId !== playerId || envelope.roomCode !== roomCode) throw new Error('Invalid signed action envelope.');
      if (Math.abs(Date.now() - Number(envelope.timestamp || 0)) > CONTROL_MAX_AGE_MS) throw new Error('Signed action expired.');
      const result = await createAndApplyOrdinaryTransition(envelope, packet.signature, packet.identityFingerprint);
      actions.result.send({ requestId, ok: true, stateVersion: result.next.stateVersion, stateHash: canonicalStateHash(result.next), authorityEpoch }, { target: peerId });
    } catch (error) {
      actions.result.send({ requestId, ok: false, error: error.message, stateVersion: getState()?.stateVersion ?? 0, authorityEpoch }, { target: peerId });
    }
  };

  actions.result.onMessage = data => {
    if (role !== 'peer') return;
    if (!data?.ok) {
      lastError = data?.error || 'Action rejected';
      window.dispatchEvent(new CustomEvent('network:action-rejected', { detail: { message: lastError } }));
    }
    emit();
  };
}

subscribe(state => {
  if (!room || !state) return;
  // Political state is replicated only by verified transitions. Subscription updates
  // may include local technical metadata, so we only announce the verified digest.
  if (role === 'owner' || role === 'peer') {
    broadcastPresence();
    if (role === 'owner') broadcastRoster();
  }
});

export async function createOnlineLobby(code = generateRoomCode()) {
  if (!hasGame()) throw new Error('Create or load a Democracy before opening an online lobby.');
  cleanup();
  const mod = await trystero();
  role = 'owner';
  connectionState = 'connecting';
  roomCode = normCode(code) || generateRoomCode();
  ownerPeerId = mod.selfId;
  localPeerId = mod.selfId;
  const state = getState();
  localPlayerId = Object.values(state.players).find(p => p.roles?.includes('creator') && p.status === 'active')?.id || Object.values(state.players).find(p => p.status === 'active')?.id || null;
  displayName = state.players?.[localPlayerId]?.displayName || 'Lobby Owner';
  const identity = await ensureIdentity();
  const player = getState().players?.[localPlayerId];
  if (localPlayerId && !player?.identityFingerprint) {
    applyLocalAction({ type: 'PLAYER_IDENTITY_BOUND', actorId: localPlayerId, playerId: localPlayerId, identityFingerprint: identity.fingerprint, identityPublicKey: identity.publicJwk });
  } else if (player?.identityFingerprint && player.identityFingerprint !== identity.fingerprint) {
    throw new Error('This Lobby Owner player belongs to a different cryptographic identity. Import the correct identity before hosting.');
  }
  authorityEpoch = Math.max(getState().network?.authorityEpoch ?? 0, 0) + 1;
  setMeta({ authorityEpoch, ownerPlayerId: localPlayerId, reconnectTokens: {}, recentTransitions: getState().network?.recentTransitions ?? [] });
  setupRoom(mod.joinRoom(trysteroRoomConfig(), roomCode, { onJoinError: handleTrysteroJoinError }), mod.selfId);
  connectionState = 'connected';
  saveSession();
  broadcastPresence();
  emit();
  return getNetworkStatus();
}

function normalizeOwnerFingerprint(value = '') {
  const clean = String(value ?? '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  return clean.length === 64 ? clean : '';
}

export async function joinOnlineLobby(code, name, { forceNewIdentity = false, ownerFingerprint = '' } = {}) {
  cleanup();
  const clean = normCode(code);
  if (!clean) throw new Error('Enter a lobby code.');
  const prior = !forceNewIdentity ? readSession(clean) : null;
  const url = new URL(location.href);
  const urlRoom = normCode(url.searchParams.get('room') || '');
  const inviteFingerprint = urlRoom === clean ? normalizeOwnerFingerprint(url.searchParams.get('ownerfp') || '') : '';
  const manualFingerprint = normalizeOwnerFingerprint(ownerFingerprint);
  const rememberedFingerprint = normalizeOwnerFingerprint(prior?.ownerFingerprint || '');
  expectedOwnerFingerprint = inviteFingerprint || manualFingerprint || rememberedFingerprint || null;
  const chosenName = (name?.trim() || prior?.displayName || '').trim();
  if (!chosenName) throw new Error('Enter your display name.');
  if (forceNewIdentity) await rotateIdentity();
  const mod = await trystero();
  role = 'peer';
  connectionState = expectedOwnerFingerprint ? (prior ? 'reconnecting' : 'connecting') : 'discovering-owner';
  roomCode = clean;
  localPeerId = mod.selfId;
  waitingJoin = true;
  displayName = chosenName;
  localPlayerId = prior?.playerId || null;
  authorityEpoch = 0; // Never inherit authority from an unrelated/stale local save while joining.
  setupRoom(mod.joinRoom(trysteroRoomConfig(), roomCode, { onJoinError: handleTrysteroJoinError }), mod.selfId);
  if (expectedOwnerFingerprint) startJoinRetry();
  emit();
  return getNetworkStatus();
}

export async function resumeOnlineSession(code) {
  const prior = readSession(code);
  if (!prior) return false;
  await joinOnlineLobby(code, prior.displayName || 'Player');
  return true;
}

export async function trustDiscoveredOwner() {
  if (role !== 'peer' || !discoveredOwner) throw new Error('No Lobby Owner identity has been discovered yet.');
  if (discoveredOwnerConflict) throw new Error('Conflicting owner identities were discovered. Verify the full fingerprint with the host and reconnect using it explicitly.');
  expectedOwnerFingerprint = discoveredOwner.fingerprint;
  ownerPeerId = discoveredOwner.peerId;
  connectionState = 'connecting';
  waitingJoin = true;
  lastError = null;
  startJoinRetry();
  emit();
  return expectedOwnerFingerprint;
}

export function leaveOnlineLobby({ forgetIdentity = false } = {}) { cleanup({ forgetSession: forgetIdentity }); }
export function subscribeNetwork(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLocalPlayerId() { return localPlayerId; }
export function isOnlinePeer() { return role === 'peer'; }
export function isOnlineOwner() { return role === 'owner'; }
function signalingStatus() {
  refreshRelayHealth();
  const rows = SIGNALING_RELAYS.map(url => {
    const rec = ensureRelayRecord(url);
    return {
      url,
      status: rec.status,
      failures: rec.failures || 0,
      lastFailureReason: rec.lastFailureReason || null,
      lastFailureAt: rec.lastFailureAt || null,
      nextRetryAt: rec.nextRetryAt || null,
      connectedAt: rec.connectedAt || null
    };
  });
  return {
    configured: SIGNALING_RELAYS.length,
    observed: rows.filter(r => r.connectedAt || r.lastFailureAt).length,
    open: rows.filter(r => r.status === 'connected').length,
    connecting: rows.filter(r => r.status === 'retrying').length,
    unavailable: rows.filter(r => r.status === 'unavailable').length,
    relays: rows
  };
}
export function getNetworkStatus() {
  const turn = readTurnSettings();
  return {
    role, connectionState, roomCode, ownerPeerId,
    ownerPlayerId: connectionState === 'connected' ? (networkMeta().ownerPlayerId ?? null) : (discoveredOwner?.playerId ?? null),
    discoveredOwner: discoveredOwner ? { playerId: discoveredOwner.playerId, displayName: discoveredOwner.displayName, fingerprint: discoveredOwner.fingerprint, peerId: discoveredOwner.peerId } : null,
    discoveredOwnerConflict,
    localPeerId, localPlayerId, connectedPeers: [...peers.keys()], peerPlayers: Object.fromEntries(peerPlayers),
    peerInfo: Object.fromEntries(peerInfo), authorityEpoch, backupOwnerPlayerId: networkMeta().backupOwnerPlayerId ?? null,
    reconnectAttempt, lastOwnerSeenAt, lastError,
    verifiedStateHash: canonicalStateHash(getState()), verifiedTransitionCount: recentTransitions().length,
    signaling: signalingStatus(),
    turn: { configured: Boolean(turn.urls.length), urlCount: turn.urls.length, forceRelay: turn.forceRelay }
  };
}
export function inviteUrl() {
  if (!roomCode) return '';
  const u = new URL(location.href);
  u.hash = 'multiplayer';
  u.searchParams.set('room', roomCode);
  const ownerFp = getState()?.players?.[networkMeta().ownerPlayerId]?.identityFingerprint;
  if (ownerFp) u.searchParams.set('ownerfp', ownerFp);
  return u.toString();
}
export function setBackupOwnerPlayer(playerId) {
  if (role !== 'owner') throw new Error('Only the Lobby Owner can choose the backup owner.');
  if (playerId && playerId === localPlayerId) throw new Error('Choose another connected player as backup.');
  if (playerId && !candidateEntries().some(c => c.playerId === playerId)) throw new Error('Backup owner must currently be a cryptographically verified connected player.');
  setMeta({ backupOwnerPlayerId: playerId || null });
  broadcastRoster();
  emit();
}

export function submitAction(action) {
  validateNetworkActionSize(action);
  if (role === 'offline') return applyLocalAction(action);
  if (!localPlayerId) throw new Error('This browser has no bound local player identity.');
  if (role === 'peer' && !ownerPeerId) {
    lastError = connectionState === 'migrating' ? 'Lobby Owner migration is in progress.' : 'Lobby Owner is not connected yet.';
    emit();
    throw new Error(lastError);
  }
  const requestId = crypto.randomUUID();
  (async () => {
    try {
      const signedPayload = {
        kind: 'game-action', roomCode, playerId: localPlayerId, action,
        expectedStateVersion: getState()?.stateVersion ?? 0,
        expectedAuthorityEpoch: authorityEpoch,
        timestamp: Date.now(), nonce: crypto.randomUUID()
      };
      const proof = await signPayload(signedPayload);
      if (role === 'owner') {
        await createAndApplyOrdinaryTransition(signedPayload, proof.signature, proof.fingerprint);
      } else {
        await actions.game.send({ requestId, signedPayload, signature: proof.signature, identityFingerprint: proof.fingerprint }, { target: ownerPeerId });
      }
    } catch (error) {
      lastError = error.message;
      window.dispatchEvent(new CustomEvent('network:action-rejected', { detail: { message: lastError } }));
      emit();
    }
  })();
  return getState();
}

export function requestFullResync() {
  if (role === 'offline') throw new Error('Not connected to an online lobby.');
  if (role === 'owner') {
    broadcastPresence();
    return { broadcast: true, mode: 'verified-transition-head' };
  }
  if (!ownerPeerId) throw new Error('No Lobby Owner is currently known. Use recovery broadcast during migration.');
  actions.stateReq?.send({ want: 'transitions', fromVersion: getState()?.stateVersion ?? 0, authorityEpoch, manual: true }, { target: ownerPeerId });
  return { requested: true, ownerPeerId, fromVersion: getState()?.stateVersion ?? 0 };
}

export function broadcastRecoveryState() {
  if (role === 'offline') throw new Error('Not connected to an online lobby.');
  const state = getState();
  if (!state) throw new Error('No game state is loaded.');
  sendRecoveryState(null, true).catch(error => { lastError = error.message; emit(); });
  if (role === 'peer' && !ownerPeerId) beginMigration();
  return { stateVersion: state.stateVersion, authorityEpoch, stateHash: canonicalStateHash(state) };
}

export function getRecoveryDiagnostics() {
  const local = getState();
  return {
    role, connectionState, roomCode, localPeerId, localPlayerId, ownerPeerId,
    ownerPlayerId: networkMeta().ownerPlayerId ?? null, authorityEpoch,
    localStateVersion: local?.stateVersion ?? 0, localStateHash: canonicalStateHash(local), localEventHeadHash: local?.history?.at(-1)?.hash ?? null,
    recoveryPackets: [...recoveryPackets.entries()].map(([peerId, p]) => ({ peerId, playerId: p.playerId ?? null, stateVersion: p.stateVersion ?? 0, stateHash: p.stateHash ?? null, authorityEpoch: p.authorityEpoch ?? 0, verified: Boolean(p.verified), eventHeadHash: p.state?.history?.at(-1)?.hash ?? null })),
    peers: [...peerInfo.entries()].map(([peerId, p]) => ({ peerId, playerId: p.playerId ?? null, identityVerified: Boolean(p.identityVerified), stateVersion: p.stateVersion ?? 0, stateHash: p.stateHash ?? null, authorityEpoch: p.authorityEpoch ?? 0, role: p.role ?? null, lastSeenAt: p.lastSeenAt ?? null })),
    backupOwnerPlayerId: networkMeta().backupOwnerPlayerId ?? null,
    verifiedTransitionCount: recentTransitions().length,
    lastError
  };
}
