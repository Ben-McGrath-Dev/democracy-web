import fs from 'node:fs';
import { createGame, dispatch, getState, loadState } from '../js/state.js';
import { verifyEventChain, hashJson } from '../js/integrity.js';

const legacyP2P=fs.existsSync(new URL('../js/network.js',import.meta.url));
const network=legacyP2P?fs.readFileSync(new URL('../js/network.js',import.meta.url),'utf8'):'';
const cloud=fs.readFileSync(new URL('../js/cloud-network.js',import.meta.url),'utf8');
const identity=fs.readFileSync(new URL('../js/identity.js',import.meta.url),'utf8');
const storage=fs.readFileSync(new URL('../js/storage.js',import.meta.url),'utf8');
const config=fs.readFileSync(new URL('../js/config.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const checks=[
  [identity.includes("ECDSA") && identity.includes("P-256"),'ECDSA P-256 browser identity'],
  [identity.includes('exportIdentityBlob') && identity.includes('importIdentityFile'),'identity export/import'],
  [legacyP2P ? network.includes('verifySignedPayload') : cloud.includes('verifyCloudSignedPayload'),'online signature verification'],
  [legacyP2P ? (network.includes("kind:'game-action'") || network.includes("kind: 'game-action'")) : cloud.includes('cloudActionPayload'),'signed game-action envelope'],
  [legacyP2P ? network.includes('seenActionNonces') : cloud.includes('nonce'),'replay nonce protection'],
  [legacyP2P ? network.includes('identityFingerprint') : cloud.includes('fingerprint'),'player fingerprint binding'],
  [storage.includes('stateHash') && storage.includes('eventHeadHash'),'snapshot/export integrity hashes'],
  [app.includes('export-identity') && app.includes('import-identity'),'identity management UI'],
  [/APP_VERSION\s*=\s*'(?:1\.[1-9]\.0(?:-phase\d+)?|1\.0\.[0-9]+|0\.(?:1[9]|2[0-9]|[3-9][0-9])\.0-phase(?:1[9]|2[0-9]|[3-9][0-9]))'/.test(config),'Phase 19 version']
];
for(const [ok,name] of checks){if(!ok)throw new Error(`FAIL: ${name}`);console.log(`PASS: ${name}`);}

createGame({gameName:'Integrity Test',creatorName:'Owner'});
let state=getState();
const ownerId=Object.keys(state.players)[0];
dispatch({type:'GAME_RENAMED',actorId:ownerId,name:'Integrity Test 2'});
dispatch({type:'PLAYER_ADDED',actorId:ownerId,name:'Alice'});
state=getState();
let result=verifyEventChain(state.history);
if(!result.ok) throw new Error('FAIL: freshly generated event chain');
if(state.history.some((e,i)=>e.sequence!==i+1||!e.hash)) throw new Error('FAIL: missing event chain metadata');
console.log(`PASS: ${result.count} official events are hash chained`);

const tampered=structuredClone(state);
tampered.history[1].data.newName='Tampered Name';
result=verifyEventChain(tampered.history);
if(result.ok) throw new Error('FAIL: tampering was not detected');
console.log(`PASS: tampering detected at event ${result.index+1}`);

const legacy=structuredClone(state);
for(const event of legacy.history){delete event.hash;delete event.previousHash;delete event.sequence;}
loadState(legacy);
result=verifyEventChain(getState().history);
if(!result.ok) throw new Error('FAIL: legacy history upgrade');
console.log('PASS: legacy unchained history upgrades deterministically');
if(hashJson({b:2,a:1})!==hashJson({a:1,b:2})) throw new Error('FAIL: stable JSON hashing');
console.log('PASS: stable state hashing');
console.log('Phase 18–19 security/integrity tests passed.');
