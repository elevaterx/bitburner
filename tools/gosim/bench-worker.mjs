// bench-worker.mjs -- worker_threads helper for bench.mjs. Runs an assigned subset of games
// (each with its own derived seed) sequentially inside one worker thread, posting one message
// back per finished game so the main thread can render live progress and aggregate results.
import { parentPort, workerData } from 'node:worker_threads';
import { playGame } from './harness.mjs';

const { botPath, botConfig, opponent, size, maxMoves, jobs } = workerData;

async function makeBot() {
  const mod = await import(botPath);
  if (typeof mod.createBot === 'function') return mod.createBot(botConfig || {});
  if (typeof mod.default === 'function') return mod.default;
  throw new Error(
    `bot module "${botPath}" must export either a default (simpleBoard, valid, ctx) => move function, ` +
    `or a named createBot(config) factory returning one.`
  );
}

for (const { index, seed } of jobs) {
  // Fresh bot instance per game so any internal state (e.g. stats accumulators) never leaks
  // across games -- matches how independent games are actually played.
  const botMove = await makeBot();
  const t0 = Date.now();
  const result = await playGame({ botMove, opponent, size, seed, maxMoves });
  result.wallMs = Date.now() - t0;
  parentPort.postMessage({ index, seed, result });
}
parentPort.postMessage({ done: true });
