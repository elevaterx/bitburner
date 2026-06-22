/** @param {NS} ns
 * Batcher diagnostic + DRY RUN. Prints live state and the exact batch plan it WOULD fire
 * (threads, additionalMsec offsets, land order, RAM) WITHOUT executing anything.
 *   run bdiag.js <target> [hackFraction]   (default fraction 0.10)
 */
import { getParams, growThreadsForMultiplier } from "batch-live.js";
import { hackThreadsForFraction, weakenThreadsForHack, weakenThreadsForGrow,
         growMultiplierAfterHack, batchOffsets, landTimes } from "batch-math.js";

export async function main(ns) {
  const target = ns.args[0];
  const frac = Number(ns.args[1]) || 0.10;
  if (!target) { ns.tprint("usage: run bdiag.js <target> [hackFraction]"); return; }
  const p = getParams(ns, target);
  const o = [];
  o.push("=== bdiag " + target + " ===");
  o.push("Formulas.exe: " + (p.hasFormulas ? "YES (exact prepped-state math)" : "NO (base funcs, current-state approx)"));
  o.push(`money:  ${ns.format.number(p.curMoney)} / ${ns.format.number(p.maxMoney)}  (${(100*p.curMoney/p.maxMoney).toFixed(1)}%)`);
  o.push(`sec:    ${p.curSec.toFixed(2)} / min ${p.minSec.toFixed(2)}  (+${(p.curSec-p.minSec).toFixed(2)})`);
  o.push("prepped: " + (p.prepped ? "YES" : "NO - run bprep.js first for a meaningful plan"));
  o.push(`times:  W ${(p.weakenTime/1000).toFixed(1)}s  G ${(p.growTime/1000).toFixed(1)}s  H ${(p.hackTime/1000).toFixed(1)}s`);

  const h = hackThreadsForFraction(frac, p.hackPct);
  const realFrac = h * p.hackPct;
  const w1 = weakenThreadsForHack(h, p.weakenPerThread);
  const mult = growMultiplierAfterHack(realFrac);
  const g = growThreadsForMultiplier(ns, target, mult, p);
  const w2 = weakenThreadsForGrow(g, p.weakenPerThread);
  const gap = 200;
  const off = batchOffsets(p.weakenTime, p.growTime, p.hackTime, gap);
  const land = landTimes(p.weakenTime, p.growTime, p.hackTime, gap);
  const totalRam = h*ns.getScriptRam("bhack.js","home") + g*ns.getScriptRam("bgrow.js","home")
                 + (w1+w2)*ns.getScriptRam("bweaken.js","home");
  const ordered = land.hack < land.weaken1 && land.weaken1 < land.grow && land.grow < land.weaken2;

  o.push(`--- batch plan (skim ${(100*frac).toFixed(0)}% req, ${(100*realFrac).toFixed(1)}% actual) ---`);
  o.push(`threads:  H ${h}   W1 ${w1}   G ${g}   W2 ${w2}   total ${h+w1+g+w2}`);
  o.push(`addMsec:  H ${off.hack.toFixed(0)}  W1 ${off.weaken1.toFixed(0)}  G ${off.grow.toFixed(0)}  W2 ${off.weaken2.toFixed(0)}`);
  o.push(`land(ms): H ${land.hack.toFixed(0)} -> W1 ${land.weaken1.toFixed(0)} -> G ${land.grow.toFixed(0)} -> W2 ${land.weaken2.toFixed(0)}  gap ${gap}`);
  o.push("order:    " + (ordered ? "OK (H<W1<G<W2)" : "BAD ORDER"));
  o.push(`RAM:      ${totalRam.toFixed(1)} GB/batch    duration ${(off.batchDuration/1000).toFixed(1)}s`);
  o.push("(dry run - nothing executed)");
  ns.tprint("\n" + o.join("\n"));
}
