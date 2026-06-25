/** hud2.js -- on-demand display: faction rep + aug status.
 *  Singularity-only data, RAM-expensive. Launch from hud1 when RAM allows; kill when
 *  you need the RAM back. Slow refresh (5s) since faction data ticks slowly.
 *
 *  Shows per joined faction: rep, count of augs offered that you don't own (NFG excluded
 *  -- it's shown separately as a stacking level indicator with next-rep/cost).
 *
 *  Must be added to pull.js. @param {NS} ns */
import { applyLayout } from "winlayout.js";
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();
    await applyLayout(ns, "hud2", ns.pid);   // self-position to the preferred stack layout
    const React = globalThis.React;
    const h = React.createElement;
    const S = ns.singularity;
    const NFG = "NeuroFlux Governor";

    while (true) {
        const me = ns.getPlayer();
        const installed = S.getOwnedAugmentations(false);     // installed only
        const queued    = S.getOwnedAugmentations(true);      // installed + purchased-not-installed
        const ownedSet  = new Set(queued);
        const factions  = me.factions;

        // NFG "level" is NOT countable from getOwnedAugmentations -- the fork (like vanilla)
        // stores stacked NFGs as one array entry and tracks level in a separate field.
        // Back-calculate level from the next-NFG rep requirement, which follows the formula
        //   nextRepReq = 500 * 1.14^currentLevel
        // Solving for level: currentLevel = log(nextRepReq / 500) / log(1.14).
        // This count INCLUDES queued NFGs (since each purchase bumps the next req), so
        // pre-install it shows installed+queued total; post-install it shows installed only.
        let nfgLevel = 0;
        let nfgNextRep = null, nfgNextCost = null;
        for (const fac of factions) {
            try {
                const augs = S.getAugmentationsFromFaction(fac);
                if (augs.includes(NFG)) {
                    const r = S.getAugmentationRepReq(NFG);
                    const c = S.getAugmentationPrice(NFG);
                    if (nfgNextCost === null || c < nfgNextCost) {
                        nfgNextCost = c;
                        nfgNextRep = r;
                    }
                }
            } catch (e) {}
        }
        if (nfgNextRep !== null && nfgNextRep > 0) {
            nfgLevel = Math.max(0, Math.round(Math.log(nfgNextRep / 500) / Math.log(1.14)));
        }

        // per-faction: rep + favor + augs-remaining count + per-aug detail (for the snapshot file).
        // Hacking-relevant multiplier keys to surface in per-aug detail.
        const HACK_KEYS = ["hacking", "hacking_exp", "hacking_speed", "hacking_money", "hacking_chance", "hacking_grow"];
        const facRows = [];          // for display: { fac, rep, favor, left }
        const facDetail = [];        // for snapshot file: full per-aug detail
        for (const fac of factions) {
            let rep = 0, favor = 0;
            try { rep = S.getFactionRep(fac); } catch (e) {}
            try { favor = S.getFactionFavor(fac); } catch (e) {}
            let augs = [];
            try { augs = S.getAugmentationsFromFaction(fac); } catch (e) {}
            const unowned = augs.filter(a => !ownedSet.has(a) && !a.startsWith(NFG));
            facRows.push({ fac, rep, favor, left: unowned.length });

            // per-aug detail for snapshot file
            const augList = [];
            for (const a of unowned) {
                let r = 0, c = 0, stats = {};
                try { r = S.getAugmentationRepReq(a); } catch (e) {}
                try { c = S.getAugmentationPrice(a); } catch (e) {}
                try { stats = S.getAugmentationStats(a); } catch (e) {}
                const mults = {};
                for (const k of HACK_KEYS) if (stats[k] && stats[k] !== 1) mults[k] = stats[k];
                augList.push({ name: a, rep: r, cost: c, mults });
            }
            augList.sort((a, b) => a.rep - b.rep);   // by rep req ascending
            facDetail.push({ name: fac, rep, favor, augs: augList });
        }
        facRows.sort((a, b) => b.rep - a.rep);

        // --- write data file for hud1 snapshot button to pick up ---
        try {
            const data = {
                ts: Date.now(),
                installed: installed.slice().sort(),   // full installed list (NFG appears once regardless of level)
                nfg: {
                    level: nfgLevel,                   // derived from rep req formula, not array count
                    nextRep: nfgNextRep,
                    nextCost: nfgNextCost,
                },
                factions: facDetail,
            };
            ns.write("hud2-data.txt", JSON.stringify(data), "w");
        } catch (e) {}

        // theme
        let theme = {};
        try { theme = ns.ui.getTheme(); } catch (e) {}
        const bg = theme.backgroundprimary || "#1a1a1a";
        const muted = theme.secondary || "#888";
        const panelBg = theme.welllight || "rgba(255,255,255,0.04)";
        const panelBorder = theme.well || "#2a2a2a";
        const titleColor = theme.primary || "#5fb3d8";
        const moneyColor = theme.money || "#ffd166";
        const hackColor = theme.hack || "#5fb3d8";

        const panel = (title, ...children) => h("div", {
            style: { background: panelBg, border: "1px solid " + panelBorder, borderRadius: 4, padding: "6px 8px", marginBottom: 6 },
        },
            h("div", { style: { color: titleColor, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 } }, title),
            ...children
        );

        // --- render ---
        ns.clearLog();
        ns.printRaw(h("div", { style: { fontFamily: "monospace", background: bg, padding: 6 } },
            panel("NEUROFLUX",
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 13 } },
                    h("span", null, "level"),
                    h("span", { style: { color: hackColor, fontWeight: 700 } }, "L" + nfgLevel)
                ),
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 11, color: muted, marginTop: 2 } },
                    h("span", null, "next req"),
                    h("span", null,
                        nfgNextRep !== null ? ("rep " + fmt(nfgNextRep) + "   $" + fmt(nfgNextCost)) : "(no faction offering)"
                    )
                )
            ),
            panel("FACTIONS",
                h("div", { style: { display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, rowGap: 2, fontSize: 12 } },
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5 } }, "FACTION"),
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5, textAlign: "right" } }, "REP"),
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5, textAlign: "right" } }, "FAV"),
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5, textAlign: "right" } }, "AUGS"),
                    ...facRows.flatMap(r => [
                        h("span", { key: r.fac + ":n", style: { color: hackColor } }, r.fac),
                        h("span", { key: r.fac + ":r", style: { textAlign: "right" } }, fmt(r.rep)),
                        h("span", { key: r.fac + ":f", style: { textAlign: "right", color: r.favor > 0 ? moneyColor : muted } }, r.favor.toFixed(1)),
                        h("span", { key: r.fac + ":a", style: { textAlign: "right", color: r.left > 0 ? moneyColor : muted } }, r.left),
                    ])
                )
            )
        ));

        await ns.sleep(5000);   // slow refresh -- faction data is slow-changing
    }
}

function fmt(n) {
    if (!isFinite(n)) return "--";
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n / 1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n / 1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n / 1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
