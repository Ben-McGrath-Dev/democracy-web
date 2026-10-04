import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const legacyP2P = fs.existsSync(new URL('../js/network.js', import.meta.url));
const network = legacyP2P ? read('js/network.js') : '';
const cloud = read('js/cloud-network.js');
const worker = read('worker/src/index.js');
const identity = read('js/identity.js');
const permissions = read('shared/permissions.js');
const app = read('js/app.js');
const config = read('js/config.js');

assert.match(config, /APP_VERSION = '(?:1\.(?:[1-9]|[1-9][0-9]+)\.[0-9]+(?:-phase\d+)?|1\.0\.[34])'/);
// Critical authority path: legacy P2P checks remain historical; 1.1 must use signed Cloud sequencing instead.
if (legacyP2P) {
  assert.match(network, /verifySignedControl\(packet, 'authority-claim'/);
  assert.match(network, /payload\.authorityEpoch !== authorityEpoch \+ 1/);
  assert.match(network, /winner\.playerId !== payload\.playerId/);
  assert.match(network, /Authority claim rejected while the current owner is still connected/);
  assert.match(network, /normalizeOwnerFingerprint/);
  assert.match(network, /verifyOwnerOffer/);
  assert.match(network, /awaiting-owner-trust/);
  assert.match(network, /expectedOwnerFingerprint = discoveredOwner\.fingerprint/);
  assert.match(network, /multiple different Lobby Owner identities answered this room code/);
  assert.match(app, /joinOwnerFingerprint/);
  assert.match(app, /trust-discovered-owner/);
  assert.match(network, /role === 'owner'[\s\S]*createAndApplyOrdinaryTransition\(signedPayload/);
  assert.match(network, /simulateDeterministicAction/);
  assert.match(network, /Transition result hash mismatch/);
  assert.match(network, /safeRecoveryState\.network/);
  assert.match(network, /recentTransitions: \[\]/);
  assert.doesNotMatch(network, /actions\.state\.send\(\{\s*state\s*,\s*stateVersion/);
} else {
  assert.match(cloud, /cloudActionPayload/);
  assert.match(cloud, /verifyCloudSignedPayload/);
  assert.match(cloud, /Cloud state divergence detected/);
  assert.match(worker, /verifyCloudSignedPayload/);
  assert.match(worker, /authorizePeerAction/);
  assert.match(worker, /reduceDeterministic/);
  assert.doesNotMatch(app, /from '\.\/network\.js'/);
}
// High #3: proposal mutation privilege checks.
assert.match(permissions, /Only the original proposer may edit this law proposal online/);
assert.match(permissions, /Only the original proposer may edit this constitutional amendment online/);
// High #4: ballot private key is no longer replicated; revealed choices are shuffled before replication.
assert.doesNotMatch(app, /revealedPrivateKey/);
assert.match(app, /const revealedChoices = \[\.\.\.reveal\.choices\]/);
assert.match(app, /crypto\.getRandomValues/);
// High #6: secure private signing material is not persisted as plaintext JWK in localStorage.
assert.match(identity, /non-extractable-indexeddb/);
assert.match(identity, /indexedDB\.open\(KEY_DB/);
assert.match(identity, /importKey\('jwk', privateJwk,[^\n]*false, \['sign'\]\)/);
assert.match(identity, /Raw identity export is disabled/);
console.log('PASS Democracy Web 1.0.3 severe-security regression checks');
