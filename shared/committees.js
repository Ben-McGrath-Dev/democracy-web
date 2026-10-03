export const COMMITTEE_CODES = ['AC','PC','PAC','PPC'];

export function committeeSizeForPlayers(activePlayers) {
  if (activePlayers >= 100) return 9;
  if (activePlayers >= 60) return 7;
  if (activePlayers >= 40) return 5;
  return 3;
}

export function defaultCommitteeState(code) {
  return { code, members: [], alternates: [], chairId: null, termStartedAt: null, termEndsAt: null, matters: [], decisions: [] };
}

export function decisionMemberIds(committee, recusedIds = []) {
  const blocked = new Set(recusedIds);
  return (committee?.members ?? []).filter(id => !blocked.has(id));
}

export function ordinaryMajority(count) {
  return Math.floor(count / 2) + 1;
}

export function twoThirds(count) {
  return Math.ceil((count * 2) / 3);
}

export function committeeElectionWinners(vote, seatCount) {
  const ranking = vote?.result?.ranking ?? [];
  return ranking.slice(0, seatCount).map(x => x.optionId ?? x.id ?? x.entityId).filter(Boolean);
}
