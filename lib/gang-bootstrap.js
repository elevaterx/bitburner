/** lib/gang-bootstrap.js -- pure logic for getting INTO a gang, which is a different problem
 *  from running one (lib/gang-logic.js).
 *
 *  THE BUG THIS EXISTS TO FIX: gang.js gated formation on GANG_KARMA_REQ = -54,000 for every
 *  node. That constant comes from `canAccessGang` (PlayerObjectGangMethods.ts:12-30) -- but read
 *  the order of the checks:
 *
 *      if (this.bitNodeN === 2) return { success: true };          // <-- returns BEFORE the karma check
 *      if (this.activeSourceFileLvl(2) === 0) return { ... };
 *      if (this.karma > GangConstants.GangKarmaRequirement) { ... }
 *
 *  In BN2 there is NO karma requirement at all. The -54,000 gate applies only when running a gang
 *  OUTSIDE BN2 on SF2. Grinding to -54,000 inside BN2 is pure waste.
 *
 *  What actually gates you in BN2 is the gang FACTION's own invite requirement, and those vary
 *  enormously -- from "backdoor one server" to "combat 300 and 30 kills". Verified against
 *  src/Faction/FactionInfo.tsx:
 *
 *    NiteSec              backdoor avmnite-02h                          <- no karma, no combat
 *    The Black Hand       backdoor I.I.I.I                              <- no karma, no combat
 *    Slum Snakes          combat 30,  $1m,   karma -9
 *    Tetrads              combat 75,  karma -18, in Chongqing/NewTokyo/Ishima
 *    Speakers for t.Dead  combat 300, hacking 100, 30 kills, karma -45
 *    The Dark Army        combat 300, hacking 300,  5 kills, karma -45, in Chongqing
 *    The Syndicate        combat 200, hacking 200, $10m, karma -90, in Aevum/Sector-12
 *
 *  NiteSec and The Black Hand need no crime whatsoever -- and sing.js already backdoors both
 *  servers as part of its normal faction-invite phase. They are also the two HACKING gangs
 *  (NetscriptFunctions/Gang.ts:49): slower but more straightforward, since territory warfare
 *  matters less. The other five are combat gangs.
 *
 *  Pure functions only -- no `ns`. Unit-tested in tests/gang-bootstrap.test.mjs.
 */

/** The two factions that produce a HACKING gang (NetscriptFunctions/Gang.ts:49). */
export const HACKING_GANGS = ["NiteSec", "The Black Hand"];

/** Invite requirements per gang faction, from src/Faction/FactionInfo.tsx.
 *  `backdoor` is a server hostname; the stat/karma/money fields are minimums.
 *  karma is a CEILING (you need karma <= this), everything else is a floor. */
export const GANG_FACTION_REQS = Object.freeze({
  "NiteSec":               { backdoor: "avmnite-02h" },
  "The Black Hand":        { backdoor: "I.I.I.I" },
  "Slum Snakes":           { combat: 30,  money: 1e6,  karma: -9 },
  "Tetrads":               { combat: 75,  karma: -18, cities: ["Chongqing", "New Tokyo", "Ishima"] },
  "Speakers for the Dead": { combat: 300, hacking: 100, kills: 30, karma: -45 },
  "The Dark Army":         { combat: 300, hacking: 300, kills: 5,  karma: -45, cities: ["Chongqing"] },
  "The Syndicate":         { combat: 200, hacking: 200, money: 10e6, karma: -90,
                             cities: ["Aevum", "Sector-12"] },
});

/** Karma you must reach before `canAccessGang` will let you form a gang AT ALL.
 *  BN2 exempts you entirely; everywhere else it is the -54,000 gate. This is SEPARATE from,
 *  and additional to, the faction's own invite requirement. */
export function accessKarmaRequirement(bitNode, gangKarmaReq = -54000) {
  return bitNode === 2 ? 0 : gangKarmaReq;
}

/** Lowest combat stat -- `haveCombatSkills(n)` requires ALL FOUR to reach n, so the binding
 *  one is the minimum, not the average. */
export function combatLevel(skills) {
  if (!skills) return 0;
  const v = [skills.strength, skills.defense, skills.dexterity, skills.agility]
    .map((n) => (Number.isFinite(n) ? n : 0));
  return Math.min(...v);
}

/** What is still missing between a player and one faction's invite. Returns null when nothing is.
 *  player: { skills, hacking, money, karma, kills, city, backdoored: Set|Array of hostnames } */
