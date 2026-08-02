/** lib/caps.js -- capability gating. One ns.getResetInfo() call -> which subsystems are usable in
 *  this BitNode. A feature is available if you're currently IN one of its BitNodes, OR you own a
 *  level of its Source-File (which grants the API elsewhere). This replaces the ad-hoc currentNode
 *  checks scattered in boot.js/sing.js and lets every late-game module self-gate identically.
 *
 *  Pure helpers (capabilitiesFrom / hasApi / sfLevel) take a plain resetInfo object and are
 *  unit-tested in Node; getCapabilities(ns)/hackIncomeDead(ns) are the thin in-game wrappers. */

/** Level of a given Source-File from a ResetInfo, robust to ownedSF being a Map, an array of
 *  [n,level] pairs, or a plain object (shape has varied across game builds). 0 if absent. */
export function sfLevel(resetInfo, n) {
  const s = resetInfo && resetInfo.ownedSF;
  if (!s) return 0;
  if (typeof s.get === "function") return s.get(n) || 0;        // Map
  if (Array.isArray(s)) {                                        // [[n,lvl],...]
    for (const e of s) if (Array.isArray(e) && e[0] === n) return e[1] || 0;
    return 0;
  }
  if (typeof s === "object") return s[n] || 0;                   // { n: lvl }
  return 0;
}

/** True if an API is reachable: current node is in `nodes`, or any Source-File in `sf` is owned. */
export function hasApi(resetInfo, { nodes = [], sf = [] }) {
  if (nodes.includes(resetInfo.currentNode)) return true;
  return sf.some((n) => sfLevel(resetInfo, n) > 0);
}

/** Full capability map derived from a resetInfo (pure). Go/IPvGO is always available. */
export function capabilitiesFrom(resetInfo) {
  return {
    node: resetInfo.currentNode,
    singularity: hasApi(resetInfo, { nodes: [4], sf: [4] }),
    gang:        hasApi(resetInfo, { nodes: [2], sf: [2] }),
    corporation: hasApi(resetInfo, { nodes: [3], sf: [3] }),
    bladeburner: hasApi(resetInfo, { nodes: [6, 7], sf: [6, 7] }),
    sleeves:     hasApi(resetInfo, { nodes: [10], sf: [10] }),
    stanek:      hasApi(resetInfo, { nodes: [13], sf: [13] }),
    go: true,
  };
}

/** In-game wrapper. */
export function getCapabilities(ns) {
  return capabilitiesFrom(ns.getResetInfo());
}

/** True where scripted hacking earns ~nothing (BN8 stocks-only, BN9 hacknet), so the farm is dead
 *  weight. Moved out of boot.js so any script can share the one heuristic. getBitNodeMultipliers
 *  needs SF5 -> try/catch defaults to "alive" if unavailable. */
export function hackIncomeDead(ns) {
  try {
    if (ns.getResetInfo().currentNode === 8) return true;
    const m = ns.getBitNodeMultipliers();
    if (m) {
      const gain = typeof m.ScriptHackMoneyGain === "number" ? m.ScriptHackMoneyGain : 1;
      const maxMoney = typeof m.ServerMaxMoney === "number" ? m.ServerMaxMoney : 1;
      if (gain * maxMoney < 0.05) return true;
    }
  } catch (e) { /* SF5 absent */ }
  return false;
}
