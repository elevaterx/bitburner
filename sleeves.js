/** sleeves.js -- capability-gated Sleeve manager (BN10, or SF-10 elsewhere).
 *
 *  Self-gates: exits if the Sleeve API isn't available, so boot.js can launch it blindly.
 *  Per sleeve: synchronize to 100 -> recover shock to the working floor -> commit crime for money.
 *  Optionally buys sleeve augmentations cheapest-first within a money budget (off by default; cloud
 *  cash + augs don't persist a soft reset, so opt in with --aug-frac).
 *
 *  Decisions live in lib/sleeve-logic.js (pure, unit-tested); this file is the thin ns shell.
 *
 *  usage:  run sleeves.js [--once] [--crime Homicide] [--max-shock 0] [--aug-frac 0] [--aug-reserve 0]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { money as fmtMoney } from "./lib/fmt.js";
import { DEFAULT_SLEEVE_CFG, chooseSleeveAction, actionMatchesTask, affordableSleeveAugs } from "./lib/sleeve-logic.js";

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["once", false],
    ["crime", DEFAULT_SLEEVE_CFG.crime],
    ["max-shock", DEFAULT_SLEEVE_CFG.maxShock],
    ["aug-frac", 0],        // fraction of money to spend on sleeve augs per pass (0 = skip)
    ["aug-reserve", 0],     // money to keep untouched when buying augs
    ["quiet", false],
  ]);
  const cfg = {
    ...DEFAULT_SLEEVE_CFG,
    crime: String(flags.crime),
    maxShock: Number(flags["max-shock"]),
  };
  const log = (m) => ns.tprint("[sleeves] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[sleeves] " + m); };

  const caps = getCapabilities(ns);
  if (!caps.sleeves) {
    log("Sleeve API unavailable in this node (need BN10 or SF-10). Exiting.");
    return;
  }

  const n = ns.sleeve.getNumSleeves();
  log("managing " + n + " sleeve(s).");

  while (true) {
    if (Number(flags["aug-frac"]) > 0) buyAugs(ns, Number(flags["aug-frac"]), Number(flags["aug-reserve"]), vlog);

    for (let i = 0; i < n; i++) {
      const s = ns.sleeve.getSleeve(i);
      const action = chooseSleeveAction(s, cfg);
      if (actionMatchesTask(action, ns.sleeve.getTask(i))) continue;   // already doing it -> don't reset progress
      applyAction(ns, i, action, vlog);
    }

    if (flags.once) return;
    await ns.sleep(6000);
  }
}

function applyAction(ns, i, action, vlog) {
  let ok = false;
  if (action.type === "sync") ok = ns.sleeve.setToSynchronize(i);
  else if (action.type === "shock") ok = ns.sleeve.setToShockRecovery(i);
  else if (action.type === "crime") ok = ns.sleeve.setToCommitCrime(i, action.crime);
  vlog("sleeve " + i + " -> " + (action.crime ? action.type + ":" + action.crime : action.type) + (ok ? "" : " (FAILED)"));
}

/** Buy the cheapest sleeve augs that fit the per-pass budget, across all sleeves. */
function buyAugs(ns, augFrac, reserve, vlog) {
  const n = ns.sleeve.getNumSleeves();
  let budget = ns.getPlayer().money * augFrac - reserve;
  if (budget <= 0) return;

  // Collect (sleeve, aug) candidates and buy globally cheapest first.
  const cands = [];
  for (let i = 0; i < n; i++) {
    for (const a of ns.sleeve.getSleevePurchasableAugs(i)) cands.push({ i, name: a.name, cost: a.cost });
  }
  cands.sort((a, b) => a.cost - b.cost);

  let spent = 0, bought = 0;
  for (const c of cands) {
    if (c.cost > budget - spent) continue;
    if (ns.sleeve.purchaseSleeveAug(c.i, c.name)) { spent += c.cost; bought++; }
  }
  if (bought) vlog("bought " + bought + " sleeve aug(s) for " + fmtMoney(spent));
}
