import assert from 'node:assert/strict';
import { createGame, dispatch, getState, loadState } from '../js/state.js';
import { electionDefaults, ELECTION_KINDS } from '../js/elections.js';
import { auditState } from '../js/diagnostics.js';

function state() { return getState(); }
function players() { return Object.values(state().players); }
function activePlayers() { return players().filter(p => p.status === 'active'); }
function actor() { return players()[0].id; }
function latest(map) { return Object.values(map).at(-1); }

function createElection(kind, optionIds, committee = null) {
  const s = state();
  const defaults = electionDefaults(kind, activePlayers().length, committee);
  let options;
  const settings = { ...defaults.settings };
  if (kind === ELECTION_KINDS.GENERAL) {
    const parties = Object.values(s.parties).filter(p => p.status === 'active');
    options = parties.map(p => ({ id:p.id, label:p.name, entityId:p.id }));
    settings.candidateLists = Object.fromEntries(parties.map(p => [p.id, [...p.members]]));
  } else {
    options = optionIds.map(id => ({ id, label:s.players[id].displayName, entityId:id }));
  }
  dispatch({ type:'VOTE_CREATED', actorId:actor(), title:defaults.title, voteType:defaults.type, electionKind:kind, committee, options, durationMinutes:1, secret:true, settings });
  return latest(state().votes).id;
}

function openCastCloseCertify(voteId, chooser) {
  dispatch({ type:'VOTE_OPENED', actorId:actor(), voteId, durationMinutes:1 });
  const vote = state().votes[voteId];
  for (const [index, voterId] of vote.electorateSnapshot.entries()) {
    dispatch({ type:'BALLOT_CAST', voterId, voteId, choice:chooser(vote, voterId, index) });
  }
  dispatch({ type:'VOTE_CLOSED', actorId:actor(), voteId });
  dispatch({ type:'VOTE_CERTIFIED', actorId:actor(), voteId });
}

createGame({ gameName:'Phase 12 Smoke Republic', creatorName:'Player 01' });
for (let i=2;i<=30;i++) dispatch({ type:'PLAYER_ADDED', actorId:actor(), name:`Player ${String(i).padStart(2,'0')}` });
assert.equal(activePlayers().length, 30);

// Parties and balanced membership.
for (let i=0;i<3;i++) {
  const leader = activePlayers().find(p => !p.partyId);
  dispatch({ type:'PARTY_CREATED', actorId:actor(), leaderId:leader.id, name:['Civic','Reform','Progress'][i], abbreviation:['CIV','REF','PRO'][i], description:'Smoke test party' });
}
let parties = Object.values(state().parties);
for (const [i, p] of activePlayers().filter(p=>!p.partyId).entries()) dispatch({ type:'PLAYER_JOINED_PARTY', actorId:actor(), playerId:p.id, partyId:parties[i%3].id });
parties = Object.values(state().parties);
assert.equal(parties.reduce((n,p)=>n+p.members.length,0),30);

// General election -> 7 seat Parliament.
const generalId = createElection(ELECTION_KINDS.GENERAL, []);
openCastCloseCertify(generalId, (vote, voterId, index) => vote.options[index % 3].id);
assert.equal(state().legislature.totalSeats, 7);
assert.equal(state().legislature.seats.length, 7);
assert.equal(state().government.status, 'forming');

// Form a majority government from enough seat-winning parties.
const seatCounts = {};
for (const seat of state().legislature.seats.filter(s=>s.status==='filled')) seatCounts[seat.partyId]=(seatCounts[seat.partyId]??0)+1;
const orderedParties = Object.keys(seatCounts).sort((a,b)=>seatCounts[b]-seatCounts[a]);
const coalition=[]; let total=0;
for (const id of orderedParties) { coalition.push(id); total += seatCounts[id]; if (total >= 4) break; }
dispatch({ type:'GOVERNMENT_FORMED', actorId:actor(), partyIds:coalition, primeMinisterId:actor() });
assert.equal(state().government.status,'active');

// Host election.
const candidateIds=activePlayers().slice(0,3).map(p=>p.id);
const hostVote=createElection(ELECTION_KINDS.HOST,candidateIds);
openCastCloseCertify(hostVote,(vote,voterId,index)=> index < 20 ? candidateIds : [candidateIds[1],candidateIds[0],candidateIds[2]]);
assert.ok(state().meta.hostPlayerId);

// Seat all committees using disjoint candidates to satisfy separation rule.
let cursor=3;
for (const code of ['AC','PC','PAC','PPC']) {
  const ids=activePlayers().slice(cursor,cursor+5).map(p=>p.id); cursor+=5;
  const voteId=createElection(ELECTION_KINDS.COMMITTEE,ids,code);
  openCastCloseCertify(voteId,(vote)=>vote.options.slice(0,3).map(o=>o.id));
  assert.equal(state().committees[code].members.length,3);
}

