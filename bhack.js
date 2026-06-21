/** @param {NS} ns
 * Batcher worker: hack `target`, finishing after `additionalMsec` extra delay.
 *   run bhack.js <target> <additionalMsec>
 */
export async function main(ns) {
  const target = ns.args[0];
  const addMs = Number(ns.args[1]) || 0;
  await ns.hack(target, { additionalMsec: addMs });
}
