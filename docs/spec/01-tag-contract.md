> Source and revisions: this document was migrated from the predecessor project `DevBoardConsole\docs\spec\` (2026-11-12, Codex, commit `c24b084`).
> The contract layer is the authoritative documentation. It was revised by `0244852` after the migration, and the review of 2026-11-12 revised it once more
> — see `00-overview.md` section 1.2 for the per-section provenance. For the implementation see `README.md` at the repository root.
# The Semantic Tag Contract

> The bus between cards and boards. This document defines the vocabulary; the board pack defines how the values are produced.

---

## 1. What a tag is

A tag is a nameable scalar measurement with five attributes:

| Attribute | Meaning | Example |
|---|---|---|
| Name | A stable identifier, layered with dots, all lower case | `cpu.usage` |
| Type | number / string / boolean / enum | number |
| Unit | An SI unit or dimensionless | `percent` |
| Range | The legal domain; a value outside it counts as a failed read | `[0, 100]` |
| Semantics | What this number actually is | "the share of the busy time of all cores over the past second" |

The name carries no board model. `cpu.usage` must mean the same thing on an RK3588, on an RK3568 and on an Allwinner board.

### How the name is layered

```
cpu.usage                 device . attribute
cpu.core.3.usage          device . instance group . instance . attribute
npu.core.0.usage
mem.total_bytes
temp.soc
```

Rules:

- The first segment is the device domain: `cpu` / `gpu` / `npu` / `mem` / `temp` / `disk` / `net` / `board` / …
- From the second segment on there are instance groups and instances; they appear only when entities of the same kind have to be told apart.
- The last segment is the attribute.
- All lower case, words joined with underscores (`temp.soc`, `net.rx_bytes`).
- No abbreviations: write `gpu.freq_hz`, not `gpu.f`; write `mem.used_bytes`, not `mem.u`.

### How the vocabulary is layered

| Layer | Defined by | Who may use it | Stability |
|---|---|---|---|
| The core vocabulary | this document, it follows the contract version | every board, every card | the semantics never change; to change the semantics, bump the version and start a new name |
| The board-private extension | declared by the board pack itself, namespace `custom.<board model>.<…>` | only the cards of that board model | no guarantee that it works across boards |

The core vocabulary is expressed with matching patterns; the `*` in a pattern matches exactly one segment.

> The authority is `data/tag-vocabulary.yaml`. The table below is its rendered result, not a second definition.
> To add or change a core tag, change the YAML; the implementation layer's machine-readable form is generated from it too.
> The three of them (the YAML / this table / the implementation layer) are kept consistent entry by entry by a cross-check test — the implementation layer calls this the only hard criterion against semantic drift ✓.
>
> The table carries one extra column, v1: `required` means a v1 board pack should provide it; `reserved` means the vocabulary reserves the semantics but v1 requires no pack to provide it.
> That column closes the gap between "the vocabulary has a definition" and "no pack implements it" (`board.kernel`, `net.*` and `disk.*` are `reserved` today).

| Pattern | Type | Unit | Range | Semantics | v1 |
|---|---|---|---|---|---|
| `cpu.usage` | number | percent | [0,100] | The share of the time in the past second during which all CPU cores executed non-idle instructions | required |
| `cpu.core.*.usage` | number | percent | [0,100] | The share of the time in the past second during which a single CPU core executed non-idle instructions | required |
| `cpu.core.*.cluster` | string | - | open enumeration | The name of the cluster the CPU core belongs to, such as A55 / A76. An unknown name is reported verbatim as a string and is not an error | required |
| `cpu.governor` | enum | - | open enumeration | The CPU frequency scaling policy in effect (the `scaling_governor` of cpufreq), such as `schedutil`. The value of cpu0 is taken; each core can be set independently | required |
| `gpu.usage` | number | percent | [0,100] | The current GPU reading: the share of the time executing non-idle instructions. The sampling window is decided by the driver and is not a fixed one second | required |
| `gpu.freq_hz` | number | hertz | ≥0 | The current GPU operating frequency | required |
| `npu.usage` | number | percent | [0,100] | The current NPU reading: the maximum of the utilisation of the compute cores. The sampling window is decided by the driver and is not a fixed one second | required |
| `npu.core.*.usage` | number | percent | [0,100] | The current utilisation of a single NPU compute core | required |
| `mem.total_bytes` | number | byte | >0 | The total amount of physical memory | required |
| `mem.available_bytes` | number | byte | ≥0 | The memory that can be handed to a new process without swapping (MemAvailable) | required |
| `mem.used_bytes` | number | byte | ≥0 | The used memory = MemTotal - MemAvailable (excluding the reclaimable page cache) | required |
| `mem.usage` | number | percent | [0,100] | The percentage of the total physical memory that is in use | required |
| `temp.soc` | number | celsius | - | The SoC core temperature, merged by the `type` of the thermal zone and not depending on the zone index | required |
| `temp.gpu` | number | celsius | - | The GPU temperature, merged by the `type` of the thermal zone | required |
| `temp.npu` | number | celsius | - | The NPU temperature, merged by the `type` of the thermal zone | required |
| `board.model` | string | - | - | The board model string, used to identify the board pack automatically | required |
| `board.kernel` | string | - | - | The kernel version string of the running system | reserved |
| `net.rx_bytes` | number | byte | ≥0 | The number of bytes received in total since boot | reserved |
| `net.tx_bytes` | number | byte | ≥0 | The number of bytes sent in total since boot | reserved |
| `disk.*.free_bytes` | number | byte | ≥0 | The number of bytes available on the file system that holds a given mount point | reserved |
| `disk.*.total_bytes` | number | byte | ≥0 | The total number of bytes on the file system that holds a given mount point | reserved |

Why the backlight is not in the core vocabulary: this board has two backlights (`backlight` and `backlight1`),
and both the instance names and the scale are specific to the board, so they do not meet the admission threshold of "the semantics are the same on every board".
Both instances therefore go through `custom.<board model>.*` (the user decided this on 2026-11-12; see item C2 of the contract reconciliation checklist).

The "semantics" column is not decoration. It is exactly the text that `describe_tag()` hands to the AI,
and it is the only thing that stops `npu.usage` from being read as any vague "NPU load".
A measurement without semantics does not enter the core vocabulary.

There is only one authority: `data/tag-vocabulary.yaml`. This table is its rendered result,
and the implementation layer's machine-readable form is generated from it too — writing a second vocabulary in code is not allowed.

> Why "only one" is emphasised: as soon as there are two copies of the vocabulary they drift — you change the document and not the code,
> or you change the code and not the document, and both sides claim to be right.
> The implementation layer's copy is a generated artefact, not a source; the source always lives in the YAML.
> Once the review has passed, the implementation layer needs a cross-check test of its own: it compares entry by entry "the vocabulary in the code",
> "the rendered result of this table" and "the YAML", and turns red when they disagree.

Adding a core tag is a contract version bump, not a board pack matter. A board pack may only declare which core tags it implements.

> This round (T-6) added three core tags: `mem.available_bytes`, `cpu.governor`,
> and a correct semantics for `mem.used_bytes` (it used to say "includes the reclaimable page cache",
> whereas `MemTotal - MemAvailable` is precisely the definition that excludes the reclaimable part).
> Because `devboard/v1` has not shipped with any implementation yet, this is a correction before v1 is finalised, not a breaking change.
> Once v1 ships, the semantics of the core tags are never changed in place again.

### Naming of the board-private extensions

The namespace of a private tag is `custom.<board pack id>.<…>`.

- `<board pack id>` may contain a hyphen (`rk3588-atk`), because the matching is a literal prefix match and not a segment pattern match.
- The number of segments in a private tag is not limited: `custom.rk3588-atk.npu.duty` is legal.
- A private tag has none of the semantic constraints of the core vocabulary — it belongs to that one board.
  A board pack should nevertheless document the meaning of each one in its own README.


---

## 2. States: a tag is not a number

This is the easiest part to get wrong and the one that most decides "cockpit versus remote control".

The reading of a tag is always "a value plus a state", never a bare value:

| State | Meaning | How a card displays it |
|---|---|---|
| `ok` | There is a value and it is inside the refresh cycle | display it normally |
| `stale` | There is a value, but the last refresh failed, so the value may be out of date | show the value plus an "out of date" marker |
| `unavailable` | This board does not provide the tag, or the resource is not there right now | show "unavailable", show no number |
| `error` | It should be readable, but the read or the parse failed | show the error |
| `pending` | No baseline has been established yet (for example when two samples have to be differenced) | show "waiting" |

The key rule: `unavailable` and `0` are two different things and must never be mixed up.

This directly inherits something the old project's `core/metrics.py` already got right — in that `Metrics` dataclass
a measurement that could not be read was `None` and not `0.0`, and the comment said it plainly: "a board you cannot
reach and a board with nothing to do must never look the same". The contract promotes it into a formal state machine.

This rule is the floor of a "cockpit": a button showing 0% load may in fact not be connected at all. In the other direction,
an `unavailable` button has to be shown as unavailable and not as 0 — otherwise the user will press a switch that does not exist.

### 2.1 How the states transition

This table is stateful: the runtime has to transition according to it, and each implementation must not invent its own.

| From | To | Trigger |
|---|---|---|
| (none) | `pending` | The tag is read for the first time and two samples have to be differenced |
| (none) | `ok` | The tag is read for the first time and one sample is enough (no dependency on history) |
| `pending` | `ok` | The second sample completed and the difference was computed |
| `pending` | `pending` | The second sample still failed (the baseline is still not established) |
| `pending` | `unavailable` | The resource is gone |
| `pending` | `error` | The sampling itself failed (non-zero command, timeout, the link dropped) |
| `ok` | `ok` | A new value was read |
| `ok` | `stale` | This refresh failed but the previous value is kept |
| `ok` | `error` | A value was read but the value is broken (parse failure, out of domain, wrong type) |
| `ok` | `unavailable` | The resource disappeared (the device was unplugged, debugfs was unmounted) |
| `stale` | `ok` | The refresh recovered |
| `stale` | `stale` | It keeps failing, the value is still the old one |
| `stale` | `error` | The refresh recovered but the value read this time is broken |
| `stale` | `unavailable` | The resource disappeared |
| `stale` | `pending` | The resource came back but the baseline has to be re-established (a stateful tag) |
| `unavailable` | `ok` | The resource came back and the value can be read straight away |
| `unavailable` | `pending` | The resource came back but the baseline has to be re-established (a stateful tag) |
| `unavailable` | `error` | The resource came back but the very first read failed |
| `error` | `ok` | The refresh recovered |
| `error` | `error` | It keeps failing |
| `error` | `stale` | It keeps failing and there was a usable value before — keep it and mark it as out of date |
| `error` | `unavailable` | The resource disappeared |
| `error` | `pending` | The resource came back but the baseline has to be re-established |

This table has no dead ends. Every row can walk back to `ok` — a momentary fault does not permanently break a card's display.
That matters: neither `error` nor `stale` is a terminal state.

The line between `unavailable` and `error`: a resource that is not there is `unavailable`; a resource
that is there but cannot be read is `error`.

> A concrete example: the NPU of an RK3588 reads `/sys/kernel/debug/rknpu/load`, and `/sys/kernel/debug` is not
> mounted by default. Whether it is mounted is an environment state, not a missing board capability —
> so it is `unavailable` (not readable right now), not `error` (something went wrong while reading).

This reaches the card directly: an `unavailable` widget should guide the user to mount debugfs,
instead of reporting "NPU read failed".

A value outside the domain counts as `error`, not as `unavailable`.
The range (section 1) is the semantic contract of the tag; a resource that is still there but whose value is illegal is "it was read and it is broken",
which is a different thing from "the resource is not there". The implementation layer has to report `error` for an out-of-domain value and must not clamp it into the legal range and treat it as `ok`
(that would be lying), nor treat it as `0` (that would be a worse lie).

A `stale` reading keeps the old value; an `unavailable` one keeps nothing (the value is `null`).
There are two behaviours for `error`, and the runtime decides which one applies, not the reader:

| Situation | Behaviour |
|---|---|
| Entering `error` from `ok`/`stale` (the value is broken) | Keep the old value and mark `error` at the same time |
| Entering `error` from `pending` (it never succeeded) | There is no old value, the value is `null` |

Keeping the old value has a reason: for a board that has just dropped off, showing its last known 37% is more useful than showing a blank —
but it has to be marked as out of date, otherwise that is lying too. When a card receives `error` with a `null` value it shows "read failed";
when it receives `error` with a value it shows "read failed (showing the previous value)".

### 2.1.1 The structure of a reading

A reading is a structure, not a bare value:

```json
{
  "tag": "npu.usage",
  "value": 12.5,
  "unit": "percent",
  "status": "unavailable",
  "reason": "device_absent",
  "detail": "/sys/kernel/debug/rknpu/load does not exist: debugfs is not mounted. Fix: mount -t debugfs debugfs /sys/kernel/debug",
  "at": 1762910000123,
  "seq": 418
}
```

| Field | Meaning |
|---|---|
| `value` | The current value. With `unavailable` there is no value; with `ok` a value is always present |
| `status` | One of the five states |
| `reason` | A machine-readable closed enumeration, see below |
| `detail` | Free text for humans. It may contain a repair hint |
| `at` | The moment this sample completed (milliseconds, UTC) |
| `seq` | A monotonically increasing sequence number within the same tag |

The `reason` is a closed enumeration and it carries a version (`reason_code_version`, governed exactly like `danger_floor_version`).
The initial code table:

| Code | Semantics | Typical source |
|---|---|---|
| `not_found` | The thing you asked for does not exist (the current board pack does not provide this tag, the action id does not exist, …) | Statically decidable, it can be computed while the card is being installed. It has the same name and the same meaning as the `not_found` on the action side in `04` section 2.4 — the AI does not get two dialects that have to be translated into each other |
| `device_absent` | The resource is not there right now: the path does not exist, the device was unplugged, the mount is gone | The reader section is missing, the file cannot be read |
| `service_down` | The service or process it depends on is not running | The command of `exec_regex` failed |
| `link_busy_terminal` | The link is occupied by the terminal, sampling is paused | The terminal holds the link and the managed sampling is suspended; the affected tag goes stale, because a round trip is exclusive on the link ✓ |
| `parse_error` | It was read but it cannot be parsed | The format does not match |
| `out_of_domain` | It was read but the value is out of domain | The range check failed |
| `timeout` | This read did not finish within the deadline | The round trip timed out |

Why there are two columns, a machine code and free text:
`reason` is there for the AI and for the card logic to consume (`unavailable(device_absent)` can be mapped programmatically onto a
"mount debugfs" button), while `detail` is for humans.
Free text alone means every pack has its own way of saying things, the AI cannot read it, and the degradation hints cannot be consumed programmatically.

The code table stays minimal: the specificity is carried by `detail`, and no new code is added for every variation of a path.

> Do not push "the action was not verified" into this table.
> This table holds the reason codes for a tag reading; the reason codes for an action execution are in `04` section 2.4
> (`readback_mismatch` / `denied` / `not_found` / …) — two tables, do not mix them.
> "The action ran but there was no readback" is neither a tag state nor a code of this table:
> it is a separate boolean field `verified` on the action result (`04` section 2.4).
> `unverified` is not a tag state — adding it to the five-state model would pollute every consumer of tags.

> The error codes of the card API share one vocabulary with this `reason` table —
> the AI does not get two dialects that have to be translated into each other.

### 2.2 Who is responsible for what

| Who | Is responsible for |
|---|---|
| The reader | Deciding whether this read succeeded: producing `ok` / `pending` / `unavailable` / `error` |
| The runtime | Deciding whether the value is fresh: downgrading `ok` to `stale` and performing the state transitions of section 2.1 |

So: a reader never produces `stale`. `stale` is a judgment about time, and a reader only knows
"what I just read". The runtime knows when the last success was, so it decides whether a value is still fresh.

This division matters because it keeps the reader a pure function: given the same input it gives the same output.
`stale` depends on history, so it does not belong to the reader.

### 2.3 Freshness

The runtime marks a tag as `stale` when more than 3 × the refresh period of its poll
group has passed since the last successful read.

The multiplier is fixed by the contract and a board pack cannot change it. The reason is simple: boards differ a lot in how fast they refresh,
and if every pack decides for itself "how long counts as out of date", then `stale` becomes a word with no uniform meaning
and neither the AI nor the cards can judge anything on the basis of it.

Note that `stale` has two trigger paths, and both lead to the same state:

1. A failed refresh — this poll could not read the value, but the previous value is kept and marked `stale`.
2. The refresh stopped — the whole poll group is no longer being polled (the connection dropped, the program crashed);
   the value itself is still there, but three periods have passed.

Both of them mean "the value may no longer be accurate", and the card handles them the same way: show the value and mark it as out of date.

The priority between the two paths: if in one refresh the read both fails and times out (for example a timeout immediately followed by the connection dropping),
it is handled as `stale` and does not become `error`. The reason: `stale` says "the value may be inaccurate",
while `error` says "the value read this time is broken" — a timeout did not read any broken value out.
Only a value that was read but is illegal (out of domain, wrong type, parsed into garbage) is an `error`.

Whether the cycle is skipped or retried after a timeout: the cycle is skipped and there is no immediate retry.
The reason comes from the old project's measurements: one `adb shell` per file is about 30ms, and retrying immediately after a failure floods the board while the connection is unstable
and distorts the sampling window of `/proc/stat`. The next attempt comes at the normal period of the poll group.

The state after a reconnect: when a connection drops and comes back, all tags under that connection first go to `unavailable`,
and then transition normally according to section 2.1 (the ones that need two samples go to `pending`). Restoring the pre-disconnect value directly as `ok` is not allowed —
that is exactly the source of lies such as "the button showing 0% load was never connected".

---

## 3. The refresh model

### 3.1 Who polls

The runtime is the only poller. Cards subscribe and agents query; neither polls on its own.

The old project has measurements behind this: spawning one `adb shell` per file takes about 30ms, and the CPU time of the forked
shell itself is booked into `/proc/stat`, which makes the board look 100% busy.
With N cards polling independently the load is N times that.

### 3.2 The unit of polling is the poll group

The board pack groups the readers into poll groups (see `02-board-pack.md` section 1.2).
One group = one round trip = one refresh period.

All the readers of a group are fetched with one combined command and each reader's output is separated by a marker, so a reader that fails
does not affect the other readers of the same group.

This resolves the conflict between two measured facts: `/proc/stat` has to be sampled every second (the utilisation is the difference of two samples),
while `/proc/device-tree/model` does not change all day. Combining the commands means the model is read again every second, wasting 30ms
and adding one more source of fork CPU noise.

Therefore:

| Concept | Belongs to | Period |
|---|---|---|
| poll group | the board pack | its own `interval_ms` |
| reader | the board pack | the period of the group it is in |
| tag | the board pack | the period of its reader |
| refresh push | the runtime | the period of the group |

The permissions and the degradation decisions in the card manifest work on tag names and have nothing to do with polling.

### 3.3 The special case of the first read

Some measurements can only be computed by differencing two samples (CPU utilisation is one of them). Such a tag returns `pending`
on the first read and only has a value from the second one on.

A card has to handle `pending` gracefully: show "waiting for the first sample", not a spinner and not a zero.

---

## 4. Discovery of tags

The central question: how does the AI know which tags a board has?

Three mechanisms, all of them necessary:

### 4.1 Static: the board pack describes itself

The board pack declares which tags it implements (see `02-board-pack.md`). That lets the AI understand the board before it is even connected.

### 4.2 Dynamic: the runtime enumerates

`list_tags()` returns all the tags that the boards of the current connection actually provide, with their live state. That covers the case of "the pack says so, but it cannot actually be read".

### 4.3 Introspection: read the details of one tag

`describe_tag(name)` returns the type, the unit, the range, the current value, the state and the source of the history. This is the item the AI has to check before it writes a card.

> Why static documentation cannot be relied on: capabilities appear dynamically — a camera is plugged in, the NPU driver is installed later, a profile is loaded at runtime. Documentation always lags behind the reality on site. The exact wording of the `list_data_sources` row in the MCP tool table is "capabilities appear dynamically, static documentation cannot be relied on".

---

## 5. What happens when a tag is missing (settled: it degrades)

When a card references a tag the current board does not have:

1. The card still loads. It is not rejected, no error is raised and nothing is blocked.
2. The widget that references the missing tag shows "unavailable" and names which tag is missing.
3. The manifest declares the list of required tags and the minimum board pack version; the runtime performs the check while loading and lists the missing items.

This is directly tied to the collaboration loop with the AI: the agent writes a card → it is hot-plugged → you look at the result → the agent iterates. If any step in between fails because "this card is incomplete on another board", the iteration is broken. Degradation keeps an "incomplete card" usable, visible and diagnosable.

But degradation is not silence. A missing thing must be explicitly visible:
- inside the card: "unavailable · missing cpu.usage"
- the MCP `validate_card` returns the list of missing items
- the MCP `list_cards` reports which cards are degraded on the current board

---

## 6. The admission threshold of the core vocabulary

What qualifies for the core vocabulary? All three conditions have to hold at the same time:

1. At least two boards produce it, or it is a generic Linux quantity (`mem.usage`, `board.model`).
2. The semantics are the same on every board. "Load" often means different things at different vendors (duty cycle versus actual utilisation — the existing `metrics.py` fell into exactly this trap: the NPU's devfreq `load` file reads `100@1000000000Hz` when idle, which is a duty cycle and not a utilisation; the real utilisation lives in the `rknpu` debugfs). Such a quantity must first be checked on several boards for a consistent meaning before it may enter the core vocabulary.
3. It has a clear failure semantics. What the state is when it cannot be read has to be written down.

A quantity that does not meet the conditions goes through `custom.<board model>.*`.

This threshold is the main mechanism that keeps the core vocabulary from swelling into a junk yard. Every word added to the vocabulary is one more promise that "every implementer has to follow this meaning".

"Reserved" does not mean "implemented": the entries marked `v1: reserved` in the vocabulary (`board.kernel`, `net.*`, `disk.*`)
have their semantics and their names already taken, but v1 requires no board pack to provide them.
They are not "forgotten implementations" — a board pack that does not provide them is compliant, and a card that references them degrades as described in section 5.
The point is that when these quantities really are implemented on two boards, the name does not have to be reinvented and the contract version does not have to be bumped.

A name whose semantics are already reserved may not be rewritten by the implementer either. Once a `reserved` entry is implemented by some board,
its semantics have to match what the vocabulary says; an implementer may not define its own semantics on the grounds of "it was not implemented anyway".

---

## 7. A concrete trap: watch out for the duty cycle

This one deserves a section of its own, because it was really fallen into:

> At one vendor the devfreq `load` file reads `<duty>@<freq>Hz`. That duty is the clock duty cycle, not the utilisation. When the board is idle it reads 100 (the clock running at full speed on standby), and when the board is fully loaded it also reads 100 (really computing). Used as a utilisation, an idle board shows as 100% busy.

The correct source is usually somewhere else (that vendor's debugfs or a sysfs attribute).

The requirement at the contract level: for every quantity in the core vocabulary the "semantics" column has to spell out what it actually represents.
"Utilisation" is not enough; it has to read "the current reading: the share of the time spent executing non-idle instructions, the sampling window is decided by the driver".
A quantity that cannot be spelled out does not enter the core vocabulary.

> Do not write "over the past second" unless it really is one second. The CPU utilisation is computed by us as the difference of two samples, so
> its window really is the interval between two samples; the devfreq and debugfs readings of the GPU/NPU are snapshots given by the driver, and the
> window is decided by the driver. Writing both of them as "over the past second" makes the agent believe they can be compared with each other,
> and makes the implementer write a sliding window that simply cannot be built.

---

## 8. Glossary

| Contract term | Meaning | Corresponding existing code |
|---|---|---|
| tag | a nameable scalar measurement | a field of `Metrics` (for example `cpu_total`) |
| state | ok / stale / unavailable / error / pending | the `None` and the `ok` flag in `Metrics` |
| reader | a batch of data fetched in one round trip | that script of `SNAPSHOT_SCRIPT` |
| board pack | the YAML data pack of one board | does not exist (scattered through `metrics.py`) |
| action | one controlled write from the GUI to the board | does not exist |

