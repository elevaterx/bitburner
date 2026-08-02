/** panel.js -- BitNode-aware control panel for the capability modules (gang/sleeves/bladeburner/
 *  corp/go). Sibling to hud1 (the farm HUD); this one governs the late-game managers.
 *
 *  RAM-SAFE BY DESIGN: it NEVER calls the subsystem APIs (Corp info = 10GB/call, etc.). Each manager
 *  writes a tiny status line to status/<key>.txt; the panel only READS those (ns.read = 0GB) and uses
 *  cheap base calls (getResetInfo/getScriptRam/scriptRunning/run/kill). Total ~5-6GB, so it runs even
 *  on a fresh-BitNode home (as low as 8GB) when the managers themselves may not yet fit.
 *
 *  BitNode-aware: only shows modules whose capability exists (via lib/caps). RAM-aware: shows each
 *  module's RAM cost vs free home RAM, and only offers/auto-launches ones that FIT -- so after a reset
 *  it brings managers up automatically as home RAM grows, without re-running boot. Per-module buttons:
 *  Start/Stop, and On/Off (whether the panel may auto-launch it). Uses hud1's action-queue pattern:
 *  onClick only sets a flag; all ns work happens in the loop.
 *
 *  usage:  run panel.js [--no-auto]   (--no-auto = display + manual buttons only, no auto-launch)
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { ram as fmtRam } from "./lib/fmt.js";
import { relevantModules, readStatus, formatStatus, readEnabled, writeEnabled } from "./lib/modules.js";

export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  const React = globalThis.React, h = React.createElement;
  const flags = ns.flags([["no-auto", false]]);

  const pending = [];             // button clicks queue {type, key, file}
  let enabled = readEnabled(ns);
  let firstRun = true;

  while (true) {
    const caps = getCapabilities(ns);
    const mods = relevantModules(caps);
    if (firstRun && enabled.size === 0) { for (const m of mods) enabled.add(m.key); writeEnabled(ns, enabled); }
    firstRun = false;

    // Drain queued button actions (no ns calls happen inside onClick handlers).
    let enabledDirty = false;
    while (pending.length) {
      const a = pending.shift();
      if (a.type === "start") { if (!ns.scriptRunning(a.file, "home")) ns.run(a.file); }
      else if (a.type === "stop") { ns.scriptKill(a.file, "home"); }
      else if (a.type === "enable") { enabled.add(a.key); enabledDirty = true; }
      else if (a.type === "disable") { enabled.delete(a.key); enabledDirty = true; }
    }
    if (enabledDirty) writeEnabled(ns, enabled);

    const homeMax = ns.getServerMaxRam("home");
    const homeFree = homeMax - ns.getServerUsedRam("home");
    const now = Date.now();

    const rows = mods.map((m) => {
      const exists = ns.fileExists(m.file, "home");
      const running = exists && ns.scriptRunning(m.file, "home");
      const cost = exists ? ns.getScriptRam(m.file, "home") : 0;
      const fits = cost > 0 && cost <= homeFree;
      const on = enabled.has(m.key);
      const status = exists ? formatStatus(readStatus(ns, m.key), now) : "missing";
      // Auto-launch: enabled + fits + present + not already running.
      if (!flags["no-auto"] && on && exists && !running && fits) ns.run(m.file);
      return { m, exists, running, cost, fits, on, status };
    });

    ns.printRaw(view(h, { rows, homeFree, homeMax, node: caps.node, auto: !flags["no-auto"], pending }));
    await ns.sleep(1000);
  }
}

function view(h, { rows, homeFree, homeMax, node, auto, pending }) {
  const mono = { fontFamily: "monospace", fontSize: "12px" };
  const btn = (label, onClick, color, disabled) => h("button", {
    onClick, disabled,
    style: {
      margin: "0 2px", padding: "1px 6px", cursor: disabled ? "default" : "pointer",
      background: disabled ? "#333" : "#111", color: disabled ? "#666" : (color || "#ddd"),
      border: "1px solid #444", borderRadius: 3, fontFamily: "monospace", fontSize: "11px",
    },
  }, label);

  const header = h("div", { style: { ...mono, color: "#9ad", marginBottom: 4 } },
    `Modules  BN${node}   free ${fmtRam(homeFree)} / ${fmtRam(homeMax)}` + (auto ? "   [auto]" : "   [manual]"));

  const body = rows.length ? rows.map((r) => {
    const startBtn = r.running
      ? btn("Stop", () => pending.push({ type: "stop", file: r.m.file }), "#f88")
      : btn("Start", () => pending.push({ type: "start", file: r.m.file }), "#8f8", !r.fits);
    const toggle = r.on
      ? btn("On", () => pending.push({ type: "disable", key: r.m.key }), "#8f8")
      : btn("Off", () => pending.push({ type: "enable", key: r.m.key }), "#888");

    const dot = r.running ? "●" : "○";
    const dotColor = r.running ? "#6c6" : "#666";
    const ramNote = !r.exists ? "no file"
      : r.fits ? fmtRam(r.cost)
      : fmtRam(r.cost) + " (too big)";
    const ramColor = !r.exists ? "#f66" : r.fits ? "#999" : "#e94";

    return h("div", { key: r.m.key, style: { ...mono, display: "flex", alignItems: "center", gap: 6, padding: "1px 0" } },
      h("span", { style: { color: dotColor, width: 12 } }, dot),
      h("span", { style: { color: "#ddd", width: 92 } }, r.m.label),
      h("span", { style: { color: "#bbb", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, r.status),
      h("span", { style: { color: ramColor, width: 92, textAlign: "right" } }, ramNote),
      h("span", { style: { width: 120, textAlign: "right" } }, startBtn, toggle),
    );
  }) : [h("div", { key: "none", style: { ...mono, color: "#888" } }, "no capability modules available in this BitNode")];

  return h("div", { style: { background: "#0b0b0b", padding: 8, border: "1px solid #333" } }, header, ...body);
}
