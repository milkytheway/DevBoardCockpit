# -*- coding: utf-8 -*-
"""Reader implementations.

Each reader kind is a *function* from (raw output, previous state) to a dict
of **sample name** -> {status, value}.  It never produces a tag name: the
pack binds samples to tags (see ``binding.py``).  That separation is what
lets one kind serve several boards under different names, and it is what
stops two readers of different kinds from colliding on a tag.

Nothing in this module talks to a board.  It only knows how to turn bytes
into numbers, which is what makes it testable without hardware.
"""

from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------------------
# status values, as defined in docs/spec/01-tag-contract.md
# --------------------------------------------------------------------------

OK = "ok"
STALE = "stale"
UNAVAILABLE = "unavailable"
ERROR = "error"
PENDING = "pending"


class ReaderError(Exception):
    """The data could not be read or understood."""


def _section(text: str, name: str) -> str:
    """Pull one ``###NAME`` section out of a combined output."""
    match = re.search(
        rf"^###{name}\s*$(.*?)^###", text, re.MULTILINE | re.DOTALL
    )
    return match.group(1) if match else ""


def _leading_ints(tokens: list[str]) -> list[int]:
    """Parse tokens as integers, stopping at the first non-numeric one.

    ``/proc/stat`` mixes counts with named fields on some kernels, so a blind
    ``int()`` over the whole tail would raise.
    """
    out: list[int] = []
    for token in tokens:
        if not token.isdigit():
            break
        out.append(int(token))
    return out


def _as_number(raw: str) -> float:
    """Parse a number out of a raw value, raising ReaderError if it is not one."""
    match = re.search(r"-?\d+(?:\.\d+)?", raw.strip())
    if not match:
        raise ReaderError(f"not a number: {raw!r}")
    return float(match.group(0))


def _unavailable(reason: str) -> dict:
    return {"status": UNAVAILABLE, "value": None, "detail": reason}


def _error(reason: str) -> dict:
    return {"status": ERROR, "value": None, "detail": reason}


# --------------------------------------------------------------------------
# kind: proc_stat
# --------------------------------------------------------------------------

#: ARMv8 CPU part identifiers, for the cluster name.
CPU_PART_NAMES = {
    0xD05: "A55",
    0xD0B: "A76",
}


def parse_proc_stat(stat_text: str, cpuinfo_text: str,
                    prev: dict | None = None) -> dict:
    """Parse ``/proc/stat`` and ``/proc/cpuinfo``.

    CPU utilisation is a *difference* between two samples, so the first
    sample yields ``pending`` -- there is no baseline to compare against yet.
    That is why ``cpu.usage`` cannot be produced by a single round trip.

    Produces the samples ``usage``, ``core.<i>.usage`` and ``core.<i>.cluster``.
    """
    total = (0, 0)
    cores: dict[int, tuple[int, int]] = {}

    for line in stat_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("cpu "):
            nums = _leading_ints(stripped.split()[1:])
            if len(nums) >= 4:
                # /proc/stat order: user nice system idle iowait irq softirq
                # Busy is user+nice+system; idle must be excluded or the board
                # looks permanently 100% busy.
                total = (sum(nums[:3]), sum(nums))
        elif stripped.startswith("cpu"):
            parts = stripped.split()
            tag = parts[0]
            if len(tag) < 4 or not tag[3:].isdigit():
                continue
            nums = _leading_ints(parts[1:])
            if len(nums) >= 4:
                cores[int(tag[3:])] = (sum(nums[:3]), sum(nums))

    # -- core names, joined by index
    names: dict[int, str] = {}
    index = -1
    for line in cpuinfo_text.splitlines():
        if line.startswith("processor"):
            try:
                index = int(line.split(":")[1].strip())
            except (IndexError, ValueError):
                index = -1
        elif line.startswith("CPU part") and index >= 0:
            match = re.search(r"0x([0-9a-fA-F]+)", line)
            if match:
                part = int(match.group(1), 16)
                names[index] = CPU_PART_NAMES.get(part, f"cpu{match.group(1)}")

    out: dict[str, Any] = {}

    if prev is None:
        out["usage"] = {"status": PENDING, "value": None,
                        "detail": "waiting for a second sample"}
        for i in sorted(cores):
            out[f"core.{i}.usage"] = {
                "status": PENDING, "value": None,
                "detail": "waiting for a second sample",
            }
    else:
        prev_total = prev["total"]
        busy_delta = total[0] - prev_total[0]
        total_delta = total[1] - prev_total[1]
        if total_delta > 0:
            out["usage"] = {
                "status": OK,
                "value": max(0.0, min(100.0, busy_delta / total_delta * 100.0)),
            }
        else:
            out["usage"] = _error("the counters did not move")

        prev_cores = prev["cores"]
        for i in sorted(cores):
            busier, all_ticks = cores[i]
            before = prev_cores.get(i)
            if before is None:
                out[f"core.{i}.usage"] = _unavailable("the core appeared")
                continue
            d_busy = busier - before[0]
            d_total = all_ticks - before[1]
            if d_total > 0:
                pct = max(0.0, min(100.0, d_busy / d_total * 100.0))
                out[f"core.{i}.usage"] = {"status": OK, "value": pct}
            else:
                out[f"core.{i}.usage"] = _error("the counters did not move")

    for i, name in names.items():
        out[f"core.{i}.cluster"] = {"status": OK, "value": name}

    out["_state"] = {"total": total, "cores": cores}
    return out


