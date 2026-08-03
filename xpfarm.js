/** xpfarm -- hacking-XP farm. Floods the network with hack workers instead of grow workers.
 *
 *  WHAT CHANGED (and why): hack(), grow() and weaken() all grant the SAME XP per thread per
 *  op -- calculateHackingExpGain (v3.0.2 Hacking.ts:30) reads only the server's BASE difficulty --
 *  but growTime = 3.2 * hackTime and weakenTime = 4 * hackTime. So a hack worker is worth 3.2
 *  grow workers and 4 weaken workers, per thread. The old xpfarm ran grow/weaken only.
 *
 *  Two source facts make an all-hack fleet viable at 250k+ threads:
 *    - fortify is capped: NetscriptHelpers.tsx:667 adds 0.002 * min(threads, maxThreadNeeded)
 *      security, while line 618 pays exp for the FULL uncapped thread count. Over-threading a
 *      hack is nearly free in security, so security scales with the number of INSTANCES, not
 *      the number of threads.
 *    - the only money dependency is a hard zero: line 639 downgrades exp to the 25% failure
 *      tier only when moneyDrained === 0, and moneyDrained is a raw float. Any non-zero balance
 *      pays full XP. grow() re-arms from exactly $0 (formulas/grow.ts:46 does moneyAvailable
 *      += threads before multiplying), so a handful of small staggered grow workers per host
 *      keeps the hack fleet in the full-XP tier.
 *
 *  BN9 note: ScriptHackMoney 0.1 and ServerMaxMoney 0.01 nerf money, not XP -- neither appears
 *  in calculateHackingExpGain. The smaller per-thread steal actually RAISES maxThreadNeeded,
 *  giving more headroom before an op zeroes a balance.
 *
 *  Roles (separate one-line worker scripts, so each pays only the RAM it needs):
 *    xph.js  hack   1.70 GB/thread   XP/sec 1.00 per thread-hackTime
 *    xpg.js  grow   1.75 GB/thread   XP/sec 0.3125, plus it re-arms the balance
 *    xpw.js  weaken 1.80 GB/thread   XP/sec 0.25, holds security at min
 *
 *  usage: run xpfarm.js [target] [--targets N] [--band N] [--grow-inst N] [--grow-threads N]
 *                       [--reserve GB] [--loop MS] [--no-hack] [--dry]
 *    target         force a single target host (default: auto-rank)
 *    --targets N    how many targets to spread across (default 2)
 *    --band N       weaken when security exceeds min by more than N (default 2)
 *    --grow-inst N  grow instances per host per target (default 4 -- ~3.2 is parity with
 *                   one hack instance, see lib/xp-alloc growInstancesFor)
 *    --grow-threads N  threads per grow instance (default 40; only needs to be non-trivial)
 *    --reserve GB   home RAM to leave free (default 64)
 *    --loop MS      controller loop interval (default 10000)
 *    --no-hack      fall back to the old grow/weaken behaviour (A/B baseline)
 *    --dry          print the plan and exit
 *  @param {NS} ns */

import { bfs, rootHost, freeRam } from "./lib/net.js";
import {
  rankTargets, maxThreadNeeded, hackSecPerSec, growSecPerSec, weakenThreadsFor,
  moneyUpFraction, planHost, staggerMs, planXpPerSec, GROW_TIME_MULT, WEAKEN_TIME_MULT,
} from "./lib/xp-alloc.js";

const HACK = "xph.js", GROW = "xpg.js", WEAK = "xpw.js";
const WORKERS = [HACK, GROW, WEAK];

