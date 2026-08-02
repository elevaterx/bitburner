/** gang.js -- capability-gated Gang manager (BN2, or SF-2 elsewhere).
 *
 *  Self-gates: exits immediately if the Gang API isn't available, so boot.js can launch it blindly.
 *  If not yet in a gang it auto-forms when SF-4 (Singularity) is present -- farms Homicide to the
 *  -54,000 karma requirement, joins the first eligible gang faction it's invited to, and createGang()s.
 *  Without SF-4 it reports a one-time blocker and idles (you must join a gang faction by hand).
 *
 *  Once running: recruits to 12, trains members to a stat floor, then farms respect until the gang is
 *  full and money after that; keeps one member on wanted-reduction when the penalty bites; ascends on
 *  a strong multiplier gain; buys relevant equipment within a money budget; and engages territory
 *  warfare only when it can beat every rival that still holds territory.
 *
 *  All decisions live in lib/gang-logic.js (pure, unit-tested); this file is the thin ns shell.
 *
 *  usage:  run gang.js [--once] [--equip-frac 0.1] [--train-until 200] [--ascend 1.5] [--no-warfare]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { money as fmtMoney } from "./lib/fmt.js";
import {
  GANG_FACTIONS, GANG_KARMA_REQ, DEFAULT_GANG_CFG,
  selectTaskNames, gangObjective, needsWantedControl, chooseTask,
  shouldAscend, equipmentToBuy, shouldWarfare,
} from "./lib/gang-logic.js";

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["once", false],
    ["equip-frac", 0.10],
    ["train-until", DEFAULT_GANG_CFG.trainUntil],
    ["ascend", DEFAULT_GANG_CFG.ascendThreshold],
    ["no-warfare", false],
    ["quiet", false],
  ]);
  const cfg = {
    ...DEFAULT_GANG_CFG,
    trainUntil: Number(flags["train-until"]),
    ascendThreshold: Number(flags.ascend),
  };
  const log = (m) => ns.tprint("[gang] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[gang] " + m); };

  const caps = getCapabilities(ns);
  if (!caps.gang) {
    log("Gang API unavailable in this node (need BN2 or SF-2). Exiting.");
    return;
  }

  let blockedNotified = false;
  while (true) {
    if (!ns.gang.inGang()) {
      const formed = await tryFormGang(ns, caps, log, () => { blockedNotified = true; }, blockedNotified);
      if (!formed) {
        if (flags.once) return;
        await ns.sleep(10_000);
        continue;
      }
      log("gang formed with " + ns.gang.getGangInformation().faction + ".");
    }

    manageGang(ns, cfg, flags, vlog);

    if (flags.once) return;
    // v3 gangs expose an async tick; await it so we act exactly once per gang update.
    try { await ns.gang.nextUpdate(); } catch (e) { await ns.sleep(2000); }
  }
}

/** Bring us into a gang if possible. Returns true once in a gang. */
async function tryFormGang(ns, caps, log, markBlocked, alreadyBlocked) {
  const p = ns.getPlayer();

  // Already a member of an eligible faction? Just create the gang.
  for (const f of GANG_FACTIONS) {
    if (p.factions.includes(f) && ns.gang.createGang(f)) return true;
  }

  if (!caps.singularity) {
    if (!alreadyBlocked) {
      log("Not in a gang and no SF-4 to automate it. Join a gang faction manually (" +
        GANG_FACTIONS.join(", ") + "); I'll take over once you're in one.");
      markBlocked();
    }
    return false;
  }

  // With Singularity: accept an eligible invite if we have one, else farm karma toward the requirement.
  const invites = ns.singularity.checkFactionInvitations();
  for (const f of invites) {
    if (GANG_FACTIONS.includes(f) && ns.singularity.joinFaction(f)) {
      if (ns.gang.createGang(f)) return true;
    }
  }

  if (p.karma > GANG_KARMA_REQ) {
    // Homicide is the fastest karma/combat route; only (re)start if we're not already on it.
    const work = ns.singularity.getCurrentWork();
    if (!work || work.type !== "CRIME" || work.crimeType !== "Homicide") {
      ns.singularity.commitCrime("Homicide", false);
    }
    log("building karma for a gang: " + Math.round(p.karma) + " / " + GANG_KARMA_REQ +
      " (committing Homicide)");
  } else {
    log("karma met (" + Math.round(p.karma) + ") but no eligible gang invite yet -- keep committing crime / lowering karma.");
  }
  return false;
}

