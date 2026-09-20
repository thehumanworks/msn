export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** 401 is the only auth-expiry signal in this contract (rotation/revocation included). */
  get isAuthExpired(): boolean {
    return this.status === 401;
  }

  /** Network hiccups and server-side overload are worth a retry with backoff. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }

  get isRetryable(): boolean {
    return true;
  }
}

/** Raised by the redirect guard; never retryable, always a configuration/security problem. */
export class InsecureOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureOriginError";
  }
}

/** The server (or a proxy) violated the documented contract; retrying the same request will not help. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Raised instead of silently truncating a bounded scan (event-cursor bootstrap, task scans, ...). */
export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
