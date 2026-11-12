# -*- coding: utf-8 -*-
"""Tests for the board pack contract.

The reader parsers, the binding rules and the pack validator are pure
functions over captured board output and over a pack file, so all three are
testable without a board.  The samples are verbatim from an
ATK-DLRK3588 running Linux 6.1.141.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "boardkit"))

from binding import bind, bind_all  # noqa: E402
from kinds import KINDS  # noqa: E402
from readers import (  # noqa: E402
    ERROR,
    OK,
    PENDING,
    UNAVAILABLE,
    parse,
    parse_devfreq_load,
    parse_exec_regex,
    parse_file_read,
    parse_meminfo,
    parse_proc_stat,
    parse_rknpu_load,
    parse_thermal_zones,
)
from vocabulary import CORE_TAGS, describe, matches_core  # noqa: E402
from validate import validate  # noqa: E402


# Verbatim /proc/stat from the board.
PROC_STAT = """cpu  25288 0 16570 41447116 2271 0 95 0 0 0
cpu0 15399 0 4709 5163405 26 0 41 0 0 0
cpu1 8455 0 5674 5163231 21 0 36 0 0 0
cpu2 449 0 2066 5187843 2116 0 1 0 0 0
cpu3 264 0 411 5186862 15 0 14 0 0 0
cpu4 56 0 128 5192852 17 0 0 0 0 0
cpu5 76 0 202 5192938 20 0 0 0 0 0
cpu6 87 0 2311 5190284 18 0 0 0 0 0
cpu7 490 0 1075 5191285 36 0 0 0 0 0
intr 22905608 0 83456 6706006 0 0 132 214486 0 0
ctxt 26784146
btime 1767225600
processes 3218
procs_running 1
procs_blocked 0
softirq 0 0 0 0 0 0 0 0 0 0 0
"""

PROC_CPUINFO = """processor	: 0
CPU implementer	: 0x41
CPU part	: 0xd05

