import assert from 'node:assert/strict';
import { deriveAttention } from '../js/attention.js';
const now=Date.now();
const state={
 votes:{v1:{id:'v1',title:'Budget Vote',status:'open',closesAt:new Date(now+60*60*1000).toISOString(),electorateSnapshot:['p1'],ballots:{},submittedVoters:{}}},
 government:{status:'caretaker',caretakerSince:'x',earlyElectionRequired:false},
 cases:{c1:{id:'CASE-001',status:'open',accusedId:'p1',accusedResponse:null}}
};
const a=deriveAttention(state,'p1',now);
assert(a.some(x=>x.id==='vote-unvoted:v1'));
assert(a.some(x=>x.id==='caretaker:x'));
assert(a.some(x=>x.id==='case-response:CASE-001'));
console.log('PASS Phase 24 attention derivation');
