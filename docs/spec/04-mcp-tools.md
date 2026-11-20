> Source and revisions: this document was migrated from the predecessor project `DevBoardConsole\docs\spec\` (2026-11-12, Codex, commit `c24b084`).
> The contract layer is the authoritative documentation. It was revised by `0244852` after the migration, and the review of 2026-11-12 revised it once more
> — see `00-overview.md` section 1.2 for the per-section provenance. For the implementation see `README.md` at the repository root.
# The MCP Tool Set

> The GUI implements the MCP server. The host AI uses it to perceive the current state of the software, to read the state of a board, to write cards and to test itself.
> This is the contract of "AI ↔ GUI" and it is symmetric to the tag contract of "card ↔ board".

---

## 1. General principles

### 1.1 Capabilities appear dynamically

Static documentation cannot work. A camera is plugged in, a driver is installed later, a board pack is loaded at runtime, a card has just been written by an agent.

The first group of MCP tools is therefore all about listing, not about querying documentation:

```
list_connections  →  what is connected right now
list_data_sources →  what can be read right now
list_capabilities →  what can be done right now
```

The static documentation (`get_card_sdk_docs`) is only a syntax reference for authoring cards, never a source of the current state.

### 1.2 The eyes of the agent self-test

When an agent has written a card and cannot immediately see whether that card behaves correctly, it is writing blind.

MCP therefore has to provide:

- `validate_card(path)` — static validation, available the moment the card is written
- `get_card_runtime_log(cardId)` — the runtime log, so that the errors of a running card can be seen

Together those two are the eyes of the agent. Without them "making a card takes half a day" cannot become "one round of conversation".

### 1.3 No raw send_command

`execute_action` replaces raw command execution. An agent may only trigger declared actions, it cannot send arbitrary commands.

There are two reasons, safety and semantics:

- Safety: an action carries a danger grading, a parameter range and an audit trail.
- Semantics: `backlight.set` says more than a shell string, and its readback is defined.

If an agent needs an action that has not been declared yet, it should write a board pack extension instead of sending a raw command.

---

## 2. The tool list

### 2.1 Perceiving the current state

#### `list_connections()`

```
→ [{ id, label, transport, board_pack, device_key, current, connected, capabilities }]
```

| Field | Meaning |
|---|---|
| `device_key` | The identity of this board ✓ (`02` section 10.2 ✓) — several connections to the same board give the same value ✓ |
| `current` | Whether it is the connection the current runtime uses ✓ (a criterion of its own, separate from `connected` ✓ — a connection with an open terminal session also counts as `connected` ✓, but it is not the one the runtime uses ✓) |

`board_pack` is the id of the board pack bound to the current board; when nothing is bound it is `null`.

> Only the id, never the version ✓: the version is an attribute of the pack itself — several versions can share one id,
> and that is not an attribute of this connection. The version is given by `list_data_sources` (which is about packs anyway).

| Field | Meaning |
|---|---|
| `id` / `label` / `transport` | The identity of the connection profile (not of some live connection) |
| `board_pack` | The id of the bound board pack, or `null` |
| `connected` | Whether this profile has a live connection right now (boolean) |
| `capabilities` | The connection-level capability bits: `exec` / `pty` / `files` / `exitCode` (the connection-level set of `spec/02` section 10.3, not the board-level vocabulary) |

The criteria for `connected` (both have to hold for the connection to count as up):

1. It is the connection of the current tag runtime and the runtime state is `running`;
   — knowing only that the runtime remembers this profile is not enough: the record survives a failed connection or a stopped runtime.
2. Or it has an open terminal session.

> Having a profileId is not the same as being connected ✓.

#### `list_data_sources()`

```
→ [{ id, board, poll_group, kind, interval_ms,
     provides: ["cpu.usage", ...], status }]
```

`status` is the state of the reader itself and it uses the same set of values as the tag states: `ok` / `stale` /
`unavailable` / `error` / `pending`.

Note that this is reader granularity, not tag granularity — the answer to "which tags are readable" is organised by reader by nature (when a reader goes down, every tag it provides goes down with it).

| Field | Meaning |
|---|---|
| `id` | The id of the reader (a data source is at reader granularity) |
| `board` | The id of the current board pack (not a connection id) |
| `poll_group` | The id of the poll group this reader belongs to |
| `kind` | The kind of the reader (`proc_stat` / `file_read` / …) |
| `interval_ms` | The period of the poll group it belongs to (a reader has no period of its own) |
| `provides` | The concrete tag names this reader provides (expanded — the pack holds patterns, see below) |
| `status` | The state of the reader itself (the mapping table is below) |

> `provides` gives concrete names ✓: the pack holds `cpu.core.*.usage` (a pattern),
> and an agent has to write a card → the card needs concrete tag names. The pattern itself is carried by the semantics of `describe_tag`.

The `status` of a reader is a mapping table (not "the worst of them"):

| Case | `status` |
|---|---|
| Not one of its tags is in the readings | `pending` |
| It has tags and all of them are `unavailable` | `unavailable` |
| It has tags and at least one of them is `error` | `error` |
| It has tags and at least one of them is `stale` (no error) | `stale` |
| All of them are `ok` | `ok` |

#### `list_capabilities()`

```
→ { transports: [...], features: ["cards", "mcp", "layout_share", "record"] }
```

What the workbench itself offers. It lets an agent tell whether a feature exists.

| Field | Domain |
|---|---|
| `transports` | The closed vocabulary of the connection-level capabilities: `exec` / `pty` / `files` / `exitCode` (the connection-level set of `spec/02` section 10.3) — not the board-level vocabulary |
| `features` | The capability bits of the workbench itself, closed: `cards` / `mcp` / `layout_share` / `record` |

> Adding a value is a contract change ✓ (it is a closed vocabulary ✓).

#### `list_tags(board?)`

```
→ [{ name, type, unit, range, status, value, board, source_reader }]
```

The tags that are actually readable right now, with their live state. This is the first tool an agent should call when writing a card.

The difference from `list_data_sources`:

- `list_data_sources` asks which data sources exist
- `list_tags` asks which concrete quantities exist and what their value is now

When an agent writes a CPU card the first call is `list_tags()`, because it tells the agent directly which tag names are available.

| Field | Meaning |
|---|---|
| `name` | The tag name |
| `type` | The type in the core vocabulary (`number` / `string` / `boolean` / `enum`); without a vocabulary entry it is `null` |
| `unit` | The unit — without a vocabulary entry it is `'-'` (dimensionless), not `null` |
| `range` | The range in the core vocabulary: a two-element array `[min,max]` or a string (such as `"open enumeration"` / `"≥0"`); without a vocabulary entry it is `null` |
| `status` / `value` | The current reading (the five states, verbatim) |
| `board` | The id of the current board pack |
| `source_reader` | The reader that provides this tag |

How `source_reader` is computed: the tag name is matched against the `provides` patterns of every reader
(the readers in `custom` are included — otherwise every quantity of `custom.*` would be `null`).
A tag matches at most one reader — board pack rule 2 guarantees that the tag patterns of the readers do not overlap,
and a pack that does not comply is not loaded at all. When nothing matches it is `null` (never a guess).

> The field `board` is not the same thing as `board_pack` of `list_connections` ✓:
> the first is the pack id of the board that is in effect, the second is the pack id bound to this connection.

#### `describe_tag(name)`

```
→ { name, type, unit, range, semantics, status, value, board,
    source: { reader, kind, args_summary }, history: [...] }
