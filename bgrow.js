/** @param {NS} ns
 * Batcher worker: grow `target`, finishing after `additionalMsec` extra delay.
 *   run bgrow.js <target> <additionalMsec>
 */
export async function main(ns) {
  const target = ns.args[0];
  const addMs = Number(ns.args[1]) || 0;
  await ns.grow(target, { additionalMsec: addMs });
}
