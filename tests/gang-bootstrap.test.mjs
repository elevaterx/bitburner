import test from "node:test";
import assert from "node:assert/strict";
import {
  HACKING_GANGS, GANG_FACTION_REQS, accessKarmaRequirement, combatLevel,
  inviteGap, gapCost, rankGangRoutes, bootstrapWeights, scoreCrime, pickCrime,
} from "../lib/gang-bootstrap.js";

const FACTIONS = Object.keys(GANG_FACTION_REQS);
const fresh = (over = {}) => ({
  skills: { strength: 1, defense: 1, dexterity: 1, agility: 1 },
  hacking: 1, money: 0, karma: 0, kills: 0, city: "Sector-12",
  backdoored: new Set(), factions: [], ...over,
});

test("BN2 has NO access-karma requirement; everywhere else keeps the -54,000 gate", () => {
  // canAccessGang returns success on bitNodeN === 2 BEFORE reaching the karma check
  assert.equal(accessKarmaRequirement(2), 0);
  assert.equal(accessKarmaRequirement(1), -54000);
  assert.equal(accessKarmaRequirement(9), -54000);
  assert.equal(accessKarmaRequirement(2, -54000), 0);
});

test("combatLevel is the MINIMUM stat -- haveCombatSkills(n) needs all four", () => {
  assert.equal(combatLevel({ strength: 100, defense: 100, dexterity: 100, agility: 5 }), 5);
  assert.equal(combatLevel({ strength: 30, defense: 30, dexterity: 30, agility: 30 }), 30);
  assert.equal(combatLevel(null), 0);
  // a missing stat counts as 0 rather than blowing up the Math.min
  assert.equal(combatLevel({ strength: 50, defense: 50, dexterity: 50 }), 0);
});

test("the two hacking gangs need only a backdoor -- no karma, no combat, no money", () => {
  assert.deepEqual(HACKING_GANGS, ["NiteSec", "The Black Hand"]);
  for (const f of HACKING_GANGS) {
    const req = GANG_FACTION_REQS[f];
    assert.ok(req.backdoor, `${f} should be backdoor-gated`);
    assert.equal(req.karma, undefined);
    assert.equal(req.combat, undefined);
    assert.equal(req.money, undefined);
  }
  // and the gap is exactly the backdoor for a brand-new player
  assert.deepEqual(inviteGap(fresh(), "NiteSec"), { backdoor: "avmnite-02h" });
  assert.equal(inviteGap(fresh({ backdoored: new Set(["avmnite-02h"]) }), "NiteSec"), null);
});

test("inviteGap treats karma as a ceiling to travel DOWN to, not a floor", () => {
  // Slum Snakes wants karma <= -9. At karma 0 you are 9 short; at -20 you are done.
  assert.equal(inviteGap(fresh({ karma: 0 }), "Slum Snakes").karma, 9);
  assert.equal(inviteGap(fresh({ karma: -20 }), "Slum Snakes").karma, undefined);
  // full Slum Snakes gap from scratch: combat 29 short, $1m short, karma 9 short
  const gap = inviteGap(fresh(), "Slum Snakes");
  assert.equal(gap.combat, 29);
  assert.equal(gap.money, 1e6);
  assert.equal(gap.karma, 9);
  // satisfied on every axis -> null, not an empty object
  assert.equal(inviteGap(fresh({
    skills: { strength: 30, defense: 30, dexterity: 30, agility: 30 }, money: 1e6, karma: -9,
  }), "Slum Snakes"), null);
});

test("inviteGap reports city and kill requirements", () => {
  const g = inviteGap(fresh(), "The Dark Army");
  assert.deepEqual(g.cities, ["Chongqing"]);
  assert.equal(g.kills, 5);
  assert.equal(inviteGap(fresh({ city: "Chongqing" }), "The Dark Army").cities, undefined);
  assert.deepEqual(inviteGap(fresh(), "Not A Faction"), { unknownFaction: true });
});

test("route ranking prefers a backdoor over any crime grind, and joined factions over everything", () => {
  const routes = rankGangRoutes(fresh(), FACTIONS);
  assert.equal(routes[0].faction, "NiteSec");        // one backdoor
  assert.ok(routes[0].hackingGang);
  // the 30-kill / combat-300 factions must rank below Slum Snakes
  const idx = (f) => routes.findIndex((r) => r.faction === f);
  assert.ok(idx("Slum Snakes") < idx("Speakers for the Dead"));
  assert.ok(idx("Slum Snakes") < idx("The Syndicate"));

  // already a member -> cost -1, sorts first, gap null (create the gang immediately)
  const joined = rankGangRoutes(fresh({ factions: ["Tetrads"] }), FACTIONS);
  assert.equal(joined[0].faction, "Tetrads");
  assert.equal(joined[0].gap, null);
  assert.ok(joined[0].joined);
  assert.equal(joined[0].hackingGang, false);
});

