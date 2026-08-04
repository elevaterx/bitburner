/** gang.js -- capability-gated Gang manager (BN2, or SF-2 elsewhere).
 *
 *  Self-gates: exits immediately if the Gang API isn't available, so boot.js can launch it blindly.
 *  If not yet in a gang it auto-forms when SF-4 (Singularity) is present -- farms Homicide to the
 *  -54,000 karma requirement, joins the first eligible gang faction it's invited to, and createGang()s.
 *  Without SF-4 it reports a one-time blocker and idles (you must join a gang faction by hand).
 *
 *  Once running: recruits to 12, trains members to a stat floor, then farms respect until the gang is
 *  full and money after that; keeps one member on wanted-reduction when the penalty bites; ascends on
 *  a strong multiplier gain -- rate-limited and respect-aware, since ascending drains gang respect
 *  (which drives the wanted penalty) and resets the member to training; buys relevant equipment
 *  within a money budget; and engages territory
 *  warfare only when it can beat every rival that still holds territory.
 *
 *  All decisions live in lib/gang-logic.js (pure, unit-tested); this file is the thin ns shell.
 *
 *  usage:  run gang.js [--once] [--equip-frac 0.1] [--train-until 200] [--ascend 1.5]
 *                      [--ascend-max 2] [--ascend-floor 0.95] [--no-warfare]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { accessKarmaRequirement, rankGangRoutes } from "./lib/gang-bootstrap.js";
import { money as fmtMoney, num as fmtNum } from "./lib/fmt.js";
import { writeStatus } from "./lib/modules.js";
import {
  GANG_FACTIONS, GANG_KARMA_REQ, DEFAULT_GANG_CFG,
  selectTaskNames, gangObjective, needsWantedControl, chooseTask,
  planAscensions, equipmentToBuy, shouldWarfare,
} from "./lib/gang-logic.js";

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["once", false],
    ["equip-frac", 0.10],
    ["train-until", DEFAULT_GANG_CFG.trainUntil],
    ["ascend", DEFAULT_GANG_CFG.ascendThreshold],
    ["ascend-max", DEFAULT_GANG_CFG.ascendMaxPerTick],
    ["ascend-floor", DEFAULT_GANG_CFG.ascendPenaltyFloor],
    ["no-warfare", false],
    ["quiet", false],
  ]);
  const cfg = {
    ...DEFAULT_GANG_CFG,
    trainUntil: Number(flags["train-until"]),
    ascendThreshold: Number(flags.ascend),
    ascendMaxPerTick: Number(flags["ascend-max"]),
    ascendPenaltyFloor: Number(flags["ascend-floor"]),
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

  // One read per member, reused below. getMemberInformation is already paid for RAM-wise.
  const infos = new Map();
  for (const name of members) infos.set(name, g.getMemberInformation(name));

  // Designate one wanted-reducer (the biggest wanted contributor) when the penalty bites.
  let reducer = null;
  if (needsWantedControl(gang, cfg) && taskNames.wanted) {
    let worst = -Infinity;
    for (const name of members) {
      const wl = infos.get(name).wantedLevelGain;
      if (wl > worst) { worst = wl; reducer = name; }
    }
  }

  // 2. Ascend -- planned gang-wide, not per-member. Ascending drains gang respect (the numerator of
  //    the wanted penalty) and resets the member to zero exp, so the plan caps how many go per tick,
  //    spares the wanted-reducer, and stops before the projected penalty breaks the floor.
  const plan = planAscensions(
    members.map((name) => ({
      name,
      asc: g.getAscensionResult(name),
      earnedRespect: infos.get(name).earnedRespect,
      isReducer: name === reducer,
    })),
    gang, isHacking, cfg,
  );
  for (const name of plan.ascend) {
    g.ascendMember(name);
    infos.set(name, g.getMemberInformation(name));   // stats/exp just reset -- retask off fresh data
    vlog("ascended " + name);
  }
  if (plan.skipped.length) {
    vlog("ascend held: " + plan.skipped.map((s) => s.name + " (" + s.reason + ")").join(", "));
  }

  // Re-read gang info: ascensions moved respect, and the status line should show the truth.
  const gangNow = plan.ascend.length ? g.getGangInformation() : gang;
  writeStatus(ns, "gang", {
    line: members.length + "/12  resp " + fmtNum(gangNow.respect) + "  " + objective
      + "  pen " + (gangNow.wantedPenalty * 100).toFixed(1) + "%"
      + (plan.ascend.length ? "  asc" + plan.ascend.length : "")
      + (gangNow.territoryWarfareEngaged ? "  war" : ""),
  });

  // 3. Retask each member.
  for (const name of members) {
    const info = infos.get(name);
    const want = chooseTask(info, gangNow, {
      isHacking, objective, forceWanted: name === reducer, taskNames, cfg,
    });
    if (want && info.task !== want) g.setMemberTask(name, want);
  }

  // 4. Equipment: buy cheapest-first across all members within a money budget this pass.
  //    Catalog is built ONCE here and shared with the data feed below, so the snapshot reports the
  //    same view of "what's still buyable" that the buyer acts on.
  const catalog = g.getEquipmentNames().map((n) => ({
    name: n, cost: g.getEquipmentCost(n), type: g.getEquipmentType(n), stats: g.getEquipmentStats(n),
  }));
  buyEquipment(ns, g, members, isHacking, Number(flags["equip-frac"]), vlog, catalog);

  // 5. Territory warfare toggle.
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

  // 6. Data feed for hud1's snapshot. Everything here comes from calls this pass ALREADY makes, so
  //    it costs no extra RAM. It exists because the two questions that actually drive gang decisions
  //    -- "what equipment is still unowned?" and "how fast is faction rep accruing?" -- were being
  //    answered by clicking through the in-game UI member by member.
  //    respectGainRate is PER CYCLE (CONSTANTS.MilliPerCycle = 200), so x5 for per-second, which is
  //    what the game's own GangStats panel displays (GangStats.tsx:59).
  const fin = g.getGangInformation();
  const mem = members.map((name) => {
    const info = infos.get(name);
    const asc = g.getAscensionResult(name);
    const miss = equipmentToBuy(info, catalog, isHacking);
    return {
      n: name,
      task: info.task,
      stat: isHacking ? info.hack : (info.str + info.def + info.dex + info.agi) / 4,
      resp: info.earnedRespect,
      asc: asc ? Math.max(...(isHacking ? [asc.hack] : [asc.str, asc.def, asc.dex, asc.agi]).map(Number).filter(Number.isFinite)) : 0,
      own: (info.upgrades || []).length + (info.augmentations || []).length,
      miss: miss.length,
      missCost: miss.reduce((a, e) => a + e.cost, 0),
    };
  });
  ns.write("gang-data.txt", JSON.stringify({
    ts: Date.now(), faction: fin.faction, isHacking: fin.isHacking, objective,
    respect: fin.respect, respectPerSec: fin.respectGainRate * 5,
    wanted: fin.wantedLevel, wantedPerSec: fin.wantedLevelGainRate * 5, penalty: fin.wantedPenalty,
    territory: fin.territory, war: fin.territoryWarfareEngaged, clash: fin.territoryClashChance,
    power: fin.power, moneyPerSec: fin.moneyGainRate * 5,
    equipCostMult: fin.equipmentCostMult,          // 1 / getDiscount()
    factionRepMult: (ns.getPlayer().mults && ns.getPlayer().mults.faction_rep) || 1,
    members: mem,
  }), "w");
}

function buyEquipment(ns, g, members, isHacking, equipFrac, vlog, catalog) {
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
