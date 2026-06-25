/** @param {NS} ns
 * Shared tail-window layout for the HUD stack (hud1, hud2, sing).
 *
 * Positions are FRACTIONS of the live game window (from ns.ui.windowSize()), so the arrangement
 * holds across monitor sizes / resolutions instead of being hardcoded pixels. The layout mirrors
 * Nate's preferred config: a right-side vertical stack -- hud2 on top, hud1 (tall) in the middle,
 * sing at the bottom.
 *
 * Quirk handled here (per bitburner-src issue #2239): opening a tail then immediately moving it
 * lands the window in the CENTER on the first try; the position only "takes" on a second apply.
 * applyLayout() therefore re-applies move+resize twice with a short settle between.
 *
 * Edit the LAYOUT table to retune. Each entry: [xFrac, yFrac, widthFrac, heightFrac].
 */

export const LAYOUT = {
    //        xFrac   yFrac   wFrac   hFrac
    hud2: [0.642,  0.012,  0.118,  0.175],   // top of stack: NEUROFLUX + FACTIONS, narrow/short
    hud1: [0.764,  0.012,  0.152,  0.610],   // middle: tall control HUD (the main panel)
    sing: [0.764,  0.660,  0.152,  0.235],   // bottom: singularity / faction-work display
};

// game window size, with a sane fallback if the call is unavailable for any reason.
function winSize(ns) {
    try { const s = ns.ui.windowSize(); if (Array.isArray(s) && s.length === 2) return s; } catch (e) {}
    return [1920, 1080];
}

/** Position + size a single tail window by name (key into LAYOUT) for the given pid.
 *  Pass the script's own ns.pid to self-position, or another script's pid to arrange it.
 *  reopen=true also (re)opens the tail first -- used by the standalone arranger so it can
 *  arrange windows that might be closed. Self-positioning scripts already have their tail open. */
export async function applyLayout(ns, which, pid, reopen) {
    const spec = LAYOUT[which];
    if (!spec) { ns.print("winlayout: no layout for '" + which + "'"); return false; }
    const [ww, wh] = winSize(ns);
    const x = Math.round(spec[0] * ww);
    const y = Math.round(spec[1] * wh);
    const w = Math.round(spec[2] * ww);
    const h = Math.round(spec[3] * wh);
    if (reopen) { try { ns.ui.openTail(pid); } catch (e) {} }
    // double-apply with a settle to defeat the open->center quirk.
    for (let i = 0; i < 2; i++) {
        await ns.sleep(120);
        try { ns.ui.moveTail(x, y, pid); } catch (e) {}
        try { ns.ui.resizeTail(w, h, pid); } catch (e) {}
    }
    return true;
}

/** Find the pid of a running script by filename on home (the HUDs all run on home). */
export function pidOf(ns, filename) {
    for (const p of ns.ps("home")) if (p.filename === filename) return p.pid;
    return 0;
}
