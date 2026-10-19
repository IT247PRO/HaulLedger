// Integer money helpers. Nothing in here ever produces a fractional cent.

/** a / b rounded half-up, for non-negative integers. */
export function roundDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= 0) {
    throw new RangeError(`roundDiv expects non-negative safe integers, got ${a}/${b}`);
  }
  return Math.floor((2 * a + b) / (2 * b));
}

export function sum(values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError(`not an integer amount: ${v}`);
    total += v;
  }
  return total;
}
