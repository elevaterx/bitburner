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
import { accessKarmaRequirement, rankGangRoutes } from "./lib/gang-bootstrap.js";
import { money as fmtMoney, num as fmtNum } from "./lib/fmt.js";
import { writeStatus } from "./lib/modules.js";
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
        writeStatus(ns, "gang", { line: "forming - karma/faction" });
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

/** Bring us into a gang if possible. Returns true once in a gang.
 *
 *  NO SINGULARITY CALLS. This used to call checkFactionInvitations / joinFaction / commitCrime /
 *  getCurrentWork, which at SF4 level 2 cost 4x their base (RamCostGenerator SF4Cost) and pushed
 *  gang.js to 50.7GB -- unlaunchable on the 32GB home you get after a BitNode reset
 *  (Prestige.ts:242-248), which is exactly when you need it. Joining is sing.js's job: it already
 *  pays for Singularity, already accepts whitelisted invites, and already backdoors avmnite-02h
 *  and I.I.I.I -- the two servers that invite you to NiteSec and The Black Hand, the only gang
 *  factions with NO karma, combat, money or city requirement at all.
 *
 *  It also used to gate on GANG_KARMA_REQ (-54,000) in every node. That is wrong in BN2:
 *  canAccessGang (PlayerObjectGangMethods.ts:16) returns success on `bitNodeN === 2` BEFORE
 *  reaching the karma check, so inside BN2 the only requirement is the faction's own invite. */
async function tryFormGang(ns, caps, log, markBlocked, alreadyBlocked) {
  const p = ns.getPlayer();

  // Already a member of an eligible faction? Create the gang -- needs no Singularity.
  for (const f of GANG_FACTIONS) {
    if (p.factions.includes(f) && ns.gang.createGang(f)) return true;
  }

  if (alreadyBlocked) return false;

  let node = 0;
  try { node = ns.getResetInfo().currentNode; } catch (e) {}
  const accessReq = accessKarmaRequirement(node, GANG_KARMA_REQ);
  const shortfall = Math.max(0, (p.karma ?? 0) - accessReq);

  const routes = rankGangRoutes({
    skills: p.skills,
    hacking: p.skills && p.skills.hacking,
    money: p.money,
    karma: p.karma,
    kills: p.numPeopleKilled,
    city: p.city,
    backdoored: [],          // gang.js won't pay 2GB for getServer; sing.js owns backdoors
    factions: p.factions,
  }, GANG_FACTIONS);

  const best = routes[0];
  if (best) {
    const gap = best.gap || {};
    const need = Object.entries(gap)
      .map(([k, v]) => (k === "backdoor" ? "backdoor " + v : k === "cities" ? "be in " + v.join("/") : k + " " + Math.round(v)))
      .join(", ");
    log("not in a gang. Cheapest route: " + best.faction +
        (best.hackingGang ? " (hacking gang)" : " (combat gang)") +
        (need ? " -- needs " + need : " -- requirements already met, waiting on the invite") +
        (shortfall > 0 ? "; plus " + Math.round(shortfall) + " more karma for the node's access gate" : "") +
        ". sing.js drives the join; I take over the moment you are in one.");
  } else {
    log("not in a gang and no route found. Join a gang faction manually (" + GANG_FACTIONS.join(", ") + ").");
  }
  markBlocked();
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
  writeStatus(ns, "gang", { line: members.length + "/12  resp " + fmtNum(gang.respect) + "  " + objective + (gang.territoryWarfareEngaged ? "  war" : "") });

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
