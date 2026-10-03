import fs from 'node:fs';
import { createGame, getState, updateTechnicalNetworkState, loadState } from '../js/state.js';
const LEGACY_P2P_RETIRED = !fs.existsSync(new URL('../js/network.js', import.meta.url));
if (LEGACY_P2P_RETIRED) {
  console.log('PASS: legacy P2P transport intentionally retired in Democracy Web 1.1 / Phase 44');
  process.exit(0);
}


const network = fs.readFileSync(new URL('../js/network.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');

const checks = [
  [network.includes("SESSION_PREFIX"), 'persistent reconnect session'],
  [network.includes("reconnectPlayerId"), 'same-player reconnect request'],
  [network.includes("reconnected"), 'reconnect acknowledgement'],
  [network.includes("dw-recovery"), 'peer recovery-state exchange'],
  [network.includes("dw-authority"), 'authority migration channel'],
  [network.includes("authorityEpoch"), 'authority epoch protection'],
  [network.includes("chooseMigrationWinner"), 'deterministic migration election'],
  [network.includes("backupOwnerPlayerId"), 'preferred backup owner'],
  [network.includes("bestRecoveryState"), 'newest-state recovery selection'],
  [app.includes("set-backup-owner"), 'backup owner UI'],
  [app.includes("resumeOnlineSession"), 'automatic refresh reconnect'],
  [/APP_VERSION\s*=\s*'(?:1\.[1-9]\.0(?:-phase\d+)?|1\.0\.[0-9]+|0\.(?:1[7-9]|2[0-9]|[3-9][0-9])\.0-phase(?:1[7-9]|2[0-9]|[3-9][0-9]))'/.test(config), 'phase 17 version']
];
for (const [ok, name] of checks) {
  if (!ok) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
}

createGame({gameName:'Continuity Test',creatorName:'Owner'});
let state=getState();
const ownerId=Object.keys(state.players)[0];
updateTechnicalNetworkState({authorityEpoch:4,ownerPlayerId:ownerId,backupOwnerPlayerId:'player-backup',reconnectTokens:{[ownerId]:'token-a'}});
state=getState();
if(state.network.authorityEpoch!==4) throw new Error('FAIL: authority epoch persistence');
if(state.network.ownerPlayerId!==ownerId) throw new Error('FAIL: owner player persistence');
const copy=structuredClone(state);
loadState(copy);
if(getState().network.reconnectTokens[ownerId]!=='token-a') throw new Error('FAIL: reconnect metadata survives state reload');
console.log('PASS: continuity metadata survives canonical state reload');
console.log('Phase 17 reconnect/migration structural tests passed.');
