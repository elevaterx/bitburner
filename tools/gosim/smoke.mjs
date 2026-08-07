import { playGame } from './harness.mjs';
import { chooseMove } from './bots/territory.mjs';
const t0 = Date.now();
let calls = 0, tms = 0;
const bot = (b, v, ctx) => { const s = Date.now(); const m = chooseMove(b, v); tms += Date.now() - s; calls++; return m; };
const r = await playGame({ botMove: bot, opponent: 'w0r1d_d43m0n', size: 19 });
console.log(JSON.stringify(r, null, 1));
console.log(`bot moves ${calls}, mean ${(tms/calls).toFixed(1)} ms/move, wall ${((Date.now()-t0)/1000).toFixed(0)}s`);
