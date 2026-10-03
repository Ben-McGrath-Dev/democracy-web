import { stableStringify, sha256 } from './integrity.js';
import { hasSecureCrypto, securityMode, lanDevFingerprint, lanDevSignature, validateLanDevSignature } from './security.js';

const IDENTITY_KEY = 'democracy-web.crypto-identity.v1';
const KEY_DB = 'democracy-web-identity-keys-v2';
const KEY_STORE = 'keys';
const SIGNING_KEY_ID = 'player-signing-key';
const encoder = new TextEncoder();

function bytesToBase64(bytes) { let binary=''; for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b); return btoa(binary); }
function base64ToBytes(value) { const binary=atob(value); const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i); return bytes; }
async function digestHex(text) {
  if (!hasSecureCrypto()) return sha256(String(text));
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(text));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function publicKeyFingerprint(publicJwk) {
  if (publicJwk?.kty === 'LAN-TEST') return lanDevFingerprint(publicJwk.token);
  return digestHex(stableStringify(publicJwk));
}

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open identity key storage.'));
  });
}

async function putSigningKey(key) {
  const db = await openKeyDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).put({ id: SIGNING_KEY_ID, key });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not store the player signing key.'));
      tx.onabort = () => reject(tx.error || new Error('Player signing-key storage was aborted.'));
    });
  } finally { db.close(); }
}

async function getSigningKey() {
  const db = await openKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readonly');
      const req = tx.objectStore(KEY_STORE).get(SIGNING_KEY_ID);
      req.onsuccess = () => resolve(req.result?.key ?? null);
      req.onerror = () => reject(req.error || new Error('Could not read the player signing key.'));
    });
  } finally { db.close(); }
}

async function deleteSigningKey() {
  const db = await openKeyDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).delete(SIGNING_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not delete the player signing key.'));
    });
  } finally { db.close(); }
}

function saveMetadata(record) {
  const safe = {
    version: record.version,
    algorithm: record.algorithm,
    createdAt: record.createdAt,
    fingerprint: record.fingerprint,
    publicJwk: record.publicJwk,
    insecureLanTest: Boolean(record.insecureLanTest)
  };
  if (record.algorithm === 'LAN-TEST-INSECURE') safe.privateJwk = record.privateJwk;
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(safe));
  return safe;
}

function randomToken() { const b=crypto.getRandomValues(new Uint32Array(8)); return [...b].map(v=>v.toString(16).padStart(8,'0')).join(''); }

async function installPrivateJwk(privateJwk) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  await putSigningKey(key);
  return key;
}

async function generateIdentity() {
  if (!hasSecureCrypto()) {
    if (securityMode() !== 'lan-test') throw new Error('Cryptographic identity requires HTTPS or localhost.');
    const token=randomToken();
    const publicJwk={kty:'LAN-TEST',token};
    const record={version:2,algorithm:'LAN-TEST-INSECURE',createdAt:new Date().toISOString(),fingerprint:lanDevFingerprint(token),publicJwk,privateJwk:{kty:'LAN-TEST',token},insecureLanTest:true};
    saveMetadata(record);
    return record;
  }

  // Generate extractable only long enough to convert the private material into a
  // non-extractable CryptoKey. Raw private JWK bytes are never persisted.
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
  const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
  await installPrivateJwk(privateJwk);
  const fingerprint=await publicKeyFingerprint(publicJwk);
  const record={version:2,algorithm:'ECDSA-P256-SHA256-NONEXTRACTABLE',createdAt:new Date().toISOString(),fingerprint,publicJwk};
  saveMetadata(record);
  return record;
}

async function migrateLegacyIdentity(parsed) {
  if (parsed?.algorithm === 'LAN-TEST-INSECURE') {
    if (hasSecureCrypto()) return generateIdentity();
    parsed.version = 2;
    saveMetadata(parsed);
    return parsed;
  }
  if (!hasSecureCrypto()) throw new Error('Migrating the cryptographic player identity requires HTTPS or localhost.');
  if (!parsed?.privateJwk || !parsed?.publicJwk) throw new Error('Legacy identity is missing its private key.');
  const fingerprint=await publicKeyFingerprint(parsed.publicJwk);
  if (parsed.fingerprint && parsed.fingerprint !== fingerprint) throw new Error('Legacy identity fingerprint mismatch.');
  await installPrivateJwk(parsed.privateJwk);
  const next={version:2,algorithm:'ECDSA-P256-SHA256-NONEXTRACTABLE',createdAt:parsed.createdAt||new Date().toISOString(),fingerprint,publicJwk:parsed.publicJwk};
  saveMetadata(next);
  return next;
}

