import { DEFAULT_CONSTITUTION_PRESET, SCHEMA_VERSION } from './config.js';
import { createEvent } from './events.js';
import { createId, deepClone, currentNowMs, currentNowIso, withDeterministicContext } from './utils.js';
import { activeElectorate, tallyVote, validateBallot } from './voting.js';
import { buildLegislatureFromElection, filledLegislativeSeats, legislativeMemberIds, majorityThreshold, nextEligibleCandidate } from './legislature.js';
import { governmentMajorityStatus, validateGovernmentFormation } from './government.js';
import { activePlayerCount, discussionFinished, nextFormalId, referendumWindowExpired, signatureThreshold } from './laws.js';
import { amendmentThresholds, nextAmendmentId } from './constitution.js';
import { createStartingLaws } from './starting-laws.js';
import { createStartingConstitutionSections } from './starting-constitution.js';
import { COMMITTEE_CODES, defaultCommitteeState, committeeSizeForPlayers, ordinaryMajority, twoThirds } from './committees.js';
import { nextCaseId, eligibleJurors, deterministicPick } from './cases.js';
import { chainEvent, ensureEventChain, verifyEventChain } from './integrity.js';

let currentState = null;
const subscribers = new Set();
let suppressPublish = 0;

function normalizeStateShape(state) {
  state.votes ??= {};
  for (const vote of Object.values(state.votes)) {
    vote.ballots ??= {};
    vote.sealedBallots ??= [];
    vote.submittedVoters ??= {};
    vote.secretBallotMode ??= null;
    vote.secretBoxPublicKey ??= null;
    vote.secretBoxHolderPlayerId ??= null;
    vote.revealedChoices ??= null;
    vote.revealedPrivateKey ??= null;
  }
  state.elections ??= {};
  state.legislature ??= { totalSeats: 0, seats: [], termStartedAt: null, termEndsAt: null, sourceElectionId: null };
  state.legislature.sourceElectionId ??= null;
  state.government ??= { status: 'not-formed', primeMinisterId: null, coalitionPartyIds: [], ministers: [], formedAt: null, caretakerSince: null, caretakerDeadline: null, earlyElectionRequired: false };
  state.government.formedAt ??= null;
  state.government.caretakerSince ??= null;
  state.government.caretakerDeadline ??= null;
  state.government.earlyElectionRequired ??= false;
  state.lawProposals ??= {};
  state.partyMembershipRequests ??= {};
  state.laws ??= {};
  state.constitution ??= { presetId: DEFAULT_CONSTITUTION_PRESET, version: 1, amendments: [], proposals: [], sectionOverrides: {}, sections: createStartingConstitutionSections() };
  state.constitution.amendments ??= [];
  state.constitution.proposals ??= {};
  state.constitution.sectionOverrides ??= {};
  state.constitution.sections ??= createStartingConstitutionSections();
  state.constitution.unlockProposals ??= {};
  state.constitution.editableOverrides ??= {};
  state.committees ??= {};
  for (const code of COMMITTEE_CODES) state.committees[code] ??= defaultCommitteeState(code);
  state.cases ??= {};
  state.hostRemoval ??= null;
  state.network ??= { authorityEpoch: 0, ownerPlayerId: null, backupOwnerPlayerId: null, reconnectTokens: {}, recentTransitions: [] };
  state.network.authorityEpoch ??= 0;
  state.network.ownerPlayerId ??= null;
  state.network.backupOwnerPlayerId ??= null;
  state.network.reconnectTokens ??= {};
  state.network.recentTransitions ??= [];
  state.history ??= [];
  ensureEventChain(state.history);
  state.integrity ??= {};
  state.integrity.eventChain = verifyEventChain(state.history);
  return state;
}

export function getState() {
  return currentState ? deepClone(currentState) : null;
}

export function hasGame() {
  return currentState !== null;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function publish() {
  if (suppressPublish > 0) return;
  const snapshot = getState();
  for (const fn of subscribers) fn(snapshot);
}

function nowIso() {
  return currentNowIso();
}

function touch(state) {
  state.stateVersion += 1;
  state.meta.updatedAt = nowIso();
}

function addEvent(state, event) {
  if (state.history.length && state.history.some(item => item.hash)) {
    const existing = verifyEventChain(state.history);
    if (!existing.ok) throw new Error(`Official history integrity failure at event ${existing.index + 1}; refusing to append new history.`);
  }
  const previous = state.history.at(-1) ?? null;
  const chained = chainEvent(event, previous, state.history.length + 1);
  state.history.push(chained);
  state.integrity ??= {};
  state.integrity.eventChain = { ok: true, count: state.history.length, headHash: chained.hash };
}

function requirePlayer(state, playerId) {
  const player = state.players[playerId];
  if (!player) throw new Error('Player not found.');
  return player;
}

function requireParty(state, partyId) {
  const party = state.parties[partyId];
  if (!party) throw new Error('Party not found.');
  return party;
}

function ensureActivePlayer(player) {
  if (player.status !== 'active') throw new Error('This action requires an active player.');
}

function cleanPartyColour(value, fallback = '#475569') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) throw new Error('Party colour must be a six-digit hex colour such as #475569.');
  return text.toLowerCase();
}

function removeMember(party, playerId) {
  party.members = party.members.filter(id => id !== playerId);
}

function closeOpenPartyHistory(player, partyId, reason) {
  const entry = [...(player.partyHistory ?? [])].reverse().find(item => item.partyId === partyId && !item.leftAt);
  if (entry) {
    entry.leftAt = nowIso();
    entry.leaveReason = reason;
  }
}

function nextPartyLeader(state, party) {
  return party.members.find(id => state.players[id]?.status === 'active') ?? null;
}

function pendingPartyMembership(state, { playerId = null, partyId = null, kind = null } = {}) {
  return Object.values(state.partyMembershipRequests ?? {}).find(request =>
    request.status === 'pending' &&
    (!playerId || request.playerId === playerId) &&
    (!partyId || request.partyId === partyId) &&
    (!kind || request.kind === kind)
  ) ?? null;
}

function joinIndependentPlayerToParty(state, player, party, actorId, reason = 'accepted') {
  ensureActivePlayer(player);
  if (party.status !== 'active') throw new Error('That party is not active.');
  if (player.partyId) throw new Error('Leave your current party before joining another one.');
  const now = nowIso();
  player.partyId = party.id;
  if (!party.members.includes(player.id)) party.members.push(player.id);
  player.partyHistory.push({ partyId: party.id, joinedAt: now, leftAt: null, reason });
  addEvent(state, createEvent('PLAYER_JOINED_PARTY', actorId ?? player.id, { playerId: player.id, partyId: party.id, previousPartyId: null }));
}

function recalculateGovernmentMajority(state, actorId = null) {
  const majority = governmentMajorityStatus(state);
  if (state.government.status === 'active' && !majority.hasMajority) {
    state.government.status = 'caretaker';
    state.government.caretakerSince = nowIso();
    state.government.caretakerDeadline = new Date(currentNowMs() + 72 * 3600000).toISOString();
    state.government.earlyElectionRequired = false;
    addEvent(state, createEvent('GOVERNMENT_LOST_MAJORITY', actorId, { coalitionSeats: majority.coalitionSeats, required: majority.required }));
  }
  return majority;
}

function vacateLegislativeSeatForPlayer(state, playerId, actorId = null, reason = 'vacated') {
  const seat = state.legislature?.seats?.find(item => item.memberId === playerId && item.status === 'filled');
  if (!seat) return null;
  const player = state.players[playerId];
  if (player) player.offices = (player.offices ?? []).filter(office => office !== 'MP');
  seat.memberId = null;
  seat.status = 'vacant';
  seat.vacatedAt = nowIso();
  const sourceVote = state.votes[state.legislature.sourceElectionId];
  const replacementId = nextEligibleCandidate(state, seat, sourceVote);
  if (replacementId) {
    seat.memberId = replacementId;
    seat.status = 'filled';
    seat.filledAt = nowIso();
    seat.vacatedAt = null;
    const replacement = state.players[replacementId];
    if (!replacement.offices.includes('MP')) replacement.offices.push('MP');
  }
  addEvent(state, createEvent('MP_SEAT_VACATED', actorId ?? playerId, { playerId, seatId: seat.id, replacementId, reason }));
  recalculateGovernmentMajority(state, actorId ?? playerId);
  return { seatId: seat.id, replacementId };
}

export function createGame({ gameName, creatorName, description = '', constitutionPreset = DEFAULT_CONSTITUTION_PRESET }) {
  const now = nowIso();
  const creatorId = createId('player');
  const gameId = createId('game');

  currentState = {
    schemaVersion: SCHEMA_VERSION,
    stateVersion: 1,
    meta: {
      id: gameId,
      name: gameName.trim(),
      description: description.trim(),
      constitutionPreset,
      createdAt: now,
      updatedAt: now
    },
    players: {
      [creatorId]: {
        id: creatorId,
        displayName: creatorName.trim(),
        joinedAt: now,
        status: 'active',
        partyId: null,
        roles: ['creator'],
        offices: [],
        officeHistory: [],
        partyHistory: [],
        lastActiveAt: now,
        identityFingerprint: null,
        identityPublicKey: null
      }
    },
    parties: {},
    elections: {},
    votes: {},
    legislature: {
      totalSeats: 0,
      seats: [],
      termStartedAt: null,
      termEndsAt: null,
      sourceElectionId: null
    },
    government: {
      status: 'not-formed',
      primeMinisterId: null,
      coalitionPartyIds: [],
      ministers: [],
      formedAt: null,
      caretakerSince: null,
      caretakerDeadline: null,
      earlyElectionRequired: false
    },
    laws: createStartingLaws(now),
    lawProposals: {},
    partyMembershipRequests: {},
    constitution: {
      presetId: constitutionPreset,
      version: 1,
      amendments: [],
      proposals: {},
      sectionOverrides: {},
      unlockProposals: {},
      editableOverrides: {},
      sections: createStartingConstitutionSections()
    },
    committees: Object.fromEntries(COMMITTEE_CODES.map(code => [code, defaultCommitteeState(code)])),
    cases: {},
    hostRemoval: null,
    network: { authorityEpoch: 0, ownerPlayerId: creatorId, backupOwnerPlayerId: null, reconnectTokens: {}, recentTransitions: [] },
    integrity: { eventChain: { ok: true, count: 0, headHash: null } },
    history: []
  };

  addEvent(currentState, createEvent('GAME_CREATED', creatorId, { gameName: currentState.meta.name }));
  publish();
  return getState();
}

