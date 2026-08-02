import test from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32, boardToArr, nbTable, groupLibs, groupLibsCount, playInPlace,
  isLegal, isEyeFor, legalNonEyeMoves, scoreBlack, randomPlayout, mctsMove,
} from "../lib/go-mcts.js";

const ME = 1, OPP = 2;
const A = (board) => { const { arr, size } = boardToArr(board); return { arr, size, nb: nbTable(size) }; };

test("mulberry32: deterministic for a seed", () => {
  const a = mulberry32(42), b = mulberry32(42);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.ok(xs.every((v) => v >= 0 && v < 1));
});

test("groupLibs / groupLibsCount: lone stone liberties", () => {
  const { arr, nb } = A(["...", ".X.", "..."]);
  assert.equal(groupLibsCount(arr, nb, 1 * 3 + 1), 4);
  assert.equal(groupLibs(arr, nb, 1 * 3 + 1).libs, 4);
});

test("playInPlace: captures a 1-liberty enemy chain", () => {
  const { arr, nb, size } = A([".X.", "XO.", ".X."]);   // O at (1,1), last liberty (1,2)
  const r = playInPlace(arr, nb, size, 1 * size + 2, ME);
  assert.equal(r.ok, true);
  assert.equal(r.captured, 1);
  assert.deepEqual(r.capturedStones, [1 * size + 1]);
  assert.equal(arr[1 * size + 1], 0);                     // O removed
});

test("isLegal: suicide illegal, capture legal, ko excluded", () => {
  // X plays into a point fully surrounded by healthy O -> suicide (illegal)
  const s = A([".O.", "O.O", ".O."]);
  assert.equal(isLegal(s.arr, s.nb, 1 * 3 + 1, ME, -1), false);
  // capturing move is legal
  const c = A([".X.", "XO.", ".X."]);
  const cap = 1 * 3 + 2;
  assert.equal(isLegal(c.arr, c.nb, cap, ME, -1), true);
  assert.equal(isLegal(c.arr, c.nb, cap, ME, cap), false);  // but not if it's the ko point
});

test("isEyeFor: real eye vs not", () => {
  const eye = A(["XXX", "X.X", "XXX"]);
  assert.equal(isEyeFor(eye.arr, eye.nb, eye.size, 1 * 3 + 1, ME), true);
  const open = A(["XX.", "X..", "..."]);
  assert.equal(isEyeFor(open.arr, open.nb, open.size, 1 * 3 + 1, ME), false);
});

test("scoreBlack: stones + own territory - komi", () => {
  // Black wall down the middle, empties on both edges are neutral (touch only black) -> all black.
  const { arr, nb, size } = A(["XXX", "XXX", "XXX"]);   // 9 black stones, no empties
  assert.equal(scoreBlack(arr, nb, size, 5.5), 9 - 5.5);
});

test("randomPlayout: terminates and is deterministic for a seed", () => {
  const b = ["...", "...", "..."];
  const run = () => { const { arr, size } = boardToArr(b); return randomPlayout(arr, nbTable(size), size, ME, -1, 0.5, mulberry32(7), 40); };
  const a = run(), c = run();
  assert.equal(a, c);
  assert.ok(Number.isFinite(a));
});

test("mctsMove: takes the capturing move", () => {
  const cap = [".X.", "XO.", ".X."];
  const mv = mctsMove(cap, { komi: 0, iterations: 250, rng: mulberry32(1), rootK: 8 });
  assert.deepEqual(mv, { x: 1, y: 2 });
});

test("mctsMove: returns a legal move on an open board, null when full", () => {
  const open = Array.from({ length: 9 }, () => ".".repeat(9));
  const mv = mctsMove(open, { komi: 5.5, iterations: 60, rng: mulberry32(3) });
  assert.ok(mv && mv.x >= 0 && mv.x < 9 && mv.y >= 0 && mv.y < 9);
  const full = ["XX", "XX"];
  assert.equal(mctsMove(full, { iterations: 10, rng: mulberry32(3) }), null);
});
