import test from "node:test";
import assert from "node:assert/strict";
import {
  expPerThreadOp, hackXpRate, growXpRate, effectiveHackXpRate, xpPerGbSec,
  rankTargets, maxThreadNeeded, hackSecPerSec, growSecPerSec, weakenThreadsFor,
  growInstancesFor, moneyUpFraction, planHost, staggerMs, planXpPerSec,
  GROW_TIME_MULT, WEAKEN_TIME_MULT, FORTIFY_AMOUNT, WEAKEN_AMOUNT,
} from "../lib/xp-alloc.js";

test("expPerThreadOp matches calculateHackingExpGain's 3 + 0.3*baseDifficulty", () => {
  assert.equal(expPerThreadOp(1), 3.3);
  assert.equal(expPerThreadOp(10), 6);
  assert.equal(expPerThreadOp(99), 32.7);
  // guard: falsy/zero baseDifficulty returns 0, mirroring the source's early return
  assert.equal(expPerThreadOp(0), 0);
  assert.equal(expPerThreadOp(undefined), 0);
});

test("hack : grow : weaken XP rate is 16 : 5 : 4", () => {
  const h = hackXpRate(10, 1000);
  const g = growXpRate(10, 1000);
  const w = hackXpRate(10, 1000) / WEAKEN_TIME_MULT;
  assert.equal(GROW_TIME_MULT, 3.2);
  assert.equal(WEAKEN_TIME_MULT, 4);
  assert.ok(Math.abs(h / g - 3.2) < 1e-9);
  assert.ok(Math.abs(h / w - 4) < 1e-9);
  // 6 xp per op over a 1s hack -> 6 xp/thread-s
  assert.equal(h, 6);
});

test("effectiveHackXpRate applies the 25% failure floor, not zero", () => {
  const full = effectiveHackXpRate(10, 1000, 1, 1);
  const dead = effectiveHackXpRate(10, 1000, 1, 0);   // every op lands on a $0 balance
  assert.equal(full, 6);
  assert.equal(dead, 1.5);                            // 25% tier, still non-zero
  // a half-armed target sits between the two
  const half = effectiveHackXpRate(10, 1000, 1, 0.5);
  assert.ok(half > dead && half < full);
  // out-of-range inputs clamp rather than throw
  assert.equal(effectiveHackXpRate(10, 1000, 5, 5), 6);
  assert.equal(effectiveHackXpRate(10, 1000, -1, 1), 1.5);
});

test("armed hack is ~3.29x grow per GB; a starved fleet is only ~18% worse", () => {
  const grow = xpPerGbSec(growXpRate(10, 1000), 1.75);

  // fully armed (grow support keeps a non-zero balance): the point of the rewrite.
  // ratio = 3.2 (op-time) * 1.75/1.70 (RAM) = 3.294
  const armedHack = xpPerGbSec(effectiveHackXpRate(10, 1000, 1, 1), 1.70);
  assert.ok(Math.abs(armedHack / grow - 3.2 * (1.75 / 1.70)) < 1e-9);

  // worst case: every op lands on a $0 balance -> 25% tier. Hack RAM is cheaper, so the
  // downside is bounded at ~18%, not catastrophic -- but it is a real loss, which is why
  // the grow support workers exist rather than running a pure hack fleet.
  const starvedHack = xpPerGbSec(effectiveHackXpRate(10, 1000, 1, 0), 1.70);
  assert.ok(starvedHack < grow);
  assert.ok(starvedHack / grow > 0.8);
});

