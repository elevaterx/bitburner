/** lib/go-mcts.js -- pure Monte-Carlo Tree Search (UCT) for IPvGO. NO ns calls; unit-testable in Node.
 *
 *  Real search, unlike the single-ply heuristic in go-logic.js: it grows a game tree, and at each leaf
 *  runs a fast eye-safe random playout to the end of the game, then backs the win/loss up the tree.
 *  Given enough playouts it out-reads the built-in subnet AIs (themselves single-ply heuristics),
 *  including the higher-komi opponents a heuristic can't beat.
 *
 *  Flat Int8Array board (0 empty, 1 you/black, 2 opponent/white, 3 dead), idx = x*size + y. Speed comes
 *  from (a) generation-stamped flood fill (no per-call Set allocation) and (b) an incremental empty-point
 *  list in the playouts (no O(N) rescan per move). Deterministic given an injected rng (mulberry32 in
 *  tests); go.js passes Math.random and a wall-clock deadline so each move uses a fixed time budget. */

const EMPTY = 0, ME = 1, OPP = 2, DEAD = 3;
const CH = { ".": EMPTY, "X": ME, "O": OPP, "#": DEAD };
const other = (c) => (c === ME ? OPP : ME);

// --- reusable scratch (grown on demand), stamped by a monotonic generation to avoid clearing ---
let MARK = new Int32Array(0), LMARK = new Int32Array(0), STK = new Int32Array(0), POS = new Int32Array(0);
let GEN = 0;
function ensureScratch(n) {
  if (MARK.length < n) { MARK = new Int32Array(n); LMARK = new Int32Array(n); STK = new Int32Array(n); POS = new Int32Array(n); GEN = 0; }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function boardToArr(board) {
  const size = board.length, arr = new Int8Array(size * size);
  for (let x = 0; x < size; x++) { const col = board[x]; for (let y = 0; y < size; y++) arr[x * size + y] = CH[col[y]] ?? EMPTY; }
  return { arr, size };
}

const NB = new Map();
export function nbTable(size) {
  let t = NB.get(size); if (t) return t;
  t = new Array(size * size);
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
    const i = x * size + y, l = [];
    if (x > 0) l.push(i - size); if (x < size - 1) l.push(i + size);
    if (y > 0) l.push(i - 1); if (y < size - 1) l.push(i + 1);
    t[i] = l;
  }
  NB.set(size, t); return t;
}

/** Liberty count only (no stone list) -- the hot path for legality/ordering. Generation-stamped. */
export function groupLibsCount(arr, nb, i) {
  ensureScratch(arr.length);
  const color = arr[i], g1 = ++GEN, g2 = ++GEN;
  let top = 0, libs = 0; STK[top++] = i; MARK[i] = g1;
  while (top) {
    const c = STK[--top], ns = nb[c];
    for (let k = 0; k < ns.length; k++) {
      const j = ns[k], v = arr[j];
      if (v === EMPTY) { if (LMARK[j] !== g2) { LMARK[j] = g2; libs++; } }
      else if (v === color && MARK[j] !== g1) { MARK[j] = g1; STK[top++] = j; }
    }
  }
  return libs;
}

/** Full chain (stones + liberties) -- used only when actually mutating (captures). */
export function groupLibs(arr, nb, i) {
  ensureScratch(arr.length);
  const color = arr[i], g1 = ++GEN, g2 = ++GEN;
  let top = 0, libs = 0; STK[top++] = i; MARK[i] = g1;
  const stones = [];
  while (top) {
    const c = STK[--top]; stones.push(c);
    const ns = nb[c];
    for (let k = 0; k < ns.length; k++) {
      const j = ns[k], v = arr[j];
      if (v === EMPTY) { if (LMARK[j] !== g2) { LMARK[j] = g2; libs++; } }
      else if (v === color && MARK[j] !== g1) { MARK[j] = g1; STK[top++] = j; }
    }
  }
  return { stones, libs };
}

