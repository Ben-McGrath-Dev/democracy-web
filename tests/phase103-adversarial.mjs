import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import { createGame, dispatch, getState } from '../js/state.js';
import { authorizePeerAction } from '../js/permissions.js';

const s0 = createGame({ gameName:'1.0.3 Adversarial', creatorName:'Alice' });
const alice = Object.values(s0.players)[0];
dispatch({type:'PLAYER_ADDED', actorId:alice.id, playerId:'bob', name:'Bob'});

// Peer identity binding must override an attempted forged voter/signer identity.
let a = authorizePeerAction(getState(), {type:'BALLOT_CAST', voterId:alice.id, voteId:'fake', choice:'yes'}, 'bob');
assert.equal(a.voterId, 'bob');
a = authorizePeerAction(getState(), {type:'HOST_REMOVAL_SIGNED', playerId:alice.id}, 'bob');
assert.equal(a.playerId, 'bob');

// Alice creates a petition-route proposal; Bob must not be able to mutate/finalize it.
dispatch({type:'LAW_PROPOSED', actorId:alice.id, title:'A', text:'Text', reason:'Reason', sponsorRoute:'petition'});
const law = Object.values(getState().lawProposals)[0];
assert.throws(() => authorizePeerAction(getState(), {type:'LAW_PROPOSAL_UPDATED', proposalId:law.id, text:'Bob edit'}, 'bob'), /original proposer/);
assert.throws(() => authorizePeerAction(getState(), {type:'LAW_PROPOSAL_FINALIZED', proposalId:law.id}, 'bob'), /proposer or Constitutional Host/);

dispatch({type:'CONSTITUTION_AMENDMENT_PROPOSED', actorId:alice.id, section:'999', sectionTitle:'Test', category:'EDITABLE', currentText:'Old', proposedText:'New', reason:'Reason', sponsorRoute:'petition'});
const amd = Object.values(getState().constitution.proposals)[0];
assert.throws(() => authorizePeerAction(getState(), {type:'CONSTITUTION_AMENDMENT_UPDATED', proposalId:amd.id, proposedText:'Bob edit'}, 'bob'), /original proposer/);
assert.throws(() => authorizePeerAction(getState(), {type:'CONSTITUTION_AMENDMENT_FINALIZED', proposalId:amd.id}, 'bob'), /proposer or Constitutional Host/);

// Direct online party assignment remains forbidden.
assert.throws(() => authorizePeerAction(getState(), {type:'PLAYER_JOINED_PARTY', playerId:'bob', partyId:'anything'}, 'bob'), /Direct party joins are not permitted/);

console.log('PASS Democracy Web 1.0.3 adversarial permission/identity checks');
