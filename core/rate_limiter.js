/**
 * CPAMC Rate Limiter v3
 * Token bucket algorithm - inspired by claude-code-telegram rate_limiter
 * Per-user rate limiting with burst support
 */

class RateLimitBucket {
  constructor(capacity = 10, refillRate = 1.0) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate; // tokens per second
    this.lastUpdate = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastUpdate) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastUpdate = now;
  }

  consume(tokens = 1) {
    this._refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  getWaitTime(tokens = 1) {
    this._refill();
    if (this.tokens >= tokens) return 0;
    return (tokens - this.tokens) / this.refillRate;
  }

  getStatus() {
    this._refill();
    return {
      tokens: Math.floor(this.tokens),
      capacity: this.capacity,
      refillRate: this.refillRate
    };
  }
}

class RateLimiter {
  constructor(options = {}) {
    this.buckets = new Map();
    this.capacity = options.capacity || 10;       // max messages burst
    this.refillRate = options.refillRate || 0.5;  // 1 token per 2 seconds
    this.violations = new Map();
  }

  _getBucket(userId) {
    if (!this.buckets.has(userId)) {
      this.buckets.set(userId, new RateLimitBucket(this.capacity, this.refillRate));
    }
    return this.buckets.get(userId);
  }

  check(userId, cost = 1) {
    const bucket = this._getBucket(userId);
    const allowed = bucket.consume(cost);

    if (!allowed) {
      const violations = (this.violations.get(userId) || 0) + 1;
      this.violations.set(userId, violations);
      const waitTime = Math.ceil(bucket.getWaitTime(cost));
      return {
        allowed: false,
        message: `⏳ Terlalu cepat! Tunggu ${waitTime} detik sebelum mengirim pesan lagi.`,
        waitTime,
        violations
      };
    }

    return { allowed: true, waitTime: 0 };
  }

  getStatus(userId) {
    const bucket = this._getBucket(userId);
    return {
      ...bucket.getStatus(),
      violations: this.violations.get(userId) || 0
    };
  }

  reset(userId) {
    this.buckets.delete(userId);
    this.violations.delete(userId);
  }
}

module.exports = RateLimiter;
