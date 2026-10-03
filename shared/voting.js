export const VOTE_TYPES = Object.freeze({
  YES_NO: 'yes-no',
  YES_NO_ABSTAIN: 'yes-no-abstain',
  SINGLE: 'single-choice',
  RANKED: 'ranked-choice',
  APPROVAL: 'approval',
  PROPORTIONAL: 'proportional'
});

export function activeElectorate(state) {
  return Object.values(state.players)
    .filter(player => player.status === 'active')
    .map(player => player.id)
    .sort();
}

export function validateBallot(vote, ballot) {
  const optionIds = new Set((vote.options ?? []).map(option => option.id));
  switch (vote.type) {
    case VOTE_TYPES.YES_NO:
      if (!['yes', 'no'].includes(ballot)) throw new Error('Ballot must be Yes or No.');
      break;
    case VOTE_TYPES.YES_NO_ABSTAIN:
      if (!['yes', 'no', 'abstain'].includes(ballot)) throw new Error('Ballot must be Yes, No or Abstain.');
      break;
    case VOTE_TYPES.SINGLE:
    case VOTE_TYPES.PROPORTIONAL:
      if (!optionIds.has(ballot)) throw new Error('Ballot contains an invalid option.');
      break;
    case VOTE_TYPES.RANKED: {
      if (!Array.isArray(ballot) || ballot.length === 0) throw new Error('Rank at least one candidate.');
      if (new Set(ballot).size !== ballot.length) throw new Error('A ranked ballot cannot repeat a candidate.');
      if (ballot.some(id => !optionIds.has(id))) throw new Error('Ranked ballot contains an invalid candidate.');
      break;
    }
    case VOTE_TYPES.APPROVAL: {
      if (!Array.isArray(ballot)) throw new Error('Approval ballot must be a list.');
      if (new Set(ballot).size !== ballot.length) throw new Error('Approval ballot cannot repeat a candidate.');
      if (ballot.some(id => !optionIds.has(id))) throw new Error('Approval ballot contains an invalid candidate.');
      const limit = vote.settings?.approvalLimit ?? vote.settings?.seatCount ?? vote.options.length;
      if (ballot.length > limit) throw new Error(`You may approve at most ${limit} candidate${limit === 1 ? '' : 's'}.`);
      break;
    }
    default:
      throw new Error(`Unsupported vote type: ${vote.type}`);
  }
  return true;
}

function ballotValues(vote) {
  if (vote.secretBallotMode === 'sealed-v1') return vote.revealedChoices ?? [];
  return Object.values(vote.ballots ?? {}).map(record => record.choice);
}

function turnout(vote) {
  const electorate = vote.electorateSnapshot?.length ?? 0;
  const cast = vote.secretBallotMode === 'sealed-v1'
    ? Object.keys(vote.submittedVoters ?? {}).length
    : Object.keys(vote.ballots ?? {}).length;
  return { electorate, cast, rate: electorate ? cast / electorate : 0 };
}

function yesNoResult(vote) {
  const counts = { yes: 0, no: 0, abstain: 0 };
  for (const choice of ballotValues(vote)) counts[choice] = (counts[choice] ?? 0) + 1;
  const decisive = counts.yes + counts.no;
  const approvalRate = decisive ? counts.yes / decisive : 0;
  const requiredApproval = vote.settings?.approvalRequirement ?? 0.5;
  const minimumTurnout = vote.settings?.turnoutRequirement ?? 0;
  const t = turnout(vote);
  let passed = approvalRate > requiredApproval || (vote.settings?.inclusiveApproval && approvalRate >= requiredApproval);
  let requiredYes = null;
  if (vote.settings?.legislativeMajority) {
    requiredYes = Math.floor(t.electorate / 2) + 1;
    passed = counts.yes >= requiredYes;
  }
  if (Number.isInteger(vote.settings?.fixedYesRequired)) {
    requiredYes = vote.settings.fixedYesRequired;
    passed = counts.yes >= requiredYes;
  }
  return {
    kind: 'yes-no', counts, decisive, approvalRate, requiredApproval, requiredYes,
    turnout: t, turnoutMet: t.rate >= minimumTurnout,
    passed: passed && t.rate >= minimumTurnout
  };
}

export function countRankedChoice(options, ballots) {
  let active = options.map(o => o.id);
  const rounds = [];
  let winnerId = null;
  let tie = null;

  while (active.length > 0) {
    const counts = Object.fromEntries(active.map(id => [id, 0]));
    let activeBallots = 0;
    for (const ballot of ballots) {
      const preference = ballot.find(id => active.includes(id));
      if (preference) { counts[preference] += 1; activeBallots += 1; }
    }
    rounds.push({ number: rounds.length + 1, counts: { ...counts }, activeBallots, activeCandidates: [...active] });
    const majority = activeBallots / 2;
    const found = active.find(id => counts[id] > majority);
    if (found) { winnerId = found; break; }
    if (active.length === 1) { winnerId = active[0]; break; }

    const min = Math.min(...active.map(id => counts[id]));
    const lowest = active.filter(id => counts[id] === min);
    if (lowest.length === active.length || (lowest.length > 1 && active.length - lowest.length < 1)) {
      tie = lowest;
      break;
    }
    if (lowest.length > 1) {
      tie = lowest;
      break;
    }
    active = active.filter(id => id !== lowest[0]);
  }

  return { winnerId, rounds, tie };
}

