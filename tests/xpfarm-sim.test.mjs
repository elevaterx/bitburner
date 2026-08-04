/** Mock-`ns` simulation of the xpfarm controller.
 *
 *  WHY THIS EXISTS: xpfarm.js is an `ns` shell, so the unit tests in xp-alloc.test.mjs can't reach
 *  its placement loop. This drives the real main() against a fake network and asserts the things
 *  that have actually broken in this suite before:
 *    - calling an API that was REMOVED in Bitburner 3.0.0 (ns.formatNumber, ns.tail, ns.purchaseServer,
 *      ns.nFormat, ...). The mock is a Proxy that throws on any removed name and on any property the
 *      real NS does not have, so a removed-API call fails here instead of in-game.
 *    - execing more threads than a host has free RAM.
 *    - eating the home RAM reserve.
 *
 *  It does NOT prove in-game behaviour (tail rendering, real exec semantics, actual XP rates).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../xpfarm.js";

/** Removed in 3.0.0 (src/NetscriptFunctions.ts setRemovedFunctions). Touching one is a bug. */
const REMOVED = new Set([
  "getServerRam", "nFormat", "getTimeSinceLastAug", "formatNumber", "formatRam", "formatPercent",
  "tFormat", "tail", "moveTail", "resizeTail", "closeTail", "setTitle",
  "getPurchasedServerCost", "purchaseServer", "getPurchasedServerUpgradeCost",
  "upgradePurchasedServer", "renamePurchasedServer", "deleteServer", "getPurchasedServers",
  "getPurchasedServerLimit", "getPurchasedServerMaxRam",
]);

function buildNs(net, opts = {}) {
  const state = {
    loops: 0, procs: [], nextPid: 1, printed: [], used: {}, overcommit: null, removedHit: null,
  };
  for (const h of Object.keys(net)) state.used[h] = 0;
  state.used.home = opts.homePreUsed ?? 200;

  const impl = {
    args: opts.args ?? [],
    disableLog() {}, clearLog() { state.printed = []; },
    ui: { openTail() {}, resizeTail() {} },
    print(s) { state.printed.push(s); }, tprint(s) { state.printed.push("TPRINT " + s); },
    getScriptName: () => "xpfarm.js",
    getScriptRam: (f) => ({ "xph.js": 1.70, "xpg.js": 1.75, "xpw.js": 1.80 }[f] ?? 0),
    scan: (h) => (net[h] ? (h === "home" ? net.home.links : ["home"]) : []),
    hasRootAccess: () => true,
    fileExists: () => true,
    getServerNumPortsRequired: () => 0,
    nuke() {}, brutessh() {}, ftpcrack() {}, relaysmtp() {}, httpworm() {}, sqlinject() {},
    getServerMaxRam: (h) => net[h]?.ram ?? 0,
    getServerUsedRam: (h) => state.used[h] ?? 0,
    getServerMaxMoney: (h) => net[h]?.money ?? 0,
    getServerMoneyAvailable: (h) => (net[h]?.money ?? 0) * 0.5,
    // force the security-drift branch after a couple of loops
    getServerSecurityLevel: (h) => (net[h]?.min ?? 1) + (state.loops > 2 ? 5 : 0),
    getServerMinSecurityLevel: (h) => net[h]?.min ?? 1,
    getServerBaseSecurityLevel: (h) => net[h]?.base ?? 1,
    getServerRequiredHackingLevel: (h) => net[h]?.req ?? 1,
    getHackTime: (h) => 500 * (net[h]?.req ?? 1) * (net[h]?.min ?? 1),
    hackAnalyzeChance: () => 0.99,
    hackAnalyze: () => 0.00165,
    getHackingLevel: () => 4950,
    getPlayer: () => ({ exp: { hacking: 9.9e10 + state.loops * 7.6e6 } }),
    ps: (h) => state.procs.filter((p) => p.host === h),
    kill(pid) {
      const i = state.procs.findIndex((p) => p.pid === pid);
      if (i >= 0) { state.used[state.procs[i].host] -= state.procs[i].ram; state.procs.splice(i, 1); }
    },
    scp: () => true,
    exec(file, host, threads, ...a) {
      const r = impl.getScriptRam(file) * threads;
      const free = net[host].ram - state.used[host];
      if (r > free + 1e-9) {
        state.overcommit = `${file} on ${host}: ${threads}t = ${r}GB but only ${free}GB free`;
        return 0;
      }
      state.used[host] += r;
      state.procs.push({ pid: state.nextPid++, filename: file, host, threads, args: a, ram: r });
      return state.procs.at(-1).pid;
    },
    write() {},
    async sleep() { state.loops++; if (state.loops > (opts.loops ?? 5)) throw new Error("__DONE__"); },
  };

  // Throw on removed APIs and on anything the mock doesn't model, rather than returning undefined.
  const ns = new Proxy(impl, {
    get(t, k) {
      if (typeof k === "string" && REMOVED.has(k)) {
        state.removedHit = k;
        throw new Error(`REMOVED FUNCTION: ns.${k} was removed in Bitburner 3.0.0`);
      }
      if (!(k in t) && typeof k === "string" && k !== "then") {
        throw new Error(`mock ns has no property "${k}" -- either a typo or an unmodelled API`);
      }
      return t[k];
    },
  });
  return { ns, state };
}

