export function nextCaseId(cases = {}) {
  let n = 1;
  while (cases[`CASE-${String(n).padStart(3,'0')}`]) n += 1;
  return `CASE-${String(n).padStart(3,'0')}`;
}

export function eligibleJurors(state, caseRecord) {
  const excluded = new Set([
    caseRecord.accusedId,
    caseRecord.complainantId,
    ...(caseRecord.pacPanel ?? []),
    ...(caseRecord.previousJurors ?? []),
    ...(caseRecord.conflictedPlayerIds ?? [])
  ].filter(Boolean));
  return Object.values(state.players)
    .filter(p => p.status === 'active' && !excluded.has(p.id))
    .map(p => p.id);
}

export function deterministicPick(ids, count) {
  return [...ids].sort().slice(0, count);
}

export function juryMajority(count) {
  return Math.floor(count / 2) + 1;
}
