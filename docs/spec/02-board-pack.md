> Source and revisions: this document was migrated from the predecessor project `DevBoardConsole\docs\spec\` (2026-11-12, Codex, commit `c24b084`).
> The contract layer is the authoritative documentation. It was revised by `0244852` after the migration, and the review of 2026-11-12 revised it once more
> — see `00-overview.md` section 1.2 for the per-section provenance. For the implementation see `README.md` at the repository root.
>
> The revision of 2026-11-13 (the decisions taken before plan 2): the capability vocabulary and the word-sense correspondence table (section 10.7),
> readback form 5 `kind: none` (sections 4.4 / 4.5), validation rules 25/26/27 (section 7).
> It follows the decisions of 2026-11-13 and takes the "correction before v1 is finalised" line:
> `apiVersion` is not bumped (`devboard/v1` has not shipped with any implementation yet),
> but it is written up once and reviewed once, not piecemeal.
> This round changed the semantics of no existing tag — the semantics in the core vocabulary never change (section 6).
# The Board Pack Format

> One board = one YAML file. All the differences between board models live here and not in the core code.
> Supporting a new board = submitting a pack, not waiting for a release.

---

## 1. What a pack looks like

```yaml
# profiles/boards/rk3588-atk/board.yaml
apiVersion: devboard/v1
kind: BoardPack

id: rk3588-atk
name: ATK-DLRK3588 (Alientek)
version: 1.0.0
description: RK3588, Buildroot 6.1.141, 8 cores (A55 x4 + A76 x4)

requires:
  transports: [adb, serial, ssh]     # all three are supported
  # Board-level capabilities (closed vocabulary, section 10.7). Do not write `stream`:
  # the business contract for Stream is not settled yet (section 7 of `00-overview.md`), so declaring it would not be honoured —
  # validation rule 26 rejects it as an error.
  capabilities: [shell, exec, files]
  min_contract: devboard/v1

# The version of the danger floor table (section 5.2.1). When it is not written it defaults to 1.
danger_floor_version: 1

# Automatic identification: when a connection does not name a board_pack, the runtime reads the model of the board and matches against it.
match:
  mode: substring                   # exact | substring
  models: [ATK-DLRK3588]

# Poll groups: one group = one round trip.
poll_groups:
  - id: fast
    interval_ms: 1000
    readers: [cpu, gpu, npu]
  - id: slow
    interval_ms: 2000
    readers: [mem, temp]
  - id: rare
    interval_ms: 30000
    readers: [board, npu_devfreq]

# Where the data comes from. A reader produces samples, `provides` binds the samples to tags.
readers:
  - id: cpu
    kind: proc_stat
    args:
      stat_path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - tag: cpu.usage
        sample: usage
      - tag: cpu.core.*.usage
        sample: core.*.usage
      - tag: cpu.core.*.cluster
        sample: core.*.cluster

  - id: gpu
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fb000000.gpu/load
      measure: utilization           # utilization | duty_cycle
    provides:
      - tag: gpu.usage
        sample: duty
      - tag: gpu.freq_hz
        sample: freq_hz

  - id: npu
    kind: rknpu_load
    args:
      path: /sys/kernel/debug/rknpu/load
    provides:
      - tag: npu.usage
        sample: usage
      - tag: npu.core.*.usage
        sample: core.*.usage

  - id: mem
    kind: meminfo
    args:
      path: /proc/meminfo
    provides:
      - tag: mem.total_bytes
        sample: total_bytes
      - tag: mem.used_bytes
        sample: used_bytes
      - tag: mem.usage
        sample: usage

  - id: temp
    kind: thermal_zone
    args:
      glob: /sys/class/thermal/thermal_zone*
      type_map:
        soc-thermal: soc
        gpu-thermal: gpu
        npu-thermal: npu
    provides:
      - tag: temp.soc
        sample: zone.soc
      - tag: temp.gpu
        sample: zone.gpu
      - tag: temp.npu
        sample: zone.npu

# What writes this board accepts. Every action has to declare its danger grade and how it is read back.
actions:
  - id: backlight.set
    label: Set the backlight brightness
    danger: reversible          # reversible | destructive
    params:
      value:
        type: integer
        min: 0
        max: 255
    # The parameter domain (section 5.5): inside this range it counts as "mild", outside it is refused (denied)
    guard:
      value: {min: 16, max: 255}
    command: "echo {value} > /sys/class/backlight/backlight/brightness"
    readback:
      kind: file_equals
      path: /sys/class/backlight/backlight/brightness
      expect: "{value}"
      tolerance: 1

# The quantities that are specific to this board. They do not enter the core vocabulary and other boards are not guaranteed to have them.
custom:
  - id: npu_devfreq
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fdab0000.npu/load
      measure: duty_cycle
    provides:
      - tag: custom.rk3588-atk.npu.duty
        sample: duty
```

### 1.1 Samples and tags: two namespaces

This is the most important rule of this format.

A reader kind produces samples, not tags. A sample is a relative name inside the reader (`usage`,
`core.3.usage`, `duty`); a tag is a globally qualified name (`cpu.usage`, `cpu.core.3.usage`, `gpu.usage`).

The pack connects the two explicitly with `provides`:

```yaml
provides:
  - tag: cpu.core.*.usage     # the target name
    sample: core.*.usage      # the source sample
