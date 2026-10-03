import assert from 'node:assert/strict';
import { createGame, dispatch, getState } from '../js/state.js';
import { authorizePeerAction } from '../js/permissions.js';

createGame({ gameName: 'Authority Test', creatorName: 'Alice' });
let state = getState();
const alice = Object.keys(state.players)[0];
dispatch({ type: 'PLAYER_ADDED', actorId: alice, name: 'Bob', playerId: 'bob' });
dispatch({ type: 'PLAYER_ADDED', actorId: alice, name: 'Carol', playerId: 'carol' });
dispatch({ type: 'PARTY_CREATED', actorId: alice, leaderId: alice, name: 'Consent Party', abbreviation: 'CP' });
state = getState();
const partyId = Object.keys(state.parties)[0];

// A signed peer action cannot rename or resign another identity.
assert.throws(() => authorizePeerAction(state, { type: 'PLAYER_RENAMED', playerId: 'bob', name: 'Not Bob' }, 'carol'), /only perform that action for yourself/);

// Direct party joins are forbidden online.
assert.throws(() => authorizePeerAction(state, { type: 'PLAYER_JOINED_PARTY', playerId: 'bob', partyId }, 'bob'), /Direct party joins/);

// Leader invite does not immediately change membership.
dispatch({ type: 'PARTY_INVITE_SENT', actorId: alice, playerId: 'bob', partyId });
state = getState();
assert.equal(state.players.bob.partyId, null);
const invite = Object.values(state.partyMembershipRequests)[0];
assert.equal(invite.status, 'pending');

// Wrong identity cannot answer Bob's invitation.
assert.throws(() => dispatch({ type: 'PARTY_MEMBERSHIP_RESPONDED', actorId: 'carol', requestId: invite.id, response: 'accept' }), /invited player/);

// Bob accepts and only then becomes a member.
dispatch({ type: 'PARTY_MEMBERSHIP_RESPONDED', actorId: 'bob', requestId: invite.id, response: 'accept' });
state = getState();
assert.equal(state.players.bob.partyId, partyId);
assert.equal(state.partyMembershipRequests[invite.id].status, 'accepted');

// Carol can request membership, but cannot self-approve it.
dispatch({ type: 'PARTY_JOIN_REQUESTED', actorId: 'carol', playerId: 'carol', partyId });
state = getState();
const request = Object.values(state.partyMembershipRequests).find(r => r.playerId === 'carol');
assert(request);
assert.throws(() => dispatch({ type: 'PARTY_MEMBERSHIP_RESPONDED', actorId: 'carol', requestId: request.id, response: 'accept' }), /party leader/);
dispatch({ type: 'PARTY_MEMBERSHIP_RESPONDED', actorId: alice, requestId: request.id, response: 'accept' });
state = getState();
assert.equal(state.players.carol.partyId, partyId);

console.log('PASS 1.0.1 authority and party-consent checks');
