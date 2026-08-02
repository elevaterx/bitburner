/** lib/fmt.js -- pure formatting helpers. NO ns calls -> 0 GB RAM cost and unit-testable in Node.
 *  Shared so every script formats money/ram/time/pct identically instead of copy-pasting a fmt().
 *  In-game you *can* use ns.formatNumber/ns.formatRam, but those cost nothing extra and differ
 *  slightly in suffixing; these keep output stable across scripts and are usable from pure logic. */

const SUFFIX = ["", "k", "m", "b", "t", "q", "Q", "s", "S"];

/** Compact number with k/m/b/t... suffix, sign-aware. num(1234) -> "1.23k". */
export function num(n, digits = 2) {
  if (!isFinite(n)) return String(n);
  const sign = n < 0 ? "-" : "";
  let x = Math.abs(n);
  if (x < 1000) return sign + trim(x, digits);
  let i = 0;
  while (x >= 1000 && i < SUFFIX.length - 1) { x /= 1000; i++; }
  return sign + trim(x, digits) + SUFFIX[i];
}

/** Money with a leading $ . money(-1.5e6) -> "-$1.50m". */
export function money(n, digits = 2) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + num(Math.abs(n), digits);
}

/** RAM in GB, promoting to TB/PB. ram(2048) -> "2.00TB". */
export function ram(gb, digits = 2) {
  const units = ["GB", "TB", "PB", "EB"];
  let x = Math.abs(gb), i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (gb < 0 ? "-" : "") + trim(x, digits) + units[i];
}

/** Fraction (0..1) as a percent. pct(0.0731) -> "7.3%". */
export function pct(x, digits = 1) {
  if (!isFinite(x)) return String(x);
  return trim(x * 100, digits) + "%";
}

/** Milliseconds as a compact human duration. time(3661000) -> "1h 01m". */
export function time(ms) {
  if (!isFinite(ms)) return String(ms);
  const s = Math.abs(ms) / 1000;
  if (s < 60) return trim(s, 1) + "s";
  const m = Math.floor(s / 60), rs = Math.floor(s % 60);
  if (m < 60) return m + "m " + pad2(rs) + "s";
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return h + "h " + pad2(rm) + "m";
  const d = Math.floor(h / 24), rh = h % 24;
  return d + "d " + pad2(rh) + "h";
}

function trim(x, digits) {
  // Drop trailing zeros so 2.00 -> "2", 2.50 -> "2.5", but keep small values readable.
  const f = x.toFixed(digits);
  return f.replace(/\.?0+$/, "");
}
function pad2(n) { return n < 10 ? "0" + n : String(n); }
