import { describe, it, expect } from 'vitest';
import {
  BOARD_CAPABILITIES,
  IMPLEMENTED_CAPABILITIES,
  isBoardCapability,
  isImplementedCapability,
  matchTagPattern,
  isCoreTag,
  isCustomTag,
} from '../../src/main/tags/vocabulary';

/**
 * 能力词表与 tag 模式匹配。
 *
 * **两个词表是两个轴**（契约 §10.3，ADR-D24）：
 * - 板级 `{shell, exec, stream, files}` —— 「这块板能做什么」
 * - 连接级 `{exec, pty, files, exitCode}` —— 「**这条连接**能做什么」
 *
 * 板级词表里**有** `stream`（那是真实的板级能力），
 * 但**已实现能力集里没有**它（Stream 契约还没写，声明了也给不出来）——
 * 这正是规则 25 与规则 26 的分工。
 */

describe('板级能力词表（规则 25 的数据）', () => {
  it('封闭词表恰好是这四个', () => {
    expect([...BOARD_CAPABILITIES]).toEqual(['shell', 'exec', 'stream', 'files']);
  });

  it('stream 在词表里（它是真实的板级能力）', () => {
    expect(isBoardCapability('stream')).toBe(true);
  });

  it('未知值不在词表里', () => {
    expect(isBoardCapability('shellh')).toBe(false);
    expect(isBoardCapability('SHELL')).toBe(false);
    expect(isBoardCapability('')).toBe(false);
  });
});

describe('已实现能力集（规则 26 的数据）', () => {
  it('恰好是 shell / exec / files', () => {
    expect([...IMPLEMENTED_CAPABILITIES]).toEqual(['shell', 'exec', 'files']);
  });

  it('stream 不在已实现集里——声明了也给不出来', () => {
    expect(isImplementedCapability('stream')).toBe(false);
  });

  it('已实现集是板级词表的子集', () => {
    for (const c of IMPLEMENTED_CAPABILITIES) {
      expect(isBoardCapability(c)).toBe(true);
    }
  });

  it('**规则 26 读的是一张表，不是硬编码的 if (stream)**', () => {
    // 这条断言守的是「将来 Stream 落地时，改的是表不是规则」。
    // 换句话说：已实现集与词表的关系是**集合关系**，不是某几个硬编码的名字。
    // `new Set<string>`：`Set<"shell"|"exec"|"files">.has(c)` 在
    // TS 里是**严格**的（c 可能是 "stream"）——不加泛型参数就编译不过。
    const implemented = new Set<string>(IMPLEMENTED_CAPABILITIES);
    for (const c of BOARD_CAPABILITIES) {
      expect(isImplementedCapability(c)).toBe(implemented.has(c));
    }
  });
});

describe('matchTagPattern · tag 的模式匹配', () => {
  it('通配段对上具体段', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.core.3.usage')).toBe(true);
  });

  it('字面段必须逐位对上', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.core.3.cluster')).toBe(false);
  });

  it('段数不同就不匹配', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.usage')).toBe(false);
    expect(matchTagPattern('cpu.usage', 'cpu.usage.x')).toBe(false);
  });

  it('完全相等就匹配', () => {
    expect(matchTagPattern('cpu.usage', 'cpu.usage')).toBe(true);
  });

  it('通配段不能匹配空段', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.core..usage')).toBe(false);
  });

  it('一个 * 只吃一段，不吃多段', () => {
    expect(matchTagPattern('cpu.*.usage', 'cpu.core.3.usage')).toBe(false);
    expect(matchTagPattern('cpu.*.usage', 'cpu.3.usage')).toBe(true);
  });

  it('sample 侧用的是同一套函数（规则 7 的前提）', () => {
    // `core.*.usage` 是 **sample** 命名空间，`cpu.core.*.usage` 是 **tag** 命名空间
    // ——两个命名空间，但**模式规则一样**。
    expect(matchTagPattern('core.*.usage', 'core.3.usage')).toBe(true);
    expect(matchTagPattern('core.*.usage', 'core.3.cluster')).toBe(false);
  });
});

describe('isCoreTag · 核心词表里的 tag（规则 1 的数据）', () => {
  it('词表里的确切名字', () => {
    expect(isCoreTag('cpu.usage')).toBe(true);
    expect(isCoreTag('mem.total_bytes')).toBe(true);
  });

  it('词表里的模式展开出来的名字', () => {
    expect(isCoreTag('cpu.core.3.usage')).toBe(true);
  });

  it('不在词表里的名字', () => {
    expect(isCoreTag('cpu.temperature')).toBe(false);
  });

  it('custom 命名空间**不是**核心词表', () => {
    expect(isCoreTag('custom.rk3588-atk.npu.duty')).toBe(false);
  });
});

describe('isCustomTag · custom 命名空间（规则 1）', () => {
  it('属于本包的 custom 命名空间', () => {
    expect(isCustomTag('custom.rk3588-atk.npu.duty', 'rk3588-atk')).toBe(true);
  });

  it('属于**别的**包的 custom 命名空间', () => {
    expect(isCustomTag('custom.rk3568.npu.duty', 'rk3588-atk')).toBe(false);
  });

  it('核心词表里的名字不是 custom', () => {
    expect(isCustomTag('cpu.usage', 'rk3588-atk')).toBe(false);
  });

  it('不带 custom 前缀的不算', () => {
    expect(isCustomTag('rk3588-atk.npu.duty', 'rk3588-atk')).toBe(false);
  });
});
