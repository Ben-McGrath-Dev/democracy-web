import fs from 'node:fs';
import assert from 'node:assert/strict';
const security=fs.readFileSync('js/security.js','utf8');
const legacyP2P=fs.existsSync('js/network.js');
const network=legacyP2P?fs.readFileSync('js/network.js','utf8'):'';
const worker=fs.readFileSync('worker/src/index.js','utf8');
const identity=fs.readFileSync('js/identity.js','utf8');
const secret=fs.readFileSync('js/secret-ballots.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const storage=fs.readFileSync('js/storage.js','utf8');
const config=fs.readFileSync('js/config.js','utf8');
assert.match(config,/(?:1\.[1-9]\.0(?:-phase\d+)?|1\.0\.[0-9]+|0\.30\.0-phase30)/);
assert.match(html,/Content-Security-Policy/);
assert.match(html,/securityBanner/);
assert.match(security,/lan-test/);
assert.match(identity,/LAN-TEST-INSECURE/);
assert.match(identity,/hasSecureCrypto/);
assert.match(secret,/assertSecureCrypto\('Sealed secret ballots'\)/);
if (legacyP2P) {
  assert.match(network,/MAX_ACTIONS_PER_WINDOW/);
  assert.match(network,/validateNetworkActionSize/);
  assert.match(network,/validateIncomingStateSize/);
} else {
  assert.match(worker,/MAX_WS_MESSAGE_BYTES/);
  assert.match(worker,/MAX_INITIAL_STATE_BYTES/);
  assert.match(worker,/used_nonces/);
}
assert.match(storage,/10 \* 1024 \* 1024/);
console.log('PASS Phase 29 security/abuse hardening structural tests.');
