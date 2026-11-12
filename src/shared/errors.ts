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

/**
 * 错误**必须是 Error 实例**，不能是普通对象。
 *
 * 理由是一条真实踩过的坑：Electron 的 `ipcRenderer.invoke` 在主进程抛错时，
 * 会把错误包成 `new Error("Error invoking remote method 'x': " + error)`。
 * 如果主进程抛的是普通对象，`String(error)` 就是 **`[object Object]`**——
 * 用户在界面上看到的是
 * 「Error invoking remote method 'terminal:open': [object Object]」，
 * 而「串口 COM3 被占用」这句话**永远到不了用户眼前**。
 *
 * 所以：错误码、消息、可重试性都挂在**实例**上，
 * 跨 IPC 时用 `toAppErrorPayload` 拍平成普通数据再传，
 * 到对面用 `appErrorToException` 还原成实例。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** 同样的输入再来一次会不会成功 */
  readonly retryable: boolean;
  /** 补充信息（端口号、字段名……）。只放安全信息，不放堆栈 */
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

/** 跨 IPC 传的错误载荷（普通数据，能被结构化克隆） */
export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

/**
 * 任何抛出物 → 可跨 IPC 的载荷。
 *
 * 不是 AppError 的（原生 Error、字符串、随便一个对象）一律归到 `INTERNAL`，
 * 但**消息要保住**——那是用户唯一能看懂的东西。
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
 * 载荷 → Error 实例（对面收到时还原成带错误码的异常）。
 *
 * renderer 侧于是可以按 `err.code` 分支的——
 * 「串口被占用」和「板子不在线」要给的提示不一样。
 */
export function appErrorToException(payload: AppErrorPayload): AppError {
  return new AppError(payload.code, payload.message, {
    retryable: payload.retryable,
    detail: payload.detail,
  });
}
