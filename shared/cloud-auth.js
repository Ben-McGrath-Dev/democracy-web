import { stableStringify } from './integrity.js';

const encoder = new TextEncoder();

export function cloudAuthPayload({ roomCode, challengeId, nonce, issuedAt, expiresAt }) {
  return {
    purpose: 'democracy-web-cloud-auth-v1',
    roomCode: String(roomCode || '').toUpperCase(),
    challengeId: String(challengeId || ''),
    nonce: String(nonce || ''),
    issuedAt: Number(issuedAt || 0),
    expiresAt: Number(expiresAt || 0)
  };
}

function base64ToBytes(value) {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

export async function cloudPublicKeyFingerprint(publicJwk) {
  if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256') throw new Error('Cloud authentication requires an ECDSA P-256 public key.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(stableStringify(publicJwk)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyCloudAuthSignature(publicJwk, payload, signature) {
  if (!publicJwk || !signature) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToBytes(signature),
      encoder.encode(stableStringify(payload))
    );
  } catch {
    return false;
  }
}

export function challengeExpired(challenge, now = Date.now()) {
  return !challenge || !Number.isFinite(challenge.expiresAt) || now > challenge.expiresAt;
}