export function inviteGap(player, faction, reqs = GANG_FACTION_REQS) {
  const req = reqs[faction];
  if (!req) return { unknownFaction: true };
  const gap = {};

  if (req.backdoor) {
    const done = player.backdoored instanceof Set
      ? player.backdoored.has(req.backdoor)
      : Array.isArray(player.backdoored) && player.backdoored.includes(req.backdoor);
    if (!done) gap.backdoor = req.backdoor;
  }
  if (req.combat) {
    const have = combatLevel(player.skills);
    if (have < req.combat) gap.combat = req.combat - have;
  }
  if (req.hacking && (player.hacking ?? 0) < req.hacking) {
    gap.hacking = req.hacking - (player.hacking ?? 0);
  }
  if (req.money && (player.money ?? 0) < req.money) gap.money = req.money - (player.money ?? 0);
  // karma is negative and must go LOWER, so the gap is how much further down we must travel
  if (req.karma !== undefined && (player.karma ?? 0) > req.karma) {
    gap.karma = (player.karma ?? 0) - req.karma;
  }
  if (req.kills && (player.kills ?? 0) < req.kills) gap.kills = req.kills - (player.kills ?? 0);
  // plural: the value is the LIST of acceptable cities, not the one we are in
  if (req.cities && !req.cities.includes(player.city)) gap.cities = req.cities;

  return Object.keys(gap).length ? gap : null;
}

/** Rough cost of closing a gap, used only to ORDER routes. Deliberately crude -- the point is
 *  that "backdoor one server" beats "combat 300 and 30 kills", not that the units are exact.
 *  A city move is cheap but not free; kills are expensive because each needs a whole Homicide. */
export function gapCost(gap) {
  if (!gap) return 0;
  if (gap.unknownFaction) return Infinity;
  return (
    (gap.backdoor ? 40 : 0) +
    (gap.combat ?? 0) * 1.0 +
    (gap.hacking ?? 0) * 0.5 +
    (gap.karma ?? 0) * 2.0 +
    (gap.kills ?? 0) * 25 +
    (gap.money ? Math.log10(gap.money) * 5 : 0) +
    (gap.cities ? 15 : 0)
  );
}

/** Rank the gang factions by how close the player is to an invite, cheapest first.
 *  Factions already joined come first at zero cost -- you can create the gang immediately. */
export function rankGangRoutes(player, factions, reqs = GANG_FACTION_REQS) {
  const joined = new Set(player.factions ?? []);
  return factions
    .map((f) => {
      const gap = joined.has(f) ? null : inviteGap(player, f, reqs);
      return {
        faction: f,
        gap,
        cost: joined.has(f) ? -1 : gapCost(gap),
        joined: joined.has(f),
        hackingGang: HACKING_GANGS.includes(f),
      };
    })
    .filter((r) => Number.isFinite(r.cost))
    .sort((a, b) => a.cost - b.cost);
}

/** Turn a gap into per-objective weights for the crime picker. Anything already satisfied gets
 *  zero weight, so we stop paying for it. Money is weighted only when it is actually short --
 *  the default money-EV picker is wrong during a bootstrap whose binding constraint is karma. */
export function bootstrapWeights(gap, accessKarmaShortfall = 0) {
  const w = { money: 0, karma: 0, combat: 0, kills: 0 };
  if (accessKarmaShortfall > 0) w.karma = 1;
  if (!gap) return w;
  if (gap.karma) w.karma = 1;
  if (gap.combat) w.combat = 1;
  if (gap.kills) w.kills = 1;
  if (gap.money) w.money = 1;
  return w;
}

/** Score a crime under weighted objectives, per second, discounted by success chance.
 *  stats is an ns.singularity.getCrimeStats() object: it carries `money`, `karma`, `kills`,
 *  `time`, and the *_exp fields. Karma and kills are only awarded on SUCCESS, which is why a
 *  hardcoded Homicide is a poor early pick -- at low combat its chance is tiny.
 *  Weights are normalised by each objective's typical magnitude so they are comparable. */
export function scoreCrime(stats, chance, weights) {
  if (!stats) return 0;
  const seconds = (stats.time || 1) / 1000;
  if (!(seconds > 0)) return 0;
  const c = Math.max(0, Math.min(1, Number(chance) || 0));
  const combatExp =
    (stats.strength_exp || 0) + (stats.defense_exp || 0) +
    (stats.dexterity_exp || 0) + (stats.agility_exp || 0);

  const w = weights || {};
  const per =
    (w.money || 0) * ((stats.money || 0) / 1e6) +     // money in millions
    (w.karma || 0) * Math.abs(stats.karma || 0) +      // karma is negative; magnitude is the gain
    (w.combat || 0) * (combatExp / 4) +                // avg combat exp across the four stats
    (w.kills || 0) * (stats.kills || 0) * 10;          // kills are rare and gate two factions

  return (c * per) / seconds;
}

/** Best crime under the given weights. candidates: [{ name, stats, chance }].
 *  Returns null when nothing scores above zero (e.g. every weight is zero). */
export function pickCrime(candidates, weights) {
  let best = null;
  for (const c of candidates || []) {
    const score = scoreCrime(c.stats, c.chance, weights);
    if (score > 0 && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}
