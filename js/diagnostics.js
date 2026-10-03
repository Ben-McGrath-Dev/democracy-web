import { filledLegislativeSeats, majorityThreshold } from './legislature.js';
import { COMMITTEE_CODES } from './committees.js';

function issue(level, code, message) {
  return { level, code, message };
}

export function auditState(state) {
  const issues = [];
  if (!state || typeof state !== 'object') return { ok: false, errors: 1, warnings: 0, issues: [issue('error', 'NO_STATE', 'No game state is loaded.')] };

  const players = state.players ?? {};
  const parties = state.parties ?? {};
  const votes = state.votes ?? {};

  if (!state.meta?.id) issues.push(issue('error', 'META_ID', 'Game metadata is missing an ID.'));
  if (!state.meta?.name) issues.push(issue('error', 'META_NAME', 'Game metadata is missing a name.'));
  if (!Number.isInteger(state.stateVersion) || state.stateVersion < 1) issues.push(issue('error', 'STATE_VERSION', 'State version must be a positive integer.'));

  for (const [id, player] of Object.entries(players)) {
    if (player.id !== id) issues.push(issue('error', 'PLAYER_ID', `Player map key ${id} does not match the player's ID.`));
    if (!player.displayName?.trim()) issues.push(issue('error', 'PLAYER_NAME', `Player ${id} has no display name.`));
    if (player.partyId && !parties[player.partyId]) issues.push(issue('error', 'PLAYER_PARTY_REF', `${player.displayName || id} references a missing party.`));
    if (player.partyId && parties[player.partyId] && !parties[player.partyId].members?.includes(id)) issues.push(issue('error', 'PARTY_MEMBERSHIP_MISMATCH', `${player.displayName || id} points to a party that does not list them as a member.`));
  }

  for (const [id, party] of Object.entries(parties)) {
    if (party.id !== id) issues.push(issue('error', 'PARTY_ID', `Party map key ${id} does not match the party ID.`));
    const uniqueMembers = new Set(party.members ?? []);
    if (uniqueMembers.size !== (party.members ?? []).length) issues.push(issue('error', 'PARTY_DUPLICATE_MEMBER', `${party.name || id} contains duplicate members.`));
    for (const memberId of uniqueMembers) {
      if (!players[memberId]) issues.push(issue('error', 'PARTY_MEMBER_REF', `${party.name || id} references a missing player.`));
      else if (players[memberId].partyId !== id) issues.push(issue('error', 'PARTY_PLAYER_MISMATCH', `${party.name || id} lists ${players[memberId].displayName} but that player points elsewhere.`));
    }
    if (party.leaderId && !uniqueMembers.has(party.leaderId)) issues.push(issue('error', 'PARTY_LEADER', `${party.name || id}'s leader is not a current member.`));
  }

  const seenMPs = new Set();
  const seats = state.legislature?.seats ?? [];
  if ((state.legislature?.totalSeats ?? 0) < seats.length) issues.push(issue('error', 'LEGISLATURE_SIZE', 'The legislature contains more seat records than its configured size.'));
  for (const seat of seats) {
    if (seat.status === 'filled') {
      if (!seat.memberId || !players[seat.memberId]) issues.push(issue('error', 'MP_REF', `Filled seat ${seat.id ?? '?'} has no valid member.`));
      if (seat.memberId && seenMPs.has(seat.memberId)) issues.push(issue('error', 'DUPLICATE_MP', `${players[seat.memberId]?.displayName ?? seat.memberId} occupies more than one seat.`));
      if (seat.memberId) seenMPs.add(seat.memberId);
      if (seat.partyId && !parties[seat.partyId]) issues.push(issue('error', 'SEAT_PARTY_REF', `Seat ${seat.id ?? '?'} references a missing party.`));
    }
  }

  const government = state.government ?? {};
  if (government.primeMinisterId && !players[government.primeMinisterId]) issues.push(issue('error', 'PM_REF', 'The Prime Minister references a missing player.'));
  for (const partyId of government.coalitionPartyIds ?? []) if (!parties[partyId]) issues.push(issue('error', 'GOV_PARTY_REF', 'The government coalition references a missing party.'));
  if (government.status === 'active' && seats.length) {
    const coalition = new Set(government.coalitionPartyIds ?? []);
    const coalitionSeats = filledLegislativeSeats(state).filter(seat => coalition.has(seat.partyId)).length;
    const required = majorityThreshold(state);
    if (coalitionSeats < required) issues.push(issue('warning', 'GOV_MAJORITY', `Government is marked active with ${coalitionSeats} seats but ${required} are required for a majority.`));
  }

  const committeeMembership = new Map();
  for (const code of COMMITTEE_CODES) {
    const committee = state.committees?.[code];
    if (!committee) {
      issues.push(issue('error', 'COMMITTEE_MISSING', `${code} committee state is missing.`));
      continue;
    }
    const members = committee.members ?? [];
    if (new Set(members).size !== members.length) issues.push(issue('error', 'COMMITTEE_DUPLICATE', `${code} contains duplicate seated members.`));
    for (const memberId of members) {
      if (!players[memberId]) issues.push(issue('error', 'COMMITTEE_MEMBER_REF', `${code} references a missing member.`));
      const previous = committeeMembership.get(memberId);
      if (previous && previous !== code) issues.push(issue('warning', 'MULTIPLE_COMMITTEES', `${players[memberId]?.displayName ?? memberId} is seated on both ${previous} and ${code}.`));
      else committeeMembership.set(memberId, code);
    }
    if (committee.chairId && !members.includes(committee.chairId)) issues.push(issue('error', 'COMMITTEE_CHAIR', `${code}'s chair is not a seated member.`));
  }

  for (const [voteId, vote] of Object.entries(votes)) {
    if (vote.id !== voteId) issues.push(issue('error', 'VOTE_ID', `Vote map key ${voteId} does not match the vote ID.`));
    const electorate = new Set(vote.electorateSnapshot ?? []);
    const submittedIds = vote.secretBallotMode === 'sealed-v1' ? Object.keys(vote.submittedVoters ?? {}) : Object.keys(vote.ballots ?? {});
    for (const voterId of submittedIds) {
      if (!players[voterId]) issues.push(issue('error', 'BALLOT_PLAYER_REF', `${vote.title || voteId} contains a ballot from a missing player.`));
      if (vote.status !== 'draft' && vote.opensAt && !electorate.has(voterId)) issues.push(issue('error', 'BALLOT_ELECTORATE', `${vote.title || voteId} contains a ballot from outside its electorate snapshot.`));
    }
    if (vote.secretBallotMode === 'sealed-v1' && (vote.sealedBallots ?? []).length !== submittedIds.length) issues.push(issue('error','SEALED_BALLOT_COUNT',`${vote.title || voteId} has a sealed-ballot count mismatch.`));
  }

  for (const [caseId, caseRecord] of Object.entries(state.cases ?? {})) {
    if (!players[caseRecord.accusedId]) issues.push(issue('error', 'CASE_ACCUSED', `${caseId} references a missing accused player.`));
    if (!players[caseRecord.complainantId]) issues.push(issue('error', 'CASE_COMPLAINANT', `${caseId} references a missing complainant.`));
    if (!state.laws?.[caseRecord.lawId]) issues.push(issue('error', 'CASE_LAW', `${caseId} references a missing law.`));
    if ((caseRecord.pacPanel ?? []).includes(caseRecord.accusedId) || (caseRecord.pacPanel ?? []).includes(caseRecord.complainantId)) issues.push(issue('error', 'PAC_CONFLICT', `${caseId}'s PAC panel contains the accused or complainant.`));
    if ((caseRecord.jury ?? []).includes(caseRecord.accusedId) || (caseRecord.jury ?? []).includes(caseRecord.complainantId)) issues.push(issue('error', 'JURY_CONFLICT', `${caseId}'s jury contains the accused or complainant.`));
  }

  if (!Array.isArray(state.history)) issues.push(issue('error', 'HISTORY', 'Official history is not an array.'));
  if (!state.constitution?.sections || typeof state.constitution.sections !== 'object') issues.push(issue('error', 'CONSTITUTION_SECTIONS', 'The save-specific Constitution is missing its section map.'));

  const errors = issues.filter(item => item.level === 'error').length;
  const warnings = issues.filter(item => item.level === 'warning').length;
  return { ok: errors === 0, errors, warnings, issues };
}

