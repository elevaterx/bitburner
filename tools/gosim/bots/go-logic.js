/** lib/go-logic.js -- pure IPvGO (Go) move engine. NO ns calls; unit-tested.
 *
 *  Single-ply SIMULATION scorer (an upgrade from the old adjacency scorer, which only peeked at a
 *  point's neighbors and never actually played the move). For each legal move it places the stone on a
 *  scratch copy of the board, removes any enemy chain that loses its last liberty, then scores the
 *  RESULTING position. That gives it the tactics the old scorer structurally could not have:
 *    - CAPTURE:        dead enemy chains are actually removed; taken stones are rewarded.
 *    - ATARI DEFENSE:  saving a friendly chain that was down to its last liberty scores high.
 *    - ATARI ATTACK:   putting an enemy chain into atari (1 liberty) is rewarded.
 *    - SELF-ATARI:     a move whose own resulting chain has 1 liberty and captures nothing is punished.
 *    - EYE PRESERVATION: filling one of your own real eyes (which would kill the group) is punished.
 *    - TERRITORY / INFLUENCE: expansion into empty space and off the 1st line.
 *  It is single-ply (no lookahead / search), so it will not out-read the strongest subnets, but it
 *  plays sound shape and stops handing games away on tactics.
 *
 *  Board is string[] with board[x][y] in {".","X","O","#"}: "X"=you (black), "O"=opponent (white),
 *  "."=empty, "#"=dead/offline node. valid[x][y] (ns.go.analysis.getValidMoves) marks legal moves.
 *  Capture/liberty/eye logic is transpose-invariant, so the exact row/col convention does not matter as
 *  long as move (x,y) is fed straight back to ns.go.makeMove(x,y). */

export const ME = "X", OPP = "O", EMPTY = ".", DEAD = "#";

export function neighbors(x, y, size) {
  const out = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < size - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < size - 1) out.push([x, y + 1]);
  return out;
}

function diagonals(x, y, size) {
  const out = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < size && ny >= 0 && ny < size) out.push([nx, ny]);
  }
  return out;
}

/** Mutable grid[x][y] of chars from the board string[]. */
export function toGrid(board) { return board.map((col) => col.split("")); }

/** The chain (connected same-colour stones) through (x,y) plus its liberty count. Pure. */
export function group(grid, x, y) {
  const size = grid.length, color = grid[x][y];
  const seen = new Set([x + "," + y]), stones = [[x, y]], libs = new Set();
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    for (const [nx, ny] of neighbors(cx, cy, size)) {
      const c = grid[nx][ny];
      if (c === EMPTY) libs.add(nx + "," + ny);
      else if (c === color) { const k = nx + "," + ny; if (!seen.has(k)) { seen.add(k); stones.push([nx, ny]); stack.push([nx, ny]); } }
    }
  }
  return { stones, libs: libs.size };
}

/** Simulate ME playing (x,y): capture any enemy chain left with 0 liberties; report the result. Pure. */
export function simulateMove(board, x, y) {
  const size = board.length, g = toGrid(board);
  g[x][y] = ME;
  let captured = 0;
  const done = new Set();
  for (const [nx, ny] of neighbors(x, y, size)) {
    if (g[nx][ny] === OPP && !done.has(nx + "," + ny)) {
      const grp = group(g, nx, ny);
      for (const [sx, sy] of grp.stones) done.add(sx + "," + sy);
      if (grp.libs === 0) for (const [sx, sy] of grp.stones) { g[sx][sy] = EMPTY; captured++; }
    }
  }
  const mine = group(g, x, y);
  return { grid: g, captured, myLibs: mine.libs, mySize: mine.stones.length };
}

/** True if empty (x,y) is one of ME's real eyes: every orthogonal neighbour is mine, and enough
 *  diagonals are mine (all present ones on an edge/corner; >= 3 of 4 in the centre). Pure. */
export function isMyEye(grid, x, y) {
  const size = grid.length;
  for (const [nx, ny] of neighbors(x, y, size)) if (grid[nx][ny] !== ME) return false;
  const diag = diagonals(x, y, size);
  let mine = 0; for (const [dx, dy] of diag) if (grid[dx][dy] === ME) mine++;
  const allowedNonMine = diag.length === 4 ? 1 : 0;   // centre tolerates one false corner; edge/corner none
  return (diag.length - mine) <= allowedNonMine;
}

/** Heuristic score for playing legal, empty (x,y). Higher is better. Pure. */
export function evaluateMove(board, x, y) {
  const size = board.length, grid = toGrid(board);

  // pre-move context on the real board
  let emptyNb = 0, enemyAdj = 0, friendAtari = 0;
  const seenPre = new Set();
  for (const [nx, ny] of neighbors(x, y, size)) {
    const c = grid[nx][ny];
    if (c === EMPTY) emptyNb++;
    else if (c === OPP) enemyAdj++;
    else if (c === ME) {
      const k = nx + "," + ny;
      if (!seenPre.has(k)) { const g = group(grid, nx, ny); for (const [sx, sy] of g.stones) seenPre.add(sx + "," + sy); if (g.libs === 1) friendAtari++; }
    }
  }

  const sim = simulateMove(board, x, y);
  if (sim.myLibs === 0 && sim.captured === 0) return -1e9;   // suicide (guard; getValidMoves excludes it)

  let score = 0;
  score += sim.captured * 200;                               // captures dominate
  if (friendAtari > 0 && sim.myLibs >= 2) score += 160 * friendAtari;   // rescued a group in atari
  if (sim.myLibs === 1 && sim.captured === 0) score -= 220;             // self-atari
  score += 6 * Math.min(sim.myLibs, 5);                      // resulting-group safety (diminishing)

  // atari the enemy: adjacent enemy chains left at 1 liberty on the simulated board
  const seenPost = new Set();
  for (const [nx, ny] of neighbors(x, y, size)) {
    if (sim.grid[nx][ny] === OPP && !seenPost.has(nx + "," + ny)) {
      const g = group(sim.grid, nx, ny);
      for (const [sx, sy] of g.stones) seenPost.add(sx + "," + sy);
      if (g.libs === 1) score += 40;
    }
  }

  score += emptyNb * 6;                                      // expand into space
  score += enemyAdj * 4;                                     // contact / pressure
  if (isMyEye(grid, x, y)) score -= 140;                     // never fill your own eye

  const edge = Math.min(x, y, size - 1 - x, size - 1 - y);   // influence: favour the 3rd/4th line
  if (edge === 0) score -= 10;        // 1st line: weak
  else if (edge === 2) score += 4;    // 3rd line: strongest on small boards
  else if (edge === 3) score += 3;    // 4th line
  else if (edge >= 4) score += 1;     // centre
  // edge === 1 (2nd line): neutral, no adjustment
  return score;
}

/** Best legal move, or null to pass. Passes only when nothing constructive remains (every legal move
 *  is self-atari / eye-fill / suicide). Pure. valid[x][y] === true marks a legal move. */
export function chooseMove(board, valid) {
  const size = board.length;
  let best = null, bestScore = -Infinity;
  for (let x = 0; x < size; x++) {
    if (!valid[x]) continue;
    for (let y = 0; y < size; y++) {
      if (!valid[x][y] || board[x][y] !== EMPTY) continue;
      const s = evaluateMove(board, x, y);
      if (s > bestScore) { bestScore = s; best = { x, y }; }
    }
  }
  if (!best || bestScore <= 0) return null;
  return best;
}
