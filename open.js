/** open.js -- cold-node opener. Crime to travel fare -> Aevum -> casino.
 *
 *  THE PROBLEM. The least automated part of any run is its first two minutes. A fresh BitNode hands
 *  you $1,262; travelling to Aevum costs $200,000 (`CONSTANTS.TravelCost`); the casino sits in Aevum
 *  and is worth ~$10b, which funds the entire early game. Only BN13 gifts the fare
 *  (`Prestige.ts:341-343`). Everywhere else that gap is crossed by hand, every single node.
 *
 *  This closes it: detect a cold node, commit the highest expected-value-per-second crime until the
 *  fare is covered, travel, then hand off to casino.js.
 *
 *  RESUMABLE BY DESIGN. casino.js save-scums -- it RELOADS the page on a losing hand, and Bitburner
 *  restarts whatever was running at the last save. So this script can be re-entered at any point and
 *  must work out where it is rather than replaying from the top. All the branching goes through
 *  openerStep() in lib/node-open.js, which is a pure state function for exactly that reason.
 *
 *  usage:  run open.js [targetCash] [casino]
 *          targetCash  passed through to casino.js (default 10e9)
 *          casino      OPT IN to auto-starting casino.js. WITHOUT it, open.js does crime + travel
 *                      and stops -- because the casino needs autosave OFF and trader.js killed,
 *                      neither of which a script can verify, and running it with autosave on loses
 *                      money. boot.js fires this unattended, so the safe default matters.
 *
 *  MANUAL PREREQUISITE, unchanged from casino.js: turn AUTOSAVE OFF (Options -> save icon red)
 *  before the casino phase, or an autosave can land right after a loss and lock it in. This script
 *  warns but cannot toggle it -- there is no ns API for Settings, and doing it through the React
 *  fiber belongs in casino.js, which already owns that fragile path.
 *
 *  Needs SF4 (singularity) for crime + travel. Without it the script says so and exits.
 *  Deployed by update.js (repo tree is auto-discovered -- no manifest to edit). @param {NS} ns */
import { isColdNode, bestCrime, crimeTarget, etaSeconds, openerStep, TRAVEL_COST } from "./lib/node-open.js";

const CRIMES = [
  "Shoplift", "Rob Store", "Mug", "Larceny", "Deal Drugs", "Bond Forgery",
  "Traffick Arms", "Homicide", "Grand Theft Auto", "Kidnap", "Assassination", "Heist",
];

export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  const TARGET_CASH = Number(ns.args[0]) > 0 ? Number(ns.args[0]) : 10e9;
  // CASINO IS OPT-IN, NOT OPT-OUT. casino.js save-scums by RELOADING on a losing hand; if autosave
  // is on, an autosave can land right after a loss and make it permanent -- so an unattended chain
  // into the casino with autosave on actively LOSES money. There is no ns API to read or set the
  // autosave interval, so this cannot be checked in code. Since boot.js now fires open.js
  // automatically on every cold node, defaulting to auto-casino would arm that trap on every single
  // run. Default: do crime + travel (both always safe), then stop and tell the user what to do.
  const DO_CASINO = ns.args.includes("casino");
  const S = ns.singularity;
  const log = (m) => { ns.print(m); ns.tprint("open: " + m); };

  let reset = null;
  try { reset = ns.getResetInfo(); } catch (e) {}
  if (!isColdNode(reset)) {
    log("not a cold node (an install has happened since node entry) -- nothing to do.");
    return;
  }

  // Probe singularity before relying on it, so the failure is one clear line rather than a stack.
  try { S.getCrimeChance("Shoplift"); } catch (e) {
    log("needs SF4 (singularity) for crime + travel. Do the opener by hand this node.");
    return;
  }

  const FARE = crimeTarget(TRAVEL_COST);
  log("cold node. fare target $" + fmt(FARE) + " (travel $" + fmt(TRAVEL_COST) + " + buffer).");

  for (let guard = 0; guard < 10000; guard++) {
    const pl = ns.getPlayer();
    const step = openerStep({
      cold: true, money: pl.money, city: pl.city, casinoTarget: TARGET_CASH, target: FARE,
    });

    if (step === "done") { log("already at $" + fmt(pl.money) + " -- past the casino target."); return; }

    if (step === "crime") {
      // Re-rank EVERY iteration, not once. Success chance climbs as the crime's own stat gains land,
      // so the best choice migrates upward mid-grind -- Shoplift early, something richer later. A
      // one-time ranking would sit on Shoplift for the whole run.
      const stats = [];
      for (const name of CRIMES) {
        try {
          const s = S.getCrimeStats(name);
          stats.push({ name, money: s.money, time: s.time, chance: S.getCrimeChance(name) });
        } catch (e) {}
      }
      const pick = bestCrime(stats);
      if (!pick) { log("no crime can earn here -- aborting opener."); return; }
      const need = FARE - pl.money;
      const eta = etaSeconds(pick, need);
      if (guard % 10 === 0) {
        log(pick.name + "  $" + fmt(pl.money) + "/" + fmt(FARE)
          + "  (chance " + (pick.chance * 100).toFixed(0) + "%, ~$" + fmt(pick.evPerSec) + "/s"
          + (Number.isFinite(eta) ? ", eta " + Math.ceil(eta) + "s" : "") + ")");
      }
      let ms = 0;
      try { ms = S.commitCrime(pick.name, false); } catch (e) { ms = 0; }
      // commitCrime returns ms to completion; a 0 means it was refused (already working, wrong
      // state). Sleep a beat and re-evaluate rather than spinning.
      await ns.sleep(ms > 0 ? ms + 60 : 500);
      continue;
    }

    if (step === "travel") {
      let ok = false;
      try { ok = S.travelToCity("Aevum"); } catch (e) {}
      if (!ok) { log("travelToCity(Aevum) refused with $" + fmt(pl.money) + " -- retrying."); await ns.sleep(1000); continue; }
      log("arrived in Aevum with $" + fmt(ns.getPlayer().money) + " left.");
      continue;
    }

    if (step === "casino") {
      try { S.stopAction(); } catch (e) {}
      if (!DO_CASINO) {
        log("READY: in Aevum, fare paid. Casino NOT started -- it needs two things no script can do:");
        log("  1. Options -> AUTOSAVE OFF (save icon goes red). An autosave right after a losing");
        log("     hand makes the loss permanent and defeats the save-scum.");
        log("  2. kill trader.js -- every reload rewinds ALL game state, so it would just churn.");
        log("Then:  run casino.js " + TARGET_CASH + "     (or re-run: run open.js " + TARGET_CASH + " casino)");
        return;
      }
      log("'casino' passed -- assuming autosave is OFF and trader is killed. Handing off.");
      const pid = ns.exec("casino.js", "home", 1, TARGET_CASH);
      if (!pid) log("could not exec casino.js -- run it yourself: run casino.js " + TARGET_CASH);
      return;
    }

    return;    // "skip"
  }
  log("opener guard tripped -- stopping. Check the tail for what stalled.");
}

function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "b";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "m";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Number(n).toFixed(0);
}