# --------------------------------------------------------------------------
# kind: meminfo
# --------------------------------------------------------------------------

def parse_meminfo(text: str) -> dict:
    """Parse ``/proc/meminfo``.

    ``MemAvailable`` is used rather than ``MemFree`` because it accounts for
    reclaimable page cache, which is what a person means by "used".

    Produces ``total_bytes``, ``used_bytes`` and ``usage``.
    """
    total = available = 0
    for line in text.splitlines():
        if line.startswith("MemTotal:"):
            total = int(line.split()[1])
        elif line.startswith("MemAvailable:"):
            available = int(line.split()[1])
    if not total:
        raise ReaderError("MemTotal not found")
    # /proc/meminfo is in kB
    used = total - available
    return {
        "total_bytes": {"status": OK, "value": total * 1024},
        "used_bytes": {"status": OK, "value": used * 1024},
        "usage": {"status": OK, "value": used / total * 100.0},
    }


# --------------------------------------------------------------------------
# kind: devfreq_load
# --------------------------------------------------------------------------

_DEVFREQ_RE = re.compile(r"(\d+)@(\d+)Hz")


def parse_devfreq_load(text: str) -> dict:
    """Parse a devfreq ``load`` file, e.g. ``37@300000000Hz``.

    Produces the samples ``duty`` and ``freq_hz``.

    The first number is the *duty cycle*.  Whether that is the utilisation
    depends on the driver, which is why the pack says which it is and the
    pack binds the sample accordingly.  This function does not decide.
    """
    match = _DEVFREQ_RE.search(text.strip())
    if not match:
        raise ReaderError(f"not a devfreq load line: {text.strip()!r}")
    return {
        "duty": {"status": OK, "value": float(match.group(1))},
        "freq_hz": {"status": OK, "value": float(match.group(2))},
    }


# --------------------------------------------------------------------------
# kind: rknpu_load
# --------------------------------------------------------------------------

_RKNPU_RE = re.compile(r"Core(\d+):\s*(\d+)%")


def parse_rknpu_load(text: str) -> dict:
    """Parse the Rockchip NPU debugfs load file.

    Format::

        NPU load:  Core0: 12%, Core1: 9%

    Produces ``usage`` (the maximum over the cores) and ``core.<i>.usage``.
    """
    values = [float(v) for _, v in _RKNPU_RE.findall(text)]
    if not values:
        raise ReaderError("no core load found")
    out: dict[str, Any] = {
        "usage": {"status": OK, "value": max(values)},
    }
    for match in _RKNPU_RE.finditer(text):
        out[f"core.{match.group(1)}.usage"] = {
            "status": OK,
            "value": float(match.group(2)),
        }
    return out


