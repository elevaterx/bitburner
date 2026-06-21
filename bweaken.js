/** @param {NS} ns
 * Batcher worker: weaken `target`, finishing after `additionalMsec` extra delay.
 *   run bweaken.js <target> <additionalMsec>
 */
export async function main(ns) {
  const target = ns.args[0];
  const addMs = Number(ns.args[1]) || 0;
  await ns.weaken(target, { additionalMsec: addMs });
}
