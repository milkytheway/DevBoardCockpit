# The Workflow Pack Format

> **Contract version**: `devboard/v1`
> **Drafting status**: drafted (2026-11-15 ✓)
> **See also**: `00-overview.md` (the two buses) · `02-board-pack.md` (actions and readback) · `03-card-manifest.md` (cards and permissions) · `04-mcp-tools.md` (the hands of the agent)

---

## 0. What it answers

| Pack | Answers |
|---|---|
| Board pack (`02`) | **What this board has** (which quantities it can produce, which writes it accepts) |
| **Workflow pack (this document)** | **How one job is done** (multiple targets, multiple steps, with criteria, accountable) |

> **"Target" is not a contract concept** ✓:
> "compile on the host" and "compile on the guest" are **two workflow packs** ✓ → cards and agents see only
> **the workflow id plus the input declaration** ✓ → the contract layer does not need a "target" dimension ✓.

---

## 1. What a pack looks like

```yaml
apiVersion: devboard/v1
kind: Workflow

id: hello-kernel.build-run
name: Compile a kernel module → transfer it straight to the board → install it → load it
version: 1.0.0
description: Compile the kernel module on the client machine, let the client machine transfer it directly to the canonical location on the board, run depmod -a and then load it by name.

inputs:
  build_dir:
    type: path
    required: true
    maxLength: 200
    description: The project root on the build machine
  project:
    type: string
    required: true
    maxLength: 200
    description: The project directory name (relative to build_dir)

roles:
  build:
    purpose: Where the build runs (the client machine)
    profile: ubuntu-ssh
  target:
    purpose: The board
    profile: board-adb

steps:
  - id: compile
    kind: exec
    role: build
    cmd: "cd {input:build_dir}/{input:project} && make"
    timeout_ms: 1800000
    readback:
      kind: command_ok

  - id: artifacts
    kind: discover
    role: build
    dir: "{input:build_dir}/{input:project}"
    pattern: "*.ko"
    exclude: ["*.o", "*.cmd", "*.order", "*.mod.c"]
    out: artifacts

  - id: deliver
    kind: file.transfer
    from:
      role: build
      path: "{output:artifacts}"
    to:
      role: target
      placement: kernel-module
    cmd: "scp {from.path} {role:target.user}@{role:target.host}:{to.path}"
    timeout_ms: 1800000
    out: dest
    readback:
      kind: verify
      role: target
      command: "test -f {to.path}"
      timeout_ms: 30000

  - id: load
    kind: exec
    role: target
    cmd: "depmod -a && modprobe {output:artifacts.name}"
    timeout_ms: 120000
    readback:
      kind: command_ok
```

**Top-level fields (closed)**: `apiVersion` `kind` `id` `name` `version` `description` `inputs` `roles` `steps` ✓.
**An unknown field is always an error** ✓ (the same rule as `02`/`03` ✓).

---

## 2. `inputs` (parameters)

The type table follows `02` section 4.3 ✓ (no second table ✓):

| type | Additionally required | Explanation |
|---|---|---|
| `string` | `maxLength` | the length must be bounded ✓ |
| `integer` | — | optional `min` / `max` ✓ |
| `number` | — | optional `min` / `max` ✓ |
| `boolean` | — | |
| `enum` | `values` (a closed set of values ✓) | a value outside `values` → **an error** ✓ |
| `path` | `maxLength` | **equivalent to `string`** ✓ (the same encoding rules ✓) |

The other fields: `required` (boolean) · `default` · `pattern` · `description` ✓.

---

## 3. `roles` (role → connection)

| Field | Required | Meaning |
|---|---|---|
| `purpose` | Yes | what this role **is for** (for the reader ✓) |
| `profile` | Yes | the id of a connection profile **that exists in the host** ✓ |

