/**
 * Exponential backoff with jitter. Used for relay reconnection.
 */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly baseMs = 500,
    private readonly maxMs = 30_000,
    private readonly jitter = 0.3,
  ) {}

  next(): number {
    const exp = this.baseMs * 2 ** this.attempt;
    const capped = Math.min(exp, this.maxMs);
    const jitterDelta = capped * this.jitter * (Math.random() * 2 - 1);
    this.attempt += 1;
    return Math.max(this.baseMs, Math.floor(capped + jitterDelta));
  }

  reset(): void {
    this.attempt = 0;
  }
}
