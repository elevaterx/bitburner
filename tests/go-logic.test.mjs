import test from "node:test";
import assert from "node:assert/strict";
import { neighbors, scoreMove, chooseMove } from "../lib/go-logic.js";

// Board is board[x][y]. Build helpers from row-strings for readability, transposed to [x][y].
function boardFrom(rows) {
  const size = rows.length;
  const b = [];
  for (let x = 0; x < size; x++) { let s = ""; for (let y = 0; y < size; y++) s += rows[y][x]; b.push(s); }
  return b;
}
// uniform liberties grid
const libGrid = (size, val) => Array.from({ length: size }, () => Array.from({ length: size }, () => val));
const validAllEmpty = (board) => board.map((col) => [...col].map((c) => c === "."));

test("neighbors: bounded", () => {
  assert.equal(neighbors(0, 0, 5).length, 2);
  assert.equal(neighbors(2, 2, 5).length, 4);
  assert.equal(neighbors(4, 4, 5).length, 2);
});

test("chooseMove: takes the capturing move", () => {
  // 3x3. Opponent 'O' at (1,1) with exactly 1 liberty; playing that liberty captures.
  const board = boardFrom([
    "X.X",
    "XOX",
    "...",
  ]);
  const size = board.length;
  // liberties: the O chain has 1 liberty. Mark liberties[1][1]=1 (the stone), others don't matter much.
  const liberties = libGrid(size, -1);
  liberties[1][1] = 1; // O at x=1,y=1 (see transpose) has 1 lib
  // Find where O actually is and set neighbor scoring; ensure the empty point adjacent to it wins.
  const valid = validAllEmpty(board);
  const mv = chooseMove(board, valid, liberties);
  assert.ok(mv, "should pick a move");
  // The capturing empty point is the one orthogonally adjacent to the O stone.
  // Locate O:
  let ox = -1, oy = -1;
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) if (board[x][y] === "O") { ox = x; oy = y; }
  const adjToO = neighbors(ox, oy, size).some(([nx, ny]) => nx === mv.x && ny === mv.y);
  assert.ok(adjToO, "chosen move should be adjacent to the capturable O stone");
});

test("scoreMove: capture beats plain expansion", () => {
  const board = boardFrom([
    ".O.",
    "...",
    "...",
  ]);
  const size = board.length;
  const liberties = libGrid(size, -1);
  // find O
  let ox, oy;
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) if (board[x][y] === "O") { ox = x; oy = y; }
  liberties[ox][oy] = 1;
  // a point adjacent to O:
  const [cx, cy] = neighbors(ox, oy, size)[0];
  const capScore = scoreMove(board, liberties, cx, cy);
  // a far empty point (corner) not adjacent to O
  const farScore = scoreMove(board, liberties, size - 1, size - 1);
  assert.ok(capScore > farScore, "capturing move should outscore a plain expansion");
});

test("chooseMove: passes when no legal moves", () => {
  const board = boardFrom(["XX", "XX"]);
  const valid = validAllEmpty(board); // all false (no empties)
  assert.equal(chooseMove(board, valid, libGrid(2, -1)), null);
});

test("scoreMove: self-atari penalised", () => {
  // Surround an empty point by opponents with plenty of liberties (no capture) -> filling it is self-atari.
  const board = boardFrom([
    ".O.",
    "O.O",
    ".O.",
  ]);
  const size = board.length;
  const liberties = libGrid(size, 5); // all O chains healthy -> no capture
  const s = scoreMove(board, liberties, 1, 1); // center, surrounded by O
  assert.ok(s < 0, "self-atari into healthy enemies should score negative");
});
