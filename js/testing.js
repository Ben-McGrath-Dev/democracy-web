import { largestRemainderAllocation, countRankedChoice, tallyVote, VOTE_TYPES, validateBallot } from './voting.js';
import { legislatureSeatCount, committeeSeatCount } from './elections.js';
import { majorityThreshold } from './legislature.js';
import { ordinaryMajority, twoThirds } from './committees.js';
import { auditState } from './diagnostics.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(rng, input) {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function runRulePropertySuite({ iterations = 2000, seed = 0xD3A0C4 } = {}) {
  const rng = mulberry32(seed);
  const started = performance.now();
  const failures = [];
  let assertions = 0;
  const check = (condition, name, detail = '') => {
    assertions += 1;
    if (!condition && failures.length < 50) failures.push({ name, detail });
  };

  for (let i = 0; i < iterations; i++) {
    const playerCount = randInt(rng, 1, 180);
    const seats = legislatureSeatCount(playerCount);
    check([7, 10, 15, 20].includes(seats), 'legislature size valid', `${playerCount} -> ${seats}`);
    check(majorityThreshold(seats) === Math.floor(seats / 2) + 1, 'legislative majority formula');
    const csize = committeeSeatCount(playerCount);
    check([3, 5, 7, 9].includes(csize), 'committee size valid', `${playerCount} -> ${csize}`);
    check(ordinaryMajority(csize) === Math.floor(csize / 2) + 1, 'committee ordinary majority formula');
    check(twoThirds(csize) === Math.ceil(csize * 2 / 3), 'committee two-thirds formula');

    const optionCount = randInt(rng, 2, 8);
    const options = Array.from({ length: optionCount }, (_, n) => ({ id: `p${n}`, label: `Party ${n}` }));
    const ballotCount = randInt(rng, 1, Math.max(2, playerCount));
    const ballots = Array.from({ length: ballotCount }, () => pick(rng, options).id);
    const alloc = largestRemainderAllocation(options, ballots, seats, 0.1);
    const allocated = Object.values(alloc.seats).reduce((a, b) => a + b, 0);
    check(allocated === seats || alloc.qualifyingIds.length === 0, 'seat allocation total', `${allocated}/${seats}`);
    check(Object.values(alloc.seats).every(n => Number.isInteger(n) && n >= 0), 'seat counts nonnegative integers');
    check(Object.keys(alloc.seats).length === optionCount, 'all options represented in seat map');

    const candidateCount = randInt(rng, 2, 7);
    const candidates = Array.from({ length: candidateCount }, (_, n) => ({ id: `c${n}`, label: `Candidate ${n}` }));
    const rankedBallots = Array.from({ length: randInt(rng, 1, 80) }, () => shuffle(rng, candidates.map(c => c.id)).slice(0, randInt(rng, 1, candidateCount)));
    const rc = countRankedChoice(candidates, rankedBallots);
    check(Boolean(rc.winnerId) !== Boolean(rc.tie), 'ranked choice resolves to winner xor tie');
    check(rc.rounds.length >= 1 && rc.rounds.length <= candidateCount, 'ranked choice round bounds');
    if (rc.winnerId) check(candidates.some(c => c.id === rc.winnerId), 'ranked winner is valid candidate');

    const vote = {
      id: 'test', type: VOTE_TYPES.YES_NO_ABSTAIN,
      options: [{ id: 'yes' }, { id: 'no' }, { id: 'abstain' }],
      ballots: {}, electorateSnapshot: Array.from({ length: playerCount }, (_, n) => `v${n}`),
      settings: { turnoutRequirement: 0.25, approvalRequirement: 0.5 }
    };
    const voters = randInt(rng, 0, playerCount);
    for (let n = 0; n < voters; n++) vote.ballots[`v${n}`] = { choice: pick(rng, ['yes', 'no', 'abstain']) };
    const result = tallyVote(vote);
    check(result.turnout.cast === voters, 'turnout cast count');
    check(result.turnout.rate >= 0 && result.turnout.rate <= 1, 'turnout bounded');
    check(result.counts.yes + result.counts.no + result.counts.abstain === voters, 'yes/no/abstain count conservation');
  }

  const invalidVote = { type: VOTE_TYPES.RANKED, options: [{ id: 'a' }, { id: 'b' }], settings: {} };
  let rejected = false;
  try { validateBallot(invalidVote, ['a', 'a']); } catch { rejected = true; }
  check(rejected, 'duplicate ranked choices rejected');

  return {
    ok: failures.length === 0,
    iterations,
    assertions,
    failures,
    seed,
    durationMs: performance.now() - started
  };
}

function utf8Bytes(text) { return new TextEncoder().encode(text).byteLength; }

export function runSyntheticStressSuite(state, { seed = 0x51A7E, samples = 600 } = {}) {
  const rng = mulberry32(seed);
  const started = performance.now();
  const stateJson = JSON.stringify(state ?? {});
  const stateBytes = utf8Bytes(stateJson);
  const scales = [2, 10, 25, 50, 100];
  const fanout = scales.map(players => ({
    players,
    peers: Math.max(0, players - 1),
    oneFullBroadcastBytes: stateBytes * Math.max(0, players - 1),
    tenFullBroadcastsBytes: stateBytes * Math.max(0, players - 1) * 10
  }));

  const options = Array.from({ length: 8 }, (_, i) => ({ id: `party-${i}`, label: `Party ${i}` }));
  const benchmarkStarted = performance.now();
  let allocations = 0;
  let rankedCounts = 0;
  for (let i = 0; i < samples; i++) {
    const electorate = pick(rng, scales);
    const ballots = Array.from({ length: electorate }, () => pick(rng, options).id);
    largestRemainderAllocation(options, ballots, legislatureSeatCount(electorate), 0.1);
    allocations += 1;
    const candidates = options.slice(0, 5);
    const ranked = Array.from({ length: electorate }, () => shuffle(rng, candidates.map(c => c.id)));
    countRankedChoice(candidates, ranked);
    rankedCounts += 1;
  }
  const benchmarkMs = performance.now() - benchmarkStarted;

  const auditStarted = performance.now();
  const audit = state ? auditState(state) : { ok: true, errors: 0, warnings: 0 };
  const auditMs = performance.now() - auditStarted;

  return {
    ok: audit.errors === 0,
    stateBytes,
    stateKiB: stateBytes / 1024,
    fanout,
    benchmark: {
      samples,
      allocations,
      rankedCounts,
      durationMs: benchmarkMs,
      operationsPerSecond: benchmarkMs ? (allocations + rankedCounts) / (benchmarkMs / 1000) : Infinity
    },
    audit: { ...audit, durationMs: auditMs },
    durationMs: performance.now() - started,
    note: 'Synthetic stress measures state size, fan-out cost, counting throughput and state integrity. Real WebRTC connection success still depends on actual browsers/NATs and should be measured during alpha.'
  };
}
