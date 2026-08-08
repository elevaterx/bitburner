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
