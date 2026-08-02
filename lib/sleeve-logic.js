/** lib/sleeve-logic.js -- pure Sleeve decision logic. NO ns calls. Unit-tested.
 *  SleevePerson (v3.0.2): { shock (0..100, want 0), sync (0..100, want 100), skills{...}, city }.
 *  Priority: raise sync to 100 -> recover shock to the working floor -> earn (crime). Aug buying is
 *  handled by the daemon (needs a live price list + budget); affordableSleeveAugs sizes that. */

export const DEFAULT_SLEEVE_CFG = Object.freeze({
  syncTarget: 100,   // synchronize until sync reaches this
  maxShock: 0,       // recover shock down to this before earning (0 = fully recover)
  crime: "Homicide", // earn task once synced+recovered (good money + karma + combat xp)
});

/** What a single sleeve should be doing right now. Returns a small action descriptor. Pure. */
export function chooseSleeveAction(sleeve, cfg = DEFAULT_SLEEVE_CFG) {
  if (sleeve.sync < cfg.syncTarget) return { type: "sync" };
  if (sleeve.shock > cfg.maxShock) return { type: "shock" };
  return { type: "crime", crime: cfg.crime };
}

/** True if the sleeve's current task already matches the desired action, so the daemon can skip a
 *  redundant setTo* call (which would reset crime progress every tick). task = getTask() result. */
export function actionMatchesTask(action, task) {
  if (!task) return false;
  if (action.type === "sync") return task.type === "SYNCHRO";
  if (action.type === "shock") return task.type === "RECOVERY";
  if (action.type === "crime") return task.type === "CRIME" && task.crimeType === action.crime;
  return false;
}

/** Greedily choose the cheapest augs that fit the budget. augPairs: [{name,cost}] (AugmentPair).
 *  Returns the names to buy, cheapest first, whose running total stays within budget. Pure. */
export function affordableSleeveAugs(augPairs, budget) {
  const sorted = [...augPairs].sort((a, b) => a.cost - b.cost);
  const out = [];
  let spent = 0;
  for (const a of sorted) {
    if (spent + a.cost <= budget) { out.push(a.name); spent += a.cost; }
  }
  return out;
}
