/**
 * Fixed-window counter of failed attempts per key (IP + email for sign-in). In-memory, which suits a
 * single API instance; behind several replicas, move it to Postgres or Redis.
 */
export class AttemptLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** Milliseconds until the key may try again, or 0 if it is not blocked. */
  blockedFor(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) return 0;
    return h.count >= this.max ? h.resetAt - now : 0;
  }

  fail(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
    if (this.hits.size > 10_000) this.sweep(now);
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
  }
}
