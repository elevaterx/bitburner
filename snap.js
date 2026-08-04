/** snap.js -- one-shot text snapshot of the whole stack. The data half of hud1 without the UI half.
 *
 *  WHY: hud1.js is ~39GB, almost all of it React rendering plus a wide ns surface. After a BitNode
 *  reset home is 32GB (Prestige.ts:242-248, SF9>=2 -> 128, else SF1 -> 32, else 8), so hud1 cannot
 *  run AT ALL until home is upgraded -- and that is exactly the window where you most need to see
 *  what is happening. This reproduces the snapshot text at ~4GB and exits immediately, so it costs
 *  nothing while not running.
 *
 *  Deliberately avoids the expensive lookups:
 *    - lib/caps.js is NOT imported: it calls ns.getBitNodeMultipliers (4GB, and needs SF5). Module
 *      state is read from the status files instead, so an absent module just shows "-".
 *    - no ns.stock.* (2GB+): the trader reports its own line.
 *    - ns.go.analysis.getStats is free (0GB), so the IPvGO record comes along for nothing.
 *
 *  Status files are filtered through readStatus, which now drops entries written before the current
 *  BitNode began -- otherwise last node's hacknet/go lines render as if they were current.
 *
 *  usage: run snap.js            print to terminal + write status/snapshot.txt
 *         run snap.js --quiet    write the file only
 *  @param {NS} ns */

import { MODULES, WORKER_JOBS, readStatus } from "./lib/modules.js";
import { money as fmtMoney, num as fmtNum, ram as fmtRam, time as fmtTime } from "./lib/fmt.js";

export async function main(ns) {
  const quiet = ns.args.includes("--quiet");
  const L = [];
  const p = ns.getPlayer();
  const reset = ns.getResetInfo();

  const sf = [...(reset.ownedSF ? reset.ownedSF.entries() : [])]
    .map(([n, lvl]) => `SF${n}.${lvl}`).join(" ") || "none";

  L.push(`=== snap @ BN${reset.currentNode}  ${new Date().toISOString().replace("T", " ").slice(0, 19)} ===`);
  L.push(`  ${sf}`);

  // --- player ---------------------------------------------------------------
  let karma = 0; try { karma = ns.heart.break(); } catch (e) {}
  let income = 0; try { income = ns.getTotalScriptIncome()[0]; } catch (e) {}
  const s = p.skills || {};
  L.push(`level ${s.hacking}  cash ${fmtMoney(p.money)}  income ${fmtMoney(income)}/s` +
         `  karma ${Math.round(karma)}  kills ${p.numPeopleKilled ?? 0}  city ${p.city}`);
  L.push(`combat ${s.strength}/${s.defense}/${s.dexterity}/${s.agility}  cha ${s.charisma}` +
         `  factions ${(p.factions || []).length}`);

  // --- network sweep: RAM, roots, contracts, processes -----------------------
  const hosts = [];
  { const seen = new Set(["home"]), q = ["home"];
    while (q.length) { const c = q.shift(); hosts.push(c);
      for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); } } }

  let rooted = 0, contracts = 0;
  let homeMax = 0, homeUsed = 0, netMax = 0, netUsed = 0, netCount = 0;
  const byScript = new Map();
  let bestFree = 0, bestHost = null;   // roomiest single rooted host -- what a big manager can use
  for (const h of hosts) {
    const root = ns.hasRootAccess(h);
    if (root) rooted++;
    try { contracts += ns.ls(h, ".cct").length; } catch (e) {}
    const max = ns.getServerMaxRam(h), used = ns.getServerUsedRam(h);
    if (h === "home") { homeMax = max; homeUsed = used; }
    // Only ROOTED hosts are usable capacity. Counting the rest inflates the figure into
    // something you cannot actually spend -- and hacknet servers lose hash rate if scripted.
    else if (max > 0 && root && !h.startsWith("hacknet-")) {
      netMax += max; netUsed += used; netCount++;
      const f = max - used;
      if (f > bestFree) { bestFree = f; bestHost = h; }
    }
    for (const proc of ns.ps(h)) {
      const e = byScript.get(proc.filename) || { threads: 0, gb: 0 };
      e.threads += proc.threads;
      e.gb += proc.threads * ns.getScriptRam(proc.filename, "home");
      byScript.set(proc.filename, e);
    }
  }
  L.push(`rooted ${rooted}/${hosts.length}  contracts ${contracts}`);
  L.push(`RAM  home ${fmtRam(homeUsed)}/${fmtRam(homeMax)}` +
         `  (free ${fmtRam(Math.max(0, homeMax - homeUsed))})` +
         `   network ${fmtRam(netUsed)}/${fmtRam(netMax)} (${netCount} rooted)` +
         (bestHost ? `   roomiest ${bestHost} ${fmtRam(bestFree)} free` : ""));

  // --- what is actually running --------------------------------------------
  L.push("SCRIPTS");
  const sorted = [...byScript.entries()].sort((a, b) => b[1].gb - a[1].gb);
  if (!sorted.length) L.push("  (nothing running)");
  for (const [file, e] of sorted) {
    L.push(`  ${file.padEnd(20)} ${String(e.threads).padStart(8)} threads  ${fmtRam(e.gb).padStart(9)}`);
  }

  // --- workers + modules, from their status files ---------------------------
  const procHome = ns.ps("home").map((x) => x.filename);
  L.push("WORKERS");
  for (const w of WORKER_JOBS) {
    const up = procHome.includes(w.file);
    const st = w.key ? readStatus(ns, w.key) : null;
    if (!up && !st) continue;
    L.push(`  ${w.label.padEnd(12)} ${up ? "up " : "stopped"}  ${st && st.line ? st.line : ""}`);
  }
  L.push("MODULES");
  for (const m of MODULES) {
    const up = procHome.includes(m.file);
    const st = readStatus(ns, m.key);
    if (!up && !st) continue;
    L.push(`  [${up ? "on " : "off"}] ${m.label.padEnd(12)} ${st && st.line ? st.line : "-"}`);
  }

  // --- IPvGO: getStats is 0GB, so this is free -----------------------------
  try {
    const gs = ns.go.analysis.getStats();
    const opps = Object.keys(gs || {});
    if (opps.length) {
      L.push("IPvGO (wins-losses  streak  bonus)");
      for (const o of opps) {
        const st = gs[o];
        L.push(`  ${String(o).padEnd(14)} ${String(st.wins + "-" + st.losses).padStart(9)}` +
               `  streak ${String(st.winStreak).padStart(4)}` +
               `  ${st.bonusPercent != null ? st.bonusPercent.toFixed(2) + "%" : ""}`);
      }
    }
  } catch (e) { /* Go not touched yet in this node */ }

  const out = L.join("\n");
  try { ns.write("status/snapshot.txt", out, "w"); } catch (e) {}
  if (!quiet) ns.tprint("\n" + out);
}
