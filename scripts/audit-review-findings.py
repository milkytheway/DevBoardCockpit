# 评审发现分类与落地核查（可复跑）
#
# 用途：核实两轮评审的每一条发现是否已经落到设计里。
# 两份评审共 117 条（07 的 78 + 08 的 39）。这个脚本做两件事：
#   1. 统计两份报告里的发现编号，确认总数；
#   2. 按「A 结构缺口 / B 语义机制 / C 表述卫生」三类互斥归类，确认求和 = 总数。
#
# 用法（在仓库根目录）：
#   python3 scripts/audit-review-findings.py
#
# 它只读文档，不改任何东西。改了分类就要改本文件里的 SETS，
# 而分类判据写在 docs/09-总设计.md §4.3。
#
# ⚠️ 这不是实现代码，是文档核查工具——不参与构建，不进 src/。

import re
import sys

REVIEW_07 = 'docs/07-评审报告.md'
REVIEW_08 = 'docs/08-独立评审-k3.1pro.md'

# ── A 结构缺口：需要改契约/架构的「形状」 ──────────────────────────
#    新增字段、接口、目录、分层，或缺失一整块（Stream、capability 词汇表……）
A_STRUCT = {
    'P0-3',    # MCP 传输形态三方冲突
    'P0-5',    # 卡片沙箱存储承诺兑现不了
    'P1-3',    # 能力层词汇三层三套
    'P1-9',    # 连接 profile 没有契约
    'P1-13',   # 用户级 profiles 目录被丢
    'P1-15',   # Stream 契约完全缺失
    'P1-16',   # manifest 无连接绑定字段
    'P1-28',   # 卡片根目录单根 vs 双根
    'P3-5',    # gpu.usage 豁免依据只有一次读数
    'K-P0-4',  # 契约 / 设计 / ADR 三方矛盾
    'K-P1-7',  # 悬空引用（verify / format / type / enum / tolerance）
    'K-P1-16', # 从 Markdown 表格生成 TS 不成立
    'K-P2-14', # capabilities 归属
    'K-P2-16', # 版本与向后兼容规则
}

# ── C 表述与卫生：只影响引用、计数、编号、措辞、样本、缓存残留 ──────
C_HYGIENE = {
    'P0-2', 'P2-1', 'P2-2', 'P2-3', 'P2-4', 'P2-5', 'P2-6', 'P2-7', 'P2-8',
    'P2-9', 'P2-10', 'P2-11', 'P2-12', 'P2-13', 'P2-16', 'P2-18', 'P2-20',
    'P3-8', 'P3-11', 'P3-15', 'P3-17',
    'K-P2-1', 'K-P2-2', 'K-P2-3', 'K-P2-4', 'K-P2-7', 'K-P2-10', 'K-P2-11',
    'K-P2-12', 'K-P2-13', 'K-P2-15',
    'K-P3-1', 'K-P3-2', 'K-P3-3', 'K-P3-4', 'K-P3-5', 'K-P3-6', 'K-P3-7',
    'K-P3-8', 'K-P3-9', 'K-P3-10', 'K-P3-11', 'K-P3-12', 'K-P3-13',
}


def find_ids(text, prefix):
    """一份评审里的发现编号。三种形态都要抓：
       ### P0-1 · 标题  /  **P1-5 · 标题**  /  | P2-3 | ... | 表格行
    """
    ids = set(re.findall(r'^### (' + prefix + r'[0-3]-\d+) ·', text, re.M))
    ids |= set(re.findall(r'^\*\*(' + prefix + r'[0-3]-\d+) ·', text, re.M))
    ids |= set(re.findall(r'^\| (' + prefix + r'[0-3]-\d+) \|', text, re.M))
    return ids


def main():
    t07 = open(REVIEW_07, encoding='utf-8').read()
    t08 = open(REVIEW_08, encoding='utf-8').read()

    ids07 = find_ids(t07, 'P')
    ids08 = find_ids(t08, 'K-P')
    total = ids07 | ids08

    a = A_STRUCT & total
    c = C_HYGIENE & total
    b = total - a - c

    print(f'07 发现：{len(ids07)} 条')
    print(f'08 发现：{len(ids08)} 条')
    print(f'合计    ：{len(total)} 条')
    print()
    print(f'A 结构缺口    ：{len(a):3d}')
    print(f'B 语义与机制  ：{len(b):3d}')
    print(f'C 表述与卫生  ：{len(c):3d}')
    print(f'求和          ：{len(a) + len(b) + len(c):3d}')

    problems = []
    if len(a) + len(b) + len(c) != len(total):
        problems.append('分类不互斥或不完备')
    phantom = (A_STRUCT | C_HYGIENE) - total
    if phantom:
        problems.append(f'分类里引用了不存在的编号：{sorted(phantom)}')

    if problems:
        print()
        for p in problems:
            print('✗', p)
        return 1

    print()
    print('✓ 分类互斥且完备，求和等于发现总数')
    return 0


if __name__ == '__main__':
    sys.exit(main())
