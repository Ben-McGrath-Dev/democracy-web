import { DurableObject } from 'cloudflare:workers';
import { CLOUD_PROTOCOL_VERSION, CLOUD_MESSAGE, protocolEnvelope, parseProtocolMessage } from '../../shared/protocol.js';
import { cloudAuthPayload, cloudPublicKeyFingerprint, verifyCloudAuthSignature, challengeExpired } from '../../shared/cloud-auth.js';
import { cloudActionPayload, cloudJoinDecisionPayload, cloudPlayerIdForFingerprint, cloudCommitHash, sameCloudAction, verifyCloudSignedPayload } from '../../shared/cloud-action.js';
import { canonicalStateHash, stableStringify } from '../../shared/integrity.js';
import { authorizePeerAction, canAdministerPlayers } from '../../shared/permissions.js';
import { reduceDeterministic } from '../../shared/reducer.js';
import { splitUtf8Text, joinSnapshotChunks, CLOUD_SNAPSHOT_CHUNK_BYTES } from '../../shared/cloud-recovery.js';

const ROOM_CODE_RE = /^[A-Z2-9]{6}$/;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const AUTH_TTL_MS = 60_000;
const MAX_INITIAL_STATE_BYTES = 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 128 * 1024;
const SNAPSHOT_INTERVAL = 50;
const SNAPSHOT_CHUNK_BYTES = CLOUD_SNAPSHOT_CHUNK_BYTES;
const MAX_RECOVERY_COMMITS = 50;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function configuredOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
}

function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return configuredOrigins(env).has(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !configuredOrigins(env).has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin'
  };
}

