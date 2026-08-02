/** panel.js -- BitNode-aware control panel + jobs board for the whole background stack.
 *  Sibling to hud1 (the farm HUD). Consolidates the many worker tail windows into one surface so you
 *  can see status, start/stop, and FLIP MODES on the fly without remembering each daemon's flags.
 *
 *  RAM-SAFE: never calls the subsystem APIs (Corp info = 10GB/call, etc.). Reads status files the
 *  managers write, plus cheap base calls (getResetInfo/getScriptRam/getRunningScript/run/kill).
 *  ~6GB total, so it runs even on a fresh-BitNode home.
 *
 *  MODULES (capability-gated, from lib/modules MODULES): shown only when their API exists in this node.
 *    Start/Stop, On/Off (may the panel auto-launch it), RAM-fit gating, live status from status/<key>.txt.
 *  WORKERS (lib/modules WORKER_JOBS): running background daemons with uptime + RAM + Stop.
 *  MODES (lib/modules MODES): per-daemon mode chips. Two kinds --
 *    - relaunch: kill + re-run with an arg set (coordinator presets, this suite's --flags). Active chip
 *      is detected from the running instance's args.
 *    - file: a live control file the daemon re-reads each loop (hacknet's hoard.txt) -- no restart.
 *
 *  Buttons only queue an action; all ns work happens in the loop (Bitburner requires this).
 *  usage:  run panel.js [--no-auto]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { ram as fmtRam, time as fmtTime } from "./lib/fmt.js";
import {
  MODULES, WORKER_JOBS, MODES, relevantModules, readStatus, formatStatus,
  readEnabled, writeEnabled, activeRelaunchMode,
} from "./lib/modules.js";

export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  const React = globalThis.React, h = React.createElement;
  const flags = ns.flags([["no-auto", false]]);

  const pending = [];
  let enabled = readEnabled(ns);
  let firstRun = true;

  while (true) {
    const caps = getCapabilities(ns);
    const mods = relevantModules(caps);
    if (firstRun && enabled.size === 0) { for (const m of mods) enabled.add(m.key); writeEnabled(ns, enabled); }
    firstRun = false;

    // --- drain queued button actions (no ns work happens inside onClick) ---
    let dirty = false;
    while (pending.length) {
      const a = pending.shift();
      if (a.type === "start") { if (!ns.isRunning(a.file, "home")) ns.run(a.file); }
      else if (a.type === "stop") ns.scriptKill(a.file, "home");
      else if (a.type === "enable") { enabled.add(a.key); dirty = true; }
      else if (a.type === "disable") { enabled.delete(a.key); dirty = true; }
      else if (a.type === "relaunch") { ns.scriptKill(a.file, "home"); ns.run(a.file, 1, ...a.args); }
      else if (a.type === "file") { if (a.on) ns.write(a.file, "1", "w"); else if (ns.fileExists(a.file, "home")) ns.rm(a.file, "home"); }
    }
    if (dirty) writeEnabled(ns, enabled);

    const homeMax = ns.getServerMaxRam("home");
    const homeFree = homeMax - ns.getServerUsedRam("home");
    const now = Date.now();

    // --- capability modules ---
    const modRows = mods.map((m) => {
      const rs = ns.getRunningScript(m.file, "home");
      const exists = ns.fileExists(m.file, "home");
      const cost = exists ? ns.getScriptRam(m.file, "home") : 0;
      const fits = cost > 0 && cost <= homeFree;
      const on = enabled.has(m.key);
      const status = exists ? formatStatus(readStatus(ns, m.key), now) : "missing";
      if (!flags["no-auto"] && on && exists && !rs && fits) ns.run(m.file);
      return {
        kind: "module", key: m.key, file: m.file, label: m.label, running: !!rs, cost, fits, on, status,
        mode: modeData(ns, m.file, !!rs, rs ? rs.args : []),
      };
    });

    // --- background workers (running only) ---
    const workerRows = [];
    for (const j of WORKER_JOBS) {
      const rs = ns.getRunningScript(j.file, "home");
      if (!rs) continue;
      workerRows.push({
        kind: "worker", file: j.file, label: j.label, up: rs.onlineRunningTime, ram: rs.ramUsage * rs.threads,
        mode: modeData(ns, j.file, true, rs.args),
      });
    }

    // --- feed hud1's diagnostic snapshot ---
    ns.write("panel-data.txt", JSON.stringify({
      ts: now, node: caps.node, auto: !flags["no-auto"], homeFree, homeMax,
      modules: modRows.map((r) => ({ key: r.file, label: r.label, running: r.running, cost: r.cost, fits: r.fits, on: r.on, status: r.status })),
      workers: workerRows.map((r) => ({ label: r.label, up: r.up, ram: r.ram })),
    }), "w");

    ns.clearLog();
    ns.printRaw(view(h, { modRows, workerRows, homeFree, homeMax, node: caps.node, auto: !flags["no-auto"], pending }));
    await ns.sleep(1000);
  }
}

/** Build the mode-chip descriptor for a daemon, or null. Reads live state (running args / control
 *  file presence) to mark the active chip. */
