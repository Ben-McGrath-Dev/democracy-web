import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
globalThis.btoa ??= value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob ??= value => Buffer.from(value, 'base64').toString('binary');

import { createGame, dispatch, getState } from '../js/state.js';
import { createBallotBox, encryptSecretChoice, revealBallotBox, verifyRevealedSecretVote } from '../js/secret-ballots.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

const state0 = createGame({ gameName: 'Secret Ballot Test', creatorName: 'Alice' });
const alice = Object.values(state0.players)[0];
dispatch({ type:'PLAYER_ADDED', actorId:alice.id, name:'Bob', playerId:'bob' });
dispatch({ type:'PLAYER_ADDED', actorId:alice.id, name:'Chris', playerId:'chris' });
dispatch({ type:'VOTE_CREATED', actorId:alice.id, voteId:'secret-test', title:'Secret Test', voteType:'yes-no-abstain', secret:true, options:[{id:'yes',label:'Yes'},{id:'no',label:'No'},{id:'abstain',label:'Abstain'}] });

const { publicJwk } = await createBallotBox('secret-test');
dispatch({ type:'VOTE_OPENED', actorId:alice.id, voteId:'secret-test', secretBoxPublicKey:publicJwk });

let vote = getState().votes['secret-test'];
assert(vote.secretBallotMode === 'sealed-v1', 'Secret vote did not enter sealed mode.');
const choices = ['yes','no','yes'];
const voters = [alice.id,'bob','chris'];
for (let i=0;i<voters.length;i++) {
  const encryptedBallot = await encryptSecretChoice(publicJwk, choices[i]);
  dispatch({ type:'BALLOT_CAST', voterId:voters[i], voteId:'secret-test', encryptedBallot });
}

vote = getState().votes['secret-test'];
assert(Object.keys(vote.ballots).length === 0, 'Plaintext ballot map should remain empty for sealed votes.');
assert(vote.sealedBallots.length === 3, 'Expected three sealed ballot envelopes.');
assert(Object.keys(vote.submittedVoters).length === 3, 'Expected three submission markers.');
assert(!JSON.stringify(vote.sealedBallots).includes('yes'), 'Ciphertext state leaked a plaintext choice.');

let duplicateRejected = false;
try {
  const duplicate = await encryptSecretChoice(publicJwk, 'yes');
  dispatch({ type:'BALLOT_CAST', voterId:alice.id, voteId:'secret-test', encryptedBallot:duplicate });
} catch { duplicateRejected = true; }
assert(duplicateRejected, 'A second sealed ballot from the same voter should be rejected.');

const reveal = await revealBallotBox(vote);
const shuffledReveal = [...reveal.choices].reverse();
dispatch({ type:'VOTE_CLOSED', actorId:alice.id, voteId:'secret-test', revealedChoices:shuffledReveal });
vote = getState().votes['secret-test'];
assert(vote.result?.counts?.yes === 2 && vote.result?.counts?.no === 1, 'Sealed ballot tally is wrong.');
const audit = await verifyRevealedSecretVote(vote);
assert(audit.ok && audit.count === 3, 'Revealed sealed ballots failed cryptographic audit.');

const tampered = structuredClone(vote);
tampered.revealedChoices = ['yes','yes','yes'];
const badAudit = await verifyRevealedSecretVote(tampered);
assert(!badAudit.ok, 'Tampered revealed choices should fail audit verification.');

console.log('PASS Phase 20 sealed secret ballot test — encrypted state, one-voter-one-ballot, delayed reveal, local-key cryptographic audit verification.');
