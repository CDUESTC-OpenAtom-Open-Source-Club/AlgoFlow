// Fixed-window request counters, kept in memory: a restart only resets them.
// One limiter per rule, for example workspace creations per address.
const MAX_TRACKED_KEYS = 10000;

export class RateLimiter {
  #windows = new Map();
  #limit;
  #windowMs;
  #now;

  /** @param {{ limit: number, windowMs: number, now?: () => number }} options */
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Counts one request for `key`. Returns 0 when it is allowed, otherwise the
   * milliseconds until the window resets; a refused request is not counted.
   */
  take(key) {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      window = { start: now, count: 0 };
      // Re-insert so Map order is oldest window first, then cap memory.
      this.#windows.delete(key);
      this.#windows.set(key, window);
      if (this.#windows.size > MAX_TRACKED_KEYS) this.#windows.delete(this.#windows.keys().next().value);
    }
    if (window.count >= this.#limit) return window.start + this.#windowMs - now;
    window.count += 1;
    return 0;
  }
}
