// harness.mjs -- plays a single IPvGO game between a user bot (Black) and Bitburner's real
// opponent AI (White, via bbgo.mjs's getMove). Does not touch bbgo.mjs/build.mjs/entry.ts/stubs/.
//
// bbgo.mjs facts this file relies on (verified empirically against the bundled v3.0.2 source):
//   - boardState.previousPlayer starts as "White", so Black is always free to move first.
//   - makeMove/passTurn use boardState.previousPlayer to enforce turn order and reject illegal
//     moves; passTurn(..., allowEndGame) can optionally trigger the game's own endGoGame() side
//     effects (faction rep, global Go/Player state) -- we always pass allowEndGame=false and
//     score the game ourselves via getScore(), so no global game state is mutated.
//   - getAllValidMoves returns an ARRAY of PointState ({x,y,...}), not a boolean[][] -- despite
//     what a first read of the Bitburner types might suggest. We convert it to the boolean[][]
//     grid documented in this harness's own botMove contract.
//   - getMove's rngOverride seeds an internal WHRNG, but at least one internal tie-break
//     (getDefendMove) reads the *global* Math.random() directly, so rngOverride alone does not
//     make a game reproducible. See the `seed` handling below.

import {
  getNewBoardState,
  updateChains,
  makeMove,
  passTurn,
  getAllValidMoves,
  getMove,
  getScore,
  GoColor,
  GoOpponent,
  opponentDetails,
} from './bbgo.mjs';

// Small seeded PRNG (mulberry32), used only to make --seed reproducible end-to-end. We monkeypatch
// the GLOBAL Math.random for the duration of a single playGame() call (restored in a finally block)
// because bbgo.mjs itself reads Math.random() directly in a few places (handicap stone placement,
// one move tie-break) that are not reachable through getMove's rngOverride parameter.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toSimpleBoard(board) {
  return board.map((col) =>
    col.map((p) => (!p ? '#' : p.color === GoColor.black ? 'X' : p.color === GoColor.white ? 'O' : '.')).join('')
  );
}

function resolveOpponent(opponent) {
  if (opponent == null) return GoOpponent.w0r1d_d43m0n;
  if (typeof opponent === 'string' && GoOpponent[opponent] !== undefined) return GoOpponent[opponent];
  return opponent; // assume caller already passed a raw GoOpponent value
}

/**
 * @param {object} opts
 * @param {(simpleBoard: string[], valid: boolean[][], ctx: object) => (Promise<{x:number,y:number}|null> | {x:number,y:number} | null)} opts.botMove
 * @param {string} [opts.opponent] - GoOpponent key (e.g. "w0r1d_d43m0n") or raw value. Default w0r1d_d43m0n.
 * @param {number} [opts.size] - requested board size. Ignored by bbgo for w0r1d_d43m0n (always 19x19).
 * @param {number} [opts.seed] - if set, makes the whole game (setup + opponent AI + bot, via global
 *   Math.random) reproducible. Omit for genuine per-game randomness.
 * @param {number} [opts.maxMoves] - ply cap; default is (actual board size)^2 * 4, mirroring go.js.
 * @param {boolean} [opts.collectBoards] - if true, returned result includes `boards`: an array of
 *   simpleBoard snapshots, one per ply, for debugging/replay.
 * @returns {Promise<{won:boolean, blackScore:number, whiteScore:number, moves:number, illegal:number,
 *   abandoned:boolean, botMs:number, oppMs:number, komi:number, boards?:string[][]}>}
 */
