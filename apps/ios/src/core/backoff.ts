export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
};

/**
 * Exponential backoff with full jitter (AWS-architecture-blog style): delay = random(0, min(max,
 * base * factor^attempt)). `attempt` is 0-indexed (first retry uses attempt 0).
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 30_000;
  const factor = options.factor ?? 2;
  const random = options.random ?? Math.random;
  const cap = Math.min(max, base * factor ** Math.max(0, attempt));
  return Math.round(random() * cap);
}
