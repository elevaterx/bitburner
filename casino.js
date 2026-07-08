/** casino.js -- automated blackjack (BN8 seed accelerant).
 *
 *  ===== PHASE 2: SAVE-SCUM =====
 *  Reaches the Blackjack React component via the fiber and drives it directly
 *  (startGame(); playerHit/playerStay({isTrusted:true})), reads hands from state,
 *  plays the optimal hit/stand chart, and reads win/loss from ns.getPlayer().money.
 *  Then: SAVE on win, RELOAD on loss. The reload reverts the loss and -- because the
 *  script was running at the last save -- Bitburner restarts it on load, so it
 *  re-navigates to blackjack and continues. Net effect: bankroll only ratchets up.
 *
 *  PREREQUISITES (do these once, manually):
 *    1. Be in Aevum (sing travels you there in BN8; it persists across reloads).
 *    2. Options -> turn AUTOSAVE OFF (save icon goes red). Otherwise an autosave can
 *       fire right after a loss and lock it in, defeating the scum.
 *    3. Recommended: `kill trader.js` during the grind -- every reload rewinds ALL
 *       game state to the last save, so the trader would just churn. Relaunch it after.
 *
 *  usage:  run casino.js [targetCash] [bet] [mode]
 *          targetCash  stop when cash >= this (default 10e9; casino caps ~ $10b)
 *          bet         wager per hand (default 1e8 = max)
 *          mode        "noscum" to auto-play WITHOUT save/reload (safe nav+play test)
 *
 *  DOM/React-internals: cannot be node-tested, version-fragile. Heavily logged so we
 *  can debug from output. TEST 'noscum' at a small bet FIRST to confirm nav works.
 *  Must be in pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();
    const doc = eval("document");            // eval() dodges the 25GB static RAM charge
    const win = eval("window");
    const TARGET = Number(ns.args[0]) || 10e9;
    const BET    = Math.min(Number(ns.args[1]) || 1e8, 1e8);
    const NOSCUM = ns.args[2] === "noscum";
    const log = (m) => ns.print(m);

    if (ns.getPlayer().money >= TARGET) { ns.tprint("casino: already >= target $" + (TARGET / 1e9) + "b. Nothing to do."); return; }

    if (!(await navToBlackjack(ns, doc, log))) {
        ns.tprint("casino: could not reach Blackjack. Be in Aevum, then run again. Aborting.");
        return;
    }
    const inst = findBlackjack(doc);
    if (!inst) { ns.tprint("casino: Blackjack mounted but instance not found. Aborting."); return; }
    log("casino: at blackjack. target $" + (TARGET / 1e9).toFixed(1) + "b  bet $" + (BET / 1e6) + "m  " + (NOSCUM ? "[NOSCUM test]" : "[save-scum]"));

    if (!NOSCUM) {
        if (!triggerSave(doc)) log("casino: WARNING -- 'save game' button not found; losses won't revert! Check the overview is expanded.");
        await ns.sleep(900);
    }

    let hands = 0, wins = 0, losses = 0, ties = 0, errs = 0;
    while (ns.getPlayer().money < TARGET) {
        const m0 = ns.getPlayer().money;
        const ok = await playHand(ns, inst, BET, log);
        if (!ok) {
            if (++errs >= 3) { ns.tprint("casino: 3 hand errors -- stopping."); return; }
            await ns.sleep(500);
            if (!findBlackjack(doc)) { if (!(await navToBlackjack(ns, doc, log))) return; }
            continue;
        }
        const delta = ns.getPlayer().money - m0;
        hands++;
        if (delta < 0) {
            losses++;
            log("hand " + hands + ": LOSS " + (delta / 1e6).toFixed(0) + "m  | W" + wins + " L" + losses + " T" + ties + (NOSCUM ? "  (noscum: kept)" : "  -> reload"));
            if (!NOSCUM) { await ns.sleep(150); win.location.reload(); return; }   // revert; script restarts & resumes
        } else if (delta > 0) {
            wins++;
            log("hand " + hands + ": +" + (delta / 1e6).toFixed(0) + "m  cash $" + (ns.getPlayer().money / 1e9).toFixed(2) + "b  | W" + wins + " L" + losses + " T" + ties);
            if (!NOSCUM) { triggerSave(doc); await ns.sleep(500); }
        } else {
            ties++;
        }
        await ns.sleep(150);
    }
    ns.tprint("casino: reached $" + (ns.getPlayer().money / 1e9).toFixed(2) + "b. Done. (W" + wins + " L" + losses + " T" + ties + ")");
}

// ---- navigation / save (new in Phase 2) ----

// Ensure the Blackjack component is mounted; if not, click City -> casino -> Play blackjack.
async function navToBlackjack(ns, doc, log) {
    if (findBlackjack(doc)) return true;
    log("nav: routing to blackjack...");
    if (!clickByText(doc, "City", true))                 { log("nav: sidebar 'City' not found (World section expanded?)"); return false; }
    await ns.sleep(600);
    if (!clickByText(doc, ["casino", "Iker Molina Casino"], false)) { log("nav: casino location not found -- are you in Aevum?"); return false; }
    await ns.sleep(600);
    if (!clickByText(doc, "Play blackjack", false))      { log("nav: 'Play blackjack' button not found"); return false; }
    await ns.sleep(600);
    return !!findBlackjack(doc);
}

// Click the first clickable element matching text. exact=true requires exact trimmed match.
// texts may be a single string or a list of candidates (first match wins). Case-insensitive.
function clickByText(doc, texts, exact) {
    const cands = (Array.isArray(texts) ? texts : [texts]).map((s) => s.toLowerCase());
    for (const el of doc.querySelectorAll("button, a, [role=button], span, li, p, div")) {
        const t = (el.textContent || "").trim();
        const tl = t.toLowerCase();
        for (const cl of cands) {
            const hit = exact ? tl === cl : (tl.includes(cl) && t.length <= cl.length + 25);  // length guard skips wrapper divs
            if (hit) {
                const target = el.closest("button, a, [role=button]") || el;
                target.click();
                return true;
            }
        }
    }
    return false;
}

// Trigger a game save via the overview save button (no isTrusted guard on it).
function triggerSave(doc) {
    const btn = doc.querySelector('[aria-label="save game"]');
    if (!btn) return false;
    btn.click();
    return true;
}

// ================= PROVEN PHASE-1 CORE BELOW -- unchanged =================

// Walk the fiber tree from any button up to the Blackjack class instance.
function findBlackjack(doc) {
    for (const el of doc.querySelectorAll("button")) {
        const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
        if (!key) continue;
        let f = el[key];
        for (let d = 0; f && d < 40; d++, f = f.return) {
            const sn = f.stateNode;
            if (sn && typeof sn.startGame === "function" && typeof sn.playerHit === "function"
                && sn.state && "playerHand" in sn.state) return sn;
        }
    }
    return null;
}

// Play one hand to resolution. Returns true on a clean resolve, false on error.
async function playHand(ns, inst, bet, log) {
    try {
        try { inst.setState({ bet, betInput: String(bet), wagerInvalid: false }); } catch (e) {}
        inst.state.bet = bet;                       // ensure startGame reads the right wager
        await ns.sleep(60);
        inst.startGame();
        await ns.sleep(140);
    } catch (e) { log("  [startGame error] " + e); return false; }

    // If a natural resolved the hand immediately, we're done.
    if (!inst.state.gameInProgress) return true;

    for (let k = 0; k < 12; k++) {
        if (!inst.state.gameInProgress) return true;
        let move;
        try { move = decide(inst.state.playerHand, inst.state.dealerHand); }
        catch (e) { log("  [decide error] " + e); return false; }
        try {
            if (move === "S") { inst.playerStay({ isTrusted: true }); await ns.sleep(160); return true; }
            inst.playerHit({ isTrusted: true }); await ns.sleep(140);
        } catch (e) { log("  [play error] " + e); return false; }
    }
    return true;
}

// Optimal hit/stand for the game's rules (dealer stands soft 17, no double/split).
function decide(playerHand, dealerHand) {
    const p = handValue(playerHand.cards.map((c) => c.value));
    const upRaw = dealerHand.cards[0].value;
    const u = upRaw >= 10 ? 10 : upRaw;             // Ace stays 1 (not in the 2-6 stand range)
    if (p.total >= 21) return "S";
    if (p.soft) {
        if (p.total >= 19) return "S";
        if (p.total === 18) return (u === 9 || u === 10) ? "H" : "S";
        return "H";
    }
    if (p.total >= 17) return "S";
    if (p.total >= 13) return (u >= 2 && u <= 6) ? "S" : "H";
    if (p.total === 12) return (u >= 4 && u <= 6) ? "S" : "H";
    return "H";
}

function handValue(vals) {
    let total = 0, aces = 0;
    for (const v of vals) {
        if (v === 1) { aces++; total += 11; }
        else total += (v >= 10 ? 10 : v);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total, soft: aces > 0 };
}
