import { currentNowMs } from './utils.js';
export function nextFormalId(records, prefix) {
  let max = 0;
  for (const key of Object.keys(records ?? {})) {
    const match = String(key).match(new RegExp(`^${prefix}-(\\d+)$`, 'i'));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export function activePlayerCount(state) {
  return Object.values(state.players ?? {}).filter(player => player.status === 'active').length;
}

export function signatureThreshold(state, fraction) {
  return Math.max(1, Math.ceil(activePlayerCount(state) * fraction));
}

export function proposalCanEdit(proposal) {
  return ['draft', 'discussion'].includes(proposal?.status) && !proposal?.textFrozenAt;
}

export function discussionFinished(proposal, now = currentNowMs()) {
  return Boolean(proposal?.discussionEndsAt) && now >= new Date(proposal.discussionEndsAt).getTime();
}

export function referendumWindowExpired(proposal, now = currentNowMs()) {
  return Boolean(proposal?.referendumDeadline) && now >= new Date(proposal.referendumDeadline).getTime();
}

export function proposalStatusLabel(status) {
  const labels = {
    draft: 'Draft', petition: 'Awaiting Signatures', discussion: 'Discussion', frozen: 'Text Frozen', voting: 'Parliament Voting',
    'referendum-window': 'Referendum Window', referendum: 'Referendum', passed: 'Passed',
    rejected: 'Rejected', 'in-force': 'In Force', repealed: 'Repealed', failed: 'Failed'
  };
  return labels[status] ?? status ?? 'Unknown';
}