| Rule | Why |
|---|---|
| **Only a profile id may be referenced, no field may be overridden** | the address, the user and the credentials **are the host's business** ✓ (the same principle as `02` section 5.5 ✓) |
| **A profile with the `local` transport must not be referenced** | `local` is **the host's own shell** ✓ — a workflow running a command on it runs that command on the host ✗ |
| **A profile that does not exist → an error** | no silent connection to a different target ✓ |

---

## 4. `steps` (the steps)

### 4.1 The six kinds (**closed**)

| kind | What it does | Required | **Where it runs** |
|---|---|---|---|
| `exec` | run one command | `role` `cmd` | the target named by `role` ✓ |
| `discover` | artefact discovery | `role` `pattern` `out` | **lists the directory** on the target of `role` ✓ |
| `file.transfer` | transport | `from` `to` `cmd` | **the source target** (`from.role` ✓) |
| `action` | references an **already declared action** of a board pack | `role` `action` | the target of `role` ✓ |
| `await` | waits until a criterion holds | `readback` | the role named by the criterion ✓ |
| `assert` | criterion plus what happens when it does not hold | `readback` | the same ✓ |

> **The command of `file.transfer` runs on the source role** ✓ —
> "the artefact compiled on the client machine is **delivered by the client machine itself** to the board" ✓, **not fetched back through the host** ✓.

> **`exec_script` does not even get a place in the table** ✓ (once an escape hatch is written into the table, somebody will use it ✓).

### 4.2 The remaining fields of a step

| Field | Used by | Explanation |
|---|---|---|
| `timeout_ms` | `exec` / `file.transfer` | the execution timeout of this step ✓ |
| `params` | `action` | the parameters of the action (the values may contain placeholders ✓) |
| `danger` | all | `reversible` (default) / `destructive` ✓ |
| `on_mismatch` | `assert` | `fail` (default) / `continue` ✓ |
| `out` | `discover` / `file.transfer` | which slot the output of this step goes into ✓ |

### 4.3 The discovery rules of `discover`

| Field | Meaning |
|---|---|
| `dir` | which directory to search (the current directory by default ✓) |
| `pattern` | **what is wanted** (matched against the **file name** ✓) |
| `exclude` | **what is not wanted** (the same matching rules ✓) |
| `out` | which slot the found paths go into ✓ |

> **The exclusion list has to be meaningful**: a build directory is full of intermediate artefacts (`.o` / `.cmd` / `.order` / `.mod.c`),
> and one missing entry may **send an intermediate file up as if it were the artefact** ✗.
> **Several matches → take the first one** (sorted by name ✓, so the result is reproducible ✓).

### 4.4 The two ends of `file.transfer`

```yaml
from:
  role: build          # the source (**the command runs here** ✓)
  path: "{output:artifacts}"
to:
  role: target         # the destination
  path: "/opt/x"       # ① the path given by the user
  # placement: kernel-module    # ② the semantic default (**a closed vocabulary** ✓)
```

| placement | Where it lands |
|---|---|
| `kernel-module` | `/usr/lib/modules/<version>/extra/` (**the version has to be asked of the target machine** ✓) |
| `user-program` | `/usr/local/bin/` |

> **A typo → an error** ✓ (it must not silently fall back to "put it anywhere" ✗ — that would drop a `.ko` into `/tmp`,
> where `modprobe` cannot find it, while the workflow reports success ✗).
> **Three forms**: ① `path` ② `placement` ③ `ask` (**not in the first version** ✓).

---

## 5. Criteria (`readback`)

**The vocabulary is the five forms of `02` section 4.4** ✓ — **no sixth form is added** ✓:

| Form | First version |
|---|---|
| ① `tag` | Rejected in the first version (a tag belongs to the **core vocabulary of the board pack** ✓, and the workflow layer has no board pack → it **cannot be looked up** ✗) |
| ② `file_equals` | Supported |
| ③ `command_ok` | Supported (**a serial line has no exit code** → it is refused on serial ✓) |
| ④ `verify` | Supported |
| ⑤ `none` | Supported (**only allowed on a step with `danger: reversible`** ✓) |

