# -*- coding: utf-8 -*-
"""Validate a board pack against the contract.

    python tools/boardkit/validate.py boards/rk3588-atk/board.yaml

The rules are those in ``docs/spec/02-board-pack.md``.  A pack that fails
here is rejected by the runtime before it is ever used, so the rules have to
be executable rather than prose.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - dependency check
    print("PyYAML is required: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)

sys.path.insert(0, str(Path(__file__).resolve().parent))

from binding import binding_patterns  # noqa: E402
from kinds import EXECUTING_KINDS, KINDS  # noqa: E402
from vocabulary import matches_core  # noqa: E402


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

class Report:
    """Collects errors and warnings."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def ok(self) -> bool:
        return not self.errors


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _readers(pack: dict) -> list[dict]:
    """Every reader in the pack, whether under ``readers`` or ``custom``."""
    return list(pack.get("readers") or []) + list(pack.get("custom") or [])


def _sample_matches(sample_pattern: str, kind_samples: list[str]) -> bool:
    """Whether a kind can produce the samples a binding asks for.

    A binding's sample pattern must line up with one of the kind's declared
    sample patterns: same number of segments, and every literal segment
    equal.
    """
    s_parts = sample_pattern.split(".")
    for candidate in kind_samples:
        c_parts = candidate.split(".")
        if len(c_parts) != len(s_parts):
            continue
        if all(c == "*" or c == s for c, s in zip(c_parts, s_parts)):
            return True
    return False


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def validate(pack: dict) -> Report:
    """Check a loaded pack.  ``report.ok()`` is the verdict."""
    report = Report()
    pack_id = pack.get("id", "")

    # -- structure
    if pack.get("apiVersion") != "devboard/v1":
        report.error(
            f"apiVersion is {pack.get('apiVersion')!r}, expected 'devboard/v1'"
        )
    if pack.get("kind") != "BoardPack":
        report.error(f"kind is {pack.get('kind')!r}, expected 'BoardPack'")
    if not pack_id:
        report.error("pack has no id")
    if not pack.get("version"):
        report.error("pack has no version")

    readers = _readers(pack)
    if not readers:
        report.error("pack provides no readers")

    # -- poll groups: every reader must be in exactly one
    groups = pack.get("poll_groups") or []
    group_of: dict[str, str] = {}
    for group in groups:
        gid = group.get("id", "?")
        members = group.get("readers") or []
        if not members:
            report.error(f"poll group {gid!r} lists no readers")
        interval = group.get("interval_ms")
        if not isinstance(interval, int):
            report.error(f"poll group {gid!r}: interval_ms must be an integer")
        elif interval < 200:
            report.error(
                f"poll group {gid!r}: interval_ms {interval} is below the "
                f"200ms floor"
            )
        for member in members:
            if member in group_of:
                report.error(
                    f"reader {member!r} is in poll groups "
                    f"{group_of[member]!r} and {gid!r}"
                )
            group_of[member] = gid

    # -- readers
    provided_by: dict[str, str] = {}
    reader_ids: set[str] = set()

    for reader in readers:
        rid = reader.get("id", "?")
        if rid in reader_ids:
            report.error(f"reader {rid!r} is declared twice")
        reader_ids.add(rid)

        if rid not in group_of:
            report.error(
                f"reader {rid!r} is in no poll group; every reader must say "
                f"which round trip it rides in"
            )

        kind_name = reader.get("kind")
        kind = KINDS.get(kind_name)
        if kind is None:
            report.error(
                f"reader {rid!r}: unknown kind {kind_name!r}; known kinds are "
                f"{', '.join(sorted(KINDS))}"
            )
            continue

        # -- arguments
        args = reader.get("args") or {}
        for problem in kind.check_args(args):
            report.error(f"reader {rid!r}: {problem}")

        if kind_name in EXECUTING_KINDS:
            report.warn(
                f"reader {rid!r}: kind {kind_name!r} executes code on the board"
            )

        # -- bindings
        bindings = reader.get("provides") or []
        if not bindings:
            report.error(f"reader {rid!r}: provides nothing")
        for binding in bindings:
            if not isinstance(binding, dict):
                report.error(
                    f"reader {rid!r}: each entry of provides must be a map with "
                    f"'tag' and 'sample'"
                )
                continue
            tag = binding.get("tag")
            sample = binding.get("sample")
            if not tag:
                report.error(f"reader {rid!r}: a binding has no tag")
                continue
            if not sample:
                report.error(f"reader {rid!r}: binding for {tag!r} has no sample")
                continue
            if tag.count("*") > 1:
                report.error(
                    f"reader {rid!r}: tag {tag!r} has more than one wildcard; "
                    f"a tag pattern may have at most one"
                )
            if sample.count("*") > 1:
                report.error(
                    f"reader {rid!r}: sample {sample!r} has more than one "
                    f"wildcard"
                )
            if ("*" in tag) != ("*" in sample):
                report.error(
                    f"reader {rid!r}: tag {tag!r} and sample {sample!r} must "
                    f"both have a wildcard or neither"
                )

            # -- the sample must be one the kind can produce
            if not _sample_matches(sample, kind.sample_patterns()):
                report.error(
                    f"reader {rid!r}: kind {kind_name!r} cannot produce the "
                    f"sample {sample!r}; it produces "
                    f"{', '.join(kind.sample_patterns())}"
                )

            # -- the tag must be in the vocabulary or the pack's own space
            if matches_core(tag):
                pass
            elif tag.startswith(f"custom.{pack_id}."):
                pass
            elif tag.startswith("custom."):
                report.error(
                    f"reader {rid!r}: tag {tag!r} is in custom.* but not in "
                    f"this pack's namespace custom.{pack_id}.*"
                )
            else:
                report.error(
                    f"reader {rid!r}: tag {tag!r} is in neither the core "
                    f"vocabulary nor custom.{pack_id}.*"
                )

            # -- no tag is provided twice
            if tag in provided_by:
                report.error(
                    f"tag {tag!r} is provided by both {provided_by[tag]!r} "
                    f"and {rid!r}"
                )
            else:
                provided_by[tag] = rid

            # -- a duty cycle may not be published as a utilisation
            if kind_name == "devfreq_load":
                measure = args.get("measure")
                if measure == "duty_cycle" and tag.endswith(".usage"):
                    report.error(
                        f"reader {rid!r}: measure is duty_cycle but it binds "
                        f"{tag!r}, whose semantics are utilisation"
                    )
                if measure == "utilization" and tag.endswith(".usage"):
                    pass
                elif measure is None and tag.endswith(".usage"):
                    report.error(
                        f"reader {rid!r}: binds {tag!r} but does not say "
                        f"whether the measurement is a utilisation or a duty "
                        f"cycle"
                    )

    # -- a proc_stat reader must provide the aggregate
    for reader in readers:
        if reader.get("kind") != "proc_stat":
            continue
        tags = binding_patterns(reader.get("provides") or [])
        if "cpu.usage" not in tags:
            report.error(
                f"reader {reader.get('id')!r}: a proc_stat reader must bind "
                f"the sample 'usage' to the tag 'cpu.usage'"
            )

    # -- actions
    action_ids: set[str] = set()
    for action in pack.get("actions") or []:
        aid = action.get("id", "?")
        if aid in action_ids:
            report.error(f"action {aid!r} is declared twice")
        action_ids.add(aid)

        danger = action.get("danger")
        if danger not in ("reversible", "destructive"):
            report.error(
                f"action {aid!r}: danger is {danger!r}, expected 'reversible' "
                f"or 'destructive'"
            )

        command = action.get("command", "")
        used = set(re.findall(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", command))
        declared = set((action.get("params") or {}).keys())

        for name in sorted(used - declared):
            report.error(
                f"action {aid!r}: command uses {{{name}}} but it is not "
                f"declared in params"
            )
        for name in sorted(declared - used):
            report.error(
                f"action {aid!r}: param {name!r} is declared but never used in "
                f"the command"
            )

        # -- the readback must point at something this pack provides
        readback = action.get("readback") or {}
        tag = readback.get("tag")
        if tag:
            if tag not in provided_by:
                report.error(
                    f"action {aid!r}: readback tag {tag!r} is not provided by "
                    f"this pack"
                )
        elif "kind" not in readback:
            report.error(f"action {aid!r}: readback has neither a tag nor a kind")

        if danger == "destructive" and not (tag or readback.get("kind")):
            report.error(
                f"action {aid!r}: a destructive action needs a readback or a "
                f"verify block"
            )

        for name, spec in (action.get("params") or {}).items():
            if not isinstance(spec, dict):
                report.error(
                    f"action {aid!r}: param {name!r} must be a map"
                )
                continue
            ptype = spec.get("type")
            if ptype not in ("integer", "float", "string", "boolean", "enum"):
                report.error(
                    f"action {aid!r}: param {name!r} has type {ptype!r}, "
                    f"which is not one of integer/float/string/boolean/enum"
                )
            if ptype == "enum" and not spec.get("values"):
                report.error(
                    f"action {aid!r}: param {name!r} is an enum but declares no "
                    f"values"
                )

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", help="path to a board.yaml")
    args = parser.parse_args(argv)

    path = Path(args.pack)
    if not path.exists():
        print(f"no such file: {path}", file=sys.stderr)
        return 2

    try:
        pack = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"cannot parse {path}: {exc}", file=sys.stderr)
        return 2

    report = validate(pack)
    for message in report.errors:
        print(f"ERROR  {message}")
    for message in report.warnings:
        print(f"WARN   {message}")

    if report.ok():
        readers = _readers(pack)
        tags = sorted(binding_patterns(
            binding for reader in readers
            for binding in (reader.get("provides") or [])
        ))
        print(f"OK     {path} — {len(readers)} readers, {len(tags)} tags, "
              f"{len(pack.get('actions') or [])} actions")
        for tag in tags:
            print(f"         {tag}")
        return 0

    print(f"\n{len(report.errors)} error(s), {len(report.warnings)} warning(s)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
