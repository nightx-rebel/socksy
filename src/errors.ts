export type WaManagerErrorCode =
  | 'CLOSED'
  | 'INVALID_ARGUMENT'
  | 'ALREADY_PAIRED'
  | 'PAIRING_IN_PROGRESS'
  | 'PAIRING_TIMEOUT'
  | 'NOT_AVAILABLE'
  | 'NOT_CONNECTED'
  | 'CONNECTION_TIMEOUT'
  | 'QUEUE_FULL'
  | 'TIMEOUT';

/** Every error thrown by the manager itself carries a stable `code`. */
export class WaManagerError extends Error {
  readonly code: WaManagerErrorCode;

  constructor(code: WaManagerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WaManagerError';
    this.code = code;
  }
}
