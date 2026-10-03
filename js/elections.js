import { VOTE_TYPES } from './voting.js';

export const ELECTION_KINDS = Object.freeze({
  GENERAL: 'general',
  HOST: 'host',
  DEPUTY_HOST: 'deputy-host',
  COMMITTEE: 'committee'
});

export function legislatureSeatCount(activePlayers) {
  if (activePlayers >= 100) return 20;
  if (activePlayers >= 60) return 15;
  if (activePlayers >= 40) return 10;
  return 7;
}

export function committeeSeatCount(activePlayers) {
  if (activePlayers >= 100) return 9;
  if (activePlayers >= 60) return 7;
  if (activePlayers >= 40) return 5;
  return 3;
}

export function electionDefaults(kind, activeCount, committee = null) {
  if (kind === ELECTION_KINDS.GENERAL) {
    return { title: 'General Election', type: VOTE_TYPES.PROPORTIONAL, secret: true, settings: { seatCount: legislatureSeatCount(activeCount), threshold: 0.1 } };
  }
  if (kind === ELECTION_KINDS.HOST) {
    return { title: 'Host Election', type: VOTE_TYPES.RANKED, secret: true, settings: {} };
  }
  if (kind === ELECTION_KINDS.DEPUTY_HOST) {
    return { title: 'Deputy Host Election', type: VOTE_TYPES.RANKED, secret: true, settings: {} };
  }
  if (kind === ELECTION_KINDS.COMMITTEE) {
    const label = committee ? `${committee} Committee Election` : 'Committee Election';
    const seats = committeeSeatCount(activeCount);
    return { title: label, type: VOTE_TYPES.APPROVAL, secret: true, settings: { seatCount: seats, approvalLimit: seats, committee } };
  }
  throw new Error('Unknown election kind.');
}
