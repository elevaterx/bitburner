/** corp.js -- capability-gated Corporation manager (BN3, or SF-3 elsewhere). v1 = Agriculture engine.
 *
 *  Self-gates: exits if the Corporation API is unavailable. Idempotent "ensure" steps run each corp
 *  state tick (order-independent, safe to re-run): create corp -> Agriculture division -> Smart Supply
 *  unlock -> expand all 6 cities (warehouse + smart supply) -> size/staff/assign offices -> keep morale
 *  up -> sell outputs at market price -> level priority upgrades -> AdVert when cheap -> accept
 *  investment at round thresholds. Smart Supply auto-buys inputs, so there's no risky manual material
 *  micro here. (Boost materials + a Tobacco PRODUCT division are the planned v2.)
 *
 *  Decisions live in lib/corp-logic.js (pure, unit-tested). This is the thin ns shell.
 *  usage:  run corp.js [--once] [--no-selffund] [--office 3] [--quiet]
 *  @param {NS} ns */
import { getCapabilities } from "./lib/caps.js";
import { money as fmtMoney } from "./lib/fmt.js";
import {
  CORP_CITIES, UPGRADE_PRIORITY, DEFAULT_CORP_CFG,
  distributeJobs, shouldAcceptOffer, upgradesToLevel,
} from "./lib/corp-logic.js";

const OUTPUTS = ["Plants", "Food"];          // Agriculture sellables
const JOB_ORDER = ["Operations", "Engineer", "Business", "Management", "Research & Development"];

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["once", false],
    ["no-selffund", false],
    ["office", DEFAULT_CORP_CFG.officeStartSize],
    ["quiet", false],
  ]);
  const cfg = { ...DEFAULT_CORP_CFG, officeStartSize: Number(flags.office) };
  const log = (m) => ns.tprint("[corp] " + m);
  const vlog = (m) => { if (!flags.quiet) ns.print("[corp] " + m); };

  const caps = getCapabilities(ns);
  if (!caps.corporation) { log("Corporation API unavailable (need BN3 or SF-3). Exiting."); return; }

  let blocked = false;
  while (true) {
    if (!ns.corporation.hasCorporation()) {
      const ok = ns.corporation.createCorporation(cfg.corpName, !flags["no-selffund"]);
      if (!ok) {
        if (!blocked) { log("Can't create a corporation (need BN3, or $150b to self-fund outside it). Idling."); blocked = true; }
        if (flags.once) return;
        await ns.sleep(10_000);
        continue;
      }
      log("created corporation '" + cfg.corpName + "'.");
    }

    ensureAll(ns, cfg, vlog);

    if (flags.once) return;
    try { await ns.corporation.nextUpdate(); } catch (e) { await ns.sleep(2000); }
  }
}

function ensureAll(ns, cfg, vlog) {
  const c = ns.corporation;
  const div = cfg.division;

  // Division.
  if (!c.getCorporation().divisions.includes(div)) {
    try { c.expandIndustry("Agriculture", div); vlog("opened Agriculture division '" + div + "'"); } catch (e) { return; }
  }

  // Smart Supply unlock (auto-buys inputs) -- buy once when affordable.
  try {
    if (!c.hasUnlock("Smart Supply") && c.getUnlockCost("Smart Supply") <= c.getCorporation().funds) {
      c.purchaseUnlock("Smart Supply"); vlog("unlocked Smart Supply");
    }
  } catch (e) {}

  const division = c.getDivision(div);
  for (const city of CORP_CITIES) ensureCity(ns, cfg, division, city, vlog);

  ensureUpgrades(ns, cfg, vlog);
  ensureAdVert(ns, cfg, div, vlog);
  ensureInvestment(ns, cfg, vlog);
}

function ensureCity(ns, cfg, division, city, vlog) {
  const c = ns.corporation;
  const div = division.name;
  try {
    if (!division.cities.includes(city)) c.expandCity(div, city);
    if (!c.hasWarehouse(div, city)) c.purchaseWarehouse(div, city);
    c.setSmartSupply(div, city, true);
  } catch (e) { return; /* not enough funds yet -- retry next tick */ }

  // Office: size -> staff -> assign.
  try {
    const office = c.getOffice(div, city);
    if (office.size < cfg.officeStartSize) {
      c.upgradeOfficeSize(div, city, cfg.officeStartSize - office.size);
    }
    const size = c.getOffice(div, city).size;
    while (c.getOffice(div, city).numEmployees < size) { if (!c.hireEmployee(div, city)) break; }
    const dist = distributeJobs(c.getOffice(div, city).numEmployees);
    for (const job of JOB_ORDER) c.setJobAssignment(div, city, job, dist[job] || 0);

    // Morale/energy upkeep keeps production from decaying.
    const o = c.getOffice(div, city);
    if (o.avgEnergy < 98) c.buyTea(div, city);
    if (o.avgMorale < 98) c.throwParty(div, city, 500_000);
  } catch (e) {}

  // Sell outputs at market price.
  for (const mat of OUTPUTS) { try { c.sellMaterial(div, city, mat, "MAX", "MP"); } catch (e) {} }
}

function ensureUpgrades(ns, cfg, vlog) {
  const c = ns.corporation;
  const funds = c.getCorporation().funds;
  const catalog = UPGRADE_PRIORITY.map((name) => {
    try { return { name, cost: c.getUpgradeLevelCost(name) }; } catch (e) { return null; }
  }).filter(Boolean);
  const picks = upgradesToLevel(catalog, funds, cfg);
  let bought = 0;
  for (const name of picks) { try { c.levelUpgrade(name); bought++; } catch (e) {} }
  if (bought) vlog("leveled " + bought + " upgrade(s)");
}

function ensureAdVert(ns, cfg, div, vlog) {
  const c = ns.corporation;
  try {
    const cost = c.getHireAdVertCost(div);
    if (cost <= c.getCorporation().funds * cfg.advertFundsFrac) { c.hireAdVert(div); vlog("bought AdVert for " + fmtMoney(cost)); }
  } catch (e) {}
}

function ensureInvestment(ns, cfg, vlog) {
  const c = ns.corporation;
  try {
    const offer = c.getInvestmentOffer();
    if (shouldAcceptOffer(offer, cfg) && c.acceptInvestmentOffer()) {
      vlog("accepted round " + offer.round + " investment: " + fmtMoney(offer.funds));
    }
  } catch (e) {}
}