```

The positions of the `*` correspond one to one: the sample `core.3.usage` is bound to the tag `cpu.core.3.usage`.

Why a reader does not produce tags directly: one kind has to serve many boards with different names. `devfreq_load`
produces `duty` and `freq_hz`; the RK3588 pack binds `duty` to `gpu.usage`, and another board can bind the same
`duty` to `custom.<that board>.gpu_duty` — not one line of code has to change.

Why a reader does not produce tags directly (the other angle): two readers of different kinds cannot collide on the same tag.
A collision can only happen where `provides` repeats a tag, and the validator can check that.

The two namespaces do not have to have the same length (`cpu.core.*.usage` has four segments, `core.*.usage` has three),
but the number of wildcards must be the same, and the literal segments of the sample must line up with the concrete sample segment by segment
(`core.*.usage` matches `core.3.usage` and does not match `core.3.cluster`).

The tag and the sample are not compared segment by segment: they live in different namespaces, and `gpu.usage` legitimately binds the sample
`duty` — it is the pack's `measure: utilization` that says "this duty reading IS the utilisation".
The literal of the sample says what was read, the literal of the tag says what that means.

### 1.2 Poll groups

One poll group = one round trip. All the readers of a group are combined into one shell command and fetched in one go,
and the output of each reader is separated by a marker.

```
echo '###R cpu STAT'; ...; echo '###E cpu' ; echo '###R gpu LOAD'; ...; echo '###E gpu'
```

The grouping exists because two measured facts collide:

- Spawning one `adb shell` per file costs about 30ms, and the CPU time of the forked shell itself is booked into
  `/proc/stat`, which makes the board look 100% busy.
- But `/proc/stat` has to be sampled every second (the utilisation is the difference of two samples), while `/proc/device-tree/model`
  does not change all day.

Combining the commands means the model is read again every second, wasting 30ms and adding one more source of fork CPU noise.
Putting everything into one group means the same thing.

The grouping puts it plainly: fast things and slow things are fetched separately.

A reader that fails inside a group does not affect the other readers of the same group: each reader has its own marker,
and an empty section counts as unavailable.

Every reader must belong to exactly one group — no group means no round trip means it is never read.
The validator stops it.

#### 1.2.1 The mutual exclusion of one round trip (especially important on serial)

On one connection only one round trip may be in flight at a time. The sampling round trip of a poll group and the action round trip
(section 4) share the same channel and have to be serialised.

On serial this is a hard constraint: the command channel and the interactive terminal share one wire (fact S1 of the old project),
there is only one read thread and one transcript, and a command claims its own reply by means of a marker.
When two round trips run concurrently the replies of the two markers interleave in the same transcript,
which shows up as "you press a button and the numbers on the monitor card jump around".

Rules:

| Item | Rule |
|---|---|
| Queueing | There is one round trip queue per connection, and both the sampling of a poll group and the actions go into that same queue |
| Priority | Actions come before sampling. When an action waits in the queue behind a sample, the sample gives way |
| Single line on serial | One round trip on serial can only be a one-line command (fact S6); a multi-line script is squeezed into one line |
| Sampling gives way | If the sampling of a poll group misses its period because it gave way to an action, the period is skipped and nothing is sent later |
| Timeout cleanup | After a round trip times out, the next round trip may only start once the markers have all been collected or a marker has been explicitly abandoned |

Skip rather than send later: sending later would make an already lagging sampling window meaningless
(the difference of `/proc/stat` is computed over the interval between two samples, and an irregular interval makes it meaningless).

> This is not theoretical fastidiousness. Fact S2 says it plainly: the board echoes the command,
> so a marker appears twice in the transcript (once in the echo, once after the output).
> With concurrent round trips the echo and the output cannot be paired — which is exactly why the old project used a marker protocol,
> and the premise of the marker protocol is that only one command is in flight at a time.

---

## 2. Reader kinds: why "a few versioned built-ins plus escape hatches"

### 2.1 The problem

The quantities on an RK3588 do not all have the same shape:

| Quantity | Shape |
|---|---|
| CPU utilisation | the difference of two samples (stateful) |
| the name of each core (A55/A76) | a join by index across files |
| GPU utilisation | `<pct>@<freq>Hz`, only the first number is taken |
| NPU utilisation | `Core0: 12%, Core1: 9%`, several values in one line |
| temperature | a glob traversal merged by the name of the `type` file |

Only the "pattern match" shape can be written purely declaratively. The other three cannot.

### 2.2 Three ways out

| Approach | Shape | Cost |
|---|---|---|
| purely declarative | the pack holds nothing but {source, path, pattern, transform} | it cannot express "a difference" or a "join across files". Either a miniature expression language grows inside the YAML (worse than code), or the most important quantity of all, the CPU utilisation, simply cannot be written down. |
| code bindings | every tag is bound to a function in the registry | the pack is no longer self-explanatory — the AI has to read the code to learn what `proc_stat_delta` does. A new board goes from "hand in a pack" to "write some code and then hand in a pack". |
| hybrid (chosen) | a small number of versioned built-in kinds plus escape hatches | one more layer of indirection: the AI has to learn what `proc_stat_delta` is for |

### 2.3 The choice: the hybrid

The third one is chosen. The reason is that it preserves the self-explanatory nature of the pack:

> An AI that has read the YAML of the pack and the manual of the kinds knows everything about this board, without executing anything and without reading the source code.

The manual of the kinds is part of the contract (it sits between `01` and this document), a versioned and finite list. A closed list means a closed mental model for the AI, and that means the AI does not guess when it writes a card.

### 2.4 The list of built-in reader kinds (v1)

These kinds are one single implementation on every board, and therefore:

- implemented once, reused on every board
- unit testable (no real board needed)
- the behaviour carries a version number and can move with the contract

Every kind declares three things: which parameters it accepts, which samples it produces, and how it fetches them from the board.

| kind | Parameters | Produced samples | Note |
|---|---|---|---|
| `proc_stat` | `stat_path`, `cpuinfo_path` | `usage`, `core.*.usage`, `core.*.cluster` | two samples are needed, the first one is pending |
| `meminfo` | `path` | `total_bytes`, `available_bytes`, `used_bytes`, `usage` | one sample is enough |
| `devfreq_load` | `path`, `measure` | `duty`, `freq_hz` | `measure` says what `duty` is, see below |
| `rknpu_load` | `path` | `usage`, `core.*.usage` | a vendor specific format, an RK specific kind |
| `thermal_zone` | `glob`, `type_map` | `zone.*` | merged by `type`, not by index |
| `file_read` | `path`/`glob`, `format`, `strip_trailing_null` | `value` | escape hatch 1: the most general one |
| `exec_regex` | `command`, `pattern`, `format` | `value` | escape hatch 2 |
| ⛔ `script` | `path`, `interpreter`, `format` | (the keys of the script JSON) | sealed — forbidden by rule 31 ✓ · the implementation has it ✓ but a pack may not use it ✓ · the reason is in section 3.3 |

This table is part of the contract, and its machine-readable form is provided by the implementation layer: the implementation layer must have
a registry of reader kinds that declares, for every kind, the parameter schema, the produced samples, whether two samples are needed
and the shell fragment used to fetch the data.

The validator checks that the parameters a pack declares exist in the schema of the kind — a mistyped parameter name is stopped,
not silently replaced by a default.

An important warning about `devfreq_load`: the `load` file of devfreq reads `<duty>@<freq>Hz`,
and that duty is the clock duty cycle, not the utilisation. It reads 100 when idle (the clock at full speed on standby) and also reads 100 at full load.

So `devfreq_load` must carry a `measure` parameter that declares what it reads:

```yaml
  - id: gpu
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fb000000.gpu/load
      measure: utilization      # utilization | duty_cycle
    provides:
      - tag: gpu.usage
        sample: duty
```

A pack with `measure: duty_cycle` must not bind `duty` to any `*.usage` (the semantics of `gpu.usage` in the core vocabulary
are the utilisation). The validator has to reject that combination. This turns the trap the old project fell into in
`core/metrics.py` ("the NPU devfreq load file reads 100@1000000000Hz when idle.
That is a duty cycle, not a utilisation") into a machine-checkable rule.

The `measure` is not optional: a binding to `*.usage` without a declared `measure` is an error for the validator.
A silent default lies — "it did not say it was the utilisation" cannot be read as "it is the utilisation".

---

## 3. Escape hatches

The hybrid has to leave doors open, otherwise an unexpected board leaves no way forward. Three levels, used in this order of preference:

### 3.1 `file_read` — read one file

The most common one. It suits "the value is just a number in a file":

```yaml
  - id: brightness
    kind: file_read
    args:
      path: /sys/class/backlight/backlight/brightness
      format: integer
    provides:
      - tag: custom.rk3588-atk.backlight.brightness
        sample: value
```

### 3.2 `exec_regex` — run one command and take a regular expression

It suits "this value has to be computed":

```yaml
  - id: uptime
    kind: exec_regex
    args:
      command: "cat /proc/uptime"
      pattern: "^([0-9.]+)"
      format: float
    provides:
      - tag: custom.rk3588-atk.uptime_s
        sample: value
```

Note: `exec_regex` has security implications — it runs an arbitrary command on the board.
The validator warns about it (section 7, rule 19), and the runtime audits the actions that execute it (the last paragraph of section 3.3).

But `exec_regex` is not an action, so it does not go through the executor and it carries no authorisation of its own.
That means: a board pack written by an agent could smuggle an arbitrary command into a reader.
The contract has an explicit disposition for that (section 5.6): **the fetching command of a reader goes through the danger floor too** ✓
(rule 28 ✓) — **and it may not carry shell metacharacters ✓ · may not be an interpreter wrapper ✓ · may not be the `script` kind ✓** (rules 29–31 ✓).

### 3.3 In-pack scripts — ⛔ sealed (the third escape hatch that used to exist)

> This section records "why it was sealed", not "how to use it" ✓
> — the usage no longer exists ✓ (section 3.3.1 below only keeps the history ✓).

There used to be a third escape hatch ✓: the pack carried a script ✓, the runtime pushed it onto the board ✓,
every poll executed it with the path ✓, the script printed JSON ✓, and the keys were the names of the samples it provided ✓.

Why it was sealed ✓ (this is the only part of this section that is still alive ✓):

| Reason | Explanation |
|---|---|
| Not one character of the script body is inspected ✓ | The danger floor (section 5.2 ✓) matches command tokens ✓ — and the body of a script is not a command at all ✓ → the floor cannot see it ✓ |
| so it became the way around the floor ✓ | A pack could carry a script with `rm -rf /` in it ✓ while its `kind` looks like a read-only reader ✓ |
| so it was sealed ✓ | Rule 31 ✓: the `script` kind is not allowed in a board pack ✓ (the validator stops it on the spot ✓) |
| but the implementation still has it ✓ | `src/main/tags/kinds/script.ts` ✓ — it was not deleted ✓ → it is dormant ✓ |

> ⚠️ What "dormant" means ⚠️: it is in the implementation ✓ · the validator does not allow it ✓ —
> → so the contract cannot teach it as an available option ✓ → this section only keeps the reason ✓
> → if it is ever reopened, "the floor cannot see the body of a script" has to be solved first ✓
> (that is a problem at the contract level ✓ · not a matter of adding a switch ✓)

#### 3.3.1 · History (⛔ no longer applicable — kept as history, do not implement against it)

> ⚠️ What follows is the design from before the sealing ✓ — the runtime never provided that path ✓
> (it never pushes a script ✓ · it never creates `/tmp/devboard-<session-id>/` ✓) →
> implementing against it means implementing something that does not exist ⚠️.

- The script lives in the pack directory (on the host) ✓, but the board state has to be read ✓ → the runtime first has to push it onto the board ✓
  (once per session ✓, landing in `/tmp` ✓), and after that every poll merely executes it with the path ✓
- When the script has not been pushed up the command cannot run ✓ → the tags of that reader report `unavailable` ✓
  (the same handling as for any other resource that is not there ✓ · never guess ✓)
- The path on the board is decided by the runtime ✓ (the pack does not specify it ✓ — `remote_path` is not a parameter of the pack ✓)
- The execution of the script has to be audited ✓ (it goes into the audit log like an action ✓ · section 5.4 ✓) —
  ⚠️ but it has no `danger` grading ⚠️ → and that is exactly the problem ✓
  (a capability on the read side can still change the state of the board ✓ → it cannot be graded ✓ → the floor cannot reach it either ✓)

---

## 4. Actions (the control plane)

### 4.1 Why an action cannot be just a command

If the control plane offers nothing but "send one command", it is a remote control, not a cockpit.

The definition of a cockpit: a button shows the real state of the board, not the intention you last clicked.

So every action has to declare how it is read back:

```yaml
actions:
  - id: npu.pipeline.start
    label: Start the inference pipeline
    danger: reversible
    params:
      # A string parameter must declare maxLength — a string parameter without an upper bound is an injection surface (section 4.6)
      model: {type: string, maxLength: 64}
      fps:   {type: integer, min: 1, max: 60}
    command: "/usr/local/bin/pipeline start --model {model} --fps {fps}"
    readback:
      tag: custom.rk3588-atk.pipeline.running
      expect: true
