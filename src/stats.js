export function round(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function mean(values) {
  const xs = values.filter((v) => v != null && !Number.isNaN(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function delta(current, previous, digits = 0) {
  if (current == null || previous == null) return null;
  return round(current - previous, digits);
}
