/** Deterministic, seedable PRNG (mulberry32). */
export function makeRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.range = (a, b) => a + (b - a) * rnd();
  rnd.sym = (a) => (rnd() * 2 - 1) * a;
  rnd.int = (n) => Math.floor(rnd() * n);
  return rnd;
}
