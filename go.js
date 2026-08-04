/** go.js -- IPvGO auto-player. Farms the subnet bonuses (hack/grow/etc. multipliers) by playing Go
 *  continuously against an AI opponent. Always available (no capability gate) -- so it is NOT launched
 *  by boot.js; run it opt-in when you want the passive bonus and aren't playing the board yourself.
 *
 *  Strategy is Monte-Carlo tree search (lib/go-mcts.js, unit-tested): grows a game tree and runs fast
 *  eye-safe random playouts, reading well enough to beat the built-in subnet AIs at every komi tier. The
 *  single-ply heuristic (lib/go-logic.js) is kept only as a superko fallback. Plays as Black; on game
 *  over it starts a fresh game, cycling opponents so wins accrue toward stronger subnets.
 *
 *  usage:  run go.js [--size 9] [--opponent "Netburners"] [--no-cycle] [--quiet] [--iters 400] [--budget 600]
 *          --iters  MCTS playouts per move (higher = stronger, slower). --budget  ms hard cap per move.
 *  @param {NS} ns */
import { chooseMove } from "./lib/go-logic.js";   // superko fallback only
import { mctsMove } from "./lib/go-mcts.js";
import { writeStatus } from "./lib/modules.js";

const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"];

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["size", 9],
    ["opponent", ""],
    ["no-cycle", false],
    ["quiet", false],
    ["iters", 400],
    ["budget", 600],
  ]);
  const size = Number(flags.size);
  const log = (m) => ns.tprint("[go] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[go] " + m); };

  // Engine tuning (iters/budget) lives in a control file so it SURVIVES opponent-pin relaunches from
  // the panel (those carry only --opponent args). Precedence: defaults <- go-ctl.txt <- explicit CLI.
  // An explicit --iters/--budget is written back; edit go-ctl.txt (nano) to retune live between games.
  const CTL = "go-ctl.txt";
  const readCtl = () => { try { const o = JSON.parse(ns.read(CTL) || "{}"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; } };
  { const cli = {};
    if (ns.args.includes("--iters")) cli.iters = Number(flags.iters);
    if (ns.args.includes("--budget")) cli.budget = Number(flags.budget);
    const merged = { iters: 400, budget: 600, ...readCtl(), ...cli };
    ns.write(CTL, JSON.stringify({ iters: merged.iters, budget: merged.budget }), "w");
    log("up: iters=" + merged.iters + " budget=" + merged.budget + "ms  (kept in go-ctl.txt; opponent pins preserve these)"); }

  if (!ns.go || typeof ns.go.getBoardState !== "function") { log("IPvGO API unavailable. Exiting."); return; }

  // Only ONE go.js may run -- there is a single IPvGO board. A duplicate (e.g. a panel pin racing the
  // auto-launch) would fight over board resets and produce phantom 0-move games. Newest instance wins:
  try { for (const p of ns.ps("home")) if (p.filename === "go.js" && p.pid !== ns.pid) ns.kill(p.pid); } catch (e) {}

  let oppIdx = 0;
  if (flags.opponent) { const i = OPPONENTS.indexOf(String(flags.opponent)); if (i >= 0) oppIdx = i; }

  while (true) {
    const opponent = flags.opponent && flags["no-cycle"] ? String(flags.opponent) : OPPONENTS[oppIdx % OPPONENTS.length];
    // A swallowed failure here is a silent trap: the loop would keep playing the PREVIOUS
    // board/opponent and the record would look fine while the pin never took. Report it.
    let resetOk = true;
    try { ns.go.resetBoardState(opponent, size); }
    catch (e) { resetOk = false; ns.tprint("go: resetBoardState(\"" + opponent + "\", " + size + ") FAILED -- " + e); }
    if (!resetOk) { await ns.sleep(5000); continue; }
    vlog("new game vs " + opponent + " (" + size + "x" + size + ")");
    let komi = 5.5; try { komi = ns.go.getGameState().komi; } catch (e) {}   // white's bonus, per opponent
    const cfg = { iters: 400, budget: 600, ...readCtl() };   // live engine tuning, re-read each game
    writeStatus(ns, "go", { line: "playing " + opponent + goRecord(ns, opponent) + "  " + cfg.iters + "it" });

    let moves = 0, mvN = 0, itSum = 0, msSum = 0, fb = 0;   // per-game MCTS diagnostics
    while (true) {
      const board = ns.go.getBoardState();
      const valid = ns.go.analysis.getValidMoves();
      const _t0 = Date.now(), _stats = {};
      let move = mctsMove(board, { komi, iterations: Number(cfg.iters), rng: Math.random, now: () => Date.now(), deadline: Date.now() + Number(cfg.budget), stats: _stats });
      const _fb = move && !(valid[move.x] && valid[move.x][move.y]);
      if (_fb) move = chooseMove(board, valid);   // rare superko: fall back to the heuristic
      msSum += Date.now() - _t0; itSum += _stats.iters || 0; mvN++; if (_fb) fb++;

      let res;
      try {
        res = move ? await ns.go.makeMove(move.x, move.y) : await ns.go.passTurn();
      } catch (e) { res = null; }

      if (!res || res.type === "gameOver") break;
      if (!move && res.type === "pass") break;   // both sides passed -> game ends
      moves++;
      if (moves > size * size * 4) break;         // safety: never loop forever on a stuck board
    }

    const gs = ns.go.getGameState();
    vlog("game over vs " + opponent + " -- you " + gs.blackScore + " : " + gs.whiteScore + " opp");
    const won = gs.blackScore > gs.whiteScore;
    const _per = mvN || 1, _it = Math.round(itSum / _per), _ms = Math.round(msSum / _per);
    const diag = " [" + _it + "it " + _ms + "ms" + (fb ? " fb" + fb : "") + "]";
    if (moves > 0) {   // skip phantom 0-move games (board was not fresh -- e.g. a stray duplicate instance)
      writeStatus(ns, "go", { line: "vs " + opponent + " " + (won ? "W" : "L") + " " + gs.blackScore + ":" + gs.whiteScore + goRecord(ns, opponent) + diag });
      appendGoHistory(ns, { t: Date.now(), opp: opponent, won, b: gs.blackScore, w: gs.whiteScore, komi, mv: moves, it: _it, ms: _ms, fb });
    } else { vlog("skipped phantom game vs " + opponent + " (0 moves)"); }
    if (!flags["no-cycle"]) oppIdx++;
    await ns.sleep(500);
  }
}

/** Append a per-game result + MCTS diagnostics to status/go-history.txt (last 25 games). Pure ns I/O. */
function appendGoHistory(ns, rec) {
  try {
    let arr = []; try { const o = JSON.parse(ns.read("status/go-history.txt") || "[]"); if (Array.isArray(o)) arr = o; } catch (e) {}
    arr.push(rec); if (arr.length > 25) arr = arr.slice(-25);
    ns.write("status/go-history.txt", JSON.stringify(arr), "w");
  } catch (e) {}
}

/** Cumulative W/L record + streak vs an opponent, from the free ns.go stats API (0 GB). "" on failure. */
function goRecord(ns, opponent) {
  try {
    const st = ns.go.analysis.getStats()[opponent];
    if (!st) return "";
    return "  " + st.wins + "-" + st.losses + " (streak " + st.winStreak + ")";
  } catch (e) { return ""; }
}