/** One management pass over the current gang. */
function manageGang(ns, cfg, flags, vlog) {
  const g = ns.gang;

  // 1. Recruit every free/affordable slot.
  let recruited = 0;
  while (g.canRecruitMember()) {
    const name = nextMemberName(g.getMemberNames());
    if (!g.recruitMember(name)) break;
    recruited++;
  }
  if (recruited) vlog("recruited " + recruited + " member(s)");

  const gang = g.getGangInformation();
  const isHacking = gang.isHacking;
  const members = g.getMemberNames();
  const taskNames = selectTaskNames(g.getTaskNames().map((n) => g.getTaskStats(n)), isHacking);
  const objective = gangObjective(gang, members.length, cfg);

  // Designate one wanted-reducer (the biggest wanted contributor) when the penalty bites.
  let reducer = null;
  if (needsWantedControl(gang, cfg) && taskNames.wanted) {
    let worst = -Infinity;
    for (const name of members) {
      const wl = g.getMemberInformation(name).wantedLevelGain;
      if (wl > worst) { worst = wl; reducer = name; }
    }
  }

  // 2. Ascend + retask each member.
  for (const name of members) {
    const info = g.getMemberInformation(name);
    if (shouldAscend(g.getAscensionResult(name), isHacking, cfg)) {
      g.ascendMember(name);
      vlog("ascended " + name);
    }
    const want = chooseTask(g.getMemberInformation(name), gang, {
      isHacking, objective, forceWanted: name === reducer, taskNames, cfg,
    });
    if (want && info.task !== want) g.setMemberTask(name, want);
  }

  // 3. Equipment: buy cheapest-first across all members within a money budget this pass.
  buyEquipment(ns, g, members, isHacking, Number(flags["equip-frac"]), vlog);

  // 4. Territory warfare toggle.
  if (!flags["no-warfare"]) {
    const others = g.getAllGangInformation();
    const chances = {};
    for (const name of Object.keys(others)) {
      if (name !== gang.faction) chances[name] = g.getChanceToWinClash(name);
    }
    const engage = shouldWarfare(gang.faction, others, chances, cfg);
    if (engage !== gang.territoryWarfareEngaged) {
      g.setTerritoryWarfare(engage);
      vlog("territory warfare " + (engage ? "ENGAGED" : "stood down"));
    }
  }
}

function buyEquipment(ns, g, members, isHacking, equipFrac, vlog) {
  const names = g.getEquipmentNames();
  const catalog = names.map((n) => ({
    name: n, cost: g.getEquipmentCost(n), type: g.getEquipmentType(n), stats: g.getEquipmentStats(n),
  }));
  let budget = ns.getPlayer().money * equipFrac;
  if (budget <= 0) return;

  // Flatten to (member, item) candidates, then buy globally cheapest first within budget.
  const cands = [];
  for (const name of members) {
    const member = g.getMemberInformation(name);
    for (const e of equipmentToBuy(member, catalog, isHacking)) cands.push({ member: name, e });
  }
  cands.sort((a, b) => a.e.cost - b.e.cost);

  let spent = 0, bought = 0;
  for (const c of cands) {
    if (c.e.cost > budget - spent) continue;
    if (g.purchaseEquipment(c.member, c.e.name)) { spent += c.e.cost; bought++; }
  }
  if (bought) vlog("bought " + bought + " equipment for " + fmtMoney(spent));
}

const NAME_POOL = ["Ada", "Byte", "Cipher", "Daemon", "Echo", "Flux", "Ghost", "Hex",
  "Iris", "Jolt", "Krypt", "Loki", "Mesh", "Nyx", "Onyx", "Proxy"];
function nextMemberName(existing) {
  const used = new Set(existing);
  for (const n of NAME_POOL) if (!used.has(n)) return n;
  let i = existing.length;
  while (used.has("gm-" + i)) i++;
  return "gm-" + i;
}
