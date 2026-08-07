#!/usr/bin/env node
/** tools/augbuy-replay.mjs -- re-run augbuy's round decision offline against a real dumped board.
 *
 *  WHY. Every defect augbuy has shipped was caught by running it in-game and reading the numbers --
 *  never by review, never by unit tests, because the tests encode the same model as the code. That
 *  cost one round trip per fix. This closes the loop: `run augbuy.js --dump` writes the real board to
 *  status/augbuy-board.json, rfa-sync pulls it to the repo, and this replays the SAME planRound()
 *  from lib/aug-round.js over it. A replay is therefore evidence about augbuy, not about a
 *  reimplementation that has drifted.
 *
 *  usage:  node tools/augbuy-replay.mjs [board.json] [--budget N] [--cutoff K] [--nonfg]
 *                                       [--sweep N] [--drops]
 *          --drops   test every droppable aug: does removing it raise total round value?
 */
import { readFileSync } from "node:fs";
import { planRound, nfgLadder, roundScore, dropImproves } from "../lib/aug-round.js";
import { orderedCost, roundEconomics } from "../lib/aug-plan.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const path = argv.find((a) => !a.startsWith("--") && a.endsWith(".json")) || "status/augbuy-board.json";

const B = JSON.parse(readFileSync(path, "utf8"));
const budget = opt("--budget", B.budget);
const cutoff = opt("--cutoff", B.cutoff);
const nfg = flag("--nonfg") ? null : B.nfg;
const scale = B.queueMult || 1;
const held = new Set(B.installed || []);
const cands = (B.candidates || []).filter((c) => c.rep >= c.repReq);

const plan = planRound(cands, budget, {
  valueCutoff: cutoff, priceScale: scale, held, nfg,
  sweep: opt("--sweep", 12),
});
const sc = roundScore(plan.list, budget, nfg || { price0: 0, valuePerLevel: 0 }, scale);

const fmt = (n) => {
  if (!isFinite(n)) return "--";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "b";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "m";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Number(n).toFixed(0);
};

const age = ((Date.now() - (B.ts || 0)) / 3600e3).toFixed(1);
console.log(`board ${path}  BN${B.bitNode ?? "?"}  ${cands.length}/${(B.candidates || []).length} rep-affordable  (dumped ${age}h ago)`);
console.log(`budget $${fmt(budget)}  cash $${fmt(B.money0)}  queueMult x${scale.toFixed(1)}  cutoff ${cutoff}`
  + `  weights: exp x${(B.weights.hacking_exp).toFixed(3)} rep x${(B.weights.faction_rep).toFixed(3)}`);
console.log(`searched ${plan.tried} baskets -> n=${plan.list.length}  augs ${sc.augs.toFixed(3)}`
  + `  + NFG ${sc.nfg.levels} lvl (${(sc.nfg.spent / 1e12).toFixed(2)}t)  = TOTAL ${sc.total.toFixed(4)}`
  + `  [threshold $${fmt(plan.threshold)}/value]`);
console.log(`aug spend $${fmt(sc.cost)}  leftover $${fmt(budget - sc.cost)}  NFG line $${fmt(sc.nfg.marginal)}/value`);

let hackMult = 1;
for (const c of plan.list) { const h = Number(c.stats && c.stats.hacking); if (h > 1) hackMult *= h; }
const nfgMult = Math.pow(1.01, sc.nfg.levels);
const req = 3000 * ((B.bn && B.bn.WorldDaemonDifficulty) || 1);
const cur = (B.player && B.player.hackingMult) || 1, lvl = (B.player && B.player.hackingLevel) || 0;
const need = lvl > 0 ? (req * cur) / lvl : NaN;
console.log(`ROUND DELIVERS x${(hackMult * nfgMult).toFixed(3)} hacking (augs x${hackMult.toFixed(3)}, NFG x${nfgMult.toFixed(3)})`
  + (lvl > 0 ? `   exit needs x${need.toFixed(2)}; after this round x${(cur * hackMult * nfgMult).toFixed(2)}`
    + `  -> ~${Math.ceil(Math.log(need / (cur * hackMult * nfgMult)) / Math.log(hackMult * nfgMult))} more round(s)` : ""));

console.log("\nslot " + "aug".padEnd(40) + "     paid  value    marginal  marg$/val");
for (const r of roundEconomics(plan.list, { priceScale: scale })) {
  const bad = nfg && dropImproves(plan.list, r.aug, budget, nfg, scale);
  console.log(String(r.slot).padStart(4) + " " + String(r.aug).slice(0, 40).padEnd(40)
    + " $" + fmt(r.paid).padStart(7) + " " + r.value.toFixed(3).padStart(6)
    + " $" + fmt(r.marginal).padStart(8) + " $" + fmt(r.marginalPerValue).padStart(9)
    + (bad ? "   <-- DROP IMPROVES ROUND" : ""));
}

if (flag("--drops")) {
  console.log("\n-- single-drop test: total round value if this aug (and its dependents) were removed --");
  const names = new Set(plan.list.map((c) => c.aug));
  const needed = new Set();
  for (const c of plan.list) for (const r of c.prereqs || []) if (names.has(r)) needed.add(r);
  const rows = [];
  for (const y of plan.list) {
    if (needed.has(y.aug)) continue;
    const t = plan.list.filter((c) => c.aug !== y.aug);
    rows.push({ aug: y.aug, total: roundScore(t, budget, nfg || { price0: 0, valuePerLevel: 0 }, scale).total });
  }
  rows.sort((a, b) => b.total - a.total);
  for (const r of rows) {
    console.log("  drop " + r.aug.padEnd(42) + " -> " + r.total.toFixed(4)
      + (r.total > sc.total + 1e-9 ? "   BETTER than keeping it" : ""));
  }
  console.log("  keep everything                                 -> " + sc.total.toFixed(4));
}
