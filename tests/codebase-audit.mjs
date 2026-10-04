import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGame, dispatch } from '../shared/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const config = readFileSync(join(root, 'js/config.js'), 'utf8');
const app = readFileSync(join(root, 'js/app.js'), 'utf8');
const cloud = readFileSync(join(root, 'js/cloud-network.js'), 'utf8');
const help = readFileSync(join(root, 'js/help.js'), 'utf8');
const rulebook = readFileSync(join(root, 'full-rules.md'), 'utf8');

assert.equal(pkg.version, '1.2.0-phase69');
assert.match(config, /1\.2\.0-phase69/);
assert.match(cloud, /PREFLIGHT_TIMEOUT_MS/);
assert.match(cloud, /WEBSOCKET_AUTH_TIMEOUT_MS/);
assert.doesNotMatch(app, /if \(finalStep\) localStorage\.setItem\(ONBOARDING_KEY/);
assert.match(app, /safePartyColour/);
assert.match(rulebook, /## 43\. Punishment Committee/);
assert.match(rulebook, /## 45\. People's Actions Committee/);
assert.match(rulebook, /## 55\. People's Punishment Committee/);
assert.match(help, /Punishment Committee/);
assert.match(help, /People's Actions Committee/);
assert.match(help, /People's Punishment Committee/);
assert.doesNotMatch(help, /Procedures Committee|Public Accountability Committee|Public Punishment Committee/);

const state = createGame({ gameName:'Audit', creatorName:'Creator' });
const creatorId = Object.keys(state.players)[0];
assert.throws(() => dispatch({type:'PARTY_CREATED', actorId:creatorId, leaderId:creatorId, name:'Unsafe', colour:'red;background:red'}), /six-digit hex colour/);
dispatch({type:'PARTY_CREATED', actorId:creatorId, leaderId:creatorId, name:'Safe', colour:'#ABCDEF'});
const partyId = Object.keys((await import('../shared/state.js')).getState().parties)[0];
assert.throws(() => dispatch({type:'PARTY_UPDATED', actorId:creatorId, partyId, name:'X'.repeat(81), colour:'#abcdef'}), /80 characters/);

assert.match(app, /sign-host-removal[\s\S]*online\?actorId/, 'Online host-removal petition should be self-bound in UI');
assert.match(app, /sign-law-proposal[\s\S]*online\?actorId/, 'Online law-proposal petition should be self-bound in UI');
assert.match(app, /sign-law-referendum[\s\S]*online\?actorId/, 'Online referendum petition should be self-bound in UI');
assert.match(app, /sign-initiative[\s\S]*online\?actorId/, 'Online citizen initiative should be self-bound in UI');
assert.match(app, /sign-base-unlock[\s\S]*online\?actorId/, 'Online base-rule unlock petition should be self-bound in UI');
assert.match(app, /sign-amendment-petition[\s\S]*online\?actorId/, 'Online amendment petition should be self-bound in UI');
assert.match(app, /open-case[\s\S]*online\?actorId/, 'Online case complainant should be self-bound in UI');

console.log('PASS codebase audit regressions');
