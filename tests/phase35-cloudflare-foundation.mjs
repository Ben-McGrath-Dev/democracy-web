import fs from 'node:fs';
import assert from 'node:assert/strict';
import { CLOUD_PROTOCOL_VERSION, CLOUD_MESSAGE, protocolEnvelope, parseProtocolMessage } from '../shared/protocol.js';

const wranglerText = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(wranglerText, /"DEMOCRACY_ROOMS"/);
assert.match(wranglerText, /"class_name"\s*:\s*"DemocracyRoom"/);
assert.match(wranglerText, /"storage"\s*:\s*"sqlite"/);
assert.match(worker, /export class DemocracyRoom extends DurableObject/);
assert.match(worker, /\/health/);
assert.match(worker, /\/rooms/);
assert.match(worker, /acceptWebSocket/);
assert.match(worker, /webSocketMessage/);
assert.match(worker, /webSocketClose/);
assert.match(worker, /ctx\.storage\.sql/);
assert.match(pkg.version, /^1\.1\.[0-9]+(?:-phase\d+)?$/);
assert.ok(pkg.scripts['cloud:dev']);
assert.ok(pkg.scripts['cloud:deploy']);
assert.equal(CLOUD_PROTOCOL_VERSION, 1);
const ping = protocolEnvelope(CLOUD_MESSAGE.PING, { n: 1 });
assert.deepEqual(parseProtocolMessage(JSON.stringify(ping)), ping);
assert.throws(() => parseProtocolMessage(JSON.stringify({ protocol: 999, type:'PING' })), /Unsupported protocol version/);
console.log('Phase 35 Cloudflare foundation: PASS');
