/** lib/node-policy.js -- ONE place that decides which income engines a BitNode wants, and why.
 *
 *  WHY THIS EXISTS. The same question -- "can scripted hacking earn here?" -- was being answered in
 *  three places, in three shapes, none of which knew about the others:
 *      lib/aug-plan.js  moneyFarmWeight(), a CONTINUOUS weight for aug scoring
 *      boot.js          hackIncomeDead(), an inline 0.05 cutoff plus a hardcoded BN8 fast path
 *      sing.js          gangWorthIt, a third copy added under time pressure
 *  Three copies drift. This module owns the definition; callers own their own thresholds.
 *
 *  IT RETURNS REASONS, NOT JUST BOOLEANS. hud1's comments already warn that an absent section is
 *  indistinguishable from a section with nothing to say. The same is true of a module that is off:
 *  "Gang [off]" reads identically whether the gang was skipped deliberately or crashed on boot. Every
 *  decision here carries the sentence that explains it, so the panel can print WHY.
 *
 *  Pure -- no `ns`. Callers pass what they have; anything missing degrades to the vanilla assumption
 *  rather than silently disabling an engine.
 */

/** Below this, farm income is not worth the RAM. Matches purchaser.js's long-standing cutoff. */
export const DEAD_HACK_THRESHOLD = 0.05;

/** How much scripted hacking can earn in this node, relative to vanilla.
 *
 *  Farm income scales with ScriptHackMoneyGain x ServerMaxMoney. That product is 1 in a vanilla node,
 *  0.08 in BN2, 0.04 in BN3, 0.01 in BN9 and 0 in BN8 -- so it catches every dead-hack node without
 *  hardcoding node numbers, which is why it beats the BN8 special-case it replaces.
 *
 *  Unknown multipliers default to 1: a missing SF5 should read as "assume the node allows it" and let
 *  observed activity decide, never as "silently disable the farm". */
export function hackMoneyIndex(mults) {
  const g = mults && typeof mults.ScriptHackMoneyGain === "number" ? mults.ScriptHackMoneyGain : 1;
  const m = mults && typeof mults.ServerMaxMoney === "number" ? mults.ServerMaxMoney : 1;
  if (!Number.isFinite(g) || !Number.isFinite(m)) return 1;
  return Math.max(0, g) * Math.max(0, m);
}

export function hackMoneyLive(mults, threshold = DEAD_HACK_THRESHOLD) {
  return hackMoneyIndex(mults) >= threshold;
}

const sfLvl = (sourceFiles, n) => {
  if (!sourceFiles) return 0;
  if (typeof sourceFiles.get === "function") return Number(sourceFiles.get(n)) || 0;
  return Number(sourceFiles[n]) || 0;
};

/** Decide the engine set for this node.
 *
 *  ctx:
 *    mults          BitNode multipliers (getBitNodeMultipliers), or null
 *    bitNode        current node number
 *    sourceFiles    Map or object of SF level by number (getResetInfo().ownedSF)
 *    hasGang        a gang already exists
 *    hasCorp        a corporation already exists
 *    homeRamGB      free home RAM, for the corp's ~564GB footprint
 *    threshold      override DEAD_HACK_THRESHOLD
 *
 *  Every entry is { on, reason }. `on` for gang/corp means WORTH ESTABLISHING -- an engine you
 *  already own is always kept, because both survive installs and cost nothing to keep running. */
export function nodePolicy(ctx = {}) {
  const { mults = null, bitNode = 0, sourceFiles = null,
          hasGang = false, hasCorp = false, homeRamGB = Infinity,
          threshold = DEAD_HACK_THRESHOLD } = ctx;

  const idx = hackMoneyIndex(mults);
  const live = idx >= threshold;
  const idxStr = idx.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

  const hackFarm = live
    ? { on: true, reason: `hacking money is live (index ${idxStr} >= ${threshold})` }
    : { on: false, reason: `scripted hacking is dead here (index ${idxStr} < ${threshold}) -- the farm would burn the pool for ~$0` };

  // GANG. It is an income SUBSTITUTE, not a bonus: ~28h of karma grind, preceded by a gym phase that
  // suppresses faction work for the whole node. Worth it only where the farm cannot earn. Observed
  // live in BN12, where every multiplier is 1.0: the karma gate ran anyway and sing produced nothing
  // for 4.2 hours.
  const canGang = bitNode === 2 || sfLvl(sourceFiles, 2) > 0;
  let gang;
  if (hasGang) gang = { on: true, reason: "already formed -- gangs survive installs and cost nothing to keep" };
  else if (!canGang) gang = { on: false, reason: "needs SF2 (or BN2)" };
  // BN2 IS NOT AN INCOME DECISION. getFactionAugmentationsFiltered pushes The Red Pill into the gang
  // faction's list when bitNodeN === 2 (FactionHelpers.tsx:180-183), and TRP is otherwise Daedalus-
  // only. So in BN2 the gang is the EXIT PATH, and the income index is irrelevant -- which is why
  // BN2's 0.08 sitting just above the 0.05 cutoff must not be allowed to skip it.
  else if (bitNode === 2) gang = { on: true, reason: "BN2: the gang faction is the only source of The Red Pill -- this is the exit path, not income" };
  else if (live) gang = { on: false, reason: `not worth ~28h of karma grind -- the farm earns here (index ${idxStr})` };
  else gang = { on: true, reason: `the farm is dead here (index ${idxStr}); the gang is the income engine` };

  // CORP. Same logic, different cost: ~$150b to start and a ~564GB resident script.
  const canCorp = bitNode === 3 || sfLvl(sourceFiles, 3) > 0;
  let corp;
  if (hasCorp) corp = { on: true, reason: "already exists -- survives installs, low ongoing cost" };
  else if (!canCorp) corp = { on: false, reason: "needs SF3 (or BN3)" };
  else if (homeRamGB < 600) corp = { on: false, reason: `needs ~564GB resident; only ${Math.round(homeRamGB)}GB free` };
  else if (live) corp = { on: false, reason: `the farm earns here (index ${idxStr}); a corp is a slower substitute` };
  else corp = { on: true, reason: `the farm is dead here (index ${idxStr}); a corp is a durable earner` };

  // STOCKS. Never node-gated on hacking; SF8 grants the API outside BN8. Always worth running -- it
  // compounds and needs no RAM beyond the trader itself.
  const canStocks = bitNode === 8 || sfLvl(sourceFiles, 8) > 0;
  const stocks = canStocks
    ? { on: true, reason: bitNode === 8 ? "BN8 -- stocks are the only earner" : "SF8: TIX available, compounds independently of the farm" }
    : { on: false, reason: "needs SF8 (or BN8)" };

  return { index: idx, hackMoneyLive: live, hackFarm, gang, corp, stocks };
}

/** One line per engine, for the panel/hud. Prints the REASON, so an intentionally-off module never
 *  looks like a crashed one. */
export function policyLines(policy) {
  if (!policy) return [];
  return ["hackFarm", "gang", "corp", "stocks"].map((k) => {
    const e = policy[k];
    return `  ${k.padEnd(9)} ${e.on ? "ON " : "off"}  ${e.reason}`;
  });
}