```

> This example is the textbook of an injection surface: `model` is a string and the command template splices it into the shell verbatim.
> Under section 4.6 the runtime wraps its value in single quotes and escapes `'`,
> so `yolov8n; reboot` becomes nothing but a harmless parameter value.
> It also shows why a `string` parameter has to declare `maxLength` (validation rule 20).

Three things have to hold at once for the loop to be closed:

1. Clicking → sends the command
2. The readback → reads `readback.tag` to confirm the actual state of the board
3. The UI follows the readback → the button shows the value of `readback.tag`, not whether you clicked it

If the readback fails (the command returned but the state did not change), the card should show "the command was sent, the effect is not confirmed" instead of optimistically showing it as switched on.

Every action has to declare a `readback` (rule 27) —
not only `destructive`, `reversible` as well.
An early version only had rule 15 covering `destructive`, so a `reversible` action without a `readback` passed validation:
the loop was silently broken, and that is a real hole.

An action that genuinely has no readable state takes form 5 `kind: none` (section 4.4.1) —
but it must be written explicitly, and it is limited to `reversible`.

### 4.2 Danger grades

| Grade | Meaning | Example | Behaviour |
|---|---|---|---|
| `reversible` | it can be undone, a mistake can be recovered from | toggling a switch, changing the sampling rate, starting and stopping a service | it is executed directly, but the audit log is written |
| `destructive` | it cannot be undone or it has a global effect | rebooting the board, flashing firmware, formatting | it is executed as it is ✓ (the danger grade is information only ✓) → **the row for that action is off by default** ✓ |

A read is not an action — a read goes through a tag. An action is always a write.

> There are only two grades. An early version had three (`read` / `reversible` / `destructive`),
> which conflicted with this contract and was unified along the contract's own line: a read goes through a tag and is not a kind of action.

> "Reversible" does not mean "harmless". It only promises that it can be undone — setting the backlight to 0 or setting the governor to `powersave`,
> can both be undone, but the user will think the board is broken.
> So the authorisation screen has to show the range of the parameters (see section 5.5) and not only the name of the action.

### 4.3 Parameters

The parameters are declarative, not free text inside a string template:

```yaml
params:
  fps: {type: integer, min: 1, max: 60, default: 30}
```

The values of `type` are closed; only the following are allowed:

| type | Required fields | Explanation |
|---|---|---|
| `integer` | — | optional `min` / `max` / `default` |
| `number` | — | optional `min` / `max` / `default` |
| `string` | `maxLength` | optional `pattern` (a regular expression) and `default` |
| `boolean` | — | takes `true` / `false` |
| `enum` | `values` | `values` is a non-empty list of strings and the value has to hit one of them exactly |

The benefits:

- the validator can check the range before the execution
- the MCP `execute_action` can return the parameter schema, so the AI does not have to guess
- the range of the parameters of a dangerous action is part of the safety boundary (`max: 60` stops the AI from setting the frame rate to 100000)

A `string` parameter has to declare `maxLength`. A string parameter without an upper bound is an injection surface
(section 4.6). The recommended default limit is 256 bytes.

### 4.4 The five forms of the readback

`readback` is one block and one of five forms is chosen:

```yaml
readback:
  tag: some.tag            # form 1: read a tag (the most common)
  expect: true             # the expected value; on a mismatch it reports "the effect is not confirmed"
```

```yaml
readback:
  kind: file_equals        # form 2: read a file and compare the value
  path: /sys/class/backlight/backlight/brightness
  expect: "{value}"        # which parameter to compare against; it can be a parameter name
  tolerance: 1
```

```yaml
readback:
  kind: command_ok         # form 3: the command itself returns 0
```

```yaml
readback:
  kind: verify             # form 4: a second verification (see below)
  command: "test -e /tmp/marker"
  timeout_ms: 5000
```

```yaml
readback:
  kind: none               # form 5: this action has no observable state (see below)
  consequence: "lights the on-board LED for about one second and then turns it off"    # required and non-empty
```

Form 1 is the preferred one, because it reuses the existing tag channel automatically.

#### 4.4.0 supplement · Criteria across targets (the workflow layer, section 5 of `05`)

All five forms in this document read back on the connection that executed them ✓ (the execution and the readback cannot be split apart, section 5.2 ✓).

But the workflow layer has one case that crosses machines ✗: "after the client has run scp, does the file really exist ON THE BOARD"
— that is a fact about another machine ✗ → it is not in the transaction that executed it ✓.

→ A criterion across targets is run by the workflow layer ✓ (section 5 of `05` ✓) →
two facts, two entries in the ledger ✓ (one for the command ✓, one for the criterion ✓).

> The workflow layer still reuses the five forms of this document ✓ (it does not add a sixth ✓),
> it only gains one more `role`: "on which role it is read" ✓.

### 4.4.1 Form 5 `kind: none`: actions that genuinely have no readable state

There is a class of actions that genuinely has no readable state: lighting an LED, writing a string of bytes to a UART,
triggering a buzzer. The contract cannot pretend they do not exist — and it cannot block that road either because they do not exist.

So there is a fifth form, `none`. But it is a narrow door, with four rules:

| Rule | Content | Why |
|---|---|---|
| It must be written explicitly | Not writing a `readback` is not the same as `none` — rule 27 stops the omission | "not writing it" and "writing none" are two different things and only the latter is a declaration |
| `consequence` is required and non-empty | One sentence that describes the side effect, such as "lights the on-board LED for about one second" | It turns "declare the user-visible consequence" from natural language into a mechanically checkable field — without it the validation fails |
| Only `danger: reversible` is allowed | `destructive` still forbids `none` | An irreversible action may not "go unverified". If a destructive action really has no observable final state, the only legal path is to add a `verify` command (such as `test -e /tmp/marker`) — and that is exactly what the `verify` of section 4.5 is for. An action that cannot even do a `verify` must not be declared in v1 |
| A warning per action plus a trace in the audit | The validator records one warning for every action that uses `none`; the audit log has to show "unverified" at a glance | `unavailable ≠ 0` prevents "taking what was not read for what was read"; this rule prevents "taking what was not verified for what needs no verification". Visibility is the main line of defence |

How the execution result is marked: `ok: true` plus `verified: false` (section 2.4 of `04`).
Do not write `ok: false` — the command really ran and the effect was really there (the LED did light up), and reporting a failure is another kind of lie;
and do not write `ok: true` and say nothing either — hiding the "not verified" is exactly the same flaw that made the option
"run a command that is always true with `verify`" unacceptable.

> A `kind: none` is not allowed inside a `verify` block.
> `verify` is another block of section 4.5 (it has `command` / `timeout_ms` / `expect`).
> Giving it a `kind: none` would give "no readback" two spellings,
> and the validator would then have to accept two ways of expressing the same thing — only `readback: {kind: none}` is kept.


The `expect` may name a parameter: `expect: "{value}"` means "after the file has been read, its value should be equal to the `value` parameter of this call".
That is better than hard-coding the expected value into the pack.

