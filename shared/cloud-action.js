import { stableStringify, hashJson } from './integrity.js';
import { verifyCloudAuthSignature } from './cloud-auth.js';

export function cloudActionPayload({ roomCode, playerId, action, expectedStateVersion, nonce }) {
  return {
    purpose: 'democracy-web-cloud-action-v1',
    roomCode: String(roomCode || '').toUpperCase(),
    playerId: String(playerId || ''),
    expectedStateVersion: Number(expectedStateVersion ?? -1),
    nonce: String(nonce || ''),
    action: structuredClone(action ?? null)
  };
}

export function cloudJoinDecisionPayload({ roomCode, playerId, requestId, decision, nonce }) {
  return {
    purpose: 'democracy-web-cloud-join-decision-v1',
    roomCode: String(roomCode || '').toUpperCase(),
    playerId: String(playerId || ''),
    requestId: String(requestId || ''),
    decision: String(decision || ''),
    nonce: String(nonce || '')
  };
}

export async function verifyCloudSignedPayload(publicJwk, payload, signature) {
  return verifyCloudAuthSignature(publicJwk, payload, signature);
}

export function cloudPlayerIdForFingerprint(fingerprint) {
  const fp = String(fingerprint || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error('A valid identity fingerprint is required.');
  return `player_cloud_${fp.slice(0, 24)}`;
}

export function cloudCommitHash(commit) {
  return hashJson({
    sequence: Number(commit.sequence || 0),
    previousCommitHash: commit.previousCommitHash ?? null,
    playerId: String(commit.playerId || ''),
    nonce: String(commit.nonce || ''),
    expectedStateVersion: Number(commit.expectedStateVersion ?? -1),
    acceptedAt: Number(commit.acceptedAt || 0),
    transitionSeed: String(commit.transitionSeed || ''),
    stateVersion: Number(commit.stateVersion || 0),
    stateHash: String(commit.stateHash || ''),
    submittedAction: commit.submittedAction ?? null,
    appliedAction: commit.appliedAction ?? null,
    signature: String(commit.signature || '')
  });
}

export function sameCloudAction(a, b) {
  return stableStringify(a) === stableStringify(b);
}
