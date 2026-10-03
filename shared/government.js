import { coalitionSeatCount, filledLegislativeSeats, majorityThreshold } from './legislature.js';

export function governmentMajorityStatus(state, partyIds = state.government?.coalitionPartyIds ?? []) {
  const filled = filledLegislativeSeats(state).length;
  const seats = coalitionSeatCount(state, partyIds);
  const required = majorityThreshold(filled);
  return { filledSeats: filled, coalitionSeats: seats, required, hasMajority: filled > 0 && seats >= required };
}

export function validateGovernmentFormation(state, partyIds, primeMinisterId) {
  const uniquePartyIds = [...new Set(partyIds ?? [])];
  if (!uniquePartyIds.length) throw new Error('Select at least one governing party.');
  for (const partyId of uniquePartyIds) {
    const party = state.parties[partyId];
    if (!party || party.status !== 'active') throw new Error('Every coalition party must be an active political party.');
  }
  const pm = state.players[primeMinisterId];
  if (!pm || pm.status !== 'active') throw new Error('Prime Minister must be an active player.');
  const majority = governmentMajorityStatus(state, uniquePartyIds);
  if (!majority.hasMajority) throw new Error(`Coalition controls ${majority.coalitionSeats}/${majority.filledSeats} filled seats; ${majority.required} are required for a majority.`);
  return { partyIds: uniquePartyIds, primeMinisterId, majority };
}