The substitution of `{param}` is allowed in three places: `command`, `readback.path` and `readback.expect` — a `{cpu}` in a place like
`/sys/devices/system/cpu/cpu{cpu}/cpufreq/...` is necessary.
The validator scans all three: a parameter that appears in only one place is a "dead parameter",
and a `{param}` that appears nowhere is "undeclared".

### 4.5 `verify`: the verification form for irreversible actions

A `command_ok` only says that the shell accepted the command, not that the board entered the target state.
For a `destructive` action that is especially not enough — a reboot command returning 0 does not mean the board rebooted successfully.

So there is a fourth form, `verify`:

| Field | Required | Meaning |
|---|---|---|
| `command` | Yes | The verification command. The command must return 0 for the verification to count as passed |
| `timeout_ms` | No | The verification timeout, 5000 by default |
| `expect` | No | The expected exit code, 0 by default |

The `verify` runs after the action has been executed (not before).
The flow: send the command → wait for the board to reboot → poll the verification command until it succeeds or times out → on a timeout report "the effect is not confirmed".

A `destructive` action must have a `readback` (form 1/2) or a `verify` (form 4), it must not use `command_ok` (form 3), and it must not use `none` (form 5).
The validator enforces this.

> There is no exit code on serial. The old project's measurements: serial cannot get an exit status,
> "there is a textual reply = 0, a timeout = 124" (fact S5 in `docs/02-device-facts.md`).
> So on the serial transport both `command_ok` and `verify` are unavailable —
> the runtime has to refuse to execute an action that depends on the exit code on those transports instead of pretending it succeeded.
> On serial only form 1 (tag) or form 2 (file_equals) can be used.

### 4.6 How the parameters enter the command (the injection defence)

The `command` is a template, but the parameter values are not spliced in verbatim. This is one of the safety floors of this contract.

Rules:

1. The parameter values are encoded by `type` before they are injected:
   - `integer` / `number` → injected as a decimal numeric literal, without quotes and without any other character;
   - `boolean` → `true` / `false`;
   - `enum` → it has to be one of the entries of `values`, injected verbatim (the `values` are written by the author of the pack and are validated);
   - `string` → wrapped in single quotes, an inner `'` escaped as `'\''`, and the length does not exceed `maxLength`.
2. Do not add your own quotes where you write `{param}` in the template — the encoding is the runtime's responsibility as a whole,
   and quotes added by the author of the pack pile up with the quotes added by the runtime and produce the wrong meaning.
