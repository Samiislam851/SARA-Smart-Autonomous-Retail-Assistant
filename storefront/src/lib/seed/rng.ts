/**
 * A tiny seeded PRNG (mulberry32) plus a handful of helpers built on it.
 *
 * Every call site in `lib/seed/` consumes randomness from a single instance
 * created with a fixed constant seed (see `generate.ts`), and control flow
 * never depends on wall-clock time or `Math.random()`. That combination is
 * what makes the whole generator deterministic: the same seed, walked in the
 * same order, always produces the same 300 products byte-for-byte.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    // mulberry32 wants a 32-bit unsigned integer seed.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** True with probability `p` (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick one element deterministically. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("SeededRng.pick: cannot pick from an empty array");
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Pick one element, or undefined if the pool is empty. */
  pickOrUndefined<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : this.pick(items);
  }

  /** Fisher-Yates shuffle; does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = tmp;
    }
    return copy;
  }

  /** Round to one decimal place — used for ratings. */
  float1(min: number, max: number): number {
    return Math.round((this.next() * (max - min) + min) * 10) / 10;
  }
}
