/** @param {NS} ns
 * Live (ns) layer for the batcher: target params (Formulas path or base fallback),
 * pool dispatch, and a shared prep loop. Runtime-only -- cannot be Node-tested.
 */
import { weakenThreadsToMin, growMultiplierToMax, GROW_SEC_PER_THREAD } from "batch-math.js";

export const HOME_RESERVE = 24; // GB kept free on home

export function getParams(ns, target) {
  const srv = ns.getServer(target);
  const maxMoney = srv.moneyMax;
  const minSec = srv.minDifficulty;
  const curMoney = ns.getServerMoneyAvailable(target);
  const curSec = ns.getServerSecurityLevel(target);
  const hasFormulas = ns.fileExists("Formulas.exe", "home");
  const player = ns.getPlayer();
  const weakenPerThread = ns.weakenAnalyze(1);

  let hackPct, weakenTime, growTime, hackTime;
  if (hasFormulas) {
    const prepped = Object.assign({}, srv, { hackDifficulty: minSec, moneyAvailable: maxMoney });
    hackPct    = ns.formulas.hacking.hackPercent(prepped, player);
    weakenTime = ns.formulas.hacking.weakenTime(prepped, player);
    growTime   = ns.formulas.hacking.growTime(prepped, player);
    hackTime   = ns.formulas.hacking.hackTime(prepped, player);
  } else {
    hackPct    = ns.hackAnalyze(target);
    weakenTime = ns.getWeakenTime(target);
    growTime   = ns.getGrowTime(target);
    hackTime   = ns.getHackTime(target);
  }
  const prepped = curMoney >= maxMoney - 1 && curSec <= minSec + 0.01;
  return { target, maxMoney, minSec, curMoney, curSec, hasFormulas, weakenPerThread,
           hackPct, weakenTime, growTime, hackTime, prepped };
}

export function growThreadsForMultiplier(ns, target, mult, p) {
  if (mult <= 1) return 0;
  if (p && p.hasFormulas) {
    const srv = ns.getServer(target);
    const start = Object.assign({}, srv, { hackDifficulty: p.minSec, moneyAvailable: p.maxMoney / mult });
    return Math.ceil(ns.formulas.hacking.growThreads(start, ns.getPlayer(), p.maxMoney));
  }
  return Math.ceil(ns.growthAnalyze(target, mult));
}

export function pool(ns) {
  const seen = new Set(["home"]), q = ["home"], all = ["home"];
  while (q.length) { const c = q.shift(); for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); all.push(n); } }
  const hosts = [];
  for (const h of all) {
    if (h !== "home" && !ns.hasRootAccess(h)) continue;
    const max = ns.getServerMaxRam(h);
    if (max === 0) continue;
    let free = max - ns.getServerUsedRam(h);
    if (h === "home") free -= HOME_RESERVE;
    if (free > 0) hosts.push({ host: h, free });
  }
  return hosts;
}

export function dispatch(ns, script, threads, ...args) {
  if (threads <= 0) return 0;
  const ram = ns.getScriptRam(script, "home");
  if (ram <= 0) return 0;
  let placed = 0;
  for (const { host, free } of pool(ns)) {
    if (placed >= threads) break;
    const fit = Math.floor(free / ram);
    if (fit <= 0) continue;
    const n = Math.min(fit, threads - placed);
    if (host !== "home") ns.scp(script, host, "home");
    if (ns.exec(script, host, n, ...args) !== 0) placed += n;
  }
  return placed;
}

// Bring `target` to max money / min security, then return true. log(msg) for progress.
export async function prepTarget(ns, target, log = () => {}) {
  for (let pass = 1; pass < 100000; pass++) {
    const p = getParams(ns, target);
    if (p.prepped) { log("PREPPED " + target); return true; }
    // Wait on the CURRENT-security weaken time (server is dirty during prep; p.weakenTime is min-sec, for
    // batch scheduling). ns.getWeakenTime reads live security, so it's right here regardless of Formulas.
    const waitMs = ns.getWeakenTime(target) + 400;
    // ONE combined pass: grow toward max (if low) AND weaken for the current excess PLUS the grow's own
    // security bump, dispatched together so they land in the same weaken window. A server handed over
    // near-prepped (~90% money, near-min sec) finishes in a single ~weakenTime wait instead of the two
    // sequential passes the old weaken-then-grow split needed -- which on a megacorp (~11 min/pass) was the
    // difference between ~11 and ~22 minutes of startup before batching begins. A cold server still
    // converges in a couple passes as security settles and the grow estimate sharpens.
    let gGot = 0, growSec = 0;
    if (p.curMoney < p.maxMoney - 1) {
      const mult = growMultiplierToMax(p.curMoney, p.maxMoney);
      const gt = growThreadsForMultiplier(ns, target, mult, p);
      gGot = dispatch(ns, "bgrow.js", gt, target, 0);
      growSec = gGot * GROW_SEC_PER_THREAD;
    }
    const secExcess = Math.max(0, p.curSec - p.minSec);
    const wt = Math.ceil((secExcess + growSec) / p.weakenPerThread);
    const wGot = wt > 0 ? dispatch(ns, "bweaken.js", wt, target, 0) : 0;
    log(`prep ${pass}: grow ${gGot} (${(100 * p.curMoney / p.maxMoney).toFixed(1)}%) weaken ${wGot} (sec +${secExcess.toFixed(2)})`);
    await ns.sleep(waitMs);
  }
  return false;
}
