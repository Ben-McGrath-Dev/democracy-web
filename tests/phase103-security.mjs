import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const network = read('js/network.js');
const identity = read('js/identity.js');
const permissions = read('js/permissions.js');
const app = read('js/app.js');
const config = read('js/config.js');

assert.match(config, /APP_VERSION = '1\.0\.3'/);
// Critical #1: authority claims must be signed, exactly-next epoch, deterministic winner, and rejected while owner is connected.
assert.match(network, /verifySignedControl\(packet, 'authority-claim'/);
assert.match(network, /payload\.authorityEpoch !== authorityEpoch \+ 1/);
assert.match(network, /winner\.playerId !== payload\.playerId/);
assert.match(network, /Authority claim rejected while the current owner is still connected/);
// Initial trust: first-time joins require an out-of-band/invite owner fingerprint.
assert.match(network, /First-time joins require the Lobby Owner fingerprint/);
assert.match(network, /normalizeOwnerFingerprint/);
assert.match(app, /joinOwnerFingerprint/);
// Critical #2: owner self-actions and peer actions use the same signed deterministic transition path.
assert.match(network, /role === 'owner'[\s\S]*createAndApplyOrdinaryTransition\(signedPayload/);
assert.match(network, /simulateDeterministicAction/);
assert.match(network, /Transition result hash mismatch/);
assert.match(network, /safeRecoveryState\.network/);
assert.match(network, /recentTransitions: \[\]/);
assert.doesNotMatch(network, /actions\.state\.send\(\{\s*state\s*,\s*stateVersion/);
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
