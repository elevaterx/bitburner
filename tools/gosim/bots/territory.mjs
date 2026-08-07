/** territory.mjs -- territorial evaluator for IPvGO, targeting the w0r1d_d43m0n opponent.
 *
 *  WHY THIS SHAPE. The opponent (goAI.ts getIlluminatiPriorityMove, isSmart=true) is a fixed
 *  priority ladder with NO lookahead and -- critically -- no territory or influence valuation
 *  anywhere in its code. Its only notion of "space I own" is getAllPotentialEyes, which caps
 *  recognised regions at 11 points (maxSize = min(nodeCount*0.4, 11)).
 *
 *  Meanwhile scoring.ts/checkTerritoryOwnership has NO practical size cap (its guard is
 *  size^2 - 3 = 358) and inspects only STONE neighbours -- dead/offline nodes do not break
 *  ownership. On the bitverse board that is 94 free walls.
 *
 *  So: large enclosed regions score fully and the opponent is structurally blind to them.
 *  This evaluator maximises exactly that, subject to not losing stones tactically.
 *
 *  Architecture is cheap-prior -> shortlist -> expensive-exact, because a full influence
 *  recomputation per candidate over ~200 legal moves would blow the per-move time budget.
 */

const EMPTY = 0, ME = 1, OPP = 2, DEAD = 3;
const CH = { ".": EMPTY, "X": ME, "O": OPP, "#": DEAD };

export const DEFAULTS = Object.freeze({
  shortlist: 14,        // candidates that get the full influence recomputation
  dilations: 5,         // Bouzy 5/21
  erosions: 21,
  wTerritory: 30,       // per point of estimated territory swing -- the dominant term
  wCapture: 26,         // per stone captured
  wSaveAtari: 22,       // per own chain rescued from atari
  wAtari: 7,            // per enemy chain put in atari
  pSelfAtari: -60,      // self-atari with no compensation
  pOwnEye: -400,        // filling your own eye kills the group
  pOwnTerritory: -140,  // playing inside space you already own is a wasted point
  wContact: 2,
  line3: 5, line4: 4, line2: 0, line1: -8,
  passThreshold: 0,     // pass only when nothing scores above this
});

export function parseBoard(board) {
  const size = board.length, N = size * size;
  const arr = new Int8Array(N);
  for (let x = 0; x < size; x++) {
    const col = board[x];
    for (let y = 0; y < size; y++) arr[x * size + y] = CH[col[y]] ?? EMPTY;
  }
  return { arr, size, N };
}

const NBC = new Map();
export function neighborTable(size) {
  let t = NBC.get(size);
  if (t) return t;
  t = new Array(size * size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const i = x * size + y, l = [];
      if (x > 0) l.push(i - size);
      if (x < size - 1) l.push(i + size);
      if (y > 0) l.push(i - 1);
      if (y < size - 1) l.push(i + 1);
      t[i] = l;
    }
  }
  NBC.set(size, t);
  return t;
}

/** Chain through i: stone indices + liberty count. */
export function chainAt(arr, nb, i) {
  const color = arr[i], seen = new Set([i]), stones = [i], libs = new Set(), stack = [i];
  while (stack.length) {
    const c = stack.pop();
    for (const j of nb[c]) {
      const v = arr[j];
      if (v === EMPTY) libs.add(j);
      else if (v === color && !seen.has(j)) { seen.add(j); stones.push(j); stack.push(j); }
    }
  }
  return { stones, libs: libs.size };
}

/** Play `color` at i on a COPY. Returns null if suicide, else { arr, captured }. */
export function playCopy(arr, nb, i, color) {
  const a = arr.slice();
  a[i] = color;
  const opp = color === ME ? OPP : ME;
  let captured = 0;
  const done = new Set();
  for (const j of nb[i]) {
    if (a[j] === opp && !done.has(j)) {
      const g = chainAt(a, nb, j);
      for (const s of g.stones) done.add(s);
      if (g.libs === 0) { for (const s of g.stones) a[s] = EMPTY; captured += g.stones.length; }
    }
  }
  if (chainAt(a, nb, i).libs === 0) return null;
  return { arr: a, captured };
}

/** True if empty i is one of `color`'s real eyes. Dead nodes count as friendly walls, exactly as
 *  they do for scoring -- a point walled by stones and holes is still enclosed. */
export function isEye(arr, nb, size, i, color) {
  for (const j of nb[i]) if (arr[j] !== color && arr[j] !== DEAD) return false;
  const x = (i / size) | 0, y = i % size;
  let diag = 0, friendly = 0;
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
      diag++;
      const v = arr[nx * size + ny];
      if (v === color || v === DEAD) friendly++;
    }
  }
  return (diag - friendly) <= (diag === 4 ? 1 : 0);
}

/** Bouzy dilation/erosion influence field. Positive = black, negative = white.
 *  Dead nodes are WALLS: they neither radiate nor erode, which is what makes a region enclosed by
 *  holes read as owned -- matching checkTerritoryOwnership, which ignores non-stone neighbours. */
