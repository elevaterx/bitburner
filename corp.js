/** corp.js -- capability-gated Corporation manager (BN3, or SF-3 elsewhere).
 *  v1: Agriculture material money engine. v2: adds a Tobacco PRODUCT division with a
 *  make -> churn-weakest lifecycle, research (Lab + Market-TA.I/II), and market-price selling.
 *
 *  Self-gates: exits if the Corporation API is unavailable. Idempotent "ensure" steps run each corp
 *  state tick (order-independent, safe to re-run). Smart Supply auto-buys inputs, so there's no risky
 *  manual material micro. Tobacco opens automatically once Agriculture has funded its industry cost.
 *
 *  Decisions live in lib/corp-logic.js (pure, unit-tested). This is the thin ns shell.
 *  usage:  run corp.js [--once] [--no-selffund] [--no-products] [--office 3] [--quiet]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { writeStatus } from "./lib/modules.js";
import { money as fmtMoney } from "./lib/fmt.js";
import {
  CORP_CITIES, UPGRADE_PRIORITY, DEFAULT_CORP_CFG,
  distributeJobs, shouldAcceptOffer, upgradesToLevel,
  PRODUCT_INDUSTRY, PRODUCT_DIVISION, PRODUCT_HQ, RESEARCH_PRIORITY, planProduct,
} from "./lib/corp-logic.js";

const AGRI = "Agriculture";
const AGRI_OUTPUTS = ["Plants", "Food"];
const JOB_ORDER = ["Operations", "Engineer", "Business", "Management", "Research & Development"];

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["once", false],
    ["no-selffund", false],
    ["no-products", false],
    ["office", DEFAULT_CORP_CFG.officeStartSize],
    ["quiet", false],
  ]);
  const cfg = {
    ...DEFAULT_CORP_CFG,
    officeStartSize: Number(flags.office),
    productOffice: 6,          // Tobacco office size per city
    productHqOffice: 9,        // larger design office in the HQ city
    productInvestFrac: 0.01,   // of funds into EACH of design + marketing per product
    productInvestMax: 1e11,    // cap per invest so we never dump the treasury
  };
  const log = (m) => ns.tprint("[corp] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[corp] " + m); };
  const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };

  const caps = getCapabilities(ns);
  if (!caps.corporation) { log("Corporation API unavailable (need BN3 or SF-3). Exiting."); return; }

  let blocked = false;
  while (true) {
    if (!ns.corporation.hasCorporation()) {
      if (!ns.corporation.createCorporation(cfg.corpName, !flags["no-selffund"])) {
        if (!blocked) { log("Can't create a corporation (need BN3, or $150b to self-fund outside it). Idling."); blocked = true; }
        writeStatus(ns, "corp", { line: "no corp (need BN3 / $150b)" });
        if (flags.once) return;
        await ns.sleep(10_000);
        continue;
      }
      log("created corporation '" + cfg.corpName + "'.");
    }

    ensureAll(ns, cfg, flags, vlog, safe);

    if (flags.once) return;
    try { await ns.corporation.nextUpdate(); } catch (e) { await ns.sleep(2000); }
  }
}

function ensureAll(ns, cfg, flags, vlog, safe) {
  const c = ns.corporation;

  // --- Agriculture material engine ---
  ensureDivision(ns, AGRI, AGRI, vlog);
  ensureUnlock(ns, "Smart Supply", vlog);
  const agri = safe(() => c.getDivision(AGRI));
  if (agri) for (const city of CORP_CITIES) ensureCity(ns, cfg, agri, city, AGRI_OUTPUTS, cfg.officeStartSize, safe, vlog);

  // --- Tobacco product engine (v2) ---
  if (!flags["no-products"]) {
    if (ensureProductDivision(ns, cfg, vlog, safe)) {
      const tob = safe(() => c.getDivision(PRODUCT_DIVISION));
      if (tob) {
        for (const city of CORP_CITIES) {
          const size = city === PRODUCT_HQ ? cfg.productHqOffice : cfg.productOffice;
          ensureCity(ns, cfg, tob, city, [], size, safe, vlog);
        }
        ensureResearch(ns, PRODUCT_DIVISION, vlog, safe);
        ensureProducts(ns, cfg, PRODUCT_DIVISION, vlog, safe);
        ensureAdVert(ns, cfg, PRODUCT_DIVISION, vlog, safe);
      }
    }
  }

  ensureUpgrades(ns, cfg, vlog, safe);
  ensureAdVert(ns, cfg, AGRI, vlog, safe);
  ensureInvestment(ns, cfg, vlog, safe);

  const info = c.getCorporation();
  writeStatus(ns, "corp", { line: fmtMoney(info.funds) + "  rev " + fmtMoney(info.revenue) + "/s"
    + "  profit " + fmtMoney(info.revenue - info.expenses) + "/s  div " + info.divisions.length });
  emitCorpData(ns, c, info, cfg, safe);
}

/** Write corp-data.txt for the snapshot, mirroring gang.js's gang-data.txt pattern.
 *
 *  WHY MORE THAN ONE LINE. "rev $56.86k/s" alone cannot answer the only questions that matter:
 *    - Is it PROFITABLE? revenue is gross; a division can post good revenue and burn funds.
 *    - Is a warehouse FULL? production silently stalls at 100% and revenue just stops climbing.
 *    - Is the office STARVED? avgEnergy/avgMorale below ~90 drops production hard.
 *    - How far to the next unlock? Tobacco is a $20b industry cost, so funds-vs-target is the
 *      single number that says whether to keep waiting or change strategy.
 *  Every one of those is a silent failure -- the corp keeps "running" and the one-line status
 *  looks identical. Same reason gang.js emits a member table instead of a summary. */