```

`semantics` is the verbatim semantic description of the tag contract. This is the key against misuse — when an agent sees `npu.usage` it has to know that it is "the maximum of the utilisation of the NPU cores" and not some vague "NPU load".

> `semantics` is the vocabulary text verbatim (it contains Markdown emphasis markers — an agent reads it as plain text ✓);
> without a vocabulary entry (a private quantity of `custom.*`) it is `null`.

`source.args_summary` tells the agent where this quantity comes from (which file, which kind) but it does not expose the concrete command (so that the agent does not learn to send raw commands).

The allow list is decided by the pair (kind, parameter name) — never by the parameter name alone:

| kind | Parameters given to the agent | Blocked |
|---|---|---|
| `proc_stat` | `stat_path`, `cpuinfo_path` | — |
| `meminfo` | `path` | — |
| `devfreq_load` | `path`, `measure` | — |
| `rknpu_load` | `path` | — |
| `thermal_zone` | `glob`, `type_map` | — |
| `file_read` | `path`, `glob`, `format`, `strip_trailing_null` | — |
| `exec_regex` | `pattern`, `format` | `command` |
| ⛔ `script` | (empty) | ~~`path`, `interpreter`, `format`~~ (sealed ✓ · rule 31 ✓) |

> Why the parameters cannot be filtered by name alone: `path` in `file_read` is a path on the board (it may be given),
> in `script` it is a path on the host file system (it may not — it leaks the directory structure of the machine,
> and `interpreter + path` is a command once it is concatenated).
> A parameter that is not in the table is never given (the table is closed, it is not "give everything and then filter").
>
> ⚠️ `script` is sealed ✓ (`02` rule 31 ✓ · section 3.3 ✓) → the row above can never be hit ✓
> — it is kept because a closed table has to be complete ✓, not because it still works ✓.

`history` = the most recent samples, with exactly the same shape as `sample_tag`: `[{ value, unit, status, at }]`.
`at` is the moment this sample completed (milliseconds, UTC).

#### `sample_tag(name, n)`

```
→ [{ value, unit, status, at }, ...]
```

The n most recent samples. It lets an agent judge whether a quantity is stable or jittery, and what the real refresh period is.

| Item | Semantics |
|---|---|
| `n` | The n most recent samples (not the last n seconds) |
| One sample first | Take one targeted sample of the poll group that holds `name` (one round trip) and only then take the n most recent samples from the buffer |
| `n` is larger than the number of samples available | Give as many as there are (no padding) |
| `n ≤ 0` | `invalid_params` |
| This tag has never been read | An empty array (not `null`) |

> Why one sample is taken first: without it the agent receives frozen old samples (they never update once the connection is down) —
> and the jitter it judges is the jitter of the past.
> The cost is one round trip — an agent can use this tool as a manual refresh.

---

### 2.2 Inspecting the installed cards

#### `list_cards()`

```
→ [{ id, name, version, path, installed_at, status, degraded, missing_tags }]
```

#### `list_cards()`

```
→ [{ id, manifest_id, name, version, path, installed_at, status,
     degraded, missing_tags, unreadable_tags }]