test("bootstrapWeights only pays for what is still missing", () => {
  // karma satisfied, combat short -> do not spend the crime budget on karma
  assert.deepEqual(bootstrapWeights({ combat: 29 }), { money: 0, karma: 0, combat: 1, kills: 0 });
  assert.deepEqual(bootstrapWeights({ karma: 9, money: 1e6 }),
                   { money: 1, karma: 1, combat: 0, kills: 0 });
  // nothing missing and no access shortfall -> all zero, so pickCrime declines to pick
  assert.deepEqual(bootstrapWeights(null), { money: 0, karma: 0, combat: 0, kills: 0 });
  // outside BN2 the -54,000 access gate adds karma weight even when the faction is satisfied
  assert.equal(bootstrapWeights(null, 54000).karma, 1);
});

test("scoreCrime discounts by success chance -- which is why hardcoded Homicide is wrong early", () => {
  // Homicide: big karma, but ~1% success at starting stats. Mug: small karma, ~50% success.
  const homicide = { time: 3000, money: 45e3, karma: 3, kills: 1,
                     strength_exp: 2, defense_exp: 2, dexterity_exp: 2, agility_exp: 2 };
  const mug      = { time: 4000, money: 36e3, karma: 0.25, kills: 0,
                     strength_exp: 3, defense_exp: 3, dexterity_exp: 3, agility_exp: 3 };
  const karmaOnly = { money: 0, karma: 1, combat: 0, kills: 0 };

  const early = pickCrime([
    { name: "Homicide", stats: homicide, chance: 0.01 },
    { name: "Mug",      stats: mug,      chance: 0.50 },
  ], karmaOnly);
  assert.equal(early.name, "Mug", "at 1% success Homicide's karma is worthless");

  // once combat is up, Homicide's chance rises and it takes over -- no ladder logic needed
  const late = pickCrime([
    { name: "Homicide", stats: homicide, chance: 0.90 },
    { name: "Mug",      stats: mug,      chance: 1.00 },
  ], karmaOnly);
  assert.equal(late.name, "Homicide");
});

test("scoreCrime follows the weights, not a fixed money objective", () => {
  const rich  = { time: 1000, money: 10e6, karma: 0,  kills: 0,
                  strength_exp: 0, defense_exp: 0, dexterity_exp: 0, agility_exp: 0 };
  const nasty = { time: 1000, money: 0,    karma: 5,  kills: 0,
                  strength_exp: 20, defense_exp: 20, dexterity_exp: 20, agility_exp: 20 };
  const cands = [{ name: "rich", stats: rich, chance: 1 }, { name: "nasty", stats: nasty, chance: 1 }];

  assert.equal(pickCrime(cands, { money: 1 }).name, "rich");
  assert.equal(pickCrime(cands, { karma: 1 }).name, "nasty");
  assert.equal(pickCrime(cands, { combat: 1 }).name, "nasty");
  // all-zero weights -> no pick, rather than an arbitrary one
  assert.equal(pickCrime(cands, { money: 0, karma: 0, combat: 0, kills: 0 }), null);
  assert.equal(pickCrime([], { money: 1 }), null);
});

test("scoreCrime survives malformed stats rather than throwing", () => {
  assert.equal(scoreCrime(null, 1, { money: 1 }), 0);
  assert.equal(scoreCrime({ time: 0 }, 1, { money: 1 }), 0);
  assert.equal(scoreCrime({ time: 1000, money: 1e6 }, NaN, { money: 1 }), 0);
  assert.equal(scoreCrime({ time: 1000, money: 1e6 }, 5, { money: 1 }), 1);   // chance clamps to 1
});

test("BN2 end-to-end: a fresh player is 1 backdoor from a gang, not 54,000 karma", () => {
  const p = fresh();
  const routes = rankGangRoutes(p, FACTIONS);
  const best = routes[0];
  assert.equal(best.faction, "NiteSec");
  assert.deepEqual(best.gap, { backdoor: "avmnite-02h" });

  // the access gate contributes nothing in BN2, so no karma weight at all
  const shortfall = Math.max(0, p.karma - accessKarmaRequirement(2));
  assert.equal(shortfall, 0);
  assert.deepEqual(bootstrapWeights(best.gap, shortfall),
                   { money: 0, karma: 0, combat: 0, kills: 0 });

  // outside BN2 the same player faces the full -54,000 grind on top of the invite
  assert.equal(Math.max(0, p.karma - accessKarmaRequirement(1)), 54000);
});
