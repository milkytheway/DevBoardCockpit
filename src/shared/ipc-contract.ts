/**
 * main 与 renderer 之间的全部 IPC 通道。
 *
 * 通道名集中在这里，main 与 preload 共用同一份定义——
 * 拼错通道名在编译期就会报错，而不是运行时静默失败。
 */

export const IPC = {} as const;

export type IpcPayloads = Record<string, unknown>;
