/** lib/node-open.js -- pure logic for the cold-node opener. No `ns`, so it is unit-testable.
 *
 *  WHY AN OPENER EXISTS. The least automated stretch of any run is the first two minutes: a fresh
 *  BitNode gives you $1,262 (prestigeAugmentation sets money = 1000 + CONSTANTS.Donations), travel
 *  to Aevum costs $200,000 (CONSTANTS.TravelCost = 200e3), and the casino -- which caps out around
 *  $10b and funds the entire early game -- is in Aevum. Only BN13 gifts you exactly the travel fare
 *  (Prestige.ts:341-343); everywhere else you must earn it first.
 *
 *  So the opener is a three-step chain that boot.js can drive unattended:
 *      crime to $200k  ->  travelToCity("Aevum")  ->  casino.js
 *
 *  Everything here is the decision-making half. The `ns` half lives in open.js.
 */

/** Travel fare, and therefore the crime target. CONSTANTS.TravelCost. */
export const TRAVEL_COST = 200e3;

/** Buffer over the fare so a rounding error or a mid-flight purchase cannot strand you in the wrong
 *  city with no way back. Cheap insurance -- one extra Shoplift. */
export const TRAVEL_BUFFER = 1.25;

/** A fresh BitNode, no install yet.
 *
 *  getResetInfo() returns lastNodeReset and lastAugReset. Entering a node sets BOTH; installing
 *  augmentations sets only lastAugReset. So they are equal exactly while no install has happened
 *  since node entry -- which is a precise test, not a heuristic on cash or aug count. (Cash is a bad
 *  proxy: the casino can leave you rich inside a still-cold node.) */
export function isColdNode(resetInfo) {
  if (!resetInfo) return false;
  const node = Number(resetInfo.lastNodeReset), aug = Number(resetInfo.lastAugReset);
  if (!Number.isFinite(node) || !Number.isFinite(aug)) return false;
  return aug <= node;
}

/** Rank crimes by expected money per second: chance * money / time.
 *
 *  `crimes` is [{ name, money, time, chance }] -- money and time from getCrimeStats, chance from
 *  getCrimeChance. Ranking on EV RATE rather than raw payout matters at base stats, where the big
 *  crimes have a payout you will almost never collect: Homicide pays far more than Shoplift but at a
 *  few percent success it is worse per second, and a failed crime still burns the full duration.
 *
 *  Ties break toward the SHORTER crime -- at the start of a node you want frequent small wins, both
 *  because the target is only $200k and because a shorter loop reacts faster once stats climb. */
export function rankCrimes(crimes) {
  return [...(crimes || [])]
    .filter((c) => c && Number(c.time) > 0 && Number(c.money) > 0)
    .map((c) => ({
      ...c,
      evPerSec: (Number(c.chance) || 0) * Number(c.money) / (Number(c.time) / 1000),
    }))
    .filter((c) => c.evPerSec > 0)
    .sort((a, b) => (b.evPerSec - a.evPerSec) || (a.time - b.time) || String(a.name).localeCompare(String(b.name)));
}

/** Best crime, or null if none can earn. */
export function bestCrime(crimes) {
  const r = rankCrimes(crimes);
  return r.length ? r[0] : null;
}

/** How much cash the crime phase must reach before travelling. */
export function crimeTarget(costOfTravel = TRAVEL_COST, buffer = TRAVEL_BUFFER) {
  return Math.ceil(costOfTravel * buffer);
}

/** Rough seconds to earn `need` at a crime's EV rate. Used only to decide whether to log an ETA and
 *  to size the stall guard -- never as a promise. */
export function etaSeconds(crime, need) {
  if (!crime || !(crime.evPerSec > 0) || !(need > 0)) return Infinity;
  return need / crime.evPerSec;
}

/** What the opener should do next, given where you are. Returns one of:
 *    "skip"    -- not a cold node, or the opener already ran
 *    "crime"   -- need travel fare
 *    "travel"  -- have fare, wrong city
 *    "casino"  -- in Aevum with fare spent; hand off
 *    "done"    -- already past the casino target
 *
 *  Written as a state function rather than a linear script so open.js can be re-run at any point --
 *  after a casino save-scum RELOAD, Bitburner restarts the scripts that were running at the last
 *  save, so the opener must be able to resume from wherever it finds itself rather than starting
 *  over and re-committing crimes it does not need. */
export function openerStep(state = {}) {
  const { cold, money, city, casinoTarget = 10e9, target = crimeTarget() } = state;
  if (!cold) return "skip";
  if (Number(money) >= casinoTarget) return "done";
  if (Number(money) < target && city !== "Aevum") return "crime";
  if (city !== "Aevum") return "travel";
  return "casino";
}

/** How long after an install the farm is still REBUILDING rather than earning.
 *
 *  An install zeroes hacking exp and deletes every purchased server (prestigeAugmentation,
 *  PlayerObjectGeneralMethods.ts:80-142), but home RAM survives. So the pool is large while the
 *  harvest crew is tiny -- coordinator's levelRatio gate only targets servers whose required level
 *  is <= 0.9 x yours, and yours is back at its floor. That slack is exactly what xpw exists to soak,
 *  and level is the binding constraint on the whole ramp (it gates harvest targets AND, through
 *  faction work, rep/s).
 *
 *  Being wrong here is cheap in both directions: coordinator's xpw shrink path has no deadband
 *  (coordinator.js:656-668), so xpw yields RAM immediately when a crew grows -- the only cost is up
 *  to one LOOP_MS (15s) of placement latency. So a generous window beats a tight one. */
export const REBUILD_WINDOW_MS = 30 * 60 * 1000;

/** True while we are inside REBUILD_WINDOW_MS of the last install.
 *
 *  getResetInfo().lastAugReset is an epoch-ms TIMESTAMP, not an elapsed time -- PlayerObject.ts:168
 *  sets `this.lastAugReset = this.lastNodeReset = Date.now()`, and the documented idiom is
 *  `Date.now() - ns.getResetInfo().lastAugReset` (NetscriptDefinitions.d.ts:9228). It is -1 before
 *  the player object is initialised (PlayerObject.ts:61), which we reject.
 *
 *  Entering a BitNode sets BOTH stamps, so a cold node reads as just-installed too. That is correct,
 *  not a leak: a fresh node is the most extreme rebuild case there is. */
export function justInstalled(resetInfo, now = Date.now(), windowMs = REBUILD_WINDOW_MS) {
  if (!resetInfo) return false;
  const aug = Number(resetInfo.lastAugReset);
  if (!Number.isFinite(aug) || aug <= 0) return false;
  const age = Number(now) - aug;
  return Number.isFinite(age) && age >= 0 && age < windowMs;
}

/** Which coordinator preset boot should launch.
 *
 *  `income` and `rebuild` differ in exactly one of six positional args -- xpw, the idle-pool XP
 *  filler ([40, 0.9, 0, 7, X, 0.85]). So this is a one-bit decision and it should be read off state
 *  rather than remembered by the operator.
 *
 *  KNOWN LIMITATION: boot runs once, so this choice is STICKY for the session. If the fleet rebuilds
 *  inside the window, coord stays in `rebuild` until something restarts it (hud1's restart button
 *  keeps the args, so pass `income` there). Making coord flip xpw on its own slack would remove the
 *  stickiness; that was considered and deferred. */
export function coordPreset(resetInfo, now = Date.now(), windowMs = REBUILD_WINDOW_MS) {
  return justInstalled(resetInfo, now, windowMs) ? "rebuild" : "income";
}
