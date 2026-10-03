function isActive(state, id) { return Boolean(id && state.players?.[id]?.status === 'active'); }
function isHostLike(state, id) { if (!id) return false; if ([state.meta?.hostPlayerId, state.meta?.deputyHostPlayerId].includes(id)) return true; if (!state.meta?.hostPlayerId) return Boolean(state.players?.[id]?.roles?.includes('creator')); return false; }
function partyLeader(state, id, partyId) { return Boolean(partyId && state.parties?.[partyId]?.leaderId === id); }
function committeeMember(state, id, code) { const c = state.committees?.[code]; return Boolean(c && [...(c.members||[]), ...(c.alternates||[])].includes(id)); }
function pmOrCoalitionLeader(state, id) {
  if (state.government?.primeMinisterId === id) return true;
  return (state.government?.coalitionPartyIds || []).some(pid => state.parties?.[pid]?.leaderId === id);
}

const HOST_ADMIN = new Set([
  'GAME_RENAMED','PLAYER_ADDED','PLAYER_STATUS_CHANGED','VOTE_CREATED','VOTE_OPENED','VOTE_PAUSED','VOTE_RESUMED','SECRET_BALLOT_BOX_REVEALED','VOTE_CLOSED','VOTE_CERTIFIED',
  'CHECK_LAW_REFERENDUM_WINDOW','LAW_REFERRED_TO_REFERENDUM','CHECK_GOVERNMENT_FORMATION_DEADLINE','CASE_PAC_PANEL_ASSIGNED','CASE_JURY_SELECTED'
]);
const SELF_ACTIONS = new Set(['PLAYER_RENAMED','PLAYER_RESIGNED','MP_RESIGNED_SEAT']);
const PETITION_ACTIONS = new Set(['LAW_PROPOSAL_PETITION_SIGNED','LAW_REFERENDUM_PETITION_SIGNED','CITIZEN_INITIATIVE_SIGNED','CONSTITUTION_BASE_UNLOCK_SIGNED','CONSTITUTION_AMENDMENT_PETITION_SIGNED','HOST_REMOVAL_SIGNED']);

