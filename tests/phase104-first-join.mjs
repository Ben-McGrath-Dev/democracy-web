import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const network = read('js/network.js');
const app = read('js/app.js');

// Initial join is one atomic signed packet: no ack/checkpoint cross-channel race.
assert.match(network, /dw-join-ack-v3/);
assert.match(network, /bootstrap:\s*\{/);
assert.match(network, /checkpoint\s*\n?\s*\}/);
assert.match(network, /const state = await verifyCheckpoint\(checkpoint, peerId, \{ initial: true \}\)/);
assert.doesNotMatch(network, /await actions\.state\.send\(checkpoint, \{ target: peerId \}\)/);

// Manual room-code joins discover, but never auto-trust, the owner identity.
assert.match(network, /kind: 'owner-offer'/);
assert.match(network, /verifySignedPayload\(publicJwk, payload, packet\.signature\)/);
assert.match(network, /connectionState = 'awaiting-owner-trust'/);
assert.match(network, /export async function trustDiscoveredOwner/);
assert.match(network, /if \(discoveredOwnerConflict\) throw new Error/);
assert.match(network, /expectedOwnerFingerprint = discoveredOwner\.fingerprint/);
assert.match(app, /Code Matches — Trust & Join/);
assert.match(app, /copy-owner-code/);
assert.match(app, /Owner verification code/);

// Joining a new lobby must not inherit an unrelated local save's authority epoch.
assert.match(network, /authorityEpoch = 0; \/\/ Never inherit authority from an unrelated\/stale local save while joining/);

// Migration must not start while an initial join/bootstrap is in progress.
assert.match(network, /wasOwner && !waitingJoin && !awaitingInitialState && connectionState === 'connected'/);

console.log('PASS Democracy Web 1.0.4 secure first-join checks');
