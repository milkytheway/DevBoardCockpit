# -*- coding: utf-8 -*-
"""The reader kind registry.

This is the machine-readable form of the "kind reference" that
``docs/spec/02-board-pack.md`` section 2.4 calls part of the contract.
Every kind declares:

* ``args``       -- the arguments it accepts, and whether an unknown one is
                    an error (it always is: a misspelled argument that is
                    silently ignored is how a pack starts lying).
* ``samples``    -- the sample names it produces.  ``*`` marks a position
                    that varies (one entry per core, per zone, ...).
* ``stateful``   -- whether it needs two samples before it means anything.
* ``fetch``      -- how the data is got off the board, as shell fragments.

A kind produces *samples*, never tag names.  The pack binds samples to tags
(see ``binding.py``).  That separation is what lets one kind serve several
boards under different names.
"""

from __future__ import annotations

from typing import Callable


# --------------------------------------------------------------------------
# argument schemas
# --------------------------------------------------------------------------

class Arg:
    """One argument a kind accepts."""

    def __init__(self, kind: str, default=None, required: bool = False,
                 choices=None) -> None:
        self.kind = kind           # string | integer | float | bool | path
        self.default = default
        self.required = required
        self.choices = choices

    def check(self, name: str, value) -> list[str]:
        """Return the problems with this value.  Empty list means fine."""
        problems: list[str] = []
        if self.kind == "integer":
            if not isinstance(value, int) or isinstance(value, bool):
                problems.append(f"{name} must be an integer, got {value!r}")
        elif self.kind == "float":
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                problems.append(f"{name} must be a number, got {value!r}")
        elif self.kind == "bool":
            if not isinstance(value, bool):
                problems.append(f"{name} must be true or false, got {value!r}")
        elif self.kind == "string":
            if not isinstance(value, str):
                problems.append(f"{name} must be a string, got {value!r}")
        elif self.kind == "map":
            if not isinstance(value, dict):
                problems.append(
                    f"{name} must be a map of names to values, got {value!r}"
                )
            elif self.choices:
                for key in value:
                    if key not in self.choices:
                        problems.append(
                            f"{name} has key {key!r}; allowed keys are "
                            f"{', '.join(sorted(self.choices))}"
                        )
        if self.choices is not None and self.kind != "map":
            if value not in self.choices:
                problems.append(
                    f"{name} must be one of {', '.join(map(str, self.choices))}, "
                    f"got {value!r}"
                )
        return problems


# --------------------------------------------------------------------------
# the kinds
# --------------------------------------------------------------------------

class Kind:
    """One reader kind."""

    def __init__(self, name: str, args: dict[str, Arg], samples: list[str],
                 stateful: bool = False,
                 fetch: Callable[[dict], list[tuple[str, str]]] | None = None,
                 note: str = "") -> None:
        self.name = name
        self.args = args
        self.samples = samples
        self.stateful = stateful
        self.fetch = fetch
        self.note = note

    def check_args(self, args: dict) -> list[str]:
        """Check a pack's arguments against this kind's schema."""
        problems: list[str] = []
        for name in args:
            if name not in self.args:
                problems.append(
                    f"unknown argument {name!r}; this kind accepts "
                    f"{', '.join(sorted(self.args)) or '(none)'}"
                )
        for name, spec in self.args.items():
            if spec.required and name not in args:
                problems.append(f"argument {name!r} is required")
                continue
            if name in args:
                problems.extend(spec.check(name, args[name]))
        return problems

    def sample_patterns(self) -> list[str]:
        """The sample names this kind can produce, with ``*`` for the
        varying positions."""
        return list(self.samples)


# --------------------------------------------------------------------------
# fetch strategies
# --------------------------------------------------------------------------

