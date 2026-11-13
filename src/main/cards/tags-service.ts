import type { ReasonCode, TagReading } from '../../shared/tag-reading';
import { matchTagPattern } from '../tags/vocabulary';
import { permissionCovers, type CardPermissions } from './permissions';

/**
 * 卡片的**读侧**：读数、列表、订阅、降级。
 *
 * ── 这是权限过滤真正发生的地方 ──
 *
 * 页面与 bridge 都**不判权限**（它们是不可信的一侧）。
 * 每一次读、每一次推送，都要过这里的 `permissionCovers`。
 *
 * ── 两条铁律 ──
 *
 * 1. **没权限的 tag 读不到，而且看不出它存不存在**
 *    ——返回的形状与「本来就没有」**一模一样**。
 *    否则卡片可以拿「读得到 / 读不到」当**探测通道**，
 *    把板子上所有 tag 名一个一个试出来。
 * 2. **通配订阅每次推送都要再判一次**
 *    ——订阅时判一次不够：推送是**每次**发生的。
 */
export interface TagsServiceDeps {
  /** 当前全部读数（来自 TagStore，ADR-D22） */
  readings: () => TagReading[];
  /** 听读数变化 */
  subscribe: (cb: (r: TagReading) => void) => () => void;
  now: () => number;
}

export class TagsService {
  constructor(
    private readonly perms: CardPermissions,
    private readonly deps: TagsServiceDeps,
  ) {}

  /**
   * 读一个 tag。
   *
   * **没有权限与没有这个 tag，长得一模一样**（信息隐藏）。
   */
  get(name: string): TagReading {
    if (!permissionCovers(this.perms, name)) return this.hidden(name);
    const found = this.deps.readings().find((r) => r.tag === name);
    if (found !== undefined) return found;
    return this.hidden(name);
  }

  /** 列出**有权限的**读数 */
  list(): TagReading[] {
    return this.deps.readings().filter((r) => permissionCovers(this.perms, r.tag));
  }

  /**
   * 订阅一个 tag。
   *
   * @param cb 收到读数时调它（宿主侧）
   * @returns 退订函数
   */
  subscribe(name: string, cb: (r: TagReading) => void): () => void {
    // 没权限 → **一个都不推**，而且**不留订阅**（省掉无用的推送）
    if (!permissionCovers(this.perms, name)) return () => undefined;
    return this.deps.subscribe((reading) => {
      // **每次推送再判一次**（铁律 2）
      if (reading.tag !== name) return;
      if (!permissionCovers(this.perms, reading.tag)) return;
      cb(reading);
    });
  }

  /** 订阅一个模式（契约 §7.1） */
  subscribePattern(pattern: string, cb: (r: TagReading) => void): () => void {
    if (!permissionCovers(this.perms, pattern)) return () => undefined;
    return this.deps.subscribe((reading) => {
      // **复用词表层那一个匹配器**（不自己写第二套——第二套迟早和第一套对不上）
      if (!matchTagPattern(pattern, reading.tag)) return;
      // **再判一次权限**（铁律 2）
      if (!permissionCovers(this.perms, reading.tag)) return;
      cb(reading);
    });
  }

  /**
   * 降级信息：哪些 tag 读不到、为什么。
   *
   * **只列有权限的**——否则这张表就成了存在性探测通道。
   */
  degradation(): { tag: string; reason: ReasonCode; detail: string }[] {
    return this.deps
      .readings()
      .filter((r) => permissionCovers(this.perms, r.tag))
      .filter((r) => r.status === 'unavailable' || r.status === 'error')
      .map((r) => ({
        tag: r.tag,
        reason: r.reason ?? 'device_absent',
        detail: r.detail ?? '',
      }));
  }

  /** 「看不到」的读数（形状与「本来就没有」一致） */
  private hidden(tag: string): TagReading {
    return {
      tag,
      value: null,
      unit: '',
      status: 'unavailable',
      reason: 'not_found',
      detail: '这张卡没有这个 tag 的读权限',
      at: this.deps.now(),
      seq: 0,
    };
  }
}
