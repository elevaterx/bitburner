const m = await import('./bbgo.mjs');
const { mctsMove } = await import('./bots/go-mcts.js');
const st = m.getNewBoardState(19, m.GoOpponent.w0r1d_d43m0n); m.updateChains(st.board);
const toSimple = (b) => b.map(c => c.map(p => !p ? '#' : p.color === m.GoColor.black ? 'X' : p.color === m.GoColor.white ? 'O' : '.').join(''));
// play 60 plies of real game to reach a representative midgame position
for (let i = 0; i < 60; i++) {
  const color = i % 2 === 0 ? m.GoColor.black : m.GoColor.white;
  const mv = await m.getMove(st, color, m.GoOpponent.w0r1d_d43m0n, false, Math.random());
  if (mv.type === 'move') m.makeMove(st, mv.x, mv.y, color); else m.passTurn(st, color, false);
}
const board = toSimple(st.board);
for (const budget of [600, 600, 600]) {
  const s = {};
  const t0 = Date.now();
  mctsMove(board, { komi: 9.5, iterations: 1500, rng: Math.random, now: () => Date.now(), deadline: Date.now() + budget, stats: s });
  console.log(`budget ${budget}ms -> iters ${s.iters}  (actual ${Date.now()-t0}ms)  rootChildren ${s.rootChildren}`);
}
console.log('LIVE observed in-game: 72-301 iters, mean ~145, at the same 600ms budget');
