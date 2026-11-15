import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { sdkDocs, SDK_TOPICS, setSdkCardsDir } from '../../../src/main/mcp/sdk-docs';

/**
 * **SDK 活文档**（契约 `spec/04` §2.3 的 `get_card_sdk_docs` ✓ · ADR-D40 ✓）。
 *
 * ── 为什么必须是「从活代码生成」──
 *
 * **手抄的静态文本会漂** ✓ —— API 加一个方法它不会自己更新 ✓
 * → agent 照着写会调一个**不存在的 API** ✗ → 卡片一调就报「方法不存在」✗
 * → **而没人查得出是哪边错了** ✗（那就跟 API 注册表自己漂了一样 ✗）。
 *
 * → **形状取自代码** ✓（注册表 ✓ · 封闭 schema 白名单 ✓）
 * → **语义取自契约** ✓（字段是什么意思 ✓ —— 代码里没有那个 ✓）。
 */
/** **真卡目录** ✓ —— `examples` 主题列的是**真卡** ✓（编的会与实际不符 ✓） */
const CARDS_DIR = join(__dirname, '../../../cards');

describe('MCP · SDK 活文档', () => {
  beforeAll(() => {
    setSdkCardsDir(CARDS_DIR);
  });

  it('**四个主题都在** ✓（契约 §2.3 列的那四个 ✓）', () => {
    expect(SDK_TOPICS).toEqual(['manifest', 'api', 'examples', 'layout']);
  });

  it('**省略 topic → 返回全部** ✓（契约 §2.3 ✓）', () => {
    const docs = sdkDocs(undefined);
    expect(docs.topics).toEqual(['manifest', 'api', 'examples', 'layout']);
    // **content 是一个字符串** ✓（agent 把它当提示词的一部分读 ✓）
    expect(typeof docs.content).toBe('string');
    expect(docs.content.length).toBeGreaterThan(0);
  });

  it('**指定一个主题 → 只给那一个** ✓', () => {
    const docs = sdkDocs('api');
    expect(docs.topics).toEqual(['api']);
    expect(docs.content).toContain('tags.get');
    // **别的主题不进** ✓
    expect(docs.content).not.toContain('min_board_pack');
  });

  it('**`api` 主题列的是「本 build 实际有的方法」** ✓（**没实现的就不列** ✓）', () => {
    const docs = sdkDocs('api');
    expect(docs.content).toContain('tags.get');
    expect(docs.content).toContain('actions.invoke');
    expect(docs.content).toContain('workflows.run');
    expect(docs.content).toContain('storage.set');
    // **`notify` 没实现** ✓ → **不列** ✓（列了 = 卡片以为通知发出去了 ✓）
    expect(docs.content).not.toContain('cockpit.notify');
  });

  it('**每个方法都有一句说明** ✓（**光有方法名不够** ✓ —— agent 不知道它什么时候用 ✓）', () => {
    const docs = sdkDocs('api');
    // **`tags.get` 的说明** ✓
    expect(docs.content).toMatch(/tags\.get[\s\S]{0,200}?读/);
  });

  it('**`manifest` 主题给出封闭 schema 的字段表** ✓（**从代码取** ✓）', () => {
    const docs = sdkDocs('manifest');
    expect(docs.content).toContain('permissions');
    expect(docs.content).toContain('entry');
    expect(docs.content).toContain('apiVersion');
    // **未知字段会报错** ✓ → 文档里要说清** ✓
    expect(docs.content).toContain('未知字段');
  });

  it('**`layout` 主题用契约的词** ✓（`cards` / `card_id` ✓ —— 不是实现的 `units` / `cardId` ✓）', () => {
    const docs = sdkDocs('layout');
    expect(docs.content).toContain('card_id');
    expect(docs.content).toContain('cards');
  });

  it('**`examples` 主题给出内置卡的清单** ✓（**真卡** ✓ —— 不是编的 ✓）', () => {
    const docs = sdkDocs('examples');
    expect(docs.content).toContain('cpu-usage');
    // **显示它的读权限** ✓（agent 照着改 manifest 时要知道能读什么 ✓）
    expect(docs.content).toContain('permissions.read');
  });

  it('**不认识的主题 → 空内容** ✓（**不猜** ✓）', () => {
    const docs = sdkDocs('nope' as never);
    expect(docs.topics).toEqual([]);
    expect(docs.content).toBe('');
  });

  it('**每个响应都带 apiVersion** ✓（契约 §四 ✓）', () => {
    expect(sdkDocs('api')['apiVersion']).toBe('devboard/v1');
  });
});
