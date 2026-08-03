/** lib/xp-alloc.js -- pure planning logic for the hacking-XP farm.
 *
 *  All numbers here are verified against Bitburner v3.0.2 source:
 *    - src/Hacking.ts:30-38   calculateHackingExpGain = (3 + baseDifficulty*0.3) * mults.hacking_exp * BN.HackExpGain
 *                             -> XP per thread per op is IDENTICAL for hack/grow/weaken, and depends on the server's
 *                                BASE difficulty, not its current (weakened) security.
 *    - src/Hacking.ts:83-93   growTime = 3.2 * hackTime, weakenTime = 4 * hackTime
 *                             -> hack : grow : weaken XP/sec = 16 : 5 : 4
 *    - NetscriptHelpers.tsx:618        expGainedOnSuccess = calculateHackingExpGain(...) * threads  (NOT capped)
 *    - NetscriptHelpers.tsx:639-641    if (moneyDrained === 0) exp is downgraded to the 25% failure tier
 *    - NetscriptHelpers.tsx:667        server.fortify(0.002 * Math.min(threads, maxThreadNeeded))
 *                             -> security cost of a hack IS capped at the useful thread count, so an
 *                                over-threaded hack is nearly free in security terms while every thread
 *                                still collects full XP. This is what makes the whole scheme work.
 *    - Server/formulas/grow.ts:46      moneyAvailable += threads  before the multiplicative growth
 *                             -> grow() restores a non-zero balance even from exactly $0.
 *
 *  Pure functions only -- no `ns`. Unit-tested in tests/xp-alloc.test.mjs.
 */

/** Op durations relative to hackTime (Hacking.ts:84,91). */
export const GROW_TIME_MULT = 3.2;
export const WEAKEN_TIME_MULT = 4;

/** Server security constants (Server/data/Constants.ts:9-10). */
export const FORTIFY_AMOUNT = 0.002;   // per hack thread (grow is 2x this per used cycle)
export const WEAKEN_AMOUNT = 0.05;     // per weaken thread

/** XP granted per thread per op on a server. Identical for hack, grow and weaken.
 *  The mults (hacking_exp, BitNode HackExpGain) are common to every target, so they are
 *  omitted here -- this is used for RANKING, where common factors cancel. */
export function expPerThreadOp(baseDifficulty) {
  if (!(baseDifficulty > 0)) return 0;
  return 3 + 0.3 * baseDifficulty;
}

/** XP per thread-second from a hack worker, before the success-chance haircut. */
export function hackXpRate(baseDifficulty, hackTimeMs) {
  if (!(hackTimeMs > 0)) return 0;
  return expPerThreadOp(baseDifficulty) / (hackTimeMs / 1000);
}

/** XP per thread-second from a grow worker (3.2x slower than hack, always full XP). */
export function growXpRate(baseDifficulty, hackTimeMs) {
  return hackXpRate(baseDifficulty, hackTimeMs) / GROW_TIME_MULT;
}

/** Expected XP per thread-second from a hack worker.
 *  chance  = ns.hackAnalyzeChance(host)
 *  moneyUp = fraction of ops expected to land while the balance is non-zero (0..1).
 *  On a miss (failed roll OR zero balance) the op pays the 25% failure tier. */
export function effectiveHackXpRate(baseDifficulty, hackTimeMs, chance, moneyUp = 1) {
  const c = clamp01(chance);
  const m = clamp01(moneyUp);
  const good = c * m;                       // full XP
  return hackXpRate(baseDifficulty, hackTimeMs) * (good + 0.25 * (1 - good));
}

/** XP per GB-second -- the number that actually matters, since RAM is the constraint.
 *  ramPerThread differs by role because the workers reference different ns functions. */
export function xpPerGbSec(xpRate, ramPerThread) {
  if (!(ramPerThread > 0)) return 0;
  return xpRate / ramPerThread;
}

/** Rank candidate targets best-first.
 *  cands: [{ host, baseDifficulty, hackTimeMs, chance }]
 *  Ranking uses the HACK rate because that is the role the bulk of the fleet will run.
 *  NOTE: the old xpfarm ranked on getServerMinSecurityLevel, but the XP formula reads
 *  baseDifficulty -- for a weakened high-end server those differ by ~3x. */
export function rankTargets(cands, moneyUp = 1) {
  return cands
    .map((c) => ({
      ...c,
      rate: effectiveHackXpRate(c.baseDifficulty, c.hackTimeMs, c.chance ?? 1, moneyUp),
    }))
    .filter((c) => c.rate > 0)
    .sort((a, b) => b.rate - a.rate);
}

/** Threads at which ONE hack op drains 100% of the balance and leaves it at exactly $0
 *  (NetscriptHelpers.tsx:623 maxThreadNeeded = ceil(1/percentHacked)).
 *  Also the cap on a hack's security cost -- threads beyond this are free. */
export function maxThreadNeeded(percentHackedPerThread) {
  if (!(percentHackedPerThread > 0)) return 1e6;
  return Math.ceil(1 / percentHackedPerThread);
}