function validCreator(value) {
  return Boolean(value && typeof value === 'object' && typeof value.fingerprint === 'string' && value.fingerprint.length === 64 && value.publicJwk?.kty === 'EC' && value.publicJwk?.crv === 'P-256');
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function safeParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      if (!originAllowed(request, env)) return json({ error: 'origin_not_allowed' }, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (!originAllowed(request, env)) return json({ error: 'origin_not_allowed' }, { status: 403 });

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'democracy-web-cloud', protocol: CLOUD_PROTOCOL_VERSION, phases: [36, 37, 38, 39, 40, 41, 42, 43, 44], release: '1.1.0', transport: 'cloud-websocket' }, { headers: cors });
    }

    if (url.pathname === '/rooms' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const requestedCode = typeof body?.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : null;
      const roomCode = requestedCode && ROOM_CODE_RE.test(requestedCode) ? requestedCode : randomRoomCode();
      const creator = validCreator(body?.creator) ? body.creator : null;
      if (!creator) return json({ error: 'creator_identity_required', message: 'Room creation requires a secure Democracy public identity.' }, { status: 400, headers: cors });
      const actualFingerprint = await cloudPublicKeyFingerprint(creator.publicJwk);
      if (actualFingerprint !== creator.fingerprint) return json({ error: 'creator_fingerprint_mismatch' }, { status: 400, headers: cors });
      if (!body?.initialState || typeof body.initialState !== 'object') return json({ error: 'initial_state_required', message: 'Creating a Cloud room requires the current verified Democracy state.' }, { status: 400, headers: cors });
      if (jsonBytes(body.initialState) > MAX_INITIAL_STATE_BYTES) return json({ error: 'initial_state_too_large' }, { status: 413, headers: cors });

      const id = env.DEMOCRACY_ROOMS.idFromName(roomCode);
      const stub = env.DEMOCRACY_ROOMS.get(id);
      const response = await stub.fetch(new Request(`https://room.internal/init?code=${roomCode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator, initialState: body.initialState })
      }));
      if (!response.ok) return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
      const info = await response.json();
      return json(info, { status: 201, headers: cors });
    }

    const match = url.pathname.match(/^\/rooms\/([A-Z2-9]{6})(?:\/(ws))?$/);
    if (match) {
      const [, roomCode, ws] = match;
      const id = env.DEMOCRACY_ROOMS.idFromName(roomCode);
      const stub = env.DEMOCRACY_ROOMS.get(id);
      const target = new URL(request.url);
      target.hostname = 'room.internal';
      target.pathname = ws ? '/ws' : '/info';
      target.searchParams.set('code', roomCode);
      const proxied = await stub.fetch(new Request(target, request));
      // WebSocket upgrade Responses contain a Cloudflare-specific `webSocket` object.
      // Return them untouched; reconstructing the Response can break the 101 upgrade
      // in production even when the Durable Object accepted the socket correctly.
      if (ws) return proxied;

      const headers = new Headers(proxied.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(proxied.body, { status: proxied.status, statusText: proxied.statusText, headers });
    }

    return json({ error: 'not_found' }, { status: 404, headers: cors });
  }
};

export class DemocracyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.actionQueue = Promise.resolve();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        connection_id TEXT PRIMARY KEY,
        connected_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        fingerprint TEXT,
        auth_role TEXT,
        player_id TEXT,
        authenticated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS join_requests (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        public_jwk TEXT NOT NULL,
        display_name TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        player_id TEXT
      );
      CREATE TABLE IF NOT EXISTS used_nonces (
        nonce_key TEXT PRIMARY KEY,
        used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commits (
        sequence INTEGER PRIMARY KEY,
        commit_hash TEXT NOT NULL,
        previous_commit_hash TEXT,
        player_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        commit_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        sequence INTEGER PRIMARY KEY,
        state_version INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        commit_hash TEXT,
        created_at INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        byte_length INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_chunks (
        snapshot_sequence INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        PRIMARY KEY(snapshot_sequence, chunk_index)
      );
    `);
    try { this.sql.exec('ALTER TABLE connections ADD COLUMN fingerprint TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE connections ADD COLUMN auth_role TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE connections ADD COLUMN player_id TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE connections ADD COLUMN authenticated_at INTEGER'); } catch {}
    try { this.sql.exec('ALTER TABLE snapshots ADD COLUMN commit_hash TEXT'); } catch {}
    try {
      const snapshotCount = Number(this.sql.exec('SELECT COUNT(*) AS n FROM snapshots').one()?.n || 0);
      const existingState = this.getStateRecord();
      if (snapshotCount === 0 && existingState?.state) {
        const latest = this.latestCommit();
        this.createPersistentSnapshot(latest.sequence, existingState.state, existingState.stateHash, existingState.updatedAt || Date.now(), latest.commitHash);
      }
    } catch {}
  }

  metaGet(key) {
    const row = this.sql.exec('SELECT value FROM room_meta WHERE key = ? LIMIT 1', key).one();
    return row?.value ?? null;
  }

  metaSet(key, value) {
    this.sql.exec('INSERT INTO room_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  }

  getStateRecord() {
    const row = this.sql.exec('SELECT state_json,state_hash,state_version,updated_at FROM room_state WHERE id=1 LIMIT 1').one();
    if (!row) return null;
    return { state: safeParse(row.state_json), stateHash: row.state_hash, stateVersion: Number(row.state_version), updatedAt: Number(row.updated_at) };
  }

  persistState(state, stateHash, updatedAt = Date.now()) {
    this.sql.exec(
      'INSERT INTO room_state(id,state_json,state_hash,state_version,updated_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,state_hash=excluded.state_hash,state_version=excluded.state_version,updated_at=excluded.updated_at',
      JSON.stringify(state), stateHash, Number(state.stateVersion || 0), updatedAt
    );
    this.metaSet('stateVersion', String(state.stateVersion || 0));
    this.metaSet('stateHash', stateHash);
  }

  latestCommit() {
    const row = this.sql.exec('SELECT sequence,commit_hash FROM commits ORDER BY sequence DESC LIMIT 1').one();
    return row ? { sequence: Number(row.sequence), commitHash: row.commit_hash } : { sequence: 0, commitHash: null };
  }

  commitHashAt(sequence) {
    const n = Number(sequence || 0);
    if (n === 0) return null;
    const row = this.sql.exec('SELECT commit_hash FROM commits WHERE sequence=? LIMIT 1', n).one();
    return row?.commit_hash || null;
  }

  sendResume(ws, fromSequence, lastCommitHash = null) {
    const latest = this.latestCommit();
    const from = Number(fromSequence || 0);
    const expectedHead = this.commitHashAt(from);
    if (from < 0 || from > latest.sequence || (from > 0 && expectedHead !== (lastCommitHash || null))) {
      this.sendRecoveryBundle(ws);
      return;
    }
    if (from === latest.sequence) {
      ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.RECOVERY_BUNDLE, { snapshot: null, commits: [], baseSequence: from, targetSequence: latest.sequence, targetCommitHash: latest.commitHash, serverNow: Date.now() })));
      return;
    }
    if (latest.sequence - from <= MAX_RECOVERY_COMMITS) {
      const commits = this.commitsAfter(from, MAX_RECOVERY_COMMITS);
      ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.RECOVERY_BUNDLE, { snapshot: null, commits, baseSequence: from, targetSequence: latest.sequence, targetCommitHash: latest.commitHash, serverNow: Date.now() })));
      return;
    }
    this.sendRecoveryBundle(ws);
  }

  splitSnapshotText(text, maxBytes = SNAPSHOT_CHUNK_BYTES) {
    return splitUtf8Text(text, maxBytes);
  }

  createPersistentSnapshot(sequence, state, stateHash, createdAt = Date.now(), commitHash = null) {
    const text = JSON.stringify(state);
    const chunks = this.splitSnapshotText(text);
    const byteLength = new TextEncoder().encode(text).byteLength;
    this.sql.exec('INSERT OR REPLACE INTO snapshots(sequence,state_version,state_hash,commit_hash,created_at,chunk_count,byte_length) VALUES (?,?,?,?,?,?,?)', Number(sequence), Number(state.stateVersion || 0), stateHash, commitHash, createdAt, chunks.length, byteLength);
    this.sql.exec('DELETE FROM snapshot_chunks WHERE snapshot_sequence=?', Number(sequence));
    chunks.forEach((chunk, index) => this.sql.exec('INSERT INTO snapshot_chunks(snapshot_sequence,chunk_index,chunk_text) VALUES (?,?,?)', Number(sequence), index, chunk));
  }

  loadPersistentSnapshot(sequence = null) {
    const row = sequence == null
      ? this.sql.exec('SELECT sequence,state_version,state_hash,commit_hash,created_at,chunk_count,byte_length FROM snapshots ORDER BY sequence DESC LIMIT 1').one()
      : this.sql.exec('SELECT sequence,state_version,state_hash,commit_hash,created_at,chunk_count,byte_length FROM snapshots WHERE sequence=? LIMIT 1', Number(sequence)).one();
    if (!row) return null;
    const chunks = [...this.sql.exec('SELECT chunk_text FROM snapshot_chunks WHERE snapshot_sequence=? ORDER BY chunk_index ASC', Number(row.sequence))].map(item => item.chunk_text);
    if (chunks.length !== Number(row.chunk_count)) throw new Error('Persistent snapshot is incomplete.');
    const text = joinSnapshotChunks(chunks, Number(row.chunk_count));
    const state = safeParse(text);
    if (!state || canonicalStateHash(state) !== row.state_hash || Number(state.stateVersion || 0) !== Number(row.state_version)) throw new Error('Persistent snapshot integrity verification failed.');
    return { sequence: Number(row.sequence), stateVersion: Number(row.state_version), stateHash: row.state_hash, lastCommitHash: row.commit_hash || null, createdAt: Number(row.created_at), byteLength: Number(row.byte_length), state };
  }

  commitsAfter(sequence, limit = MAX_RECOVERY_COMMITS) {
    return [...this.sql.exec('SELECT commit_json FROM commits WHERE sequence>? ORDER BY sequence ASC LIMIT ?', Number(sequence || 0), Number(limit))]
      .map(row => safeParse(row.commit_json))
      .filter(Boolean);
  }

  sendRecoveryBundle(ws) {
    const snapshot = this.loadPersistentSnapshot();
    if (!snapshot) return this.sendSnapshot(ws);
    const latest = this.latestCommit();
    const commits = this.commitsAfter(snapshot.sequence, MAX_RECOVERY_COMMITS + 1);
    if (commits.length > MAX_RECOVERY_COMMITS || (snapshot.sequence + commits.length) !== latest.sequence) return this.sendSnapshot(ws);
    ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.RECOVERY_BUNDLE, {
      snapshot,
      commits,
      targetSequence: latest.sequence,
      targetCommitHash: latest.commitHash,
      serverNow: Date.now()
    })));
  }

  roomInfo() {
    const latest = this.latestCommit();
    return {
      roomCode: this.metaGet('roomCode'),
      protocol: CLOUD_PROTOCOL_VERSION,
      createdAt: this.metaGet('createdAt'),
      stateVersion: Number(this.metaGet('stateVersion') || 0),
      stateHash: this.metaGet('stateHash'),
      commitSequence: latest.sequence,
      lastCommitHash: latest.commitHash,
      serverNow: Date.now(),
      snapshotSequence: Number(this.sql.exec('SELECT COALESCE(MAX(sequence),0) AS n FROM snapshots').one()?.n || 0),
      snapshotCount: Number(this.sql.exec('SELECT COUNT(*) AS n FROM snapshots').one()?.n || 0),
      connectedClients: this.ctx.getWebSockets().length,
      authenticatedClients: Number(this.sql.exec('SELECT COUNT(*) AS n FROM connections WHERE authenticated_at IS NOT NULL').one()?.n || 0),
      status: 'durable-recovery-sequencer'
    };
  }

  statePlayerByFingerprint(fingerprint) {
    const state = this.getStateRecord()?.state;
    if (!state) return null;
    return Object.values(state.players || {}).find(player => player.identityFingerprint === fingerprint && player.identityPublicKey) || null;
  }

  async validateInitialState(initialState, creator) {
    const creatorPlayer = initialState?.players?.[creator.playerId];
    if (!creatorPlayer || !creatorPlayer.roles?.includes('creator')) throw new Error('The supplied creator player does not exist in the initial state.');
    const seenFingerprints = new Set();
    for (const player of Object.values(initialState?.players || {})) {
      if (!player.identityFingerprint) continue;
      if (!player.identityPublicKey) throw new Error(`Player ${player.id || 'unknown'} has a fingerprint without a public identity key.`);
      if (seenFingerprints.has(player.identityFingerprint)) throw new Error('The initial state contains the same cryptographic identity on more than one player.');
      seenFingerprints.add(player.identityFingerprint);
    }
    if (creatorPlayer.identityFingerprint !== creator.fingerprint) throw new Error('The initial state creator fingerprint does not match the room creator identity.');
    if (!creatorPlayer.identityPublicKey) throw new Error('The initial state creator must contain its public identity key.');
    const storedFingerprint = await cloudPublicKeyFingerprint(creatorPlayer.identityPublicKey);
    if (storedFingerprint !== creator.fingerprint || stableStringify(creatorPlayer.identityPublicKey) !== stableStringify(creator.publicJwk)) throw new Error('The initial state creator public key does not match the room creator identity.');
    return canonicalStateHash(initialState);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      const code = url.searchParams.get('code');
      if (!ROOM_CODE_RE.test(code || '')) return json({ error: 'invalid_room_code' }, { status: 400 });
      let body = {};
      try { body = await request.json(); } catch {}
      if (!validCreator(body?.creator) || !body?.initialState) return json({ error: 'creator_identity_and_state_required' }, { status: 400 });
      if (!this.metaGet('roomCode')) {
        try {
          const stateHash = await this.validateInitialState(body.initialState, body.creator);
          this.metaSet('roomCode', code);
          this.metaSet('createdAt', new Date().toISOString());
          this.metaSet('creatorFingerprint', body.creator.fingerprint);
          this.metaSet('creatorPublicJwk', JSON.stringify(body.creator.publicJwk));
          this.metaSet('creatorPlayerId', body.creator.playerId || '');
          this.metaSet('creatorDisplayName', body.creator.displayName || '');
          this.persistState(body.initialState, stateHash);
          this.createPersistentSnapshot(0, body.initialState, stateHash, Date.now());
        } catch (error) {
          return json({ error: 'invalid_initial_state', message: error.message }, { status: 400 });
        }
      } else if (this.metaGet('creatorFingerprint') !== body.creator.fingerprint) {
        return json({ error: 'room_code_in_use' }, { status: 409 });
      }
      return json(this.roomInfo());
    }

    if (url.pathname === '/info' && request.method === 'GET') {
      if (!this.metaGet('roomCode')) return json({ error: 'room_not_initialized' }, { status: 404 });
      return json(this.roomInfo());
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'websocket_upgrade_required' }, { status: 426 });
      if (!this.metaGet('roomCode')) return json({ error: 'room_not_initialized' }, { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const connectionId = crypto.randomUUID();
      const issuedAt = Date.now();
      const challenge = {
        roomCode: this.metaGet('roomCode'),
        challengeId: crypto.randomUUID(),
        nonce: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
        issuedAt,
        expiresAt: issuedAt + AUTH_TTL_MS
      };
      this.ctx.acceptWebSocket(server, [connectionId]);
      server.serializeAttachment({ connectionId, connectedAt: issuedAt, challenge, authenticated: false, fingerprint: null, publicJwk: null, authRole: null, playerId: null });
      this.sql.exec('INSERT OR REPLACE INTO connections(connection_id,connected_at,last_seen_at,fingerprint,auth_role,player_id,authenticated_at) VALUES (?,?,?,?,?,?,?)', connectionId, issuedAt, issuedAt, null, null, null, null);
      server.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.WELCOME, { ...this.roomInfo(), connectionId })));
      server.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.AUTH_CHALLENGE, challenge)));
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'not_found' }, { status: 404 });
  }

  async webSocketMessage(ws, message) {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(raw).byteLength > MAX_WS_MESSAGE_BYTES) {
      ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.ERROR, { code: 'message_too_large', message: 'Cloud message exceeded the maximum allowed size.' })));
      return;
    }
    try {
      const parsed = parseProtocolMessage(raw);
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.connectionId) this.sql.exec('UPDATE connections SET last_seen_at=? WHERE connection_id=?', Date.now(), attachment.connectionId);

      if (parsed.type === CLOUD_MESSAGE.PING) {
        const serverAt = Date.now();
        ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.PONG, { clientSentAt: Number(parsed.payload?.clientSentAt || 0), serverAt })));
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.HELLO) {
        ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.ROOM_INFO, this.roomInfo())));
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.AUTH_RESPONSE) {
        await this.handleAuthentication(ws, attachment, parsed.payload || {});
        return;
      }
      if (!attachment.authenticated) {
        ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.ERROR, { code: 'authentication_required', message: 'Authenticate this WebSocket before using room messages.' })));
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.JOIN_REQUEST) {
        await this.handleJoinRequest(ws, attachment, parsed.payload || {});
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.JOIN_DECISION) {
        await this.handleJoinDecision(ws, attachment, parsed.payload || {});
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.ACTION_SUBMIT) {
        this.actionQueue = this.actionQueue.then(() => this.handleActionSubmit(ws, attachment, parsed.payload || {})).catch(error => {
          try { ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.ERROR, { code: 'action_rejected', message: error?.message || 'Cloud action rejected.' }))); } catch {}
        });
        await this.actionQueue;
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.RESUME) {
        if (!attachment.playerId) throw new Error('Only approved players may resume game state.');
        this.sendResume(ws, parsed.payload?.fromSequence, parsed.payload?.lastCommitHash || null);
        return;
      }
      if (parsed.type === CLOUD_MESSAGE.RESYNC_REQUEST) {
        if (!attachment.playerId) throw new Error('Only approved players may resynchronise game state.');
        const fromSequence = Number(parsed.payload?.fromSequence || 0);
        const latest = this.latestCommit();
        const preferDelta = parsed.payload?.preferDelta === true && parsed.payload?.forceSnapshot !== true;
        if (preferDelta && fromSequence >= 0 && fromSequence < latest.sequence && latest.sequence - fromSequence <= MAX_RECOVERY_COMMITS) {
          const commits = this.commitsAfter(fromSequence, MAX_RECOVERY_COMMITS);
          ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.RECOVERY_BUNDLE, {
            snapshot: null, commits, baseSequence: fromSequence, targetSequence: latest.sequence, targetCommitHash: latest.commitHash, serverNow: Date.now()
          })));
        } else {
          this.sendRecoveryBundle(ws);
        }
        return;
      }

      ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.ERROR, { code: 'unsupported_message', message: `${parsed.type} is not supported by the Democracy Web 1.1 Cloud protocol.` })));
    } catch (error) {
      ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.ERROR, { code: 'bad_message', message: error?.message || 'Invalid protocol message.' })));
    }
  }

  async handleAuthentication(ws, attachment, payload) {
    if (attachment.authenticated) throw new Error('This WebSocket session is already authenticated.');
    const challenge = attachment.challenge;
    if (!challenge || challengeExpired(challenge)) throw new Error('Authentication challenge expired. Reconnect and try again.');
    if (payload.challengeId !== challenge.challengeId) throw new Error('Authentication challenge mismatch.');
    const publicJwk = payload.publicJwk;
    const fingerprint = await cloudPublicKeyFingerprint(publicJwk);
    if (fingerprint !== payload.fingerprint) throw new Error('Authentication fingerprint mismatch.');
    const authPayload = cloudAuthPayload(challenge);
    const valid = await verifyCloudAuthSignature(publicJwk, authPayload, payload.signature);
    if (!valid) throw new Error('Authentication signature is invalid.');

    const player = this.statePlayerByFingerprint(fingerprint);
    if (player?.identityPublicKey) {
      const stateFingerprint = await cloudPublicKeyFingerprint(player.identityPublicKey);
      if (stateFingerprint !== fingerprint) throw new Error('Registered player identity does not match the authenticated key.');
    }
    const role = player ? (player.roles?.includes('creator') ? 'creator' : 'player') : 'unregistered';
    const nextAttachment = { ...attachment, authenticated: true, fingerprint, publicJwk, authRole: role, playerId: player?.id || null, challenge: null };
    ws.serializeAttachment(nextAttachment);
    this.sql.exec('UPDATE connections SET fingerprint=?,auth_role=?,player_id=?,authenticated_at=?,last_seen_at=? WHERE connection_id=?', fingerprint, role, player?.id || null, Date.now(), Date.now(), attachment.connectionId);
    ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.AUTH_OK, { fingerprint, role, playerId: player?.id || null, displayName: player?.displayName || null, roomCode: this.metaGet('roomCode'), ...this.roomInfo() })));
    if (player) {
      const resumeFrom = payload.resumeFromSequence;
      if (resumeFrom != null) this.sendResume(ws, resumeFrom, payload.resumeLastCommitHash || null);
      else this.sendRecoveryBundle(ws);
    } else this.sendExistingJoinStatus(ws, fingerprint);
    this.broadcastPresence();
    this.broadcastJoinRequests();
  }

  sendExistingJoinStatus(ws, fingerprint) {
    const row = this.sql.exec('SELECT request_id,display_name,requested_at,status,player_id FROM join_requests WHERE fingerprint=? ORDER BY requested_at DESC LIMIT 1', fingerprint).one();
    if (!row) return;
    ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.JOIN_REQUEST, {
      requestId: row.request_id,
      displayName: row.display_name,
      requestedAt: Number(row.requested_at),
      status: row.status,
      playerId: row.player_id || null
    })));
  }

  async handleJoinRequest(ws, attachment, payload) {
    if (attachment.playerId) throw new Error('This identity is already registered as a player.');
    const displayName = String(payload.displayName || '').trim();
    if (!displayName) throw new Error('Enter a display name to request entry.');
    if (displayName.length > 50) throw new Error('Player names must be 50 characters or fewer.');
    const existing = this.sql.exec("SELECT request_id,display_name,requested_at,status FROM join_requests WHERE fingerprint=? AND status='pending' ORDER BY requested_at DESC LIMIT 1", attachment.fingerprint).one();
    const requestId = existing?.request_id || crypto.randomUUID();
    const requestedAt = existing ? Number(existing.requested_at) : Date.now();
    if (existing) {
      this.sql.exec('UPDATE join_requests SET display_name=? WHERE request_id=?', displayName, requestId);
    } else {
      this.sql.exec('INSERT INTO join_requests(request_id,fingerprint,public_jwk,display_name,requested_at,status,decided_at,decided_by,player_id) VALUES (?,?,?,?,?,?,?,?,?)', requestId, attachment.fingerprint, JSON.stringify(attachment.publicJwk), displayName, requestedAt, 'pending', null, null, null);
    }
    ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.JOIN_REQUEST, { requestId, displayName, requestedAt, status: 'pending' })));
    this.broadcastJoinRequests();
  }

  pendingJoinRequests() {
    return [...this.sql.exec("SELECT request_id,fingerprint,public_jwk,display_name,requested_at,status FROM join_requests WHERE status='pending' ORDER BY requested_at ASC")].map(row => ({
      requestId: row.request_id,
      fingerprint: row.fingerprint,
      publicJwk: safeParse(row.public_jwk),
      displayName: row.display_name,
      requestedAt: Number(row.requested_at),
      status: row.status,
      playerId: cloudPlayerIdForFingerprint(row.fingerprint)
    }));
  }

  broadcastJoinRequests() {
    const state = this.getStateRecord()?.state;
    if (!state) return;
    const requests = this.pendingJoinRequests();
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() || {};
      if (!a.authenticated || !a.playerId || !canAdministerPlayers(state, a.playerId)) continue;
      try { socket.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.JOIN_REQUESTS, { requests }))); } catch {}
    }
  }

  async handleJoinDecision(ws, attachment, packet) {
    if (!attachment.playerId) throw new Error('Only approved players may decide join requests.');
    const state = this.getStateRecord()?.state;
    if (!state || !canAdministerPlayers(state, attachment.playerId)) throw new Error('Only the Constitutional Host, Deputy Host, or pre-Host creator may decide join requests.');
    const signedPayload = cloudJoinDecisionPayload(packet.signedPayload || {});
    if (signedPayload.playerId !== attachment.playerId || signedPayload.roomCode !== this.metaGet('roomCode')) throw new Error('Join decision identity or room mismatch.');
    if (signedPayload.decision !== 'reject') throw new Error('Join approval must use the signed canonical PLAYER_ADDED action path.');
    const player = state.players?.[attachment.playerId];
    if (!player?.identityPublicKey) throw new Error('Approver has no registered public key.');
    const valid = await verifyCloudSignedPayload(player.identityPublicKey, signedPayload, packet.signature);
    if (!valid) throw new Error('Join decision signature is invalid.');
    this.assertNonceUnused(attachment.fingerprint, signedPayload.nonce);
    const request = this.sql.exec("SELECT request_id,fingerprint,status FROM join_requests WHERE request_id=? LIMIT 1", signedPayload.requestId).one();
    if (!request || request.status !== 'pending') throw new Error('That join request is no longer pending.');
    this.markNonceUsed(attachment.fingerprint, signedPayload.nonce);
    this.sql.exec("UPDATE join_requests SET status='rejected',decided_at=?,decided_by=? WHERE request_id=?", Date.now(), attachment.playerId, signedPayload.requestId);
    this.sendToFingerprint(request.fingerprint, CLOUD_MESSAGE.JOIN_REJECTED, { requestId: signedPayload.requestId, decidedBy: attachment.playerId });
    this.broadcastJoinRequests();
  }

  assertNonceUnused(fingerprint, nonce) {
    if (!nonce || String(nonce).length < 8) throw new Error('Action nonce is missing or too short.');
    const key = `${fingerprint}:${nonce}`;
    if (this.sql.exec('SELECT nonce_key FROM used_nonces WHERE nonce_key=? LIMIT 1', key).one()) throw new Error('This signed request nonce has already been used.');
  }

  markNonceUsed(fingerprint, nonce) {
    this.sql.exec('INSERT INTO used_nonces(nonce_key,used_at) VALUES (?,?)', `${fingerprint}:${nonce}`, Date.now());
  }

  validateJoinApprovalAction(action) {
    if (action?.type !== 'PLAYER_ADDED' || !action.joinRequestId) return null;
    const request = this.sql.exec("SELECT request_id,fingerprint,public_jwk,display_name,status FROM join_requests WHERE request_id=? LIMIT 1", action.joinRequestId).one();
    if (!request || request.status !== 'pending') throw new Error('The referenced join request is no longer pending.');
    const expected = {
      type: 'PLAYER_ADDED',
      joinRequestId: request.request_id,
      playerId: cloudPlayerIdForFingerprint(request.fingerprint),
      name: request.display_name,
      identityFingerprint: request.fingerprint,
      identityPublicKey: safeParse(request.public_jwk)
    };
    if (!sameCloudAction(action, expected)) throw new Error('Join approval action does not exactly match the pending verified join request.');
    return { request, expected };
  }

  async handleActionSubmit(ws, attachment, packet) {
    if (!attachment.playerId) throw new Error('Join approval is required before submitting game actions.');
    const record = this.getStateRecord();
    if (!record?.state) throw new Error('Room state is unavailable.');
    const signedPayload = cloudActionPayload(packet.signedPayload || {});
    if (signedPayload.roomCode !== this.metaGet('roomCode')) throw new Error('Action room mismatch.');
    if (signedPayload.playerId !== attachment.playerId) throw new Error('A connection may only submit actions as its authenticated player.');
    if (signedPayload.expectedStateVersion !== record.stateVersion) throw new Error(`Stale state version. Expected ${record.stateVersion}, received ${signedPayload.expectedStateVersion}.`);
    const player = record.state.players?.[attachment.playerId];
    if (!player?.identityPublicKey || player.identityFingerprint !== attachment.fingerprint) throw new Error('Authenticated player binding is invalid.');
    const valid = await verifyCloudSignedPayload(player.identityPublicKey, signedPayload, packet.signature);
    if (!valid) throw new Error('Action signature is invalid.');
    this.assertNonceUnused(attachment.fingerprint, signedPayload.nonce);

    const joinApproval = this.validateJoinApprovalAction(signedPayload.action);
    if (signedPayload.action?.type === 'PLAYER_ADDED' && !joinApproval) throw new Error('Cloud player creation requires an approved pending join request.');
    const appliedAction = authorizePeerAction(record.state, signedPayload.action, attachment.playerId);
    const acceptedAt = Date.now();
    const transitionSeed = crypto.randomUUID();
    const reduced = reduceDeterministic(record.state, appliedAction, { seed: transitionSeed, timestamp: acceptedAt });
    const latest = this.latestCommit();
    const sequence = latest.sequence + 1;
    const commit = {
      sequence,
      previousCommitHash: latest.commitHash,
      playerId: attachment.playerId,
      nonce: signedPayload.nonce,
      expectedStateVersion: signedPayload.expectedStateVersion,
      acceptedAt,
      transitionSeed,
      stateVersion: reduced.state.stateVersion,
      stateHash: reduced.stateHash,
      submittedAction: signedPayload.action,
      appliedAction,
      signature: packet.signature
    };
    commit.commitHash = cloudCommitHash(commit);

    const joinedPlayerId = joinApproval ? cloudPlayerIdForFingerprint(joinApproval.request.fingerprint) : null;
    this.ctx.storage.transactionSync(() => {
      this.persistState(reduced.state, reduced.stateHash, acceptedAt);
      this.sql.exec('INSERT INTO commits(sequence,commit_hash,previous_commit_hash,player_id,nonce,state_version,state_hash,accepted_at,commit_json) VALUES (?,?,?,?,?,?,?,?,?)', sequence, commit.commitHash, commit.previousCommitHash, commit.playerId, commit.nonce, commit.stateVersion, commit.stateHash, commit.acceptedAt, JSON.stringify(commit));
      this.metaSet('commitSequence', String(sequence));
      this.metaSet('lastCommitHash', commit.commitHash);
      if (sequence % SNAPSHOT_INTERVAL === 0) this.createPersistentSnapshot(sequence, reduced.state, reduced.stateHash, acceptedAt, commit.commitHash);
      this.markNonceUsed(attachment.fingerprint, signedPayload.nonce);
      if (joinApproval) this.sql.exec("UPDATE join_requests SET status='approved',decided_at=?,decided_by=?,player_id=? WHERE request_id=?", acceptedAt, attachment.playerId, joinedPlayerId, joinApproval.request.request_id);
    });

    if (joinApproval) {
      this.upgradeFingerprintToPlayer(joinApproval.request.fingerprint, joinedPlayerId);
      this.sendToFingerprint(joinApproval.request.fingerprint, CLOUD_MESSAGE.JOIN_APPROVED, { requestId: joinApproval.request.request_id, playerId: joinedPlayerId, decidedBy: attachment.playerId });
    }

    this.broadcastRegistered(CLOUD_MESSAGE.ACTION_COMMITTED, { commit }, joinApproval?.request?.fingerprint || null);
    if (joinApproval) this.sendSnapshotsToFingerprint(joinApproval.request.fingerprint);
    this.broadcastJoinRequests();
    this.broadcastPresence();
  }

  upgradeFingerprintToPlayer(fingerprint, playerId) {
    const state = this.getStateRecord()?.state;
    const player = state?.players?.[playerId];
    if (!player) return;
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() || {};
      if (!a.authenticated || a.fingerprint !== fingerprint) continue;
      const next = { ...a, authRole: 'player', playerId };
      socket.serializeAttachment(next);
      this.sql.exec('UPDATE connections SET auth_role=?,player_id=? WHERE connection_id=?', 'player', playerId, a.connectionId);
    }
  }

  sendSnapshot(ws) {
    const record = this.getStateRecord();
    if (!record?.state) return;
    const latest = this.latestCommit();
    ws.send(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.STATE_SNAPSHOT, {
      state: record.state,
      stateHash: record.stateHash,
      stateVersion: record.stateVersion,
      commitSequence: latest.sequence,
      lastCommitHash: latest.commitHash,
      serverNow: Date.now(),
      recoverySource: 'current-state'
    })));
  }

  sendSnapshotsToFingerprint(fingerprint) {
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() || {};
      if (a.authenticated && a.fingerprint === fingerprint && a.playerId) {
        try { this.sendSnapshot(socket); } catch {}
      }
    }
  }

  sendToFingerprint(fingerprint, type, payload) {
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() || {};
      if (a.authenticated && a.fingerprint === fingerprint) {
        try { socket.send(JSON.stringify(protocolEnvelope(type, payload))); } catch {}
      }
    }
  }

  broadcastRegistered(type, payload, excludeFingerprint = null) {
    const message = JSON.stringify(protocolEnvelope(type, payload));
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() || {};
      if (!a.authenticated || !a.playerId || (excludeFingerprint && a.fingerprint === excludeFingerprint)) continue;
      try { socket.send(message); } catch {}
    }
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.connectionId) this.sql.exec('DELETE FROM connections WHERE connection_id=?', attachment.connectionId);
    try { ws.close(); } catch {}
    this.broadcastPresence();
  }

  webSocketError(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.connectionId) this.sql.exec('DELETE FROM connections WHERE connection_id=?', attachment.connectionId);
    this.broadcastPresence();
  }

  broadcastPresence() {
    const payload = JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.PRESENCE, {
      connectedClients: this.ctx.getWebSockets().length,
      authenticatedClients: Number(this.sql.exec('SELECT COUNT(*) AS n FROM connections WHERE authenticated_at IS NOT NULL').one()?.n || 0),
      ...this.roomInfo()
    }));
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(payload); } catch {}
    }
  }
}