**The only extension: one more `role`** — "**on which role it is read**" ✓.

```yaml
readback:
  kind: verify
  role: target          # ← read on the **target** ("is that file really on the board?" ✓)
  command: "test -f {to.path}"
  timeout_ms: 30000
```

| Rule | Why |
|---|---|
| **A `role` that points at a role that was never declared → an error** | a criterion must not read **an unauthorised machine** ✗ |
| **`await`/`assert` must say on which role it reads** | otherwise "which one does it read by default" is a guess ✗ |
| **The command of a criterion also goes through the danger floor** | it is **a command given by the pack** ✓ → without the floor it could run a dangerous command in the name of "verification" ✗ |
| **The command of a criterion does not reach the executor** (first version) | a criterion is **a read-only verification** ✓; the defences are **the unified permission area** ✓ (the row for that workflow ✓) + the floor ✓ |

> **A criterion across targets is run by the workflow layer** ✓ (the executor of `02` section 5.2 reads back **on the connection it executes on** ✓) →
> **two facts, two ledger lines** ✓ (the line of the criterion is recorded on its own ✓).

---

## 6. Placeholders (**a closed set of five** — it **is** the injection defence ✓)

| Form | What it denotes |
|---|---|
| `{input:name}` | the value of a parameter |
| `{role:role.fact}` | a connection fact of a role |
| `{output:slot}` | a slot produced by **an earlier step** |
| `{output:slot.name}` | the file name **without its extension** (`hello.ko` → `hello` ✓) |
| `{from.path}` / `{to.path}` | the source / destination **of this step itself** (**only inside a `file.transfer` step** ✓) |

**The closed table of role facts**: `host` / `port` / `user` / `profile_id` ✓
(**no `key`** ✓ — the path of a credential must not be interpolated into a command ✓: it would end up in the audit line ✓, it would end up in the `dry_run` echo ✓,
and it is **mostly useless** — the command runs on the **source target**, and the source target uses **its own** key ✓).

**Where the role facts come from** (`02` section 10.3 ✓) ✓ — **the connection profile bound to that role** ✓:

| Fact | Source (**taken in order, the first one that exists wins** ✓) |
|---|---|
| `host` | `options.ssh.host` of the profile ✓ → `options.host` ✓ → **the empty string** ✓ |
| `port` | `options.ssh.port` ✓ → `options.port` ✓ → **22** ✓ |
| `user` | `options.ssh.username` ✓ → `options.username` ✓ → **`root`** ✓ |
| `profile_id` | the `profile.id` of that role ✓ |

> **Why there is an `options.ssh` layer** ✓: **an action across machines is started on another machine** ✓
> (the command of `file.transfer` runs on the **source target** ✓) → that command needs **the SSH address of the board** ✓
> → **the workflow pack must not know the address of the board** ✓ → **it follows the profile** ✓.
> → **a profile with `transport: 'ssh'` is itself that endpoint** ✓ → **it must not be written twice** ✓ (drift ✓).

**Two substitution modes**:

| Mode | Used by | Input values | Role facts | Paths in slots |
|---|---|---|---|---|
| **Command mode** | the command of a step, the secondary verification command of a readback | **encoded by type** (`02` section 4.6 ✓) | **quoted as a string** ✓ | **quoted** ✓ |
| **Value mode** | the `expect` / `path` of a readback, the `dir` / `pattern` / `exclude` of a discovery | verbatim ✓ | verbatim ✓ | verbatim ✓ |

> **Command mode is the injection defence** ✓: an input value such as `; reboot` is **treated as a literal** ✓.
> **A placeholder in a template must not carry its own quotes** ✓ (the same rule as validation rule 21 of `02` ✓).

**Static check** (at parse time ✓): a placeholder points at an input / role / output slot that was never declared → **an error** ✓
(a typo that only blows up at runtime means the workflow fails halfway through ✗).