```

`degraded` and `missing_tags` tell the agent whether this card is incomplete on the current board.

| Field | Meaning |
|---|---|
| `id` | The card id = the name of the card directory — everything on the host indexes by it (`uninstall_card` / `get_card_runtime_log` / the layout all use it) |
| `manifest_id` | The id declared in the manifest (it may differ from the directory name, which is why there are two fields) |
| `name` / `version` | From the manifest |
| `path` | The absolute path of the card directory |
| `installed_at` | The last modification time of the card directory (milliseconds, UTC) — not the moment a human pressed install |
| `status` | `ok` / `degraded` / `invalid` (closed) |
| `degraded` | Whether this card is incomplete on the current board (boolean) |
| `missing_tags` | The tags this card wants that the current board pack does not have at all |
| `unreadable_tags` | The tags that are declared, that the pack also provides, but that cannot be read right now |

> What `installed_at` is exempt from ✓: the host has never recorded an installation time —
> adding a field would change the persistence path of every card, and the MCP contract states explicitly that it does no file IO (except the copy of install_card).
> → It uses the mtime of the directory ✓, and it states what it is ✓ —
> otherwise an agent would sort by it to find "the most recently installed cards" ✗ (and that would be wrong) ✗.

The domain of `status` (closed):

| Value | Meaning |
|---|---|
| `ok` | The manifest is valid and all the tags it wants are readable |
| `degraded` | The manifest is valid but some tags cannot be read |
| `invalid` | The manifest itself is not valid |

> A card with `invalid` is still listed ✓ — the agent has to know that "the card I installed last time is broken" ✓.

"Cannot be read" and "does not exist" are two different things (as in `spec/01` section 2.1, `unavailable` versus `error`):

| Field | Criterion | Granularity |
|---|---|---|
| `missing_tags` | For every pattern P of `permissions.read`: no provides pattern of any reader of the current board pack covers P → the whole of P is recorded | Pattern level (the pattern itself is recorded, not expanded) |
| `unreadable_tags` | The concrete name exists in the readings and its state is not `ok` | Concrete name level (only those that are in the readings) |

> When an instance of a wildcard tag is absent from the readings, that must not be taken as a "missing" verdict —
> by contract the sampler never guesses concrete instance names.
> `degraded` = `missing_tags` is not empty or `unreadable_tags` is not empty.

#### `get_card_sdk_docs(topic?)`

```
→ { apiVersion, topics: [...], content }
```

The syntax reference for authoring cards: the manifest format, the available APIs, the whitelisted methods, the example cards.

`topic` is optional: `"manifest"` / `"api"` / `"examples"` / `"layout"`. When it is omitted everything is returned.

Note: this is a reference to the syntax, not to the current state. The current state is always taken with `list_*`.

`content` is a single string (an agent reads it as part of a prompt).

It is generated from the live code and the live data, not hand-copied static text (a hand-copied text drifts:
when the API gains a method it does not update itself, and an agent that follows it calls an API that does not exist):

| topic | Source | How it is generated | Limit |
|---|---|---|---|
| `manifest` | The closed schema whitelist of the card manifest | The field names and their requiredness are taken from the code; the semantics of the fields are taken from section 2 of `03` | — |
| `api` | The card API registry | The method names, the parameters and the permission dimensions are taken from the code; every method gets one sentence of explanation | — |
| `examples` | The directory of the built-in cards | The manifest plus the html/js of the entry point | 8 KB per card, beyond that it is truncated and marked |
| `layout` | The pure data shape of the layout | It uses the words of this contract (`cards` / `card_id`) | It does not copy the internal field names of the implementation layer |

> The code gives the shape, the contract gives the semantics ✓.

---

### 2.3 Writing cards and self-testing

#### `validate_card(path)`

```
→ { ok, errors: [...], warnings: [...],
    resolved: { tags, actions, layout, missing_tags, missing_actions } }
```

Static validation, without installing. The validation rules are in section 9 of `03-card-manifest.md`.

`resolved` tells the agent which tags and actions this card would actually bind to and which of them are missing.

| Field | Meaning |
|---|---|
| `resolved.tags` | The tags this card wants to read and that are readable on the current board (concrete names) |
| `resolved.actions` | The ids of the actions this card wants to write and that really exist in the current board pack |
| `resolved.layout` | The cell size that was resolved (`w`/`h`/`min_w`/`min_h`); without a layout it is `null` |
| `resolved.missing_tags` | The tags it wants to read but that are not readable right now (the same criterion as `missing_tags` of `list_cards`) |
| `resolved.missing_actions` | The ids of the actions it wants to write but that the current board pack does not have |

> `resolved.tags` and `resolved.actions` are the intersection of the declaration and what is available right now —
> not the declared values. What the agent needs to know is what this card can really bind to,
> not what it claims to want.

#### `get_card_runtime_log(cardId, since?)`

```
→ [{ level, at, message, source }]
```

The errors of the card runtime. `level` ∈ `error` / `warn` / `info`.

A card that crashed, a tag that could not be read, an action whose readback does not match — all of it is here.

| Field | Meaning |
|---|---|
| `level` | `error` / `warn` / `info` (closed) |
| `at` | Milliseconds, UTC |
| `message` | One sentence |
| `source` | `card` / `host` / `csp` (closed) |
| `since` (parameter) | Only the entries with `at >= since` (milliseconds, UTC); by default all of them |

> The log lives in the memory of the runtime (at most 200 entries per card) — it is lost on restart.
> The filtering by `since` is done on the host side.

#### `install_card(path)`

```
→ { ok: true, card_id, installed: true, degraded: bool, missing: [...] }
```

Copy the card directory into the card root and trigger the hot reload.

If an action this card wants to write is not in the board pack, `install_card` does not install it and returns:

```
→ { ok: false, reason: "invalid", card_id, installed: false,
    detail: "The board pack does not declare these actions: system.reboot" }
```

> Changed on 2026-11-16 (ADR-D46 ✓ · the user's own words: "the board description file has the final say" ✓):
> Installing a card no longer requires "approval" ✓ — the effective permission is the declaration of the card's manifest ✓ (`03` section 2.4 ✓).
> → The gate "new authorisation needed → not installed" is gone ✓ (the same thing is not recorded twice ✓).
> → What it wants to write is written down in the manifest ✓ — that is a verifiable fact ✓.

Two return shapes (closed):

| Case | Return |
|---|---|
| It was installed | `{ ok: true, card_id, installed: true, degraded, missing }` |
| An action it wants to write is not in the board pack | `{ ok: false, reason: "invalid", card_id, installed: false, detail }` |

`degraded` and `missing` follow the criterion of `list_cards` (`missing` is the list of the missing tag names).

This does not deadlock the loop of the agent. The flow is:

1. The agent calls `install_card` → it is installed (or the board pack does not declare that action → an error ✓)
2. The installed card has the permissions of its manifest declaration ✓ (`03` section 2.4 ✓ — there is no second gate ✓)

> Changed on 2026-11-16 (ADR-D46 ✓): the whole "the GUI pops up a confirmation → approve one by one → retry" sequence is gone ✓
> — the user's own words: "having to agree to this and having to agree to that, is that not tiring" ✓.

How this divides the work with the file watcher: both paths work, but they do different things.

| | Purpose | Semantics |
|---|---|---|
| Writing the files directly | The agent changes a card that is already installed | It triggers the hot reload. When the `permissions.write` of the manifest changes the permission set follows ✓ (see section 3.3 of `03` ✓) |
| `install_card` | Installing a new card, or copying one in from elsewhere | Equivalent to "copy the directory and reload", idempotent: installing the same id again replaces it |

When an agent uses `install_card` for a card that is already installed but has a different `permissions.write`,
it replaces it directly ✓ (the permissions follow the manifest ✓ — no second approval is needed ✓).

Writing the files directly has to pass the same validation: when the file watcher triggers the hot reload,
the runtime has to validate the manifest again (the 13 rules of section 9 of `03`) and to recompute the permission set,
it may not skip that because "it was triggered by the file watcher". That is what the equivalence of the two paths means.

The standard loop of the agent:

```
validate_card(path) → edit → validate_card(path) → install_card(path)
    → get_card_runtime_log(cardId) → read the errors → edit → install_card(path) → …
