// A fixed-window limiter, per process. On serverless every instance has its own counters, so
// this is a brake against floods, not an exact quota (the README says so).

export interface RateLimiter {
  check(key: string): { allowed: boolean; retryAfterSeconds: number };
}

const MAX_TRACKED_KEYS = 1000;

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    check(key) {
      const current = now();
      if (windows.size > MAX_TRACKED_KEYS) {
        for (const [trackedKey, window] of windows) {
          if (current - window.start >= options.windowMs) {
            windows.delete(trackedKey);
          }
        }
      }
      const existing = windows.get(key);
      if (existing === undefined || current - existing.start >= options.windowMs) {
        windows.set(key, { start: current, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      existing.count += 1;
      if (existing.count <= options.limit) {
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const retryMs = existing.start + options.windowMs - current;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    },
  };
}
