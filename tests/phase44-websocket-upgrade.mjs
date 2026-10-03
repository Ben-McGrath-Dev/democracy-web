import fs from 'node:fs';
import assert from 'node:assert/strict';

const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
assert.match(worker, /if \(ws\) return proxied;/, 'WebSocket upgrade response must be returned untouched');
assert.doesNotMatch(worker, /webSocket:\s*proxied\.webSocket/, 'Worker must not reconstruct proxied WebSocket response');
assert.match(worker, /return new Response\(proxied\.body,[\s\S]*headers\s*\}/, 'Normal HTTP room responses should still be wrapped for CORS');
console.log('PASS phase44 websocket upgrade forwarding');
