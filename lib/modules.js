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
  { file: "hacknet.js",     label: "Hacknet" },
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
  "hacknet.js": { type: "file", file: "hoard.txt", options: [
    { label: "Spend", on: false }, { label: "Hoard", on: true },
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
    { label: "Cycle", args: [] }, { label: "Illuminati", args: ["--opponent", "Illuminati", "--no-cycle"] },
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

export function readStatus(ns, key) {
  return parseStatus(ns.read(statusPath(key)));
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
