/**
 * The error shape used across the project.
 *
 * Every error code is listed here. A new code must be registered in this
 * list rather than introduced at the point of use.
 */

export type ErrorCode =
  | 'CONN_OPEN_FAILED'
  | 'CONN_CLOSED'
  | 'CONN_TIMEOUT'
  | 'CONN_BUSY'
  | 'PORT_BUSY'
  | 'TERM_NOT_FOUND'
  | 'FILE_TRANSFER_FAILED'
  | 'PACK_INVALID'
  | 'IPC_INVALID_PAYLOAD'
  | 'INTERNAL';

/**
 * Errors must be `Error` instances, not plain objects.
 *
 * The reason is a defect that was actually hit: when the main process throws
 * during `ipcRenderer.invoke`, Electron wraps it as
 * `new Error("Error invoking remote method 'x': " + error)`. If the main
 * process threw a plain object, `String(error)` would be `[object Object]`,
 * and the user would see
 * "Error invoking remote method 'terminal:open': [object Object]"
 * while the sentence "serial port COM3 is busy" never reached the screen.
 *
 * The code, the message and the retryability therefore live on the instance.
 * Across the IPC boundary `toAppErrorPayload` flattens the error into plain
 * data, and `appErrorToException` restores it on the other side.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** Whether the same input would succeed on a retry */
  readonly retryable: boolean;
  /** Supplementary information (port number, field name). Safe data only, no stack */
  readonly detail?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    extra?: { retryable?: boolean; detail?: unknown },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = extra?.retryable ?? false;
    if (extra?.detail !== undefined) this.detail = extra.detail;
  }
}

export function makeError(
  code: ErrorCode,
  message: string,
  extra?: { retryable?: boolean; detail?: unknown },
): AppError {
  return new AppError(code, message, extra);
}

/** The error payload carried across the IPC boundary (plain, structured-cloneable data) */
export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

/**
 * Any thrown value becomes a payload that can cross the IPC boundary.
 *
 * Values that are not `AppError` (a native `Error`, a string, an arbitrary
 * object) are mapped to `INTERNAL`, but the message is preserved: it is the
 * only part the user can read.
 */
export function toAppErrorPayload(err: unknown): AppErrorPayload {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    };
  }
  if (err instanceof Error) {
    return { code: 'INTERNAL', message: err.message, retryable: false };
  }
  return { code: 'INTERNAL', message: String(err), retryable: false };
}

/**
 * Payload becomes an `Error` instance, so the receiving side gets an
 * exception it can branch on by `err.code`.
 *
 * "The serial port is busy" and "the board is offline" need different
 * messages, and the code is what distinguishes them.
 */
export function appErrorToException(payload: AppErrorPayload): AppError {
  return new AppError(payload.code, payload.message, {
    retryable: payload.retryable,
    detail: payload.detail,
  });
}
