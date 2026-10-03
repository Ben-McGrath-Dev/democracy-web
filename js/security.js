import { sha256, stableStringify } from './integrity.js';

const MAX_TEXT = 20000;
const MAX_ACTION_BYTES = 128 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_JOIN_NAME = 80;

function privateLanHostname(hostname = location.hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
  const m = hostname.match(/^172\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

export function hasSecureCrypto() {
  if (typeof window === 'undefined') return Boolean(globalThis.crypto?.subtle);
  return Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle);
}

export function securityMode() {
  if (hasSecureCrypto()) return 'secure';
  if (typeof location !== 'undefined' && location.protocol === 'http:' && privateLanHostname(location.hostname)) return 'lan-test';
  return 'unsupported';
}

export function securitySummary() {
  const mode = securityMode();
  if (mode === 'secure') return { mode, secure: true, label: 'Secure', detail: 'Web Crypto and secure-context protections are active.' };
  if (mode === 'lan-test') return { mode, secure: false, label: 'LAN Test Mode', detail: 'Private-LAN HTTP detected. Cryptographic identity proofs use a non-secure development fallback and sealed ballots are unavailable.' };
  return { mode, secure: false, label: 'Secure context required', detail: 'Open Democracy Web through HTTPS or localhost to use multiplayer security features.' };
}

export function assertSecureCrypto(feature = 'This feature') {
  if (!hasSecureCrypto()) throw new Error(`${feature} requires HTTPS (or localhost). This browser is currently in ${securitySummary().label}.`);
}

export function safeText(value, maxLength = MAX_TEXT) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (text.length > maxLength) throw new Error(`Text exceeds the ${maxLength.toLocaleString()} character safety limit.`);
  return text;
}

export function serializedBytes(value) {
  return new TextEncoder().encode(stableStringify(value)).byteLength;
}

export function validateNetworkActionSize(action) {
  const bytes = serializedBytes(action);
  if (bytes > MAX_ACTION_BYTES) throw new Error(`Network action is too large (${Math.ceil(bytes/1024)} KiB; maximum ${MAX_ACTION_BYTES/1024} KiB).`);
  return bytes;
}

export function validateIncomingStateSize(state) {
  const bytes = serializedBytes(state);
  if (bytes > MAX_STATE_BYTES) throw new Error(`Incoming state exceeds the ${MAX_STATE_BYTES/1024/1024} MiB safety limit.`);
  return bytes;
}

export function validateDisplayName(value) {
  const name = safeText(value, MAX_JOIN_NAME);
  if (!name) throw new Error('Display name is required.');
  return name;
}

export function lanDevFingerprint(token) {
  return `lan-${sha256(String(token)).slice(0, 40)}`;
}

export function lanDevSignature(token, payload) {
  return `lan-test:${sha256(`${token}|${stableStringify(payload)}`)}`;
}

export function validateLanDevSignature(token, payload, signature) {
  return signature === lanDevSignature(token, payload);
}

export const SECURITY_LIMITS = Object.freeze({ MAX_TEXT, MAX_ACTION_BYTES, MAX_STATE_BYTES, MAX_JOIN_NAME });