const NET = {
  home: { ram: 524288, links: ["n00dles", "foodnstuff", "sigma-cosmetics", "omnitek", "hacknet-server-0"] },
  "n00dles": { ram: 4, money: 1750, base: 1, min: 1, req: 1 },
  "foodnstuff": { ram: 16, money: 20000, base: 10, min: 3, req: 1 },
  "sigma-cosmetics": { ram: 16, money: 23000, base: 10, min: 3, req: 5 },
  "omnitek": { ram: 512, money: 5e7, base: 99, min: 33, req: 950 },
  "hacknet-server-0": { ram: 1024, money: 0, base: 1, min: 1, req: 1 },
};

async function run(opts) {
  const { ns, state } = buildNs(NET, opts);
  try { await main(ns); } catch (e) { if (e.message !== "__DONE__") throw e; }
  return state;
}

test("controller runs without touching any API removed in 3.0.0", async () => {
  const s = await run({});
  assert.equal(s.removedHit, null);
});

test("controller never overcommits a host's RAM", async () => {
  const s = await run({});
  assert.equal(s.overcommit, null, s.overcommit ?? "");
});

test("controller respects the home RAM reserve", async () => {
  const s = await run({});
  const free = NET.home.ram - s.used.home;
  assert.ok(free >= 64 - 1e-6, `home free ${free}GB < 64GB reserve`);
});

test("hack workers get the bulk of the fleet, with grow and weaken support present", async () => {
  const s = await run({});
  const by = (f) => s.procs.filter((p) => p.filename === f).reduce((a, p) => a + p.threads, 0);
  const hack = by("xph.js"), grow = by("xpg.js"), weaken = by("xpw.js");
  assert.ok(hack > 0 && grow > 0 && weaken > 0, `hack ${hack} grow ${grow} weaken ${weaken}`);
  assert.ok(hack / (hack + grow + weaken) > 0.95, "hack should dominate the thread budget");
  // grow instance count is what re-arms the balance -- threads barely matter
  assert.ok(s.procs.filter((p) => p.filename === "xpg.js").length >= 4);
});

test("--no-hack baseline places no hack workers", async () => {
  const s = await run({ args: ["--no-hack"] });
  assert.equal(s.procs.filter((p) => p.filename === "xph.js").length, 0);
  assert.ok(s.procs.filter((p) => p.filename === "xpg.js").length > 0);
  assert.equal(s.overcommit, null, s.overcommit ?? "");
});

test("hacknet servers are never used as workers or targets", async () => {
  const s = await run({});
  assert.equal(s.procs.filter((p) => p.host.startsWith("hacknet-")).length, 0);
  assert.equal(s.procs.filter((p) => p.args[0]?.startsWith("hacknet-")).length, 0);
});

test("every placement carries a serial so a later top-up is not a duplicate no-op", async () => {
  const s = await run({});
  const keys = s.procs.map((p) => `${p.filename}|${p.host}|${p.args.join(",")}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate (file, host, args) placement");
});
