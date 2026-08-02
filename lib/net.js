/** lib/net.js -- shared network helpers. Replaces the bfs()/root-opener blocks copy-pasted across
 *  coordinator.js, boot.js, sing.js, xpfarm.js, backdoors.js. The functions take `ns` so callers
 *  pay the same RAM they already pay for ns.scan/ns.nuke; bfs() is pure over an injected {scan}
 *  and is unit-tested in Node. Migrate existing scripts to import from here to kill the duplication. */

/** Breadth-first walk of the network from home. Returns every reachable host, home included.
 *  Identical semantics to the inline bfs() the suite already uses. */
export function bfs(ns) {
  const seen = new Set(["home"]), q = ["home"], out = ["home"];
  while (q.length) {
    const c = q.shift();
    for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); out.push(n); }
  }
  return out;
}

/** Port-opener programs in the order they unlock, paired with their ns method name. */
export const PORT_OPENERS = [
  ["BruteSSH.exe", "brutessh"],
  ["FTPCrack.exe", "ftpcrack"],
  ["relaySMTP.exe", "relaysmtp"],
  ["HTTPWorm.exe", "httpworm"],
  ["SQLInject.exe", "sqlinject"],
];

/** How many port-opener programs are owned on home (0..5). */
export function ownedOpeners(ns) {
  let n = 0;
  for (const [file] of PORT_OPENERS) if (ns.fileExists(file, "home")) n++;
  return n;
}

/** Open every port we can, then nuke if we have enough. Returns true if we end up with root. */
export function rootHost(ns, host) {
  if (ns.hasRootAccess(host)) return true;
  let opened = 0;
  for (const [file, method] of PORT_OPENERS) {
    if (ns.fileExists(file, "home")) { try { ns[method](host); opened++; } catch (e) { /* already open */ } }
  }
  if (opened >= ns.getServerNumPortsRequired(host)) { try { ns.nuke(host); } catch (e) { /* not enough */ } }
  return ns.hasRootAccess(host);
}

/** Root everything reachable; returns the count now rooted. */
export function rootAll(ns) {
  let n = 0;
  for (const h of bfs(ns)) if (rootHost(ns, h)) n++;
  return n;
}

/** Rooted hosts only (home included). */
export function rootedHosts(ns) {
  return bfs(ns).filter((h) => ns.hasRootAccess(h));
}

/** Free RAM (GB) on a host right now. */
export function freeRam(ns, host) {
  return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}