test("rankTargets ranks on BASE difficulty over hackTime, not min security", () => {
  // the bug in the old xpfarm: it scored (3 + 0.3*minSecurity)/growTime.
  // A weakened high-end server has minSecurity << baseDifficulty, so it was under-ranked.
  const cands = [
    { host: "n00dles", baseDifficulty: 1, hackTimeMs: 500, chance: 1 },
    { host: "omnitek", baseDifficulty: 99, hackTimeMs: 40000, chance: 1 },
    { host: "joesguns", baseDifficulty: 10, hackTimeMs: 1200, chance: 1 },
  ];
  const ranked = rankTargets(cands);
  assert.equal(ranked[0].host, "n00dles");        // 3.3/0.5  = 6.6
  assert.equal(ranked[1].host, "joesguns");       // 6.0/1.2  = 5.0
  assert.equal(ranked[2].host, "omnitek");        // 32.7/40  = 0.82
  assert.ok(ranked[0].rate > ranked[1].rate);
  // zero-difficulty candidates are dropped rather than ranked last
  assert.equal(rankTargets([{ host: "x", baseDifficulty: 0, hackTimeMs: 100 }]).length, 0);
});

test("maxThreadNeeded inverts percentHacked and survives a zero percent", () => {
  assert.equal(maxThreadNeeded(0.01), 100);
  assert.equal(maxThreadNeeded(0.00165), 607);
  assert.equal(maxThreadNeeded(1), 1);
  // percentHacked 0 (hackDifficulty >= 100) -> the source's 1e6 sentinel
  assert.equal(maxThreadNeeded(0), 1e6);
  assert.equal(maxThreadNeeded(NaN), 1e6);
});

test("hack security cost is capped at maxThreadNeeded -- over-threading is free", () => {
  const mtn = 600;
  const hackTime = 1000;
  const small = hackSecPerSec(1, 600, mtn, hackTime);
  const huge = hackSecPerSec(1, 200000, mtn, hackTime);
  assert.equal(small, huge);                              // the cap bites
  assert.equal(huge, FORTIFY_AMOUNT * 600);               // 1.2 sec/s from one instance
  // cost scales with INSTANCES, not threads
  assert.equal(hackSecPerSec(4, 200000, mtn, hackTime), 4 * huge);
  assert.equal(hackSecPerSec(0, 1000, mtn, hackTime), 0);
});

test("weakenThreadsFor offsets a given security gain rate", () => {
  const hackTime = 1000;                                  // weakenTime = 4000ms
  // one weaken thread removes 0.05 per 4s = 0.0125/s
  assert.equal(weakenThreadsFor(0.0125, hackTime), 1);
  assert.equal(weakenThreadsFor(1.2, hackTime), 96);
  assert.equal(weakenThreadsFor(0, hackTime), 0);
  // round trip: the threads we ask for really do cover the drift
  const gain = hackSecPerSec(1, 200000, 600, hackTime) + growSecPerSec(4, 40, hackTime);
  const need = weakenThreadsFor(gain, hackTime);
  const removed = (need * WEAKEN_AMOUNT) / (hackTime * WEAKEN_TIME_MULT / 1000);
  assert.ok(removed >= gain);
});

test("growInstancesFor / moneyUpFraction encode the 3.2:1 parity rule", () => {
  // a grow instance completes once per 3.2 hackTimes; a hack instance fires once per hackTime
  assert.equal(growInstancesFor(1), 4);        // ceil(3.2)
  assert.equal(growInstancesFor(10), 32);
  assert.equal(growInstancesFor(0), 0);
  assert.equal(moneyUpFraction(1, 4), 1);      // 4/3.2 = 1.25 -> clamped to 1
  assert.equal(moneyUpFraction(1, 0), 0);      // no grow support -> always starved
  assert.ok(Math.abs(moneyUpFraction(10, 16) - 0.5) < 1e-9);
  assert.equal(moneyUpFraction(0, 0), 1);      // no hack workers -> vacuously armed
});

test("planHost fills weaken, then grow, then hack, and never overcommits RAM", () => {
  const ram = { hack: 1.70, grow: 1.75, weaken: 1.80 };
  const plan = planHost(1000, ram, { weaken: 50, growInstances: 4, growThreadsPerInstance: 40 });
  assert.equal(plan.weaken, 50);
  assert.deepEqual(plan.grow, [40, 40, 40, 40]);
  const used = plan.weaken * ram.weaken + plan.grow.reduce((a, b) => a + b, 0) * ram.grow +
               plan.hack * ram.hack;
  assert.ok(used <= 1000, `used ${used} > 1000`);
  assert.ok(plan.hack > 0);
});

