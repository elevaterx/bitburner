// bots/current.mjs -- adapter around the user's live go.js bot (lib/go-mcts.js + lib/go-logic.js,
// copied verbatim into this directory; see go-mcts.js/go-logic.js headers). Reproduces the exact
// live call go.js makes each move, including the superko fallback to the single-ply heuristic.
//
// Live call (go.js):
//   mctsMove(board, { komi, iterations: ITERS, rng: Math.random, now: () => Date.now(),
//                      deadline: Date.now() + BUDGET, stats })
//   if (move && !(valid[move.x] && valid[move.x][move.y])) move = chooseMove(board, valid);
//
// ITERS/BUDGET default to 1500/600 -- the user's current go-ctl.txt live settings -- and are
// configurable via the `config` object passed to createBot({ iters, budget, stats }).
//
// Exports BOTH shapes bench.mjs understands:
//   - `createBot(config)` factory (bench.mjs prefers this so --bot-config style tuning is possible)
//   - a plain `default` bot function (createBot() with defaults), for direct use / other callers.

import { mctsMove } from './go-mcts.js';
import { chooseMove } from './go-logic.js';

export const DEFAULT_ITERS = 1500;
export const DEFAULT_BUDGET = 600;

/**
 * @param {object} [config]
 * @param {number} [config.iters=1500] - MCTS playouts per move (go.js's --iters / go-ctl.txt).
 * @param {number} [config.budget=600] - ms hard cap per move (go.js's --budget / go-ctl.txt).
 * @param {object} [config.stats] - optional external sink; accumulates {iters, moves, fallbacks}.
 * @returns {(board: string[], valid: boolean[][], ctx: {komi:number}) => ({x:number,y:number}|null)}
 */
export function createBot(config = {}) {
  const ITERS = config.iters ?? DEFAULT_ITERS;
  const BUDGET = config.budget ?? DEFAULT_BUDGET;
  const stats = config.stats;

  return function currentBot(board, valid, ctx) {
    const komi = ctx.komi;
    const _stats = {};
    let move = mctsMove(board, {
      komi,
      iterations: ITERS,
      rng: Math.random,
      now: () => Date.now(),
      deadline: Date.now() + BUDGET,
      stats: _stats,
    });
    const fellBack = !!(move && !(valid[move.x] && valid[move.x][move.y]));
    if (fellBack) move = chooseMove(board, valid);

    if (stats) {
      stats.iters = (stats.iters || 0) + (_stats.iters || 0);
      stats.moves = (stats.moves || 0) + 1;
      stats.fallbacks = (stats.fallbacks || 0) + (fellBack ? 1 : 0);
    }

    return move;
  };
}

export default createBot();
