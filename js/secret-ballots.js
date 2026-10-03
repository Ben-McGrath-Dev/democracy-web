import { assertSecureCrypto } from './security.js';
const DB_NAME = 'democracy-web-secret-ballots';
const DB_VERSION = 1;
const STORE = 'ballot-boxes';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const memoryBoxes = new Map();

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'voteId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the sealed-ballot key store.'));
  });
}

async function putBox(record) {
  const db = await openDb();
  if (!db) { memoryBoxes.set(record.voteId, record); return; }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Could not save ballot-box key.'));
  });
  db.close();
}

async function getBox(voteId) {
  const db = await openDb();
  if (!db) return memoryBoxes.get(voteId) ?? null;
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(voteId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('Could not read ballot-box key.'));
  });
  db.close();
  return record;
}

export async function deleteBallotBox(voteId) {
  const db = await openDb();
  if (!db) { memoryBoxes.delete(voteId); return; }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(voteId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Could not delete ballot-box key.'));
  });
  db.close();
}

export async function createBallotBox(voteId) {
  assertSecureCrypto('Sealed secret ballots');
  if (!voteId) throw new Error('Vote ID is required for a sealed ballot box.');
  const existing = await getBox(voteId);
  if (existing?.privateKey && existing?.publicJwk) return { publicJwk: existing.publicJwk };

  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  await putBox({ voteId, privateKey: pair.privateKey, publicJwk, createdAt: new Date().toISOString() });
  return { publicJwk };
}

async function importPublic(publicJwk) {
  return crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
}

async function importPrivate(privateJwk) {
  return crypto.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
}

export async function encryptSecretChoice(publicJwk, choice) {
  assertSecureCrypto('Sealed secret ballots');
  if (!publicJwk) throw new Error('This secret vote has no ballot-box public key.');
  const publicKey = await importPublic(publicJwk);
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawAes = await crypto.subtle.exportKey('raw', aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(choice));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAes);
  return {
    version: 1,
    algorithm: 'RSA-OAEP-2048/AES-GCM-256',
    ballotId: crypto.randomUUID(),
    wrappedKey: bytesToBase64(wrappedKey),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  };
}

async function decryptEnvelope(privateKey, envelope) {
  if (!envelope || envelope.version !== 1) throw new Error('Unsupported encrypted ballot format.');
  const rawAes = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, base64ToBytes(envelope.wrappedKey));
  const aesKey = await crypto.subtle.importKey('raw', rawAes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    aesKey,
    base64ToBytes(envelope.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

export async function revealBallotBox(vote) {
  assertSecureCrypto('Sealed secret ballots');
  if (!vote?.id) throw new Error('Vote not found.');
  const record = await getBox(vote.id);
  if (!record?.privateKey) {
    throw new Error('This browser does not hold the private key for this sealed ballot box. The vote cannot be counted here; restore the original ballot-box holder or rerun the vote.');
  }
  const choices = [];
  for (const envelope of vote.sealedBallots ?? []) choices.push(await decryptEnvelope(record.privateKey, envelope));
  return { choices };
}

export async function verifyRevealedSecretVote(vote) {
  assertSecureCrypto('Sealed secret ballot verification');
  if (vote?.secretBallotMode !== 'sealed-v1') return { ok: false, reason: 'not-sealed' };
  if (!Array.isArray(vote.revealedChoices)) return { ok: false, reason: 'not-revealed' };
  const record = await getBox(vote.id);
  if (!record?.privateKey) return { ok: false, reason: 'local-ballot-key-required' };
  try {
    const choices = [];
    for (const envelope of vote.sealedBallots ?? []) choices.push(await decryptEnvelope(record.privateKey, envelope));
    const normalise = values => values.map(value => JSON.stringify(value)).sort();
    const expected = JSON.stringify(normalise(vote.revealedChoices ?? []));
    const actual = JSON.stringify(normalise(choices));
    return { ok: expected === actual, choices, count: choices.length, reason: expected === actual ? null : 'revealed-choices-mismatch' };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function deriveRecoveryKey(passphrase, salt) {
  if (!passphrase || passphrase.length < 8) throw new Error('Recovery passphrase must be at least 8 characters.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 250000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
}

export async function hasBallotBoxKey(voteId) {
  const record = await getBox(voteId);
  return Boolean(record?.privateKey);
}

export async function exportBallotBoxRecovery(voteId, passphrase) {
  assertSecureCrypto('Ballot-box recovery');
  const record = await getBox(voteId);
  if (!record?.privateKey || !record?.publicJwk) throw new Error('This browser does not hold that ballot-box private key.');
  const privateJwk = await crypto.subtle.exportKey('jwk', record.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveRecoveryKey(passphrase, salt);
  const plaintext = encoder.encode(JSON.stringify({ voteId, privateJwk, publicJwk: record.publicJwk, createdAt: record.createdAt }));
  const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, plaintext);
  return {
    format: 'democracy-web-ballot-recovery', version: 1, voteId,
    kdf: { name:'PBKDF2', hash:'SHA-256', iterations:250000, salt:bytesToBase64(salt) },
    cipher: { name:'AES-GCM', iv:bytesToBase64(iv), ciphertext:bytesToBase64(ciphertext) }
  };
}

export async function importBallotBoxRecovery(payload, passphrase, expectedPublicJwk = null) {
  assertSecureCrypto('Ballot-box recovery');
  if (!payload || payload.format !== 'democracy-web-ballot-recovery' || payload.version !== 1) throw new Error('Invalid ballot recovery package.');
  const salt = base64ToBytes(payload.kdf?.salt || '');
  const iv = base64ToBytes(payload.cipher?.iv || '');
  const ciphertext = base64ToBytes(payload.cipher?.ciphertext || '');
  const key = await deriveRecoveryKey(passphrase, salt);
  let decoded;
  try { decoded = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ciphertext); }
  catch { throw new Error('Could not decrypt ballot recovery package. Check the passphrase and file.'); }
  const data = JSON.parse(decoder.decode(decoded));
  if (!data.voteId || !data.privateJwk || !data.publicJwk) throw new Error('Recovery package is incomplete.');
  if (expectedPublicJwk && JSON.stringify(expectedPublicJwk) !== JSON.stringify(data.publicJwk)) throw new Error('Recovery package does not match this vote ballot-box public key.');
  const privateKey = await importPrivate(data.privateJwk);
  await putBox({ voteId:data.voteId, privateKey, publicJwk:data.publicJwk, createdAt:data.createdAt || new Date().toISOString(), recoveredAt:new Date().toISOString() });
  return { voteId:data.voteId, publicJwk:data.publicJwk };
}