// Exercise an ordinary case through PAC -> jury -> PPC.
const s1=state();
const accused=activePlayers().at(-1).id;
const complainant=activePlayers().at(-2).id;
const lawId=Object.keys(s1.laws)[0];
dispatch({ type:'CASE_OPENED', actorId:actor(), accusedId:accused, complainantId:complainant, lawId, conduct:'Smoke-test alleged conduct', evidence:'Synthetic evidence' });
const caseId=Object.keys(state().cases).at(-1);
dispatch({ type:'CASE_RESPONSE_SUBMITTED', actorId:accused, caseId, response:'Synthetic response' });
dispatch({ type:'CASE_PAC_PANEL_ASSIGNED', actorId:actor(), caseId });
dispatch({ type:'CASE_PAC_VOTE_CREATED', actorId:actor(), caseId });
let c=state().cases[caseId];
openCastCloseCertify(c.pacVoteId,()=> 'yes');
c=state().cases[caseId];
assert.equal(c.status,'awaiting-jury');
dispatch({ type:'CASE_JURY_SELECTED', actorId:actor(), caseId });
dispatch({ type:'CASE_JURY_VOTE_CREATED', actorId:actor(), caseId });
c=state().cases[caseId];
openCastCloseCertify(c.juryVoteId,()=> 'yes');
c=state().cases[caseId];
assert.equal(c.status,'awaiting-ppc');
dispatch({ type:'CASE_PPC_PUNISHMENT_RECORDED', actorId:actor(), caseId, punishment:'Synthetic warning' });
assert.equal(state().cases[caseId].status,'closed-guilty');

// Constitutional amendment: government sponsorship, time-shift discussion, vote and apply.
dispatch({ type:'CONSTITUTION_AMENDMENT_PROPOSED', actorId:actor(), section:'91', sectionTitle:'First Election', category:'EDITABLE', currentText:state().constitution.sections['91'].text, proposedText:'Synthetic amended first-election provision for smoke testing.', reason:'Phase 12 test', sponsorRoute:'government' });
const amendmentId=Object.keys(state().constitution.proposals).at(-1);
let shifted=state();
shifted.constitution.proposals[amendmentId].discussionEndsAt=new Date(Date.now()-1000).toISOString();
loadState(shifted);
dispatch({ type:'CONSTITUTION_AMENDMENT_FINALIZED', actorId:actor(), proposalId:amendmentId });
let amendment=state().constitution.proposals[amendmentId];
openCastCloseCertify(amendment.voteId,()=> 'yes');
assert.equal(state().constitution.sections['91'].text,'Synthetic amended first-election provision for smoke testing.');
assert.ok(state().constitution.version >= 2);

// Exercise ordinary legislation through Parliament and enact after referendum window.
dispatch({ type:'LAW_PROPOSED', actorId:actor(), title:'Smoke Test Act', text:'This is a synthetic law for Phase 12 testing.', reason:'Exercise the legislative flow.', pathway:'legislative', sponsorRoute:'government' });
const proposalId=Object.keys(state().lawProposals).at(-1);
shifted=state();
shifted.lawProposals[proposalId].discussionEndsAt=new Date(Date.now()-1000).toISOString();
loadState(shifted);
dispatch({ type:'LAW_PROPOSAL_FINALIZED', actorId:actor(), proposalId });
let proposal=state().lawProposals[proposalId];
openCastCloseCertify(proposal.legislativeVoteId,()=> 'yes');
proposal=state().lawProposals[proposalId];
assert.equal(proposal.status,'referendum-window');
shifted=state();
shifted.lawProposals[proposalId].referendumDeadline=new Date(Date.now()-1000).toISOString();
loadState(shifted);
dispatch({ type:'CHECK_LAW_REFERENDUM_WINDOW', actorId:actor(), proposalId });
assert.ok(Object.values(state().laws).some(l=>l.title==='Smoke Test Act'));


// Host removal: 20% petition, then 90% approval with 50% turnout.
dispatch({ type:'HOST_REMOVAL_PROPOSED', actorId:actor() });
for (const signer of activePlayers().slice(1,6)) dispatch({ type:'HOST_REMOVAL_SIGNED', actorId:actor(), playerId:signer.id });
let removal=state().hostRemoval;
assert.equal(removal.status,'voting');
openCastCloseCertify(removal.voteId,(vote,voterId,index)=> index < 27 ? 'yes' : 'no');
assert.equal(state().hostRemoval.status,'passed');
assert.equal(state().meta.hostPlayerId,null);

const audit=auditState(state());
assert.equal(audit.errors,0,JSON.stringify(audit.issues,null,2));
assert.ok(state().history.length > 100);
console.log(`PASS Phase 12 offline smoke test — state #${state().stateVersion}, ${state().history.length} events, ${Object.keys(state().votes).length} votes.`);
