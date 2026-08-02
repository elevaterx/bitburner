/** lib/go-logic.js -- pure IPvGO (Go) move logic. NO ns calls. Unit-tested.
 *  Single-ply greedy scorer (not a search): reward captures and atari rescues, expansion into empty
 *  space, and the 2nd line; avoid self-atari. Board is string[] with board[x][y] in {".","X","O","#"}
 *  where "X" = your stones, "O" = opponent, "." = empty, "#" = dead node. valid[x][y] and
 *  liberties[x][y] use the same indexing (liberties = the chain's liberty count, -1 for empty). */

export function neighbors(x, y, size) {
  const out = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < size - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < size - 1) out.push([x, y + 1]);
  return out;
}

/** Heuristic value of playing at an empty, legal point. Pure. */
export function scoreMove(board, liberties, x, y) {
  const size = board.length;
  let score = 0, empties = 0, capture = false, safeFriend = false;
  for (const [nx, ny] of neighbors(x, y, size)) {
    const ch = board[nx][ny];
    const lib = liberties[nx][ny];
    if (ch === "O") { if (lib === 1) { score += 1000; capture = true; } else score += 2; }
    else if (ch === "X") { if (lib === 1) score += 500; else { score += 5; if (lib > 1) safeFriend = true; } }
    else if (ch === ".") { empties++; score += 12; }
    // "#" dead node contributes nothing
  }
  // Self-atari guard: no liberties opened, not a capture, not connecting to a safe friendly group.
  if (!capture && empties === 0 && !safeFriend) score -= 5000;

  const edgeDist = Math.min(x, y, size - 1 - x, size - 1 - y);
  if (edgeDist === 0) score -= 3;        // first line: usually poor
  else if (edgeDist === 1) score += 2;   // second line: good
  return score;
}

/** Pick the best legal move, or null to pass. Pure.
 *  valid[x][y] === true marks a legal move. Passes if there are no legal moves, or the best available
 *  is still a self-atari (score very negative). */
export function chooseMove(board, valid, liberties) {
  const size = board.length;
  let best = null, bestScore = -Infinity;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (!valid[x] || !valid[x][y]) continue;
      const s = scoreMove(board, liberties, x, y);
      if (s > bestScore) { bestScore = s; best = { x, y }; }
    }
  }
  if (!best || bestScore <= -1000) return null;
  return best;
}
