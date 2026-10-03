import { createId, currentNowIso } from './utils.js';

export function createEvent(type, actorId, data = {}) {
  return {
    id: createId('event'),
    type,
    actorId: actorId ?? null,
    timestamp: currentNowIso(),
    data
  };
}

function playerName(state, id) {
  return id ? state.players[id]?.displayName ?? 'Unknown player' : 'A player';
}

function partyName(state, id) {
  return id ? state.parties[id]?.name ?? 'Unknown party' : 'a party';
}

export function describeEvent(event, state) {
  const actor = playerName(state, event.actorId);
  switch (event.type) {
    case 'GAME_CREATED': return `${actor} created ${event.data.gameName}.`;
    case 'GAME_RENAMED': return `${actor} renamed the game to ${event.data.newName}.`;
    case 'PLAYER_ADDED': return `${actor} added ${event.data.playerName} to Democracy.`;
    case 'PLAYER_IDENTITY_BOUND': return `${playerName(state, event.data.playerId)} bound a cryptographic player identity.`;
    case 'PLAYER_RENAMED': return `${event.data.previousName} changed their name to ${event.data.newName}.`;
    case 'PLAYER_STATUS_CHANGED': return `${playerName(state, event.data.playerId)} became ${event.data.newStatus}.`;
    case 'PLAYER_RESIGNED': return `${playerName(state, event.data.playerId)} resigned from Democracy.`;
    case 'PARTY_CREATED': return `${actor} created the ${event.data.partyName}.`;
    case 'PLAYER_JOINED_PARTY': return `${playerName(state, event.data.playerId)} joined ${partyName(state, event.data.partyId)}.`;
    case 'PLAYER_LEFT_PARTY': return `${playerName(state, event.data.playerId)} left ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_INVITE_SENT': return `${actor} invited ${playerName(state, event.data.playerId)} to join ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_JOIN_REQUESTED': return `${playerName(state, event.data.playerId)} requested to join ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_MEMBERSHIP_RESPONDED': return `${event.data.response === 'accepted' ? 'Accepted' : 'Rejected'} ${event.data.kind === 'invite' ? 'party invitation' : 'party join request'} for ${playerName(state, event.data.playerId)} and ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_MEMBER_REMOVED': return `${playerName(state, event.data.playerId)} was removed from ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_LEADER_CHANGED': return `${playerName(state, event.data.newLeaderId)} became leader of ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_UPDATED': return `${actor} updated ${partyName(state, event.data.partyId)}.`;
    case 'PARTY_DISSOLVED': return `${event.data.partyName} was dissolved.`;
    case 'VOTE_CREATED': return `${actor} created ${event.data.title}.`;
    case 'VOTE_OPENED': return `${event.data.title} opened with ${event.data.electorateSize} eligible voters.`;
    case 'BALLOT_CAST': return event.data.secret ? `A secret ballot was submitted.` : `${actor} submitted a ballot.`;
    case 'VOTE_PAUSED': return `${state.votes?.[event.data.voteId]?.title ?? 'Voting'} was paused.`;
    case 'VOTE_RESUMED': return `${state.votes?.[event.data.voteId]?.title ?? 'Voting'} resumed.`;
    case 'VOTE_CLOSED': return `${event.data.title} closed with ${event.data.ballotsCast} ballots cast.`;
    case 'VOTE_CERTIFIED': return `${event.data.title} was certified.`;
    case 'LEGISLATURE_FORMED': return `A ${event.data.totalSeats}-seat Parliament was formed with ${event.data.filledSeats} filled seats.`;
    case 'MP_SEAT_VACATED': return `${playerName(state, event.data.playerId)} left their legislative seat${event.data.replacementId ? `; ${playerName(state, event.data.replacementId)} replaced them` : ''}.`;
    case 'GOVERNMENT_FORMED': return `${playerName(state, event.data.primeMinisterId)} formed a government with ${event.data.coalitionSeats} seats.`;
    case 'GOVERNMENT_LOST_MAJORITY': return `The government lost its legislative majority and became caretaker.`;
    case 'GOVERNMENT_SET_CARETAKER': return `The government entered caretaker status.`;
    case 'MINISTER_APPOINTED': return `${playerName(state, event.data.playerId)} was appointed Minister for ${event.data.portfolio}.`;
    case 'MINISTER_DISMISSED': return `${playerName(state, event.data.playerId)} left the ${event.data.portfolio} ministry.`;
    case 'LEGISLATIVE_VOTE_CREATED': return `${actor} created the parliamentary vote ${event.data.title}.`;
    case 'HOST_ASSUMED_OFFICE': return `${playerName(state, event.data.playerId)} became Constitutional Host.`;
    case 'HOST_REMOVAL_PROPOSED': return `${actor} started a petition to remove the Constitutional Host.`;
    case 'HOST_REMOVAL_SIGNED': return `A Host removal petition signature was recorded.`;
    case 'HOST_REMOVED': return `${playerName(state, event.data.previousHostId)} was removed as Constitutional Host.`;
    case 'HOST_REMOVAL_FAILED': return `The Host removal vote failed.`;
    case 'DEPUTY_HOST_ASSUMED_OFFICE': return `${playerName(state, event.data.playerId)} became Deputy Host.`;
    case 'CONFIDENCE_CONFIRMED': return `The government won a vote of confidence.`;
    case 'CONFIDENCE_LOST': return `The government lost a vote of confidence and became caretaker.`;
    case 'CONSTRUCTIVE_NO_CONFIDENCE_PASSED': return `${playerName(state, event.data.primeMinisterId)} became Prime Minister after a constructive no-confidence vote.`;
    case 'EARLY_ELECTION_REQUIRED': return `The caretaker government formation deadline expired; an early general election is required.`;
    case 'LAW_PROPOSED': return `${actor} published ${event.data.proposalId}: ${event.data.title}.`;
    case 'LAW_PROPOSAL_UPDATED': return `${event.data.proposalId} was updated during discussion.`;
    case 'LAW_PROPOSAL_FROZEN': return `${event.data.proposalId} was frozen for voting.`;
    case 'LAW_PASSED_PARLIAMENT': return `${event.data.proposalId} passed Parliament and entered its referendum window.`;
    case 'LAW_REJECTED_BY_PARLIAMENT': return `${event.data.proposalId} was rejected by Parliament.`;
    case 'LAW_REFERENDUM_PETITION_SIGNED': return `A referendum petition signature was recorded for ${event.data.proposalId}.`;
    case 'CITIZEN_INITIATIVE_SIGNED': return `A citizens' initiative signature was recorded for ${event.data.proposalId}.`;
    case 'LAW_REFERENDUM_CREATED': return `A public referendum was created for ${event.data.proposalId}.`;
    case 'LAW_ENACTED': return `${event.data.lawId} — ${event.data.title} entered into force.`;
    case 'LAW_AMENDED': return `${event.data.lawId} was amended to version ${event.data.version}.`;
    case 'LAW_REPEALED': return `${event.data.lawId} — ${event.data.title} was repealed.`;
    case 'LAW_REFERENDUM_REJECTED': return `${event.data.proposalId} was rejected by referendum.`;
    case 'CONSTITUTION_AMENDMENT_PROPOSED': return `${actor} proposed ${event.data.proposalId} for constitutional Section ${event.data.section}.`;
    case 'CONSTITUTION_AMENDMENT_UPDATED': return `${event.data.proposalId} was updated during discussion.`;
    case 'CONSTITUTION_AMENDMENT_FROZEN': return `${event.data.proposalId} was frozen and sent to a public vote.`;
    case 'CONSTITUTION_AMENDED': return `${event.data.proposalId} amended constitutional Section ${event.data.section}; Constitution v${event.data.version}.`;
    case 'CONSTITUTION_AMENDMENT_REJECTED': return `${event.data.proposalId} was rejected.`;
    case 'BASE_UNLOCK_PROPOSED': return `${actor} proposed ${event.data.proposalId} to make Base Section ${event.data.section} editable.`;
    case 'BASE_UNLOCK_PETITION_SIGNED': return `A signature was recorded for ${event.data.proposalId}.`;
    case 'BASE_UNLOCK_AC_APPROVED': return `The required AC approval was recorded for ${event.data.proposalId}; the public unlock vote was created.`;
    case 'BASE_RULE_MADE_EDITABLE': return `Base Section ${event.data.section} became editable through ${event.data.proposalId}.`;
    case 'BASE_UNLOCK_REJECTED': return `${event.data.proposalId} failed to make Base Section ${event.data.section} editable.`;
    case 'COMMITTEE_SEATED': return `${event.data.committee} was seated after its election.`;
    case 'COMMITTEE_CHAIR_SET': return `${playerName(state, event.data.playerId)} became chair of ${event.data.committee}.`;
    case 'COMMITTEE_MATTER_CREATED': return `${event.data.committee} opened matter ${event.data.title}.`;
    case 'COMMITTEE_MEMBER_RECUSED': return `${playerName(state, event.data.playerId)} was recused from a ${event.data.committee} matter.`;
    case 'COMMITTEE_VOTE_CREATED': return `${event.data.committee} opened a formal committee vote.`;
    case 'COMMITTEE_DECISION': return `${event.data.committee} ${event.data.decision} a committee matter.`;
    case 'BASE_UNLOCK_AC_VOTE_CREATED': return `The AC opened its required vote on ${event.data.proposalId}.`;
    case 'CASE_OPENED': return `${event.data.caseId} was opened against ${playerName(state, event.data.accusedId)}.`;
    case 'CASE_RESPONSE_SUBMITTED': return `The accused response was recorded in ${event.data.caseId}.`;
    case 'CASE_PAC_PANEL_ASSIGNED': return `A PAC panel was assigned to ${event.data.caseId}.`;
    case 'CASE_PAC_VOTE_CREATED': return `PAC voting began for ${event.data.caseId}.`;
    case 'CASE_PAC_DECIDED': return `PAC found ${event.data.finding} in ${event.data.caseId}.`;
    case 'CASE_JURY_SELECTED': return `A jury was selected for ${event.data.caseId}.`;
    case 'CASE_JURY_VOTE_CREATED': return `Jury review began for ${event.data.caseId}.`;
    case 'CASE_JURY_DECIDED': return `The jury ${event.data.result} the PAC finding in ${event.data.caseId}.`;
    case 'CASE_PUNISHMENT_RECORDED': return `PPC punishment was recorded in ${event.data.caseId}.`;
    default: return event.type.replaceAll('_', ' ').toLowerCase();
  }
}
