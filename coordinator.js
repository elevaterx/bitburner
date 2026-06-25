/** @param {NS} ns */
export async function main(ns) {
    // VERSION STAMP -- bump on every coord change. Emitted into coord-health.txt by the RUNNING
    // process and surfaced in hud1's snapshot, so you can see what's actually executing in memory
    // (not what's on disk or in the repo). This is the immediate tell for a stale/deferred pull:
    // if the snapshot's coord version lags the version you just pushed, the running process didn't
    // pick up the new code (kill coord -> pull -> reload -> rerun). Format: vMAJOR.MINOR (date).
    const COORD_VERSION = "v2.8 (2026-06-25)";   // + named scenario presets (run coordinator.js income / rebuild / repgrind / digheavy / safe)

    // ================================ ARG REFERENCE (read me) ================================
    //   TWO WAYS TO LAUNCH:
    //
    //   (A) NAMED PRESET (easy) -- recommended for everyday use:
    //         run coordinator.js <preset> [overrides...]
    //       Presets (see PRESETS table just below for exact values):
    //         income     post-install earning mode: xpw OFF, full pool to harvest+digs. The default workhorse.
    //         rebuild    fresh post-install: xpw ON (level up on idle pool while the farm rebuilds).
    //         repgrind   running faction share for rep: leave more harvest headroom, xpw ON.
    //         digheavy   push almost the whole pool into prepping fat servers (fast prep, less harvest headroom).
    //         safe       conservative: lower level ratio (only well-out-leveled targets), xpw OFF.
    //       Override flags can follow a preset to tweak one thing (precedence: preset first, then flags):
    //         xpw / noxpw     force leveling on/off       nobatch         turn batching off
    //         dig=0.9         set dig-budget fraction      targets=25      cap harvest targets
    //       Examples:
    //         run coordinator.js income                 -> the everyday earning launch
    //         run coordinator.js rebuild                -> just installed augs, rebuilding + leveling
    //         run coordinator.js income digheavy        -> earning but prep fat servers harder
    //         run coordinator.js income dig=0.95        -> earning, push 95% of pool into digs
    //         run coordinator.js repgrind noxpw         -> rep share, but no leveling fill
    //         run coordinator.js help                   -> print the preset table and exit
    //
    //   (B) RAW POSITIONAL (full control) -- numbers in fixed positions:
    //         run coordinator.js [numTargets] [levelRatio] [digSlots] [batchMax] [xpw] [digBudget]
    //                               40           0.9          0          7         1       0.85     <- defaults
    //       Args are POSITIONAL: to set a later one, fill the earlier ones. Omit trailing args to keep defaults.
    //         [0] numTargets  max harvest servers. 40 default (filters below trim it).
    //         [1] levelRatio  only target servers whose required level <= this * your level. 0.9 = safe margin.
    //         [2] digSlots    parallel prep slots. 0 = AUTO (sizes from pool).
    //         [3] batchMax    cap on HWGW batchers. 0 = off. Auto-ramps up to this as servers prep.
    //         [4] xpw         leveling fill: 1 = ON (idle pool -> XP), 0 = OFF (idle pool -> income).
    //         [5] digBudget   fraction of pool spent prepping per loop. 0.85 default. Higher = prep faster.
    // =========================================================================================
    //
    // PRESETS: each maps to the six positional args [numTargets, levelRatio, digSlots, batchMax, xpw, digBudget].
    // Edit values here to retune a preset; names are what you type. Adjust freely as scenarios evolve.
    const PRESETS = {
        income:   [40, 0.9,  0, 7, 0, 0.85],   // earning mode, no leveling -- the default workhorse
        rebuild:  [40, 0.9,  0, 7, 1, 0.85],   // post-install: level up on idle pool while rebuilding
        repgrind: [40, 0.9,  0, 7, 1, 0.60],   // faction share for rep: more harvest headroom, leveling on
        digheavy: [40, 0.9,  0, 7, 0, 0.95],   // push almost all pool into prepping fat servers
        safe:     [40, 0.75, 0, 7, 0, 0.85],   // conservative: only well-out-leveled targets
    };
    // Resolve named-preset launches into the positional args[] the rest of the script reads. If args[0]
    // is a number (or absent), this is a no-op and raw positional parsing runs unchanged.
    const resolved = resolveArgs(ns, PRESETS, COORD_VERSION);
    if (resolved === null) return;            // 'help' was requested; table printed, exit.
    const A = resolved;                       // A[0..5] = the six positional args, post-preset-expansion

    const numTargets   = Number(A[0]) || 40;    // [0] max harvest targets. e.g. `...js 25` caps harvest at 25.
                                 // High default is fine: the value-floor + level gates below filter, so a high cap
                                 // just stops artificially starving harvest. Lower it only to deliberately focus fewer servers.
    const levelRatio   = Number(A[1]) || 0.9;   // [1] only harvest servers whose required hacking level is
                                 // <= this * your level. 0.9 leaves a safety margin (you out-level targets, so hacks
                                 // land reliably). e.g. `...js 40 0.75` is more conservative; 1.0 targets right up to your level.
    const BATCH_MAX = A[3] !== undefined ? Number(A[3]) : 7;   // [3] CAP on HWGW batchers (0 = batching
                                 // off). e.g. `...js 40 0.9 0 0` turns batching off; `...js 40 0.9 0 12` allows up to 12.
                                 // The ACTUAL count auto-adjusts each loop: min(BATCH_MAX, number of PREPPED servers
                                 // worth batching, i.e. maxMoney >= BATCH_FLOOR). So a cold start runs at 0 batchers
                                 // on its own and ramps up as fat servers prep -- no manual 0->5 dance on restart.
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
    const DIG_SLOTS_ARG = A[2] !== undefined ? Number(A[2]) : 0;   // [2] parallel dig (prep) slots.
                                 // 0/omitted = AUTO (sizes from the live pool -- recommended). e.g. `...js 40 0.9 5`
                                 // forces exactly 5 parallel digs. Pool-relative selection (below) auto-sizes when 0;
                                 // an explicit value overrides DIG_MAX_SLOTS (the parallel-dig ceiling).
                                 // `run coordinator.js <numTargets> <levelRatio> <digMaxSlots> <batchMax>`.
    // --- POOL-RELATIVE DIG ALLOCATION (replaces the old absolute DIG_PREP_CAP) -----------------
    // The recurring coord-scaling problem: dig logic reasoned in ABSOLUTE thread counts (a 40000-
    // thread cap, "~10k threads per dig"), but what matters is the RATIO of a server's prep cost to
    // the live pool. 40k threads is trivial at a 200k pool (BN1 endgame) and catastrophic at a 2.4k
    // pool (BN4 mid-game) -- same number, opposite meaning -- so the absolute constants broke at
    // every band boundary and got re-patched. These ratio-based knobs self-adjust at any pool size:
    const DIG_POOL_FRAC   = 0.30;   // no single dig may claim more than this fraction of the pool.
                                    // Replaces DIG_PREP_CAP. Scales with pool. Raised 0.20 -> 0.30 once
                                    // xpw (the old idle-soak) was disabled: with few cold servers left,
                                    // 0.20 left the pool idle (3 digs x 20% = 60%, rest idle). 0.30 lets
                                    // idle capacity pour into the remaining fat servers to prep them
                                    // faster. NOTE diminishing returns -- past a point fat servers are
                                    // weaken-CYCLE-limited (wall-clock), not thread-limited; this trades
                                    // some idle pool for faster prep, not perfect utilization. With
                                    // DIG_MIN_SLOTS=3 and budget 0.85, 3x0.30=0.90 > 0.85 so the budget
                                    // shares the 3rd dig's allocation (handled by the min-slot remainder).
    const DIG_BUDGET_FRAC = A[5] !== undefined ? Number(A[5]) : 0.85;
                                    // max fraction of the pool spent on digs in total each loop, now
                                    // CLI-flexible: arg[5] (e.g. `coordinator.js 40 0.9 0 7 0 0.85`).
                                    // The rest is headroom for HARVEST (current income). NOTE: placement
                                    // order (harvest hack -> harvest prep -> dig prep) is the REAL
                                    // protection for income -- harvest always claims its threads before
                                    // digs run. So this fraction only needs to leave a little headroom,
                                    // not half. It was 0.50, which left the pool HALF-IDLE once xpw (the
                                    // old idle-soak) was disabled: harvest wanted only a small slice,
                                    // digs were capped at 50%, and the remaining ~50% earned nothing.
                                    // 0.85 lets digs absorb idle capacity; harvest still gets first claim.
    const DIG_BUDGET_FRAC_COLD = 0.90;  // cold-start budget (harvest empty): no income to protect, so
                                    // prep aggressively to reach first earner fast. Leaves a sliver for
                                    // xpw so leveling still ticks. Reverts to DIG_BUDGET_FRAC once earning.
    const DIG_MIN_SLOTS   = 3;      // always allow at least this many parallel digs even if the budget
                                    // math would allow fewer, so the pipeline never fully stalls.
    const DIG_MAX_SLOTS_DEFAULT = 24;   // hard ceiling on parallel digs (prevents over-fragmentation).
    const ENTER = 0.90, EXIT = 0.60;   // hysteresis: prepped at >=90% money, reverts only below 60%
    const LOOP_MS = 15000;
    const PREP = "prep.js", HACK = "h.js";
    // --- XP farm: fill leftover idle RAM with weaken() for hacking XP. The harvest/dig/batch placements
    //     run their normal course; xpw is a tail filler that takes whatever pool is left and gives it back
    //     when those need to grow. Hacking XP only -- weaken/grow/hack don't train combat stats. Combat
    //     requires gym/crime; with Singularity (SF4, available now) sing.js can automate that separately.
    const XP_ENABLE   = A[4] !== undefined ? (Number(A[4]) !== 0) : true;
                                       // master switch, now CLI-controllable: arg[4]=0 disables xpw.
                                       // run `coordinator.js 40 0.9 0 7 0` -> xpw OFF (frees its pool for
                                       // income; coord actively sweeps existing xpw workers, see below).
                                       // Omit arg[4] (or nonzero) -> xpw ON (default, fills idle pool w/ XP).
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
    ns.tprint("coordinator " + COORD_VERSION + " starting...");

    // --- singleton guard: kill any other copy of this coordinator (newest wins) ---
    const me = ns.getRunningScript();
    for (const p of ns.ps("home")) {
        if (p.filename === me.filename && p.pid !== me.pid) ns.kill(p.pid);
    }

    const preppedSet = new Set();   // persists across loops (hysteresis state)
    let lastKey = "";               // last harvest set logged (for change-only logging, not gating)
    // --- self-diagnostics state (persists across loops) ----------------------------------------
    // No external test harness exists for in-game scripts, so coord checks its own plan-vs-reality
    // invariants each loop and emits findings. Catches the bug classes hit in development: pool
    // consumed by non-coord scripts (harvest can't place), fat servers that never finish prepping
    // (dig black-holes), and planner overruns. Findings go to coord-health.txt (hud1 surfaces them
    // in the snapshot) and HIGH-severity ones toast in real time (debounced).
    const health = {
        digWindowStart: {}, // server -> money% at the start of its current "being worked" window
        digWindowLoops: {}, // server -> consecutive loops worked without resetting the window
        shortfallLoops: 0,  // consecutive loops harvest hack placement fell materially short
        incomePeak: 0,      // decaying recent income peak (for shortfall severity gating)
        lastAlerts: {},     // finding code -> loopNum last toasted (debounce)
    };
    let loopNum = 0;

    while (true) {
        loopNum++;
        try {
            // Formulas.exe gives EXACT grow-thread math (accounts for current security); it's lost on
            // every install, so check each loop and let crewFor/prepCost fall back to growthAnalyze if absent.
            const useFormulas = hasFormulas(ns);
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
            const harvestSet = new Set(harvest);   // O(1) membership for the dig-prep placement pass
            // pool capacity (threads) -- the live worker pool size. Everything dig-related scales off this.
            const workerRam = Math.max(ns.getScriptRam(PREP, "home"), ns.getScriptRam(HACK, "home")) || 1.75;
            let totalCap = 0;
            for (const h of all.concat("home")) {
                if (!ns.hasRootAccess(h) || ns.getServerMaxRam(h) <= 0) continue;
                let cap = ns.getServerMaxRam(h);
                if (h === "home") cap -= HOME_RESERVE;
                totalCap += Math.max(0, Math.floor(cap / workerRam));
            }

            // ---- POOL-RELATIVE DIG SELECTION --------------------------------------------------
            // All thresholds are fractions of the live pool, so the same logic holds whether the
            // pool is 2.4k threads (BN4 mid-game) or 2M (BN1 endgame). Two rules:
            //   (1) per-dig cap     = DIG_POOL_FRAC * pool  -- no one server monopolizes the pool;
            //                         a server simply preps incrementally over need/cap loops
            //   (2) total dig spend <= DIG_BUDGET_FRAC * pool -- digs never starve harvest income
            // Ordering is PRODUCTIVE-FIRST (by score): the efficient mid-tier servers claim budget
            // before low-score fat servers. Fat servers still get dug, just lower priority, and they
            // prep slowly via the per-dig cap. As the pool grows, perDigCap grows and they speed up
            // -- no band-specific logic, no affordability gate (which caused a cheap-server inversion).
            const perDigCap = Math.max(1, Math.floor(totalCap * DIG_POOL_FRAC));
            // Dig budget is ADAPTIVE: the DIG_BUDGET_FRAC cap exists to protect HARVEST income from
            // being starved by digs. At cold start (harvest empty) there is no income to protect, so
            // the cap's justification is absent -- prep harder to reach first income faster. Once any
            // server is earning, fall back to the steady-state split. If arg[5] sets a steady-state
            // frac HIGHER than the cold default, honor it at cold start too (max), so the arg isn't
            // silently lowered when harvest is empty.
            const effBudgetFrac = harvest.length === 0 ? Math.max(DIG_BUDGET_FRAC_COLD, DIG_BUDGET_FRAC) : DIG_BUDGET_FRAC;
            const digBudgetTotal = Math.max(1, Math.floor(totalCap * effBudgetFrac));
            const DIG_MAX_SLOTS = DIG_SLOTS_ARG > 0 ? DIG_SLOTS_ARG : DIG_MAX_SLOTS_DEFAULT;

            // candidate cold servers, each with its (uncapped) prep need and score.
            // Source from rootedMoney (reqLevel <= L) so prep can target fat servers in the 0.9L..L
            // band that the harvest ratio-filter excludes -- prep/grow/weaken aren't level-gated.
            const digCands = rootedMoney
                .filter(t => !preppedSet.has(t) && !batchSetS.has(t))
                .map(t => ({
                    t,
                    need: Math.max(1, Math.ceil(prepCost(ns, t, useFormulas) * PREP_MARGIN)),
                    score: scoreOf[t] || 0,
                    money: ns.getServerMaxMoney(t),
                }));

            // PRODUCTIVE-FIRST ordering: by score descending (the digrank order). A fat server with a
            // high max-money but low per-thread score sorts BELOW an efficient mid-tier server, which
            // is exactly what we want -- mid-tier income first, fat servers as the pool allows.
            // COLD START exception: when nothing is prepped yet (no income at all), order by prep-cost
            // ASCENDING instead -- get *some* server earning in seconds, rather than committing the
            // whole small pool to the highest-score server which may be slow to prep. Once any earner
            // exists, switch to score-order so the pipeline fills with the most valuable targets.
            if (harvest.length === 0) {
                digCands.sort((a, b) => (a.need - b.need) || (a.t < b.t ? -1 : 1));
            } else {
                digCands.sort((a, b) => (b.score - a.score) || (a.t < b.t ? -1 : 1));
            }

            // Admit digs in priority order, each capped at perDigCap, until the dig budget or the
            // slot ceiling is hit. NO affordability gate: with a per-dig cap, every server preps
            // INCREMENTALLY over need/perDigCap loops -- there is no "unaffordable" server, only
            // slow-prepping ones. Score order already prioritizes the productive mid-tier servers;
            // the per-dig cap already stops any one server from monopolizing the pool; the budget
            // already protects harvest income. An earlier affordability gate here caused an inversion
            // (cheap high-score servers deferred while one expensive server dug) and is removed.
            // The DIG_MIN_SLOTS floor guarantees at least that many digs get worked even on a small
            // pool -- but it must NOT bust the budget: a forced min-slot dig gets the REMAINING budget,
            // not the full per-dig cap (else 3 * perDigCap could exceed the budget, the cause of an
            // observed DIG_BUDGET_OVERRUN after perDigCap was raised to 0.20).
            let digList = [];
            const digPlan = {};        // t -> capped prep threads to request this loop
            let digSpend = 0;
            for (const c of digCands) {
                if (digList.length >= DIG_MAX_SLOTS) break;
                const remainingBudget = digBudgetTotal - digSpend;
                if (remainingBudget <= 0) break;                             // budget fully spent
                let capped = Math.min(c.need, perDigCap);                    // per-dig cap (rule 1)
                if (digSpend + capped > digBudgetTotal) {
                    // would exceed budget. If we already have the minimum slots, stop. Otherwise this
                    // is a forced min-slot dig -- give it whatever budget remains (capped at its need).
                    if (digList.length >= DIG_MIN_SLOTS) break;
                    capped = Math.min(capped, remainingBudget);
                }
                digList.push(c.t);
                digPlan[c.t] = capped;
                digSpend += capped;
            }

            // --- desired plan: per-target thread targets (harvest = hack+prep crew; digs = capped prep) ---
            const HACK_CAP = Math.max(1, Math.floor(totalCap * 0.20));   // no single target hogs >20% on hack
            const crews = {};
            for (const t of harvest) crews[t] = crewFor(ns, t, STEAL_FRAC, PREP_MARGIN, HACK_CAP, useFormulas);
            const want = {};        // target -> { hack, prep }  (the steady state we want running)
            // Harvest prep is capped at perDigCap too. Without Formulas.exe, growthAnalyze overcounts
            // grow threads when a server is below max money, so crewFor's prepT can balloon (observed:
            // 1847 threads on a $5.6M server). Uncapped, one harvest server's prep monopolizes the pool
            // and starves digs + other harvest. prep.js weakens-then-grows over cycles, so a bounded
            // maintenance crew still keeps the server prepped -- it just self-corrects over a few loops.
            for (const t of harvest) want[t] = { hack: crews[t].hackT, prep: Math.min(crews[t].prepT, perDigCap) };
            for (const t of digList) {
                if (want[t]) continue;                              // harvest wins if somehow both
                want[t] = { hack: 0, prep: digPlan[t] };            // digs: pool-capped prep, no seed-hack
            }

            // --- what's actually running now, grouped by target + script ---
            const byTarget = {};    // target -> { hack: [{pid,threads}], prep: [{pid,threads}] }
            let shareThreads = 0;   // sh.js worker threads across the fleet (share consumes pool legitimately)
            for (const h of all.concat("home")) {
                for (const p of ns.ps(h)) {
                    if (p.filename === "sh.js") { shareThreads += p.threads; continue; }
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
            // PLACEMENT PRIORITY (pool is consumed in this order):
            //   1. harvest hack  -- current income, highest priority
            //   2. harvest prep  -- maintains current earners (keeps them prepped)
            //   3. dig prep      -- investment in future earners, gets only leftover capacity
            // This ordering is what guarantees digs can't starve harvest: by the time dig prep is
            // placed, harvest's full crew is already claimed. Combined with the dig BUDGET cap, digs
            // are doubly bounded (budget-limited in planning, leftover-limited in placement).
            // placed{Hack,Prep} accumulate what place() ACTUALLY deployed, for the diagnostics below.
            const placedHack = {}, placedPrep = {};
            for (const t of harvest) {
                const r = remain[t] || { hack: 0, prep: 0 };
                if (worth(want[t].hack, r.hack)) placedHack[t] = place(ns, pool, HACK, want[t].hack - r.hack, t);
            }
            for (const t of harvest) {
                const r = remain[t] || { hack: 0, prep: 0 };
                if (worth(want[t].prep, r.prep)) placedPrep[t] = place(ns, pool, PREP, want[t].prep - r.prep, t);
            }
            for (const t of digList) {
                if (harvestSet.has(t)) continue;                    // already handled as harvest above
                const r = remain[t] || { hack: 0, prep: 0 };
                if (worth(want[t].prep, r.prep)) placedPrep[t] = place(ns, pool, PREP, want[t].prep - r.prep, t);
            }

            // --- SELF-DIAGNOSTICS: check plan-vs-reality invariants ------------------------------
            // Each check compares what coord INTENDED against what actually happened. We deliberately
            // do NOT re-derive the plan (that would just reproduce any planning bug); we observe gaps.
            const findings = [];   // { sev: "HIGH"|"WARN"|"INFO", code, msg }

            // (A) PLACEMENT_SHORTFALL -- coord wanted harvest hack threads but couldn't place them.
            // The naive version cried wolf: share (sh.js) legitimately consumes the pool during a rep
            // grind, so a hack shortfall is EXPECTED then, not a bug. But "share explains it" is the
            // wrong discriminator -- in the overnight-leak disaster share WAS the consumer too (it
            // ballooned and starved harvest). The true signal is INCOME: a shortfall while income is
            // healthy is benign (chosen share pressure); a shortfall while income has COLLAPSED is the
            // emergency. So we gate severity on income vs a rolling recent peak coord tracks itself.
            let liveInc = 0;
            try { liveInc = ns.getTotalScriptIncome()[0]; } catch (e) {}
            health.incomePeak = Math.max((health.incomePeak || 0) * 0.97, liveInc);   // decaying peak
            let wantHack = 0, gotHack = 0;
            for (const t of harvest) {
                wantHack += want[t].hack;
                gotHack += (remain[t] ? remain[t].hack : 0) + (placedHack[t] || 0);
            }
            if (wantHack >= 50 && gotHack < 0.5 * wantHack) {
                health.shortfallLoops++;
                if (health.shortfallLoops >= 2) {
                    const missing = wantHack - gotHack;
                    const pct = Math.round(100 * gotHack / wantHack);
                    // income collapsed relative to recent peak? then the shortfall is REAL (harvest is
                    // actually being starved, like the overnight bug). If income is near its peak, the
                    // shortfall is benign -- harvest is earning fine, hack just isn't at its theoretical
                    // max because share+prep+digs share the pool. Healthy = within 50% of recent peak.
                    const incomeHealthy = health.incomePeak > 0 && liveInc >= 0.5 * health.incomePeak;
                    if (incomeHealthy) {
                        findings.push({ sev: "WARN", code: "PLACEMENT_SHORTFALL",
                            msg: "harvest hack " + gotHack + "/" + wantHack + " (" + pct + "%); " + missing +
                                 " unplaced, but income healthy ($" + fmtMoney(liveInc) + "/s). Expected under share (" +
                                 shareThreads + "t) + prep/dig pool pressure -- not a problem." });
                    } else {
                        findings.push({ sev: "HIGH", code: "PLACEMENT_SHORTFALL",
                            msg: "harvest hack " + gotHack + "/" + wantHack + " (" + pct + "%) for " + health.shortfallLoops +
                                 " loops AND income collapsed ($" + fmtMoney(liveInc) + "/s vs peak $" + fmtMoney(health.incomePeak) +
                                 "/s) -- harvest is being starved (share " + shareThreads + "t too big? non-share leak?)." });
                    }
                }
            } else {
                health.shortfallLoops = 0;
            }

            // (B) DIG_BLACKHOLE -- fire ONLY when a server is actually RECEIVING prep threads but its
            // money% is not climbing. Three states, only one is a problem:
            //   - STARVED: getting ~no prep threads (waiting behind harvest+share at a small pool).
            //     This is BENIGN and EXPECTED -- harvest income has priority by design. No warning.
            //   - PROGRESSING: getting threads, money% rising. Healthy. No warning.
            //   - STUCK: getting threads for many loops, money% flat. The real pathology (threads not
            //     converting -- e.g. prep growing against high security, or cap too low to outpace
            //     decay). This is what warrants a warning.
            // Progress is measured CUMULATIVELY over a window (not loop-to-loop) so slow-but-steady
            // prep doesn't false-fire on per-loop rounding. "Being worked" = received >=50% of its
            // requested (capped) prep this loop.
            const digSetNow = new Set(digList);
            for (const t of digList) {
                const maxM = ns.getServerMaxMoney(t) || 1;
                const pct = ns.getServerMoneyAvailable(t) / maxM;
                const placed = (remain[t] ? remain[t].prep : 0) + (placedPrep[t] || 0);
                const requested = digPlan[t] || 0;
                const beingWorked = requested > 0 && placed >= 0.5 * requested;
                if (!beingWorked) {
                    // starved / waiting its turn -- benign, reset its window so it isn't blamed later
                    delete health.digWindowStart[t];
                    delete health.digWindowLoops[t];
                    continue;
                }
                if (health.digWindowStart[t] === undefined) {
                    health.digWindowStart[t] = pct;
                    health.digWindowLoops[t] = 0;
                }
                health.digWindowLoops[t]++;
                if (pct > health.digWindowStart[t] + 0.05) {
                    // >=5 percentage-points cumulative progress -> healthy, reset the window
                    health.digWindowStart[t] = pct;
                    health.digWindowLoops[t] = 0;
                } else if (health.digWindowLoops[t] >= 15) {
                    // worked 15 loops, <5pp progress. Report the REAL signal instead of guessing:
                    //  - security phase: at-min => prep is in GROW mode, grow too slow to move money
                    //    (cap too small for this server's grow need). Elevated => prep is in WEAKEN mode,
                    //    weaken too slow to cut security (cap too small for the weaken need).
                    //  - whether the per-dig cap is the binding constraint: if placed ~= perDigCap, the
                    //    server is getting all the cap allows and still stalling => POOL-LIMITED (will
                    //    self-resolve as the pool grows and perDigCap rises). If placed < perDigCap,
                    //    something else is capping it (contention) -- worth a closer look.
                    const secExcess = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
                    const phase = secExcess > 1 ? ("weaken-limited (sec +" + secExcess.toFixed(1) + ")")
                                                : "grow-limited (sec at min)";
                    const capBound = placed >= 0.9 * perDigCap;
                    const constraint = capBound
                        ? "pool-limited: getting full cap " + perDigCap + "t but it's too small for this server at pool " + totalCap + "t -- clears as pool grows"
                        : "placed " + placed + " < cap " + perDigCap + ": contention is capping it below its allowance -- check pool pressure";
                    findings.push({ sev: "WARN", code: "DIG_BLACKHOLE",
                        msg: t + " stalled " + health.digWindowLoops[t] + " loops at " +
                             (health.digWindowStart[t] * 100).toFixed(0) + "%->" + (pct * 100).toFixed(0) + "% money; " +
                             phase + "; " + constraint });
                }
            }
            // drop state for servers no longer digging or now prepped
            for (const t of Object.keys(health.digWindowLoops)) {
                if (!digSetNow.has(t) || preppedSet.has(t)) {
                    delete health.digWindowLoops[t];
                    delete health.digWindowStart[t];
                }
            }

            // (C) DIG_BUDGET_OVERRUN -- planner self-check: dig prep requested must not exceed the
            // dig budget. Verifies the new pool-relative planner; should never fire if it's correct.
            let digPrepReq = 0;
            for (const t of digList) digPrepReq += digPlan[t] || 0;
            if (digPrepReq > digBudgetTotal * 1.05) {
                findings.push({ sev: "WARN", code: "DIG_BUDGET_OVERRUN",
                    msg: "dig prep requested " + digPrepReq + " exceeds budget " + digBudgetTotal + " -- planner bug" });
            }

            // (D) POOL split (INFO, always) -- how the theoretical capacity is actually used. The
            // 'other' bucket is non-coord consumption (share/sing/hud/etc.); a surprising spike there
            // is the early warning the overnight run lacked.
            const idleNow = pool.reduce((s, r) => s + r.free, 0);
            let coordThreads = 0;
            for (const t of new Set([...harvest, ...digList])) {
                const r = remain[t] || { hack: 0, prep: 0 };
                coordThreads += r.hack + r.prep + (placedHack[t] || 0) + (placedPrep[t] || 0);
            }
            const otherThreads = Math.max(0, totalCap - coordThreads - idleNow);
            findings.push({ sev: "INFO", code: "POOL",
                msg: "cap " + totalCap + "t = coord " + coordThreads + " + idle " + idleNow +
                     " + other " + otherThreads + " (" + Math.round(100 * otherThreads / Math.max(1, totalCap)) + "% non-coord)" });

            // (E) DIG status (INFO) -- how many digs are actively worked vs starved (waiting behind
            // harvest+share for pool). Starved digs are expected at a small pool, NOT a problem; this
            // line makes the benign state visible so it isn't mistaken for a stall.
            let digWorked = 0, digStarved = 0;
            for (const t of digList) {
                const placed = (remain[t] ? remain[t].prep : 0) + (placedPrep[t] || 0);
                const requested = digPlan[t] || 0;
                if (requested > 0 && placed >= 0.5 * requested) digWorked++; else digStarved++;
            }
            findings.push({ sev: "INFO", code: "DIG",
                msg: "digs " + digList.length + ": " + digWorked + " worked, " + digStarved +
                     " waiting for pool (perDig " + perDigCap + ", budget " + digBudgetTotal + ")" });

            // write health file for hud1's snapshot to surface; toast HIGH findings (debounced).
            try {
                ns.write("coord-health.txt", JSON.stringify({ ts: Date.now(), ver: COORD_VERSION, loop: loopNum, L, findings }), "w");
            } catch (e) {}
            for (const f of findings) {
                if (f.sev !== "HIGH") continue;
                const last = health.lastAlerts[f.code];
                if (last === undefined || (loopNum - last) >= 4) {   // re-alert at most every 4 loops
                    ns.toast("coord: " + f.msg, "warning", 6000);
                    ns.tprint("[coord HIGH] " + f.code + ": " + f.msg);
                    health.lastAlerts[f.code] = loopNum;
                }
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
                    + "  dig[" + digList.length + "] " + (digList.map(t => t + "(p" + (digPlan[t] || 0) + ")").join(",") || "(none)")
                    + "  cap " + totalCap + "t (perDig " + perDigCap + " / digBudget " + digBudgetTotal + ")  idle " + idle + "t"
                    + (useFormulas ? "  [Formulas]" : ""));
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
            } else if (!XP_ENABLE) {
                // xpw disabled (arg[4]=0): actively SWEEP all xpw workers fleet-wide so the pool frees
                // THIS loop, instead of waiting for harvest/dig crews to slowly reclaim it. Without this
                // sweep, disabling xpw just stops replenishment and the ~28TB it holds drains only as
                // other crews happen to grow. The sweep makes "xpw off" immediate and clean.
                let swept = 0;
                for (const h of all.concat("home")) {
                    for (const p of ns.ps(h)) {
                        if (p.filename === XP_WORKER) { ns.kill(p.pid); swept += p.threads; }
                    }
                }
                if (swept > 0) ns.print("xpw disabled -- swept " + swept + " xpw threads, pool freed for income");
            }
        } catch (e) {
            ns.print("loop error: " + e);
        }
        await ns.sleep(LOOP_MS);
    }
}

function place(ns, pool, script, threads, target) {
    let remaining = threads, done = 0;
    for (const r of pool) {
        if (remaining <= 0) break;
        if (r.free <= 0) continue;
        const n = Math.min(r.free, remaining);
        const pid = ns.exec(script, r.host, n, target);
        if (pid !== 0) { r.free -= n; remaining -= n; done += n; }
    }
    return done;   // actual threads deployed (may be < requested if the pool ran out)
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
// Accurate grow-thread estimate. ns.growthAnalyze ignores the server's CURRENT security -- it assumes
// min security -- so on a cold server (high sec) it MIS-estimates the real grow need, which is the root
// of the long-standing overcounting (the foodnstuff phantom 1847-thread crew; inflated DIG_BLACKHOLE
// "need" values). Formulas.exe (ns.formulas) computes grow threads from the server's ACTUAL state and
// the player's real multipliers -- exact. But Formulas.exe is LOST every aug install, so coord must
// work without it too: if ns.formulas isn't available, fall back to growthAnalyze. Call hasFormulas()
// once per loop, not per server, to avoid repeated try/catch cost.
// expands named presets + override flags into positional args; handles help; passes raw args through.
// Returns a 6-element array [numTargets, levelRatio, digSlots, batchMax, xpw, digBudget], or null if
// 'help' was requested (caller should exit). args[0] non-numeric => preset mode; numeric/absent => raw.
function resolveArgs(ns, PRESETS, version) {
    const a = ns.args;
    const first = a[0];
    // raw positional mode: no args, or args[0] is a number -> pass straight through unchanged.
    if (first === undefined || !isNaN(Number(first))) return a.slice();

    const key = String(first).toLowerCase();
    if (key === "help" || key === "?") {
        ns.tprint("=== coordinator.js " + version + " presets ===");
        ns.tprint("  run coordinator.js <preset> [overrides]");
        ns.tprint("  presets: " + Object.keys(PRESETS).join(", "));
        for (const [name, v] of Object.entries(PRESETS)) {
            ns.tprint("    " + name.padEnd(9) + " -> targets=" + v[0] + " levelRatio=" + v[1] +
                      " digSlots=" + v[2] + " batchMax=" + v[3] + " xpw=" + v[4] + " digBudget=" + v[5]);
        }
        ns.tprint("  override flags (after a preset): xpw | noxpw | nobatch | dig=<frac> | targets=<n> | level=<r> | batch=<n>");
        ns.tprint("  raw positional still works: run coordinator.js 40 0.9 0 7 0 0.85");
        return null;
    }

    const preset = PRESETS[key];
    if (!preset) {
        ns.tprint("ERROR: unknown preset '" + first + "'. Valid: " + Object.keys(PRESETS).join(", ") +
                  ", or 'help'. Falling back to 'income'.");
        return (PRESETS.income || [40, 0.9, 0, 7, 0, 0.85]).slice();
    }
    const out = preset.slice();   // copy so we don't mutate the table

    // apply override flags (everything after the preset name); precedence: preset first, then flags.
    for (let i = 1; i < a.length; i++) {
        const f = String(a[i]).toLowerCase();
        if (f === "xpw") out[4] = 1;
        else if (f === "noxpw") out[4] = 0;
        else if (f === "nobatch") out[3] = 0;
        else if (f.startsWith("dig=")) { const v = Number(f.slice(4)); if (!isNaN(v)) out[5] = v; }
        else if (f.startsWith("targets=")) { const v = Number(f.slice(8)); if (!isNaN(v)) out[0] = v; }
        else if (f.startsWith("level=")) { const v = Number(f.slice(6)); if (!isNaN(v)) out[1] = v; }
        else if (f.startsWith("batch=")) { const v = Number(f.slice(6)); if (!isNaN(v)) out[3] = v; }
        else ns.tprint("WARN: ignoring unknown flag '" + a[i] + "'");
    }
    ns.tprint("coordinator: preset '" + key + "' -> [" + out.join(", ") + "]");
    return out;
}

function hasFormulas(ns) {
    try { ns.formulas.hacking.growThreads; return ns.fileExists("Formulas.exe", "home"); }
    catch (e) { return false; }
}
// grow threads to take a server from its CURRENT money to max (or by a multiplier if curMoney given).
function growThreadsFor(ns, t, useFormulas, targetMultIfNoState) {
    if (useFormulas) {
        try {
            const so = ns.getServer(t);
            const po = ns.getPlayer();
            // grow from current money up to max, at current security -- the accurate figure.
            const need = ns.formulas.hacking.growThreads(so, po, ns.getServerMaxMoney(t));
            if (isFinite(need) && need >= 0) return Math.ceil(need);
        } catch (e) { /* fall through to analyze */ }
    }
    // fallback: growthAnalyze with the requested multiplier (min-security assumption -- approximate).
    return Math.ceil(ns.growthAnalyze(t, targetMultIfNoState));
}

function crewFor(ns, t, STEAL_FRAC, PREP_MARGIN, HACK_CAP, useFormulas) {
    const perHack = ns.hackAnalyze(t);                       // fraction stolen per hack thread
    let hackT = perHack > 0 ? Math.max(1, Math.floor(STEAL_FRAC / perHack)) : 1;
    if (hackT > HACK_CAP) hackT = HACK_CAP;
    const growMult = 1 / (1 - STEAL_FRAC);                   // regrow what the skim removes
    // For a prepped harvest server, growthAnalyze(growMult) at min sec is correct, so Formulas adds
    // little here -- but use it when available for exactness (handles partial-money edge states).
    const growT = Math.max(1, growThreadsFor(ns, t, useFormulas, growMult));
    const wpt = ns.weakenAnalyze(1) || 0.05;                 // security removed per weaken thread
    const secAdd = ns.hackAnalyzeSecurity(hackT, t) + ns.growthAnalyzeSecurity(growT, t);
    const weakenT = Math.max(1, Math.ceil(secAdd / wpt));
    const prepT = Math.ceil((growT + weakenT) * PREP_MARGIN);
    return { hackT, prepT };
}

// Rough threads-to-prep estimate for picking the fastest bootstrap target:
// grow threads to refill from current money + weaken threads for current security excess.
// Lower = closer to prepped / cheaper to bring online. With Formulas.exe this is EXACT (accounts for
// the server's real security); without it, growthAnalyze under/over-counts on cold servers.
function prepCost(ns, t, useFormulas) {
    const max = ns.getServerMaxMoney(t);
    const cur = Math.max(ns.getServerMoneyAvailable(t), 1);
    let growT;
    if (useFormulas) {
        try {
            const so = ns.getServer(t), po = ns.getPlayer();
            growT = ns.formulas.hacking.growThreads(so, po, max);
            if (!isFinite(growT) || growT < 0) growT = 0;
        } catch (e) { useFormulas = false; }
    }
    if (!useFormulas) {
        const mult = Math.min(max / cur, 1e6);              // cap to avoid Infinity on near-empty servers
        growT = mult > 1 ? ns.growthAnalyze(t, mult) : 0;
    }
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

// compact money formatter for diagnostic messages
function fmtMoney(n) {
    if (!isFinite(n)) return "--";
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n / 1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n / 1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n / 1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
