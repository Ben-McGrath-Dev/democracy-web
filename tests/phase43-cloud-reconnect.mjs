import assert from 'node:assert/strict';
import fs from 'node:fs';
import { protocolEnvelope, parseProtocolMessage, CLOUD_MESSAGE } from '../shared/protocol.js';
import { prepareCloudMigrationState } from '../js/cloud-network.js';

const sample = {
  id: 'g1', stateVersion: 7,
  players: { p1: { id:'p1', displayName:'Ben', roles:['creator'] } },
  network: { authorityEpoch: 9, ownerPlayerId:'p1', backupOwnerPlayerId:'p2', reconnectTokens:{p1:'secret'}, recentTransitions:[{x:1}] },
  laws: { L1: { id:'L1', title:'Keep me' } }, events: [{ id:'E1' }]
};
const migrated = prepareCloudMigrationState(sample);
assert.equal(migrated.stateVersion, 7);
assert.deepEqual(migrated.laws, sample.laws);
assert.deepEqual(migrated.events, sample.events);
assert.deepEqual(migrated.network, { authorityEpoch:0, ownerPlayerId:null, backupOwnerPlayerId:null, reconnectTokens:{}, recentTransitions:[] });
assert.equal(sample.network.authorityEpoch, 9, 'migration must not mutate local source save');

const resume = parseProtocolMessage(JSON.stringify(protocolEnvelope(CLOUD_MESSAGE.RESUME, { fromSequence: 12, lastCommitHash:'abc' })));
assert.equal(resume.type, 'RESUME');
assert.equal(resume.payload.fromSequence, 12);

const client = fs.readFileSync(new URL('../js/cloud-network.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
assert.match(client, /RECONNECT_DELAYS_MS/);
assert.match(client, /visibilitychange/);
assert.match(client, /addEventListener\('online'/);
assert.match(client, /resumeFromSequence/);
assert.match(client, /SESSION_KEY/);
assert.match(worker, /sendResume\(/);
assert.match(worker, /commitHashAt\(/);
assert.match(worker, /resumeLastCommitHash/);
console.log('Phase 43 Cloud reconnect/resume + save migration: PASS');
