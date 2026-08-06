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
  ascendMaxPerTick: 2,      // never ascend more than this many members in one pass (see planAscensions)
  ascendPenaltyFloor: 0.95, // never ascend into a projected wanted penalty below this
  wantedPenaltyFloor: 0.90, // below this penalty (with real wanted) put a member on reduction
  wantedLevelFloor: 10,     // ignore wanted control until wantedLevel exceeds this
  warfareMinWin: 0.65,      // engage territory warfare only if we beat EVERY holder by >= this
  objective: "auto",        // "auto" | "respect" | "money" -- see gangObjective
  // At the member cap, "auto" keeps earning RESPECT while your other income already dwarfs what a
  // gang can add. Gang money is capped and linear; respect is not, and respect is the only thing
  // that converts to gang-faction reputation (Gang.ts:152-155).
  moneyIrrelevantAbove: 1e7,  // $/s of non-gang income above which gang money is not worth a task
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
/** Which currency the gang should earn.
 *
 *  The old rule was `memberCount < 12 ? "respect" : "money"` -- written for a node where money was
 *  scarce. It ignores the reason respect keeps paying after the roster is full:
 *
 *  A gang faction sells ALMOST EVERY AUGMENTATION IN THE GAME. getFactionAugmentationsFiltered
 *  (FactionHelpers.tsx:172-176) short-circuits on `Player.hasGangWith(faction.name)` and returns
 *  the whole Augmentations table, minus isSpecial ones and a seeded filter on faction-unique augs.
 *  It does NOT return the faction's own list. So the gang faction is a universal storefront, and
 *  respect -> reputation (Gang.ts:152-155) is what unlocks it. Money buys the augs; reputation
 *  decides which ones you are allowed to buy at all.
 *
 *  Below the cap respect is forced regardless: recruiting is respect-gated at
 *  5^(members - 3 + 1) (Gang.ts:316-323), so money there would stall the roster.
 *
 *  At the cap, "auto" asks whether gang money is even material. Gang income is bounded by member
 *  stats, territory and GangSoftcap; a running stock trader or corporation is not. When the rest of
 *  your economy already earns more than `moneyIrrelevantAbove`, a money task trades an unbounded
 *  currency for a rounding error. Pure -- ctx supplies the live reading. */