processor	: 4
CPU implementer	: 0x41
CPU part	: 0xd0b
"""


# --------------------------------------------------------------------------
# proc_stat
# --------------------------------------------------------------------------

def test_first_sample_is_pending_not_zero():
    """CPU utilisation is a difference, so the first read has no baseline.

    Reporting 0 here would be the classic lie: the board looks idle when it
    has simply not been measured yet.
    """
    out = parse_proc_stat(PROC_STAT, PROC_CPUINFO)
    assert out["usage"]["status"] == PENDING
    assert out["usage"]["value"] is None
    assert out["core.0.usage"]["status"] == PENDING


def test_second_sample_computes_utilisation():
    prev = parse_proc_stat(PROC_STAT, PROC_CPUINFO)["_state"]
    later = PROC_STAT.replace("cpu  25288 0 16570 41447116",
                              "cpu  25288 0 16570 41448116")
    out = parse_proc_stat(later, PROC_CPUINFO, prev)
    assert out["usage"]["status"] == OK
    # 1000 extra idle ticks out of 1000 extra ticks: still 100% busy.
    assert out["usage"]["value"] == pytest.approx(0.0, abs=0.001)


def test_core_names_come_from_cpuinfo():
    out = parse_proc_stat(PROC_STAT, PROC_CPUINFO)
    assert out["core.0.cluster"]["value"] == "A55"
    assert out["core.4.cluster"]["value"] == "A76"


def test_eight_cores_are_found():
    out = parse_proc_stat(PROC_STAT, PROC_CPUINFO)
    indices = [int(k.split(".")[1]) for k in out
               if k.startswith("core.") and k.endswith(".usage")]
    assert sorted(indices) == list(range(8))


def test_a_parser_produces_samples_not_tags():
    """A reader kind must not name tags.

    The pack binds samples to tags; if a parser emitted tag names, two
    readers of different kinds would collide on the same key.
    """
    out = parse_proc_stat(PROC_STAT, PROC_CPUINFO)
    for key in out:
        if key.startswith("_"):
            continue
        assert not key.startswith("cpu.")
        assert not key.startswith("gpu.")
        assert not key.startswith("npu.")


# --------------------------------------------------------------------------
# meminfo
# --------------------------------------------------------------------------

def test_meminfo_reports_used_and_percentage():
    out = parse_meminfo("MemTotal:  8107744 kB\nMemAvailable: 4053872 kB\n")
    assert out["total_bytes"]["value"] == 8107744 * 1024
    assert out["used_bytes"]["value"] == (8107744 - 4053872) * 1024
    assert out["usage"]["value"] == pytest.approx(50.0, abs=0.01)


def test_meminfo_without_total_is_an_error():
    from readers import ReaderError
    with pytest.raises(ReaderError):
        parse_meminfo("garbage\n")


# --------------------------------------------------------------------------
# devfreq
# --------------------------------------------------------------------------

def test_devfreq_load_splits_duty_and_frequency():
    out = parse_devfreq_load("37@300000000Hz\n")
    assert out["duty"]["value"] == 37.0
    assert out["freq_hz"]["value"] == 300000000.0


def test_devfreq_load_rejects_garbage():
    from readers import ReaderError
    with pytest.raises(ReaderError):
        parse_devfreq_load("not a load line")


# --------------------------------------------------------------------------
# rknpu
# --------------------------------------------------------------------------

def test_rknpu_load_reports_every_core():
    out = parse_rknpu_load("NPU load:  Core0:  12%, Core1:   5%, Core2:   0%,\n")
    assert out["core.0.usage"]["value"] == 12.0
    assert out["core.1.usage"]["value"] == 5.0
    assert out["core.2.usage"]["value"] == 0.0
    # The aggregate is the maximum over the cores.
    assert out["usage"]["value"] == 12.0


# --------------------------------------------------------------------------
# thermal
# --------------------------------------------------------------------------

def test_thermal_zones_map_by_type_not_index():
    out = parse_thermal_zones(
        "soc-thermal=32384\ngpu-thermal=31461\nnpu-thermal=32384\n",
        {"soc-thermal": "soc", "gpu-thermal": "gpu", "npu-thermal": "npu"},
    )
    assert out["zone.soc"]["value"] == pytest.approx(32.384)
    assert out["zone.gpu"]["value"] == pytest.approx(31.461)
    assert "zone.npu" in out


def test_thermal_zones_ignore_unmapped_types():
    out = parse_thermal_zones("other-thermal=30000\n", {"soc-thermal": "soc"})
    assert out == {}


# --------------------------------------------------------------------------
# file_read / exec_regex
# --------------------------------------------------------------------------

def test_file_read_strips_trailing_nulls():
    out = parse_file_read("ATK-DLRK3588\x00", "string", strip_trailing_null=True)
    assert out["value"]["value"] == "ATK-DLRK3588"


def test_file_read_integer_reports_error_on_garbage():
    out = parse_file_read("not a number", "integer")
    assert out["value"]["status"] == ERROR


def test_exec_regex_takes_the_first_group():
    out = parse_exec_regex("1234.56  789\n", r"^([0-9.]+)", "float")
    assert out["value"]["value"] == pytest.approx(1234.56)


# --------------------------------------------------------------------------
# binding
# --------------------------------------------------------------------------

def test_a_binding_maps_a_sample_to_its_tag():
    value = {"status": OK, "value": 42.0}
    assert bind("usage", value, {"tag": "cpu.usage", "sample": "usage"}) == "cpu.usage"


def test_a_wildcard_binding_expands_per_instance():
    value = {"status": OK, "value": 42.0}
    concrete = bind("core.3.usage", value,
                    {"tag": "cpu.core.*.usage", "sample": "core.*.usage"})
    assert concrete == "cpu.core.3.usage"


def test_a_binding_does_not_match_the_wrong_sample():
    value = {"status": OK, "value": 42.0}
    assert bind("core.3.cluster", value,
                {"tag": "cpu.core.*.usage", "sample": "core.*.usage"}) is None


def test_a_binding_with_a_mismatched_wildcard_count_is_refused():
    value = {"status": OK, "value": 42.0}
    assert bind("usage", value,
                {"tag": "cpu.core.*.usage", "sample": "usage"}) is None


def test_an_unmatched_tag_is_unavailable_never_zero():
    out = bind_all({}, [{"tag": "gpu.usage", "sample": "duty"}])
    assert out["gpu.usage"]["status"] == UNAVAILABLE
    assert out["gpu.usage"]["value"] is None


def test_two_readers_cannot_collide_on_a_tag():
    """The same sample under two readers binds to two different tags."""
    a = bind_all({"duty": {"status": OK, "value": 37.0}},
                 [{"tag": "gpu.usage", "sample": "duty"}])
    b = bind_all({"duty": {"status": OK, "value": 37.0}},
                 [{"tag": "custom.rk3588-atk.npu.freq_hz", "sample": "duty"}])
    assert set(a) == {"gpu.usage"}
    assert set(b) == {"custom.rk3588-atk.npu.freq_hz"}


# --------------------------------------------------------------------------
# vocabulary
# --------------------------------------------------------------------------

def test_core_pattern_matching():
    assert matches_core("cpu.usage")
    assert matches_core("cpu.core.3.usage")
    assert matches_core("temp.soc")
    assert not matches_core("cpu.core.usage")
    assert not matches_core("nonsense")


def test_every_core_tag_carries_its_semantics():
    """describe_tag hands an agent the semantics; without them it is guessing."""
    for pattern, entry in CORE_TAGS.items():
        assert entry.get("semantics"), pattern
        assert entry.get("type"), pattern
        assert entry.get("unit") is not None, pattern


def test_describe_finds_a_concrete_instance():
    entry = describe("cpu.core.3.usage")
    assert entry is not None
    assert entry["pattern"] == "cpu.core.*.usage"
    assert entry["unit"] == "percent"


# --------------------------------------------------------------------------
# kind schemas
# --------------------------------------------------------------------------

def test_an_unknown_argument_is_an_error():
    """A misspelled argument that is ignored is how a pack starts lying."""
    kind = KINDS["proc_stat"]
    problems = kind.check_args({"stat_path": "/proc/stat", "statpath": "/x"})
    assert any("statpath" in p for p in problems)


def test_a_missing_required_argument_is_an_error():
    kind = KINDS["devfreq_load"]
    problems = kind.check_args({})
    assert any("path" in p for p in problems)


def test_a_type_map_is_a_map_not_a_string():
    kind = KINDS["thermal_zone"]
    problems = kind.check_args({"type_map": "soc"})
    assert problems
    assert not kind.check_args({"type_map": {"soc-thermal": "soc"}})


# --------------------------------------------------------------------------
# the shipped pack
# --------------------------------------------------------------------------

PACK_PATH = ROOT / "boards" / "rk3588-atk" / "board.yaml"


@pytest.fixture(scope="module")
def pack():
    return yaml.safe_load(PACK_PATH.read_text(encoding="utf-8"))


def test_the_shipped_pack_validates(pack):
    report = validate(pack)
    assert report.errors == [], report.errors


def test_every_reader_belongs_to_a_poll_group(pack):
    """A reader with no group has no round trip, so it would never be read."""
    members = set()
    for group in pack["poll_groups"]:
        members.update(group["readers"])
    for reader in list(pack["readers"]) + list(pack["custom"]):
        assert reader["id"] in members, reader["id"]


def test_the_shipped_pack_has_no_executing_readers(pack):
    """The shipped pack reads files only.

    A reader that runs code on the board is a privilege, and the reference
    pack has no need of one.
    """
    for reader in list(pack["readers"]) + list(pack["custom"]):
        assert reader["kind"] not in ("exec_regex", "script")


def test_the_shipped_pack_provides_the_core_quantities(pack):
    provided = set()
    for reader in list(pack["readers"]) + list(pack["custom"]):
        for binding in reader["provides"]:
            provided.add(binding["tag"])
    for tag in ("cpu.usage", "gpu.usage", "npu.usage", "mem.usage",
                "temp.soc", "board.model"):
        assert tag in provided


def test_the_shipped_pack_does_not_publish_a_duty_cycle_as_utilisation(pack):
    """The NPU devfreq file reads 100@1000000000Hz while the board is idle.

    Publishing that as npu.usage would show an idle board as 100% busy.
    """
    for reader in list(pack["readers"]) + list(pack["custom"]):
        if reader["kind"] != "devfreq_load":
            continue
        measure = (reader.get("args") or {}).get("measure")
        for binding in reader["provides"]:
            if binding["tag"].endswith(".usage"):
                assert measure == "utilization", (
                    f"{reader['id']} publishes {binding['tag']} but measures "
                    f"{measure}"
                )


def test_the_shipped_pack_keeps_npu_utilisation_off_devfreq(pack):
    util_readers = [
        r for r in pack["readers"]
        if any(b["tag"] == "npu.usage" for b in r["provides"])
    ]
    assert len(util_readers) == 1
    assert util_readers[0]["kind"] == "rknpu_load"


def test_every_action_has_a_readback(pack):
    for action in pack.get("actions") or []:
        readback = action.get("readback") or {}
        assert readback.get("tag") or readback.get("kind"), action["id"]


def test_destructive_actions_are_verifiable(pack):
    for action in pack.get("actions") or []:
        if action.get("danger") == "destructive":
            assert action.get("readback") or action.get("verify"), action["id"]


def test_no_action_reads_back_a_tag_the_pack_does_not_provide(pack):
    provided = set()
    for reader in list(pack["readers"]) + list(pack["custom"]):
        for binding in reader["provides"]:
            provided.add(binding["tag"])
    for action in pack.get("actions") or []:
        tag = (action.get("readback") or {}).get("tag")
        if tag:
            assert tag in provided, action["id"]