/** Play color at i, mutating arr. Returns { ok, captured, ko, capturedStones }. ok=false => suicide. */
export function playInPlace(arr, nb, size, i, color) {
  arr[i] = color;
  const opp = other(color);
  let captured = 0, lastCap = -1, capturedStones = null;
  for (const j of nb[i]) {
    if (arr[j] === opp) {
      const g = groupLibs(arr, nb, j);
      if (g.libs === 0) {
        for (const s of g.stones) arr[s] = EMPTY;
        captured += g.stones.length;
        if (g.stones.length === 1) lastCap = g.stones[0];
        capturedStones = capturedStones ? capturedStones.concat(g.stones) : g.stones;
      }
    }
  }
  if (groupLibsCount(arr, nb, i) === 0) return { ok: false, captured: 0, ko: -1, capturedStones: null };
  const ko = (captured === 1 && lastCap >= 0 && groupSingleAtari(arr, nb, i)) ? lastCap : -1;
  return { ok: true, captured, ko, capturedStones };
}
// helper: is (i)'s chain a single stone with exactly one liberty (ko shape)?
function groupSingleAtari(arr, nb, i) {
  let stones = 0, libs = 0; ensureScratch(arr.length);
  const color = arr[i], g1 = ++GEN, g2 = ++GEN; let top = 0; STK[top++] = i; MARK[i] = g1;
  while (top) { const c = STK[--top]; stones++; if (stones > 1) return false; const ns = nb[c];
    for (let k = 0; k < ns.length; k++) { const j = ns[k], v = arr[j];
      if (v === EMPTY) { if (LMARK[j] !== g2) { LMARK[j] = g2; libs++; } }
      else if (v === color && MARK[j] !== g1) { MARK[j] = g1; STK[top++] = j; } } }
  return stones === 1 && libs === 1;
}

export function isLegal(arr, nb, i, color, ko) {
  if (arr[i] !== EMPTY || i === ko) return false;
  const opp = other(color);
  for (const j of nb[i]) {
    const v = arr[j];
    if (v === EMPTY) return true;
    else if (v === color) { if (groupLibsCount(arr, nb, j) >= 2) return true; }
    else if (v === opp) { if (groupLibsCount(arr, nb, j) === 1) return true; }
  }
  return false;
}

export function isEyeFor(arr, nb, size, i, color) {
  for (const j of nb[i]) if (arr[j] !== color) return false;
  const x = (i / size) | 0, y = i % size;
  let diag = 0, same = 0;
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < size && ny >= 0 && ny < size) { diag++; if (arr[nx * size + ny] === color) same++; }
  }
  return (diag - same) <= (diag === 4 ? 1 : 0);
}

export function legalNonEyeMoves(arr, nb, size, color, ko) {
  const N = size * size, out = [];
  for (let i = 0; i < N; i++) {
    if (arr[i] !== EMPTY || i === ko) continue;
    if (isEyeFor(arr, nb, size, i, color)) continue;
    if (isLegal(arr, nb, i, color, ko)) out.push(i);
  }
  return out;
}

export function scoreBlack(arr, nb, size, komi) {
  const N = size * size; ensureScratch(N);
  const g = ++GEN;
  let black = 0, white = 0;
  for (let i = 0; i < N; i++) { const v = arr[i]; if (v === ME) black++; else if (v === OPP) white++; }
  for (let i = 0; i < N; i++) {
    if (arr[i] !== EMPTY || MARK[i] === g) continue;
    let top = 0; STK[top++] = i; MARK[i] = g; let n = 0, tB = false, tW = false;
    while (top) {
      const c = STK[--top]; n++;
      for (const j of nb[c]) {
        const v = arr[j];
        if (v === EMPTY) { if (MARK[j] !== g) { MARK[j] = g; STK[top++] = j; } }
        else if (v === ME) tB = true; else if (v === OPP) tW = true;
      }
    }
    if (tB && !tW) black += n; else if (tW && !tB) white += n;
  }
  return black - (white + komi);
}

/** One eye-safe random playout with an incremental empty-point list. Mutates arr. Black-view margin. */
export function randomPlayout(arr, nb, size, toMove, ko0, komi, rng, maxMoves) {
  ensureScratch(arr.length);
  const N = size * size, list = [];
  for (let i = 0; i < N; i++) POS[i] = -1;
  for (let i = 0; i < N; i++) if (arr[i] === EMPTY) { POS[i] = list.length; list.push(i); }
  const rm = (i) => { const p = POS[i]; if (p < 0) return; const last = list[list.length - 1]; list[p] = last; POS[last] = p; list.pop(); POS[i] = -1; };
  const add = (i) => { if (POS[i] < 0) { POS[i] = list.length; list.push(i); } };

  let passes = 0, color = toMove, ko = ko0, moves = 0;
  while (passes < 2 && moves < maxMoves) {
    let played = -1;
    const L = list.length;
    for (let t = 0; t < 8 && L > 0; t++) {
      const i = list[(rng() * L) | 0];
      if (i !== ko && !isEyeFor(arr, nb, size, i, color) && isLegal(arr, nb, i, color, ko)) { played = i; break; }
    }
    if (played < 0) {
      for (let p = 0; p < list.length; p++) { const i = list[p]; if (i !== ko && !isEyeFor(arr, nb, size, i, color) && isLegal(arr, nb, i, color, ko)) { played = i; break; } }
    }
    if (played < 0) { passes++; color = other(color); continue; }
    passes = 0;
    const r = playInPlace(arr, nb, size, played, color);
    rm(played);
    if (r.capturedStones) for (const s of r.capturedStones) add(s);
    ko = r.ko; color = other(color); moves++;
  }
  return scoreBlack(arr, nb, size, komi);
}