export function largestRemainderAllocation(options, ballots, seatCount, threshold = 0.1) {
  const rawCounts = Object.fromEntries(options.map(o => [o.id, 0]));
  for (const id of ballots) if (id in rawCounts) rawCounts[id] += 1;
  const total = ballots.length;
  const qualifying = options.filter(o => total > 0 && rawCounts[o.id] / total >= threshold);
  const qualifyingVotes = qualifying.reduce((sum, o) => sum + rawCounts[o.id], 0);
  const seats = Object.fromEntries(options.map(o => [o.id, 0]));
  const quotas = {};
  const remainders = {};

  if (!qualifying.length || qualifyingVotes === 0 || seatCount <= 0) {
    return { rawCounts, qualifyingIds: [], seats, quotas, remainders, seatCount, threshold, unallocated: seatCount };
  }
  if (qualifying.length === 1) {
    seats[qualifying[0].id] = seatCount;
    return { rawCounts, qualifyingIds: [qualifying[0].id], seats, quotas, remainders, seatCount, threshold, unallocated: 0 };
  }

  let allocated = 0;
  for (const option of qualifying) {
    const quota = rawCounts[option.id] / qualifyingVotes * seatCount;
    quotas[option.id] = quota;
    seats[option.id] = Math.floor(quota);
    remainders[option.id] = quota - Math.floor(quota);
    allocated += seats[option.id];
  }

  const order = [...qualifying].sort((a, b) => {
    const remainderDiff = remainders[b.id] - remainders[a.id];
    if (Math.abs(remainderDiff) > 1e-12) return remainderDiff;
    const voteDiff = rawCounts[b.id] - rawCounts[a.id];
    if (voteDiff !== 0) return voteDiff;
    return a.id.localeCompare(b.id);
  });

  let index = 0;
  while (allocated < seatCount && order.length) {
    seats[order[index % order.length].id] += 1;
    allocated += 1;
    index += 1;
  }

  return { rawCounts, qualifyingIds: qualifying.map(o => o.id), seats, quotas, remainders, seatCount, threshold, unallocated: seatCount - allocated };
}

function approvalResult(vote) {
  const counts = Object.fromEntries(vote.options.map(o => [o.id, 0]));
  for (const choices of ballotValues(vote)) for (const id of choices) if (id in counts) counts[id] += 1;
  const seatCount = vote.settings?.seatCount ?? 1;
  const ordered = [...vote.options].sort((a, b) => counts[b.id] - counts[a.id] || a.label.localeCompare(b.label));
  const cutoff = ordered[seatCount - 1] ? counts[ordered[seatCount - 1].id] : -1;
  const certain = ordered.filter((o, index) => index < seatCount && counts[o.id] > cutoff).map(o => o.id);
  const tiedAtCutoff = ordered.filter(o => counts[o.id] === cutoff).map(o => o.id);
  const remainingSeats = Math.max(0, seatCount - certain.length);
  const tie = tiedAtCutoff.length > remainingSeats ? tiedAtCutoff : null;
  const winners = tie ? certain : ordered.slice(0, seatCount).map(o => o.id);
  return { kind: 'approval', counts, winners, tie, seatCount, turnout: turnout(vote) };
}

export function tallyVote(vote) {
  if (!vote) throw new Error('Vote not found.');
  switch (vote.type) {
    case VOTE_TYPES.YES_NO:
    case VOTE_TYPES.YES_NO_ABSTAIN:
      return yesNoResult(vote);
    case VOTE_TYPES.SINGLE: {
      const counts = Object.fromEntries(vote.options.map(o => [o.id, 0]));
      for (const id of ballotValues(vote)) if (id in counts) counts[id] += 1;
      const max = Math.max(0, ...Object.values(counts));
      const leaders = Object.keys(counts).filter(id => counts[id] === max);
      return { kind: 'single-choice', counts, winnerId: leaders.length === 1 ? leaders[0] : null, tie: leaders.length > 1 ? leaders : null, turnout: turnout(vote) };
    }
    case VOTE_TYPES.RANKED: {
      const counted = countRankedChoice(vote.options, ballotValues(vote));
      return { kind: 'ranked-choice', ...counted, turnout: turnout(vote) };
    }
    case VOTE_TYPES.APPROVAL:
      return approvalResult(vote);
    case VOTE_TYPES.PROPORTIONAL: {
      const allocation = largestRemainderAllocation(vote.options, ballotValues(vote), vote.settings?.seatCount ?? 0, vote.settings?.threshold ?? 0.1);
      return { kind: 'proportional', ...allocation, turnout: turnout(vote) };
    }
    default:
      throw new Error(`Unsupported vote type: ${vote.type}`);
  }
}

export function secondsRemaining(vote, now = Date.now()) {
  if (!vote?.closesAt) return null;
  return Math.max(0, Math.ceil((new Date(vote.closesAt).getTime() - now) / 1000));
}