export async function playGame(opts) {
  const { botMove, opponent, size = 19, seed, collectBoards = false } = opts;
  if (typeof botMove !== 'function') throw new Error('playGame: opts.botMove must be a function');

  const aiValue = resolveOpponent(opponent);

  const originalRandom = Math.random;
  let restoreRandom = null;
  if (seed !== undefined && seed !== null) {
    const rng = mulberry32(seed);
    Math.random = rng;
    restoreRandom = () => { Math.random = originalRandom; };
  }

  try {
    const board = getNewBoardState(size, aiValue);
    updateChains(board.board);

    const actualSize = board.board.length;
    const maxMoves = opts.maxMoves ?? actualSize * actualSize * 4;

    let illegal = 0;
    let botMs = 0;
    let oppMs = 0;
    let moveNumber = 0;
    let abandoned = false;
    const boards = collectBoards ? [] : undefined;
    let color = GoColor.black;

    while (true) {
      if (board.passCount >= 2) break;
      if (moveNumber >= maxMoves) { abandoned = true; break; }

      if (color === GoColor.black) {
        const validPoints = getAllValidMoves(board, GoColor.black);
        const validGrid = Array.from({ length: actualSize }, () => new Array(actualSize).fill(false));
        for (const p of validPoints) validGrid[p.x][p.y] = true;

        const simpleBoard = toSimpleBoard(board.board);
        if (boards) boards.push(simpleBoard);

        const ctx = {
          komi: board.komiOverride ?? getEffectiveKomi(board),
          moveNumber,
          boardState: board,
        };

        const t0 = performance.now();
        let mv;
        let threw = false;
        try {
          mv = await botMove(simpleBoard, validGrid, ctx);
        } catch (e) {
          threw = true;
          mv = null;
        }
        botMs += performance.now() - t0;

        if (threw) {
          illegal++;
          passTurn(board, GoColor.black, false);
        } else if (mv == null) {
          passTurn(board, GoColor.black, false);
        } else if (
          Number.isInteger(mv.x) && Number.isInteger(mv.y) &&
          validGrid[mv.x] && validGrid[mv.x][mv.y]
        ) {
          const ok = makeMove(board, mv.x, mv.y, GoColor.black);
          if (!ok) {
            // Shouldn't happen given validGrid agreement, but stay defensive.
            illegal++;
            passTurn(board, GoColor.black, false);
          }
        } else {
          illegal++;
          passTurn(board, GoColor.black, false);
        }
      } else {
        const t0 = performance.now();
        // CRITICAL: the seed must be a LARGE INTEGER, not Math.random().
        // WHRNG's constructor does `v = (seed/1000) % 30000`. A seed in [0,1) gives v ~= 5e-4, and
        // the Wichmann-Hill state needs several steps to grow into range -- so the 3rd draw (the one
        // that gates getIlluminatiPriorityMove's pattern/jump/weak-surround branches) collapses to a
        // mean of 0.247 instead of 0.505, lands in the "<=0.25: no pattern, NO jump" bucket 50% of
        // the time instead of 24%, and NEVER reaches the ">=0.6" bucket that fires 40% of the time
        // live. That is a materially weaker opponent and it biases every benchmark optimistic.
        // The live game seeds from Player.totalPlaytime in milliseconds; mirror that magnitude.
        const mv = await getMove(board, GoColor.white, aiValue, false, Math.floor(3e8 + Math.random() * 3e9));
        oppMs += performance.now() - t0;
        if (mv.type === 'move') {
          makeMove(board, mv.x, mv.y, GoColor.white);
        } else {
          passTurn(board, GoColor.white, false);
        }
      }

      color = color === GoColor.black ? GoColor.white : GoColor.black;
      moveNumber++;
    }

    const score = getScore(board);
    const won = score[GoColor.black].sum > score[GoColor.white].sum;

    const result = {
      won,
      blackScore: score[GoColor.black].sum,
      whiteScore: score[GoColor.white].sum,
      moves: moveNumber,
      illegal,
      abandoned,
      botMs,
      oppMs,
      komi: score[GoColor.white].komi,
      // Not part of the minimal spec'd shape, but cheap to include and needed by bench.mjs's
      // nodePower/difficulty-multiplier math (bbgo forces boardSize=19 for w0r1d_d43m0n
      // regardless of the requested `size`, so the caller can't assume it back).
      boardSize: actualSize,
    };
    if (boards) result.boards = boards;
    return result;
  } finally {
    if (restoreRandom) restoreRandom();
  }
}

// bbgo.mjs's own komi lookup (getKomi) isn't exported; opponentDetails[ai].komi covers every named
// opponent including w0r1d_d43m0n (9.5), and boardState.komiOverride (checked by the caller above)
// covers the only other source bbgo.mjs itself uses. This local fallback only fires if neither
// applies (defensive; getScore's own `komi` field is always the authoritative value in the result).
function getEffectiveKomi(board) {
  return opponentDetails[board.ai]?.komi ?? 6.5;
}
