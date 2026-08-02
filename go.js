/** go.js -- IPvGO auto-player. Farms the subnet bonuses (hack/grow/etc. multipliers) by playing Go
 *  continuously against an AI opponent. Always available (no capability gate) -- so it is NOT launched
 *  by boot.js; run it opt-in when you want the passive bonus and aren't playing the board yourself.
 *
 *  Strategy is a single-ply greedy scorer in lib/go-logic.js (pure, unit-tested): capture, rescue
 *  atari, expand, avoid self-atari. Plays as Black. On game over it starts a fresh game, cycling
 *  opponents so wins accrue toward stronger subnets.
 *
 *  usage:  run go.js [--size 9] [--opponent "Netburners"] [--no-cycle] [--quiet]
 *  @param {NS} ns */
import { chooseMove } from "./lib/go-logic.js";
import { writeStatus } from "./lib/modules.js";

const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"];

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["size", 9],
    ["opponent", ""],
    ["no-cycle", false],
    ["quiet", false],
  ]);
  const size = Number(flags.size);
  const log = (m) => ns.tprint("[go] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[go] " + m); };

  if (!ns.go || typeof ns.go.getBoardState !== "function") { log("IPvGO API unavailable. Exiting."); return; }

  let oppIdx = 0;
  if (flags.opponent) { const i = OPPONENTS.indexOf(String(flags.opponent)); if (i >= 0) oppIdx = i; }

  while (true) {
    const opponent = flags.opponent && flags["no-cycle"] ? String(flags.opponent) : OPPONENTS[oppIdx % OPPONENTS.length];
    try { ns.go.resetBoardState(opponent, size); } catch (e) { /* opponent may be locked */ }
    vlog("new game vs " + opponent + " (" + size + "x" + size + ")");
    writeStatus(ns, "go", { line: "playing " + opponent });

    let moves = 0;
    while (true) {
      const board = ns.go.getBoardState();
      const valid = ns.go.analysis.getValidMoves();
      const liberties = ns.go.analysis.getLiberties();
      const move = chooseMove(board, valid, liberties);

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
    writeStatus(ns, "go", { line: "vs " + opponent + "  " + gs.blackScore + ":" + gs.whiteScore });
    if (!flags["no-cycle"]) oppIdx++;
    await ns.sleep(500);
  }
}
