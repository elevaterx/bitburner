import test from "node:test";
import assert from "node:assert/strict";
import { neighbors, group, toGrid, simulateMove, isMyEye, evaluateMove, chooseMove } from "../lib/go-logic.js";

// Boards are given directly as column-strings (board[x] = column x, board[x][y] = char).
const validEmpties = (b) => b.map((col) => [...col].map((c) => c === "."));

test("neighbors: bounded", () => {
  assert.equal(neighbors(0, 0, 5).length, 2);
  assert.equal(neighbors(2, 2, 5).length, 4);
  assert.equal(neighbors(4, 4, 5).length, 2);
});

test("group: counts liberties of a lone stone", () => {
  const b = ["...", ".X.", "..."];
  assert.equal(group(toGrid(b), 1, 1).libs, 4);
});

// O at (1,1) with a single liberty at (1,2); X there captures it.
const capBoard = [".X.", "XO.", ".X."];

test("simulateMove: captures an enemy chain in atari", () => {
  const sim = simulateMove(capBoard, 1, 2);
  assert.equal(sim.captured, 1);
  assert.equal(sim.grid[1][1], ".");   // the O stone was removed
});

test("evaluateMove: capture outscores plain expansion", () => {
  assert.ok(evaluateMove(capBoard, 1, 2) > evaluateMove(capBoard, 0, 0));
});

test("chooseMove: takes the capturing move", () => {
  const mv = chooseMove(capBoard, validEmpties(capBoard));
  assert.deepEqual(mv, { x: 1, y: 2 });
});

test("evaluateMove: self-atari is penalised, expansion is not", () => {
  const b = ["OO.", ".O.", "..."];        // (0,2) has one empty neighbour + one enemy -> self-atari
  assert.ok(evaluateMove(b, 0, 2) < 0);
  assert.ok(evaluateMove(b, 2, 2) > 0);    // open corner-ish expansion
});

test("isMyEye: true when surrounded by own stones, false otherwise", () => {
  const eye = ["XXX", "X.X", "XXX"];
  assert.equal(isMyEye(toGrid(eye), 1, 1), true);
  const notEye = ["XXX", "X.X", "OXO"];    // two enemy diagonals -> not a real eye
  assert.equal(isMyEye(toGrid(notEye), 1, 1), false);
});

test("chooseMove: refuses to fill its own eye / suicide (passes)", () => {
  const eye = ["XXX", "X.X", "XXX"];       // only empty is the eye; filling it is suicide
  assert.equal(chooseMove(eye, validEmpties(eye)), null);
});

test("chooseMove: passes when there are no legal moves", () => {
  const b = ["XX", "XX"];
  assert.equal(chooseMove(b, validEmpties(b)), null);
});