3. The validator checks: a `string` parameter whose placeholder in the pack is wrapped in quotes (such as `'{value}'`) is an error.
4. The runtime validates by type once more before the execution (it does not trust the pack's own statements) and refuses to execute with
   `invalid_params` when the validation fails.

Why it has to be this way: the board-side session runs as root (the measurements around fact A1/S1 in `docs/02-device-facts.md`),
a single `--model 'x; reboot'` turns "start the pipeline" into "reboot the board",
and `reboot` is not in the template of that command at all — so the floor of section 5.2, which matches the template, cannot stop it (see section 5.3).

> The parameter encoding belongs to the contract and the runtime is responsible for carrying it out. The pack only declares the types and the ranges and is not responsible for escaping —
> ten authors of packs write ten kinds of escaping, and nine of them are wrong.

---

## 5. Permissions and security

The actions in a board pack are not automatically allowed to run. The permission is declared on the card side and granted by the runtime.

### 5.1 Grading

| Tier | Where | Meaning | Authorisation |
|---|---|---|---|
| read | the card's `permissions.read` | read a tag | not needed (a tag is read-only to begin with) |
| `reversible` | `danger: reversible` in the board pack | a reversible write | it is executed directly ✓ → **the row for that action in the unified permission area decides whether it may run at all** ✓ |
| `destructive` | `danger: destructive` in the board pack | a destructive write | it is executed as it is ✓ (the danger grade is information only ✓) → **that row is off by default** ✓ → turning it on is the informed consent ✓ |

A read is not an action. A read goes through a tag and `permissions.read` needs no authorisation flow.
There is no `danger: readonly` action in a board pack either — an action is always a write.

The authorisation is per action, not a blanket one. Installing a card does not mean installing the permission for all of its actions.

### 5.2 The floor of the danger grades

The pack declares `danger` itself. But an agent can write packs — without any other constraint a pack that declares `reboot` as `reversible`
can call a dangerous action safe, and the grading becomes decoration.

So there is a floor:

> Some operations are always `destructive`, no matter what the pack declares.

The floor is a fixed table of operation patterns. It belongs to the contract and to no pack:

| Pattern | The operation it matches |
|---|---|
| `reboot` / `shutdown` / `poweroff` / `halt` | rebooting and shutting down |
| `flash*` / `upgrade` / `erase` / `burn` | flashing storage |
| `mkfs*` | formatting |
| `dd` written to `/dev/mmcblk` `/dev/sd` `/dev/nvme` | writing a raw block device |
| `rm -rf /` and its equivalent forms | deleting the root |
| `iptables -F` / `nft flush ruleset` | clearing the firewall rules |

Where the floor takes effect ✓ (changed on 2026-11-16 ✓):

| Place | What it does |
|---|---|
| The validator (section 7, rule 16 ✓) | A pack that declares a command that hits the floor as `reversible` is an error straight away ✓ → that pack does not load at all ✓ |
| The permission area of the settings page (`03` section 2.4 ✓) | A dangerous action is marked "destructive action" on that row ✓ → its switch is off by default ✓ → turning it on is the informed consent for that one step ✓ |
| The runtime | It no longer re-checks ✓ — it no longer "asks whether it is dangerous" ✓ (the user on 2026-11-16: "use permissions for everything" ✓) |

The floor is a lower bound, not an upper bound. A pack may mark more actions as `destructive`,
but it cannot downgrade what is on the floor.

Why the matching is on command patterns and not on a list of actions: what has to be stopped is a command, not an action id.
A `reboot` can hide in any action: `system.reboot`, `board.power_cycle`, `do_a_soft_reset`.
Matching on the command stops "what this command really does" and not "what this action is called".

The executable version is provided by the implementation layer (a table of command patterns plus a matching function).

#### 5.2.1 How the floor matches (the matching specification)

The floor table is the contract, so the matching rules have to be the contract as well — otherwise different implementations reach different verdicts.

What is matched is the parsed command, not the template. The order is fixed:

1. First the parameters are encoded into the template as in section 4.6, which yields the final command string;
2. The final command is split into an argv sequence by shell lexing (no shell is executed and no variable expansion is done);
3. The floor is matched against the argv sequence.

If the template were matched first, `pipeline start --model {model}` contains no `reboot` and the injected `reboot` would never be matched —
the floor would be useless.

Matching rules:

| Item | Rule |
|---|---|
| The unit of matching | a single token of the argv (not a substring) |
| Token equality | only `argv[i] == pattern` counts as a hit; `upgrade_status.sh` does not hit `upgrade` |
| Prefix matching | a prefix match is only allowed when the pattern ends with `*` (for example `flash*` hits `flash_uboot` and `mkfs*` hits `mkfs.ext4`) |
| The basename of a token counts too | The basename of `/sbin/reboot` is `reboot` → it hits `reboot`. Real invocations almost always carry an absolute path — matching the literal only would leave the floor empty in real usage |
| Path patterns | The path is normalised first (expand `..`, collapse repeated `/`, drop the trailing `/`) and only then compared |
| `dd` patterns | Match the `dd` token plus a destination argument that hits a block device path (the value of `of=`, or the argument right after it) |
| `rm -rf /` patterns | Match `rm` plus the `-rf`/`-fr` combination plus a path argument that equals `/` after normalisation. `/*` expands to all the entries of the root directory → it is equivalent to `/` (that is what the "and its equivalent forms" row of the table means) |
| The direction of a failed match | Failing to match does not mean safe. A pattern that is not in the table follows the declaration of the pack, but the runtime must record a warning |

The floor table has to carry a version. It is part of the contract, so it carries `danger_floor_version`:

```yaml
danger_floor_version: 1
```

The v1 table is the six rows above. Changing the floor table means changing the contract, it has to go through a review and bump `apiVersion`.
When a pack does not declare `danger_floor_version` it is treated as 1 by default.

> Why "failing to match does not mean safe" is written into the contract: a table of operation patterns is never complete.
> If the rule were "a non-match passes", then every omitted row would open a back door;
> if the rule were "a non-match counts as destructive", then every command would need a human and the product would be unusable.
> So the middle ground is chosen: a hit inside the table forces destructive; outside the table the declaration of the pack applies, but a warning is recorded.
> The recorded warnings are the input of the next version of the floor table.

### 5.3 dry-run

With `dry_run: true` it returns "what would be executed" and executes nothing:

```json
{
  "dry_run": true,
  "command": "/usr/local/bin/pipeline start --model yolov8n --fps 30",
  "readback_tag": "custom.rk3588-atk.pipeline.running"
}
```

> The default behaviour of `destructive` is **"it runs"** ✓ — the danger grade is information only ✓ —
> **the gate is the unified permission area in the settings** ✓ → **that row is off by default** ✓
> → **turning it on is the informed consent for that one step** ✓.
>
> `dry_run` is a preview that the agent asks for on purpose ✓ — it is **not** the default behaviour of a `destructive` action ✓.
> The return value of a dry-run is not an execution result ✓ → **so a dry-run never runs anything** ✓.

### 5.4 The audit log

Every action execution writes one line: the time, the trigger (the card id / the agent / the user), the action id, the parameters,
the final command (encoded ✓), the input values (used by the workflow layer ✓), the result and the readback value.

> Why the "final command" and the "input values" are required ✓:
> with only the action id and the parameters you cannot reconstruct afterwards what was actually executed ✗;
> the inputs of a workflow are declared in the workflow pack (not in the board pack ✓) →
> without them all you can see afterwards is "some step ran", not "which project was used" ✗.

An action that uses `none` (form 5) has to be marked "unverified" on that line — otherwise there is no accountability afterwards:
the log says "success" and the reader does not know that nobody verified it.

It follows the shape of the old project's `core/session_log.py` (append, flush per line, a timestamp prefix) — that one has been validated: even after a crash it leaves a readable record.

### 5.5 Authorisation granularity: the action id plus an optional parameter domain

The authorisation is per action (`03-card-manifest.md` section 3.2), but the action id alone is not fine-grained enough:
the card declares "this card may change the backlight brightness", and what is actually granted is the whole `0..255` range,
including turning the screen completely black.

So an action can declare a parameter domain (a `guard`), which declares "within which range of parameters this action counts as mild":

```yaml
actions:
  - id: backlight.set
    label: Set the backlight brightness
    danger: reversible
    params:
      value: {type: integer, min: 0, max: 255}
    guard:
      value: {min: 16, max: 255}     # inside [16,255] = mild; outside = refused (denied)
    command: "echo {value} > /sys/class/backlight/backlight/brightness"
    readback:
      kind: file_equals
      path: /sys/class/backlight/backlight/brightness
      expect: "{value}"
      tolerance: 1
```

Semantics:

| Situation | Behaviour |
|---|---|
| The parameter value falls inside the `guard` | It is executed directly (the audit is still written) |
| The parameter value falls outside the `guard` | It is refused ✓ (`denied` ✓ — the guard is the line the author of the pack drew ✓ — outside it is not permitted ✓ — since 2026-11-16 there is no "ask once" any more ✓) |
| No `guard` is declared | It is equivalent to a `guard` = the full declared domain of the parameters, that is, the range is not narrowed |

> The reason codes of an action execution follow the table of section 2.4 of `04` — this table does not introduce one of its own.
> (History: `needs_approval` → `needs_confirmation` (2026-11-14) →
> from 2026-11-16 that tier is gone ✓ — going outside the domain is a direct `denied` ✓.)

A `guard` may only narrow the range, never widen it. The validator checks:
the interval of the `guard` has to be a subset of the declared domain of the `params`, otherwise it is an error.

> Why the pack declares the `guard` instead of the card declaring one: what the card asks for is "let this card set the backlight to 30",
> not "let this card set the backlight to 0". The parameter domain is declared by the author of the pack (possibly an agent),
> but it may only narrow and never widen the declared domain of the action itself — so an agent cannot widen its permissions by writing a wide `guard`.
> The row for that action in the settings page has to show that domain ✓ (`03` section 2.4 ✓).

### 5.5 supplement · Authorisation in the workflow layer (`05-workflow-pack.md` section 7)

A workflow is not an action (it is not in a board pack ✓), but it can execute commands on the user's machine just the same ✗
→ its entry point has to be stricter than an action's ✓:

| Item | Rule |
|---|---|
| Two layers of authorisation | The card declares the workflow in `permissions.workflows` ✓ (`03` section 2.4 ✓) → the row for that workflow in the unified permission area is enabled ✓ → both layers have to pass ✓ (the card level layer was removed on 2026-11-16 ✓) |
| Only ids are accepted | Cards and agents cannot supply a path ✓ (a pack can only be taken from the registry by its id ✓) |
| The content digest of the pack is recorded | Changed content → a different digest ✓ → the change stays visible in the audit trail ✓ (`05` section 7.2, rule T2 ✓) |
| Every write step goes through the floor | A free command is a second command channel ✗ → it has to share the same line of defence as an action ✓ |

### 5.6 Who may write a board pack (the fact that a reader can also run arbitrary commands)

The problem: the danger floor of section 5.2 only governs actions. But `exec_regex` is a reader —
they run arbitrary commands on the board without going through the floor and without needing the authorisation of the user.

And section 2.4.2 of `spec/04` says "a pack takes effect unconditionally … an agent may write a board pack extension,
use it straight away, no approval by the user is needed". Put together, the two rules mean:

> The agent writes a board pack, and in a reader it uses `exec_regex` to run a command —
> that command used to go onto the board without the danger floor ever seeing it.

That was a way around the floor. The disposition below closes it.

The disposition: a board pack is a device permission, not a card.

| Rule | Content |
|---|---|
| Who may write a board pack | A human. The user can edit `profiles/boards/` locally and can also have an agent draft a pack; a pack takes effect as soon as it is written ✓ (the board description file has the final say ✓ — the user on 2026-11-16: "add a board and whatever is in it executes" ✓) |
| The precondition of taking effect | There is no extra gate ✓ — but the contents of the pack still have to follow the rules ✓: the actions go through the danger floor and the `danger` grade ✓ (section 5.2 ✓) · the fetching command of a reader goes through the danger floor ✓ (rule 28 ✓) · the tag / sample / capability vocabularies go through the validation ✓ (section 7 ✓) |
| Drafted by the agent | The agent may write files (that is its day job) ✓ — but what it writes goes through the validation all the same ✓ (rule 28 is part of that validation ✓) |
| A pack that fails to load does not take the other capabilities down with it | When a pack fails to load, the tags of that connection report `unavailable`; the terminal and the file transfer keep working as usual (the same applies to section 10.1) |

> Why there is no "a human must confirm before it is enabled" gate (changed on 2026-11-16 ✓):
> → it is what the user wanted ✓: "the board description file has the final say" ✓ "add a board and whatever is in it executes" ✓ "having to agree to this and to that as well, is that not tiring" ✓.
> → the gate that replaces it is rule 28 ✓ — the command of a reader goes through the floor by itself ✓ (that is the only place where a reader can overstep ✓).
> → the path of the action has always been there ✓: the danger floor ✓ + the `danger` grade ✓ + **the row for that action in the unified permission area** ✓ (`04` section 2.4.1 ✓).

Why the cut is made this way: section 1.3 of `spec/04` says "no bare send_command",
but a reader that can run an arbitrary command IS a bare command channel —
it only has a different entrance. The contract cannot forbid bare commands on one side and hand the agent the same road on the other.

The disposition today (changed on 2026-11-16 ✓):

| Option | The conclusion today |
|---|---|
| A pack takes effect unconditionally (also one written by the agent) | ✅ It was changed to this ✓ — the user's own words: "add a board and whatever is in it executes" ✓ "the board description file has the final say" ✓ |
| Let the readers go through the danger floor as well | ✅ It was changed to this ✓ — rule 28 ✓ (the fetching command of a reader hits the floor → the pack does not pass the validation ✓ → it does not take effect ✓) |
| Forbid `exec_regex` / `script` outright | ⚠️ Only `script` was forbidden ✓ (rule 31 ✓ — it executes a body ✓ — the floor cannot see it ✓); `exec_regex` stays ✓ (it is an escape hatch ✓) → but two more rules were added ✓: rule 29 (the parameter values may not contain shell metacharacters ✓) · rule 30 (the command may not contain an interpreter / a downloader / a privilege escalator ✓ — wrapping it is how the floor is bypassed ✓) |

> The old decision "a pack takes effect unconditionally" (`SPEC-D12`) is no longer narrowed ✓ — any pack takes effect ✓
> (but the pack still has to pass its own validator ✓ — rules 28/29/30/31 are that gate ✓).
>
> The hole the independent review of 2026-11-16 found ✓ (the strength of the rules ✓ — not the number of the rules ✓):
> rule 28 only stops the handful of words that are in the floor table ✓ → `bash -c 'rm -rf /'` does not match ✓ →
> so rules 29 and 30 were added ✓ — the same thing written differently gives the opposite conclusion ✗ → that is not a design trade-off, that is a hole in the matcher ✓.

---

## 6. The version of a pack

| Field | Meaning |
|---|---|
| `apiVersion` | The contract version (`devboard/v1`). It only changes when the format itself changes |
| `version` | The version of this pack itself. It is bumped when the contents of the pack change |
| `requires.min_contract` | Which contract version is required at least |

The semantics in the core vocabulary never change. To change the semantics, bump `apiVersion` and start a new tag name — never change the meaning of an existing tag in place, or every published card would quietly start lying after some upgrade.

---

## 7. The validation rules (what the validator has to stop)

Before a pack is accepted it has to pass at least these checks. These 31 rules are the contract itself —
the implementation layer has to implement them one by one; missing one means the board pack format is not implemented.

The command-line entry point of the validator is up to the implementation layer (for example `npm run validate:profiles` ✓),
but the rules themselves are the ones of this table and they do not change with the implementation.

| # | Rule | Why |
|---|---|---|
| 1 | Every `provides[].tag` matches the core vocabulary or falls under `custom.<the id of this pack>.` | It prevents a typo and a private widening of the vocabulary |
| 2 | The tag patterns of two readers must not overlap | `cpu.core.*.usage` and `cpu.core.3.usage` would collide at runtime |
| 3 | With `devfreq_load` and `measure: duty_cycle`, `duty` must not be bound to any `*.usage` | That is exactly the duty cycle trap |
| 4 | When `devfreq_load` is bound to `*.usage` it must declare `measure: utilization` | A silent default lies |
| 5 | `proc_stat` must bind `usage` to `cpu.usage` | The semantics of the first pending |
| 6 | Every `provides[].sample` has to be a sample that the kind can produce | The binding points at data that does not exist |
| 7 | The number of `*` in the tag and in the sample must be the same, the number of segments need not be | Two namespaces, the lengths may differ |
| 8 | Every parameter a reader declares must exist in the schema of the kind | A mistyped parameter name would be silently ignored |
| 9 | A required parameter must not be missing | |
| 10 | An unknown top-level field is an error | A field that is silently ignored is a field that was mistyped |
| 11 | `match.models` has to be a non-empty list of strings and `match.mode` may only be exact or substring | The automatic identification depends on it |
| 12 | The `readback.tag` of every action has to be a tag that this pack provides | Otherwise the loop is broken |
| 13 | Every `{param}` in the `command`, `readback.path` and `readback.expect` of an action has to be declared | A mistyped parameter name only blows up at runtime |
| 14 | A parameter that is declared but used nowhere is a dead parameter | A dead parameter |
| 15 | An action with `danger: destructive` must have a `readback` (form 1/2) or a `verify` (form 4), it must not use `command_ok` and it must not use `none` (form 5) | An irreversible action may not be sent blindly |
| 16 | A command that hits the danger floor must be declared as `destructive` | The agent may not downgrade it by itself |
| 17 | Every reader must belong to exactly one poll group | No group means no round trip means it is never read |
| 18 | The `interval_ms` of a poll group must not be below 200 | Too frequent and the board is swamped |
| 19 | When `exec_regex` is present, print a warning | It can execute arbitrary code (`script` is completely forbidden by rule 31 ✓ · this rule can therefore never fire for it ✓) |
| 20 | The `type` of every `params.<name>` has to be one of the values of the table in section 4.3; an `enum` must have non-empty `values`; a `string` must have a `maxLength` | A closed set of types, otherwise the validator has nothing to work with |
| 21 | A `{param}` placeholder in a `command` template must not carry quotes of its own | The quotes are encoded by the runtime as a whole (section 4.6) and piling them up goes wrong |
| 22 | A `guard` has to be a subset of the declared domain of the `params` | A `guard` may only narrow the authorised range, never widen it |
| 23 | The `kind` of a `readback` has to be one of `file_equals` / `command_ok` / `verify` / `none` (without a `kind` it reads a tag as in form 1) | The set of readback forms is closed |
| 24 | A declared `danger_floor_version` has to be a known version (there is only 1 at the moment); an unknown top-level field is an error | A field that is silently ignored is a field that was mistyped |
| 25 | Every value of `requires.capabilities` has to belong to the closed vocabulary `{shell, exec, stream, files}` (section 10.7) | A mistyped capability name has to be an error and not silently ignored (the same closedness principle as rule 24) |
| 26 | Every value of `requires.capabilities` has to belong to the set of capabilities the runtime has implemented (v1 = `{shell, exec, files}`). Declaring a capability that cannot be delivered is an error and not a warning | Declaring something that can never be delivered promises a delivery that does not exist. `stream` is not in the set because the Stream contract is missing (section 7 of `00-overview.md`) |
| 27 | Every action must have a `readback` block whose `kind` belongs to `{file_equals, command_ok, verify, none}` (without a `kind` it reads a tag as in form 1); when its `kind` is `none` it must carry a non-empty `consequence` | Only rule 15 covers `destructive` → a `reversible` action without a `readback` passes the validation → the loop is silently broken. `none` is the only legal way of saying "I have no readable state" — the same thing must not be expressed by "not writing it" |
| 28 | The fetching command of a reader must not hit the danger floor (the `command` of `exec_regex` goes onto the board verbatim ✓ → so it has to go through the floor itself ✓) | A board pack takes effect directly ✓ ("the board description file has the final say" ✓) → the "a human must confirm before it is enabled" gate is gone ✓ → this rule is the gate that replaces it ✓. A reader is not an action ✓ — it does not go through the executor ✓ — so it is judged here ✓ |
| 29 | The parameter values of a reader must not contain shell metacharacters (`;` `|` `&` `` ` `` `$` `>` `<` and a newline ✓). Exceptions: the `command` and the `pattern` of `exec_regex` ✓ · the path and the interpreter of `script` ✓ | The fetching fragment of a reader is spliced into one shell command ✓ → a value with a metacharacter means a second command is spliced in ✓ (that is the road around the floor ✓). The metacharacters of a regular expression do not count ✓ (a regular expression is not a shell ✓) |
| 30 | The `command` of an `exec_regex` must not contain an interpreter / a downloader / a privilege escalator (`sh` `bash` `env` `xargs` `python*` `perl` `node` `curl` `wget` `nc` `busybox` `sudo` `su` … in any position ✓) | The floor table matches words ✓ — `bash -c 'rm -rf /'` does not match a single word ✓ → the wrapper is the road around the floor ✓ → so these words must not appear ✓ |
| 31 | The `script` kind is not allowed in a board pack | It executes the body of a script ✓ — not one character of that body is inspected ✓ → the floor cannot see it ✓ → do not leave a hole that "will be opened some day" ✓ (the runtime still does not push a script onto the board ✓ → it is dormant ✓) |

> Rules 20–24 were added by the review of 2026-11-12. The first 19 rules were already part of the contract in the `0244852` revision,
> and the last 5 close the holes the review found: a closed type set, the parameter encoding, the `guard` subset and the closed set of readback forms.
>
> Rules 25–27 were added by the decisions taken before plan 2 on 2026-11-13 ✓:
> the first two close the hole of a `requires.capabilities` that nobody validates and nobody consumes —
> not one of the 24 rules checked it; the last one closes the hole in the loop of "a `reversible` action may omit the readback".
>
> Rule 26 reads a data table, it is not a hard-coded `if (stream)`.
> The day the Stream contract lands, what changes is that table and not the rule.

The three checks that the validator does not perform and the runtime does (because they depend on the runtime state):

| # | Check | Where it is checked |
|---|---|---|
| R1 | The parameter value falls inside the `guard`, otherwise `denied` (changed on 2026-11-16 ✓) | before the execution in the runtime |
| R2 | `command_ok` / `verify`, which depend on the exit code, are unavailable on serial | before the execution in the runtime |
| R3 | A command outside the floor table records a warning | before the execution in the runtime |

---

## 8. The directory layout

```
profiles/
  boards/
    rk3588-atk/
      board.yaml            # the board pack
      README.md             # the supplementary notes for humans (how to connect it, the known traps)
    rk3568/
      board.yaml
```

One directory, one pack.

> ⚠️ The pack directory does not carry a `scripts/` directory any more ✓ — the `script` kind is sealed ✓ (rule 31 ✓ · section 3.3 ✓)
> → that road is not implemented ✓ → putting a script into the directory is not read either ✓

---

## 9. The two top-level lists: `readers` and `custom`

A board pack has two lists of readers:

| List | The readers in it | The tags it provides |
|---|---|---|
| `readers` | the capabilities that the board has in general | the tags of the core vocabulary (`cpu.usage` and the like) |
| `custom` | the capabilities that are specific to the board | the tags under `custom.<the id of this pack>.*` |

The only difference between the two is the namespace of the tags. The runtime treats them exactly the same: each reader has to belong to a poll group,
each has to use the same table of reader kinds, and each has to have a `provides` binding.

The split into two lists is for humans: reading `readers` tells you "the quantities this board has in general",
reading `custom` tells you "the quantities that are specific to this board". The machine does not tell them apart.

---

## 10. How a pack is bound to a connection

A board pack describes "what this board is"; a connection (a connection profile) describes "how to connect to this board".
The two are separate, but the runtime has to know which pack goes with which connection.

Three ways to bind, ordered by how reliable they are:

| Way | How it is decided | Advantages and disadvantages |
|---|---|---|
| Named in the connection | the connection profile carries `board_pack: rk3588-atk` | the most explicit, but it has to be written in every connection |
| Automatic identification | read `board.model` and match it against the `match` rules of the pack | convenient, but the board has to support reading its model |
| Probing | try the readers of several packs and see which one reads something | slow and it can misjudge |

"Named in the connection, with automatic identification as the fallback" is chosen:

```json
{
  "id": "board-adb",
  "label": "Board · ADB",
  "transport": "adb",
  "options": { "pty": false, "prompt": "root@board" },
  "board_pack": "rk3588-atk",
  "device_key": "ATK-DLRK3588"
}
```

> The name of the binding key is `board_pack`. That is the contract's line,
> and `docs/spec/04-mcp-tools.md` both use it. The key `board` also occurred historically,
> and it is now unified to `board_pack` — the runtime only recognises `board_pack`
> and reports "unknown top-level field" for `board` (the same closed rule as rule 24 of section 7).

### 10.1 The format of a connection profile (closed ✓)

> Why this section was added ✓: it had no table of fields before ✓ — only one example JSON ✓.
> To add a field you first need a table ✓ (otherwise "closed" cannot be talked about ✓).

| Field | Required | Meaning |
|---|---|---|
| `id` | ✅ | the id of the connection (globally unique ✓) |
| `label` | ✅ | the name for humans |
| `transport` | ✅ | `serial` / `adb` / `ssh` / `local` |
| `board_pack` | | the id of the board pack it is bound to (when it is absent it is not bound ✓) |
| `device_key` | | the identifier of this board ✓ (when it is absent it is the `id` ✓) |
| `options` | ✅ | the parameters of the transport itself ✓ (closed per transport ✓ — an unknown key is an error ✓) |

An unknown top-level field is an error ✓ (the same closed rule as rule 24 of section 7 ✓).

### 10.1.1 The two layers of one profile

> **The identity comes from the shipped profile ✓ · the machine-specific values come from the user's copy ✓** (decision record SPEC-D28 ✓).

| Layer | The fields | Where it comes from | Why |
|---|---|---|---|
| **The identity** | `label` ✓ · `transport` ✓ · `board_pack` ✓ · `device_key` ✓ | the **shipped** profile ✓ | it says **which board** it is ✓ and **which channel** it uses ✓ — it does not belong to one machine ✓ |
| **The machine-specific values** | the `options` ✓ (the address ✓ · the serial number ✓ · the serial port ✓ · the credential ✓) | the **user's** copy ✓ | they belong to **the machine the profile is used on** ✓ |

| Item | Rule |
|---|---|
| The same id in both directories | **one profile** ✓ — the two copies are merged ✓ |
| The merge | the identity from the shipped profile ✓ · the options field by field ✓ (the user's value wins ✓ · the shipped fields the user's copy does not name survive ✓) |
| An option of the user's copy that the transport does not allow | it is **dropped** ✓ (the shipped value stays ✓) — a profile that does not fit its transport is not a profile ✓ |
| A copy that is stale | it is **reported** ✓ (and the shipped identity is used ✓) |
| A profile that only the user's directory has | it is used **as it is** ✓ (the wizard's own board ✓) |

> **Why not "the user's copy wins completely"** ✓: a copy that is written once and never touched **freezes** the profile ✓ → a shipped fix never reaches the machine ✓ (found on 2026-11-21 ✓: the board was still called `atk-01` although the shipped profile says `ATK-DLRK3588` ✓).

### 10.2 `device_key`: the physical board and the connection are two layers

| Item | Rule |
|---|---|
| What it is | the identifier of this board ✓ — several connections of the same board give the same value ✓ |
| Its domain | an id in the space of the profile ids ✓ — not a host name and not a URL ✓ |
| When it is absent | the `id` ✓ (that is how a connection with one board and one link is handled ✓) |
| Validation | several profiles with the same `device_key` must declare the same `board_pack` ✓ — a board has only one model ✓ → an inconsistency records a warning ✓ (it does not take the application down ✓ — the same as "a broken file is only skipped" ✓) |

> Why this layer is needed ✓: a board has three connections, ADB / serial / SSH ✓ →
> the interface has to group by board ✓ → so it first has to know which connections are the same board ✓.
> → `board_pack` is the "board pack" (the model) ✓ and not the "physical board" ✓ — two boards of the same model share one pack ✓.

### 10.3 `options.ssh`: the SSH endpoint of the machine behind this connection

> It crosses transports ✓ — an ADB connection also knows whether the board behind it can be reached over SSH ✓.

```jsonc
{
  "id": "board-adb",
  "transport": "adb",
  "board_pack": "rk3588-atk",
  "device_key": "ATK-DLRK3588",
  "options": {
    "serial": "0000000000000000",
    "pty": false,
    "ssh": { "host": "192.168.5.100", "port": 22, "username": "root" }
  }
}
```

| Item | Rule |
|---|---|
| Its shape | `{ host, port?, username? }` (closed ✓ — an unknown key is an error ✓) |
| Who writes it | Every transport may carry it ✓ (it is a fact that crosses transports ✓) |
| A profile with `transport: 'ssh'` | It must not carry it ✓ — it is that endpoint itself ✓ (`options.host` already is ✓) → writing it twice means drift ✓ |
| `transport: 'local'` | It must not carry it ✓ (it is the host itself ✓) |
| A conflict | It is an error ✓ (not "who wins" ✓ — never guess ✓) |

> Why it is needed ✓: an action that crosses machines is started on the other machine ✓ (`05` section 8.C ✓) →
> that command needs the SSH address of the board ✓ → the workflow pack should not know the address of the board ✓ →
> it travels with the profile ✓ (machine-specific values do not go into a pack ✓ — see SPEC-D26 in `00-overview.md` ✓).

#### 10.3.1 The credential: the key that opens the host

> The credential is as **machine-specific** as the address ✓ (decision record SPEC-D29 ✓).

| Item | Rule |
|---|---|
| Where it lives | in the `options` of the **ssh** transport ✓ (`key_filename` ✓ · `password` ✓) — a published repository must not carry it ✓ |
| Which key it is | **the key that authenticates at that host** ✓ — the criterion is the handshake ✓ (**a measurement ✓** — never a guess ✓) |
| The address of a **machine that is not a board** ✓ (the guest ✓) | it comes from the person's own ssh records ✓ (`~/.ssh/known_hosts` ✓ · `~/.ssh/config` ✓) → **the board's address never leaks into it** ✓ |
| The address of a **board** ✓ | it comes from the board itself ✓ (`adb shell ip -4 addr show` ✓) |
| A stored address that does not answer | it is **detected again** ✓ (a value that looks plausible but is wrong was invisible to the "is it a placeholder" check ✓) |
| The failure | it says **which** problem it is ✓: the host did not answer ✓ · the host answered and refused the credential ✓ · there was no credential at all ✓ |

> → **The three link kinds are one shape** ✓: **the host → the board** ✓ · **the host → the host-machine (the guest)** ✓ · **the guest → the board** ✓ (it travels with the profile ✓ · `options.ssh` ✓).
> → **Adding a board is adding a kit** ✓ (`06` ✓) — nothing in the code changes ✓ (decision record SPEC-D27 ✓).

### 10.4 The interface lists boards only: the host picks the connection

> The user was explicit on 2026-11-16: "the devices go at the very top of the interface, only the board selection is supported,
> right now there is the fake one and the real 3588 one, do not put the connections and that in there" ✓
> Decision: the interface lists boards only, and the host picks the connection ✓

| Item | Rule |
|---|---|
| What the interface lists | Boards ✓ (the `device_key` ✓) — not the connections ✓ |
| What a board is | At least one connection has a board pack bound to it ✓ — the same yardstick as the runtime candidates ✓ (the `pickCandidates` of `tags/runtime.ts` ✓) → the local machine and the client machine are not boards ✓ |
| The name of the board | It is the `device_key` ✓ (no invented names ✓ — the labels of the three connections differ ✓ → whichever one is taken is invented ✓) |
| Who picks the connection after a board is clicked | The host ✓ (the interface hands over the `device_key` ✓ → the host looks up its connections by `device_key` ✓ → it tries them one by one ✓ → it uses the first one that connects ✓) |
| Already on that board | It does not reconnect ✓ (connecting for nothing drops the readings ✗ — the sampler would restart ✓) |
| None of them works | It is an error ✓ (it says clearly why each one failed ✓ — it does not silently swap in another board ✗) |
| Where the board goes | At the very top of the interface ✓ (on the title bar ✓ — "I am on this board" has to stay visible ✓ — a page header moves around with the page ✗) |

The channel name: the IPC `connections:select` (by connection) is replaced by `devices:select` (by board) ✓ —
what the interface hands over is the identity of the board ✓ and not a connection id ✓.
The MCP `list_connections` does not change ✓ (it lists the connections ✓ — the agent has to see the channels ✓ — what the interface shows and what a person sees are not the same thing ✓).

When no `board_pack` is written, the runtime reads `board.model` and looks for the matching pack according to the `match` rules of the pack:

| mode | Rule |
|---|---|
| `exact` | the model string is exactly one of the entries of `models` |
| `substring` | the model string contains one of the entries of `models` |

The timing of the automatic identification: it happens after the connection has been established and before the readers start.
During the connection handshake `board.model` is read once (one round trip), the board pack is chosen from it,
and only then does the sampling start along the poll groups of that pack.

> Why the timing has to be spelled out: the automatic identification itself reads `board.model`,
> and `board.model` is a tag provided by some board pack.
> If the binding happened before the readers started, there would be a chicken-and-egg problem.
> So the automatic identification uses a one-off probe (matching the string against `match.models`),
> not "run the readers and see whether something comes out" —
> the latter (probing to match) recurses forever. The contract therefore does not adopt probing to match.

What happens when it cannot be recognised: never guess. It reports "this board has no board pack", the terminal and the file transfer keep working as usual,
and the monitoring and the control clearly show "unavailable".

The promise of "never guess" is very concrete: bind a `gpu.usage` to a board without a GPU
and the card shows a gauge that is pinned at zero — a gauge that does not look wrong is more dangerous than no gauge at all.

### 10.5 What happens when a connection has no pack

The connection is up, but there is no matching board pack:

- the terminal works as usual (the terminal only needs the HAL, not any board knowledge)
- the file transfer works as usual
- the monitoring and the control are unavailable and clearly show "this board has no board pack"

This matters: a board pack is an enhancement, not a precondition. The user brings a new board, first connects it and can type commands,
and adds a pack afterwards.

### 10.6 What `requires.transports` means

A pack may declare which connection methods it needs (`[adb, serial, ssh]`).
That is information, not a restriction — it tells the runtime "this pack also works over serial", so that the runtime knows
that the same pack can go with several connections.

But serial and ADB are not the same thing: serial has one line at a time and the multi-line snapshot of `/proc/stat` does not run on serial.
So the way a reader fetches has to adapt to the transport, and that is the responsibility of the runtime and not of the pack.

Concretely: the same `proc_stat` reader may fetch several lines over ADB,
and over serial it has to use the single-line variant (the `SNAPSHOT_ONELINE` of the old project's `core/metrics.py` exists for exactly that,
and its comment reads "a UART has no room for a multi-line script").

The pack is not aware of the transport. That is deliberate: the pack describes the board, the HAL describes the channel, and the runtime connects the two.
When one pack goes with ADB and with serial, each channel uses its own way of fetching and produces the same tags.

### 10.7 The capability vocabulary: the board level and the connection level

The contract and the implementation each have a set of capability words. They are not the same axis,
but part of the word forms overlap — so there has to be a correspondence table that fixes their relation,
otherwise changing a word in one place only leaves the two vocabularies talking past each other.

#### 10.7.1 The two axes

| | The contract layer (board-level capabilities) | The implementation layer (connection-level capabilities) |
|---|---|---|
| The question it answers | what this board can do | what this connection can do |
| Who declares it | the board pack (`requires.capabilities`) | the runtime, negotiated per connection profile (`capabilitiesFor(profile)`) |
| The closed vocabulary | `{shell, exec, stream, files}` | `{exec, pty, files, exitCode}` |
| Who consumes it | the validator (rules 25/26) + the pack description query | the degradation decisions of the UI (whether the file browser forbids uploading) + the mode selection of the runtime |

Why there are two axes and not one set: section 10.2 says "the pack describes the board, the HAL describes the channel".
Forcing them into one set means making the pack aware of the transport, which directly violates section 10.2.

#### 10.7.2 The word-sense correspondence table

This table is part of the contract. It is a translation between two sets of words and not a function —
a board-level capability does not imply a connection-level capability: the same board over adb and over serial has completely different connection capabilities.

| Board-level capability (the contract, declared by the pack) | Connection-level capability (the implementation, negotiated per profile) | Semantics | The implementation state in v1 |
|---|---|---|---|
| `shell` | `pty` | it can open an interactive shell | ✅ implemented |
| `exec` | `exec` | it can run one command and get the result | ✅ implemented |
| `files` | `files` | there is a file channel | ✅ implemented (but not on serial, fact S7) |
| `stream` | —— | it can push a continuous stream | ❌ not implemented: the Stream contract is missing (section 7 of `00-overview.md`) |
| —— | `exitCode` | the channel can give an exit code | ✅ implemented (not on serial, fact S5) |

Two points that have to be understood:

1. `files` has the same name and a different meaning. At the board level it says "this board has a file channel",
   at the connection level it says "this connection can transfer files" — on a serial connection the latter is false and the former is still true.
   That is exactly why `requires.capabilities` cannot be used as a gate on the connection (see 10.3.3).
2. `exitCode` has no board-level counterpart. It is a property of the channel and not of the board
   (serial cannot get an exit code, fact S5). It belongs on the connection level in the first place —
   it is not "one extra thing in the implementation".

#### 10.7.3 `requires.capabilities` is information, not a gate

The same line as `requires.transports` in section 10.6: it tells the runtime "what this pack can go with",
and it does not restrict "this pack may only go with".

Why it cannot be used as a gate on the connection: serial has `files=false`.
Using the board-level `files` as a gate would make the pack useless over serial —
which directly violates section 10.6, "when one pack goes with ADB and with serial, each channel uses its own way of fetching".

So in v1 it does two things:

1. It is validated — rule 25 (the closed vocabulary) and rule 26 (it has to be an implemented capability);
2. It is queried — it comes with the pack description interface and with the output of `probe:board`,
   so that the agent knows "what this board declares that it supports".

> It must not be pretended to be meaningful. If one day v1 does not open the pack description query,
> then a note "this field has no consumer for now, pending v2" has to be recorded in the contract reconciliation checklist.

#### 10.7.4 The disposition of `stream`

The `stream` stays in the vocabulary, but a v1 pack must not declare it.

- It stays in the vocabulary: it is a real board-level capability (the board really does have a video pipeline).
  When the Stream contract lands it can be used directly, without deleting the word now and putting it back later —
  deleting a word is a contract change and that is the moment when `apiVersion` is bumped.
- It must not be declared: v1 has no Stream contract (section 7 of `00-overview.md`),
  and declaring it would promise a delivery that does not exist.
  Rule 26 stops it as an error — not as a warning.
  The error message points at the gap register, so whoever runs into it gets a signpost and not a silent hole.

> Rule 26 is generic; it reads the table of "the capabilities the runtime has implemented",
> it is not a hard-coded `if (stream)`. The day Stream lands, what changes is the table and not the rule.