```

`install_card` is idempotent: installing the same id again replaces the card, it does not add a second one.

#### `uninstall_card(cardId)`

```
→ { ok }
```

It deletes the directory under the user card root. A built-in card cannot be deleted (`denied` — it lives in the application directory).

| Case | `reason` |
|---|---|
| The card does not exist | `not_found` |
| It is a built-in card | `denied` |
| It was deleted | none (`ok: true`) |

Side effect: the directory is deleted and the grant ledger of that card is cleared as well —
otherwise reinstalling it would bring the old grants back (that is not a fresh install, that is putting it back).
The card storage is kept (`03` section 6.2).

---

### 2.4 Executing actions

#### `execute_action(actionId, params, dry_run, device_key?)`

```
→ {
    ok: true,
    readback: { value, unit, status, at },
    verified: true,
    audit_id: "...",
  }
```

or, on failure:

```
→ {
    ok: false,
    reason: "readback_mismatch" | "denied" | "not_found"
          | "timeout" | "invalid_params" | "failed"
          | "unsupported_transport" | "cancelled",
    expected: true, actual: false,
  }
```

What `cancelled` means (added on 2026-11-15, following ADR-D36 ✓):
this execution was stopped ✓ — it did not fail ✓.
→ Its exit code is `null` ✓ (neither 0 nor 124 ✓);
→ It does not report `readback_mismatch` ✓ (that would say "the board did not obey" ✗ — a human stopping it is not the same as the board not obeying ✓);
→ A timeout and a cancellation are two different things ✓ (`timeout` versus `cancelled` ✓ — fact G1 ✓).

The `verified` field (added on 2026-11-13, following ADR-D25 of the implementation-layer decision record):

| Value | Meaning |
|---|---|
| `true` (the default) | The action was executed and the readback confirmed that the board really entered the target state |
| `false` | The action was executed but there was no readback — the action declares `readback: {kind: none}` (`02` section 4.4.1, form 5) |

Why it is not a `reason` code: `reason` is the reason for a failure.
`verified: false` is not a failure — the command really ran and the effect was really there (the LED came on).
Reporting `ok: false` would be a different kind of lie; reporting `ok: true` and saying nothing hides the fact that it was not verified.

> `unverified` is in neither this `reason` table nor the tag `reason` table of section 2.1.1 of `01`.
> The two tables are different things: the `reason` of `01` is the reason code of a tag reading (`not_found` /
> `device_absent` / …), the `reason` of this section is the reason code of an action execution.
> But "the thing you asked for does not exist" has the same name and the same meaning on both sides (both are `not_found`) —
> the AI is not given two dialects that have to be translated into each other (ADR-D27).
> `unverified` is not a tag state — adding it would pollute every consumer of tags.

The wording for the UI (fixed): `verified: false` → the card must show "executed, not verified",
and it must not show it as "in effect".
This is the same thing as the sentence "the command has been sent, the effect is not confirmed" in section 4.1 of `02` —
a cockpit must not display something that was not verified as if it had taken effect.

Parameters:

| Parameter | Meaning |
|---|---|
| `actionId` | The id of an action declared in the board pack (not a card id) |
| `params` | The parameters according to the declaration of the action |
| `dry_run` | It only returns what would be executed and executes nothing |

Why the action id and not the card id: an action is a capability of the board, a card is only a referrer. The same card can call several actions and the same action can be called by several cards. Authorising by action id is more precise (what is authorised is "changing the backlight", not "this card").

Behaviour:

0. If a `device_key` is given it must be the `device_key` of the connection the current runtime uses ✓
   → otherwise `not_found` ✓ (the detail states clearly "no such device: X" ✓).
   It is never allowed to ignore the `device_key` and act on the current board instead ✓ — that is silently doing something else ✗.
1. Check whether the action exists in the current board pack → otherwise `not_found`
2. Check the authorisation of the caller → otherwise `denied`
3. Validate the parameters (type, range, enumeration) → otherwise `invalid_params`
4. With `dry_run: true` it returns the command that would be executed together with the parameters (no execution, no readback, no audit entry)
   — it comes before steps 5 and 6 ✓: otherwise the agent would never get a preview of a `destructive` action ✗
5. Parameters outside the `guard` domain of that action → `denied` ✓ (the guard is the line the author of the pack drew ✓ — outside it is not permitted ✓)
6. `danger: destructive` → do it ✓ (no question to a human any more ✓ — the danger level is only information ✓ — the gate is the unified permission area in the settings ✓ · `03` section 2.4 ✓ · ADR-D48 ✓)
7. Execute → on failure `failed` (the command exited with a non-zero code); an action that depends on the exit code is not supported on a serial connection, then `unsupported_transport`
8. Readback → on a mismatch `readback_mismatch`.
   If the action declares `readback: {kind: none}` (`02` section 4.4.1, form 5) → the readback is skipped
   and `ok: true` with `verified: false` is returned
9. Write the audit log (an action that uses `none` has to be marked as "not verified" in the audit, `02` section 5.4)

> `dry_run` writes no audit entry ✓: the audit records every attempt —
> and a dry run is not even an attempt (it is a preview) → writing it would pollute the ledger of who touched the board ✓.

The order of `not_found` and `denied`: existence is checked before authorisation. An unauthorised caller therefore learns
that the action exists but cannot learn what it does — the `command` of the action is only returned once the authorisation has passed.
The order is deliberate: it makes "does the board have this capability" discoverable and "how is this capability implemented" not.

The `command` returned by `dry_run` is the final command after encoding (`02` section 4.6),
not a template. What the agent sees in the preview is therefore exactly what is executed.

The return shape of `dry_run` (the shape of section 5.3 of `02` plus the `ok` of section 4 of this document ✓):

```
→ { ok: true, dry_run: true, command: "...", readback_tag: "..." }
```

`readback_tag` is the tag the readback of this action reads; when the readback is not of the form "read a tag" it is `null` ✓.

#### 2.4.1 The authorisation of the agent

An agent is not a card, it has an authorisation of its own.

The authorisation of a card is "ask once per action when the card is installed"; the authorisation of an agent is a different thing: an agent can call any action directly,
it does not have to install a card first.

Rules:

| Tier | What the agent does |
|---|---|
| `reversible`, the parameters are inside the `guard` domain | The agent may execute it directly, and an audit entry is written |
| `reversible`, the parameters are outside the `guard` domain | `denied` ✓ (the guard is the line the author of the pack drew ✓ — outside it is not permitted ✓) |
| `destructive` | It does it ✓ (no question to a human any more ✓ — the danger level is only information ✓ — the gate is the unified permission area in the settings ✓ · `03` section 2.4 ✓ · ADR-D48 ✓) |

> Changed on 2026-11-16 (ADR-D48 ✓ · the user's own words: "do not ask any more whether a command is dangerous,
> use permissions for everything, turning a permission on already means knowing the danger" ✓) — a destructive action used to require a human nod ✓
> → it is not asked any more ✓ → dangerous actions are off by default in the settings ✓ (turning one on is the informed consent for that one step ✓).

Three details:

| # | Detail |
|---|---|
| 1 | The authorisation set of the agent = all the actions declared by the current board pack ✓ (section 2.4.2 ✓ · `02` section 5.6 ✓). A pack takes effect as soon as it is written ✓ (there is no layer of "a human confirmed this pack" ✓ — changed on 2026-11-16 ✓ · ADR-D46 ✓) — but it has to pass its own validator ✓ (the 31 rules of section 7 of `02` ✓) |
| 2 | The parameter domain is the `guard` declared by the action itself ✓ — there is no "narrower domain granted by a human" ✓ (that layer was removed on 2026-11-16 ✓) |
| 3 | Existence is checked before authorisation ✓ (see the behaviour table above) — the `command` of the action is only returned once the authorisation has passed ✓ |

> `denied` hardly ever happens in v1 ✓ (except when there is no pack ✓) → but it has to exist ✓:
> it is the guard rail at this place ✓ — if a narrower authorisation per connection or per user is added later ✓, the reason code is already there ✓.
> To be explicit: do not assume that it is in effect all the time ✗.

There is no confirmation chain any more ✓ (removed on 2026-11-16 ✓ — ADR-D48 ✓).

→ The agent calls `execute_action` → it is executed directly ✓ (a destructive action too ✓).
→ Parameters outside the `guard` → `denied` ✓.
→ The two tools `confirm_action` and `confirm_workflow` are gone ✓ (21 → 19 ✓) —
  the whole confirmation credential machinery is gone with them ✓ (`ConfirmationStore` ✓ · `requestConfirmation` ✓ ·
  `approveAndResume` ✓ · `confirm_id` ✓ · `workflow:confirm` ✓).

How the agent is held in check then ✓: by the unified permission area in the settings ✓ (`03` section 2.4 ✓ · ADR-D47 ✓) —
→ one row per operation ✓ · two switches, one for each executor ✓ (card / agent ✓)
→ dangerous actions are off by default ✓ (turning one on is the informed consent for that one step ✓)
→ it is the ledger ✓ (one place ✓ — there is no second copy of "who granted what" any more ✓).

What the agent cannot do: the agent cannot change the authorisation itself. It cannot raise its own permissions,
and it cannot change the authorisation of any card. It can only execute declared actions.

#### 2.4.2 Trust in the board pack

Every pack takes effect — as soon as it is written ✓ (the board description file has the final say ✓).

| Who wrote it | Does it take effect directly |
|---|---|
| The user wrote it, or it is built in | Yes |
| An agent drafted it | Yes as well ✓ (but what it wrote still passes the validation ✓ — the 31 rules of section 7 of `02` ✓) |

> Changed on 2026-11-16 (ADR-D46 ✓ · the user's own words: "the board description file has the final say",
> "add a board and whatever is in it executes" ✓) — there used to be a gate here that required a human to approve the pack ✓.

The gate that replaced it sits on the pack itself ✓:
- The fetching command of a reader passes the danger floor ✓ (rule 28 of section 7 of `02` ✓) —
  this is the only place where a reader can go out of bounds ✓ (it is not an action ✓ — it does not go through the executor ✓);
- Actions pass the danger floor and the `danger` level ✓ (`02` section 5.2 ✓) —
  `danger` is only information ✓ (changed on 2026-11-16 ✓ · ADR-D48 ✓) →
  a destructive action is executed as it is ✓ → the gate is the unified permission area in the settings ✓ (section 2.4.1 ✓ · ADR-D47 ✓);
- The permissions of a card are the declaration of its manifest ✓ (`03` section 2.4 ✓) —
  everything outside the declaration is denied ✓ — a card cannot say one thing and do another ✓.

So: the authoring side of the cards belongs to the agent, and the permission side of the device is drafted by the agent as well ✓;
but both sides pass the same set of rules that a machine can check ✓ (the validation rules ✓ + the danger floor ✓) —
there is no more "a human has to nod for every installation" ✓.

> ⚠️ The path through a card has no "a human pressed it" confirmation ✓ (changed on 2026-11-16 ✓ · ADR-D46 ✓):
> → A click on a card button is that one human action ✓ (`03` section 2.4 ✓) → a destructive action runs directly on the card path ✓.
> → The host cannot tell "a human pressed the button on the card" from "the JavaScript of the card called the same API" ✗
> → So a writable card that an agent installed can trigger those actions itself ✗
> → This is the direct consequence of what the user said ✓ — a stricter rule would need one more gate ✓ (this contract does not write that gate yet ✓).

Why it was chosen this way: the core value of this product is "an AI manufactures instruments and switches in bulk from a manual".
If every card and every pack that an agent writes had to be approved by a human, the collaboration loop would break —
so cards are not approved (`03` section 3.3), and packs are not approved either ✓ (changed on 2026-11-16 ✓ · ADR-D46 ✓).
The difference remains: a card can only read tags and call declared actions (under the constraints of the grading);
a pack can define new sources of readings — but its fetching commands pass a stricter machine check today ✓
(the rules 28–31 of section 7 of `02` ✓ — shell metacharacters, interpreter wrapping and the `script` kind are all forbidden ✓).

What about the danger level then: the floor (`02-board-pack.md` section 5.2) ✓ — but today it is only judged in the validator ✓
(changed on 2026-11-16 ✓ · ADR-D48 ✓: it is not checked again at runtime ✓ → a pack that hits the floor cannot be loaded ✓).

A pack declares `danger` itself, but there is a fixed table of operation patterns that belongs to the contract:
`reboot`, `mkfs`, `dd` to a block device, `flash`… these commands are always treated as `destructive`,
no matter what the pack declares.

So the agent is indeed trusted, but it cannot downgrade "reboot the board" to a reversible action by itself ✓ —
this tension is resolved today by a machine mechanism ✓ (the floor + the permission area ✓),
and it no longer depends on "a human nods" ✓ (that layer was removed on 2026-11-16 ✓).

(This tension is real: if nothing were done about it, an agent could write a reboot action with `danger: reversible`
and the grading would lose its meaning. The floor + the permission area is the smallest mechanism that lets both intentions hold at the same time ✓.)

#### `list_workflows()`

```
→ [{ id, name, inputs: { … } }]
```

Lists the workflows that are in the registry ✓ (there is no longer a layer of "approved by the user" ✓ — ADR-D48 ✓).

> Only the id, the name and the input declarations ✓ — never the topology ✓
> (which role connects to which machine and which command it runs → that is not for an unauthorised party to see ✗).

#### `run_workflow(id, inputs, dry_run)`

```
→ { run_id: "wf-…" }
```

It runs a workflow. It returns immediately ✓ (the compilation takes minutes ✓) → the progress is polled with `workflow_status` ✓.

With `dry_run: true` it is a preview ✓ (nothing runs ✓):

```
→ { ok: true, steps: [{ id, kind, role?, command?, action?, readback?, danger, timeout_ms? }] }
```

| Item | Rule |
|---|---|
| What runs | Not a single step ✓ — it is a preview ✓ |
| Is an audit entry written | No ✓ — the audit records every attempt ✓; a preview is not even an attempt ✓ |
| Is there a `run_id` | No ✓ — no run means no run id ✓ |
| Placeholders | The input values are replaced after being encoded by type ✓ (strings are quoted ✓ — as in section 4.6 of `02` ✓); the role facts and the output slots keep their placeholders ✓ — not connected and not run means not known ✓ |
| Danger level | Every step carries one ✓ (`reversible` by default ✓) — the agent has to know which step is destructive ✓ |
| A workflow that does not exist | No preview ✓ (`not_found` ✓) — a preview would leak what the pack does ✓ — that is not for an unauthorised party to know ✗ |

#### `workflow_status(run_id)`

```
→ { state: "running" | "done" | "failed" | "cancelled",
    current: { stepId, kind, at } | null,
    stages: [ { stepId, kind, ok, verified, reason?, audit_id } ] }
