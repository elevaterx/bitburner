/** @param {NS} ns */
export async function main(ns) {
    const numTargets   = Number(ns.args[0]) || 40;    // max harvest targets (high default; the value-floor + level
                                 // gates below filter, so a high cap just stops artificially starving harvest)
    const levelRatio   = Number(ns.args[1]) || 0.9;   // target required-level <= ratio * your level (0.9 leaves a
    const BATCH_MAX = ns.args[3] !== undefined ? Number(ns.args[3]) : 7;   // CAP on batchers (0 = batching off).
                                 // The ACTUAL count auto-adjusts each loop: min(BATCH_MAX, number of PREPPED servers
                                 // worth batching, i.e. maxMoney >= BATCH_FLOOR). So a cold start runs at 0 batchers
                                 // on its own and ramps up as fat servers prep -- no manual 0->5 dance on restart.
                                 // 4th CLI arg is now this cap: `run coordinator.js <numTargets> <levelRatio> <digTargets> <batchMax>`.
    const BATCH_FLOOR = 1e9;     // a server must be at least this fat ($1b maxMoney) to deserve a batcher slot;
                                 // below it, it stays in prep-and-hold harvest. Keeps batchers off starter servers.
                                 // LOWERED from $10b for BN4: server money is cut ~75-80%, so the fattest servers
                                 // top out around $4b here (global-pharm). $10b stranded every server below the
                                 // floor -> 0 batchers permanently. $1b captures the top ~13-server fat cluster.
    const BATCH_FRAC = 0.05, BATCH_GAP = 200, BATCH_PERIOD_MULT = 6;    // density tuning. 16 was the safe default;
                                 // 6 was confirmed empirically as the timing-density sweet spot for a 7-hour AFK run
                                 // last session. Reset wiped that tuning (file reverted to 16); restored here.
                                 // HOME_RESERVE is computed per-loop below from the live batcher count (auto-sized).
    const STEAL_FRAC   = 0.25;   // fraction of a target's money each hack pass skims; one knob for every server
    const PREP_MARGIN  = 1.5;    // prep threads over the bare grow+weaken need, for reactive-timing slack
    const VALUE_FLOOR  = 0.02;   // skip harvesting any target worth < this fraction of your richest one
    const STICKY_EXTRA = 3;      // keep up to numTargets + this many prepped earners harvesting during a handoff
    const DIG_TARGETS_ARG = ns.args[2] !== undefined ? Number(ns.args[2]) : 0;   // 0/omitted = AUTO: digCount scales
                                 // with the pool (computed in-loop), so prep parallelism grows as the rebuild does.
                                 // PREP THROUGHPUT: how many cold servers prep in parallel. Pass an explicit 3rd arg
                                 // to override the auto value with a fixed count.
    const DIG_PREP_CAP = 40000;  // flat ceiling on prep threads per dig target. A server's prep need is set by
                                 // its OWN economics, not the pool size -- 4% of a 270k pool was still 11k, far
                                 // more than any BN1 server needs at min security. growthAnalyze (no Formulas)
                                 // over-counts grow threads at high security, so prepCost balloons on a cold
                                 // target; this bounds it. prep.js weakens-then-grows over a few cycles, so a
                                 // bounded crew preps fully anyway. Raise if big servers prep slowly; lower to cut idle.
    const ENTER = 0.90, EXIT = 0.60;   // hysteresis: prepped at >=90% money, reverts only below 60%
    const LOOP_MS = 15000;
    const PREP = "prep.js", HACK = "h.js";
    // --- XP farm: fill leftover idle RAM with weaken() for hacking XP. The harvest/dig/batch placements
    //     run their normal course; xpw is a tail filler that takes whatever pool is left and gives it back
    //     when those need to grow. Hacking XP only -- weaken/grow/hack don't train combat stats. Combat
    //     requires gym/crime, which without Singularity (SF4) is a manual UI activity in BN1.
    const XP_ENABLE   = true;          // master switch. false disables fill and lets existing xpw workers die off
    const XP_TARGET   = "joesguns";    // weaken target. low base sec -> fast cycles -> more XP/sec per thread.
                                       // any rooted low-level server works; joesguns is the traditional pick.
    const XP_WORKER   = "xpw.js";      // worker script -- MUST be added to pull.js or it won't deploy after pull
    const XP_DEADBAND = 0.15;          // (legacy; no longer used after the immediate-shrink fix below.
                                       // Kept as a const to preserve the existing tuning surface in case
                                       // a future iteration wants it back on the grow path.)
    const XP_SLACK    = 4;             // threads of headroom left truly free on every host. ALSO controls the
                                       // grow-side deadband: xpw only grows when wantXpwT exceeds curXpwT by
                                       // more than XP_SLACK threads, so small per-loop jitter doesn't churn.
    ns.disableLog("ALL");

    // --- singleton guard: kill any other copy of this coordinator (newest wins) ---
    const me = ns.getRunningScript();
    for (const p of ns.ps("home")) {
        if (p.filename === me.filename && p.pid !== me.pid) ns.kill(p.pid);
    }

    const preppedSet = new Set();   // persists across loops (hysteresis state)
    let lastKey = "";               // last harvest set logged (for change-only logging, not gating)

    while (true) {
        try {
            // --- scan ---
            const seen = new Set(["home"]), queue = ["home"], all = [];
            while (queue.length) {
                const cur = queue.shift();
                if (cur !== "home") all.push(cur);
                for (const n of ns.scan(cur)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
            }
            // --- root ---
            const openers = ["BruteSSH.exe","FTPCrack.exe","relaySMTP.exe","HTTPWorm.exe","SQLInject.exe"];
            const have = openers.filter(f => ns.fileExists(f, "home")).length;
            for (const h of all) {
                if (ns.hasRootAccess(h)) continue;
                if (ns.fileExists("BruteSSH.exe","home")) ns.brutessh(h);
                if (ns.fileExists("FTPCrack.exe","home")) ns.ftpcrack(h);
                if (ns.fileExists("relaySMTP.exe","home")) ns.relaysmtp(h);
                if (ns.fileExists("HTTPWorm.exe","home")) ns.httpworm(h);
                if (ns.fileExists("SQLInject.exe","home")) ns.sqlinject(h);
                if (ns.getServerNumPortsRequired(h) <= have) ns.nuke(h);
            }
            // --- pick candidates (level-filtered, ranked by yield-efficiency) ---
            const L = ns.getHackingLevel();
            const maxReq = L * levelRatio;
            // servers I can currently hack at all: rooted, has money, reqLevel <= my level
            const rootedMoney = all.filter(h => ns.hasRootAccess(h) && ns.getServerMaxMoney(h) > 0
                                              && ns.getServerRequiredHackingLevel(h) <= L);
            // Efficiency score per candidate, computed ONCE (quantized + hostname tiebreak so the
            // ordering is a deterministic function of state -- this is what keeps focus/key stable).
            // Used for SORT ONLY, never for filtering: the eligibility filter + zero-target fallback
            // below stay reqLevel-based, so the L1 cold-start deadlock cannot return.
            const scoreOf = {};
            for (const h of rootedMoney) scoreOf[h] = scoreServer(ns, h);
            const byScore = (a, b) => {
                const d = (scoreOf[b] || 0) - (scoreOf[a] || 0);
                return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);   // tiebreak: hostname asc
            };
            // normal selection uses the ratio filter (skip near-level targets with poor odds);
            // but if that strands us with ZERO targets -- the cold-start deadlock, e.g. n00dles
            // needs L1 while ratio*L < 1 at level 1 -- fall back to every hackable server so the
            // coordinator can never sit idle with no targets and no way to level out of it.
            let eligible = rootedMoney.filter(h => ns.getServerRequiredHackingLevel(h) <= maxReq);
            if (eligible.length === 0) eligible = rootedMoney;
            eligible.sort(byScore);
            const top = eligible.slice(0, numTargets);

            // --- classify with hysteresis: ANY eligible server that's fully prepped can be
            // promoted to the harvest set (not just the top-N). The cold start preps the cheapest
            // server (n00dles) first; restricting promotion to top-N stranded it there forever,
            // since n00dles is never among the richest. The harvest set is value-floored and
            // sliced below, so poor servers drop off on their own once richer ones come online. ---
            const watch = new Set(eligible);
            for (const t of preppedSet) watch.add(t);
            for (const t of watch) {
                if (!ns.hasRootAccess(t) || ns.getServerMaxMoney(t) <= 0) { preppedSet.delete(t); continue; }
                const m = ns.getServerMoneyAvailable(t) / ns.getServerMaxMoney(t);
                const s = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
                if (!preppedSet.has(t)) { if (m >= ENTER && s <= 2) preppedSet.add(t); }
                else { if (m < EXIT) preppedSet.delete(t); }
            }

            // harvest = currently-prepped servers, sticky even if bumped out of top-N;
            // ordered by efficiency (crew placement loads the best $/RAM-sec targets first),
            // but ADMISSION stays on static max-money: the value floor is relative to the richest
            // earner (explicit max, not harvest[0]), so a server can't flip in/out of the set as
            // its score drifts -- that drift is exactly what would thrash the rebalance key.
            // batch handoff: the fattest prepped servers (up to BATCH_MAX) by MAX MONEY (fattest) go to their own
            // bbatch2 controllers and are removed from prep-and-hold here. Ranked by value, NOT byScore:
            // byScore is per-thread efficiency (favors low-level servers), but a batcher skims a fixed % of
            // max money per batch, so batch income scales with the server's TOTAL value -- pick the fattest.
            const ranked = [...preppedSet].sort(byScore);
            // auto batch count: the fattest PREPPED servers above BATCH_FLOOR, capped at BATCH_MAX. Cold start has
            // nothing above the floor -> 0 batchers; as megacorps prep they cross the floor and slots fill on their own.
            const fatPrepped = [...preppedSet]
                .filter(t => ns.getServerMaxMoney(t) >= BATCH_FLOOR)
                .sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a));
            const batchSet = BATCH_MAX > 0 ? fatPrepped.slice(0, BATCH_MAX) : [];
            const batchSetS = new Set(batchSet);
            // Reserve 25% of home RAM (minimum 40 GB) for non-coord scripts, plus 14 GB per batcher.
            // The percentage scales automatically as home grows; the floor protects against tiny-home
            // edge cases. Coord won't claim this space for workers; sing/hud/etc. can still use it.
            const HOME_MAX = ns.getServerMaxRam("home");
            const HOME_RESERVE = Math.max(40, Math.floor(HOME_MAX * 0.25)) + 14 * batchSet.length;
            let harvest = ranked.filter(t => !batchSetS.has(t));
            const bestMoney = harvest.length ? Math.max(...harvest.map(t => ns.getServerMaxMoney(t))) : 0;
            harvest = harvest.filter(t => ns.getServerMaxMoney(t) >= VALUE_FLOOR * bestMoney)
                             .slice(0, numTargets + STICKY_EXTRA);
            // pool capacity (threads) -- computed here so digCount can scale prep parallelism to the live pool.
            const workerRam = Math.max(ns.getScriptRam(PREP, "home"), ns.getScriptRam(HACK, "home")) || 1.75;
            let totalCap = 0;
            for (const h of all.concat("home")) {
                if (!ns.hasRootAccess(h) || ns.getServerMaxRam(h) <= 0) continue;
                let cap = ns.getServerMaxRam(h);
                if (h === "home") cap -= HOME_RESERVE;
                totalCap += Math.max(0, Math.floor(cap / workerRam));
            }
            // auto dig parallelism: scale with the pool, clamped [6,20]. Bigger pool -> prep more cold servers at
            // once -> faster rebuild. ~10k threads budgeted per dig (covers a megacorp's cold need). Arg overrides.
            const digCount = DIG_TARGETS_ARG > 0 ? DIG_TARGETS_ARG : Math.max(6, Math.min(20, Math.floor(totalCap / 10000)));
            // dig list: the cold servers we actively prep THIS cycle, in parallel, each capped to its
            // own need (pass 3 below). Capping + parallelism replaces "pour the whole pool into one
            // focus" -- at a 100k+ thread pool that wasted nearly all of it on a server needing a few hundred.
            //  - no earners yet: bootstrap the FASTEST-to-prep servers first (income in seconds)
            //  - once earning: dig the highest-POTENTIAL unprepped top-N targets (big servers now included)
            let digList;
            if (harvest.length === 0) {
                digList = eligible.filter(t => !preppedSet.has(t))
                    .sort((a, b) => prepCost(ns, a) - prepCost(ns, b))
                    .slice(0, digCount);
            } else {
                // byScore-ranked digs (favors small efficient servers -- fast income rebuild)
                const scoreDigs = top.filter(t => !preppedSet.has(t));
                // FAT-PREP RESERVATION: byScore starves the fat $1b+ servers (high req level = poor
                // per-thread efficiency), so they never prep and never become batch-eligible -- batchers
                // stay at 0 forever. Reserve up to BATCH_MAX dig slots for the fattest unprepped servers
                // above BATCH_FLOOR, ranked by MAX MONEY, so the future batch targets actually get prepped.
                // These interleave with the byScore digs rather than replacing them.
                // SOURCED FROM rootedMoney (reqLevel <= L), NOT eligible (reqLevel <= 0.9*L): the ratio
                // filter excludes fat servers in the 0.9L..L band (e.g. at L199 it cuts everything needing
                // 180-199), which is exactly the fat cluster we need to prep. Prep (grow/weaken) works at
                // any level; only hacking is level-gated, and rootedMoney already excludes servers above L.
                const fatUnprepped = BATCH_MAX > 0
                    ? rootedMoney.filter(t => !preppedSet.has(t) && ns.getServerMaxMoney(t) >= BATCH_FLOOR)
                              .sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a))
                              .slice(0, BATCH_MAX)
                    : [];
                // merge: fat servers first (priority prep), then byScore digs, dedup, cap at digCount.
                // Fat-first ensures the batch pipeline fills even when digCount is small.
                const merged = [];
                const seen = new Set();
                for (const t of fatUnprepped) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
                for (const t of scoreDigs)    { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
                digList = merged.slice(0, digCount);
            }

            // --- desired plan: per-target thread targets (harvest = hack+prep crew; digs = capped prep) ---
            // (workerRam + totalCap computed above for digCount; reused here for the hack cap)
            const HACK_CAP = Math.max(1, Math.floor(totalCap * 0.20));   // no single target hogs >20% on hack
            const crews = {};
            for (const t of harvest) crews[t] = crewFor(ns, t, STEAL_FRAC, PREP_MARGIN, HACK_CAP);
            const want = {};        // target -> { hack, prep }  (the steady state we want running)
            for (const t of harvest) want[t] = { hack: crews[t].hackT, prep: crews[t].prepT };
            for (const t of digList) {
                if (want[t]) continue;                              // harvest wins if somehow both
                const raw = Math.max(1, Math.ceil(prepCost(ns, t) * PREP_MARGIN));
                want[t] = { hack: 0, prep: Math.min(raw, DIG_PREP_CAP) };   // digs: capped prep, no seed-hack
            }

            // --- what's actually running now, grouped by target + script ---
            const byTarget = {};    // target -> { hack: [{pid,threads}], prep: [{pid,threads}] }
            for (const h of all.concat("home")) {
                for (const p of ns.ps(h)) {
                    if (p.filename !== PREP && p.filename !== HACK) continue;
                    const tgt = p.args[0];
                    if (!tgt) continue;
                    if (!byTarget[tgt]) byTarget[tgt] = { hack: [], prep: [] };
                    (p.filename === HACK ? byTarget[tgt].hack : byTarget[tgt].prep).push({ pid: p.pid, threads: p.threads });
                }
            }

            // --- RECONCILE: kill only the excess, start only the deficit; leave correct workers running.
            // This replaces the old kill-everything-and-redeploy rebalance, which tore down every hack crew
            // each loop and (with many parallel digs finishing at staggered times) pinned income at $0. Now a
            // harvest server's crew is touched ONLY when its own plan changes; the dig-list reshuffle that used
            // to trigger a full teardown now adjusts just the one or two servers that actually changed. ---
            const remain = {};      // target -> { hack, prep } surviving the kill pass
            const targets = new Set([...Object.keys(byTarget), ...Object.keys(want)]);
            for (const t of targets) {
                const w = want[t] || { hack: 0, prep: 0 };
                const cur = byTarget[t] || { hack: [], prep: [] };
                remain[t] = { hack: killExcess(ns, cur.hack, w.hack), prep: killExcess(ns, cur.prep, w.prep) };
            }
            await ns.sleep(50);     // let killed RAM free before recomputing the pool

            // build the free-RAM pool (idle capacity now); scp workers to any host missing them
            const pool = [];
            for (const h of all.concat("home")) {
                if (!ns.hasRootAccess(h) || ns.getServerMaxRam(h) <= 0) continue;
                if (!ns.fileExists(PREP, h) || !ns.fileExists(HACK, h)) ns.scp([PREP, HACK], h, "home");
                let avail = ns.getServerMaxRam(h) - ns.getServerUsedRam(h);
                if (h === "home") avail -= HOME_RESERVE;
                const free = Math.floor(avail / workerRam);
                if (free > 0) pool.push({ host: h, free });
            }
            // Prefer CLOUD over home: place workers on cloud first, fall back to home only as overflow.
            // place() consumes the pool in order, so sorting home to the end means prep/hack workers land
            // on home only when all cloud capacity is full. This keeps home's non-reserved space genuinely
            // free for the bbatch2 controllers (which are home-pinned at exec time) rather than clogged with
            // a big prep.js crew. Within cloud, still fill biggest-free-first to minimize fragmentation.
            pool.sort((a, b) => {
                if (a.host === "home" && b.host !== "home") return 1;    // home sinks to the bottom
                if (b.host === "home" && a.host !== "home") return -1;
                return b.free - a.free;                                  // otherwise biggest-free-first
            });

            // start deficits: hack first (income), then prep (harvest maintenance + digs). A deadband skips
            // sub-10% gaps so small crew-size drift between loops doesn't cause constant kill/restart churn.
            // BUT: the deadband must NOT block initial placement. If have=0 and want>0, always place --
            // otherwise small crews (1-2 threads) never get placed because want < deadband floor. This
            // bit BN4 hard: at high level on small reachable servers, crewFor often computes hackT=1-2,
            // and the deadband prevented harvest from ever firing on those servers.
            const worth = (w, have) => {
                if (have === 0 && w > 0) return true;
                return (w - have) > Math.max(3, Math.ceil(w * 0.10));
            };
            for (const t of harvest) {
                const r = remain[t] || { hack: 0, prep: 0 };
                if (worth(want[t].hack, r.hack)) place(ns, pool, HACK, want[t].hack - r.hack, t);
            }
            for (const t of Object.keys(want)) {
                const r = remain[t] || { hack: 0, prep: 0 };
                if (worth(want[t].prep, r.prep)) place(ns, pool, PREP, want[t].prep - r.prep, t);
            }

            // --- batch controllers: ensure one bbatch2 per batch target; drop stale ones. The reconcile
            // pass above already cleared any prep/hold workers from servers that just entered batchSet, so
            // the batcher takes over a clean server. bbatch2 self-preps and self-corrects from here. ---
            if (BATCH_MAX > 0) {
                const runningBatchers = new Map();   // target -> pid
                for (const p of ns.ps("home")) if (p.filename === "bbatch2.js" && p.args[0]) runningBatchers.set(p.args[0], p.pid);
                for (const t of batchSet) {
                    if (!runningBatchers.has(t)) ns.exec("bbatch2.js", "home", 1, t, BATCH_FRAC, BATCH_GAP, BATCH_PERIOD_MULT);
                }
                for (const [t, pid] of runningBatchers) if (!batchSetS.has(t)) ns.kill(pid);
            }

            // log only when the HARVEST set changes (meaningful events); the dig-list reshuffle no longer
            // tears anything down, so it isn't worth a line every loop
            const hkey = [...harvest].sort().join(",") + "|B:" + [...batchSet].sort().join(",");
            if (hkey !== lastKey) {
                lastKey = hkey;
                const idle = pool.reduce((s, r) => s + r.free, 0);
                const crewStr = harvest.map(t => t + "(h" + want[t].hack + "/p" + want[t].prep + ")").join(" ");
                ns.tprint("coordinator @L" + L + ": harvest " + (crewStr || "(none)")
                    + (batchSet.length ? "  batch[" + batchSet.length + "] " + batchSet.join(",") : "")
                    + "  dig[" + digList.length + "] " + (digList.join(",") || "(none)")
                    + "  cap " + totalCap + "t  idle " + idle + "t");
            }

            // --- PHASE 2: XP fill. Run AFTER harvest/dig/batch placement so it consumes only true leftovers.
            // For each rooted host: sum xpw threads (curXpwT) and infer non-xpw used RAM. Compute the xpw
            // capacity that fits in (maxRam - nonXpwUsed - reserve - slack). Grow with one exec when below
            // target by more than the slack; shrink (smallest workers first) only when above target by the
            // deadband (15%). The deadband is what stops every tiny per-loop crew drift from churning xpw.
            // If XP_ENABLE is flipped off mid-run, this branch goes idle and the existing xpw workers stay
            // up until reconcile pressure pushes them out via the shrink path being unreachable -- to kill
            // them off immediately, set XP_TARGET to an unreachable name and they'll be killed as off-target.
            if (XP_ENABLE && ns.hasRootAccess(XP_TARGET)) {
                const xpRam = ns.getScriptRam(XP_WORKER, "home") || 1.75;
                for (const h of all.concat("home")) {
                    if (!ns.hasRootAccess(h) || ns.getServerMaxRam(h) <= 0) continue;
                    if (!ns.fileExists(XP_WORKER, h)) ns.scp([XP_WORKER], h, "home");
                    // kill any xpw still pointing at a stale target (so re-targeting takes effect next loop)
                    for (const p of ns.ps(h)) {
                        if (p.filename === XP_WORKER && p.args[0] !== XP_TARGET) ns.kill(p.pid);
                    }
                    const xpwProcs = ns.ps(h).filter(p => p.filename === XP_WORKER && p.args[0] === XP_TARGET);
                    const curXpwT = xpwProcs.reduce((s, p) => s + p.threads, 0);
                    const curXpwRam = curXpwT * xpRam;
                    // non-xpw used RAM == everything harvest/dig/batch is using on this host right now
                    const nonXpwUsed = ns.getServerUsedRam(h) - curXpwRam;
                    const reserve = (h === "home" ? HOME_RESERVE : 0) + XP_SLACK * workerRam;
                    const wantXpwRam = Math.max(0, ns.getServerMaxRam(h) - nonXpwUsed - reserve);
                    const wantXpwT = Math.floor(wantXpwRam / xpRam);
                    if (wantXpwT > curXpwT + XP_SLACK) {
                        ns.exec(XP_WORKER, h, wantXpwT - curXpwT, XP_TARGET);
                    } else if (curXpwT > wantXpwT) {
                        // shrink to want immediately -- no deadband. The XP_DEADBAND constant existed to
                        // shield against own-jitter (small per-loop variation in own thread count). It does
                        // NOT belong on the cross-script case: when sharecap or a batcher expands and drives
                        // wantXpwT down, that's a real signal and xpw must yield NOW, not 15% later. Holding
                        // back here is what was starving sharecap (single-digit growth per loop) and forcing
                        // bbatch2 fires to skip on RAM. Kill smallest workers first to minimize overshoot.
                        xpwProcs.sort((a, b) => a.threads - b.threads);
                        let cur = curXpwT;
                        for (const p of xpwProcs) {
                            if (cur <= wantXpwT) break;
                            ns.kill(p.pid);
                            cur -= p.threads;
                        }
                    }
                }
            }
        } catch (e) {
            ns.print("loop error: " + e);
        }
        await ns.sleep(LOOP_MS);
    }
}

