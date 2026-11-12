/**
 * 全工程统一的错误形状。
 *
 * 契约：`docs/04-架构设计.md` §11.1。
 * 错误码族见下表——**新增码要在这里登记**，不要散落在各处。
 */

export type ErrorCode =
  | 'CONN_OPEN_FAILED'
  | 'CONN_CLOSED'
  | 'CONN_TIMEOUT'
  | 'PORT_BUSY'
  | 'TERM_NOT_FOUND'
  | 'FILE_TRANSFER_FAILED'
  | 'IPC_INVALID_PAYLOAD'
  | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  /** 人话，可直接展示给用户 */
  message: string;
  /** 同样的输入再来一次会不会成功 */
  retryable: boolean;
  /** 补充信息（端口号、字段名……）。只放安全信息，不放堆栈 */
  detail?: unknown;
}

export function makeError(
  code: ErrorCode,
  message: string,
  extra?: Partial<Omit<AppError, 'code' | 'message'>>,
): AppError {
  return {
    code,
    message,
    retryable: extra?.retryable ?? false,
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
  };
}