```

> `current` = the step that is running now (`05` section 8·B ✓): it is running ✓;
> when the run has ended → `null` ✓.
> → `at` = the moment that step started ✓ (the interface computes how long it has been running from it ✓).
> → `current` is a live snapshot (it changes ✓), `stages` only grows ✓ (the two have a different idempotency ✓, `05` section 8·B·B3 ✓).
> → `current` does not expose the roles ✓ (no topology ✓).
> → The card side sees a reduced projection ✓ (`03` section 7.7 ✓) — it is not this shape copied over as it is ✓.

#### Cancellation

The agent has no tool to cancel a workflow ✓ — whether to stop is a judgement of a human ✓ (`05` section 8·A·A4 ✓):
"whether it is allowed" is not given to the agent ✓ (section 2.4.1 ✓), and "whether to stop" is not given either ✓.

### 2.5 Layout

#### `promote_card(cardId, connectionId?)`

```
→ { ok, mode: "fullscreen" }
```

It promotes a card to fullscreen. For the interaction a terminal of that kind has to be able to take over (`htop` is unusable in a small card), but as far as the contract is concerned it is still a card.

What it changes is the layout ✓ — fullscreen is one state of the layout ✓ (`promoted` ✓), not a one-off rendering instruction ✓.

| Item | Rule |
|---|---|
| What is recorded | Only which cell has to be fullscreen ✓ (`{card_id, connection_id, x, y, w, h}` ✓ — its original position and connection ✓) |
| How many rows it spans | The number of rows that fill the visible height of the current main area — computed by the renderer from the viewport ✓ |
| The other cells | The host does not touch them ✓ — making room is a matter of the renderer as well ✓ |
| Connection | `connectionId` omitted = the only instance of that card; more than one is an error (never a guess) |

> Why the number of rows is computed by the renderer ✓:
> only the renderer knows the row height and the height of the viewport ✓ (`ROW_HEIGHT` is a constant of the renderer ✓) →
> the host computing it would be a guess ✗ → the host records "who wants fullscreen" ✓ and the renderer computes "how many rows" ✓ — neither side guesses ✓.
>
> Why making room is a matter of the renderer as well ✓:
> the layout model has no concept of "hidden" ✓ (`LayoutUnit` has only six fields ✓) →
> the host moving somebody else's cell would destroy the arrangement of the user ✗ → the host only records the state ✓.
>
> Why "change the layout" and not "add a mode field" ✓:
> a new mode would make the layout model grow a second shape (the format version has to be bumped ✓ · the renderer has to change ✓);
> changing the layout reuses the existing one ✓ (persistence ✓ · rendering ✓).
> The cost: fullscreen takes over the layout of the user ✓ (it has to be restored with `set_layout` ✓) — that cost is stated explicitly ✓.

#### `set_layout(layout)`

```
→ { ok, dropped: [...] }
```

It saves the layout (a replacement of the whole thing, not an increment).

It is normalised before it is written ✓:

| Item | Rule |
|---|---|
| `x` / `y` | Non-negative integers |
| `w` | `1 ≤ w ≤ 12` |
| `h` | `h ≥ 1` |
| Overlap | Not judged (left to the renderer) |
| A cell out of bounds | The whole entry is dropped ✓ and its `card_id` is reported in `dropped[]` ✓ |

#### `get_layout()`

```
→ { cards: [{ card_id, connection_id, x, y, w, h }] }
```

| Field | Meaning |
|---|---|
| `card_id` | The card id (the same name and the same meaning as `list_cards[].id` ✓) |
| `connection_id` | The connection this cell is bound to (`null` = no connection context) |

> The key of the layout is the pair `(card_id, connection_id)` ✓ — one card has one cell per connection ✓.

---

## 3. Interfaces outside the tool set

MCP covers AI ↔ GUI. The other two channels do not go through MCP:

| Channel | Purpose | Why it is not MCP |
|---|---|---|
| The file system | The agent edits the card directory directly | MCP does no file IO. An agent writes files much faster than it goes through MCP, and that is what it is best at |
| The file watcher | A change in the card directory → hot reload | An internal mechanism of the runtime |

The practical workflow of an agent is therefore:

```
write the card files in the file system   ← writing the files directly
    ↓