def _shell_quote(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


def _fetch_proc_stat(args: dict) -> list[tuple[str, str]]:
    stat = args.get("stat_path", "/proc/stat")
    cpuinfo = args.get("cpuinfo_path", "/proc/cpuinfo")
    # One shell command, two sections.  The markers are what let the reader
    # tell the two apart without guessing.
    return [(
        "STAT",
        f"echo '###STAT'; cat {stat}; "
        f"echo '###INFO'; grep -E 'processor|CPU part' {cpuinfo}; "
        f"echo '###END'",
    )]


def _fetch_path(args: dict) -> list[tuple[str, str]]:
    path = args.get("path", "")
    if args.get("glob"):
        return [(
            "FILES",
            f'for f in {args["glob"]}; do '
            f'[ -r "$f" ] && echo "$f"; cat -- "$f" 2>/dev/null; done',
        )]
    return [("FILE", f"cat -- {path} 2>/dev/null || true")]


def _fetch_thermal(args: dict) -> list[tuple[str, str]]:
    glob = args.get("glob", "/sys/class/thermal/thermal_zone*")
    return [(
        "ZONES",
        f'for z in {glob}; do '
        f'[ -r "$z/type" ] && '
        f'echo "$(cat $z/type)=$(cat $z/temp 2>/dev/null)"; done',
    )]


def _fetch_devfreq(args: dict) -> list[tuple[str, str]]:
    return [("LOAD", f"cat -- {args.get('path', '')} 2>/dev/null || true")]


def _fetch_command(args: dict) -> list[tuple[str, str]]:
    return [("OUT", f"{args.get('command', '')} 2>/dev/null || true")]


KINDS: dict[str, Kind] = {    "proc_stat": Kind(
        name="proc_stat",
        args={
            "stat_path": Arg("string"),
            "cpuinfo_path": Arg("string"),
        },
        samples=["usage", "core.*.usage", "core.*.cluster"],
        stateful=True,
        fetch=_fetch_proc_stat,
        note="CPU utilisation is a difference between two samples, so the "
             "first read is 'pending'.",
    ),
    "meminfo": Kind(
        name="meminfo",
        args={"path": Arg("string")},
        samples=["total_bytes", "used_bytes", "usage"],
        fetch=_fetch_path,
    ),
    "devfreq_load": Kind(
        name="devfreq_load",
        args={
            "path": Arg("string", required=True),
            "measure": Arg("string", choices=("utilization", "duty_cycle")),
        },
        samples=["duty", "freq_hz"],
        fetch=_fetch_devfreq,
        note="The first number is the clock duty cycle.  Whether that is the "
             "utilisation depends on the driver -- 'measure' says which.",
    ),
    "rknpu_load": Kind(
        name="rknpu_load",
        args={"path": Arg("string", required=True)},
        samples=["usage", "core.*.usage"],
        fetch=_fetch_devfreq,
        note="Rockchip NPU debugfs.  This is the real utilisation; the "
             "devfreq file next to it is a duty cycle.",
    ),
    "thermal_zone": Kind(
        name="thermal_zone",
        args={
            "glob": Arg("string"),
            "type_map": Arg("map"),
        },
        samples=["zone.*"],
        fetch=_fetch_thermal,
        note="Maps each zone's 'type' file to a sample.  Never by zone index.",
    ),
    "file_read": Kind(
        name="file_read",
        args={
            "path": Arg("string"),
            "glob": Arg("string"),
            "format": Arg("string", choices=("string", "integer", "float")),
            "strip_trailing_null": Arg("bool"),
        },
        samples=["value"],
        fetch=_fetch_path,
    ),
    "exec_regex": Kind(
        name="exec_regex",
        args={
            "command": Arg("string", required=True),
            "pattern": Arg("string", required=True),
            "format": Arg("string", choices=("string", "integer", "float")),
        },
        samples=["value"],
        fetch=_fetch_command,
        note="Executes a command on the board.  A privilege, and warned "
             "about by the validator.",
    ),
    "script": Kind(
        name="script",
        args={
            "path": Arg("string", required=True),
            "format": Arg("string", choices=("json",)),
        },
        samples=["*"],
        fetch=None,
        note="A script from the pack directory that prints JSON.  Its keys "
             "are the sample names.",
    ),
}


def get(name: str) -> Kind | None:
    return KINDS.get(name)


#: Kinds whose fetch executes something on the board.  The validator warns
#: about these: they are a privilege, not a convenience.
EXECUTING_KINDS = ("exec_regex", "script")

#: Kinds that need two samples before they mean anything.
STATEFUL_KINDS = ("proc_stat",)