export function authorizePeerAction(state, rawAction, playerId) {
  if (!isActive(state, playerId)) throw new Error('Your player is not active.');
  const action = structuredClone(rawAction);
  action.actorId = playerId;

  if (action.type === 'BALLOT_CAST') { action.voterId = playerId; return action; }
  if (PETITION_ACTIONS.has(action.type)) { action.playerId = playerId; return action; }
  if (SELF_ACTIONS.has(action.type)) {
    if (action.playerId && action.playerId !== playerId) throw new Error('You may only perform that action for yourself.');
    action.playerId = playerId; return action;
  }
  if (action.type === 'PLAYER_LEFT_PARTY') { action.playerId = playerId; return action; }
  if (action.type === 'PLAYER_JOINED_PARTY') throw new Error('Direct party joins are not permitted online. Use an invitation or join request.');
  if (action.type === 'PARTY_JOIN_REQUESTED') { action.playerId = playerId; return action; }
  if (action.type === 'PARTY_INVITE_SENT') {
    if (!partyLeader(state, playerId, action.partyId)) throw new Error('Only the current party leader may invite a player.');
    return action;
  }
  if (action.type === 'PARTY_MEMBERSHIP_RESPONDED') {
    const request = state.partyMembershipRequests?.[action.requestId];
    if (!request || request.status !== 'pending') throw new Error('That party membership request is no longer pending.');
    const party = state.parties?.[request.partyId];
    if (request.kind === 'invite' && request.playerId !== playerId) throw new Error('Only the invited player may respond to this invitation.');
    if (request.kind === 'join-request' && party?.leaderId !== playerId) throw new Error('Only the party leader may respond to this join request.');
    return action;
  }
  if (action.type === 'PARTY_MEMBER_REMOVED') {
    if (!partyLeader(state, playerId, action.partyId)) throw new Error('Only the current party leader may remove a member.');
    return action;
  }
  if (action.type === 'PARTY_CREATED') { action.leaderId = playerId; return action; }
  if (['PARTY_UPDATED','PARTY_DISSOLVED','PARTY_LEADER_CHANGED'].includes(action.type)) {
    if (!partyLeader(state, playerId, action.partyId)) throw new Error('Only the current party leader may do that.');
    return action;
  }
  if (HOST_ADMIN.has(action.type)) {
    if (!isHostLike(state, playerId)) throw new Error('Only the Constitutional Host or Deputy Host may perform this administrative action online.');
    return action;
  }
  if (action.type === 'HOST_REMOVAL_PROPOSED') return action;
  if (['GOVERNMENT_FORMED','MINISTER_APPOINTED','MINISTER_DISMISSED','GOVERNMENT_SET_CARETAKER','LEGISLATIVE_VOTE_CREATED'].includes(action.type)) {
    if (!pmOrCoalitionLeader(state, playerId) && !isHostLike(state, playerId)) throw new Error('You do not have government authority for that action.');
    return action;
  }
  if (action.type === 'LAW_PROPOSED') return action;
  if (action.type === 'LAW_PROPOSAL_UPDATED') {
    const proposal = state.lawProposals?.[action.proposalId];
    if (!proposal || proposal.proposerId !== playerId) throw new Error('Only the original proposer may edit this law proposal online.');
    return action;
  }
  if (action.type === 'LAW_PROPOSAL_FINALIZED') {
    const proposal = state.lawProposals?.[action.proposalId];
    if (!proposal) throw new Error('Law proposal not found.');
    if (proposal.proposerId !== playerId && !isHostLike(state, playerId)) throw new Error('Only the proposer or Constitutional Host may finalize this law proposal.');
    return action;
  }
  if (action.type === 'LAW_REFERRED_TO_REFERENDUM') {
    if (!isHostLike(state, playerId)) throw new Error('Only the Constitutional Host may administratively create an approved public referral.');
    return action;
  }
  if (action.type === 'CONSTITUTION_AMENDMENT_PROPOSED') return action;
  if (action.type === 'CONSTITUTION_AMENDMENT_UPDATED') {
    const proposal = state.constitution?.proposals?.[action.proposalId];
    if (!proposal || proposal.proposerId !== playerId) throw new Error('Only the original proposer may edit this constitutional amendment online.');
    return action;
  }
  if (action.type === 'CONSTITUTION_AMENDMENT_FINALIZED') {
    const proposal = state.constitution?.proposals?.[action.proposalId];
    if (!proposal) throw new Error('Constitutional amendment not found.');
    if (proposal.proposerId !== playerId && !isHostLike(state, playerId)) throw new Error('Only the proposer or Constitutional Host may finalize this amendment.');
    return action;
  }
  if (action.type === 'CONSTITUTION_BASE_UNLOCK_PROPOSED') {
    if (action.initiatedBy === 'host' && !isHostLike(state, playerId)) throw new Error('Only the Constitutional Host may initiate the Host route for a Base-rule unlock.');
    action.initiatedBy = action.initiatedBy === 'host' ? 'host' : 'petition';
    return action;
  }
  if (action.type.startsWith('COMMITTEE_')) {
    const code = action.committee;
    if (!committeeMember(state, playerId, code)) throw new Error(`You are not a member of ${code}.`);
    return action;
  }
  if (action.type === 'CONSTITUTION_BASE_UNLOCK_AC_VOTE_CREATED') {
    if (!committeeMember(state, playerId, 'AC')) throw new Error('Only an AC member may begin the AC vote.');
    return action;
  }
  if (action.type === 'CASE_OPENED') { action.complainantId = playerId; return action; }
  if (action.type === 'CASE_RESPONSE_SUBMITTED') {
    const c = state.cases?.[action.caseId]; if (!c || c.accusedId !== playerId) throw new Error('Only the accused player may submit this response.'); return action;
  }
  if (action.type === 'CASE_PAC_VOTE_CREATED') {
    const c = state.cases?.[action.caseId]; if (!c?.pacPanel?.includes(playerId) && !isHostLike(state,playerId)) throw new Error('Only the PAC panel or Host may begin this vote.'); return action;
  }
  if (action.type === 'CASE_JURY_VOTE_CREATED') {
    const c = state.cases?.[action.caseId]; if (!c?.jury?.includes(playerId) && !isHostLike(state,playerId)) throw new Error('Only the jury or Host may begin this vote.'); return action;
  }
  if (action.type === 'CASE_PPC_PUNISHMENT_RECORDED') {
    if (!committeeMember(state,playerId,'PPC')) throw new Error('Only a PPC member may record punishment.'); return action;
  }
  throw new Error(`Online permission rule not yet defined for ${action.type}.`);
}