export function loadState(state) {
  currentState = normalizeStateShape(deepClone(state));
  publish();
  return getState();
}

export function updateTechnicalNetworkState(patch = {}) {
  if (!currentState) throw new Error('No game is currently loaded.');
  const state = deepClone(currentState);
  normalizeStateShape(state);
  state.network = { ...state.network, ...deepClone(patch) };
  state.meta.updatedAt = nowIso();
  currentState = state;
  publish();
  return getState();
}



function actorCanSponsorGovernmentProposal(state, actorId) {
  if (!actorId) return false;
  const player = state.players[actorId];
  if (!player || player.status !== 'active') return false;
  return player.id === state.government.primeMinisterId || (player.partyId && state.government.coalitionPartyIds?.includes(player.partyId));
}

function actorCanSponsorRepresentedPartyProposal(state, actorId) {
  const player = state.players[actorId];
  if (!player?.partyId || player.status !== 'active') return false;
  return filledLegislativeSeats(state).some(seat => seat.partyId === player.partyId);
}

function beginProposalDiscussion(proposal, hours) {
  const now = nowIso();
  proposal.status = 'discussion';
  proposal.discussionStartedAt = now;
  proposal.discussionEndsAt = new Date(currentNowMs() + hours * 3600000).toISOString();
}

function createInternalVote(state, { id = null, title, type = 'yes-no-abstain', actorId = null, secret = false, durationMinutes = 1440, options = null, settings = {} }) {
  const voteId = id || createId('vote');
  if (state.votes[voteId]) throw new Error('Vote ID already exists.');
  state.votes[voteId] = {
    id: voteId, title, type, electionKind: null, committee: null, status: 'draft', secret,
    createdAt: nowIso(), createdBy: actorId, opensAt: null, closesAt: null,
    durationMinutes: Math.max(1, Number(durationMinutes) || 1440), electorateSnapshot: [],
    options: options ?? [{id:'yes',label:'Yes'},{id:'no',label:'No'},{id:'abstain',label:'Abstain'}],
    ballots: {}, sealedBallots: [], submittedVoters: {}, secretBallotMode: null, secretBoxPublicKey: null, secretBoxHolderPlayerId: null, revealedChoices: null, revealedPrivateKey: null, settings: deepClone(settings), result: null, certifiedAt: null, certifiedBy: null
  };
  return voteId;
}

function enactLawProposal(state, proposal, actorId) {
  const now = nowIso();
  if (proposal.changeKind === 'repeal') {
    const target = state.laws[proposal.targetLawId];
    if (!target) throw new Error('Target law not found.');
    target.status = 'repealed';
    target.repealedAt = now;
    target.history ??= [];
    target.history.push({ type: 'repealed', at: now, proposalId: proposal.id });
    proposal.status = 'passed';
    proposal.effectiveAt = now;
    addEvent(state, createEvent('LAW_REPEALED', actorId, { proposalId: proposal.id, lawId: target.id, title: target.title }));
    return;
  }
  if (proposal.changeKind === 'amend') {
    const target = state.laws[proposal.targetLawId];
    if (!target) throw new Error('Target law not found.');
    target.history ??= [];
    target.history.push({ type: 'amended', at: now, proposalId: proposal.id, previousText: target.text, previousTitle: target.title, previousVersion: target.version });
    target.title = proposal.title;
    target.text = proposal.text;
    target.version = (target.version ?? 1) + 1;
    target.updatedAt = now;
    target.status = 'in-force';
    proposal.status = 'passed';
    proposal.effectiveAt = now;
    addEvent(state, createEvent('LAW_AMENDED', actorId, { proposalId: proposal.id, lawId: target.id, title: target.title, version: target.version }));
    return;
  }
  const lawId = proposal.lawId || nextFormalId(state.laws, 'LAW');
  state.laws[lawId] = {
    id: lawId, title: proposal.title, text: proposal.text, reason: proposal.reason,
    status: 'in-force', version: 1, enactedAt: now, updatedAt: now, sourceProposalId: proposal.id,
    history: [{ type: 'enacted', at: now, proposalId: proposal.id }]
  };
  proposal.lawId = lawId;
  proposal.status = 'passed';
  proposal.effectiveAt = now;
  addEvent(state, createEvent('LAW_ENACTED', actorId, { proposalId: proposal.id, lawId, title: proposal.title }));
}

function createLawReferendum(state, proposal, actorId) {
  if (proposal.referendumVoteId) return proposal.referendumVoteId;
  const voteId = createInternalVote(state, {
    title: `Referendum — ${proposal.id}: ${proposal.title}`, actorId, secret: true, durationMinutes: 1440,
    settings: { approvalRequirement: 0.5, turnoutRequirement: 0.20, inclusiveApproval: false, proposalType: 'law-referendum', proposalId: proposal.id }
  });
  proposal.referendumVoteId = voteId;
  proposal.status = 'referendum';
  addEvent(state, createEvent('LAW_REFERENDUM_CREATED', actorId, { proposalId: proposal.id, voteId }));
  return voteId;
}

function applyCertifiedProposalVote(state, vote, actorId) {
  const proposalType = vote.settings?.proposalType;
  const proposalId = vote.settings?.proposalId;
  if (!proposalType || !proposalId) return;

  if (proposalType === 'law-legislative') {
    const proposal = state.lawProposals[proposalId];
    if (!proposal) return;
    if (vote.result?.passed) {
      proposal.status = 'referendum-window';
      proposal.parliamentPassedAt = nowIso();
      proposal.referendumDeadline = new Date(currentNowMs() + 48 * 3600000).toISOString();
      addEvent(state, createEvent('LAW_PASSED_PARLIAMENT', actorId, { proposalId, voteId: vote.id, referendumDeadline: proposal.referendumDeadline }));
    } else {
      proposal.status = 'rejected';
      addEvent(state, createEvent('LAW_REJECTED_BY_PARLIAMENT', actorId, { proposalId, voteId: vote.id }));
    }
  } else if (proposalType === 'law-referendum' || proposalType === 'citizen-initiative') {
    const proposal = state.lawProposals[proposalId];
    if (!proposal) return;
    if (vote.result?.passed) enactLawProposal(state, proposal, actorId);
    else {
      proposal.status = 'rejected';
      addEvent(state, createEvent('LAW_REFERENDUM_REJECTED', actorId, { proposalId, voteId: vote.id }));
    }
  } else if (proposalType === 'base-unlock') {
    const proposal = state.constitution.unlockProposals[proposalId];
    if (!proposal) return;
    if (vote.result?.passed) {
      proposal.status = 'approved';
      proposal.approvedAt = nowIso();
      state.constitution.editableOverrides[proposal.section] = { section: proposal.section, title: proposal.sectionTitle, unlockedBy: proposal.id, approvedAt: proposal.approvedAt };
      addEvent(state, createEvent('BASE_RULE_MADE_EDITABLE', actorId, { proposalId, section: proposal.section }));
    } else {
      proposal.status = 'rejected';
      addEvent(state, createEvent('BASE_UNLOCK_REJECTED', actorId, { proposalId, section: proposal.section }));
    }
  } else if (proposalType === 'constitutional-amendment') {
    const proposal = state.constitution.proposals[proposalId];
    if (!proposal) return;
    if (vote.result?.passed) {
      proposal.status = 'approved';
      const now = nowIso();
      const amendmentNo = state.constitution.amendments.length + 1;
      const amendment = {
        number: amendmentNo, id: proposal.id, section: proposal.section, sectionTitle: proposal.sectionTitle,
        category: proposal.category, previousText: proposal.currentText, newText: proposal.proposedText,
        reason: proposal.reason, approvedAt: now, effectiveAt: proposal.effectiveAt || now,
        electorateSize: vote.electorateSnapshot.length, votesCast: vote.secretBallotMode === 'sealed-v1' ? Object.keys(vote.submittedVoters ?? {}).length : Object.keys(vote.ballots).length,
        result: deepClone(vote.result)
      };
      state.constitution.amendments.push(amendment);
      state.constitution.sectionOverrides[proposal.section] = {
        section: proposal.section, title: proposal.sectionTitle, category: proposal.category,
        text: proposal.proposedText, amendmentId: proposal.id, effectiveAt: amendment.effectiveAt
      };
      if (state.constitution.sections?.[proposal.section]) {
        state.constitution.sections[proposal.section] = {
          ...state.constitution.sections[proposal.section],
          title: proposal.sectionTitle || state.constitution.sections[proposal.section].title,
          category: proposal.category,
          text: proposal.proposedText,
          amendedBy: proposal.id,
          effectiveAt: amendment.effectiveAt
        };
      }
      state.constitution.version = (state.constitution.version ?? 1) + 1;
      proposal.status = 'applied';
      proposal.appliedAt = now;
      addEvent(state, createEvent('CONSTITUTION_AMENDED', actorId, { proposalId, section: proposal.section, version: state.constitution.version }));
    } else {
      proposal.status = 'rejected';
      addEvent(state, createEvent('CONSTITUTION_AMENDMENT_REJECTED', actorId, { proposalId, section: proposal.section }));
    }
  }
}


function applyCommitteeOrCaseVote(state, vote, actorId) {
  const settings = vote.settings ?? {};
  if (settings.committeeMatterId && settings.committeeCode) {
    const committee = state.committees[settings.committeeCode];
    const matter = committee?.matters?.find(m => m.id === settings.committeeMatterId);
    if (matter) {
      matter.status = 'decided';
      matter.decision = vote.result?.passed ? 'approved' : 'rejected';
      matter.decidedAt = nowIso();
      committee.decisions ??= [];
      committee.decisions.push({ matterId: matter.id, decision: matter.decision, voteId: vote.id, decidedAt: matter.decidedAt });
      addEvent(state, createEvent('COMMITTEE_DECISION', actorId, { committee: settings.committeeCode, matterId: matter.id, decision: matter.decision }));
    }
  }

  if (settings.baseUnlockProposalId && settings.committeeCode === 'AC') {
    const proposal = state.constitution.unlockProposals[settings.baseUnlockProposalId];
    if (proposal) {
      if (vote.result?.passed) {
        proposal.acApproved = true;
        proposal.status = 'ac-approved';
        const thresholds = amendmentThresholds('base-unlock');
        const publicVoteId = createInternalVote(state, {
          title: `Base Rule Unlock — Section ${proposal.section}${proposal.sectionTitle ? `: ${proposal.sectionTitle}` : ''}`,
          actorId, secret: true, durationMinutes: 2880,
          settings: { approvalRequirement: thresholds.approvalRequirement, turnoutRequirement: thresholds.turnoutRequirement, inclusiveApproval: true, proposalType: 'base-unlock', proposalId: proposal.id }
        });
        proposal.voteId = publicVoteId;
        proposal.status = 'public-vote';
        addEvent(state, createEvent('BASE_UNLOCK_AC_APPROVED', actorId, { proposalId: proposal.id, voteId: publicVoteId }));
      } else {
        proposal.status = 'rejected';
        addEvent(state, createEvent('BASE_UNLOCK_REJECTED', actorId, { proposalId: proposal.id, section: proposal.section }));
      }
    }
  }

  if (settings.caseId && settings.caseStage) {
    const c = state.cases[settings.caseId];
    if (!c) return;
    if (settings.caseStage === 'pac') {
      c.pacVoteId = vote.id;
      c.pacFinding = vote.result?.passed ? 'guilty' : 'not-guilty';
      c.pacDecidedAt = nowIso();
      c.status = vote.result?.passed ? 'awaiting-jury' : 'closed-not-guilty';
      addEvent(state, createEvent('CASE_PAC_DECIDED', actorId, { caseId: c.id, finding: c.pacFinding }));
    } else if (settings.caseStage === 'jury') {
      c.juryVoteId = vote.id;
      c.juryResult = vote.result?.passed ? 'upheld' : 'rejected';
      c.juryDecidedAt = nowIso();
      c.status = vote.result?.passed ? 'awaiting-ppc' : 'closed-not-guilty';
      addEvent(state, createEvent('CASE_JURY_DECIDED', actorId, { caseId: c.id, result: c.juryResult }));
    }
  }
}