export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.resizeTail(720, 300);

  const flag = (name, dflt) => {
    const i = ns.args.indexOf("--" + name);
    if (i < 0) return dflt;
    const v = ns.args[i + 1];
    return v === undefined || String(v).startsWith("--") ? true : Number(v);
  };
  const has = (name) => ns.args.includes("--" + name);
  const positional = ns.args.filter((a) => typeof a === "string" && !a.startsWith("--"));
  const override = positional[0] || null;

  // Default 1: security is capped per-op and money is trivially re-armed, so a single
  // best-ranked target absorbs the whole fleet. Spreading only dilutes onto slower servers.
  const NUM_TARGETS = Math.max(1, Number(flag("targets", 1)) || 1);
  const BAND = Number(flag("band", 2)) || 2;
  const GROW_INST = Math.max(0, Number(flag("grow-inst", 4)));
  const GROW_THREADS = Math.max(1, Number(flag("grow-threads", 40)) || 40);
  const HOME_RESERVE = Math.max(0, Number(flag("reserve", 64)));
  const LOOP_MS = Math.max(2000, Number(flag("loop", 10000)) || 10000);
  const USE_HACK = !has("no-hack");
  const DRY = has("dry");

  // singleton: newest wins
  for (const p of ns.ps("home")) {
    if (p.filename === ns.getScriptName() && p.pid !== ns.pid) ns.kill(p.pid);
  }

  const ram = {
    hack: ns.getScriptRam(HACK, "home"),
    grow: ns.getScriptRam(GROW, "home"),
    weaken: ns.getScriptRam(WEAK, "home"),
  };
  if (!ram.hack || !ram.grow || !ram.weaken) {
    ns.tprint(`xpfarm: missing worker script(s). Need ${WORKERS.join(", ")} on home. ` +
              `Run update.js first.`);
    return;
  }

  const hosts = () => bfs(ns).filter((h) => !h.startsWith("hacknet-"));
  const level = () => ns.getHackingLevel();

  /** Rank targets. XP reads BASE difficulty (not min security -- the old ranking's bug),
   *  and the op cadence is hackTime, so score = (3 + 0.3*baseDifficulty) / hackTime. */
  const pickTargets = () => {
    const lvl = level();
    const cands = [];
    for (const h of hosts()) {
      if (h === "home" || !ns.hasRootAccess(h)) continue;
      if (ns.getServerMaxMoney(h) <= 0) continue;
      // hack() needs the level; grow/weaken do not, but an all-hack fleet does.
      if (USE_HACK && ns.getServerRequiredHackingLevel(h) > lvl) continue;
      const hackTimeMs = ns.getHackTime(h);
      if (!(hackTimeMs > 0)) continue;
      cands.push({
        host: h,
        baseDifficulty: ns.getServerBaseSecurityLevel(h),
        hackTimeMs,
        chance: USE_HACK ? ns.hackAnalyzeChance(h) : 1,
        pct: USE_HACK ? ns.hackAnalyze(h) : 0,
      });
    }
    const ranked = rankTargets(cands);
    if (override) {
      const forced = ranked.find((c) => c.host === override);
      return forced ? [forced] : ranked.slice(0, 1);
    }
    return ranked.slice(0, NUM_TARGETS);
  };

  let targets = pickTargets();
  if (!targets.length) {
    ns.tprint("xpfarm: no rootable, money-bearing target found.");
    return;
  }

  const header = () =>
    "=== xpfarm  " + (USE_HACK ? "HACK mode" : "grow/weaken mode (--no-hack)") +
    "  targets: " + targets.map((t) => t.host).join(", ") + (override ? " (override)" : "");

  if (DRY) {
    ns.tprint(header());
    for (const t of targets) {
      ns.tprint(`  ${t.host}: baseSec ${t.baseDifficulty}  hackTime ${(t.hackTimeMs / 1000).toFixed(2)}s  ` +
                `chance ${(t.chance * 100).toFixed(1)}%  maxThreadNeeded ${maxThreadNeeded(t.pct)}  ` +
                `rate ${t.rate.toFixed(3)} xp/thread-s`);
    }
    return;
  }

  // Stop the money farm so its RAM is free (leaves hud/panel/trader/hacknet alone).
  for (const h of hosts()) {
    if (!ns.hasRootAccess(h)) continue;
    for (const p of ns.ps(h)) {
      if (["coordinator.js", "prep.js", "h.js", "xp.js"].includes(p.filename)) ns.kill(p.pid);
    }
  }

  const startXp = ns.getPlayer().exp.hacking || 0;
  const startLvl = level();
  const t0 = Date.now();
  let lastRank = Date.now();
  let serial = 0;

  while (true) {
    // re-rank every 5 min: hackTime falls as the level climbs, which reorders targets
    if (Date.now() - lastRank > 300000) { targets = pickTargets(); lastRank = Date.now(); }

    const all = hosts();
    for (const h of all) rootHost(ns, h);
    const rooted = all.filter((h) => ns.hasRootAccess(h) && ns.getServerMaxRam(h) > 0);

    // --- current per-target state -------------------------------------------------
    const state = new Map();
    for (const t of targets) {
      const sec = ns.getServerSecurityLevel(t.host);
      const min = ns.getServerMinSecurityLevel(t.host);
      state.set(t.host, {
        sec, min, drift: sec - min,
        money: ns.getServerMoneyAvailable(t.host),
        maxMoney: ns.getServerMaxMoney(t.host),
        hackInst: 0, growInst: 0, hackThreads: 0, growThreads: 0, weakenThreads: 0,
      });
    }

    // --- census of what is already running ----------------------------------------
    for (const h of rooted) {
      for (const p of ns.ps(h)) {
        if (!WORKERS.includes(p.filename)) continue;
        const st = state.get(p.args[0]);
        if (!st) { ns.kill(p.pid); continue; }   // worker on a target we no longer use
        if (p.filename === HACK) { st.hackInst++; st.hackThreads += p.threads; }
        else if (p.filename === GROW) { st.growInst++; st.growThreads += p.threads; }
        else st.weakenThreads += p.threads;
      }
    }

    // --- place workers into whatever RAM is free ----------------------------------
    let placed = 0, placedHosts = 0;
    rooted.forEach((h, hostIdx) => {
      let gb = freeRam(ns, h);
      if (h === "home") gb -= HOME_RESERVE;
      if (gb < ram.weaken) return;

      const t = targets[hostIdx % targets.length];
      const st = state.get(t.host);

      // weaken need: hold security flat against the hack + grow instances on this target,
      // plus a burst if security has already drifted above the band.
      const mtn = maxThreadNeeded(t.pct);
      const hackInst = Math.max(1, st.hackInst);
      const secGain =
        hackSecPerSec(hackInst, st.hackThreads / hackInst, mtn, t.hackTimeMs) +
        growSecPerSec(Math.max(1, st.growInst), GROW_THREADS, t.hackTimeMs);
      let wantWeaken = weakenThreadsFor(secGain, t.hackTimeMs);
      if (st.drift > BAND) {
        // clear the accumulated drift within one weaken cycle, on top of steady state
        wantWeaken += Math.ceil(st.drift / 0.05);
      }
      wantWeaken = Math.max(0, wantWeaken - st.weakenThreads);
      // spread the remaining need over the hosts we have not visited yet
      const share = Math.ceil(wantWeaken / Math.max(1, rooted.length - hostIdx));

      // In --no-hack baseline mode the "fill" role is grow, so price the fill at grow's RAM.
      const rp = USE_HACK ? ram : { ...ram, hack: ram.grow };
      const plan = planHost(gb, rp, {
        weaken: share,
        growInstances: USE_HACK ? GROW_INST : 0,
        growThreadsPerInstance: GROW_THREADS,
      });
      if (!USE_HACK && plan.hack > 0) { plan.grow.push(plan.hack); plan.hack = 0; }

      if (h !== "home" && !ns.scp(WORKERS, h, "home")) return;

      // ns.exec refuses a launch whose (file, host, args) already exists. Every placement
      // therefore carries a serial as a trailing arg -- the workers ignore args[2], but it
      // keeps a later top-up of freed RAM from silently returning 0.
      let any = false;
      if (plan.weaken > 0 && ns.exec(WEAK, h, plan.weaken, t.host, serial++)) {
        placed += plan.weaken; st.weakenThreads += plan.weaken; any = true;
      }
      plan.grow.forEach((threads, i) => {
        const off = staggerMs(hostIdx * GROW_INST + i, Math.max(1, targets.length * GROW_INST * 4),
                              t.hackTimeMs * GROW_TIME_MULT);
        if (threads > 0 && ns.exec(GROW, h, threads, t.host, off, serial++)) {
          placed += threads; st.growThreads += threads; st.growInst++; any = true;
        }
      });
      if (plan.hack > 0) {
        const off = staggerMs(hostIdx, Math.max(1, rooted.length), t.hackTimeMs);
        if (ns.exec(HACK, h, plan.hack, t.host, off, serial++)) {
          placed += plan.hack; st.hackThreads += plan.hack; st.hackInst++; any = true;
        }
      }
      if (any) placedHosts++;
    });

    // --- report -------------------------------------------------------------------
    const nowXp = ns.getPlayer().exp.hacking || 0;
    const secs = Math.max(1, (Date.now() - t0) / 1000);
    const gained = nowXp - startXp;
    const lines = [header()];
    lines.push(`  L${level()} (+${level() - startLvl})   XP +${ns.formatNumber(gained, 2)}   ` +
               `${ns.formatNumber(gained / secs, 2)} xp/s since start` +
               (placed > 0 ? `   (+${placed} threads / ${placedHosts} hosts)` : "   (pool full)"));
    for (const t of targets) {
      const st = state.get(t.host);
      const mtn = maxThreadNeeded(t.pct);
      const mUp = moneyUpFraction(st.hackInst, st.growInst);
      const est = planXpPerSec(
        { hack: st.hackThreads, grow: [st.growThreads], weaken: st.weakenThreads },
        1, t.hackTimeMs, t.chance, mUp);
      lines.push(
        `  ${t.host}  sec ${st.sec.toFixed(2)}/${st.min.toFixed(2)}` +
        `  $${ns.formatNumber(st.money, 1)}/${ns.formatNumber(st.maxMoney, 1)}` +
        `  hack ${st.hackThreads}t/${st.hackInst}i  grow ${st.growThreads}t/${st.growInst}i` +
        `  weak ${st.weakenThreads}t` +
        `  ht ${(t.hackTimeMs / 1000).toFixed(2)}s  mtn ${mtn}  chance ${(t.chance * 100).toFixed(0)}%` +
        `  moneyUp~${(mUp * 100).toFixed(0)}%  rel ${est.toFixed(0)}`);
    }
    ns.clearLog();
    for (const l of lines) ns.print(l);
    try {
      ns.write("status/xpfarm.txt",
        `xpfarm ${USE_HACK ? "hack" : "grow"}  L${level()}  ${ns.formatNumber(gained / secs, 2)} xp/s  ` +
        targets.map((t) => {
          const st = state.get(t.host);
          return `${t.host} h${st.hackThreads}/g${st.growThreads}/w${st.weakenThreads} sec+${st.drift.toFixed(1)}`;
        }).join("  "), "w");
    } catch (e) { /* status dir optional */ }

    await ns.sleep(LOOP_MS);
  }
}
