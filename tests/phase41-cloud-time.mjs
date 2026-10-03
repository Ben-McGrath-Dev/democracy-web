import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGame, getState } from '../shared/state.js';
import { reduceDeterministic } from '../shared/reducer.js';
import { estimateCloudClock, cloudNow } from '../shared/cloud-time.js';

const estimate = estimateCloudClock({ serverAt: 10_050, clientSentAt: 9_900, receivedAt: 10_100 });
assert.equal(estimate.rttMs, 200);
assert.equal(estimate.offsetMs, 50);
assert.equal(cloudNow(20_000, estimate.offsetMs), 20_050);

createGame({ gameName:'Canonical Time Test', creatorName:'Alice' });
let state = getState();
const creatorId = Object.keys(state.players)[0];
const t0 = 1_800_000_000_000;
let reduced = reduceDeterministic(state, {
  type:'VOTE_CREATED', actorId:creatorId, voteId:'time-vote', title:'Canonical deadline', voteType:'yes-no-abstain', secret:false,
  durationMinutes:1, options:[{id:'yes',label:'Yes'},{id:'no',label:'No'},{id:'abstain',label:'Abstain'}]
}, { seed:'time-create', timestamp:t0 });
reduced = reduceDeterministic(reduced.state, { type:'VOTE_OPENED', actorId:creatorId, voteId:'time-vote', durationMinutes:1 }, { seed:'time-open', timestamp:t0 });
assert.equal(new Date(reduced.state.votes['time-vote'].closesAt).getTime(), t0 + 60_000);
assert.throws(() => reduceDeterministic(reduced.state, { type:'BALLOT_CAST', actorId:creatorId, voteId:'time-vote', voterId:creatorId, choice:'yes' }, { seed:'time-late', timestamp:t0 + 60_001 }), /deadline has passed/i);

const worker=fs.readFileSync(new URL('../worker/src/index.js',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../js/cloud-network.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
assert.match(worker,/const acceptedAt = Date\.now\(\)/);
assert.match(worker,/timestamp: acceptedAt/);
assert.match(worker,/clientSentAt/);
assert.match(worker,/serverAt/);
assert.match(client,/estimateCloudClock/);
assert.match(client,/getCloudNowMs/);
assert.match(app,/secondsRemaining\(vote, getCloudNowMs\(\)\)/);
assert.match(app,/deriveAttention\(state, localActorId\(state\), getCloudNowMs\(\)\)/);
console.log('Phase 41 canonical Cloud time and deadline enforcement: PASS');
