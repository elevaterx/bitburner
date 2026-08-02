/** lib/hacknet-budget.js -- pure hacknet spend-control logic. NO ns calls. Unit-tested.
 *
 *  Three states, fail-safe: default is PAUSED (spend nothing). The daemon resets the control to
 *  "paused" on every launch, so a boot can never spend. States:
 *    - paused           : buy nothing (still sells hashes for cash).
 *    - payback          : buy an upgrade only if it pays for itself (from extra hash income) within
 *                         maxPaybackSeconds. Converges -- once nodes are strong, marginal upgrades
 *                         have long payback and it STOPS on its own, so cash accumulates untouched.
 *    - budget:<$N>      : spend up to $N total (best-ROI-first), IGNORING payback -- lets you grow
 *                         beyond the payback line, or clamp below it. Decrements to 0, then paused.
 *  A hard cash reserve is always respected. */

export const HASH_MONEY_PER_ACTION = 1e6; // "Sell for Money" pays $1e6 per action (4 hashes -> $250k/hash)

/** $ value of one hash when selling for money, derived from the action's live hash cost. */
export function hashDollarValue(hashCostPerAction, moneyPerAction = HASH_MONEY_PER_ACTION) {
  return hashCostPerAction > 0 ? moneyPerAction / hashCostPerAction : 0;
}

/** Seconds for an upgrade to pay for itself from its extra hash income. Infinity if it adds nothing. */
export function paybackSeconds(cost, gainHashesPerSec, hashValue) {
  const dollarsPerSec = gainHashesPerSec * hashValue;
  if (!(dollarsPerSec > 0)) return Infinity;
  return cost / dollarsPerSec;
}
export function paybackOk(cost, gainHashesPerSec, hashValue, maxSeconds) {
  return paybackSeconds(cost, gainHashesPerSec, hashValue) <= maxSeconds;
}

function normalizeCtl(mode, budget) {
  const b = Math.max(0, Number(budget) || 0);
  if (mode === "budget") return b > 0 ? { mode: "budget", budget: b } : { mode: "paused", budget: 0 };
  if (mode === "payback") return { mode: "payback", budget: 0 };
  return { mode: "paused", budget: 0 };
}

/** Parse the control file. Fail-safe: anything unrecognized -> paused.
 *  Forms: "paused" | "payback" | "budget:<number>" | JSON {mode,budget}. Pure. */
export function parseCtl(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return { mode: "paused", budget: 0 };
  if (t[0] === "{") { try { const o = JSON.parse(t); return normalizeCtl(o.mode, o.budget); } catch (e) { return { mode: "paused", budget: 0 }; } }
  const m = /^budget:\s*([0-9.eE+]+)$/.exec(t);
  if (m) return normalizeCtl("budget", Number(m[1]));
  if (t === "payback") return { mode: "payback", budget: 0 };
  return { mode: "paused", budget: 0 };
}

/** Serialize a control state back to the file form. Pure. */
export function ctlToStr(ctl) {
  if (ctl && ctl.mode === "budget") return "budget:" + ctl.budget;
  return ctl && ctl.mode === "payback" ? "payback" : "paused";
}

/** Dollar ceiling hacknet may spend THIS loop, given mode + live cash + reserve. Pure.
 *  paused -> 0; budget -> min(remaining budget, cash-reserve); payback -> cash-reserve (the per-upgrade
 *  payback filter does the actual gating). */
export function spendCeiling(mode, budget, cash, reserve) {
  const spendable = Math.max(0, cash - reserve);
  if (mode === "budget") return Math.min(Math.max(0, Number(budget) || 0), spendable);
  if (mode === "payback") return spendable;
  return 0;
}
