/** plan-hacknet.js — how much $ to reach a target hash→money income (BN9 / hacknet servers).
 *  READ-ONLY: simulates ROI-greedy upgrades against a LOCAL copy of your hacknet state via the
 *  Formulas API. Buys NOTHING. Prints the total cost + breakdown to reach TARGET_DPS.
 *
 *  "Sell for Money" is a flat 4 hashes → $1,000,000, so $/s = production(h/s) × 250,000.
 *  Self-calibrates the production multiplier AND the purchase-cost multiplier from your live
 *  node 0, so it matches your augs / BN9 penalty without hardcoding. It PRINTS those factors so
 *  you can sanity-check them. Requires SF5 (Formulas — same one hacknet.js uses). Run:
 *      run plan-hacknet.js
 *  Assumes hacknet servers run no scripts (ramUsed→0) for the money plan.
 *  @param {NS} ns */
export async function main(ns) {
  const TARGET_DPS = 20e6;            // want > $20m/s
  const D_PER_HASH = 250000;         // Sell for Money: 4 hashes = $1e6
  const TARGET_HPS = TARGET_DPS / D_PER_HASH;   // 80 h/s

  let F;
  try { F = eval("ns.formulas.hacknetServers"); F.hashGainRate(1, 0, 1, 1, 1); }
  catch (e) { ns.tprint("ERROR need Formulas API (SF5): " + e); return; }

  const n = ns.hacknet.numNodes();
  const MAXN = ns.hacknet.maxNumNodes();
  if (n === 0) { ns.tprint("Buy one server first, then re-run (need a node to calibrate)."); return; }

  // caps
  const C = (F.constants && F.constants()) || {};
  const MAXLVL = C.MaxLevel || 300, MAXRAM = C.MaxRam || 8192, MAXCORE = C.MaxCores || 128;

  // ---- calibrate production multiplier: real prod / formula(mult=1), averaged ----
  let acc = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const s = ns.hacknet.getNodeStats(i);
    const raw = F.hashGainRate(s.level, s.ramUsed || 0, s.ram, s.cores, 1);
    if (raw > 0) { acc += (s.production || 0) / raw; k++; }
  }
  const multProd = k ? acc / k : 1;

  // ---- calibrate cost multiplier off node 0's live level-upgrade cost ----
  const s0 = ns.hacknet.getNodeStats(0);
  let costMult = 1;
  try { costMult = ns.hacknet.getLevelUpgradeCost(0, 1) / F.levelUpgradeCost(s0.level, 1, 1); } catch (e) {}
  // ---- calibrate new-server cost indexing against live (n vs n+1) ----
  let serverIdxOff = 1;
  try {
    const live = ns.hacknet.getPurchaseNodeCost();
    const a = Math.abs(F.hacknetServerCost(n, costMult) - live);
    const b = Math.abs(F.hacknetServerCost(n + 1, costMult) - live);
    serverIdxOff = (a <= b) ? 0 : 1;
  } catch (e) {}

  // ---- local sim state ----
  const node = [];
  for (let i = 0; i < n; i++) { const s = ns.hacknet.getNodeStats(i); node.push({ level: s.level, ram: s.ram, cores: s.cores }); }
  const prodOf = (x) => F.hashGainRate(x.level, 0, x.ram, x.cores, 1) * multProd;
  const startProd = node.reduce((a, x) => a + prodOf(x), 0);
  let total = startProd, cost = 0, buys = 0, newSrv = 0;

  while (total < TARGET_HPS && buys < 500000) {
    let best = null, bestRoi = -1;
    const consider = (c) => { if (Number.isFinite(c.cost) && c.cost > 0 && c.gain > 0) { const r = c.gain / c.cost; if (r > bestRoi) { bestRoi = r; best = c; } } };

    if (node.length < MAXN) {
      try { consider({ kind: "buy", cost: F.hacknetServerCost(node.length + serverIdxOff, costMult), gain: F.hashGainRate(1, 0, 1, 1, 1) * multProd }); } catch (e) {}
    }
    for (let i = 0; i < node.length; i++) {
      const x = node[i], cur = prodOf(x);
      if (x.level < MAXLVL) consider({ kind: "lvl", i, cost: F.levelUpgradeCost(x.level, 1, costMult), gain: F.hashGainRate(x.level + 1, 0, x.ram, x.cores, 1) * multProd - cur });
      if (x.ram < MAXRAM)   consider({ kind: "ram", i, cost: F.ramUpgradeCost(x.ram, 1, costMult),     gain: F.hashGainRate(x.level, 0, x.ram * 2, x.cores, 1) * multProd - cur });
      if (x.cores < MAXCORE)consider({ kind: "core", i, cost: F.coreUpgradeCost(x.cores, 1, costMult),  gain: F.hashGainRate(x.level, 0, x.ram, x.cores + 1, 1) * multProd - cur });
    }
    if (!best) break;   // everything at cap
    if (best.kind === "buy") { node.push({ level: 1, ram: 1, cores: 1 }); newSrv++; }
    else { const x = node[best.i]; if (best.kind === "lvl") x.level++; else if (best.kind === "ram") x.ram *= 2; else x.cores++; }
    cost += best.cost; buys++;
    total = node.reduce((a, x) => a + prodOf(x), 0);
  }

  const m = (v) => v >= 1e12 ? (v/1e12).toFixed(2)+"t" : v >= 1e9 ? (v/1e9).toFixed(2)+"b" : (v/1e6).toFixed(1)+"m";
  ns.tprint("──── hacknet plan → $" + (TARGET_DPS/1e6).toFixed(0) + "m/s ────");
  ns.tprint("calibration:  prodMult " + multProd.toFixed(3) + "   costMult " + costMult.toFixed(2) + "   servers " + n + "/" + MAXN);
  ns.tprint("current prod: " + startProd.toFixed(1) + " h/s  ($" + (startProd*D_PER_HASH/1e6).toFixed(1) + "m/s)");
  ns.tprint("target prod:  " + TARGET_HPS.toFixed(1) + " h/s");
  if (total < TARGET_HPS) ns.tprint("⚠ UNREACHABLE: maxing all " + MAXN + " servers yields only " + total.toFixed(1) + " h/s ($" + (total*D_PER_HASH/1e6).toFixed(1) + "m/s).");
  else ns.tprint("EST. COST:    $" + m(cost) + "   (" + buys + " upgrades, " + newSrv + " new servers)");
}