test("planHost degrades gracefully on tiny hosts", () => {
  const ram = { hack: 1.70, grow: 1.75, weaken: 1.80 };
  // 8GB host: weaken request eats most of it, grow gets what is left, hack gets nothing
  const tiny = planHost(8, ram, { weaken: 2, growInstances: 4, growThreadsPerInstance: 40 });
  const used = tiny.weaken * ram.weaken + tiny.grow.reduce((a, b) => a + b, 0) * ram.grow +
               tiny.hack * ram.hack;
  assert.ok(used <= 8, `used ${used} > 8`);
  // 0GB and negative hosts return an empty plan rather than throwing
  assert.deepEqual(planHost(0, ram, { weaken: 5, growInstances: 4, growThreadsPerInstance: 40 }),
                   { weaken: 0, grow: [], hack: 0 });
  assert.deepEqual(planHost(-100, ram, { weaken: 5, growInstances: 1, growThreadsPerInstance: 1 }),
                   { weaken: 0, grow: [], hack: 0 });
});

test("staggerMs spreads instances evenly across the window", () => {
  assert.equal(staggerMs(0, 4, 3200), 0);
  assert.equal(staggerMs(1, 4, 3200), 800);
  assert.equal(staggerMs(3, 4, 3200), 2400);
  assert.equal(staggerMs(4, 4, 3200), 0);      // wraps
  assert.equal(staggerMs(0, 1, 3200), 0);      // single instance -> no offset
});

test("planXpPerSec weights the three roles by their op times", () => {
  const hackTime = 1000;
  const onlyHack = planXpPerSec({ hack: 1000, grow: [], weaken: 0 }, 6, hackTime, 1, 1);
  const onlyGrow = planXpPerSec({ hack: 0, grow: [1000], weaken: 0 }, 6, hackTime, 1, 1);
  const onlyWeak = planXpPerSec({ hack: 0, grow: [], weaken: 1000 }, 6, hackTime, 1, 1);
  assert.equal(onlyHack, 6000);
  assert.ok(Math.abs(onlyHack / onlyGrow - 3.2) < 1e-9);
  assert.ok(Math.abs(onlyHack / onlyWeak - 4) < 1e-9);
  // a starved hack fleet collapses to the 25% tier but is still counted
  const starved = planXpPerSec({ hack: 1000, grow: [], weaken: 0 }, 6, hackTime, 1, 0);
  assert.equal(starved, 1500);
});

test("realistic BN9 plan: an all-hack fleet with support beats the old grow-only farm", () => {
  const hackTime = 800;
  const perThreadOpXp = 6;                       // (3 + 0.3*10) * mults, mults folded in
  const ram = { hack: 1.70, grow: 1.75, weaken: 1.80 };
  const totalGb = 526000;                        // ~526 TB of home RAM

  // old farm: everything on a grow/weaken worker at 2.10 GB/thread
  const oldThreads = Math.floor(totalGb / 2.10);
  const oldXp = (oldThreads * perThreadOpXp) / (hackTime / 1000 * GROW_TIME_MULT);

  // new farm: weaken + staggered grow support, rest hack
  const plan = planHost(totalGb, ram, { weaken: 500, growInstances: 8, growThreadsPerInstance: 40 });
  const mUp = moneyUpFraction(1, 8);
  const newXp = planXpPerSec(plan, perThreadOpXp, hackTime, 0.99, mUp);

  assert.ok(newXp / oldXp > 3.0, `expected >3x, got ${(newXp / oldXp).toFixed(2)}x`);
  assert.ok(newXp / oldXp < 4.0, `implausibly high: ${(newXp / oldXp).toFixed(2)}x`);
});