# --------------------------------------------------------------------------
# kind: thermal_zone
# --------------------------------------------------------------------------

def parse_thermal_zones(text: str, type_map: dict[str, str]) -> dict:
    """Parse ``<type>=<millidegrees>`` lines.

    The mapping is by the zone's ``type`` file, never by the zone's index --
    the index differs between boards and even between kernel versions.

    Produces one sample per mapped zone, named ``zone.<mapped name>``.
    """
    out: dict[str, Any] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        name, _sep, value = line.partition("=")
        name = name.strip()
        value = value.strip()
        if not name or not value:
            continue
        mapped = type_map.get(name)
        if not mapped:
            continue
        try:
            out[f"zone.{mapped}"] = {
                "status": OK, "value": float(value) / 1000.0,
            }
        except ValueError:
            continue
    return out


# --------------------------------------------------------------------------
# kind: file_read
# --------------------------------------------------------------------------

def parse_file_read(text: str, fmt: str = "string",
                    strip_trailing_null: bool = False) -> dict:
    """Read a whole file as one value.  Produces the sample ``value``."""
    text = text.strip()
    if strip_trailing_null:
        # The device-tree files end with a NUL, and it comes *before* the
        # newline.  Stripping the whitespace first and the NUL second is the
        # only order that removes both.
        text = text.rstrip("\x00").strip()
    if fmt in ("integer", "float"):
        try:
            return {"value": {"status": OK, "value": _as_number(text)}}
        except ReaderError as exc:
            return {"value": _error(str(exc))}
    return {"value": {"status": OK, "value": text}}


# --------------------------------------------------------------------------
# kind: exec_regex
# --------------------------------------------------------------------------

def parse_exec_regex(text: str, pattern: str, fmt: str = "string") -> dict:
    """Take the first regex match out of a command's output.

    Produces the sample ``value``.
    """
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        return {"value": _error("the pattern did not match")}
    raw = match.group(1) if match.groups() else match.group(0)
    if fmt in ("integer", "float"):
        try:
            return {"value": {"status": OK, "value": _as_number(raw)}}
        except ReaderError as exc:
            return {"value": _error(str(exc))}
    return {"value": {"status": OK, "value": raw.strip()}}


# --------------------------------------------------------------------------
# kind: script
# --------------------------------------------------------------------------

def parse_script(text: str) -> dict:
    """Parse a script's JSON output.  Its keys are the sample names."""
    import json

    try:
        data = json.loads(text)
    except Exception as exc:
        raise ReaderError(f"the script did not print JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ReaderError("the script must print a JSON object")
    out: dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(value, bool):
            out[key] = {"status": OK, "value": value}
        elif isinstance(value, (int, float)):
            out[key] = {"status": OK, "value": float(value)}
        else:
            out[key] = {"status": OK, "value": value}
    return out


# --------------------------------------------------------------------------
# the parsers, by kind
# --------------------------------------------------------------------------

def parse(kind: str, text: str, args: dict, state: dict | None = None) -> dict:
    """Run the parser for a kind over the raw text of its section."""
    if kind == "proc_stat":
        return parse_proc_stat(
            _section(text, "STAT"), _section(text, "INFO"), state
        )
    if kind == "meminfo":
        return parse_meminfo(text)
    if kind == "devfreq_load":
        return parse_devfreq_load(text)
    if kind == "rknpu_load":
        return parse_rknpu_load(text)
    if kind == "thermal_zone":
        return parse_thermal_zones(text, args.get("type_map") or {})
    if kind == "file_read":
        return parse_file_read(
            text, args.get("format", "string"),
            args.get("strip_trailing_null", False),
        )
    if kind == "exec_regex":
        return parse_exec_regex(
            text, args.get("pattern", r"(.+)"), args.get("format", "string"),
        )
    if kind == "script":
        return parse_script(text)
    raise ReaderError(f"no parser for kind {kind!r}")
