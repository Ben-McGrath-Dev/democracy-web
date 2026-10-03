import fs from 'node:fs';
import assert from 'node:assert/strict';

const net = fs.readFileSync(new URL('../js/network.js', import.meta.url), 'utf8');
assert.match(net, /function handleTrysteroJoinError\(details\)/, 'expected peer-scoped join error handler');
assert.match(net, /if \(role === 'owner'\)[\s\S]*?if \(room\) connectionState = 'connected';/, 'owner must remain connected after a peer-scoped join failure');
assert.doesNotMatch(net, /onJoinError:\s*e\s*=>\s*\{[^}]*connectionState\s*=\s*'disconnected'/, 'onJoinError must not globally disconnect a room');
assert.match(net, /onJoinError:\s*handleTrysteroJoinError/g, 'both host and client should use the scoped handler');
console.log('Phase 1.0.4 host connection regression: PASS');
