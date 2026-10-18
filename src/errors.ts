/** Single source of truth: the type below is derived from this list. */
export const WA_MANAGER_ERROR_CODES = [
  'CLOSED',
  'INVALID_ARGUMENT',
  'ALREADY_PAIRED',
  'PAIRING_IN_PROGRESS',
  'PAIRING_TIMEOUT',
  'NOT_AVAILABLE',
  'NOT_CONNECTED',
  'CONNECTION_TIMEOUT',
  'QUEUE_FULL',
  'TIMEOUT',
] as const;

export type WaManagerErrorCode = (typeof WA_MANAGER_ERROR_CODES)[number];

export type WaManagerErrorOptions = {
  /** The original error that caused this one. */
  cause?: unknown;
  /** Which user session the error belongs to (handy for logs). */
  userId?: string;
};

/** Every error thrown by the manager itself carries a stable `code`. */
export class WaManagerError extends Error {
  readonly code: WaManagerErrorCode;
  readonly userId?: string;

  constructor(code: WaManagerErrorCode, message: string, options: WaManagerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WaManagerError';
    this.code = code;
    if (options.userId !== undefined) this.userId = options.userId;
    // Keep the stack trace pointing at the caller, not at this constructor.
    Error.captureStackTrace?.(this, WaManagerError);
  }

  /**
   * Type-safe check. With no codes: "is this a WaManagerError?".
   * With codes: "is it one of these?"  e.g. WaManagerError.is(err, 'CLOSED', 'NOT_CONNECTED')
   */
  static is(error: unknown, ...codes: WaManagerErrorCode[]): error is WaManagerError {
    if (!(error instanceof WaManagerError)) return false;
    return codes.length === 0 || codes.includes(error.code);
  }

  /** Clean JSON for logs / API responses (no stack, cause flattened to its message). */
  toJSON(): { name: string; code: WaManagerErrorCode; message: string; userId?: string; cause?: string } {
    const cause =
      this.cause === undefined
        ? undefined
        : this.cause instanceof Error
          ? this.cause.message
          : String(this.cause);
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.userId !== undefined && { userId: this.userId }),
      ...(cause !== undefined && { cause }),
    };
  }
}
