import fs from 'node:fs';
import assert from 'node:assert/strict';

const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../js/cloud-network.js', import.meta.url), 'utf8');

assert.match(worker, /function firstRow\(cursor\)/, 'Worker must use a zero-row-safe SQL helper.');
assert.match(worker, /const row = firstRow\(this\.sql\.exec\('SELECT value FROM room_meta/, 'metaGet must tolerate missing metadata rows.');
assert.match(worker, /if \(!this\.metaGet\('roomCode'\)\) return json\(\{ error: 'room_not_initialized' \}, \{ status: 404 \}\);/, 'Uninitialized room must return a clean 404.');
assert.match(cloud, /async function preflightCloudRoom\(/, 'Browser must preflight Cloud rooms before opening WebSocket.');
assert.match(cloud, /await preflightCloudRoom\(settings\.apiBase, code\)/, 'WebSocket connect must require successful room preflight.');
assert.match(cloud, /Cloud room \$\{roomCode\} does not exist yet/, 'Missing room error must be actionable.');
assert.match(cloud, /error\.permanent = response\.status === 404/, 'Missing rooms must not enter an infinite reconnect loop.');

console.log('PASS Phase 44/1.1.3 Cloud room-not-found handling');
