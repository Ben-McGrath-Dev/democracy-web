export function majorityThreshold(filledSeats) {
  return Math.floor(Math.max(0, Number(filledSeats) || 0) / 2) + 1;
}

export function filledLegislativeSeats(state) {
  return (state.legislature?.seats ?? []).filter(seat => seat.status === 'filled' && seat.memberId);
}

export function legislativeMemberIds(state) {
  return filledLegislativeSeats(state).map(seat => seat.memberId);
}

export function partySeatCounts(state) {
  const counts = {};
  for (const seat of filledLegislativeSeats(state)) {
    counts[seat.partyId] = (counts[seat.partyId] ?? 0) + 1;
  }
  return counts;
}

export function coalitionSeatCount(state, partyIds) {
  const wanted = new Set(partyIds ?? []);
  return filledLegislativeSeats(state).filter(seat => wanted.has(seat.partyId)).length;
}

export function buildLegislatureFromElection(state, vote) {
  if (!vote?.result || vote.result.kind !== 'proportional') throw new Error('Certified general election has no proportional result.');
  const candidateLists = vote.settings?.candidateLists ?? {};
  const seats = [];
  const allocated = vote.result.seats ?? {};
  const totalSeats = Number(vote.result.seatCount ?? vote.settings?.seatCount ?? 0);
  const assignedPlayers = new Set();

  for (const option of vote.options ?? []) {
    const partyId = option.entityId ?? option.id;
    const numberOfSeats = Number(allocated[option.id] ?? 0);
    const candidates = (candidateLists[option.id] ?? candidateLists[partyId] ?? [])
      .filter(playerId => state.players[playerId] && !assignedPlayers.has(playerId));

    for (let index = 0; index < numberOfSeats; index += 1) {
      const memberId = candidates[index] ?? null;
      if (memberId) assignedPlayers.add(memberId);
      seats.push({
        id: `seat-${seats.length + 1}`,
        number: seats.length + 1,
        partyId,
        memberId,
        status: memberId ? 'filled' : 'vacant',
        filledAt: memberId ? vote.certifiedAt : null,
        vacatedAt: null,
        sourceElectionId: vote.id
      });
    }
  }

  while (seats.length < totalSeats) {
    seats.push({ id: `seat-${seats.length + 1}`, number: seats.length + 1, partyId: null, memberId: null, status: 'vacant', filledAt: null, vacatedAt: null, sourceElectionId: vote.id });
  }

  return { totalSeats, seats, sourceElectionId: vote.id };
}

export function nextEligibleCandidate(state, seat, sourceVote) {
  if (!seat?.partyId || !sourceVote) return null;
  const candidateLists = sourceVote.settings?.candidateLists ?? {};
  const list = candidateLists[seat.partyId] ?? [];
  const occupied = new Set(filledLegislativeSeats(state).map(item => item.memberId));
  return list.find(playerId => {
    const player = state.players[playerId];
    return player && player.status === 'active' && player.partyId === seat.partyId && !occupied.has(playerId);
  }) ?? null;
}
