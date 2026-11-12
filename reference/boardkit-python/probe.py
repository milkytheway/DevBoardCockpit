# -*- coding: utf-8 -*-
"""Probe a board pack against a real board.

The pack is only as good as what it says it can read.  This script runs
every poll group in a pack against a real board and prints what came back,
so a pack can be checked before it is trusted.

    python tools/boardkit/probe.py boards/rk3588-atk/board.yaml
    python tools/boardkit/probe.py boards/rk3588-atk/board.yaml --transport ssh

It talks to the board the same way the console does.  Each poll group is
fetched in **one** round trip, with every reader in the group delimited by
its own marker, so one reader failing does not take the others down with
it.

Two samples are taken for stateful readers (the CPU one needs a baseline),
so the script waits one interval before it reports CPU utilisation.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - dependency check
    print("PyYAML is required: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)

sys.path.insert(0, str(Path(__file__).resolve().parent))

from binding import bind_all  # noqa: E402
from kinds import KINDS  # noqa: E402
from readers import ERROR, OK, PENDING, UNAVAILABLE, parse  # noqa: E402


# --------------------------------------------------------------------------
# transport
# --------------------------------------------------------------------------

class Transport:
    """Sends one command to a board and returns its output."""

    def __init__(self, kind: str, **options) -> None:
        self.kind = kind
        self.options = options

    def run(self, command: str, timeout: float = 30.0) -> tuple[int, str, str]:
        raise NotImplementedError

    def describe(self) -> str:
        raise NotImplementedError


class AdbTransport(Transport):
    """One ``adb shell`` per command.

    No PTY on purpose: with ``shell -t -t`` on Windows the reply is batched
    until the *next* command is sent, so the output appears one command late.
    """

    def __init__(self, serial: str = "", adb_path: str = "adb") -> None:
        super().__init__("adb")
        self.serial = serial
        self.adb_path = adb_path

    def _base(self) -> list[str]:
        cmd = [self.adb_path]
        if self.serial:
            cmd += ["-s", self.serial]
        return cmd

    def run(self, command: str, timeout: float = 30.0) -> tuple[int, str, str]:
        try:
            proc = subprocess.run(
                self._base() + ["shell", command],
                capture_output=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return 124, "", "timed out"
        except FileNotFoundError:
            return 127, "", f"{self.adb_path} not found"
        return (
            proc.returncode,
            proc.stdout.decode("utf-8", "replace"),
            proc.stderr.decode("utf-8", "replace"),
        )

    def describe(self) -> str:
        return f"adb serial={self.serial or '(the only device)'}"


class SshTransport(Transport):
    """One command over SSH, via paramiko."""

    def __init__(self, host: str, username: str, port: int = 22,
                 key_filename: str = "", password: str = "") -> None:
        super().__init__("ssh")
        self.host = host
        self.username = username
        self.port = port
        self.key_filename = key_filename
        self.password = password
        self._client = None

    def _connect(self):
        try:
            import paramiko
        except ImportError:
            raise RuntimeError("paramiko is required for the ssh transport")
        if self._client is not None:
            return self._client
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        if self.key_filename:
            client.connect(self.host, port=self.port, username=self.username,
                           key_filename=self.key_filename, timeout=15)
        elif self.password:
            client.connect(self.host, port=self.port, username=self.username,
                           password=self.password, timeout=15)
        else:
            client.connect(self.host, port=self.port, username=self.username,
                           timeout=15)
        self._client = client
        return client

    def run(self, command: str, timeout: float = 30.0) -> tuple[int, str, str]:
        client = self._connect()
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        return code, out, err

    def describe(self) -> str:
        return f"ssh {self.username}@{self.host}:{self.port}"


# --------------------------------------------------------------------------
# one round trip per poll group
# --------------------------------------------------------------------------

def build_group_command(group: dict, readers: dict[str, dict]) -> str:
    """Compose one shell command that fetches every reader of a group.

    Each reader's output is fenced by its own marker, so a reader that
    produces nothing is distinguishable from a reader that was never asked.
    """
    parts = []
    for rid in group.get("readers") or []:
        reader = readers.get(rid)
        if reader is None:
            continue
        kind = KINDS.get(reader.get("kind"))
        if kind is None or kind.fetch is None:
            continue
        args = reader.get("args") or {}
        for section, fragment in kind.fetch(args):
            parts.append(
                f"echo '###R {rid} {section}'; {fragment}; echo '###E {rid}'"
            )
    if not parts:
        return ""
    return " ; ".join(parts)


def split_sections(text: str) -> dict[str, str]:
    """Split a combined output into one section per reader."""
    out: dict[str, str] = {}
    pattern = re.compile(
        r"^###R (?P<rid>\S+) (?P<section>\S+)\s*$(?P<body>.*?)^###E ",
        re.MULTILINE | re.DOTALL,
    )
    for match in pattern.finditer(text):
        rid = match.group("rid")
        body = match.group("body")
        # A reader may have several sections; concatenate them.
        out[rid] = out.get(rid, "") + body
    return out


# --------------------------------------------------------------------------
# running one group
# --------------------------------------------------------------------------

def probe_group(group: dict, readers: dict[str, dict], transport: Transport,
                states: dict) -> tuple[dict, list[str]]:
    """Run one poll group.  Returns (tags, problems)."""
    command = build_group_command(group, readers)
    if not command:
        return {}, []

    code, out, err = transport.run(command, timeout=40.0)
    if code != 0:
        return {}, [f"group {group.get('id')!r}: exit {code}: {err.strip()}"]

    sections = split_sections(out)
    tags: dict[str, dict] = {}
    problems: list[str] = []

    for rid in group.get("readers") or []:
        reader = readers.get(rid)
        if reader is None:
            continue
        kind_name = reader.get("kind")
        kind = KINDS.get(kind_name)
        if kind is None or kind.fetch is None:
            continue

        args = reader.get("args") or {}
        body = sections.get(rid, "")

        if not body.strip():
            # The resource is not there.  That is 'unavailable', not an
            # error, and certainly not zero.
            for binding in reader.get("provides") or []:
                tag = binding.get("tag", "")
                if tag and "*" not in tag:
                    tags[tag] = {
                        "status": UNAVAILABLE, "value": None,
                        "detail": "the board returned nothing for this reader",
                    }
            problems.append(
                f"reader {rid!r}: the board returned nothing "
                f"(the resource is probably not present)"
            )
            continue

        try:
            samples = parse(kind_name, body, args, states.get(rid))
        except Exception as exc:
            problems.append(f"reader {rid!r}: {exc}")
            for binding in reader.get("provides") or []:
                tag = binding.get("tag", "")
                if tag and "*" not in tag:
                    tags[tag] = {
                        "status": ERROR, "value": None, "detail": str(exc),
                    }
            continue

        if "_state" in samples:
            states[rid] = samples.pop("_state")

        bound = bind_all(samples, reader.get("provides") or [])
        for tag, value in bound.items():
            if value.get("status") == UNAVAILABLE and "no sample matched" in (
                value.get("detail") or ""
            ):
                problems.append(f"reader {rid!r}: no sample matched {tag!r}")
            tags[tag] = value

    return tags, problems


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", help="path to a board.yaml")
    parser.add_argument("--transport", choices=("adb", "ssh"), default="adb")
    parser.add_argument("--serial", default="", help="adb device serial")
    parser.add_argument("--adb-path", default="adb")
    parser.add_argument("--host", default="192.168.1.102")
    parser.add_argument("--username", default="root")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--key", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--samples", type=int, default=2,
                        help="how many rounds to read (the CPU reader needs 2)")
    args = parser.parse_args(argv)

    path = Path(args.pack)
    pack = yaml.safe_load(path.read_text(encoding="utf-8"))

    if args.transport == "adb":
        transport = AdbTransport(serial=args.serial, adb_path=args.adb_path)
    else:
        transport = SshTransport(
            host=args.host, username=args.username, port=args.port,
            key_filename=args.key, password=args.password,
        )

    readers = {}
    for reader in (pack.get("readers") or []) + (pack.get("custom") or []):
        readers[reader.get("id", "?")] = reader
    groups = pack.get("poll_groups") or []

    print(f"pack      : {path}")
    print(f"board     : {pack.get('name')} ({pack.get('id')} v{pack.get('version')})")
    print(f"transport : {transport.describe()}")
    print(f"groups    : {', '.join(g.get('id', '?') for g in groups)}")
    print()

    states: dict = {}
    results: dict[str, dict] = {}
    all_problems: list[str] = []

    for round_index in range(max(1, args.samples)):
        if round_index:
            print("--- second round (the CPU reader needs a baseline) ---")
        for group in groups:
            tags, problems = probe_group(group, readers, transport, states)
            results.update(tags)
            for problem in problems:
                all_problems.append(problem)
            shown = ", ".join(
                f"{k}={v.get('value')}"
                for k, v in sorted(tags.items())
                if v.get("status") == OK
            )
            print(f"  [{group.get('id')}] {shown or '(nothing readable)'}")
        if round_index == 0 and len(groups) > 1:
            time.sleep(1.2)

    print()
    print("--- tags as a card would see them ---")
    declared: list[str] = []
    for reader in readers.values():
        for binding in reader.get("provides") or []:
            declared.append(binding.get("tag", ""))

    bad = 0
    for tag in sorted(set(declared)):
        if "*" in tag:
            prefix, suffix = tag.split("*", 1)
            instances = sorted(
                k for k in results
                if k.startswith(prefix) and k.endswith(suffix)
            )
            for inst in instances:
                value = results[inst]
                print(f"  {tag:<32} -> {inst:<24} "
                      f"{value.get('value')} [{value.get('status')}]")
            if not instances:
                print(f"  {tag:<32} -> (no instance matched) [{UNAVAILABLE}]")
                bad += 1
            continue
        value = results.get(tag, {"status": UNAVAILABLE, "value": None})
        print(f"  {tag:<32} {value.get('value')} [{value.get('status')}]")
        if value.get("status") in (ERROR, UNAVAILABLE):
            bad += 1

    print()
    if all_problems:
        print("problems:")
        for problem in all_problems:
            print(f"  - {problem}")
        print()
    if bad:
        print(f"{bad} tag(s) did not produce a value.")
        print("A tag that cannot be read must report 'unavailable', never 0.")
        return 1
    print("Every declared tag produced a value.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