export function dispatch(action) {
  if (!currentState) throw new Error('No game is currently loaded.');
  const state = deepClone(currentState);

  switch (action.type) {
    case 'GAME_RENAMED': {
      const name = action.name?.trim();
      if (!name) throw new Error('Game name cannot be empty.');
      if (name.length > 80) throw new Error('Game names must be 80 characters or fewer.');
      const previousName = state.meta.name;
      state.meta.name = name;
      touch(state);
      addEvent(state, createEvent('GAME_RENAMED', action.actorId, { previousName, newName: name }));
      break;
    }

    case 'PLAYER_ADDED': {
      const name = action.name?.trim();
      if (!name) throw new Error('Player name cannot be empty.');
      if (name.length > 50) throw new Error('Player names must be 50 characters or fewer.');
      const id = action.playerId || createId('player');
      if (state.players[id]) throw new Error('Player ID already exists.');
      const now = nowIso();
      state.players[id] = {
        id,
        displayName: name,
        joinedAt: now,
        status: 'active',
        partyId: null,
        roles: [],
        offices: [],
        officeHistory: [],
        partyHistory: [],
        lastActiveAt: now,
        identityFingerprint: action.identityFingerprint ?? null,
        identityPublicKey: action.identityPublicKey ? deepClone(action.identityPublicKey) : null
      };
      touch(state);
      addEvent(state, createEvent('PLAYER_ADDED', action.actorId, { playerId: id, playerName: name }));
      break;
    }


    case 'PLAYER_IDENTITY_BOUND': {
      const player = requirePlayer(state, action.playerId);
      if (!action.identityFingerprint || !action.identityPublicKey) throw new Error('A public identity and fingerprint are required.');
      if (player.identityFingerprint && player.identityFingerprint !== action.identityFingerprint && !action.allowReplace) throw new Error('This player already has a different cryptographic identity.');
      player.identityFingerprint = action.identityFingerprint;
      player.identityPublicKey = deepClone(action.identityPublicKey);
      player.lastActiveAt = nowIso();
      touch(state);
      addEvent(state, createEvent('PLAYER_IDENTITY_BOUND', action.actorId ?? action.playerId, { playerId: player.id, fingerprint: action.identityFingerprint }));
      break;
    }

    case 'PLAYER_RENAMED': {
      const player = requirePlayer(state, action.playerId);
      const newName = action.name?.trim();
      if (!newName) throw new Error('Player name cannot be empty.');
      if (newName.length > 50) throw new Error('Player names must be 50 characters or fewer.');
      const previousName = player.displayName;
      player.displayName = newName;
      player.lastActiveAt = nowIso();
      touch(state);
      addEvent(state, createEvent('PLAYER_RENAMED', action.actorId ?? action.playerId, { playerId: player.id, previousName, newName }));
      break;
    }

    case 'PLAYER_STATUS_CHANGED': {
      const player = requirePlayer(state, action.playerId);
      const allowed = ['active', 'inactive'];
      if (!allowed.includes(action.status)) throw new Error('Invalid player status.');
      if (player.status === 'resigned' || player.status === 'removed') throw new Error('Resigned or removed players cannot be changed with this action.');
      const previousStatus = player.status;
      if (previousStatus === action.status) throw new Error(`Player is already ${action.status}.`);
      player.status = action.status;
      player.lastActiveAt = nowIso();
      touch(state);
      addEvent(state, createEvent('PLAYER_STATUS_CHANGED', action.actorId, { playerId: player.id, previousStatus, newStatus: action.status }));
      break;
    }

    case 'PLAYER_RESIGNED': {
      const player = requirePlayer(state, action.playerId);
      if (player.status === 'resigned') throw new Error('Player has already resigned.');
      if (player.status === 'removed') throw new Error('Permanently removed players cannot resign.');
      const oldPartyId = player.partyId;
      if (oldPartyId && state.parties[oldPartyId]) {
        const party = state.parties[oldPartyId];
        removeMember(party, player.id);
        closeOpenPartyHistory(player, oldPartyId, 'resigned');
        if (party.leaderId === player.id) {
          party.leaderId = nextPartyLeader(state, party);
        }
      }
      player.partyId = null;
      player.status = 'resigned';
      player.lastActiveAt = nowIso();
      vacateLegislativeSeatForPlayer(state, player.id, action.actorId ?? player.id, 'player-resigned');
      touch(state);
      addEvent(state, createEvent('PLAYER_RESIGNED', action.actorId ?? player.id, { playerId: player.id, previousPartyId: oldPartyId }));
      break;
    }

    case 'PARTY_CREATED': {
      const leader = requirePlayer(state, action.leaderId);
      ensureActivePlayer(leader);
      if (leader.partyId) throw new Error('The proposed leader is already in a party.');
      const name = action.name?.trim();
      if (!name) throw new Error('Party name cannot be empty.');
      if (name.length > 80) throw new Error('Party names must be 80 characters or fewer.');
      const abbreviation = action.abbreviation?.trim().toUpperCase() || '';
      const duplicate = Object.values(state.parties).some(p => p.status === 'active' && p.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error('An active party already uses that name.');
      const id = createId('party');
      const now = nowIso();
      const description = action.description?.trim() || '';
      if (description.length > 500) throw new Error('Party descriptions must be 500 characters or fewer.');
      const colour = cleanPartyColour(action.colour, '#475569');
      state.parties[id] = {
        id,
        name,
        abbreviation: abbreviation.slice(0, 10),
        description,
        colour,
        leaderId: leader.id,
        members: [leader.id],
        createdAt: now,
        dissolvedAt: null,
        status: 'active'
      };
      leader.partyId = id;
      leader.partyHistory.push({ partyId: id, joinedAt: now, leftAt: null, reason: 'founder' });
      touch(state);
      addEvent(state, createEvent('PARTY_CREATED', action.actorId ?? leader.id, { partyId: id, partyName: name, leaderId: leader.id }));
      break;
    }

    case 'PARTY_INVITE_SENT': {
      const party = requireParty(state, action.partyId);
      const player = requirePlayer(state, action.playerId);
      ensureActivePlayer(player);
      if (party.status !== 'active') throw new Error('That party is not active.');
      if (party.leaderId !== action.actorId) throw new Error('Only the party leader may invite a player.');
      if (player.partyId) throw new Error('Only independent players can be invited. They must leave their current party first.');
      if (pendingPartyMembership(state, { playerId: player.id })) throw new Error('That player already has a pending party membership request or invitation.');
      const id = createId('party-membership');
      state.partyMembershipRequests[id] = { id, kind: 'invite', partyId: party.id, playerId: player.id, createdBy: action.actorId, status: 'pending', createdAt: nowIso(), resolvedAt: null, resolvedBy: null };
      touch(state);
      addEvent(state, createEvent('PARTY_INVITE_SENT', action.actorId, { requestId: id, partyId: party.id, playerId: player.id }));
      break;
    }

    case 'PARTY_JOIN_REQUESTED': {
      const party = requireParty(state, action.partyId);
      const player = requirePlayer(state, action.playerId ?? action.actorId);
      ensureActivePlayer(player);
      if (player.id !== action.actorId) throw new Error('You may only request party membership for yourself.');
      if (party.status !== 'active') throw new Error('That party is not active.');
      if (player.partyId) throw new Error('Leave your current party before requesting another one.');
      if (pendingPartyMembership(state, { playerId: player.id })) throw new Error('You already have a pending party membership request or invitation.');
      const id = createId('party-membership');
      state.partyMembershipRequests[id] = { id, kind: 'join-request', partyId: party.id, playerId: player.id, createdBy: player.id, status: 'pending', createdAt: nowIso(), resolvedAt: null, resolvedBy: null };
      touch(state);
      addEvent(state, createEvent('PARTY_JOIN_REQUESTED', player.id, { requestId: id, partyId: party.id, playerId: player.id }));
      break;
    }

    case 'PARTY_MEMBERSHIP_RESPONDED': {
      const request = state.partyMembershipRequests?.[action.requestId];
      if (!request || request.status !== 'pending') throw new Error('That party membership request is no longer pending.');
      const party = requireParty(state, request.partyId);
      const player = requirePlayer(state, request.playerId);
      const response = action.response === 'accept' ? 'accepted' : action.response === 'reject' ? 'rejected' : null;
      if (!response) throw new Error('Response must be accept or reject.');
      if (request.kind === 'invite' && action.actorId !== player.id) throw new Error('Only the invited player may accept or reject this invitation.');
      if (request.kind === 'join-request' && action.actorId !== party.leaderId) throw new Error('Only the party leader may accept or reject this join request.');
      if (response === 'accepted') joinIndependentPlayerToParty(state, player, party, action.actorId, request.kind === 'invite' ? 'invite-accepted' : 'request-accepted');
      request.status = response;
      request.resolvedAt = nowIso();
      request.resolvedBy = action.actorId;
      touch(state);
      addEvent(state, createEvent('PARTY_MEMBERSHIP_RESPONDED', action.actorId, { requestId: request.id, partyId: party.id, playerId: player.id, kind: request.kind, response }));
      break;
    }

    case 'PARTY_MEMBER_REMOVED': {
      const party = requireParty(state, action.partyId);
      const player = requirePlayer(state, action.playerId);
      if (party.leaderId !== action.actorId) throw new Error('Only the party leader may remove a member.');
      if (player.id === party.leaderId) throw new Error('The party leader must leave the party or transfer leadership instead.');
      if (player.partyId !== party.id || !party.members.includes(player.id)) throw new Error('That player is not a member of this party.');
      removeMember(party, player.id);
      closeOpenPartyHistory(player, party.id, 'removed-by-party');
      player.partyId = null;
      vacateLegislativeSeatForPlayer(state, player.id, action.actorId, 'removed-from-electoral-list');
      touch(state);
      addEvent(state, createEvent('PARTY_MEMBER_REMOVED', action.actorId, { partyId: party.id, playerId: player.id }));
      break;
    }

    case 'PLAYER_JOINED_PARTY': {
      const player = requirePlayer(state, action.playerId);
      const party = requireParty(state, action.partyId);
      ensureActivePlayer(player);
      if (party.status !== 'active') throw new Error('That party is not active.');
      if (player.partyId === party.id) throw new Error('Player is already in that party.');
      const previousPartyId = player.partyId;
      if (previousPartyId && state.parties[previousPartyId]) {
        const previousParty = state.parties[previousPartyId];
        removeMember(previousParty, player.id);
        closeOpenPartyHistory(player, previousPartyId, 'switched');
        if (previousParty.leaderId === player.id) previousParty.leaderId = nextPartyLeader(state, previousParty);
      }
      const now = nowIso();
      player.partyId = party.id;
      if (previousPartyId && previousPartyId !== party.id) vacateLegislativeSeatForPlayer(state, player.id, action.actorId ?? player.id, 'left-electoral-list');
      if (!party.members.includes(player.id)) party.members.push(player.id);
      player.partyHistory.push({ partyId: party.id, joinedAt: now, leftAt: null, reason: previousPartyId ? 'switched-in' : 'joined' });
      touch(state);
      addEvent(state, createEvent('PLAYER_JOINED_PARTY', action.actorId ?? player.id, { playerId: player.id, partyId: party.id, previousPartyId }));
      break;
    }

    case 'PLAYER_LEFT_PARTY': {
      const player = requirePlayer(state, action.playerId);
      if (!player.partyId) throw new Error('Player is not currently in a party.');
      const party = requireParty(state, player.partyId);
      const previousPartyId = party.id;
      removeMember(party, player.id);
      closeOpenPartyHistory(player, previousPartyId, 'left');
      player.partyId = null;
      vacateLegislativeSeatForPlayer(state, player.id, action.actorId ?? player.id, 'left-electoral-list');
      if (party.leaderId === player.id) party.leaderId = nextPartyLeader(state, party);
      touch(state);
      addEvent(state, createEvent('PLAYER_LEFT_PARTY', action.actorId ?? player.id, { playerId: player.id, partyId: previousPartyId }));
      break;
    }

    case 'PARTY_LEADER_CHANGED': {
      const party = requireParty(state, action.partyId);
      const newLeader = requirePlayer(state, action.leaderId);
      if (party.status !== 'active') throw new Error('That party is not active.');
      if (!party.members.includes(newLeader.id) || newLeader.partyId !== party.id) throw new Error('Party leader must be a current party member.');
      ensureActivePlayer(newLeader);
      const previousLeaderId = party.leaderId;
      if (previousLeaderId === newLeader.id) throw new Error('That player is already the party leader.');
      party.leaderId = newLeader.id;
      touch(state);
      addEvent(state, createEvent('PARTY_LEADER_CHANGED', action.actorId, { partyId: party.id, previousLeaderId, newLeaderId: newLeader.id }));
      break;
    }

    case 'PARTY_UPDATED': {
      const party = requireParty(state, action.partyId);
      if (party.status !== 'active') throw new Error('Dissolved parties cannot be edited.');
      const previous = { name: party.name, abbreviation: party.abbreviation, description: party.description, colour: party.colour };
      const name = action.name?.trim();
      if (!name) throw new Error('Party name cannot be empty.');
      if (name.length > 80) throw new Error('Party names must be 80 characters or fewer.');
      const duplicate = Object.values(state.parties).some(p => p.id !== party.id && p.status === 'active' && p.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error('An active party already uses that name.');
      const description = action.description?.trim() || '';
      if (description.length > 500) throw new Error('Party descriptions must be 500 characters or fewer.');
      party.name = name;
      party.abbreviation = (action.abbreviation?.trim().toUpperCase() || '').slice(0, 10);
      party.description = description;
      party.colour = cleanPartyColour(action.colour, party.colour || '#475569');
      touch(state);
      addEvent(state, createEvent('PARTY_UPDATED', action.actorId, { partyId: party.id, previous, current: { name: party.name, abbreviation: party.abbreviation, description: party.description, colour: party.colour } }));
      break;
    }

    case 'PARTY_DISSOLVED': {
      const party = requireParty(state, action.partyId);
      if (party.status === 'dissolved') throw new Error('Party is already dissolved.');
      const now = nowIso();
      const formerMemberIds = [...party.members];
      for (const memberId of formerMemberIds) {
        const player = state.players[memberId];
        if (!player) continue;
        if (player.partyId === party.id) player.partyId = null;
        closeOpenPartyHistory(player, party.id, 'dissolved');
        vacateLegislativeSeatForPlayer(state, player.id, action.actorId, 'party-dissolved');
      }
      party.members = [];
      party.leaderId = null;
      party.status = 'dissolved';
      party.dissolvedAt = now;
      touch(state);
      addEvent(state, createEvent('PARTY_DISSOLVED', action.actorId, { partyId: party.id, partyName: party.name, formerMemberIds }));
      break;
    }


    case 'VOTE_CREATED': {
      const title = action.title?.trim();
      if (!title) throw new Error('Vote title cannot be empty.');
      const id = action.voteId || createId('vote');
      if (state.votes[id]) throw new Error('Vote ID already exists.');
      const options = (action.options ?? []).map(option => ({ id: option.id || createId('option'), label: option.label?.trim() || 'Untitled option', entityId: option.entityId ?? null }));
      if (!options.length) throw new Error('A vote requires at least one option.');
      state.votes[id] = {
        id,
        title,
        type: action.voteType,
        electionKind: action.electionKind ?? null,
        committee: action.committee ?? null,
        status: 'draft',
        secret: action.secret !== false,
        createdAt: nowIso(),
        createdBy: action.actorId ?? null,
        opensAt: null,
        closesAt: null,
        durationMinutes: Math.max(1, Number(action.durationMinutes) || 2880),
        electorateSnapshot: [],
        options,
        ballots: {},
        sealedBallots: [],
        submittedVoters: {},
        secretBallotMode: null,
        secretBoxPublicKey: null,
        secretBoxHolderPlayerId: null,
        revealedChoices: null,
        revealedPrivateKey: null,
        settings: deepClone(action.settings ?? {}),
        result: null,
        certifiedAt: null,
        certifiedBy: null
      };
      if (action.electionKind) {
        state.elections[id] = { voteId: id, kind: action.electionKind, committee: action.committee ?? null, status: 'draft', result: null };
      }
      touch(state);
      addEvent(state, createEvent('VOTE_CREATED', action.actorId, { voteId: id, title, voteType: action.voteType, electionKind: action.electionKind ?? null }));
      break;
    }

    case 'VOTE_OPENED': {
      const vote = state.votes[action.voteId];
      if (!vote) throw new Error('Vote not found.');
      if (!['draft', 'scheduled'].includes(vote.status)) throw new Error('Only a draft or scheduled vote can be opened.');
      let snapshot;
      if (vote.settings?.electorateMode === 'legislature') snapshot = legislativeMemberIds(state);
      else if (Array.isArray(vote.settings?.eligiblePlayerIds)) snapshot = [...new Set(vote.settings.eligiblePlayerIds)].filter(id => state.players[id]?.status === 'active');
      else snapshot = activeElectorate(state);
      if (!snapshot.length) throw new Error('There are no active eligible voters.');
      const now = new Date(currentNowMs());
      const durationMinutes = Math.max(1, Number(action.durationMinutes) || vote.durationMinutes || 2880);
      vote.electorateSnapshot = snapshot;
      vote.opensAt = now.toISOString();
      vote.closesAt = new Date(now.getTime() + durationMinutes * 60000).toISOString();
      vote.durationMinutes = durationMinutes;
      vote.status = 'open';
      vote.result = null;
      if (vote.secret && action.secretBoxPublicKey) {
        vote.secretBallotMode = 'sealed-v1';
        vote.secretBoxPublicKey = deepClone(action.secretBoxPublicKey);
        vote.secretBoxHolderPlayerId = action.actorId ?? null;
        vote.sealedBallots = [];
        vote.submittedVoters = {};
        vote.revealedChoices = null;
        vote.revealedPrivateKey = null;
      }
      if (state.elections[vote.id]) state.elections[vote.id].status = 'open';
      touch(state);
      addEvent(state, createEvent('VOTE_OPENED', action.actorId, { voteId: vote.id, title: vote.title, electorateSize: snapshot.length, closesAt: vote.closesAt }));
      break;
    }

    case 'BALLOT_CAST': {
      const vote = state.votes[action.voteId];
      if (!vote) throw new Error('Vote not found.');
      if (vote.status !== 'open') throw new Error('Voting is not open.');
      if (new Date(vote.closesAt).getTime() <= currentNowMs()) throw new Error('The voting deadline has passed. Close the vote before continuing.');
      const voter = requirePlayer(state, action.voterId);
      if (!vote.electorateSnapshot.includes(voter.id)) throw new Error('This player is not in the electorate snapshot.');
      let replaced = false;
      if (vote.secretBallotMode === 'sealed-v1') {
        if (!action.encryptedBallot?.ciphertext || !action.encryptedBallot?.wrappedKey || !action.encryptedBallot?.iv) throw new Error('A sealed secret ballot is required for this vote.');
        if (vote.submittedVoters?.[voter.id]) throw new Error('This sealed secret ballot has already been submitted. Sealed ballots cannot be changed after submission.');
        vote.submittedVoters ??= {};
        vote.sealedBallots ??= [];
        vote.submittedVoters[voter.id] = { submittedAt: nowIso() };
        vote.sealedBallots.push(deepClone(action.encryptedBallot));
      } else {
        validateBallot(vote, action.choice);
        replaced = Boolean(vote.ballots[voter.id]);
        vote.ballots[voter.id] = { voterId: voter.id, choice: deepClone(action.choice), castAt: nowIso() };
      }
      voter.lastActiveAt = nowIso();
      touch(state);
      addEvent(state, createEvent('BALLOT_CAST', vote.secret ? null : action.voterId, { voteId: vote.id, secret: vote.secret, sealed: vote.secretBallotMode === 'sealed-v1', replaced }));
      break;
    }

    case 'SECRET_BALLOT_BOX_REVEALED': {
      const vote = state.votes[action.voteId];
      if (!vote || vote.secretBallotMode !== 'sealed-v1') throw new Error('This vote does not use a sealed ballot box.');
      if (!['open','paused'].includes(vote.status)) throw new Error('The sealed ballot box may only be revealed while closing an open or paused vote.');
      if (vote.secretBoxHolderPlayerId && action.actorId !== vote.secretBoxHolderPlayerId) throw new Error('Only the player who opened this sealed ballot box can reveal it.');
      if (!Array.isArray(action.choices) || action.choices.length !== (vote.sealedBallots ?? []).length) throw new Error('Revealed ballot count does not match the sealed ballot count.');
      for (const choice of action.choices) validateBallot(vote, choice);
      vote.revealedChoices = deepClone(action.choices);
      vote.revealedPrivateKey = null;
      vote.revealedAt = nowIso();
      touch(state);
      addEvent(state, createEvent('SECRET_BALLOT_BOX_REVEALED', action.actorId, { voteId: vote.id, ballots: action.choices.length }));
      break;
    }

    case 'VOTE_PAUSED': {
      const vote = state.votes[action.voteId];
      if (!vote || vote.status !== 'open') throw new Error('Only an open vote can be paused.');
      vote.status = 'paused';
      vote.pausedAt = nowIso();
      if (state.elections[vote.id]) state.elections[vote.id].status = 'paused';
      touch(state);
      addEvent(state, createEvent('VOTE_PAUSED', action.actorId, { voteId: vote.id }));
      break;
    }

    case 'VOTE_RESUMED': {
      const vote = state.votes[action.voteId];
      if (!vote || vote.status !== 'paused') throw new Error('Only a paused vote can be resumed.');
      const pausedMs = currentNowMs() - new Date(vote.pausedAt).getTime();
      vote.closesAt = new Date(new Date(vote.closesAt).getTime() + Math.max(0, pausedMs)).toISOString();
      vote.status = 'open';
      vote.pausedAt = null;
      if (state.elections[vote.id]) state.elections[vote.id].status = 'open';
      touch(state);
      addEvent(state, createEvent('VOTE_RESUMED', action.actorId, { voteId: vote.id, closesAt: vote.closesAt }));
      break;
    }

    case 'VOTE_CLOSED': {
      const vote = state.votes[action.voteId];
      if (!vote) throw new Error('Vote not found.');
      if (!['open', 'paused'].includes(vote.status)) throw new Error('Only an open or paused vote can be closed.');
      if (vote.secretBallotMode === 'sealed-v1' && !Array.isArray(vote.revealedChoices)) {
        if (vote.secretBoxHolderPlayerId && action.actorId !== vote.secretBoxHolderPlayerId) throw new Error('Only the player who opened this sealed ballot box can close and reveal it.');
        if (!Array.isArray(action.revealedChoices) || action.revealedChoices.length !== (vote.sealedBallots ?? []).length) throw new Error('Reveal material is required to close this sealed secret vote.');
        for (const choice of action.revealedChoices) validateBallot(vote, choice);
        vote.revealedChoices = deepClone(action.revealedChoices);
        vote.revealedPrivateKey = null;
        vote.revealedAt = nowIso();
        addEvent(state, createEvent('SECRET_BALLOT_BOX_REVEALED', action.actorId, { voteId: vote.id, ballots: action.revealedChoices.length }));
      }
      vote.status = 'closed';
      vote.closedAt = nowIso();
      vote.result = tallyVote(vote);
      if (state.elections[vote.id]) {
        state.elections[vote.id].status = 'closed';
        state.elections[vote.id].result = deepClone(vote.result);
      }
      touch(state);
      addEvent(state, createEvent('VOTE_CLOSED', action.actorId, { voteId: vote.id, title: vote.title, ballotsCast: vote.secretBallotMode === 'sealed-v1' ? Object.keys(vote.submittedVoters ?? {}).length : Object.keys(vote.ballots).length }));
      break;
    }

    case 'VOTE_CERTIFIED': {
      const vote = state.votes[action.voteId];
      if (!vote || vote.status !== 'closed') throw new Error('Only a closed vote can be certified.');
      vote.status = 'certified';
      vote.certifiedAt = nowIso();
      vote.certifiedBy = action.actorId ?? null;
      if (state.elections[vote.id]) state.elections[vote.id].status = 'certified';

      if (vote.electionKind === 'general') {
        const built = buildLegislatureFromElection(state, vote);
        const termStartedAt = vote.certifiedAt;
        const termEndsAt = new Date(new Date(termStartedAt).getTime() + 28 * 86400000).toISOString();
        state.legislature = { ...built, termStartedAt, termEndsAt };
        for (const player of Object.values(state.players)) {
          player.offices = (player.offices ?? []).filter(office => office !== 'MP');
        }
        for (const seat of filledLegislativeSeats(state)) {
          const player = state.players[seat.memberId];
          if (player && !player.offices.includes('MP')) player.offices.push('MP');
        }
        state.government = { status: 'forming', primeMinisterId: null, coalitionPartyIds: [], ministers: [], formedAt: null, caretakerSince: null, caretakerDeadline: null, earlyElectionRequired: false };
        addEvent(state, createEvent('LEGISLATURE_FORMED', action.actorId, { electionId: vote.id, totalSeats: built.totalSeats, filledSeats: filledLegislativeSeats(state).length }));
      } else if (vote.electionKind === 'host' && vote.result?.winnerId) {
        const winner = state.players[vote.result.winnerId];
        if (winner) {
          for (const player of Object.values(state.players)) player.offices = (player.offices ?? []).filter(office => office !== 'Host');
          if (!winner.offices.includes('Host')) winner.offices.push('Host');
          state.meta.hostPlayerId = winner.id;
          addEvent(state, createEvent('HOST_ASSUMED_OFFICE', action.actorId, { playerId: winner.id, electionId: vote.id }));
        }
      } else if (vote.electionKind === 'deputy-host' && vote.result?.winnerId) {
        const winner = state.players[vote.result.winnerId];
        if (winner) {
          for (const player of Object.values(state.players)) player.offices = (player.offices ?? []).filter(office => office !== 'Deputy Host');
          if (!winner.offices.includes('Deputy Host')) winner.offices.push('Deputy Host');
          state.meta.deputyHostPlayerId = winner.id;
          addEvent(state, createEvent('DEPUTY_HOST_ASSUMED_OFFICE', action.actorId, { playerId: winner.id, electionId: vote.id }));
        }
      } else if (vote.electionKind === 'committee' && vote.committee) {
        const code = vote.committee;
        const committee = state.committees[code] ?? defaultCommitteeState(code);
        const seatCount = Number(vote.settings?.seatCount) || committeeSizeForPlayers(activePlayerCount(state));
        const winners = vote.result?.winners ?? [];
        const ordered = Object.entries(vote.result?.counts ?? {}).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).map(([id])=>id);
        committee.members = winners.slice(0, seatCount);
        committee.alternates = ordered.filter(id => !committee.members.includes(id)).slice(0, seatCount >= 5 ? 2 : 1);
        committee.chairId = null;
        committee.termStartedAt = vote.certifiedAt;
        committee.termEndsAt = new Date(new Date(vote.certifiedAt).getTime() + 56*86400000).toISOString();
        state.committees[code] = committee;
        for (const player of Object.values(state.players)) player.offices = (player.offices ?? []).filter(o => o !== code);
        for (const id of committee.members) {
          const player = state.players[id];
          if (player && !player.offices.includes(code)) player.offices.push(code);
        }
        addEvent(state, createEvent('COMMITTEE_SEATED', action.actorId, { committee: code, members: committee.members, alternates: committee.alternates }));
      }

      if (vote.settings?.motionKind === 'confidence') {
        if (vote.result?.passed) {
          state.government.status = 'active';
          state.government.caretakerSince = null;
          state.government.caretakerDeadline = null;
          state.government.earlyElectionRequired = false;
          addEvent(state, createEvent('CONFIDENCE_CONFIRMED', action.actorId, { voteId: vote.id }));
        } else {
          state.government.status = 'caretaker';
          state.government.caretakerSince = nowIso();
          state.government.caretakerDeadline = new Date(currentNowMs() + 72 * 3600000).toISOString();
          addEvent(state, createEvent('CONFIDENCE_LOST', action.actorId, { voteId: vote.id }));
        }
      } else if (vote.settings?.motionKind === 'constructive-no-confidence' && vote.result?.passed) {
        const checked = validateGovernmentFormation(state, vote.settings.replacementPartyIds, vote.settings.replacementPrimeMinisterId);
        const previousPmId = state.government.primeMinisterId;
        for (const player of Object.values(state.players)) player.offices = (player.offices ?? []).filter(office => !['Prime Minister','Minister'].includes(office));
        state.government = { status: 'active', primeMinisterId: checked.primeMinisterId, coalitionPartyIds: checked.partyIds, ministers: [], formedAt: nowIso(), caretakerSince: null, caretakerDeadline: null, earlyElectionRequired: false };
        const replacementPm = state.players[checked.primeMinisterId];
        if (!replacementPm.offices.includes('Prime Minister')) replacementPm.offices.push('Prime Minister');
        addEvent(state, createEvent('CONSTRUCTIVE_NO_CONFIDENCE_PASSED', action.actorId, { previousPmId, primeMinisterId: checked.primeMinisterId, partyIds: checked.partyIds }));
      }

      if (vote.settings?.hostRemovalVote) {
        const removal = state.hostRemoval;
        if (removal && removal.voteId === vote.id) {
          removal.status = vote.result?.passed ? 'passed' : 'failed';
          removal.resolvedAt = nowIso();
          if (vote.result?.passed) {
            const previousHostId = state.meta.hostPlayerId ?? null;
            if (previousHostId && state.players[previousHostId]) state.players[previousHostId].offices = (state.players[previousHostId].offices ?? []).filter(o => o !== 'Host');
            state.meta.hostPlayerId = null;
            state.meta.actingHostPlayerId = state.meta.deputyHostPlayerId ?? null;
            addEvent(state, createEvent('HOST_REMOVED', action.actorId, { previousHostId, actingHostPlayerId: state.meta.actingHostPlayerId, voteId: vote.id }));
          } else {
            addEvent(state, createEvent('HOST_REMOVAL_FAILED', action.actorId, { voteId: vote.id }));
          }
        }
      }

      applyCertifiedProposalVote(state, vote, action.actorId);
      applyCommitteeOrCaseVote(state, vote, action.actorId);
      touch(state);
      addEvent(state, createEvent('VOTE_CERTIFIED', action.actorId, { voteId: vote.id, title: vote.title }));
      break;
    }


    case 'LAW_PROPOSED': {
      const title = action.title?.trim();
      const text = action.text?.trim();
      const reason = action.reason?.trim();
      if (!title || !text || !reason) throw new Error('A law proposal requires a title, complete wording and reason.');
      const id = nextFormalId(state.lawProposals, 'PROP');
      const now = nowIso();
      const changeKind = action.changeKind ?? 'enact';
      if (!['enact','amend','repeal'].includes(changeKind)) throw new Error('Invalid law proposal type.');
      if (changeKind !== 'enact' && !state.laws[action.targetLawId]) throw new Error('Select an existing law to amend or repeal.');
      const pathway = action.pathway ?? 'legislative';
      const sponsorRoute = pathway === 'citizen-initiative' ? 'citizen-initiative' : (action.sponsorRoute ?? 'petition');
      if (sponsorRoute === 'government' && !actorCanSponsorGovernmentProposal(state, action.actorId)) throw new Error('The proposer is not authorised to sponsor a government bill.');
      if (sponsorRoute === 'represented-party' && !actorCanSponsorRepresentedPartyProposal(state, action.actorId)) throw new Error('The proposer does not belong to an Electoral List holding a filled legislative seat.');
      state.lawProposals[id] = {
        id, title, text, reason, changeKind, targetLawId: action.targetLawId ?? null,
        proposerId: action.actorId ?? null, pathway, sponsorRoute,
        status: ['petition','citizen-initiative'].includes(sponsorRoute) ? 'petition' : 'discussion', createdAt: now,
        discussionStartedAt: null, discussionEndsAt: null, textFrozenAt: null,
        legislativeVoteId: null, referendumVoteId: null, referendumDeadline: null,
        proposalSignatures: [], petitionSignatures: [], initiativeSignatures: [], lawId: null, effectiveAt: action.effectiveAt ?? null
      };
      if (!['petition','citizen-initiative'].includes(sponsorRoute)) beginProposalDiscussion(state.lawProposals[id], 24);
      touch(state);
      addEvent(state, createEvent('LAW_PROPOSED', action.actorId, { proposalId: id, title, changeKind, pathway, sponsorRoute }));
      break;
    }


    case 'LAW_PROPOSAL_PETITION_SIGNED': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal || proposal.sponsorRoute !== 'petition' || proposal.status !== 'petition') throw new Error('This proposal is not collecting sponsorship signatures.');
      const player = requirePlayer(state, action.playerId); ensureActivePlayer(player);
      if (!proposal.proposalSignatures.includes(player.id)) proposal.proposalSignatures.push(player.id);
      const needed = signatureThreshold(state, 0.10);
      if (proposal.proposalSignatures.length >= needed) beginProposalDiscussion(proposal, 24);
      touch(state);
      addEvent(state, createEvent('LAW_PROPOSAL_PETITION_SIGNED', action.actorId ?? player.id, { proposalId: proposal.id, signatures: proposal.proposalSignatures.length, needed }));
      break;
    }

    case 'LAW_PROPOSAL_UPDATED': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal) throw new Error('Law proposal not found.');
      if (!['discussion','draft'].includes(proposal.status) || proposal.textFrozenAt) throw new Error('This proposal is already frozen.');
      if (action.title !== undefined) proposal.title = action.title.trim();
      if (action.text !== undefined) proposal.text = action.text.trim();
      if (action.reason !== undefined) proposal.reason = action.reason.trim();
      if (!proposal.title || !proposal.text || !proposal.reason) throw new Error('Title, wording and reason cannot be empty.');
      proposal.updatedAt = nowIso();
      touch(state);
      addEvent(state, createEvent('LAW_PROPOSAL_UPDATED', action.actorId, { proposalId: proposal.id }));
      break;
    }

    case 'LAW_PROPOSAL_FINALIZED': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal) throw new Error('Law proposal not found.');
      if (proposal.status !== 'discussion') throw new Error('Only a proposal in discussion can be finalized.');
      if (!discussionFinished(proposal)) throw new Error('The required 24-hour discussion period has not finished.');
      proposal.status = 'frozen';
      proposal.textFrozenAt = nowIso();
      if (proposal.pathway === 'citizen-initiative') {
        proposal.status = 'frozen';
        const needed = signatureThreshold(state, 0.20);
        if (proposal.initiativeSignatures.length >= needed) {
          const voteId = createInternalVote(state, {
            title: `Citizens' Initiative — ${proposal.id}: ${proposal.title}`, actorId: action.actorId, secret: true, durationMinutes: 1440,
            settings: { approvalRequirement: 0.5, turnoutRequirement: 0.20, proposalType: 'citizen-initiative', proposalId: proposal.id }
          });
          proposal.referendumVoteId = voteId;
          proposal.status = 'referendum';
        }
      } else {
        const voteId = createInternalVote(state, {
          title: `${proposal.id}: ${proposal.title}`, actorId: action.actorId, secret: false, durationMinutes: 1440,
          settings: { electorateMode: 'legislature', legislativeMajority: true, proposalType: 'law-legislative', proposalId: proposal.id }
        });
        proposal.legislativeVoteId = voteId;
        proposal.status = 'voting';
      }
      touch(state);
      addEvent(state, createEvent('LAW_PROPOSAL_FROZEN', action.actorId, { proposalId: proposal.id, voteId: proposal.legislativeVoteId }));
      break;
    }

    case 'LAW_REFERENDUM_PETITION_SIGNED': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal || proposal.status !== 'referendum-window') throw new Error('This proposal is not in its referendum petition window.');
      if (referendumWindowExpired(proposal)) throw new Error('The 48-hour referendum petition window has expired.');
      const player = requirePlayer(state, action.playerId); ensureActivePlayer(player);
      if (!proposal.petitionSignatures.includes(player.id)) proposal.petitionSignatures.push(player.id);
      const needed = signatureThreshold(state, 0.20);
      if (proposal.petitionSignatures.length >= needed) createLawReferendum(state, proposal, action.actorId ?? player.id);
      touch(state);
      addEvent(state, createEvent('LAW_REFERENDUM_PETITION_SIGNED', action.actorId ?? player.id, { proposalId: proposal.id, signatures: proposal.petitionSignatures.length, needed }));
      break;
    }

    case 'LAW_REFERRED_TO_REFERENDUM': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal || proposal.status !== 'referendum-window') throw new Error('This proposal cannot currently be referred to referendum.');
      createLawReferendum(state, proposal, action.actorId);
      touch(state);
      break;
    }

    case 'CHECK_LAW_REFERENDUM_WINDOW': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal || proposal.status !== 'referendum-window') throw new Error('This proposal is not awaiting the referendum window.');
      if (!referendumWindowExpired(proposal)) throw new Error('The 48-hour referendum window has not expired.');
      enactLawProposal(state, proposal, action.actorId);
      touch(state);
      break;
    }

    case 'CITIZEN_INITIATIVE_SIGNED': {
      const proposal = state.lawProposals[action.proposalId];
      if (!proposal || proposal.pathway !== 'citizen-initiative') throw new Error('Citizen initiative not found.');
      if (!['petition','discussion'].includes(proposal.status)) throw new Error('This initiative is no longer collecting signatures.');
      const player = requirePlayer(state, action.playerId); ensureActivePlayer(player);
      if (!proposal.initiativeSignatures.includes(player.id)) proposal.initiativeSignatures.push(player.id);
      const needed = signatureThreshold(state, 0.20);
      if (proposal.initiativeSignatures.length >= needed && proposal.status === 'petition') beginProposalDiscussion(proposal, 24);
      touch(state);
      addEvent(state, createEvent('CITIZEN_INITIATIVE_SIGNED', action.actorId ?? player.id, { proposalId: proposal.id, signatures: proposal.initiativeSignatures.length, needed }));
      break;
    }


    case 'CONSTITUTION_BASE_UNLOCK_PROPOSED': {
      const section = action.section?.trim();
      const reason = action.reason?.trim();
      if (!section || !reason) throw new Error('Section and reason are required.');
      const id = nextFormalId(state.constitution.unlockProposals, 'UNLOCK');
      state.constitution.unlockProposals[id] = {
        id, section, sectionTitle: action.sectionTitle?.trim() ?? '', reason,
        initiatedBy: action.initiatedBy === 'petition' ? 'petition' : 'host', proposerId: action.actorId ?? null,
        signatures: [], acApproved: false, status: action.initiatedBy === 'petition' ? 'petition' : 'awaiting-ac',
        createdAt: nowIso(), voteId: null
      };
      touch(state);
      addEvent(state, createEvent('BASE_UNLOCK_PROPOSED', action.actorId, { proposalId: id, section, initiatedBy: action.initiatedBy === 'petition' ? 'petition' : 'host' }));
      break;
    }

    case 'CONSTITUTION_BASE_UNLOCK_SIGNED': {
      const proposal = state.constitution.unlockProposals[action.proposalId];
      if (!proposal || proposal.initiatedBy !== 'petition' || proposal.status !== 'petition') throw new Error('This unlock proposal is not collecting petition signatures.');
      const player = requirePlayer(state, action.playerId); ensureActivePlayer(player);
      if (!proposal.signatures.includes(player.id)) proposal.signatures.push(player.id);
      const needed = signatureThreshold(state, 0.25);
      if (proposal.signatures.length >= needed) proposal.status = 'awaiting-ac';
      touch(state);
      addEvent(state, createEvent('BASE_UNLOCK_PETITION_SIGNED', action.actorId ?? player.id, { proposalId: proposal.id, signatures: proposal.signatures.length, needed }));
      break;
    }

    case 'CONSTITUTION_BASE_UNLOCK_AC_APPROVED': {
      throw new Error('Manual AC approval has been removed. Create and certify a real AC vote instead.');
    }

    case 'CONSTITUTION_AMENDMENT_PROPOSED': {
      const section = action.section?.trim();
      const currentText = action.currentText?.trim();
      const proposedText = action.proposedText?.trim();
      const reason = action.reason?.trim();
      if (!section || !currentText || !proposedText || !reason) throw new Error('Section, current wording, proposed wording and reason are required.');
      const category = (action.category ?? 'EDITABLE').toUpperCase();
      if (category === 'BASE') throw new Error('Base provisions cannot be directly amended through the normal amendment procedure.');
      const id = nextAmendmentId(state.constitution);
      const now = nowIso();
      const sponsorRoute = action.sponsorRoute ?? 'petition';
      if (sponsorRoute === 'government' && !actorCanSponsorGovernmentProposal(state, action.actorId)) throw new Error('The proposer is not authorised to sponsor a government constitutional amendment.');
      if (sponsorRoute === 'represented-party' && !actorCanSponsorRepresentedPartyProposal(state, action.actorId)) throw new Error('The proposer does not belong to an Electoral List holding a filled legislative seat.');
      state.constitution.proposals[id] = {
        id, section, sectionTitle: action.sectionTitle?.trim() ?? '', category,
        currentText, proposedText, reason, proposerId: action.actorId ?? null, sponsorRoute,
        proposalSignatures: [], status: sponsorRoute === 'petition' ? 'petition' : 'discussion', createdAt: now,
        discussionStartedAt: null, discussionEndsAt: null, textFrozenAt: null,
        voteId: null, effectiveAt: action.effectiveAt ?? null
      };
      if (sponsorRoute !== 'petition') beginProposalDiscussion(state.constitution.proposals[id], 48);
      touch(state);
      addEvent(state, createEvent('CONSTITUTION_AMENDMENT_PROPOSED', action.actorId, { proposalId: id, section, sponsorRoute }));
      break;
    }


    case 'CONSTITUTION_AMENDMENT_PETITION_SIGNED': {
      const proposal = state.constitution.proposals[action.proposalId];
      if (!proposal || proposal.sponsorRoute !== 'petition' || proposal.status !== 'petition') throw new Error('This amendment is not collecting sponsorship signatures.');
      const player = requirePlayer(state, action.playerId); ensureActivePlayer(player);
      if (!proposal.proposalSignatures.includes(player.id)) proposal.proposalSignatures.push(player.id);
      const needed = signatureThreshold(state, 0.10);
      if (proposal.proposalSignatures.length >= needed) beginProposalDiscussion(proposal, 48);
      touch(state);
      addEvent(state, createEvent('CONSTITUTION_AMENDMENT_PETITION_SIGNED', action.actorId ?? player.id, { proposalId: proposal.id, signatures: proposal.proposalSignatures.length, needed }));
      break;
    }

    case 'CONSTITUTION_AMENDMENT_UPDATED': {
      const proposal = state.constitution.proposals[action.proposalId];
      if (!proposal) throw new Error('Constitutional amendment not found.');
      if (proposal.status !== 'discussion' || proposal.textFrozenAt) throw new Error('This amendment is already frozen.');
      if (action.proposedText !== undefined) proposal.proposedText = action.proposedText.trim();
      if (action.reason !== undefined) proposal.reason = action.reason.trim();
      if (!proposal.proposedText || !proposal.reason) throw new Error('Proposed wording and reason cannot be empty.');
      proposal.updatedAt = nowIso();
      touch(state);
      addEvent(state, createEvent('CONSTITUTION_AMENDMENT_UPDATED', action.actorId, { proposalId: proposal.id }));
      break;
    }

    case 'CONSTITUTION_AMENDMENT_FINALIZED': {
      const proposal = state.constitution.proposals[action.proposalId];
      if (!proposal || proposal.status !== 'discussion') throw new Error('Only an amendment in discussion can be finalized.');
      if (!discussionFinished(proposal)) throw new Error('The required 48-hour discussion period has not finished.');
      proposal.textFrozenAt = nowIso();
      proposal.status = 'voting';
      const thresholds = amendmentThresholds('normal');
      const voteId = createInternalVote(state, {
        title: `${proposal.id} — Section ${proposal.section}`, actorId: action.actorId, secret: true, durationMinutes: 2880,
        settings: { ...thresholds, inclusiveApproval: true, proposalType: 'constitutional-amendment', proposalId: proposal.id }
      });
      proposal.voteId = voteId;
      touch(state);
      addEvent(state, createEvent('CONSTITUTION_AMENDMENT_FROZEN', action.actorId, { proposalId: proposal.id, voteId }));
      break;
    }

    case 'HOST_REMOVAL_PROPOSED': {
      if (!state.meta.hostPlayerId) throw new Error('There is no current Host to remove.');
      if (state.hostRemoval && ['petition','voting'].includes(state.hostRemoval.status)) throw new Error('A Host removal process is already active.');
      const proposer = requirePlayer(state, action.actorId); ensureActivePlayer(proposer);
      state.hostRemoval = { id:createId('host-removal'), targetHostId:state.meta.hostPlayerId, proposerId:proposer.id, signatures:[proposer.id], status:'petition', createdAt:nowIso(), voteId:null, resolvedAt:null };
      touch(state);
      addEvent(state, createEvent('HOST_REMOVAL_PROPOSED', action.actorId, { targetHostId:state.meta.hostPlayerId, signatures:1, needed:signatureThreshold(state,0.20) }));
      break;
    }

    case 'HOST_REMOVAL_SIGNED': {
      const removal = state.hostRemoval;
      if (!removal || removal.status !== 'petition') throw new Error('No Host removal petition is collecting signatures.');
      const player = requirePlayer(state, action.playerId); ensureActivePlayer(player);
      if (!removal.signatures.includes(player.id)) removal.signatures.push(player.id);
      const needed = signatureThreshold(state,0.20);
      if (removal.signatures.length >= needed) {
        const voteId = createInternalVote(state, { title:'Remove the Host?', actorId:action.actorId ?? player.id, secret:true, durationMinutes:2880, settings:{ approvalRequirement:0.90, turnoutRequirement:0.50, inclusiveApproval:true, hostRemovalVote:true } });
        removal.voteId = voteId;
        removal.status = 'voting';
      }
      touch(state);
      addEvent(state, createEvent('HOST_REMOVAL_SIGNED', action.actorId ?? player.id, { signatures:removal.signatures.length, needed, voteId:removal.voteId }));
      break;
    }

    case 'MP_RESIGNED_SEAT': {
      const seat = state.legislature.seats.find(item => item.memberId === action.playerId && item.status === 'filled');
      if (!seat) throw new Error('That player does not hold a filled legislative seat.');
      vacateLegislativeSeatForPlayer(state, action.playerId, action.actorId ?? action.playerId, 'seat-resignation');
      touch(state);
      break;
    }

    case 'GOVERNMENT_FORMED': {
      const checked = validateGovernmentFormation(state, action.partyIds, action.primeMinisterId);
      const now = nowIso();
      state.government = { status: 'active', primeMinisterId: checked.primeMinisterId, coalitionPartyIds: checked.partyIds, ministers: [], formedAt: now, caretakerSince: null, caretakerDeadline: null, earlyElectionRequired: false };
      for (const player of Object.values(state.players)) player.offices = (player.offices ?? []).filter(office => !['Prime Minister','Minister'].includes(office));
      const pm = state.players[checked.primeMinisterId];
      if (!pm.offices.includes('Prime Minister')) pm.offices.push('Prime Minister');
      touch(state);
      addEvent(state, createEvent('GOVERNMENT_FORMED', action.actorId, { partyIds: checked.partyIds, primeMinisterId: checked.primeMinisterId, coalitionSeats: checked.majority.coalitionSeats, required: checked.majority.required }));
      break;
    }

    case 'MINISTER_APPOINTED': {
      if (!['active','caretaker'].includes(state.government.status)) throw new Error('No government is in office.');
      if (state.government.ministers.length >= 5) throw new Error('The government already has the maximum of five ministers.');
      const player = requirePlayer(state, action.playerId);
      ensureActivePlayer(player);
      if (state.government.ministers.some(item => item.playerId === player.id)) throw new Error('That player is already a minister.');
      const portfolio = action.portfolio?.trim();
      if (!portfolio) throw new Error('Ministerial portfolio cannot be empty.');
      state.government.ministers.push({ playerId: player.id, portfolio, appointedAt: nowIso() });
      if (!player.offices.includes('Minister')) player.offices.push('Minister');
      touch(state);
      addEvent(state, createEvent('MINISTER_APPOINTED', action.actorId, { playerId: player.id, portfolio }));
      break;
    }

    case 'MINISTER_DISMISSED': {
      const index = state.government.ministers.findIndex(item => item.playerId === action.playerId);
      if (index < 0) throw new Error('That player is not a minister.');
      const [minister] = state.government.ministers.splice(index, 1);
      const player = state.players[minister.playerId];
      if (player) player.offices = (player.offices ?? []).filter(office => office !== 'Minister');
      touch(state);
      addEvent(state, createEvent('MINISTER_DISMISSED', action.actorId, { playerId: minister.playerId, portfolio: minister.portfolio }));
      break;
    }

    case 'GOVERNMENT_SET_CARETAKER': {
      if (state.government.status === 'not-formed' || state.government.status === 'forming') throw new Error('No formed government exists.');
      state.government.status = 'caretaker';
      state.government.caretakerSince = nowIso();
      state.government.caretakerDeadline = new Date(currentNowMs() + 72 * 3600000).toISOString();
      state.government.earlyElectionRequired = false;
      touch(state);
      addEvent(state, createEvent('GOVERNMENT_SET_CARETAKER', action.actorId, { reason: action.reason ?? 'manual' }));
      break;
    }

    case 'LEGISLATIVE_VOTE_CREATED': {
      if (!filledLegislativeSeats(state).length) throw new Error('There is no functioning legislature.');
      const title = action.title?.trim();
      if (!title) throw new Error('Motion title cannot be empty.');
      const id = createId('vote');
      state.votes[id] = {
        id, title, type: 'yes-no-abstain', electionKind: null, committee: null, status: 'draft', secret: false, createdAt: nowIso(), createdBy: action.actorId ?? null, opensAt: null, closesAt: null, durationMinutes: Math.max(1, Number(action.durationMinutes) || 1440), electorateSnapshot: [], options: [{id:'yes',label:'Yes'},{id:'no',label:'No'},{id:'abstain',label:'Abstain'}], ballots: {}, sealedBallots: [], submittedVoters: {}, secretBallotMode: null, secretBoxPublicKey: null, secretBoxHolderPlayerId: null, revealedChoices: null, revealedPrivateKey: null, settings: { electorateMode: 'legislature', legislativeMajority: true, motionKind: action.motionKind ?? 'ordinary', replacementPartyIds: deepClone(action.replacementPartyIds ?? []), replacementPrimeMinisterId: action.replacementPrimeMinisterId ?? null }, result: null, certifiedAt: null, certifiedBy: null
      };
      touch(state);
      addEvent(state, createEvent('LEGISLATIVE_VOTE_CREATED', action.actorId, { voteId: id, title }));
      break;
    }

    case 'CHECK_GOVERNMENT_FORMATION_DEADLINE': {
      if (state.government.status !== 'caretaker' || !state.government.caretakerDeadline) throw new Error('There is no active caretaker formation deadline.');
      if (currentNowMs() < new Date(state.government.caretakerDeadline).getTime()) throw new Error('The 72-hour government formation period has not expired.');
      state.government.earlyElectionRequired = true;
      touch(state);
      addEvent(state, createEvent('EARLY_ELECTION_REQUIRED', action.actorId, { deadline: state.government.caretakerDeadline }));
      break;
    }

    case 'COMMITTEE_CHAIR_SET': {
      const committee = state.committees[action.committee];
      if (!committee) throw new Error('Committee not found.');
      if (!committee.members.includes(action.playerId)) throw new Error('Chair must be a seated committee member.');
      committee.chairId = action.playerId;
      touch(state);
      addEvent(state, createEvent('COMMITTEE_CHAIR_SET', action.actorId, { committee: action.committee, playerId: action.playerId }));
      break;
    }

    case 'COMMITTEE_MATTER_CREATED': {
      const committee = state.committees[action.committee];
      if (!committee) throw new Error('Committee not found.');
      const title = action.title?.trim();
      if (!title) throw new Error('Matter title cannot be empty.');
      const matter = { id: createId(`matter-${action.committee.toLowerCase()}`), title, description: action.description?.trim() ?? '', createdAt: nowIso(), status: 'open', recusedIds: [], voteId: null, decision: null };
      committee.matters ??= [];
      committee.matters.push(matter);
      touch(state);
      addEvent(state, createEvent('COMMITTEE_MATTER_CREATED', action.actorId, { committee: action.committee, matterId: matter.id, title }));
      break;
    }

    case 'COMMITTEE_MEMBER_RECUSED': {
      const committee = state.committees[action.committee];
      const matter = committee?.matters?.find(m => m.id === action.matterId);
      if (!matter) throw new Error('Committee matter not found.');
      if (!committee.members.includes(action.playerId)) throw new Error('Player is not a committee member.');
      matter.recusedIds ??= [];
      if (!matter.recusedIds.includes(action.playerId)) matter.recusedIds.push(action.playerId);
      touch(state);
      addEvent(state, createEvent('COMMITTEE_MEMBER_RECUSED', action.actorId, { committee: action.committee, matterId: matter.id, playerId: action.playerId }));
      break;
    }

    case 'COMMITTEE_VOTE_CREATED': {
      const committee = state.committees[action.committee];
      const matter = committee?.matters?.find(m => m.id === action.matterId);
      if (!matter) throw new Error('Committee matter not found.');
      const eligible = committee.members.filter(id => !(matter.recusedIds ?? []).includes(id));
      if (eligible.length < 3) throw new Error('At least three non-recused committee members are required.');
      const voteId = createInternalVote(state, { title: `${action.committee} — ${matter.title}`, actorId: action.actorId, secret: false, durationMinutes: 4320, settings: { eligiblePlayerIds: eligible, fixedYesRequired: ordinaryMajority(eligible.length), committeeMatterId: matter.id, committeeCode: action.committee } });
      matter.voteId = voteId;
      matter.status = 'voting';
      touch(state);
      addEvent(state, createEvent('COMMITTEE_VOTE_CREATED', action.actorId, { committee: action.committee, matterId: matter.id, voteId }));
      break;
    }

    case 'CONSTITUTION_BASE_UNLOCK_AC_VOTE_CREATED': {
      const proposal = state.constitution.unlockProposals[action.proposalId];
      if (!proposal) throw new Error('Base-rule unlock proposal not found.');
      if (proposal.status !== 'awaiting-ac') throw new Error('This proposal is not awaiting AC approval.');
      const committee = state.committees.AC;
      if (!committee?.members?.length) throw new Error('The Actions Committee has not been elected yet.');
      const eligible = committee.members;
      const voteId = createInternalVote(state, { title: `AC approval — ${proposal.id}`, actorId: action.actorId, secret: false, durationMinutes: 4320, settings: { eligiblePlayerIds: eligible, fixedYesRequired: twoThirds(eligible.length), baseUnlockProposalId: proposal.id, committeeCode: 'AC' } });
      proposal.acVoteId = voteId;
      proposal.status = 'ac-vote';
      touch(state);
      addEvent(state, createEvent('BASE_UNLOCK_AC_VOTE_CREATED', action.actorId, { proposalId: proposal.id, voteId }));
      break;
    }

    case 'CASE_OPENED': {
      const accused = requirePlayer(state, action.accusedId);
      const complainant = requirePlayer(state, action.complainantId);
      const law = state.laws[action.lawId];
      if (!law || law.status !== 'in-force') throw new Error('Select a law currently in force.');
      const conduct = action.conduct?.trim();
      if (!conduct) throw new Error('Alleged conduct is required.');
      const id = nextCaseId(state.cases);
      state.cases[id] = { id, accusedId: accused.id, complainantId: complainant.id, lawId: law.id, conduct, evidence: action.evidence?.trim() ?? '', openedAt: nowIso(), status: 'open', accusedResponse: '', pacPanel: [], pacFinding: null, jury: [], previousJurors: [], ppcPunishment: null, conflictedPlayerIds: [] };
      touch(state);
      addEvent(state, createEvent('CASE_OPENED', action.actorId, { caseId: id, accusedId: accused.id, lawId: law.id }));
      break;
    }

    case 'CASE_RESPONSE_SUBMITTED': {
      const c = state.cases[action.caseId];
      if (!c) throw new Error('Case not found.');
      c.accusedResponse = action.response?.trim() ?? '';
      c.responseSubmittedAt = nowIso();
      touch(state);
      addEvent(state, createEvent('CASE_RESPONSE_SUBMITTED', action.actorId, { caseId: c.id }));
      break;
    }

    case 'CASE_PAC_PANEL_ASSIGNED': {
      const c = state.cases[action.caseId];
      if (!c) throw new Error('Case not found.');
      const committee = state.committees.PAC;
      let pool = [...(committee.members ?? []), ...(committee.alternates ?? [])].filter(id => ![c.accusedId, c.complainantId, ...(c.conflictedPlayerIds ?? [])].includes(id));
      if (pool.length < 3) pool = Object.values(state.players).filter(p => p.status === 'active' && ![c.accusedId,c.complainantId,...pool].includes(p.id)).map(p=>p.id).concat(pool);
      c.pacPanel = deterministicPick([...new Set(pool)], 3);
      if (c.pacPanel.length < 3) throw new Error('Not enough eligible players for a PAC panel.');
      c.status = 'pac-review';
      touch(state);
      addEvent(state, createEvent('CASE_PAC_PANEL_ASSIGNED', action.actorId, { caseId: c.id, panel: c.pacPanel }));
      break;
    }

    case 'CASE_PAC_VOTE_CREATED': {
      const c = state.cases[action.caseId];
      if (!c || c.pacPanel.length < 3) throw new Error('Assign a PAC panel first.');
      const voteId = createInternalVote(state, { title: `${c.id} — PAC finding (Yes = Guilty)`, actorId: action.actorId, secret: false, durationMinutes: 4320, settings: { eligiblePlayerIds: c.pacPanel, fixedYesRequired: 2, caseId: c.id, caseStage: 'pac' } });
      c.pacVoteId = voteId;
      c.status = 'pac-voting';
      touch(state);
      addEvent(state, createEvent('CASE_PAC_VOTE_CREATED', action.actorId, { caseId: c.id, voteId }));
      break;
    }

    case 'CASE_JURY_SELECTED': {
      const c = state.cases[action.caseId];
      if (!c || c.status !== 'awaiting-jury') throw new Error('This case is not awaiting a jury.');
      const pool = eligibleJurors(state, c);
      c.jury = deterministicPick(pool, 5);
      if (c.jury.length < 5) throw new Error('Not enough eligible players for a five-person jury.');
      c.status = 'jury-ready';
      touch(state);
      addEvent(state, createEvent('CASE_JURY_SELECTED', action.actorId, { caseId: c.id, jury: c.jury }));
      break;
    }

    case 'CASE_JURY_VOTE_CREATED': {
      const c = state.cases[action.caseId];
      if (!c || c.jury.length < 4) throw new Error('Select a jury first.');
      const voteId = createInternalVote(state, { title: `${c.id} — Jury review (Yes = Uphold Guilty finding)`, actorId: action.actorId, secret: true, durationMinutes: 4320, settings: { eligiblePlayerIds: c.jury, fixedYesRequired: ordinaryMajority(c.jury.length), caseId: c.id, caseStage: 'jury' } });
      c.juryVoteId = voteId;
      c.status = 'jury-voting';
      touch(state);
      addEvent(state, createEvent('CASE_JURY_VOTE_CREATED', action.actorId, { caseId: c.id, voteId }));
      break;
    }

    case 'CASE_PPC_PUNISHMENT_RECORDED': {
      const c = state.cases[action.caseId];
      if (!c || c.status !== 'awaiting-ppc') throw new Error('This case is not awaiting PPC punishment.');
      const punishment = action.punishment?.trim();
      if (!punishment) throw new Error('Punishment is required.');
      c.ppcPunishment = { text: punishment, imposedAt: nowIso(), imposedBy: action.actorId ?? null };
      c.status = 'closed-guilty';
      c.closedAt = nowIso();
      touch(state);
      addEvent(state, createEvent('CASE_PUNISHMENT_RECORDED', action.actorId, { caseId: c.id, punishment }));
      break;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  currentState = state;
  publish();
  return getState();
}

export function clearGame() {
  currentState = null;
  publish();
}


export function dispatchDeterministic(action, { seed, timestamp } = {}) {
  if (!seed) throw new Error('Deterministic online actions require a transition seed.');
  if (!Number.isFinite(Number(timestamp))) throw new Error('Deterministic online actions require a valid timestamp.');
  return withDeterministicContext({ seed, timestamp: Number(timestamp) }, () => dispatch(action));
}

export function simulateDeterministicAction(baseState, action, { seed, timestamp } = {}) {
  if (!baseState) throw new Error('A base state is required for transition simulation.');
  const saved = currentState;
  suppressPublish += 1;
  try {
    currentState = normalizeStateShape(deepClone(baseState));
    return dispatchDeterministic(action, { seed, timestamp });
  } finally {
    currentState = saved;
    suppressPublish -= 1;
  }
}
