/** lib/modules.js -- registry + status plumbing for the capability modules and the control panel.
 *
 *  KEY DESIGN (RAM): the panel must NEVER call the subsystem APIs (Corp info calls cost 10GB EACH,
 *  gang/bladeburner/sleeve 2-4GB) or it couldn't launch on a fresh-BitNode home (as low as 8GB).
 *  Instead each manager writes a tiny status line to status/<key>.txt (ns.write = 0GB), and the panel
 *  READS those files (ns.read = 0GB). So the panel stays ~base-Netscript cheap and runs on any home.
 *
 *  Pure helpers (relevantModules / formatStatus / parseStatus) are unit-tested; write/readStatus are
 *  the thin ns wrappers. */

export const STATUS_DIR = "status/";
export const ENABLED_FILE = STATUS_DIR + "panel-enabled.txt";

/** capKey maps to a lib/caps capability flag. "go" is always available. */
export const MODULES = [
  { key: "gang",        file: "gang.js",        cap: "gang",        label: "Gang" },
  { key: "sleeves",     file: "sleeves.js",     cap: "sleeves",     label: "Sleeves" },
  { key: "bladeburner", file: "bladeburner.js", cap: "bladeburner", label: "Bladeburner" },
  { key: "corp",        file: "corp.js",        cap: "corporation", label: "Corporation" },
  { key: "go",          file: "go.js",          cap: "go",          label: "IPvGO" },
];

export function statusPath(key) { return STATUS_DIR + key + ".txt"; }

/** Non-capability background daemons the panel surfaces as a read-only jobs table (with a Stop
 *  button), so their individual tail windows can be closed. Only the running ones are shown. */
export const WORKER_JOBS = [
  { file: "coordinator.js", label: "Coordinator" },
  { file: "trader.js",      label: "Trader" },
  { file: "sing.js",        label: "Singularity" },
  { file: "hacknet.js",     label: "Hacknet", key: "hacknet" },
  { file: "xpfarm.js",      label: "XP Farm" },
  { file: "sharecap.js",    label: "Share" },
  { file: "purchaser.js",   label: "Purchaser" },
];

/** Only the modules whose capability is present in this BitNode. Pure. */
export function relevantModules(caps, modules = MODULES) {
  return modules.filter((m) => !!caps[m.cap]);
}

/** On-the-fly mode controls, keyed by script file. Two mechanisms:
 *   - type "file":     a control file the daemon re-reads live (no restart). e.g. hacknet's hoard.txt.
 *                      options: [{ label, on }] -> on:true writes the file, on:false removes it.
 *   - type "relaunch": kill + re-run with a fixed arg set (some state loss). e.g. coordinator presets,
 *                      and this suite's --flags. options: [{ label, args:[...] }]; active = running args.
 *  Edit freely to add modes; anything not listed simply shows no mode chips. */