function place(ns, pool, script, threads, target) {
    let remaining = threads;
    for (const r of pool) {
        if (remaining <= 0) break;
        if (r.free <= 0) continue;
        const n = Math.min(r.free, remaining);
        const pid = ns.exec(script, r.host, n, target);
        if (pid !== 0) { r.free -= n; remaining -= n; }
    }
}

// Kill whole worker processes for one (target, script) until the running thread count is at/under
// `desired`. Smallest-first, so we overshoot as little as possible. A 15% overage is left alone
// (deadband) so tiny crew-size drift between loops doesn't cause constant kill/restart churn.
// Returns the thread count still running afterward.
function killExcess(ns, procs, desired) {
    let cur = 0;
    for (const p of procs) cur += p.threads;
    if (cur <= Math.ceil(desired * 1.15)) return cur;     // within tolerance (or desired 0 & cur 0)
    procs.sort((a, b) => a.threads - b.threads);
    for (const p of procs) {
        if (cur <= desired) break;
        ns.kill(p.pid);
        cur -= p.threads;
    }
    return cur;
}

// Size a harvest crew for one target from its own hack/grow economics.
function crewFor(ns, t, STEAL_FRAC, PREP_MARGIN, HACK_CAP) {
    const perHack = ns.hackAnalyze(t);                       // fraction stolen per hack thread
    let hackT = perHack > 0 ? Math.max(1, Math.floor(STEAL_FRAC / perHack)) : 1;
    if (hackT > HACK_CAP) hackT = HACK_CAP;
    const growMult = 1 / (1 - STEAL_FRAC);                   // regrow what the skim removes
    const growT = Math.max(1, Math.ceil(ns.growthAnalyze(t, growMult)));
    const wpt = ns.weakenAnalyze(1) || 0.05;                 // security removed per weaken thread
    const secAdd = ns.hackAnalyzeSecurity(hackT, t) + ns.growthAnalyzeSecurity(growT, t);
    const weakenT = Math.max(1, Math.ceil(secAdd / wpt));
    const prepT = Math.ceil((growT + weakenT) * PREP_MARGIN);
    return { hackT, prepT };
}

