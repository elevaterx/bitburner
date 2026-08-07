#!/usr/bin/env node
// bench.mjs -- CLI benchmark runner for an IPvGO bot against bbgo.mjs's real opponent AI.
//
//   node bench.mjs --bot <path> --games 50 [--opponent w0r1d_d43m0n] [--size 19]
//                   [--concurrency 4] [--seed 1] [--json out.json]
//
// Bot module contract (bench.mjs supports BOTH; a module that exports a named `createBot` is
// preferred and gets called once per game with an empty config object so per-bot defaults like
// bots/current.mjs's ITERS=1500/BUDGET=600 apply):
//   - default export: (simpleBoard, valid, ctx) => ({x,y} | null)                [plain function]
//   - named export:   createBot(config) => (simpleBoard, valid, ctx) => ({x,y} | null)   [factory]
//
// Games are independent, so they're parallelised across worker_threads (bench-worker.mjs) --
// real OS threads, not just interleaved promises, because the bot's move search is synchronous
// CPU work (MCTS) that would not benefit at all from async concurrency in a single thread.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { getDifficultyMultiplier, getWinstreakMultiplier } from './bbgo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { games: 50, opponent: 'w0r1d_d43m0n', size: 19, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--bot': out.bot = next(); break;
      case '--games': out.games = Number(next()); break;
      case '--opponent': out.opponent = next(); break;
      case '--size': out.size = Number(next()); break;
      case '--concurrency': out.concurrency = Number(next()); break;
      case '--seed': out.seed = Number(next()); break;
      case '--json': out.json = next(); break;
      case '--maxMoves': out.maxMoves = Number(next()); break;
      case '--quiet': out.quiet = true; break;
      default:
        console.error(`bench.mjs: unrecognized argument "${a}"`);
        process.exit(1);
    }
  }
  if (!out.bot) { console.error('bench.mjs: --bot <path> is required'); process.exit(1); }
  if (!Number.isFinite(out.games) || out.games < 1) { console.error('bench.mjs: --games must be >= 1'); process.exit(1); }
  return out;
}

function wilsonInterval(wins, n, z = 1.959963984540054) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Mirrors bbgo.mjs's endGoGame/resetWinstreak semantics exactly (see harness.mjs / project notes):
 *  nodePower accrues on every COMPLETED game (win OR loss -- losses just use the <0 streak's fixed
 *  0.5 multiplier), keyed off the winStreak value *after* this game's result is folded in, using the
 *  streak *before* the update as getWinstreakMultiplier's `previousWinStreak`. Abandoned games (hit
 *  the move cap without reaching two passes) never call endGoGame in the real game -- they earn ZERO
 *  nodePower -- but do still count as a loss for streak purposes (gameComplete=false: only resets a
 *  currently-non-negative streak to -1; an already-negative streak is left unchanged). */
function simulateNodePower(gamesInOrder, startStreak) {
  let streak = startStreak;
  const nodePowers = [];
  for (const g of gamesInOrder) {
    const boardSize = g.boardSize ?? 19;
    if (g.abandoned) {
      if (streak >= 0) streak = -1;
      nodePowers.push(0);
      continue;
    }
    const oldStreak = streak;
    if (g.won) {
      streak = oldStreak < 0 ? 1 : oldStreak + 1;
    } else {
      streak = oldStreak >= 0 ? -1 : oldStreak - 1;
    }
    const np = g.blackScore * getDifficultyMultiplier(g.komi, boardSize) * getWinstreakMultiplier(streak, oldStreak);
    nodePowers.push(np);
  }
  return nodePowers;
}

function splitRoundRobin(jobs, n) {
  const chunks = Array.from({ length: n }, () => []);
  jobs.forEach((job, i) => chunks[i % n].push(job));
  return chunks.filter((c) => c.length > 0);
}