export async function ensureIdentity() {
  let parsed=null;
  try { parsed=JSON.parse(localStorage.getItem(IDENTITY_KEY)||'null'); } catch {}
  if (!parsed) return generateIdentity();
  if (parsed.version === 1) return migrateLegacyIdentity(parsed);
  if (parsed.version !== 2 || !parsed.publicJwk || !parsed.fingerprint) return generateIdentity();
  if (hasSecureCrypto() && parsed.algorithm === 'LAN-TEST-INSECURE') return generateIdentity();
  if (parsed.algorithm !== 'LAN-TEST-INSECURE') {
    const key=await getSigningKey();
    if (!key) throw new Error('This browser has the public identity record but its non-extractable private signing key is missing. Rotate to a new identity or restore this browser profile.');
  }
  return parsed;
}

export function getStoredIdentitySummary() {
  try {
    const r=JSON.parse(localStorage.getItem(IDENTITY_KEY)||'null');
    return r ? {
      version:r.version,createdAt:r.createdAt,fingerprint:r.fingerprint,publicJwk:r.publicJwk,
      algorithm:r.algorithm,insecureLanTest:Boolean(r.insecureLanTest),
      privateKeyStorage:r.algorithm==='LAN-TEST-INSECURE'?'insecure-lan-token':'non-extractable-indexeddb',
      exportable:r.algorithm==='LAN-TEST-INSECURE'
    } : null;
  } catch { return null; }
}

export async function signPayload(payload) {
  const identity=await ensureIdentity();
  if (identity.algorithm === 'LAN-TEST-INSECURE') return {signature:lanDevSignature(identity.privateJwk.token,payload),fingerprint:identity.fingerprint,publicJwk:identity.publicJwk,insecureLanTest:true};
  const key=await getSigningKey();
  if (!key) throw new Error('Player signing key is unavailable.');
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(stableStringify(payload)));
  return { signature:bytesToBase64(signature),fingerprint:identity.fingerprint,publicJwk:identity.publicJwk };
}

export async function verifySignedPayload(publicJwk,payload,signature) {
  if(!publicJwk||!signature) return false;
  if (publicJwk.kty === 'LAN-TEST') return securityMode()==='lan-test' && validateLanDevSignature(publicJwk.token,payload,signature);
  if (!hasSecureCrypto()) return false;
  try {
    const key=await crypto.subtle.importKey('jwk',publicJwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,base64ToBytes(signature),encoder.encode(stableStringify(payload)));
  } catch { return false; }
}

export async function exportIdentityBlob() {
  const identity=await ensureIdentity();
  if (identity.algorithm === 'LAN-TEST-INSECURE') throw new Error('LAN Test identities are temporary and cannot be exported.');
  throw new Error('For security, 1.0.3 stores the player signing key as non-extractable. Raw identity export is disabled; use the same browser profile for this identity.');
}

export async function importIdentityFile(file) {
  if (file?.size > 128 * 1024) throw new Error('Identity file is unexpectedly large.');
  let parsed; try { parsed=JSON.parse(await file.text()); } catch { throw new Error('Identity file is not valid JSON.'); }
  if(parsed?.format!=='democracy-web-identity'||!parsed.publicJwk||!parsed.privateJwk) throw new Error('Unsupported Democracy identity file.');
  if(parsed.algorithm==='LAN-TEST-INSECURE') throw new Error('LAN Test identities are temporary development credentials and cannot be imported.');
  if (!hasSecureCrypto()) throw new Error('Importing a cryptographic identity requires HTTPS or localhost.');
  const fingerprint=await publicKeyFingerprint(parsed.publicJwk);
  if(parsed.fingerprint&&parsed.fingerprint!==fingerprint) throw new Error('Identity fingerprint does not match its public key.');
  await installPrivateJwk(parsed.privateJwk);
  const metadata={version:2,algorithm:'ECDSA-P256-SHA256-NONEXTRACTABLE',createdAt:parsed.createdAt||new Date().toISOString(),fingerprint,publicJwk:parsed.publicJwk};
  saveMetadata(metadata);
  return {fingerprint,createdAt:metadata.createdAt};
}

export async function rotateIdentity() {
  localStorage.removeItem(IDENTITY_KEY);
  try { await deleteSigningKey(); } catch {}
  return generateIdentity();
}
