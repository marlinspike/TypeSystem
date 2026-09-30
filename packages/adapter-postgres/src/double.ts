/**
 * Exact facts about IEEE-754 doubles (ADR-0044), so SQL bounds on stored
 * decimals can be stated in exact arithmetic instead of trusting another
 * system's floating-point parsing.
 */

const view = new DataView(new ArrayBuffer(8));

function bits(x: number): bigint {
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}

function fromBits(b: bigint): number {
  view.setBigUint64(0, b);
  return view.getFloat64(0);
}

/** The next double above `x` (finite `x`); `Infinity` above the largest. */
export function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE;
  const b = bits(x);
  return x > 0 ? fromBits(b + 1n) : fromBits(b - 1n);
}

/** The next double below `x` (finite `x`); `-Infinity` below the most negative. */
export function nextDown(x: number): number {
  return -nextUp(-x);
}

/**
 * The exact decimal value of a finite double — every digit, no rounding —
 * as a string Postgres `numeric` reads exactly. A double is `m × 2^e` with
 * integer `m`; for `e < 0` that is `m × 5^-e / 10^-e`.
 */
export function exactDecimal(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError("exactDecimal needs a finite number");
  if (x === 0) return "0";
  const b = bits(x);
  const negative = b >> 63n === 1n;
  const biased = Number((b >> 52n) & 0x7ffn);
  const fraction = b & 0xfffffffffffffn;
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  let digits: string;
  if (exponent >= 0) digits = (mantissa << BigInt(exponent)).toString();
  else {
    const scale = -exponent;
    const scaled = (mantissa * 5n ** BigInt(scale)).toString().padStart(scale + 1, "0");
    const whole = scaled.slice(0, scaled.length - scale);
    const part = scaled.slice(scaled.length - scale).replace(/0+$/, "");
    digits = part ? `${whole}.${part}` : whole;
  }
  return negative ? `-${digits}` : digits;
}