// Rough threads-to-prep estimate for picking the fastest bootstrap target:
// grow threads to refill from current money + weaken threads for current security excess.
// Lower = closer to prepped / cheaper to bring online.
function prepCost(ns, t) {
    const max = ns.getServerMaxMoney(t);
    const cur = Math.max(ns.getServerMoneyAvailable(t), 1);
    const mult = Math.min(max / cur, 1e6);                  // cap to avoid Infinity on near-empty servers
    const growT = mult > 1 ? ns.growthAnalyze(t, mult) : 0;
    const secExcess = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
    const weakenT = secExcess / (ns.weakenAnalyze(1) || 0.05);
    return growT + weakenT;
}

// --- yield-efficiency score (relative target ranking) ---------------------------------------
// effScore is PURE (Node-testable): the expected income rate per hack thread a server would have
// once PREPPED (at min security / max money), computed analytically from static values + level.
// Scoring potential -- not current state -- is deliberate: a big server sitting COLD (high sec,
// low money) reads as terrible on the live hack functions, which made focus avoid the very
// servers it should dig. Potential scoring ranks them by what they're worth once prepped.
// Quantized to 3 sig figs so small per-loop drift can't reorder targets and thrash focus/key.
function effScore(maxMoney, reqLevel, minSec, level) {
    if (!(maxMoney > 0) || !(level > 0)) return 0;
    const diffMult = Math.max(0, (100 - minSec) / 100);                 // 0 at sec 100
    const pct    = Math.max(0, (level - (reqLevel - 1)) / level) * diffMult / 240;   // frac/thread at min sec
    const chance = Math.max(0, Math.min(1, (1.75 * level - reqLevel) / (1.75 * level))) * diffMult;
    const timeProxy = (2.5 * reqLevel * minSec + 500) / (level + 50);   // ~hackTime at min sec (×5 const drops out)
    if (!(pct > 0) || !(chance > 0) || !(timeProxy > 0)) return 0;
    return quantize((maxMoney * pct * chance) / timeProxy);
}
function quantize(x) {
    if (!(x > 0) || !isFinite(x)) return 0;
    return Number(x.toPrecision(3));
}
// live wrapper: STATIC reads only (maxMoney, reqLevel, minSec) + current level. No current-security
// reads, no Formulas.exe (lost every install). Same score whether the server is cold or prepped,
// so focus picks the highest-potential cold target to dig instead of fleeing it.
function scoreServer(ns, t) {
    return effScore(ns.getServerMaxMoney(t), ns.getServerRequiredHackingLevel(t),
                    ns.getServerMinSecurityLevel(t), ns.getHackingLevel());
}