---

## 7. The trust model (**this is the most important section of this document** ✓)

### 7.1 A workflow pack is "a set of commands that are going to run on the user's machine"

→ It has to have a **stricter entry point than an action** ✓.

### 7.2 Two ledgers

| Ledger | What it records | Who may change it |
|---|---|---|
| **Registry** | which packs the directory holds (id → pack + **content digest**) | putting a file into the directory |
| **Audit** | what every step of every run did (`02` section 5.4 ✓) | the host |

> **There is no approval ledger any more** ✓ (**removed on 2026-11-16** ✓) —
> **the existence of a workflow pack is the explanation by itself** ✓ (the user: "**the existence of the workflow explains itself**" ✓).
> → **the gate is the unified permission area in settings** ✓ (`03` section 2.4 ✓): **the row for the workflow** ✓.

### 7.3 Five rules

| # | Rule | Why |
|---|---|---|
| **T1** | **putting a file into the directory does not mean that it may run** | **the row that is enabled in the permission area is what may run** ✓ (`03` section 2.4 ✓) |
| **T2** | **the content digest of a workflow pack is recorded in the registry** | change the content → **the digest changes** ✓ (**the first link of the chain of accountability** ✓ — the same reason as "an approval is bound to a digest" ✓) |
| **T3** | **cards and agents may only take a pack from the registry by id**, **they cannot supply a path** | an agent must not be able to write a pack and run it ✗ |
| **T4** | **every write step goes through the encoding of `02` section 4.6 and the danger floor of section 5.2.1**; hitting the floor → **it is treated as `destructive`** | a free command is **a second command channel** ✗ — it has to share **the same line of defence as an action** ✓ |

> **The subject of T4 is "the write given by the pack"** ✓.
> **The host's own clean-up write** (the clean-up of section 8.C ✓) takes **another route** ✓:
> the path **may only come from the resolved result of this step** ✓ + **encoded as in `02` section 4.6** ✓ +
> **only one regular file, no recursion** ✓ + **a separate audit line** ✓.
| **T5** | **a role must not be bound to the `local` transport** | `local` is the host's own shell ✓ |

### 7.4 The permission area **must show** "which commands this workflow runs on which targets"

→ role → profile id, the command **template** of every write step, whether the step is dangerous, on which role the criterion reads ✓
(**the description of that row in the permission area** ✓ — `03` section 2.4 ✓).

> Otherwise the switch is only "enabling a file name" ✓ → **it amounts to not having looked** ✗.
> → **`planOf()` produces this summary** ✓ (on the registry side ✓).

### 7.5 Dangerous commands: **there is no runtime confirmation any more** ✓ (**changed on 2026-11-16** ✓)

| # | Rule |
|---|---|
| 1 | A step declares `danger: destructive` → **it runs as declared** ✓ (**nobody is asked** ✓ — **the danger grade is information only** ✓) |
| 2 | **hitting the danger floor → it is treated as `destructive` as well** (the stricter one wins ✓) — **it is decided inside the pack** ✓ (rule 16 ✓) |
| 3 | **the gate is the unified permission area in settings** ✓ (`03` section 2.4 ✓): **the row for the workflow** ✓ · **dangerous actions are off by default** ✓ |
| 4 | **the whole confirmation credential apparatus is gone** ✓ (`confirm_id` ✓ · `awaiting_confirmation` ✓ · the resume chain ✓) |