function emitCorpData(ns, c, info, cfg, safe) {
  try {
    const divisions = [];
    for (const dn of info.divisions) {
      const d = safe(() => c.getDivision(dn));
      if (!d) continue;
      const cities = [];
      for (const city of (d.cities || [])) {
        const w = safe(() => c.getWarehouse(dn, city));
        const o = safe(() => c.getOffice(dn, city));
        cities.push({
          city,
          whLevel: w ? w.level : null,
          whUsed: w ? w.sizeUsed : null,
          whSize: w ? w.size : null,
          smart: w ? !!w.smartSupplyEnabled : null,
          employees: o ? o.numEmployees : null,
          officeSize: o ? o.size : null,
          morale: o ? o.avgMorale : null,
          energy: o ? o.avgEnergy : null,
        });
      }
      divisions.push({
        name: dn,
        industry: d.industry,
        revenue: d.lastCycleRevenue, expenses: d.lastCycleExpenses,
        productionMult: d.productionMult, research: d.researchPoints,
        adverts: d.numAdVerts, awareness: d.awareness, popularity: d.popularity,
        products: d.products || [], makesProducts: !!d.makesProducts, maxProducts: d.maxProducts || 0,
        cities,
      });
    }
    // next capability gate -- what the corp is currently saving toward, and how far off it is
    let nextGate = null;
    if (!info.divisions.includes(PRODUCT_DIVISION)) {
      const cost = safe(() => c.getIndustryData(PRODUCT_INDUSTRY).startingCost);
      if (cost) nextGate = { what: PRODUCT_DIVISION + " (" + PRODUCT_INDUSTRY + ")", cost };
    }
    ns.write("corp-data.txt", JSON.stringify({
      ts: Date.now(),
      name: info.name, public: !!info.public, state: info.nextState,
      funds: info.funds, revenue: info.revenue, expenses: info.expenses,
      valuation: info.valuation, sharePrice: info.sharePrice,
      numShares: info.numShares, totalShares: info.totalShares,
      dividendRate: info.dividendRate, investorRound: safe(() => c.getInvestmentOffer().round) || null,
      divisions, nextGate,
    }), "w");
  } catch (e) { /* diagnostics must never break the manager */ }
}

function ensureDivision(ns, name, industry, vlog) {
  const c = ns.corporation;
  if (!c.getCorporation().divisions.includes(name)) {
    try { c.expandIndustry(industry, name); vlog("opened " + industry + " division '" + name + "'"); } catch (e) {}
  }
}

function ensureProductDivision(ns, cfg, vlog, safe) {
  const c = ns.corporation;
  if (c.getCorporation().divisions.includes(PRODUCT_DIVISION)) return true;
  const cost = safe(() => c.getIndustryData(PRODUCT_INDUSTRY).cost);
  if (cost != null && c.getCorporation().funds >= cost) {
    try { c.expandIndustry(PRODUCT_INDUSTRY, PRODUCT_DIVISION); vlog("opened Tobacco product division"); return true; } catch (e) {}
  }
  return false;
}

function ensureUnlock(ns, name, vlog) {
  const c = ns.corporation;
  try {
    if (!c.hasUnlock(name) && c.getUnlockCost(name) <= c.getCorporation().funds) { c.purchaseUnlock(name); vlog("unlocked " + name); }
  } catch (e) {}
}

