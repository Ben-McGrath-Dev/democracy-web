import { createGame, dispatch, getState } from '../js/state.js';
import { runSyntheticStressSuite } from '../js/testing.js';
import { auditState } from '../js/diagnostics.js';

createGame({ gameName: 'Stress Republic', creatorName: 'Player 001' });
let state = getState();
const creator = Object.keys(state.players)[0];
for (let i = 2; i <= 100; i++) {
  dispatch({ type:'PLAYER_ADDED', actorId:creator, name:`Player ${String(i).padStart(3,'0')}` });
}
state = getState();
const ids = Object.keys(state.players);
const parties = [
  ['Alpha Party','ALP'],['Beta Party','BET'],['Gamma Party','GAM'],['Delta Party','DEL'],['Epsilon Party','EPS']
];
for (let p=0; p<parties.length; p++) {
  const leader = ids[p];
  dispatch({ type:'PARTY_CREATED', actorId:creator, leaderId:leader, name:parties[p][0], abbreviation:parties[p][1], description:'Stress fixture' });
}
state=getState();
const partyIds=Object.keys(state.parties);
for (const [index, playerId] of ids.entries()) {
  if (state.players[playerId].partyId) continue;
  dispatch({ type:'PLAYER_JOINED_PARTY', actorId:creator, playerId, partyId:partyIds[index % partyIds.length] });
}
state=getState();
const audit=auditState(state);
if (!audit.ok) {
  console.error('FAIL fixture audit', audit.issues);
  process.exit(1);
}
const result=runSyntheticStressSuite(state,{samples:3000,seed:0x51A7E});
if (!result.ok) {
  console.error('FAIL Phase 28 synthetic stress suite', result.audit.issues);
  process.exit(1);
}
const row100=result.fanout.find(r=>r.players===100);
console.log('PASS Phase 28 synthetic stress suite');
console.log(`  players: 100`);
console.log(`  state: ${result.stateKiB.toFixed(1)} KiB`);
console.log(`  100-player full-state fanout: ${(row100.oneFullBroadcastBytes/1024/1024).toFixed(2)} MiB`);
console.log(`  10 broadcasts @100 players: ${(row100.tenFullBroadcastsBytes/1024/1024).toFixed(2)} MiB`);
console.log(`  election count throughput: ${Math.round(result.benchmark.operationsPerSecond).toLocaleString()} ops/s`);
console.log(`  integrity audit: ${result.audit.durationMs.toFixed(2)} ms`);
