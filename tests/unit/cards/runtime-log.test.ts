import { describe, it, expect } from 'vitest';
import { CardRuntimeLog } from '../../../src/main/cards/runtime-log';

/**
 * 卡片的运行时日志。
 *
 * ── 最要紧的一条：CSP 违规要归到**对的那张卡** ──
 *
 * 契约 §6.1 承诺「agent 能看到『这张卡试图联网』」。
 * 但违规带来的是**实例 id**（`cockpit://card/<实例 id>/…`），
 * 而日志是**按卡片 id** 存的（`get_card_runtime_log(cardId)`）——
 * 所以中间必须有「实例 → 卡片」的对应。
 *
 * **归不出来就不记**：挂错卡的日志比没有日志更糟
 * （它会让 agent 去查一张**没做错事**的卡）。
 */
describe('卡片运行时日志', () => {
  it('追加与读取（按时间顺序）', () => {
    const log = new CardRuntimeLog({ now: () => 1000 });
    log.append('cpu-usage', { source: 'card', level: 'info', message: '第一句' });
    log.append('cpu-usage', { source: 'host', level: 'warn', message: '第二句' });
    const entries = log.read('cpu-usage');
    expect(entries.map((e) => e.message)).toEqual(['第一句', '第二句']);
    expect(entries[0]?.at).toBe(1000);
  });

  it('卡之间互不可见', () => {
    const log = new CardRuntimeLog();
    log.append('card-a', { source: 'card', level: 'info', message: 'A 的事' });
    expect(log.read('card-b')).toEqual([]);
  });

  it('CSP 违规归到**对的那张卡**', () => {
    const log = new CardRuntimeLog();
    log.bind('inst-1', 'cpu-usage');
    const cardId = log.attributeCspViolation({
      message: "Refused to connect to 'https://example.com/'",
      sourceUrl: 'cockpit://card/inst-1/index.html',
    });
    expect(cardId).toBe('cpu-usage');
    const entries = log.read('cpu-usage');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('csp');
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.message).toMatch(/example\.com/);
  });

  it('**归不出来就不记**（不认识的实例 / 不是卡片的地址）', () => {
    const log = new CardRuntimeLog();
    log.bind('inst-1', 'cpu-usage');
    expect(log.attributeCspViolation({ message: 'x', sourceUrl: 'cockpit://card/inst-9/x.js' })).toBeNull();
    expect(log.attributeCspViolation({ message: 'x', sourceUrl: 'https://example.com/a.js' })).toBeNull();
    expect(log.read('cpu-usage')).toEqual([]);
  });

  it('条目数有上限（超出丢最旧的）', () => {
    const log = new CardRuntimeLog({ limitPerCard: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.append('cpu-usage', { source: 'card', level: 'info', message: `第 ${i} 条` });
    }
    const entries = log.read('cpu-usage');
    expect(entries).toHaveLength(3);
    expect(entries[0]?.message).toBe('第 2 条');
  });
});