export function influence(arr, nb, N, cfg) {
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = arr[i] === ME ? 64 : arr[i] === OPP ? -64 : 0;
  let cur = v, next = new Float32Array(N);
  for (let d = 0; d < cfg.dilations; d++) {
    for (let i = 0; i < N; i++) {
      if (arr[i] === DEAD) { next[i] = 0; continue; }
      const val = cur[i];
      let pos = 0, neg = 0;
      for (const j of nb[i]) { if (arr[j] === DEAD) continue; const w = cur[j]; if (w > 0) pos++; else if (w < 0) neg++; }
      let nv = val;
      if (val >= 0 && neg === 0) nv = val + pos;
      else if (val <= 0 && pos === 0) nv = val - neg;
      next[i] = nv;
    }
    const t = cur; cur = next; next = t;
  }
  for (let e = 0; e < cfg.erosions; e++) {
    for (let i = 0; i < N; i++) {
      if (arr[i] === DEAD) { next[i] = 0; continue; }
      const val = cur[i];
      if (val === 0) { next[i] = 0; continue; }
      let against = 0;
      // Dead neighbours are excluded -- a wall does not eat into your territory.
      for (const j of nb[i]) { if (arr[j] === DEAD) continue; const w = cur[j]; if (val > 0 ? w <= 0 : w >= 0) against++; }
      let nv = val > 0 ? Math.max(0, val - against) : Math.min(0, val + against);
      next[i] = nv;
    }
    const t = cur; cur = next; next = t;
  }
  return cur;
}

/** Estimated black territory: empty points the influence field assigns to black, plus black stones. */
export function territoryEstimate(arr, inf, N) {
  let t = 0;
  for (let i = 0; i < N; i++) {
    if (arr[i] === ME) t++;
    else if (arr[i] === EMPTY && inf[i] > 0) t++;
    else if (arr[i] === EMPTY && inf[i] < 0) t--;
  }
  return t;
}

/** Cheap per-move prior used to shortlist candidates before the expensive influence pass. */
function prior(arr, nb, size, i, inf, cfg) {
  let s = 0, empt = 0, contact = 0;
  for (const j of nb[i]) {
    const v = arr[j];
    if (v === EMPTY) empt++;
    else if (v === OPP) { contact++; const g = chainAt(arr, nb, j); if (g.libs === 1) s += cfg.wCapture * g.stones.length; else if (g.libs === 2) s += cfg.wAtari; }
    else if (v === ME) { const g = chainAt(arr, nb, j); if (g.libs === 1) s += cfg.wSaveAtari; }
  }
  s += empt * 3 + contact * cfg.wContact;
  // Prefer the boundary between the two influences -- that is where points are still up for grabs.
  const a = Math.abs(inf[i]);
  s += a < 8 ? 10 : a < 24 ? 4 : -6;
  const x = (i / size) | 0, y = i % size;
  const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
  s += edge === 0 ? cfg.line1 : edge === 1 ? cfg.line2 : edge === 2 ? cfg.line3 : cfg.line4;
  return s;
}

/** Full evaluation of one candidate. Returns a score in "points of territory" units. */
function evaluate(arr, nb, size, N, i, baseInf, baseTerr, cfg) {
  if (isEye(arr, nb, size, i, ME)) return -Infinity;
  const r = playCopy(arr, nb, i, ME);
  if (!r) return -Infinity;                       // suicide
  const after = chainAt(r.arr, nb, i);

  let s = 0;
  s += r.captured * cfg.wCapture;
  if (after.libs === 1 && r.captured === 0) s += cfg.pSelfAtari;

  for (const j of nb[i]) {
    const v = arr[j];
    if (v === ME) { const g = chainAt(arr, nb, j); if (g.libs === 1 && after.libs >= 2) s += cfg.wSaveAtari; }
    else if (v === OPP && r.arr[j] === OPP) { const g = chainAt(r.arr, nb, j); if (g.libs === 1) s += cfg.wAtari; }
  }

  // Playing inside space the influence field already gives us is a wasted stone: it converts a
  // territory point into a stone point (net zero) and costs a tempo the opponent will spend
  // somewhere useful. The opponent never passes, so tempo is the scarce resource.
  if (baseInf[i] > 24) s += cfg.pOwnTerritory;

  const inf2 = influence(r.arr, nb, N, cfg);
  s += (territoryEstimate(r.arr, inf2, N) - baseTerr) * cfg.wTerritory;

  const x = (i / size) | 0, y = i % size;
  const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
  s += edge === 0 ? cfg.line1 : edge === 1 ? cfg.line2 : edge === 2 ? cfg.line3 : cfg.line4;
  return s;
}

/** Pick black's move. `valid[x][y] === true` marks a legal point. Returns {x,y} or null to pass. */
export function chooseMove(board, valid, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { arr, size, N } = parseBoard(board);
  const nb = neighborTable(size);

  const legal = [];
  for (let x = 0; x < size; x++) {
    if (!valid[x]) continue;
    for (let y = 0; y < size; y++) {
      const i = x * size + y;
      if (!valid[x][y] || arr[i] !== EMPTY) continue;
      if (isEye(arr, nb, size, i, ME)) continue;
      legal.push(i);
    }
  }
  if (!legal.length) return null;

  const baseInf = influence(arr, nb, N, cfg);
  const baseTerr = territoryEstimate(arr, baseInf, N);

  legal.sort((a, b) => prior(arr, nb, size, b, baseInf, cfg) - prior(arr, nb, size, a, baseInf, cfg));
  const shortlist = legal.slice(0, cfg.shortlist);

  let best = null, bestScore = -Infinity;
  for (const i of shortlist) {
    const s = evaluate(arr, nb, size, N, i, baseInf, baseTerr, cfg);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best === null || bestScore <= cfg.passThreshold) return null;
  return { x: (best / size) | 0, y: best % size };
}

export function createBot(config = {}) {
  return (board, valid) => chooseMove(board, valid, config);
}
export default (board, valid) => chooseMove(board, valid);