validate_card(path)          ← MCP: check
    ↓
install_card(path)           ← MCP: install (or put them in the right directory and the watcher installs them)
    ↓
get_card_runtime_log(id)     ← MCP: read the result of the run
```

MCP is the eyes and the hands of the AI, not its hard disk.

---

## 4. Conventions shared by the return values

| Convention | Content |
|---|---|
| Errors | `ok: false` plus a `reason`, no exception is thrown |
| Unknown | `status: "unavailable"`, neither `null` nor 0 is returned |
| Time | Millisecond timestamp, UTC. `at` = the moment this sample completed, not the moment it was broadcast<br>(the workflow side is the exception ✓: the `at` of `05` = the moment that step started ✓ — the same field name in a workflow means "when that step began" ✓) |
| Paths | Absolute paths |
| Version | The field `apiVersion` is carried by every response (a list carries it on every entry ✓) |

> The version field is spelled `apiVersion` throughout (as in the manifest and in the board pack).
> Historically three spellings existed, `api_version` and `version` among them,
> and now there is only `apiVersion` — the `apiVersion` in a response denotes the version of the contract,
> not the version of the tool set itself.

> "the value is null" and "this item does not exist" are two different things ✓:
> `status: "unavailable"` is about a reading ✓;
> and metadata fields such as `range` / `semantics` / `type` are `null` when the vocabulary does not know them ✓
> (which means "this item does not exist" ✓) — there is no contradiction ✓.

### 4.1 The failure reason codes (one table, shared by all the tools ✓)

It is closed ✓ — the failure of every MCP tool is taken from here ✓:

| Code | When | Who uses it |
|---|---|---|
| `invalid_params` | The parameters do not fit (type, range, enumeration, illegal value) | All of them ✓ |
| `not_found` | The thing does not exist (action, workflow, card and reading share the same name and the same meaning ✓ ADR-D27 ✓) | All of them ✓ |
| `denied` | Not permitted (the user refused, or there is no authorisation) | The write side ✓ |
| `busy` | The same thing is already running, it cannot run concurrently | The workflow side ✓ |
| `invalid` | The content is not valid (the manifest itself is not valid) | The card side ✓ |
| `failed` | Any other failure | All of them ✓ |
| `readback_mismatch` | The value that was read back does not match the expectation | `execute_action` ✓ |
| `timeout` | The command or the readback timed out | `execute_action` ✓ |
| `unsupported_transport` | The readback needs an exit code and this connection has none (serial) | `execute_action` ✓ |
| `cancelled` | It was stopped (not a failure ✓) | `execute_action` ✓ |

> `guard_exceeded` is not in this table ✓ — the flag does not exist any more since 2026-11-16 ✓
> (going outside the guard domain is a direct `denied` ✓ — section 2.4 ✓).

> Adding an entry to the table of codes is a contract change ✓ — it is the same governance as `danger_floor_version` (section 5.2.1 of `02` ✓)
> and `reason_code_version` (section 2.1.1 of `01` ✓) ✓:
> a change to a closed vocabulary goes through a review ✓.

### 4.2 When `apiVersion` is bumped (the criterion ✓)

| Case | Bumped or not |
|---|---|
| `devboard/v1` has not shipped with any implementation yet | Not bumped ✓ — this is a correction before v1 is finalised ✓ (precedent: ADR-D24 / D25 / D26 of the implementation-layer decision record ✓) |
| After v1 has shipped | Always bumped ✓ |

> The reason must not be written as "adding a field is not a breaking change" ✓ — this project has no such general rule ✓:
> a closed schema governs the artefacts (the inputs of the manifest / pack / workflow ✓),
> and an MCP response is not an artefact ✓ → adding a field does not violate the declared rules ✓,
> but the ground is "v1 has not shipped" ✓ — a different ground would not hold ✓.


The `n` of `sample_tag(name, n)` is "the n most recent samples", not "the last n seconds".
The length of the window is determined by the period of the poll group each tag belongs to (section 3.2 of `01`),
so the same `n` covers a different span of time on different tags — before an agent judges the jitter
it should look at the `interval_ms` in `list_data_sources`.

---

## 5. Three hard rules for the agent

They are written into the live documentation of the SDK:

1. Do not send raw commands. For a new capability, write a board pack extension or a card action.
2. Do not update the UI optimistically. After an action, render with the value of the `readback` in every case.
3. After writing a card, always run `validate_card` and `get_card_runtime_log`. A card that was written blind is most likely broken.

The third rule decides whether the whole collaboration loop works.

---

## 6. The boundaries of MCP itself

| What it does not do | Why |
|---|---|
| No file IO (except the copy of `install_card`) | An agent writes files faster on its own |
| No general purpose shell | See section 1.3 |
| It stores no state of the agent | Every call carries its own context |
| It does not guess the intent of the agent | Explicit parameters + dry-run |

The MCP server should be thin: it exposes the internal state of the GUI and nothing else.
Everything that can be done in MCP is either "read the internal state of the GUI" or "trigger an action the GUI has declared".

---

## 7. How to connect to it

This section does not lock the implementation, but it has to be clear, otherwise an agent cannot use it.

### 7.1 Transport

The decision: HTTP over the loopback interface (127.0.0.1) + a discovery file + a bearer token.

There are two standard MCP transports: stdio and HTTP (Streamable HTTP, which replaces the old HTTP+SSE).

| | How it is used | Why it is not used |
|---|---|---|
| stdio | The agent starts the MCP server as a subprocess and talks to it through a pipe | What the agent would have to start is "a desktop application that is in use by the user" — awkward; and the GUI has to stay operable by the agent and by the user at the same time. A separate process also violates the hard constraint "the MCP server and the GUI live in the same process" (ADR-D2 of the implementation-layer decision record) |
| HTTP (127.0.0.1) | The GUI opens a local port and the agent connects to it | Adopted. The price is the port and the local security baseline (see below) |

The reason: the GUI is something a user opens and keeps open anyway,
and the agent connects to the GUI that is already running instead of starting it.
The HTTP loopback keeps the MCP server inside the Electron main process (ADR-D2 holds)
and at the same time gives the agent a way to connect to it.

The local security baseline (part of the contract, not an implementation suggestion):

| Item | Requirement |
|---|---|
| Listening address | Bind `127.0.0.1` only, never `0.0.0.0` |
| `Origin` validation | Validate the `Origin` of every inbound request; when it is present and not allowed, answer 403 |
| `Host` validation | Accept only `127.0.0.1:<port>` and `localhost:<port>` |
| Authentication | Every request must carry `Authorization: Bearer <token>`, the token comes from the discovery file |
| Token | Regenerated on every start of the GUI (random, at least 32 bytes); never written to a log |
| Permissions of the discovery file | Readable by the current user only (POSIX 0600 / the ACL of the current user on Windows) |
| No CORS | No `Access-Control-Allow-Origin` is sent, no cross-origin access is granted |

> Why these rules are part of the contract and not implementation advice: a local HTTP MCP server that does not validate `Origin` and `Host`
> lets any malicious page the user has visited send requests to `127.0.0.1` through DNS rebinding,
> and drive `execute_action` to change the board of the user. The MCP specification requires this explicitly
> ("servers MUST validate the `Origin` header"), and this product writes it into the contract as a hard constraint.

What is not locked: the concrete library, the strategy for the port allocation and the concrete variant of SSE or Streamable HTTP
are decided by the connection method of the implementation layer. This contract only requires that "the agent can discover and connect, and what it connects to is always the GUI that the user of this machine started".

### 7.2 Discovery

How does the agent learn the port and the path?

The GUI writes a discovery file locally:

```
%LOCALAPPDATA%/DevBoardCockpit/mcp.json
{
  "apiVersion": "devboard/v1",
  "transport": "http",
  "host": "127.0.0.1",
  "port": 51234,
  "pid": 12345,
  "token": "<the bearer token generated for this start>",
  "cards_dir": "...",
  "started_at": "..."
}
```

The agent reads this file and knows how to connect. This file is the only coupling point:
when the transport changes, the agent only has to change the way it reads the file.

(Another common approach is a fixed port plus a fixed path. A fixed port collides when several instances are open, the discovery file does not have that problem.)

The rules of the discovery file:

| Item | Rule |
|---|---|
| When it is written | After the GUI has started and has successfully bound the port |
| How it is written | A temporary file is written first and then renamed atomically, so that the agent never reads half a file |
| Permissions | Readable by the current user only |
| Clean-up | It is deleted when the GUI exits; it is deleted as well when the port is taken (a discovery file that points at a dead process must not be left behind) |
| Stale file | When the agent cannot connect it does not retry other ports, it reports the error directly — that avoids connecting to another process |
| `pid` | It lets the agent confirm that this discovery file belongs to the GUI that is alive right now |

> Why the token lives in the discovery file: the discovery file is protected by permissions anyway (readable by the current user only),
> and it carries the address and the credential at the same time. The token is regenerated on every start,
> so the token left behind by the previous session is invalid immediately.

### 7.3 Who is trusted

The agent is a trusted party, but it is bound by the grading of the actions.

- The agent may read all the state (`list_*`, `describe_*`, `sample_*`).
- The agent may write cards (`install_card`) — that is the purpose of the product design.
- The agent may not execute a `destructive` action without a human confirmation (section 2.4.1).

"The agent can install arbitrary cards" has to be taken seriously: installing a card means running a piece of HTML/JS inside the workbench.
The sandbox of a card is therefore a serious one (`03` section 6 — it includes the CSP and `cockpit.storage.*`),
and a `destructive` action requires a human confirmation.

The trust of the agent is "trust within what has been authorised": the board state the agent may read = the boards the user has already connected;
the actions the agent may execute = the authorised actions; parameters outside the `guard` domain need a separate confirmation (`02` section 5.5).
The agent may not read the file system of the user, may not change the authorisation and may not connect to another board.

### 7.4 One run

```
user: install a card that shows the NPU utilisation
agent: list_tags()                    → sees that npu.usage exists, status=unavailable
agent: describe_tag("npu.usage")      → sees the semantics: "the maximum of the utilisation across the cores"
agent: list_cards()                   → checks whether one already exists
agent: writes the card files
agent: validate_card(path)            → the static check passes
agent: install_card(path)             → the hot plug takes effect
agent: get_card_runtime_log(cardId)   → no errors
user: (the card appears on the screen)
```

In this loop the agent uses three listing and introspection tools before it writes anything — that is why they have to be live and they have to be accurate.
Capabilities appear dynamically, static documentation cannot work.

