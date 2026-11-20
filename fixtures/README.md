# fixtures — real-device samples (golden test vectors)

These files are outputs **captured verbatim from a real board or a real
session**. They are not invented. Their purpose is to let the parsers
(`/proc/stat`, `/proc/cpuinfo`, devfreq, rknpu, meminfo, thermal) be tested
without a board, and to make a change in the parsing logic show up as a
regression immediately.

> The rule: **samples are append-only**. To add a sample, add a new file. To
> change a parser, keep the old sample green.
> The tag names and the state semantics are defined in
> `docs/spec/01-tag-contract.md`; this file does not repeat them.

| File | Origin | What it exercises |
|---|---|---|
| `metrics/proc-stat.txt` | Real `/proc/stat` from an ATK-DLRK3588 | `cpu.usage` / `cpu.core.*.usage`; the core number is the `N` of `cpuN` |
| `metrics/proc-stat-second.txt` | **Synthetic**, derived exactly from the file above | The difference vector of `cpu.usage` — with one sample there is no difference to take |
| `metrics/cpuinfo-excerpt.txt` | Excerpt of a real `/proc/cpuinfo` | `cpu.core.*.cluster` (A55/A76, `CPU part` 0xd05 / 0xd0b) |
| `metrics/snapshot-sample.txt` | A real merged snapshot of one round trip (`###STAT`…`###END`) | Snapshot sections, GPU/NPU/memory/temperature parsing |
| `metrics/roundtrip-per-reader.txt` | **Synthetic**, content taken from the file above and rearranged into the contract format | The per-reader fences of the contract (`###R <reader>` / `###E <reader>`) |
| `metrics/snapshot-degraded.txt` | A synthetic **degraded** sample | Malformed data must parse as `unavailable`, never as `0` |
| `session-log/serial-session.log` | A real serial session log | Session log format (timestamp prefix, ANSI stripping, event lines) |
| `validator/illegal-floor-downgrade.yaml` | A deliberately **illegal** board pack | Negative case: declaring `reboot` as `reversible` must be rejected |

## Two generations of section format

| Generation | Files | Format | Status |
|---|---|---|---|
| Old (flat) | `snapshot-sample.txt`, `snapshot-degraded.txt` | One block from `###STAT` to `###END` | **Kept**, unchanged |
| New (per reader) | `roundtrip-per-reader.txt` | Each reader has its own `###R <reader> <KIND>` … `###E <reader>` | The format the contract specifies in `spec/02` §1.2 |

**The contract specifies the new format.** The old format comes from a
one-off snapshot script in the predecessor project. Its section boundaries do
not distinguish readers, so one broken reader contaminates the whole block,
whereas the contract requires that a reader failing inside a group does not
affect the others. The implementation therefore parses the new format; the
old samples stay as historical input, used to verify how the parser degrades
when it meets an unknown section.

## The `cpu.usage` difference vector

`cpu.usage` is computed by **differencing two samples**. With the first
sample alone, `cpu.usage` stays `pending` (contract `spec/01` §3.3) — there
is no difference vector.

`metrics/proc-stat-second.txt` closes that gap. It is derived from
`proc-stat.txt` under "1 second at HZ=1000, idle +1000 per core", and the
file header states the `busyΔ` / `totalΔ` / expected `usage` of every core.

**How to use it**: feed both samples to the parser in order and assert that
the second output equals the expected value in the header. Note that the
expected value is **Δbusy / Δtotal**, not "cumulative busy / cumulative
total" — the latter is the average since boot, not the current load.

> This sample is **synthetic**, not captured from a board. A second sample
> captured from a real board is still worth adding (the rule is
> **append-only**: add a file, do not overwrite this one).

## Negative sample: a deliberately illegal board pack

`validator/illegal-floor-downgrade.yaml` must never pass validation. It
declares a command that hits the danger floor (`reboot`) as
`danger: reversible`, which violates rule 16 of `spec/02` §7.

It tests two things, and both are needed:

1. **Statically**: the validator rejects the pack, and the error points at
   rule 16 and at the offending field.
2. **As a runtime backstop**: even if the pack is forced into the runtime,
   the danger floor still classifies it as `destructive`, returns
   `needs_confirmation`, and does not execute it.

> The floor is a **lower bound** and the validator is the **first gate**.
> Both have to be there: with only the static check, a path that bypasses the
> validator would run a reboot as if it were reversible.

## `board/` — samples captured directly from the board, 2026-11-13

The samples in `metrics/` come from the predecessor project
(`DevBoardConsole`). The samples in `board/` were **captured directly from
the board on 2026-11-13**, over ADB, board serial `0000000000000000`.

| File | Contents |
|---|---|
| `rk3588-atk-ls-root.txt` | The real output of `ls -l /` (five symlinks, entries with `----------` permissions) |
| `rk3588-atk-snapshot.txt` | `/proc/stat`, `/proc/cpuinfo`, `/proc/meminfo`, GPU devfreq, rknpu and the thermal zones, captured in one round trip |
| `rk3588-atk-devfreq.txt` | The two paths to the NPU side by side (devfreq duty cycle against the real rknpu utilisation), plus the debugfs mount state |
| `rk3588-atk-proc-stat-pair.txt` | **Two real** `/proc/stat` samples, three seconds apart |

**Why capture a second one**: `metrics/proc-stat-second.txt` is synthetic
(derived from "1 second at HZ=1000"), not captured. `cpu.usage` is computed
by differencing two samples, so the difference vector has to come from two
real samples; otherwise the parser's tolerance for a missing line, an extra
line or a different core count is never exercised.

The conformance tests are in `tests/unit/board-fixtures.test.ts`.

## Known gaps

| Gap | Status |
|---|---|
| A second `/proc/stat` from real hardware | **Closed**: `board/rk3588-atk-proc-stat-pair.txt` holds two real samples |
| A round-trip sample in the contract format | Substituted by real content in a synthetic layout |
| The `rare` poll group (30000 ms) | The whole group has no vector |
| The readback of `backlight.set` | The measured `200` of a maximum of 255 exists only in prose |
| The readback of `cpu.governor.set` | The measured `schedutil` exists only in prose |
| The `duty_cycle` path | The `100@1000000000Hz` form exists only in prose |

`session-log/serial-session.log` comes from a real run of the predecessor
project and was copied verbatim. It contains shell prompts and directory
listings only.

## Conformance against the contract

These samples are the implementation layer's **golden test vectors**: once
the contract is approved, a parser written against it must produce the
**same result** on the same sample that the contract defines.

The hard criterion for "the semantics did not drift" is **implementation
versus contract**, not implementation versus implementation. The vocabulary
and the validation rules are therefore generated from `docs/spec/`, and
`npm run gen:vocabulary:check` asserts that the YAML, the document tables
and the code vocabulary are the same three things.