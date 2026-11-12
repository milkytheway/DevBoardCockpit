# -*- coding: utf-8 -*-
"""The core tag vocabulary.

This file is the **authority** for the vocabulary.  ``docs/spec/01`` shows
it; this is what the pack validator, the card validator and the runtime's
``describe_tag`` all read, so they cannot drift apart.

A pattern's ``*`` matches exactly one segment.
"""

from __future__ import annotations

#: pattern -> (type, unit, low, high, semantics)
#:
#: ``semantics`` is not decoration.  It is what ``describe_tag`` returns to
#: an AI agent, and it is the only thing that stops "npu.usage" from being
#: read as any vague notion of NPU load.
CORE_TAGS: dict[str, dict] = {
    "cpu.usage": {
        "type": "number", "unit": "percent", "range": [0, 100],
        "semantics": "过去 1 秒内，所有 CPU 核心执行非空闲指令的时间占比。"
                     "读不到时报告 unavailable，绝不报告 0。",
    },
    "cpu.core.*.usage": {
        "type": "number", "unit": "percent", "range": [0, 100],
        "semantics": "过去 1 秒内，单个 CPU 核心执行非空闲指令的时间占比。",
    },
    "cpu.core.*.cluster": {
        "type": "string", "unit": "-", "range": None,
        "semantics": "CPU 核心所属的簇名，如 A55 / A76。名称集合随 SoC 变化，"
                     "是开放枚举；未知名字按字符串原样上报，不算读取失败。",
    },
    "gpu.usage": {
        "type": "number", "unit": "percent", "range": [0, 100],
        "semantics": "过去 1 秒内 GPU 执行非空闲指令的时间占比。"
                     "注意：某些驱动的 devfreq load 文件给的是时钟占空比而非"
                     "利用率，板型包必须声明 measure=utilization 才可绑定本 tag。",
    },
    "gpu.freq_hz": {
        "type": "number", "unit": "hertz", "range": [0, None],
        "semantics": "GPU 当前工作频率，单位 Hz。",
    },
    "npu.usage": {
        "type": "number", "unit": "percent", "range": [0, 100],
        "semantics": "过去 1 秒内 NPU 各计算核利用率的**最大值**。"
                     "不是时钟占空比：空闲的板子读 0，不是 100。",
    },
    "npu.core.*.usage": {
        "type": "number", "unit": "percent", "range": [0, 100],
        "semantics": "过去 1 秒内单个 NPU 计算核的利用率。",
    },
    "mem.total_bytes": {
        "type": "number", "unit": "byte", "range": [1, None],
        "semantics": "物理内存总量，单位字节。",
    },
    "mem.used_bytes": {
        "type": "number", "unit": "byte", "range": [0, None],
        "semantics": "已用内存 = MemTotal - MemAvailable。含可回收的 page cache。",
    },
    "mem.usage": {
        "type": "number", "unit": "percent", "range": [0, 100],
        "semantics": "已用内存占物理内存总量的百分比。",
    },
    "temp.soc": {
        "type": "number", "unit": "celsius", "range": None,
        "semantics": "SoC 核心温度，按 thermal zone 的 type 文件归并，"
                     "不依赖 zone 序号。",
    },
    "temp.gpu": {
        "type": "number", "unit": "celsius", "range": None,
        "semantics": "GPU 温度，按 thermal zone 的 type 文件归并。",
    },
    "temp.npu": {
        "type": "number", "unit": "celsius", "range": None,
        "semantics": "NPU 温度，按 thermal zone 的 type 文件归并。",
    },
    "board.model": {
        "type": "string", "unit": "-", "range": None,
        "semantics": "板子的型号字符串，用于自动识别板型包。",
    },
    "board.kernel": {
        "type": "string", "unit": "-", "range": None,
        "semantics": "运行中的内核版本字符串。",
    },
    "backlight.brightness": {
        "type": "number", "unit": "level", "range": [0, 255],
        "semantics": "背光亮度档位，取值 0-255，具体刻度由板子决定。",
    },
    "net.rx_bytes": {
        "type": "number", "unit": "byte", "range": [0, None],
        "semantics": "自启动以来累计接收的字节数。",
    },
    "net.tx_bytes": {
        "type": "number", "unit": "byte", "range": [0, None],
        "semantics": "自启动以来累计发送的字节数。",
    },
    "disk.*.free_bytes": {
        "type": "number", "unit": "byte", "range": [0, None],
        "semantics": "某个挂载点所在文件系统的可用字节数。",
    },
    "disk.*.total_bytes": {
        "type": "number", "unit": "byte", "range": [0, None],
        "semantics": "某个挂载点所在文件系统的总字节数。",
    },
}

#: Tag names outside the core vocabulary that a pack may publish.
#: The prefix is ``custom.<pack id>.`` and the rest may have any number of
#: segments -- the pack id itself may contain hyphens, so the match is on
#: the literal prefix, not on a segment pattern.
CUSTOM_PREFIX = "custom."


def matches_core(tag: str) -> bool:
    """Whether a tag name matches the core vocabulary."""
    for pattern in CORE_TAGS:
        if pattern == tag:
            return True
        if "*" in pattern:
            p_parts = pattern.split(".")
            t_parts = tag.split(".")
            if len(p_parts) == len(t_parts) and all(
                p == "*" or p == t for p, t in zip(p_parts, t_parts)
            ):
                return True
    return False


def describe(tag: str) -> dict | None:
    """The vocabulary entry for a tag, if it has one."""
    for pattern, entry in CORE_TAGS.items():
        if pattern == tag:
            return {"pattern": pattern, **entry}
        if "*" in pattern:
            p_parts = pattern.split(".")
            t_parts = tag.split(".")
            if len(p_parts) == len(t_parts) and all(
                p == "*" or p == t for p, t in zip(p_parts, t_parts)
            ):
                return {"pattern": pattern, **entry}
    return None


def is_custom(tag: str) -> bool:
    return tag.startswith(CUSTOM_PREFIX)