function ensureCity(ns, cfg, division, city, outputs, officeSize, safe, vlog) {
  const c = ns.corporation;
  const div = division.name;
  try {
    if (!division.cities.includes(city)) c.expandCity(div, city);
    if (!c.hasWarehouse(div, city)) c.purchaseWarehouse(div, city);
    c.setSmartSupply(div, city, true);
  } catch (e) { return; /* insufficient funds -- retry next tick */ }

  try {
    const office = c.getOffice(div, city);
    if (office.size < officeSize) c.upgradeOfficeSize(div, city, officeSize - office.size);
    const size = c.getOffice(div, city).size;
    while (c.getOffice(div, city).numEmployees < size) { if (!c.hireEmployee(div, city)) break; }
    const dist = distributeJobs(c.getOffice(div, city).numEmployees);
    for (const job of JOB_ORDER) c.setJobAssignment(div, city, job, dist[job] || 0);
    const o = c.getOffice(div, city);
    if (o.avgEnergy < 98) c.buyTea(div, city);
    if (o.avgMorale < 98) c.throwParty(div, city, 500_000);
  } catch (e) {}

  for (const mat of outputs) safe(() => c.sellMaterial(div, city, mat, "MAX", "MP"));
}

function ensureResearch(ns, div, vlog, safe) {
  const c = ns.corporation;
  const pts = safe(() => c.getDivision(div).researchPoints) || 0;
  for (const name of RESEARCH_PRIORITY) {
    if (safe(() => c.hasResearched(div, name))) continue;
    const cost = safe(() => c.getResearchCost(div, name));
    if (cost != null && cost <= pts * 0.5) { safe(() => c.research(div, name)); vlog("researched " + name); }
    break; // one per tick, keep a research-point buffer
  }
}

function ensureProducts(ns, cfg, div, vlog, safe) {
  const c = ns.corporation;
  const division = safe(() => c.getDivision(div));
  if (!division) return;

  const products = division.products.map((n) => {
    const p = safe(() => c.getProduct(div, PRODUCT_HQ, n)) || {};
    return { name: n, developmentProgress: p.developmentProgress ?? 100, effectiveRating: p.effectiveRating ?? 0 };
  });

  const funds = c.getCorporation().funds;
  const invest = Math.min(cfg.productInvestMax, Math.max(1e6, funds * cfg.productInvestFrac));
  const plan = planProduct(products, division.maxProducts);
  if (plan.action === "make" && funds >= invest * 2) {
    safe(() => c.makeProduct(div, PRODUCT_HQ, plan.name, invest, invest)); vlog("designing " + plan.name);
  } else if (plan.action === "replace" && funds >= invest * 2) {
    safe(() => c.discontinueProduct(div, plan.discontinue));
    safe(() => c.makeProduct(div, PRODUCT_HQ, plan.make, invest, invest));
    vlog("churned " + plan.discontinue + " -> " + plan.make);
  }

  // Sell every finished product at market price everywhere; let Market-TA.II auto-price if researched.
  const ta2 = safe(() => c.hasResearched(div, "Market-TA.II"));
  for (const n of division.products) {
    for (const city of division.cities) safe(() => c.sellProduct(div, city, n, "MAX", "MP", true));
    if (ta2) safe(() => c.setProductMarketTA2(div, n, true));
  }
}

function ensureUpgrades(ns, cfg, vlog, safe) {
  const c = ns.corporation;
  const funds = c.getCorporation().funds;
  const catalog = UPGRADE_PRIORITY.map((name) => {
    const cost = safe(() => c.getUpgradeLevelCost(name));
    return cost == null ? null : { name, cost };
  }).filter(Boolean);
  let bought = 0;
  for (const name of upgradesToLevel(catalog, funds, cfg)) { if (safe(() => c.levelUpgrade(name)) !== undefined) bought++; }
  if (bought) vlog("leveled " + bought + " upgrade(s)");
}

function ensureAdVert(ns, cfg, div, vlog, safe) {
  const c = ns.corporation;
  const cost = safe(() => c.getHireAdVertCost(div));
  if (cost != null && cost <= c.getCorporation().funds * cfg.advertFundsFrac) {
    safe(() => c.hireAdVert(div)); vlog("bought AdVert for " + div + " (" + fmtMoney(cost) + ")");
  }
}

function ensureInvestment(ns, cfg, vlog, safe) {
  const c = ns.corporation;
  const offer = safe(() => c.getInvestmentOffer());
  if (shouldAcceptOffer(offer, cfg) && safe(() => c.acceptInvestmentOffer())) {
    vlog("accepted round " + offer.round + " investment: " + fmtMoney(offer.funds));
  }
}
