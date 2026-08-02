/** bladeburner.js -- capability-gated Bladeburner manager (BN6/7, or SF-6/7 elsewhere).
 *
 *  Self-gates: exits if the Bladeburner API isn't available. Joins the division (training combat to
 *  the 100-stat entry bar via the gym first if SF-4 is present), then each tick:
 *   - regenerates when stamina is low, runs Diplomacy when city chaos is high;
 *   - fires the next Black Op when its rank is met and success >= 95%;
 *   - otherwise runs the safe Operation/Contract with the best rank-gain per second;
 *   - drains skill points into the cheapest skill in big batches (exponential/binary sizing) without
 *     over-committing past the next-cheapest skill's cost.
 *
 *  Decisions live in lib/bladeburner-logic.js (pure, unit-tested). This is the thin ns shell.
 *  usage:  run bladeburner.js [--once] [--stamina-floor 0.5] [--chaos-ceiling 50] [--success-floor 0.8]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { DEFAULT_BB_CFG, chooseAction, largestAffordableBatch } from "./lib/bladeburner-logic.js";

const GYM = "Powerhouse Gym";
const COMBAT = ["str", "def", "dex", "agi"];
const JOIN_STAT = 100;

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["once", false],
    ["stamina-floor", DEFAULT_BB_CFG.staminaFloor],
    ["chaos-ceiling", DEFAULT_BB_CFG.chaosCeiling],
    ["success-floor", DEFAULT_BB_CFG.successFloor],
    ["quiet", false],
  ]);
  const cfg = {
    ...DEFAULT_BB_CFG,
    staminaFloor: Number(flags["stamina-floor"]),
    chaosCeiling: Number(flags["chaos-ceiling"]),
    successFloor: Number(flags["success-floor"]),
  };
  const log = (m) => ns.tprint("[blade] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[blade] " + m); };

  const caps = getCapabilities(ns);
  if (!caps.bladeburner) { log("Bladeburner API unavailable (need BN6/7 or SF-6/7). Exiting."); return; }

  let blocked = false;
  while (true) {
    if (!ns.bladeburner.inBladeburner()) {
      if (!(await tryJoin(ns, caps, log, () => { blocked = true; }, blocked))) {
        if (flags.once) return;
        await ns.sleep(10_000);
        continue;
      }
      log("joined the Bladeburner division.");
    }

    // Opportunistically join the faction (unlocks its augs) -- only succeeds at rank >= 25.
    try { if (ns.bladeburner.getRank() >= 25) ns.bladeburner.joinBladeburnerFaction(); } catch (e) {}

    manage(ns, cfg, vlog);

    if (flags.once) return;
    try { await ns.bladeburner.nextUpdate(); } catch (e) { await ns.sleep(2000); }
  }
}

async function tryJoin(ns, caps, log, markBlocked, alreadyBlocked) {
  if (ns.bladeburner.joinBladeburnerDivision()) return true;

  if (!caps.singularity) {
    if (!alreadyBlocked) {
      log("Can't join yet (need all combat stats >= " + JOIN_STAT + ") and no SF-4 to auto-train. " +
        "Train str/def/dex/agi to 100, then I'll join automatically.");
      markBlocked();
    }
    return false;
  }
  // Train the lowest combat stat toward the entry bar.
  const sk = ns.getPlayer().skills;
  let lowest = COMBAT[0];
  for (const s of COMBAT) if (sk[statKey(s)] < sk[statKey(lowest)]) lowest = s;
  if (sk[statKey(lowest)] < JOIN_STAT) {
    ns.singularity.gymWorkout(GYM, lowest, false);
    log("training " + lowest + " to " + JOIN_STAT + " for Bladeburner entry (" + sk[statKey(lowest)] + "/" + JOIN_STAT + ")");
  }
  return false;
}

function statKey(gymStat) {
  return { str: "strength", def: "defense", dex: "dexterity", agi: "agility" }[gymStat];
}

function manage(ns, cfg, vlog) {
  const bb = ns.bladeburner;
  const [cur, max] = bb.getStamina();
  const city = bb.getCity();
  const nextBlackOp = bb.getNextBlackOp();

  const candidates = [];
  for (const [type, names] of [["Operations", bb.getOperationNames()], ["Contracts", bb.getContractNames()]]) {
    for (const name of names) {
      candidates.push({
        type, name,
        countRemaining: bb.getActionCountRemaining(type, name),
        chance: bb.getActionEstimatedSuccessChance(type, name)[0],
        rankGain: bb.getActionRankGain(type, name),
        time: bb.getActionTime(type, name),
      });
    }
  }

  const state = {
    staminaPct: max > 0 ? cur / max : 1,
    chaos: bb.getCityChaos(city),
    rank: bb.getRank(),
    nextBlackOp,
    blackOpChance: nextBlackOp ? bb.getActionEstimatedSuccessChance("Black Operations", nextBlackOp.name)[0] : 0,
    candidates,
  };

  const action = chooseAction(state, cfg);
  const now = bb.getCurrentAction();
  if (!now || now.type !== action.type || now.name !== action.name) {
    if (bb.startAction(action.type, action.name)) vlog("action -> " + action.type + ":" + action.name);
  }

  spendSkillPoints(ns, vlog);
}

/** Drain skill points into the cheapest skill in the largest safe batch, then re-evaluate. */
function spendSkillPoints(ns, vlog) {
  const bb = ns.bladeburner;
  let guard = 0, bought = 0;
  while (guard++ < 64) {
    const points = bb.getSkillPoints();
    const skills = bb.getSkillNames()
      .map((name) => ({ name, unit: bb.getSkillUpgradeCost(name, 1) }))
      .filter((s) => isFinite(s.unit) && s.unit <= points);
    if (!skills.length) break;
    skills.sort((a, b) => a.unit - b.unit);
    const cheapest = skills[0];
    const ceiling = skills.length > 1 ? skills[1].unit : Infinity;
    const n = largestAffordableBatch((k) => bb.getSkillUpgradeCost(cheapest.name, k), points, ceiling);
    if (n < 1 || !bb.upgradeSkill(cheapest.name, n)) break;
    bought += n;
  }
  if (bought) vlog("bought " + bought + " skill level(s)");
}
