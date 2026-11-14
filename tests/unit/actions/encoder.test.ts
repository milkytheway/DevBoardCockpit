import { describe, it, expect } from 'vitest';
import {
  buildCommand,
  encodeParams,
  renderCommand,
} from '../../../src/main/actions/encoder';
import { tokenizeCommand } from '../../../src/main/tags/floor';
import type { PackParam } from '../../../src/main/tags/schema';

/**
 * 参数编码 —— 契约 `docs/spec/02-board-pack.md` §4.6「注入防线」。
 *
 * **为什么它是一等公民**：板端会话是 root 权限，
 * 一条 `--model 'x; reboot'` 就能把「启动管线」变成「重启板子」——
 * 而 `reboot` **不在命令模板里**，所以危险地板按模板匹配**根本拦不住**。
 *
 * → 编码是**运行时**的活：包只声明类型与范围，不负责转义
 * （十个包作者会写出十种转义方式，其中九种是错的）。
 */
const SCHEMA: Record<string, PackParam> = {
  model: { type: 'string', maxLength: 32 },
  fps: { type: 'integer', min: 1, max: 120 },
  ratio: { type: 'number' },
  on: { type: 'boolean' },
  mode: { type: 'enum', values: ['fast', 'slow'] },
};

describe('参数编码 · 四种类型的正例', () => {
  it('integer 按十进制字面量注入，不带引号', () => {
    expect(encodeParams({ fps: SCHEMA.fps! }, { fps: 30 })).toEqual({ fps: '30' });
  });

  it('number 同理', () => {
    expect(encodeParams({ ratio: SCHEMA.ratio! }, { ratio: 1.5 })).toEqual({ ratio: '1.5' });
  });

  it('boolean → true / false', () => {
    expect(encodeParams({ on: SCHEMA.on! }, { on: true })).toEqual({ on: 'true' });
    expect(encodeParams({ on: SCHEMA.on! }, { on: false })).toEqual({ on: 'false' });
  });

  it('enum 原样注入（值必须在 values 里）', () => {
    expect(encodeParams({ mode: SCHEMA.mode! }, { mode: 'fast' })).toEqual({ mode: 'fast' });
  });

  it('string 单引号包裹', () => {
    expect(encodeParams({ model: SCHEMA.model! }, { model: 'x' })).toEqual({ model: "'x'" });
  });

  it("string 里的单引号按 POSIX 方式转义（' → '\\''）", () => {
    expect(encodeParams({ model: SCHEMA.model! }, { model: "it's" })).toEqual({
      model: "'it'\\''s'",
    });
  });
});

describe('参数编码 · 注入不改变参数个数（这条是 §4.6 的核心）', () => {
  it('分号被包在单引号里 → 仍然只有一个参数', () => {
    const encoded = encodeParams({ model: SCHEMA.model! }, { model: 'x; reboot' });
    const command = renderCommand('pipeline start --model {model}', encoded);
    const tokens = tokenizeCommand(command);
    // 参数个数不变 → `reboot` 不可能成为第二条命令
    expect(tokens).toEqual(['pipeline', 'start', '--model', 'x; reboot']);
  });

  it('命令替换后参数个数不变（模板两个词 + 两个参数）', () => {
    const { command } = buildCommand(
      'pipeline start --model {model} --fps {fps}',
      { model: SCHEMA.model!, fps: SCHEMA.fps! },
      { model: 'x; reboot', fps: 30 },
    );
    expect(tokenizeCommand(command)).toEqual([
      'pipeline',
      'start',
      '--model',
      'x; reboot',
      '--fps',
      '30',
    ]);
  });

  it('命令替换后带空格的参数不会被拆开（空格也在引号里）', () => {
    const { command } = buildCommand('run {model}', { model: SCHEMA.model! }, { model: 'a b c' });
    expect(tokenizeCommand(command)).toEqual(['run', 'a b c']);
  });
});

describe('参数编码 · 负例（运行时**不信任包与调用方的自述**）', () => {
  const bad = (schema: PackParam, value: unknown): () => unknown =>
    () => encodeParams({ p: schema }, { p: value });

  it('enum 的值不在 values 里 → 拒掉', () => {
    expect(bad(SCHEMA.mode!, 'turbo')).toThrow(/values|取值/);
  });

  it('integer 收到字符串 → 拒掉（不因为「看起来像数字」就放行）', () => {
    expect(bad(SCHEMA.fps!, '30')).toThrow(/integer|整数/);
  });

  it('number 收到 NaN → 拒掉', () => {
    expect(bad(SCHEMA.ratio!, Number.NaN)).toThrow(/number/);
  });

  it('boolean 收到字符串 → 拒掉', () => {
    expect(bad(SCHEMA.on!, 'true')).toThrow(/boolean/);
  });

  it('integer 超出 min/max → 拒掉', () => {
    expect(bad(SCHEMA.fps!, 0)).toThrow(/范围|min|max/);
    expect(bad(SCHEMA.fps!, 999)).toThrow(/范围|min|max/);
  });

  it('string 超 maxLength → 拒掉（没有上限的字符串参数就是注入面）', () => {
    expect(bad(SCHEMA.model!, 'x'.repeat(33))).toThrow(/maxLength|长度/);
  });

  it('string 不匹配 pattern → 拒掉', () => {
    expect(bad({ type: 'string', maxLength: 8, pattern: '^[a-z]+$' }, 'ABC')).toThrow(/pattern/);
  });

  it('string 里有换行 → 拒掉（串口是一行一条命令，事实 S6）', () => {
    expect(bad(SCHEMA.model!, 'a\nb')).toThrow(/换行/);
  });

  it('缺值且没有 default → 拒掉', () => {
    expect(() => encodeParams({ model: SCHEMA.model! }, {})).toThrow(/缺少|缺/);
  });

  it('多出来的参数 → 拒掉（调用方塞了一个没声明的参数）', () => {
    expect(() => encodeParams({ fps: SCHEMA.fps! }, { fps: 30, extra: 'x' })).toThrow(/没有声明/);
  });

  it('模板里的占位没有声明 → 拒掉（不信任包的模板）', () => {
    expect(() => renderCommand('run {undeclared}', { model: "'x'" })).toThrow(/占位|声明/);
  });

  it('错误是 AppError，带错误码', () => {
    try {
      encodeParams({ mode: SCHEMA.mode! }, { mode: 'turbo' });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'IPC_INVALID_PAYLOAD' });
    }
  });
});

describe('参数编码 · 取值', () => {
  it('缺值时用 default', () => {
    expect(encodeParams({ fps: { type: 'integer', default: 60 } }, {})).toEqual({ fps: '60' });
  });

  it('给了值就用给的值（不给 default 优先）', () => {
    expect(encodeParams({ fps: { type: 'integer', default: 60 } }, { fps: 30 })).toEqual({
      fps: '30',
    });
  });
});

describe('命令渲染', () => {
  it('同一个占位出现两次 → 两处都替换', () => {
    const encoded = encodeParams({ fps: SCHEMA.fps! }, { fps: 30 });
    expect(renderCommand('a {fps} b {fps}', encoded)).toBe('a 30 b 30');
  });

  it('模板里没有占位 → 原样返回', () => {
    expect(renderCommand('lsmod', {})).toBe('lsmod');
  });

  it('buildCommand 一次给全：命令 + 每个参数的编码片段（审计要记参数）', () => {
    const result = buildCommand('run --fps {fps}', { fps: SCHEMA.fps! }, { fps: 30 });
    expect(result.command).toBe('run --fps 30');
    expect(result.encoded).toEqual({ fps: '30' });
  });
});
