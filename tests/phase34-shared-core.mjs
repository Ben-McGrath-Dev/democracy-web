import fs from 'node:fs';
import assert from 'node:assert/strict';
import { legislatureSeatCount as browserSeatCount } from '../js/elections.js';
import { legislatureSeatCount as sharedSeatCount } from '../shared/elections.js';
import { majorityThreshold as browserMajority } from '../js/legislature.js';
import { majorityThreshold as sharedMajority } from '../shared/legislature.js';
import { canonicalStateHash as browserHash } from '../js/integrity.js';
import { canonicalStateHash as sharedHash } from '../shared/integrity.js';
import { createGame, getState, simulateDeterministicAction } from '../shared/state.js';
import { reduceDeterministic } from '../shared/reducer.js';

for (const n of [25,39,40,59,60,99,100,250]) assert.equal(browserSeatCount(n), sharedSeatCount(n));
for (const n of [0,1,2,3,7,10,20]) assert.equal(browserMajority(n), sharedMajority(n));

const wrappers = ['utils','events','voting','elections','legislature','government','laws','constitution','committees','cases','integrity','permissions','starting-laws','starting-constitution','state'];
for (const name of wrappers) {
  const source = fs.readFileSync(new URL(`../js/${name}.js`, import.meta.url), 'utf8').trim();
  assert.match(source, new RegExp(`^export \\* from '\\.\\./shared/${name}\\.js';$`), `${name}.js should be a compatibility re-export`);
}

createGame({ gameName:'Shared Core Test', creatorName:'Alice' });
const base = getState();
const playerId = Object.keys(base.players)[0];
const action = { type:'PLAYER_RENAMED', playerId, name:'Alice Shared', actorId:playerId };
const context = { seed:'phase34-equivalence', timestamp:1791057600000 };
const direct = simulateDeterministicAction(base, action, context);
const reduced = reduceDeterministic(base, action, context);
assert.equal(reduced.stateHash, canonicalStateHashSafe(direct));
assert.equal(browserHash(direct), sharedHash(direct));
assert.deepEqual(reduced.state, direct);

function canonicalStateHashSafe(state) { return sharedHash(state); }
console.log('Phase 34 shared deterministic core: PASS');