> **Why there is no runtime confirmation any more** ✓ (the user in so many words: "**stop asking whether a command is dangerous,
> use the permissions throughout, enabling a permission already means knowing the danger**" ✓):
> → **the dangerous information is written into that row of the settings page** ✓ → **turning that switch on is the informed consent** ✓.
> → **the existence of a workflow pack is the explanation by itself** ✓ → **nobody asks "what will this workflow do" any more** ✓ (**it is written in the list** ✓).

### 7.6 The authorisation of a workflow: **it is that row in the permission area**

① **the manifest of the card declares it** (card side ✓) ② **that row in the permission area is enabled** ✓ → **both are required** ✓.

> A workflow is **not an action** (it is not in a board pack ✓), but it can **also run commands on the user's machine** ✗
> → it **must** have an authorisation layer of its own ✓ (the same model as `03` section 3.3 ✓) —
> **that layer is now the switch on the settings page** ✓ (**one place** ✓).

---

## 8. Run semantics for long tasks

| # | Provision |
|---|---|
| 1 | **the trigger returns a `run_id` immediately** (a compilation takes minutes ✓ → a synchronous return does not hold ✓) |
| 2 | **`status(run_id)` is polled for the timeline** ✓ (polling in the first version ✓) |
| 3 | **state machine**: `running` / `done` / `failed` / **`cancelled`** ✓ (**`awaiting_confirmation` removed on 2026-11-16** ✓ — **there is no more stopping to wait for a nod** ✓) |
| 4 | **idempotent**: polling the same `run_id` again → **the same timeline** ✓ |
| 5 | **triggering again** = **running from the beginning again** ✓ (**the write steps that already completed run again** ✓ → a `destructive` step **must not be placed after a write step with a side effect** ✓) |
| 6 | **resuming** = **not a thing any more** ✓ — the confirmation chain is gone ✓ (section 7.5 ✓) → **a run either runs or is cancelled** ✓ |
| 7 | **concurrency**: **only one run of the same workflow pack at a time** ✓ (two workflows competing for one serial line would talk over each other ✓) |
| 8 | **cancellation**: section 8.A ✓ |
| 9 | **the step in flight**: section 8.B ✓ |
| 10 | **no half-written files**: section 8.C ✓ |

### 8.A Cancellation

| # | Provision | Why |
|---|---|---|
| **A1** | **cancellation = the host *requests* the abortion of the step in flight** ✓<br>**whether it can actually stop depends on the transport and the remote side** ✓ — the contract **does not promise** that "the process certainly dies" ✓<br>(on serial that is impossible ✓ — it is not a shell connection ✓; on ssh/adb it depends on the remote side ✓)<br>what the contract promises is two things: **the host stops waiting** ✓ + **the timeline says it truthfully** ✓ | "the process is certainly gone" is an **implementation layer mechanism** ✓, and the semantics of the four transports **differ from each other** ✓ (locally the process is killed ✓ / over ssh the channel is closed ✓ / over adb what dies is the local client ✓ / over serial nothing can be killed ✓) → writing it into the contract = **lying to three of the transports** ✗ |
| **A2** | the state of the run = **`cancelled`** ✓ (**not `failed`** ✓ — a cancellation is not a failure ✓) | mixed together → the interface reports "a human stopped it" as "something broke" ✗; the retry logic misjudges it as well ✗ |
| **A3** | **a step that has already run is not rolled back** ✓ | the contract **has no notion of a rollback** ✓ (section 10 ✓) — the inverse operation of a rollback **is a write command of its own** ✓ → it also goes through the floor, **it also needs the permission of that workflow** ✓, and it may fail as well ✓ → **the cost is greater than the benefit** ✓ |
| **A4** | **only the host may cancel** ✓ (the GUI ✓ / the host command line ✓)<br>→ **cards and agents have no cancellation interface** ✓ | "may it" and "may it stop" are **the same family of judgement** ✓ (the confirmation chain of section 7.6 ✓) — "may it" is not given to the agent ✓ (`04` section 2.4.1 ✓), and "may it stop" is not given to it either ✓<br>otherwise the agent would have a channel for **deciding on its own not to do the work** ✓ → the "a human nods" chain would have a bypass ✗<br>cards do not get it either ✓: the card permissions are granted **per method** ✓ (`03` section 7.7 ✓) → "stopping somebody else's run" is **not in any permission item** ✓ |
| **A5** | cancelling a `run_id` that **does not exist** → **an error** ✓<br>cancelling a run that **has already ended** → **idempotent** ✓ (not one character of the state changes ✓)<br>**after a cancellation the workflow may be triggered again at once** ✓ (section 8.5 ✓) | a mistyped id has to be said clearly ✓; pressing "stop" twice must not crash ✓; after a stop there may still be work to do ✓ |
| **A6** | a cancellation **affects that one run only** ✓ | another run must not stop with it ✓ |
| **A7** | for the cancelled step the timeline **gives `cancelled` as the reason** ✓ (**not `failed`** ✓, **not `readback_mismatch`** ✓) | in an audit it has to be visible that "a human stopped it" ✗ ≠ "the machine broke" ✓ |
| **A8** | a cancellation **stops the run** ✓ | otherwise the steps after it would keep running on a run the user has already stopped ✓ |
| **A9** | a cancellation **writes an audit line** ✓ (who stopped it ✓) | if "who stopped it" cannot be looked up ✓ → there is no accountability afterwards ✓ |
| **A10** | **resuming and cancelling are mutually exclusive** ✓ | after a cancellation, pressing "continue" = running a run that has already been stopped ✗ |

> **What "cancellation" does not promise** (stated honestly ✓):
> - **it does not promise that the process dies** ✓ (A1 ✓)
> - **it does not promise a rollback** ✓ (A3 ✓)
> - **it does not promise that the machine returns to its original state** ✓ — **what is left behind after a cancellation has to be stated clearly** ✓ (section 8.C ✓)

### 8.B The step in flight

| # | Provision | Why |
|---|---|---|
| **B1** | `status(run_id)` gives, besides the timeline, **`current`** = **the current step** (**running** ✓): `{ stepId, kind, at }` ✓<br>the run **has ended** (`done` / `failed` / `cancelled`) → `current` = `null` ✓ | a measured compilation takes 58.9s / 98.5s ✓ → the interface must not be a dead silence ✓; "which step is it on now" is the one thing the interface needs most ✓ |
| **B2** | `current.at` = **the moment that step started** ✓ → the interface can compute "**how long it has been running**" by itself ✓ | **no percentage** ✓ — the percentage of a transfer is a guess ✗; "42 seconds already" is a fact ✓ |
| **B3** | **`current` is a live snapshot** (it changes ✓); **`stages` only grows** ✓ (section 8.4 ✓)<br>→ **the two have a different idempotency** ✓ | two queries of the same `run_id`: `stages` is the same ✓, `current` may differ ✓ — conflating them produces half-sentences like "the timeline is idempotent as well" ✗ |
| **B4** | `current` **does not give the role** ✓ (**it gives no topology** ✓ — the same principle as `04` ✓) | "which role connects to which machine" is **something an unauthorised party must not see** ✓ (the rule of `04` section 2.4.1 ✓) |
| **B5** | **the card side is a reduced projection** ✓: `stages` only gives `stepId` / `kind` / `ok` / `verified` / `reason` ✓; **the detail (paths, output values, roles) stays with the host and the agent** ✓ | a card is written by an AI ✓ → the less the card side sees, **the safer** ✓ |

### 8.C No half-written files

| # | Provision | Why |
|---|---|---|
| **R1** | **after the transport command itself did not succeed (including being cancelled ✓), if the destination did not exist before**, the workflow layer guarantees **that it leaves no half-written file behind** ✓<br>→ **"the readback failed but the command succeeded" does not count** ✓ (that is "**it was transferred, it was not verified**" ✓ — **no clean-up** ✓, the timeline only states it clearly ✓) | "stopping cleanly" is part of a cancellation ✓ — otherwise nobody dares to stop ✗<br>→ "it was transferred" and "it was verified" are **two facts** ✓ — **if one of them does not hold, the other must not clean up after it** ✓ |
| **R2** | **the destination existed before** → **it is left alone by default** ✓<br>**when it is not certain** (it cannot be looked up ✓) → **it is not deleted** ✓, the timeline only says "the destination holds an unconfirmed file" ✓ | better to leave a truncated old file ✓ than to delete something of the user ✓<br>→ **the only exception** = **the destination did not exist before the transfer** ✓ — in that case it **must be** the one this transfer produced ✓ |
| **R3** | the clean-up **may only act on "the path this step resolved"** ✓: the path is **encoded as in `02` section 4.6** ✓ (single quotes, newlines and null characters refused ✓), **only one regular file is allowed** ✓ (no recursion ✓ / no directory ✓ / no wildcard ✓), **and it has to be character for character equal to `to.path`** ✓ | `to.path` is **given by the pack** ✓ → not encoding it is **an injection surface** ✓ (section 7, rule T4 ✓) |
| **R4** | the clean-up **writes an audit line of its own** ✓ (who deleted it, which path was deleted ✓); **it raises no confirmation** ✓ | if something was deleted, **it has to be accounted for** ✓<br>it is **the clean-up of this very run** ✓ — raising another dialog on a cancellation → the user thinks the stop was not clean ✓ |
| **R5** | **intermediate leftovers outside the destination produced by the transport command (such as `.b64`) are the responsibility of the pack** ✓; they are visible at approval time ✓ (section 7.4 shows the command templates ✓) | the workflow layer **only sees `to.path`** ✓ → things elsewhere are **none of its business** ✓<br>→ the contract **does not require an atomic transport** ✓ (there is no "temporary name plus rename" placeholder ✓ → forcing it = growing an expression language ✗) |

---

## 9. The validation checklist

`validate_workflow(path)` must check:

| # | Rule |
|---|---|
| 1 | `apiVersion` is a known version |
| 2 | `kind` is `Workflow` |
| 3 | **there is no unknown field at any level** |
| 4 | the `id` has a valid format (`name.name`) |
| 5 | the type of `inputs` is in the closed table; `enum` has `values`; `string`/`path` have `maxLength` |
| 6 | every role of `roles` has `purpose` and `profile`; **the profile exists** and **is not a `local` transport** |
| 7 | `steps` is not empty; the `id` is unique; the `kind` is one of the six |
| 8 | the required fields of every kind are present (section 4.1) |
| 9 | `placement` is in the closed vocabulary |
| 10 | **everything a placeholder points at exists** (input / role / output slot / role fact) |
| 11 | **a step with `danger: destructive` must not use `readback.kind: none`** (the same as `02` section 4.4.1 ✓) |
| 12 | **`await`/`assert` can say on which role it reads** ✓ |

> Rule **11** is the same as `02` section 4.4.1 ("`destructive` still forbids `none`" ✓) —
> a criterion across targets **is not an exemption** ✓.

---

## 10. What the contract **does not** do

| Not done | Why |
|---|---|
| **"target" as a contract concept** | section 0 ✓ |
| **a card assembling several steps itself** | composition belongs to the workflow pack ✓ |
| **a push channel for workflows** | polling in the first version ✓ (the continuous stream contract of `00` section 7 is not settled yet ✓) |
| **a workflow pack carrying its own credentials** | only a profile id may be referenced ✓ |
| **`exec_script`** | section 4.1 ✓ |
| **form 1 of the criteria** | section 5 ✓ |
| **rollback** | section 8.A, rule A3 ✓ — the inverse operation is a write command of its own ✓ |
| **the third form `ask`** | section 4.4 ✓ |
| **branches and loops** | the first version is **a straight line** ✓ |

---

*Basis: the trust model of this document (three ledgers and five rules), the run semantics for long tasks
(a `run_id` plus polling; cancellation; the step in flight; no half-written files),
and the measurements made on real hardware ✓; it went through four rounds of independent review ✓.*
