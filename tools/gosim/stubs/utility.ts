export function sleep(_ms: number): Promise<void> { return Promise.resolve(); }
export function calculateEffectWithFactors(a: number) { return a; }
export function clampNumber(v: number, min = -Infinity, max = Infinity) { return Math.max(Math.min(v, max), min); }
export function clampInteger(v: number, min = -Infinity, max = Infinity) { return Math.round(Math.max(Math.min(v, max), min)); }