export function offlineReadiness(state) {
  if (!state) return [];
  const activePlayers = Object.values(state.players ?? {}).filter(p => p.status === 'active').length;
  const activeParties = Object.values(state.parties ?? {}).filter(p => p.status === 'active').length;
  const committees = Object.values(state.committees ?? {});
  return [
    { label: 'At least 25 active players', pass: activePlayers >= 25, detail: `${activePlayers} active` },
    { label: 'At least two active political parties', pass: activeParties >= 2, detail: `${activeParties} active` },
    { label: 'Voting engine has created a vote', pass: Object.keys(state.votes ?? {}).length > 0, detail: `${Object.keys(state.votes ?? {}).length} vote(s)` },
    { label: 'A certified election exists', pass: Object.values(state.elections ?? {}).some(e => e.status === 'certified'), detail: 'Needed to prove election lifecycle' },
    { label: 'Legislature has been formed', pass: (state.legislature?.totalSeats ?? 0) > 0, detail: `${state.legislature?.totalSeats ?? 0} seats configured` },
    { label: 'Government has been formed', pass: ['active', 'caretaker'].includes(state.government?.status), detail: state.government?.status ?? 'not formed' },
    { label: 'Starting laws exist', pass: Object.keys(state.laws ?? {}).length >= 5, detail: `${Object.keys(state.laws ?? {}).length} law(s)` },
    { label: 'Save-specific Constitution exists', pass: Object.keys(state.constitution?.sections ?? {}).length > 0, detail: `v${state.constitution?.version ?? 1}` },
    { label: 'All four committees are seated', pass: committees.length >= 4 && committees.every(c => (c.members ?? []).length >= 3), detail: `${committees.filter(c => (c.members ?? []).length >= 3).length}/4 seated` },
    { label: 'Case system has been exercised', pass: Object.keys(state.cases ?? {}).length > 0, detail: `${Object.keys(state.cases ?? {}).length} case(s)` },
    { label: 'Official history is recording actions', pass: (state.history ?? []).length >= 10, detail: `${state.history?.length ?? 0} events` }
  ];
}