/** Security added per second on a target by its hack workers.
 *  Each INSTANCE contributes one op per hackTime, and each op's fortify is capped
 *  at maxThreadNeeded -- so cost scales with the number of instances, not threads. */
export function hackSecPerSec(instances, threadsPerInstance, maxThreads, hackTimeMs) {
  if (!(hackTimeMs > 0) || instances <= 0) return 0;
  const perOp = FORTIFY_AMOUNT * Math.min(threadsPerInstance, maxThreads);
  return (instances * perOp) / (hackTimeMs / 1000);
}

/** Security added per second by grow workers. Grow fortifies 2x per USED cycle
 *  (ServerHelpers.ts:213), capped at the instance's thread count. */
export function growSecPerSec(instances, threadsPerInstance, hackTimeMs) {
  if (!(hackTimeMs > 0) || instances <= 0) return 0;
  const perOp = 2 * FORTIFY_AMOUNT * threadsPerInstance;
  return (instances * perOp) / ((hackTimeMs * GROW_TIME_MULT) / 1000);
}

/** Weaken threads needed to hold security flat against a given security-gain rate. */
export function weakenThreadsFor(secPerSec, hackTimeMs, coreBonus = 1, weakenRate = 1) {
  if (!(secPerSec > 0) || !(hackTimeMs > 0)) return 0;
  const weakenTimeS = (hackTimeMs * WEAKEN_TIME_MULT) / 1000;
  const perThreadPerSec = (WEAKEN_AMOUNT * coreBonus * weakenRate) / weakenTimeS;
  if (!(perThreadPerSec > 0)) return 0;
  return Math.ceil(secPerSec / perThreadPerSec);
}

/** How many grow INSTANCES are needed so that a grow completes at least as often as a
 *  hack op lands -- i.e. so most hack ops find a non-zero balance.
 *  A grow instance completes once per 3.2*hackTime; a hack instance fires once per hackTime.
 *  So parity needs ~3.2 grow instances per hack instance. */
export function growInstancesFor(hackInstances, safety = 1.0) {
  if (hackInstances <= 0) return 0;
  return Math.ceil(hackInstances * GROW_TIME_MULT * safety);
}

/** Expected fraction of hack ops that land on a non-zero balance, given how often
 *  grows complete relative to hack ops. Each completed grow re-arms at most one hack. */
export function moneyUpFraction(hackInstances, growInstances) {
  if (hackInstances <= 0) return 1;
  if (growInstances <= 0) return 0;
  const growsPerHackOp = growInstances / GROW_TIME_MULT / hackInstances;
  return clamp01(growsPerHackOp);
}

/** Split one host's free thread budget into roles.
 *  free        : whole threads available on this host for the biggest worker
 *  ramPerThread: { hack, grow, weaken } GB per thread for each worker script
 *  want        : { weaken: threads, growInstances: n, growThreadsPerInstance: n }
 *  Returns { weaken, grow: [threads,...], hack } in THREADS, sized so the total fits.
 *  Weaken is placed first (it protects the target), then grow (it re-arms the money),
 *  then everything left goes to hack. */
export function planHost(freeGb, ramPerThread, want) {
  const out = { weaken: 0, grow: [], hack: 0 };
  let gb = Math.max(0, freeGb);

  const wt = Math.min(want.weaken || 0, Math.floor(gb / ramPerThread.weaken));
  if (wt > 0) { out.weaken = wt; gb -= wt * ramPerThread.weaken; }

  const gInst = Math.max(0, want.growInstances || 0);
  const gThreads = Math.max(1, want.growThreadsPerInstance || 1);
  for (let i = 0; i < gInst; i++) {
    const t = Math.min(gThreads, Math.floor(gb / ramPerThread.grow));
    if (t <= 0) break;
    out.grow.push(t);
    gb -= t * ramPerThread.grow;
  }

  out.hack = Math.max(0, Math.floor(gb / ramPerThread.hack));
  return out;
}

/** Stagger offset (ms) for instance i of n over a window, so ops de-phase instead of
 *  all landing together. */
export function staggerMs(i, n, windowMs) {
  if (n <= 1) return 0;
  return Math.round(((i % n) / n) * windowMs);
}

/** Total XP/sec for a plan, using the real per-thread XP (mults included).
 *  perThreadOpXp = (3 + 0.3*baseDifficulty) * mults.hacking_exp * BN.HackExpGain */
export function planXpPerSec(plan, perThreadOpXp, hackTimeMs, chance, moneyUp) {
  if (!(hackTimeMs > 0)) return 0;
  const tS = hackTimeMs / 1000;
  const good = clamp01(chance) * clamp01(moneyUp);
  const hackFactor = good + 0.25 * (1 - good);
  const growThreads = plan.grow.reduce((a, b) => a + b, 0);
  return (
    (plan.hack * perThreadOpXp * hackFactor) / tS +
    (growThreads * perThreadOpXp) / (tS * GROW_TIME_MULT) +
    (plan.weaken * perThreadOpXp) / (tS * WEAKEN_TIME_MULT)
  );
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