export function gangObjective(gang, memberCount, cfg = DEFAULT_GANG_CFG, ctx = {}) {
  const forced = cfg && cfg.objective;
  if (forced === "respect" || forced === "money") return forced;
  if (memberCount < MAX_GANG_MEMBERS) return "respect";
  const other = Number(ctx.otherIncomeRate);
  const floor = Number(cfg.moneyIrrelevantAbove);
  if (Number.isFinite(other) && Number.isFinite(floor) && other >= floor) return "respect";
  return "money";
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

/** Best relevant ascension FACTOR for a member. asc = the object from ns.gang.getAscensionResult
 *  ({respect, hack, str, def, dex, agi, cha}), where each stat field is postAscend/preAscend
 *  (GangMember.ts:273-285) -- a RATIO, not an absolute mult. Returns 0 when the member can't
 *  ascend (the API returns undefined then). Pure. */
export function ascendGain(asc, isHacking) {
  if (!asc) return 0;
  const factors = (isHacking ? [asc.hack] : [asc.str, asc.def, asc.dex, asc.agi])
    .map(Number)
    .filter(Number.isFinite);
  if (factors.length === 0) return 0;
  return Math.max(...factors);
}

/** Respect the gang loses by ascending this member. Gang.ascendMember does
 *  `this.respect = Math.max(1, this.respect - res.respect)` (Gang.ts:390-393), where res.respect
 *  is the member's earnedRespect. Pure. */
export function ascendRespectCost(cand) {
  const fromAsc = cand && cand.asc ? Number(cand.asc.respect) : NaN;
  if (Number.isFinite(fromAsc) && fromAsc >= 0) return fromAsc;
  const fromInfo = Number(cand && cand.earnedRespect);
  return Number.isFinite(fromInfo) && fromInfo >= 0 ? fromInfo : 0;
}

/** Wanted penalty the gang WOULD have after paying `respectCost`.
 *  Gang.getWantedPenalty() is respect/(respect+wanted) (Gang.ts:357), and respect floors at 1. */
export function projectedWantedPenalty(respect, wanted, respectCost = 0) {
  const r = Math.max(1, (Number(respect) || 0) - (Number(respectCost) || 0));
  const w = Math.max(0, Number(wanted) || 0);
  if (!(r + w > 0)) return 1;
  return r / (r + w);
}

/** Back-compat single-member check: does this member's gain clear the threshold?
 *  Deliberately ignores the respect/penalty/downtime costs -- use planAscensions for decisions. */
export function shouldAscend(asc, isHacking, cfg = DEFAULT_GANG_CFG) {
  return ascendGain(asc, isHacking) >= cfg.ascendThreshold;
}

/** Decide WHICH members to ascend this pass. Pure.
 *
 *  Ascension is not free, and the raw threshold check hides three costs (all verified against
 *  v3.0.2 GangMember.ts:298-341):
 *    1. RESPECT. ascend() returns the member's earnedRespect and Gang.ascendMember subtracts it
 *       from gang respect. Since the wanted penalty is respect/(respect+wanted), draining respect
 *       raises the penalty on everything the gang earns.
 *    2. DOWNTIME. ascend() zeroes every *_exp and calls updateSkillLevels(), so the member's stats
 *       collapse to base and chooseTask puts them back on `train` until cfg.trainUntil. Ascending
 *       the whole gang in one tick idles the whole gang.
 *    3. EQUIPMENT. ascend() empties this.upgrades (augmentations survive), so buyEquipment re-buys
 *       the wiped gear out of the money budget on the next pass.
 *  So: rank by gain, break ties toward the CHEAPER member, cap the count per tick, never ascend the
 *  designated wanted-reducer (its stats reset would stop the reduction), and stop before the
 *  projected penalty falls through the floor.
 *
 *  candidates: [{ name, asc, earnedRespect, isReducer }]
 *  gang:       ns.gang.getGangInformation() -- reads .respect and .wantedLevel
 *  Returns { ascend: [name], skipped: [{ name, reason }] }. */
export function planAscensions(candidates, gang, isHacking, cfg = DEFAULT_GANG_CFG) {
  const out = { ascend: [], skipped: [] };
  if (!Array.isArray(candidates) || candidates.length === 0) return out;

  const maxPerTick = Number.isFinite(cfg.ascendMaxPerTick) && cfg.ascendMaxPerTick > 0
    ? cfg.ascendMaxPerTick : Infinity;
  const wanted = Math.max(0, Number(gang && gang.wantedLevel) || 0);
  let respect = Math.max(1, Number(gang && gang.respect) || 1);

  // EFFECTIVE floor = min(configured floor, the penalty we already have). A hard floor alone
  // deadlocks: if the gang is already below it for reasons that have nothing to do with ascending
  // (a bad wanted spike, an early gang with tiny respect), even a ZERO-cost ascension gets refused
  // and the mults never compound. Clamping to the current penalty keeps the real invariant --
  // "ascending must not make the penalty worse, and must not push it under the floor" -- while
  // still letting free ascensions through. Recovery is automatic: respect regrows, the penalty
  // climbs back over the configured floor, and normal gating resumes.
  const current = projectedWantedPenalty(respect, wanted, 0);
  const configured = Number.isFinite(cfg.ascendPenaltyFloor) ? cfg.ascendPenaltyFloor : 0;
  const floor = Math.min(configured, current);

  const ranked = candidates
    .map((c) => ({ name: c.name, isReducer: !!c.isReducer, gain: ascendGain(c.asc, isHacking), cost: ascendRespectCost(c) }))
    .filter((c) => c.gain >= cfg.ascendThreshold)
    .sort((a, b) => (b.gain - a.gain) || (a.cost - b.cost) || String(a.name).localeCompare(String(b.name)));

  for (const c of ranked) {
    if (c.isReducer) { out.skipped.push({ name: c.name, reason: "wanted-reducer" }); continue; }
    if (out.ascend.length >= maxPerTick) { out.skipped.push({ name: c.name, reason: "per-tick cap" }); continue; }
    const proj = projectedWantedPenalty(respect, wanted, c.cost);
    if (proj < floor) { out.skipped.push({ name: c.name, reason: "penalty floor " + proj.toFixed(3) }); continue; }
    out.ascend.push(c.name);
    respect = Math.max(1, respect - c.cost);
  }
  return out;
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
