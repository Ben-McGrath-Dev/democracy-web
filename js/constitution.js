import { nextFormalId } from './laws.js';

export function nextAmendmentId(constitution) {
  return nextFormalId(constitution?.proposals ?? {}, 'AMD');
}

export function amendmentThresholds(kind = 'normal') {
  if (kind === 'base-unlock') return { approvalRequirement: 0.75, turnoutRequirement: 0.50 };
  return { approvalRequirement: 0.66, turnoutRequirement: 0.25 };
}

export function amendmentStatusLabel(status) {
  const labels = {
    petition: 'Awaiting Signatures', discussion: 'Discussion', frozen: 'Text Frozen', voting: 'Public Vote',
    approved: 'Approved', rejected: 'Rejected', applied: 'Applied', failed: 'Failed'
  };
  return labels[status] ?? status ?? 'Unknown';
}
