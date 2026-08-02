/** lib/gang-logic.js -- pure Gang decision logic. NO ns calls. The daemon (gang.js) reads game
 *  state, calls these, and performs the resulting ns actions. Everything here is unit-tested.
 *
 *  Sourced from Bitburner v3.0.2 mechanics: gang factions + karma req from GangConstants;
 *  ascension result fields are newMult/oldMult FACTORS per stat; task selection is data-driven
 *  off getTaskStats so it works for hacking AND combat gangs without hard-coding earn-task names. */

export const GANG_FACTIONS = [
  "Slum Snakes", "Tetrads", "The Syndicate", "The Dark Army",
  "Speakers for the Dead", "NiteSec", "The Black Hand",
];
export const GANG_KARMA_REQ = -54000;
export const MAX_GANG_MEMBERS = 12;

export const DEFAULT_GANG_CFG = Object.freeze({
  trainUntil: 200,          // avg combat / hack level before a member starts earning
  ascendThreshold: 1.5,     // ascend when a relevant stat's mult would grow by >= this factor
  wantedPenaltyFloor: 0.90, // below this penalty (with real wanted) put a member on reduction
  wantedLevelFloor: 10,     // ignore wanted control until wantedLevel exceeds this
  warfareMinWin: 0.65,      // engage territory warfare only if we beat EVERY holder by >= this
});

/** Average of the four combat stats. */
export function avgCombat(m) {
  return (m.str + m.def + m.dex + m.agi) / 4;
}

/** The stat that matters for this gang type. */
export function relevantStat(member, isHacking) {
  return isHacking ? member.hack : avgCombat(member);
}

/** Pick canonical earn/train task NAMES from getTaskStats output, filtered to the gang's type.
 *  taskStats: array of GangTaskStats ({name,isHacking,isCombat,baseMoney,baseRespect,baseWanted}). */
export function selectTaskNames(taskStats, isHacking) {
  const usable = taskStats.filter((t) => (isHacking ? t.isHacking : t.isCombat));
  const bestBy = (key) => usable.reduce((best, t) => (!best || t[key] > best[key] ? t : best), null);
  const worstWanted = usable.reduce((w, t) => (!w || t.baseWanted < w.baseWanted ? t : w), null);
  const money = bestBy("baseMoney");
  const respect = bestBy("baseRespect");
  return {
    train: isHacking ? "Train Hacking" : "Train Combat",
    money: money ? money.name : null,
    respect: respect ? respect.name : null,
    wanted: worstWanted && worstWanted.baseWanted < 0 ? worstWanted.name : null,
  };
}

/** Gang-wide objective: farm respect until the gang is full, then pivot to money. */
export function gangObjective(gang, memberCount, cfg = DEFAULT_GANG_CFG) {
  return memberCount < MAX_GANG_MEMBERS ? "respect" : "money";
}

/** Whether the gang currently needs a member on wanted-reduction duty. */
export function needsWantedControl(gang, cfg = DEFAULT_GANG_CFG) {
  return gang.wantedLevel > cfg.wantedLevelFloor && gang.wantedPenalty < cfg.wantedPenaltyFloor;
}

/** Task for one member. forceWanted marks the daemon's designated reducer. Pure. */
export function chooseTask(member, gang, opts) {
  const { isHacking, objective, forceWanted = false, taskNames, cfg = DEFAULT_GANG_CFG } = opts;
  if (relevantStat(member, isHacking) < cfg.trainUntil) return taskNames.train;
  if (forceWanted && taskNames.wanted) return taskNames.wanted;
  const earn = objective === "respect" ? taskNames.respect : taskNames.money;
  return earn || taskNames.money || taskNames.respect || taskNames.train;
}

/** Ascend if the best relevant ascension FACTOR clears the threshold. asc = GangMemberAscension
 *  (newMult/oldMult per stat) or null/undefined. Pure. */
export function shouldAscend(asc, isHacking, cfg = DEFAULT_GANG_CFG) {
  if (!asc) return false;
  const factors = isHacking ? [asc.hack] : [asc.str, asc.def, asc.dex, asc.agi];
  return Math.max(...factors) >= cfg.ascendThreshold;
}

/** Equipment a member should buy: relevant to gang type or an Augmentation, not already owned,
 *  cheapest first. equipList: [{name,cost,type,stats}]. Budget is applied by the caller. Pure. */
export function equipmentToBuy(member, equipList, isHacking) {
  const owned = new Set([...(member.upgrades || []), ...(member.augmentations || [])]);
  const relevant = (e) => {
    if (e.type === "Augmentation") return true;
    const s = e.stats || {};
    return isHacking ? (s.hack > 0) : (s.str > 0 || s.def > 0 || s.dex > 0 || s.agi > 0);
  };
  return equipList
    .filter((e) => !owned.has(e.name) && relevant(e))
    .sort((a, b) => a.cost - b.cost);
}

/** Engage territory warfare only if we can beat EVERY rival that still holds territory.
 *  others: Record<name,{power,territory}>; chances: Record<name, winChance 0..1>. Pure. */
export function shouldWarfare(ourFaction, others, chances, cfg = DEFAULT_GANG_CFG) {
  const holders = Object.entries(others).filter(([name, g]) => name !== ourFaction && g.territory > 0.0001);
  if (holders.length === 0) return false; // we own it all -> no clashes needed
  return holders.every(([name]) => (chances[name] ?? 0) >= cfg.warfareMinWin);
}
