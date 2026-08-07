import { playGame } from './harness.mjs';
import { chooseMove, DEFAULTS } from './bots/territory.mjs';

const VARIANTS = {
  base:        {},
  wide:        { shortlist: 45 },
  wider:       { shortlist: 80 },
  softBouzy:   { shortlist: 45, dilations: 4, erosions: 13 },
  hardBouzy:   { shortlist: 45, dilations: 6, erosions: 25 },
  terrHeavy:   { shortlist: 45, wTerritory: 55 },
  terrLight:   { shortlist: 45, wTerritory: 16 },
  noPassEarly: { shortlist: 45, passThreshold: -1e9 },
  ownTerrHard: { shortlist: 45, pOwnTerritory: -400 },
  e9:  { shortlist: 45, dilations: 4, erosions: 9 },
  e13: { shortlist: 45, dilations: 4, erosions: 13 },
  e17: { shortlist: 45, dilations: 4, erosions: 17 },
  e13d3: { shortlist: 45, dilations: 3, erosions: 13 },
};

const which = process.argv[2];
const games = Number(process.argv[3] || 24);
const cfg = VARIANTS[which];
if (!cfg) { console.error('variants: ' + Object.keys(VARIANTS).join(',')); process.exit(1); }

const res = [];
for (let g = 0; g < games; g++) {
  const r = await playGame({ botMove: (b, v) => chooseMove(b, v, cfg), opponent: 'w0r1d_d43m0n', size: 19 });
  res.push(r);
}
const s = res.map(r => r.blackScore).sort((a, b) => a - b);
const wins = res.filter(r => r.won).length;
const mean = s.reduce((a, b) => a + b, 0) / s.length;
const ms = res.reduce((a, r) => a + r.botMs, 0) / res.reduce((a, r) => a + r.moves / 2, 0);
console.log(JSON.stringify({ variant: which, games, wins, winPct: +(100 * wins / games).toFixed(1),
  mean: +mean.toFixed(1), median: s[s.length >> 1], p25: s[Math.floor(s.length * .25)], max: s[s.length - 1],
  msPerMove: +ms.toFixed(1), abandoned: res.filter(r => r.abandoned).length }));
