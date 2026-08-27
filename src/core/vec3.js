// Minimal dependency-free vec3 helpers. Vectors are plain [x, y, z] arrays so the
// core generator can run both in the browser and in Node (headless validation).

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const clone = (a) => [a[0], a[1], a[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function norm(a) {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Any unit vector perpendicular to `d`. */
export function perp(d) {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  return norm(cross(d, a));
}

/** Rotate `v` around unit axis `k` by `ang` radians (Rodrigues). */
export function rotAxis(v, k, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/** Rotation that takes unit vector `a` to unit vector `b`, applied to `v`. */
export function rotateFromTo(v, a, b) {
  const c = dot(a, b);
  if (c > 0.999999) return clone(v);
  if (c < -0.999999) return rotAxis(v, perp(a), Math.PI);
  const axis = norm(cross(a, b));
  return rotAxis(v, axis, Math.acos(Math.max(-1, Math.min(1, c))));
}

/** Component of `v` orthogonal to unit `n`, normalized. */
export function orthoNorm(v, n) {
  const p = sub(v, mul(n, dot(v, n)));
  return len(p) > 1e-9 ? norm(p) : perp(n);
}
