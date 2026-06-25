/** @param {NS} ns
 * arrange.js -- snap the HUD stack (hud1, hud2, sing) back to the preferred layout.
 *
 * Run manually (`run arrange.js`) or via the hud1 "arrange" button. Finds each window's running
 * pid and re-applies its position+size from the shared winlayout.js table. Windows that aren't
 * running are skipped. Safe to run anytime -- it only moves/resizes existing tails.
 *
 * Must be added to pull.js. */
import { applyLayout, pidOf, LAYOUT } from "winlayout.js";

export async function main(ns) {
    let done = 0, skipped = [];
    for (const which of Object.keys(LAYOUT)) {
        const pid = pidOf(ns, which + ".js");
        if (!pid) { skipped.push(which); continue; }
        await applyLayout(ns, which, pid, true);   // reopen=true: ensure tail is open, then place
        done++;
    }
    const msg = "arranged " + done + " window(s)" + (skipped.length ? "; not running: " + skipped.join(", ") : "");
    ns.tprint("[arrange] " + msg);
    ns.toast(msg, "success", 2500);
}
