/** hud2.js -- on-demand display: faction rep + aug status.
 *  Singularity-only data, RAM-expensive. Launch from hud1 when RAM allows; kill when
 *  you need the RAM back. Slow refresh (5s) since faction data ticks slowly.
 *
 *  Shows per joined faction: rep, count of augs offered that you don't own (NFG excluded
 *  -- it's shown separately as a stacking level indicator with next-rep/cost).
 *
 *  Must be added to pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.ui.resizeTail(420, 380);
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

        // NFG level: count installed copies; queued = pending install
        let nfgInstalled = 0, nfgQueued = 0;
        for (const a of installed) if (a === NFG) nfgInstalled++;
        for (const a of queued)    if (a === NFG) nfgQueued++;
        const nfgPending = nfgQueued - nfgInstalled;

        // next NFG cost/rep -- cheapest across joined factions offering it
        let nfgNextRep = Infinity, nfgNextCost = Infinity;
        for (const fac of factions) {
            try {
                const augs = S.getAugmentationsFromFaction(fac);
                if (augs.includes(NFG)) {
                    const r = S.getAugmentationRepReq(NFG);
                    const c = S.getAugmentationPrice(NFG);
                    if (c < nfgNextCost) { nfgNextCost = c; nfgNextRep = r; }
                }
            } catch (e) {}
        }

        // per-faction: rep + augs left (excluding NFG, which is shown separately)
        const facRows = [];
        for (const fac of factions) {
            let rep = 0; try { rep = S.getFactionRep(fac); } catch (e) {}
            let augs = []; try { augs = S.getAugmentationsFromFaction(fac); } catch (e) {}
            const left = augs.filter(a => !ownedSet.has(a) && a !== NFG).length;
            facRows.push({ fac, rep, left });
        }
        facRows.sort((a, b) => b.rep - a.rep);

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
                    h("span", { style: { color: hackColor, fontWeight: 700 } },
                        "L" + nfgInstalled + (nfgPending > 0 ? ("  (+" + nfgPending + " queued)") : "")
                    )
                ),
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 11, color: muted, marginTop: 2 } },
                    h("span", null, "next req"),
                    h("span", null, "rep " + fmt(nfgNextRep) + "   $" + fmt(nfgNextCost))
                )
            ),
            panel("FACTIONS",
                h("div", { style: { display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 12, rowGap: 2, fontSize: 12 } },
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5 } }, "FACTION"),
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5, textAlign: "right" } }, "REP"),
                    h("span", { style: { color: muted, fontSize: 10, letterSpacing: 0.5, textAlign: "right" } }, "AUGS"),
                    ...facRows.flatMap(r => [
                        h("span", { key: r.fac + ":n", style: { color: hackColor } }, r.fac),
                        h("span", { key: r.fac + ":r", style: { textAlign: "right" } }, fmt(r.rep)),
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