function runWorkerChunk(chunk, botPath, botConfig, opponent, size, maxMoves, onGame) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'bench-worker.mjs'), {
      workerData: { botPath, botConfig, opponent, size, maxMoves, jobs: chunk },
    });
    worker.on('message', (msg) => {
      if (msg.done) { worker.terminate(); resolve(); return; }
      onGame(msg);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with code ${code}`)); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const botPath = path.isAbsolute(args.bot) ? args.bot : path.resolve(process.cwd(), args.bot);
  if (!fs.existsSync(botPath)) { console.error(`bench.mjs: bot module not found: ${botPath}`); process.exit(1); }
  const botUrl = 'file://' + botPath;

  const jobs = [];
  for (let i = 0; i < args.games; i++) {
    const seed = args.seed !== undefined ? args.seed + i : undefined;
    jobs.push({ index: i, seed });
  }

  const concurrency = Math.max(1, Math.min(args.concurrency, args.games));
  const chunks = splitRoundRobin(jobs, concurrency);

  const results = new Array(args.games);
  let completed = 0;
  const wallStart = Date.now();
  const onGame = (msg) => {
    results[msg.index] = msg.result;
    completed++;
    if (!args.quiet) {
      const r = msg.result;
      const tag = r.abandoned ? 'ABANDONED' : r.won ? 'W' : 'L';
      process.stderr.write(
        `[${completed}/${args.games}] game ${msg.index} seed=${msg.seed ?? '-'} ${tag} ` +
        `black=${r.blackScore} white=${r.whiteScore} moves=${r.moves} illegal=${r.illegal} ` +
        `(${(r.wallMs / 1000).toFixed(1)}s)\n`
      );
    }
  };

  await Promise.all(
    chunks.map((chunk) => runWorkerChunk(chunk, botUrl, {}, args.opponent, args.size, args.maxMoves, onGame))
  );

  const wallMs = Date.now() - wallStart;

  const n = results.length;
  const wins = results.filter((r) => r.won).length;
  const abandoned = results.filter((r) => r.abandoned).length;
  const totalIllegal = results.reduce((a, r) => a + r.illegal, 0);
  const blackScores = results.map((r) => r.blackScore);
  const whiteScores = results.map((r) => r.whiteScore);
  const moveCounts = results.map((r) => r.moves);
  const botMsPerMove = results.flatMap((r) => (r.moves > 0 ? [r.botMs / Math.ceil(r.moves / 2)] : []));

  const [ciLo, ciHi] = wilsonInterval(wins, n);
  const nodePowers = simulateNodePower(results, -36);

  const summary = {
    bot: args.bot,
    opponent: args.opponent,
    size: args.size,
    games: n,
    wins,
    winRate: n ? wins / n : 0,
    winRateCI95: [ciLo, ciHi],
    meanBlackScore: mean(blackScores),
    medianBlackScore: median(blackScores),
    meanWhiteScore: mean(whiteScores),
    meanMoves: mean(moveCounts),
    meanBotMsPerMove: mean(botMsPerMove),
    totalIllegal,
    abandoned,
    meanNodePower: mean(nodePowers),
    wallMs,
  };

  if (!args.quiet) {
    console.log('');
    console.log('=== bench summary ===');
    console.log(`bot:          ${args.bot}`);
    console.log(`opponent:     ${args.opponent}`);
    console.log(`games:        ${summary.games}`);
    console.log(`wins:         ${summary.wins}  (win rate ${(summary.winRate * 100).toFixed(1)}%, 95% CI [${(ciLo * 100).toFixed(1)}%, ${(ciHi * 100).toFixed(1)}%])`);
    console.log(`black score:  mean ${summary.meanBlackScore.toFixed(1)}, median ${summary.medianBlackScore.toFixed(1)}`);
    console.log(`white score:  mean ${summary.meanWhiteScore.toFixed(1)}`);
    console.log(`moves/game:   mean ${summary.meanMoves.toFixed(1)}`);
    console.log(`bot ms/move:  mean ${summary.meanBotMsPerMove.toFixed(1)}`);
    console.log(`illegal:      ${summary.totalIllegal}`);
    console.log(`abandoned:    ${summary.abandoned}`);
    console.log(`nodePower:    mean ${summary.meanNodePower.toFixed(2)} per game (streak simulated from -36)`);
    console.log(`wall clock:   ${(wallMs / 1000).toFixed(1)}s (concurrency ${concurrency})`);
  }

  if (args.json) {
    const outPath = path.isAbsolute(args.json) ? args.json : path.resolve(process.cwd(), args.json);
    fs.writeFileSync(outPath, JSON.stringify({ games: results, summary }, null, 2));
    if (!args.quiet) console.log(`\nwrote ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