/** Clone-free move-ordering score for root pruning. */
function orderScore(arr, nb, size, i, color) {
  let cap = 0, empt = 0, friendLib = 0;
  for (const j of nb[i]) {
    const v = arr[j];
    if (v === EMPTY) empt++;
    else if (v === other(color)) { if (groupLibsCount(arr, nb, j) === 1) cap++; }
    else if (v === color) { const l = groupLibsCount(arr, nb, j); if (l > friendLib) friendLib = l; }
  }
  const x = (i / size) | 0, y = i % size, edge = Math.min(x, y, size - 1 - x, size - 1 - y);
  return cap * 100 + empt * 3 + Math.min(friendLib, 4) + (edge >= 2 ? 2 : edge === 1 ? 0 : -4);
}

function makeNode(arr, player, ko, untried, move) {
  return { arr, player, ko, untried, children: [], visits: 0, wins: 0, move };
}
function bestChild(node, C) {
  const logN = Math.log(node.visits + 1);
  let best = null, bv = -Infinity;
  for (const c of node.children) {
    const wr = c.wins / (c.visits || 1);
    const exploit = node.player === ME ? wr : 1 - wr;
    const ucb = exploit + C * Math.sqrt(logN / (c.visits || 1));
    if (ucb > bv) { bv = ucb; best = c; }
  }
  return best;
}

/** UCT search. Returns { x, y } for Black's best move, or null to pass.
 *  opts: { komi=5.5, iterations=400, rng=Math.random, rootK=16, C=1.4, maxPlayout, deadline, now }. */
export function mctsMove(board, opts = {}) {
  const komi = opts.komi ?? 5.5;
  const iterations = opts.iterations ?? 400;
  const rng = opts.rng ?? Math.random;
  const rootK = opts.rootK ?? 16;
  const C = opts.C ?? 1.4;
  const { arr, size } = boardToArr(board);
  const maxPlayout = opts.maxPlayout ?? Math.round(size * size * 1.6);
  const nb = nbTable(size);
  const now = opts.now, deadline = opts.deadline;

  let rootMoves = legalNonEyeMoves(arr, nb, size, ME, -1);
  if (rootMoves.length === 0) return null;
  rootMoves.sort((a, b) => orderScore(arr, nb, size, b, ME) - orderScore(arr, nb, size, a, ME));
  rootMoves = rootMoves.slice(0, rootK);
  const root = makeNode(arr, ME, -1, rootMoves, -1);

  let it = 0;
  for (; it < iterations; it++) {
    if (deadline && now && (it & 31) === 0 && now() >= deadline) break;
    const path = [root]; let node = root;
    while (node.untried.length === 0 && node.children.length > 0) { node = bestChild(node, C); path.push(node); }
    if (node.untried.length > 0) {
      const mv = node.untried.pop();
      const carr = node.arr.slice(); const r = playInPlace(carr, nb, size, mv, node.player);
      const cp = other(node.player);
      const child = makeNode(carr, cp, r.ok ? r.ko : -1, legalNonEyeMoves(carr, nb, size, cp, r.ok ? r.ko : -1), mv);
      node.children.push(child); path.push(child); node = child;
    }
    const s = randomPlayout(node.arr.slice(), nb, size, node.player, node.ko, komi, rng, maxPlayout);
    const blackWin = s > 0 ? 1 : 0;
    for (const n of path) { n.visits++; n.wins += blackWin; }
  }

  if (opts.stats) { opts.stats.iters = it; opts.stats.rootChildren = root.children.length; opts.stats.rootVisits = root.visits; }
  let best = null, bv = -1;
  for (const c of root.children) if (c.visits > bv) { bv = c.visits; best = c; }
  if (!best) return null;
  return { x: (best.move / size) | 0, y: best.move % size };
}