test("rankTargets honours an op-time floor: below it, only baseDifficulty still pays", () => {
  // ns.hack resolves via window.setTimeout, so nominal times under the practical scheduling
  // floor do not convert into more ops/sec. XP per op is (3 + 0.3*baseDifficulty) and is
  // independent of op time -- so under the floor the higher-difficulty server must win.
  const FLOOR = 150;
  const cands = [
    { host: "foodnstuff", baseDifficulty: 10, hackTimeMs: 70,  chance: 1 },
    { host: "midrange",   baseDifficulty: 30, hackTimeMs: 140, chance: 1 },
  ].map((c) => ({ ...c, rankTimeMs: Math.max(c.hackTimeMs, FLOOR) }));

  // unfloored, the fast low-difficulty server wins: 6.0/0.07 = 85.7 vs 12.0/0.14 = 85.7 -- a tie
  // that tips to whichever is marginally faster, which is exactly the trap.
  const naive = rankTargets(cands.map(({ rankTimeMs, ...c }) => c));
  assert.equal(naive[0].host, "foodnstuff");

  // floored, both are capped at the same real cadence, so 2x the XP per op wins outright
  const floored = rankTargets(cands);
  assert.equal(floored[0].host, "midrange");
  assert.ok(floored[0].rate / floored[1].rate > 1.9);
});

test("the op-time floor never penalises a target already slower than the floor", () => {
  const cands = [
    { host: "slow", baseDifficulty: 99, hackTimeMs: 40000, chance: 1, rankTimeMs: 40000 },
    { host: "fast", baseDifficulty: 10, hackTimeMs: 70, chance: 1, rankTimeMs: 150 },
  ];
  const r = rankTargets(cands);
  assert.equal(r[0].host, "fast");   // 6.0/0.15 = 40 vs 32.7/40 = 0.82
});

test("planHost caps support as a FRACTION of the host, so hack is never starved to zero", () => {
  const ram = { hack: 1.70, grow: 1.75, weaken: 1.80 };

  // A 27GB network server -- roughly what BN2 hands you -- is ~15 hack threads. The old absolute
  // sizing (4 grow instances x 40 threads = 280GB) swallowed the whole host and hack got nothing.
  const small = 27;
  const hostThreads = Math.floor(small / ram.hack);
  const capped = planHost(small, ram, {
    weaken: 100, growInstances: 4, growThreadsPerInstance: 40,
    supportCapThreads: Math.ceil(hostThreads * 0.25),
  });
  const support = capped.weaken + capped.grow.reduce((a, b) => a + b, 0);
  assert.ok(support <= Math.ceil(hostThreads * 0.25), `support ${support} exceeded the cap`);
  assert.ok(capped.hack > 0, "hack must still be placed on a small host");

  // uncapped, the same request starves hack completely -- this is the bug, pinned
  const starved = planHost(small, ram, { weaken: 100, growInstances: 4, growThreadsPerInstance: 40 });
  assert.equal(starved.hack, 0);

  // and the cap never overcommits
  const used = capped.weaken * ram.weaken + capped.grow.reduce((a, b) => a + b, 0) * ram.grow +
               capped.hack * ram.hack;
  assert.ok(used <= small, `used ${used} > ${small}`);
});

test("the support cap is a no-op on a host large enough not to need it", () => {
  const ram = { hack: 1.70, grow: 1.75, weaken: 1.80 };
  const big = 524288;
  const hostThreads = Math.floor(big / ram.hack);
  const a = planHost(big, ram, { weaken: 9000, growInstances: 4, growThreadsPerInstance: 40 });
  const b = planHost(big, ram, {
    weaken: 9000, growInstances: 4, growThreadsPerInstance: 40,
    supportCapThreads: Math.ceil(hostThreads * 0.25),
  });
  assert.deepEqual(a, b, "a huge host should plan identically with or without the cap");
});
