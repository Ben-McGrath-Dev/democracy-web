import { simulateDeterministicAction } from './state.js';
import { canonicalStateHash } from './integrity.js';

/**
 * Apply one deterministic Democracy transition without retaining module state.
 * Both browser networking and the Cloudflare Worker use this exact function.
 */
export function reduceDeterministic(state, action, context) {
  const nextState = simulateDeterministicAction(state, action, context);
  return { state: nextState, stateHash: canonicalStateHash(nextState) };
}
