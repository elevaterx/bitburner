/** xp worker — pure hacking-XP farming on one server.
 *  Weakens only if security has drifted above min; otherwise grows.
 *  grow() grants XP every cycle even at max money, and at min security the
 *  action time is shortest, which is where XP/sec is highest. Either branch
 *  grants XP, so this never "wastes" a cycle and needs no timing.
 *  usage: run xp.js <target> [secBand]
 *  @param {NS} ns */
export async function main(ns) {
    const t = ns.args[0];
    const band = Number(ns.args[1]) || 2;   // weaken only if security exceeds min by more than this
    if (!t) { ns.tprint("xp.js: needs a target hostname"); return; }
    while (true) {
        const over = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
        if (over > band) await ns.weaken(t);
        else await ns.grow(t);
    }
}
