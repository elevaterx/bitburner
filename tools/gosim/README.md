# gosim — offline IPvGO harness

Runs Bitburner's REAL Go opponent AI in Node, so bot changes are benchmarked offline instead of by
watching the in-game record. Same principle as `tools/augbuy-replay.mjs`: the thing under test must be
runnable without the game.

## Layout
- `build.mjs` + `entry.ts` + `stubs/` — esbuild bundle of the game's Go AI. The `.tsx`/bare-package
  stubs are the hard-won part: they let `src/Go/**` compile out of the Bitburner tree with no browser
  or React dependency. Produces `bbgo.mjs` (~246KB, generated — NOT committed, rebuild it).
- `harness.mjs` — plays a bot against the real AI, returns result + move/iteration stats.
- `bench.mjs` / `bench-worker.mjs` — parallel benchmarking across N games.
- `sweep.mjs` — parameter sweep over an evaluator's config.
- `bots/territory.mjs` — the territorial evaluator (see below).
- `bots/current.mjs`, `bots/go-logic.js`, `bots/go-mcts.js` — snapshot of the shipped bot for A/B.
- `bench_terr.json` / `bench_terr.log` — the measurement backing the claim below.

## Rebuild
```
npm install          # esbuild only
node build.mjs       # regenerates bbgo.mjs from a bitburner-src checkout
node bench.mjs       # A/B the bots
```
`build.mjs` expects a Bitburner source clone; point it at one
(`git clone --depth 1 https://github.com/bitburner-official/bitburner-src`).

## Why territory.mjs exists
The `w0r1d_d43m0n` opponent (`getIlluminatiPriorityMove`, isSmart) is a fixed priority ladder with no
lookahead and **no territory or influence valuation anywhere**. Its only notion of owned space is
`getAllPotentialEyes`, capped at 11 points (`maxSize = min(nodeCount*0.4, 11)`).

Meanwhile `scoring.ts/checkTerritoryOwnership` has no practical size cap (guard is `size^2-3 = 358`)
and inspects only STONE neighbours — dead/offline nodes do not break ownership, and the bitverse board
has 94 of them acting as free walls.

So large enclosed regions score fully and the opponent is structurally blind to them. `territory.mjs`
maximises exactly that (Bouzy 5/21 influence field, dead nodes as walls), subject to not losing stones
tactically. Architecture is cheap-prior → shortlist → expensive-exact, because full influence
recomputation over ~200 legal moves blows the per-move budget.

## Status (2026-08-07) — NOT YET INTEGRATED
Measured on 19x19 vs `w0r1d_d43m0n`: **territory.mjs ~7% wins, shipped MCTS bot 0%** (0-52 live in
BN2). On small boards MCTS is far better (293-103), so integration needs a **board-size gate**: new
evaluator on 19x19, keep MCTS at 5/7/9/13.

Not urgent — `w0r1d_d43m0n` requires The Red Pill INSTALLED
(`netscriptGoImplementation.ts:359`), so it is unreachable until node exit. Close it before it is
needed, not after.

**Harness gotcha that already cost one wrong baseline:** do NOT pass `Math.random` as `getMove`'s
rngOverride. `WHRNG` computes `v = (seed/1000) % 30000`, which collapses the gate draw — the opponent
then plays no jump moves and never reaches the top branch. Pass a large integer seed. Fixing this
moved the measured baseline from 89.7 to 67.4, matching live.
