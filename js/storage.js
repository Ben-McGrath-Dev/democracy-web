import { SCHEMA_VERSION } from './config.js';
import { hashJson, verifyEventChain } from './integrity.js';
import { serializedBytes } from './security.js';

const DB_NAME = 'democracy-web';
const DB_VERSION = 1;
const GAME_STORE = 'games';
const SNAPSHOT_STORE = 'snapshots';
const CURRENT_GAME_KEY = 'democracy-web.current-game-id';

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GAME_STORE)) {
        const games = db.createObjectStore(GAME_STORE, { keyPath: 'id' });
        games.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        const snapshots = db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'snapshotId' });
        snapshots.createIndex('gameId', 'gameId');
        snapshots.createIndex('createdAt', 'createdAt');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local database.'));
  });
  return dbPromise;
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Database request failed.'));
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = callback(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = async () => {
      try { resolve(await result); }
      catch (error) { reject(error); }
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Database transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Database transaction was aborted.'));
  });
}

export function validateSaveFile(state) {
  if (!state || typeof state !== 'object') throw new Error('Save file does not contain a game state.');
  if (serializedBytes(state) > 8 * 1024 * 1024) throw new Error('Save state exceeds the 8 MiB safety limit.');
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported save schema ${state.schemaVersion ?? 'unknown'}. This build expects schema ${SCHEMA_VERSION}.`);
  }
  if (!state.meta?.id || !state.meta?.name) throw new Error('Save file is missing game metadata.');
  if (!state.players || typeof state.players !== 'object') throw new Error('Save file is missing players.');
  if (!state.parties || typeof state.parties !== 'object') throw new Error('Save file is missing parties.');
  if (!Array.isArray(state.history)) throw new Error('Save file is missing official history.');
  if (!Number.isInteger(state.stateVersion) || state.stateVersion < 1) throw new Error('Save file has an invalid state version.');
  if (state.history.some(event => event.hash)) { const integrity = verifyEventChain(state.history); if (!integrity.ok) throw new Error(`Official history integrity check failed at event ${integrity.index + 1} (${integrity.reason}).`); }
  return true;
}

export async function saveGame(state) {
  validateSaveFile(state);
  const record = {
    id: state.meta.id,
    name: state.meta.name,
    updatedAt: state.meta.updatedAt,
    createdAt: state.meta.createdAt,
    stateVersion: state.stateVersion,
    stateHash: hashJson(state),
    eventHeadHash: state.history?.at(-1)?.hash ?? null,
    playerCount: Object.keys(state.players).length,
    partyCount: Object.values(state.parties).filter(p => p.status === 'active').length,
    state
  };
  await withStore(GAME_STORE, 'readwrite', store => requestAsPromise(store.put(record)));
  localStorage.setItem(CURRENT_GAME_KEY, state.meta.id);
  return record;
}

export async function loadGame(gameId, { setCurrent = true } = {}) {
  const record = await withStore(GAME_STORE, 'readonly', store => requestAsPromise(store.get(gameId)));
  if (!record) throw new Error('Saved game not found.');
  validateSaveFile(record.state);
  if (setCurrent) localStorage.setItem(CURRENT_GAME_KEY, gameId);
  return structuredClone(record.state);
}

export async function loadCurrentGame() {
  const id = localStorage.getItem(CURRENT_GAME_KEY);
  if (!id) return null;
  try { return await loadGame(id); }
  catch {
    localStorage.removeItem(CURRENT_GAME_KEY);
    return null;
  }
}

export async function listSavedGames() {
  const records = await withStore(GAME_STORE, 'readonly', store => requestAsPromise(store.getAll()));
  return records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(record => ({
    id: record.id,
    name: record.name,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    stateVersion: record.stateVersion,
    playerCount: record.playerCount,
    partyCount: record.partyCount
  }));
}

export async function deleteSavedGame(gameId) {
  await withStore(GAME_STORE, 'readwrite', store => requestAsPromise(store.delete(gameId)));
  if (localStorage.getItem(CURRENT_GAME_KEY) === gameId) localStorage.removeItem(CURRENT_GAME_KEY);
}

export async function createSnapshot(state, reason = 'automatic') {
  validateSaveFile(state);
  const snapshot = {
    snapshotId: `${state.meta.id}:${state.stateVersion}:${Date.now()}`,
    gameId: state.meta.id,
    stateVersion: state.stateVersion,
    createdAt: new Date().toISOString(),
    reason,
    stateHash: hashJson(state),
    eventHeadHash: state.history?.at(-1)?.hash ?? null,
    state: structuredClone(state)
  };
  await withStore(SNAPSHOT_STORE, 'readwrite', store => requestAsPromise(store.put(snapshot)));
  return snapshot;
}

export async function listSnapshots(gameId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
    const index = tx.objectStore(SNAPSHOT_STORE).index('gameId');
    const request = index.getAll(gameId);
    request.onsuccess = () => resolve(request.result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    request.onerror = () => reject(request.error ?? new Error('Could not list snapshots.'));
  });
}

export async function getSnapshot(snapshotId) {
  const snapshot = await withStore(SNAPSHOT_STORE, 'readonly', store => requestAsPromise(store.get(snapshotId)));
  if (!snapshot) throw new Error('Snapshot not found.');
  validateSaveFile(snapshot.state);
  if (snapshot.stateHash && snapshot.stateHash !== hashJson(snapshot.state)) throw new Error('Snapshot state hash does not match.');
  if (snapshot.eventHeadHash && snapshot.eventHeadHash !== (snapshot.state.history?.at(-1)?.hash ?? null)) throw new Error('Snapshot event-head hash does not match.');
  return structuredClone(snapshot);
}

export async function restoreSnapshot(snapshotId) {
  const snapshot = await getSnapshot(snapshotId);
  return structuredClone(snapshot.state);
}

export async function verifySnapshots(gameId) {
  const snapshots = await listSnapshots(gameId);
  return snapshots.map(snapshot => {
    let ok = true; let reason = null;
    try {
      validateSaveFile(snapshot.state);
      if (snapshot.stateHash && snapshot.stateHash !== hashJson(snapshot.state)) throw new Error('state-hash-mismatch');
      if (snapshot.eventHeadHash && snapshot.eventHeadHash !== (snapshot.state.history?.at(-1)?.hash ?? null)) throw new Error('event-head-mismatch');
    } catch (error) { ok = false; reason = error.message; }
    return { snapshotId: snapshot.snapshotId, stateVersion: snapshot.stateVersion, createdAt: snapshot.createdAt, reason: snapshot.reason, ok, error: reason };
  });
}

export function shouldCreateAutomaticSnapshot(state) {
  return state.stateVersion === 1 || state.stateVersion % 5 === 0;
}

export function exportGameFile(state) {
  validateSaveFile(state);
  const payload = {
    format: 'democracy-web-save',
    exportedAt: new Date().toISOString(),
    schemaVersion: state.schemaVersion,
    stateHash: hashJson(state),
    eventHeadHash: state.history?.at(-1)?.hash ?? null,
    state
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

export async function importGameFile(file) {
  if (file?.size > 10 * 1024 * 1024) throw new Error('Save file exceeds the 10 MiB import safety limit.');
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { throw new Error('The selected file is not valid JSON.'); }

  const state = payload?.format === 'democracy-web-save' ? payload.state : payload;
  validateSaveFile(state);
  if (payload?.format === 'democracy-web-save' && payload.stateHash && payload.stateHash !== hashJson(state)) {
    throw new Error('Save integrity hash does not match. The exported save may have been modified or corrupted.');
  }
  if (payload?.format === 'democracy-web-save' && payload.eventHeadHash && payload.eventHeadHash !== (state.history?.at(-1)?.hash ?? null)) {
    throw new Error('Save event-head hash does not match the official history.');
  }
  return structuredClone(state);
}