function modeData(ns, file, running, args) {
  const spec = MODES[file];
  if (!spec) return null;
  if (spec.type === "relaunch") {
    const active = running ? activeRelaunchMode(spec.options, args) : -1;
    return { type: "relaunch", file, options: spec.options.map((o, i) => ({ label: o.label, args: o.args, active: i === active })) };
  }
  // file toggle
  const present = ns.fileExists(spec.file, "home");
  return { type: "file", controlFile: spec.file, options: spec.options.map((o) => ({ label: o.label, on: o.on, active: o.on === present })) };
}

// ---------------- rendering ----------------

function view(h, { modRows, workerRows, homeFree, homeMax, node, auto, pending }) {
  const mono = { fontFamily: "monospace", fontSize: "12px" };

  const chip = (label, active, onClick, color) => h("button", {
    onClick,
    style: {
      margin: "0 2px", padding: "0 5px", cursor: "pointer", fontFamily: "monospace", fontSize: "10px",
      background: active ? (color || "#274") : "#111", color: active ? "#dfd" : "#999",
      border: "1px solid " + (active ? (color || "#4a6") : "#444"), borderRadius: 3,
    },
  }, label);

  const btn = (label, onClick, color, disabled) => h("button", {
    onClick, disabled,
    style: {
      margin: "0 2px", padding: "1px 6px", cursor: disabled ? "default" : "pointer",
      background: disabled ? "#333" : "#111", color: disabled ? "#666" : (color || "#ddd"),
      border: "1px solid #444", borderRadius: 3, fontFamily: "monospace", fontSize: "11px",
    },
  }, label);

  // mode chips for a row (relaunch or file)
  const modeChips = (mode) => {
    if (!mode) return null;
    return mode.options.map((o, i) => chip(
      o.label, o.active,
      mode.type === "relaunch"
        ? () => pending.push({ type: "relaunch", file: mode.file, args: o.args })
        : () => pending.push({ type: "file", file: mode.controlFile, on: o.on }),
    ));
  };

  const rowWrap = (key, cells) =>
    h("div", { key, style: { ...mono, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, padding: "1px 0" } }, ...cells);

  // --- modules ---
  const modBody = modRows.length ? modRows.map((r) => {
    const dot = h("span", { style: { color: r.running ? "#6c6" : "#666", width: 12 } }, r.running ? "●" : "○");
    const name = h("span", { style: { color: "#ddd", width: 84 } }, r.label);
    const stat = h("span", { style: { color: "#bbb", flex: 1, minWidth: 80 } }, r.status);
    const ram = h("span", { style: { color: !r.exists ? "#f66" : r.fits ? "#999" : "#e94", width: 84, textAlign: "right" } },
      r.cost ? fmtRam(r.cost) + (r.fits ? "" : " !") : "?");
    const startStop = r.running
      ? btn("Stop", () => pending.push({ type: "stop", file: r.file }), "#f88")
      : btn("Start", () => pending.push({ type: "start", file: r.file }), "#8f8", !r.fits);
    const onOff = r.on
      ? btn("auto", () => pending.push({ type: "disable", key: r.key }), "#8f8")
      : btn("man", () => pending.push({ type: "enable", key: r.key }), "#888");
    return rowWrap("m-" + r.file, [dot, name, stat, ram, startStop, onOff, ...(modeChips(r.mode) || [])]);
  }) : [h("div", { key: "m-none", style: { ...mono, color: "#888" } }, "no capability modules in this BitNode")];

  // --- workers ---
  const workerHeader = workerRows.length
    ? h("div", { style: { ...mono, color: "#9ad", marginTop: 6, marginBottom: 2 } }, "Workers (" + workerRows.length + ")")
    : null;
  const workerBody = workerRows.map((r) => {
    const dot = h("span", { style: { color: "#6c6", width: 12 } }, "●");
    const name = h("span", { style: { color: "#ddd", width: 84 } }, r.label);
    const up = h("span", { style: { color: "#bbb", flex: 1, minWidth: 80 } }, "up " + fmtTime(r.up));
    const ram = h("span", { style: { color: "#999", width: 84, textAlign: "right" } }, fmtRam(r.ram));
    const stop = btn("Stop", () => pending.push({ type: "stop", file: r.file }), "#f88");
    return rowWrap("w-" + r.file, [dot, name, up, ram, stop, ...(modeChips(r.mode) || [])]);
  });

  const header = h("div", { style: { ...mono, color: "#9ad", marginBottom: 4 } },
    "Modules  BN" + node + "   free " + fmtRam(homeFree) + " / " + fmtRam(homeMax) + (auto ? "   [auto]" : "   [manual]"));

  return h("div", { style: { background: "#0b0b0b", padding: 8, border: "1px solid #333" } },
    header, ...modBody, workerHeader, ...workerBody);
}