export const MODES = {
  "coordinator.js": { type: "relaunch", options: [
    { label: "income", args: ["income"] }, { label: "rebuild", args: ["rebuild"] },
    { label: "repgrind", args: ["repgrind"] }, { label: "digheavy", args: ["digheavy"] }, { label: "safe", args: ["safe"] },
  ] },
  "hacknet.js": { type: "write", file: "hacknet-ctl.txt", options: [
    { label: "Pause", content: "paused" }, { label: "Payback", content: "payback" },
    { label: "$100b", content: "budget:100e9" }, { label: "$500b", content: "budget:500e9" },
  ] },
  "sharecap.js": { type: "relaunch", options: [
    { label: "Off", args: ["0"] }, { label: "RepGrind", args: ["1000"] },
  ] },
  "gang.js": { type: "relaunch", options: [
    { label: "Warfare", args: [] }, { label: "No-war", args: ["--no-warfare"] },
  ] },
  "corp.js": { type: "relaunch", options: [
    { label: "Products", args: [] }, { label: "Agri-only", args: ["--no-products"] },
  ] },
  "sleeves.js": { type: "relaunch", options: [
    { label: "No-augs", args: [] }, { label: "Augs 1%", args: ["--aug-frac", "0.01"] },
  ] },
  "go.js": { type: "relaunch", options: [
    { label: "Cycle", args: [] },
    { label: "Netburners",  args: ["--opponent", "Netburners", "--no-cycle"] },
    { label: "Slum Snakes", args: ["--opponent", "Slum Snakes", "--no-cycle"] },
    { label: "Black Hand",  args: ["--opponent", "The Black Hand", "--no-cycle"] },
    { label: "Tetrads",     args: ["--opponent", "Tetrads", "--no-cycle"] },
    { label: "Daedalus",    args: ["--opponent", "Daedalus", "--no-cycle"] },
    { label: "Illuminati",  args: ["--opponent", "Illuminati", "--no-cycle"] },
    // The hidden opponent (GoOpponent.w0r1d_d43m0n == 12 '?'). Requires TheRedPill INSTALLED
    // (netscriptGoImplementation.ts:359). bonusPower 2.0 on mults.hacking -- the highest in the
    // game, and it multiplies raw hacking skill.
    // NO --size: getNewBoardState (boardState.ts:26-30) hard-forces boardSize = 19 and the fixed
    // bitverse board shape for this opponent. A --size arg is accepted without error and then
    // silently discarded, so passing one only makes the launch line lie about what is running.
    // Komi 9.5 -> getDifficultyMultiplier = (9.5+0.5)*0.25 = 2.5, and it gets a 7-router handicap.
    { label: "W0R1D",       args: ["--opponent", "????????????", "--no-cycle"] },
  ] },
};

/** Two arg lists equal as strings (running-script args may be numbers or strings). Pure. */
export function argsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => String(v) === String(b[i]));
}

/** Index of the relaunch option matching the running args, or -1. Pure. */
export function activeRelaunchMode(options, currentArgs) {
  for (let i = 0; i < options.length; i++) if (argsEqual(options[i].args, currentArgs)) return i;
  return -1;
}

/** Parse a status file's raw text to an object, or null. Pure. */
export function parseStatus(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** Short display string for a status object. Flags staleness (writer stopped) from its timestamp. Pure. */
export function formatStatus(status, nowMs) {
  if (!status) return "-";
  const line = status.line || "running";
  if (nowMs != null && status.t) {
    const age = Math.round((nowMs - status.t) / 1000);
    if (age > 30) return line + " (" + age + "s old)";
  }
  return line;
}

// --- thin ns wrappers (write=0GB, read=0GB) ---

/** A manager calls this each loop with a compact { line: "..." } summary. */
export function writeStatus(ns, key, obj) {
  ns.write(statusPath(key), JSON.stringify({ ...obj, t: Date.now() }), "w");
}

/** True when a status entry was written BEFORE the current BitNode began -- i.e. it is a ghost
 *  from the previous node. Home files persist across a BitNode reset but the state they describe
 *  does not, so a stale entry renders last node's numbers as if they were current (e.g. a BN9
 *  hacknet line reading "153 h/s $32.00m/s" while sitting in BN2 with hacknet stopped).
 *  Pure so it can be unit-tested; `t` is stamped by writeStatus. */
export function isGhostStatus(status, lastNodeReset) {
  if (!status || typeof status.t !== "number") return false;
  if (!Number.isFinite(lastNodeReset) || lastNodeReset <= 0) return false;
  return status.t < lastNodeReset;
}

export function readStatus(ns, key) {
  const st = parseStatus(ns.read(statusPath(key)));
  // getResetInfo costs 1GB and every status reader (panel, hud) already pays it via lib/caps.
  try {
    if (isGhostStatus(st, ns.getResetInfo().lastNodeReset)) return null;
  } catch (e) { /* no getResetInfo -> fall through and return what we read */ }
  return st;
}

/** Persisted set of panel-enabled module keys (which the panel may auto-launch). */
export function readEnabled(ns) {
  const raw = ns.read(ENABLED_FILE);
  const obj = parseStatus(raw);
  return new Set(Array.isArray(obj) ? obj : []);
}
export function writeEnabled(ns, set) {
  ns.write(ENABLED_FILE, JSON.stringify([...set]), "w");
}
