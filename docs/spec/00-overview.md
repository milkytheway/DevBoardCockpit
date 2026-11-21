> Source and revisions: this document was migrated from the predecessor project `DevBoardConsole\docs\spec\` (2026-11-12, Codex, commit `c24b084`).
> The contract layer is the authoritative documentation. It was revised by `0244852` after the migration (the body was not left unchanged; see section 1.2 for the per-section provenance).
> For the implementation see `README.md` at the repository root.
# DevBoard Cockpit · Specification Overview

> This document is the first deliverable of the specification track. It binds to no implementation language and to no shell form.
> Whether the shell turns out to be Electron, a thin shell or pure web, not one word of the specification has to change.

---

## 1. Two symmetric buses

The whole product has exactly two contracts; everything else is implementation detail:

| Bus | Connects | Contract | Read by |
|---|---|---|---|
| tag contract | card ↔ board | `01-tag-contract.md` + `02-board-pack.md` | cards, the host-side agent |
| MCP contract | AI ↔ GUI | `04-mcp-tools.md` | the host-side agent |

> The workflow pack (`05-workflow-pack.md`) sits on neither of these buses ✓.
> It is the data format for "how one job is done" ✓ (multiple targets, multiple steps, with criteria ✓).
> Cards and agents both trigger it through the two buses above ✓ (`cockpit.workflows.*` in `03` section 7.7 ·
> `run_workflow` in `04` section 2 ✓) → it is not a channel of its own ✓.

The two buses are symmetric because they answer the same kind of question from two directions:

- The tag contract answers "what the board looks like right now and how to change it" — cards work through it.
- The MCP contract answers "what this software has right now and what you can do on my behalf" — the agent works through it.

The host-side agent is a reader of both buses at once: it reads the tag contract to understand a board it has never seen, and the MCP contract to understand software it has never seen.
Both contracts must therefore be readable by the agent on their own — this is what separates them from ordinary configuration files, and it is why the format has to carry its own explanation.

---

## 1.2 Source and revision record

The contract layer was substantially revised after it was migrated out of the predecessor project; it was not "left with an unchanged body". This table is the basis for review and traceability:
every section states whether it is migrated original text, revised after the migration, or added by this review round.

| File | Migrated version | `0244852` revision | Added by this review round (2026-11-12) |
|---|---|---|---|
| `00-overview.md` | sections 1–7 | +26/−15: added D6–D14, changed the three escape hatches to three | section 1.2 this table; section 4 decision numbers changed to `SPEC-D*` |
| `01-tag-contract.md` | sections 1–8 | +156/−44: the vocabulary became a table with a semantics column, the five states of core tags were refined, `backlight.brightness` added | the vocabulary moved into `data/tag-vocabulary.yaml` and became authoritative there; `mem.available_bytes` / `cpu.governor` added; the missing edges of the state transition table filled in; the definition of `mem.total` versus `mem.used_bytes` corrected |
| `02-board-pack.md` | sections 1–10 | +337/−83: added the danger floor, grew validation rules 10 to 19, added the three readback forms, added binding rules | added the `verify` definition, the parameter encoding rules, the floor matching specification and serial mutual exclusion; `readback.expect` brought into the `{param}` scan; added value tables for `format`/`type` |
| `03-card-manifest.md` | sections 1–9 | +172/−28: closed the schema, added the `actions[]` fields, 11 validation checklist items | kept one single card API and gave it its names; added CSP and `cockpit.storage.*`; added the fields and the validation for "in-view action versus board-pack action" |
| `04-mcp-tools.md` | sections 1–7 | +194/−14: added agent authorisation, pack trust, transport and discovery | the transport settled on HTTP loopback plus a token plus a security baseline; added the `confirm_id` lifecycle; unified the spelling of the version field |

How to use this table: when a reviewer objects to an entry, first work out which column it belongs to.
Changing something marked "migrated original" means changing the predecessor project's specification; what is marked "added by this review round" was decided by that round.

> Why this table was added: the migration note used to say "the body was not changed", yet `git diff c24b084 0244852 -- docs/spec` is +956/−187 lines —
> the three large security mechanisms (the danger floor, agent authorisation, transport and discovery) all arrived in that revision with no migration record at all.
> The label "authoritative, body unchanged" would let reviewers skip them.

---

## 2. The layered model

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Application layer   Terminal │ Monitor │ Control │ Capture │ Layout editor    │
├──────────────────────────────────────────────────────────────────────────────┤
│  Card layer          manifest · file-based · hot reload · sandbox · promote    │
├──────────────────────────────────────────────────────────────────────────────┤
│  Capability layer    Source (scalar tag) │ Stream                              │
│                      Action (parameters · grading · readback)                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  tag contract        stable vocabulary: name · type · unit · semantics         │
├──────────────────────────────────────────────────────────────────────────────┤
│  Connection layer    Connection HAL · capability negotiation                   │
│  ┌────────┬──────────┬──────────┬────────────────┐                             │
│  │ Serial │   SSH    │   ADB    │   Any future   │                             │
│  └────────┴──────────┴──────────┴────────────────┘                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  Board pack          board pack (YAML data pack, one per board)                │
└──────────────────────────────────────────────────────────────────────────────┘
     ▲
     │  MCP contract (read state / write cards) + file watching (hot reload)
     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Host-side AI Agent: perceive → write cards → hot-plug → self-test → iterate   │
└──────────────────────────────────────────────────────────────────────────────┘
```

There is exactly one dependency direction: the upper layer depends on the lower one, and the lower one does not know that the upper one exists.

- A card does not know which board it is on; it only knows tag names.
- A board pack does not know which card is using it; it only declares which tags it provides, how they are produced and which actions it accepts.
- The connection layer does not know who is above it; it only offers "I can read files, run commands and push streams".

Once this direction is broken, "supporting a new board = submitting a pack" and "N cards × M board types = N+M files" no longer hold.

---

## 3. Six contracts

| File | What it is | Drafting status |
|---|---|---|
| `01-tag-contract.md` | the semantic tag contract: vocabulary, types, states, refresh model | drafted |
| `02-board-pack.md` | the board pack format: readers, tag bindings, actions, verification states | drafted |
| `03-card-manifest.md` | the card manifest format: read-side bindings, write-side bindings, grading, permissions | drafted |
| `04-mcp-tools.md` | the MCP tool set: the AI's eyes and hands | drafted |
| `05-workflow-pack.md` | the workflow pack format: how one job is done (multiple targets, multiple steps, with criteria) | drafted (2026-11-15) |
| `06-board-kit.md` | the board kit format: everything one board model needs, with the machine-specific values left to the person | drafted (2026-11-21) |
| `data/tag-vocabulary.yaml` | the machine-readable authority for the core vocabulary (the table in `01` is generated from it) | drafted |

Plus the artefacts that ship with the application:
`profiles/boards/rk3588-atk/board.yaml` — the first real board pack, based on measured data from an ATK-DLRK3588;
`profiles/kits/ATK-DLRK3588/` — the board kit of that board (the connections it needs, with the machine-specific values as variables ✓).

The machine-readable form of the contracts is generated by the implementation layer, and it must be generated from the tables in this directory — writing a second copy in code is not allowed.
Changing one place means two places (the contract document / the implementation layer); adding a board pack on top makes it three, otherwise the cross-check test goes red.

> Why the vocabulary lives in a YAML file of its own: a Markdown table is not a reliable machine-readable carrier
> (a cell can contain `|`, the column order has to be maintained by hand, and a single changed space shifts a column silently).
> `data/tag-vocabulary.yaml` is the single authority; the table in `01-tag-contract.md` is its rendered result,
> and the implementation layer is generated from it too. The three are kept consistent by a cross-check test — the implementation layer calls this the only hard criterion against semantic drift ✓.

---

## 4. Decisions already made

> On numbering: the numbers in this table are `SPEC-D*` (contract-layer decisions).
> The numbers in this table are this layer's own decision numbers (`SPEC-D*`); there is no second numbering system here.
> Historically two systems wrote "D7", which made "see D7" ambiguous — this round fixed that ✓.

| # | Decision | Reason |
|---|---|---|
| SPEC-D1 | The specification comes first, the shell is decided later | The tag contract, the board pack, the manifest and MCP are all language-neutral. Deciding the shell before writing the contracts means the specification spins on the spot. |
| SPEC-D2 | The board pack uses a hybrid: a small number of versioned built-in reader kinds plus three escape hatches | A purely declarative form cannot express tags such as "the difference of two samples"; code bindings would stop the pack from being self-explanatory and would degrade it into the old project's `metrics.py` with a YAML shell wrapped around it. |
| SPEC-D3 | A missing tag degrades gracefully: the card still loads, the missing widget shows as unavailable | When an agent tries a card on another board it should not be turned away; otherwise the iteration loop turns into a swamp. |
| SPEC-D4 | Tags describe scalar measurements only; a continuous stream is not a tag | Putting video streams, log streams and file contents into the tag vocabulary pollutes it. Streams travel over a different API. |
| SPEC-D5 | A board pack and a connection profile are two different things | The first describes "what this board is", the second describes "how to connect to this board". The old project's `TargetProfile` was the latter. |
| SPEC-D6 | A reader produces samples; the pack explicitly binds samples to tags | One kind serves many boards with different names; two readers also cannot collide on the same tag. |
| SPEC-D7 | The unit of polling is the poll group: one group = one round trip | This resolves two measured facts at once: "one `adb shell` per file costs 30ms and the fork pollutes `/proc/stat`" and "`/proc/stat` must be sampled every second". |
| SPEC-D8 | The reader decides whether the read succeeded; the runtime decides whether the value is fresh | A reader stays a pure function; `stale` depends on history, so it does not belong to the reader. |
| SPEC-D9 | There is only one core vocabulary, namely `data/tag-vocabulary.yaml`; the Markdown table and the implementation layer's machine-readable form are both generated from it | Two copies of the vocabulary inevitably drift — you change the document and not the code, and both sides claim to be right. The implementation layer's copy is a generated artefact, not a source. |
| SPEC-D10 | Every layer of the card schema is closed; an unknown field is an error | A field that is silently ignored is a field that was mistyped. The promise "v1 has no network permission" needs somebody to enforce it. |
| SPEC-D11 | `permissions.write` supports exact ids only, not patterns | Read permission is low risk and patterns are convenient; write permission has side effects and patterns are dangerous. The risk is asymmetric. |
| SPEC-D12 | ⛔ Superseded (2026-11-16) — the original decision: board packs take effect unconditionally (the agent is trusted), but "taking effect" presupposed that a human had confirmed that pack | Now: board packs take effect unconditionally ✓ (the board description file has the final say ✓ — the user's own words ✓) → the "a human has to nod before a pack is installed" layer is gone ✓. Why it was superseded: that "card" is the agent's creative surface ✓ (installing cards is not approved ✓); the reader bypass is blocked by the contract layer today ✓ (`02` section 7, rules 28–31 ✓ — shell metacharacters / interpreter wrapping / the `script` kind are all forbidden ✓), so it no longer relies on "ask once per install" ✓. |
| SPEC-D13 | ⛔ Superseded (2026-11-16) — the original decision: destructive actions must be confirmed by a human, and the agent cannot mint its own credentials | Now: destructive actions are executed as declared ✓ (no more asking a human every time ✓ — the danger grade is only information ✓) → the gate is the unified permission area in settings ✓: that class of action is off by default ✓ → turning it on is the informed consent for that one step ✓. |
| SPEC-D14 | The danger grade has a floor: the command pattern table belongs to the contract, and reboot / flash / format always count as destructive | SPEC-D12 and SPEC-D13 pull against each other: without a floor an agent could write a pack with `reboot: reversible` and slip past the grading. The floor lets both of them hold at the same time. |
| SPEC-D15 | The danger floor matches the parsed command, not the literal template | If the floor matched the template (`pipeline start --model {model}`), an injected `reboot` would not be inside the template and the floor would be useless. |
| SPEC-D16 | Action parameters must be encoded by type before they are injected; they must never be concatenated verbatim | Declarative parameters plus free-text substitution equals command injection. The board-side session runs as root, so this rule decides outright whether "the agent cannot exceed its permissions" holds. |
| SPEC-D17 | Card network access is switched off by a host-injected CSP; card storage goes through the host-managed `cockpit.storage.*` | The `sandbox` attribute of an iframe does not restrict network access. Writing only "no same-origin" is not enough to honour "v1 cannot reach the network". |
| SPEC-D18 | MCP runs over an HTTP loopback plus a discovery file plus a bearer token | The agent connects to a GUI that is already running instead of being asked to start it. stdio requires the agent to launch the process, which conflicts with "the GUI is a long-lived desktop application". |
| SPEC-D19 | ⛔ Superseded (2026-11-16) — the original decision: authorisation granularity = action id plus an optional parameter domain | Now: authorisation granularity = action id ✓ (the domain is the `guard` the action declares itself ✓) — there is no "narrower domain granted by a human" ✓ (that layer was removed on 2026-11-16 ✓ · `04` section 2.4.2 ✓). |
| SPEC-D20 | The data-acquisition interface is a Source (poll / push); v1 implements poll only | A Stream (HDMI, camera into the NPU) is inherently push-based. Welding "acquire then distribute" to pure poll means that adding a Stream later means reworking every card API. Interface polymorphism is a one-line signature decision; deferring it to M3 costs too much. |
| SPEC-D21 | TagStore is the single convergence point for readings; readings carry a monotonic `seq` | The UI, the cards and the AI must all see a projection of the same state. Once a layer starts keeping its own "I remember it as…", two cards display different numbers and the user cannot tell which one is real. `seq` lets the render layer discard out-of-order old values. |
| SPEC-D22 | A round trip is exclusive on the link; an action and its readback cannot be split apart | On a half-duplex line (serial) sampling and actions have to be serialised transactionally. If a readback is cut in on by a sample it may read the output of a different command, and "the readback did not match" becomes a false negative — the cockpit would display a wrong real state. |
| SPEC-D23 | Cancelling is the host's business: cards and agents have no cancel interface; the contract does not promise that "the process definitely dies" | "Whether it is allowed" and "whether it stops" are judgments of the same family — "whether it is allowed" has already been denied to the agent (`04` section 2.4.1), and "whether it stops" is denied too, otherwise the confirmation chain gains a bypass for "deciding by myself not to do it". And "the process definitely dies" is an implementation-layer mechanism: kill the process locally, close the channel over ssh, kill the local client over adb, impossible over serial — putting that into the contract would be lying to three of the transports. What the contract promises is "the host stops waiting" plus "the timeline tells the truth". |
| SPEC-D24 | The step in flight is expressed with the additional field `current`; the card side gets a reduced projection | A compile takes minutes, so the interface must not be dead silent. `current` is independent of `stages`: `stages` is an append-only verdict (`ok` is a binary verdict, not a tri-state), while `current` is a live snapshot (running, or stopped waiting for a nod). The card side only gets `stepId`/`kind`/`ok`/`verified`/`reason` — cards are written by an AI, and the less they see the safer they are. |
| SPEC-D25 | Only "the destination did not exist before" makes it meaningful to leave no half-written file after a failed or cancelled transfer | `to.path` comes from the pack and value-mode substitution is not encoded — cleanup that is not encoded is an injection surface. The criterion is "the destination did not exist before the transfer" (so it must have been produced by this transfer), not "the size and the mtime changed" (the same size within the same second cannot be detected, and it cannot be told whether this step or somebody else changed it). When in doubt, do not delete: it is better to leave half a file than to delete the user's data. |
| SPEC-D26 | The device (the physical board) and the connection (the profile) are two layers: `device_key` identifies the board, `options.ssh` is the SSH endpoint of the machine behind that connection | One board has ADB / serial / SSH connections, and all of them point at the same board. A board pack says "what model this board is", a connection says "how to reach it" — two boards of the same model share one pack, yet they are not one board. `device_key` supplies the "physical board" layer: the interface has to group by board and credentials have to be bound to a specific board (a credential signed for board A must not be used on board B), and both need it. `options.ssh` in turn solves actions that cross machines: the command runs on the client machine but what is wanted is the board's address, while that board's private key sits on the client — so the board's SSH address has to travel with the connection (with the profile, not into the pack: machine-specific values do not go into a pack). |
| SPEC-D27 | The board kit: everything one board model needs, with the machine-specific values as **variables** ✓ | A connection profile carries values that belong to **one machine and one board** ✓ (the serial port ✓ · the board's serial number ✓ · the address ✓) → a published repository must not carry them ✓ → **the shipped profiles could only carry placeholders** ✓ → **a placeholder profile is a profile that cannot connect** ✓ (that is how the release of 2026-11-20 shipped three connections that pointed nowhere ✓). → **A kit replaces the placeholder profile with a template** ✓: the person fills the variables once ✓, the host writes a concrete profile ✓, and **the runtime does not change** ✓ (it never sees a placeholder ✓). → The board pack ✓, the workflow packs ✓ and the cards ✓ stay exactly where they are ✓ — **a kit refers to them ✓, it does not carry them** ✓. → **The kit is the only thing that may name the machine-specific values** ✓, and the variables live in the **user data directory** ✓ (`profiles/settings.json` is inside the read-only archive ✓). **The values may be detected** ✓ — but only while there is **exactly one candidate** ✓ (`06` §4.4 ✓ · rule 17 ✓) → several candidates are a question for the person ✓. |
| SPEC-D28 | A connection profile has **two layers**: the identity comes from the shipped profile ✓ · the machine-specific values come from the user's copy ✓ | The identity (`label` ✓ · `transport` ✓ · `board_pack` ✓ · `device_key` ✓) is the **contract** of the connection ✓ — which board it is ✓ · which channel it uses ✓ — and it does not belong to one machine ✓. The options (the address ✓ · the serial number ✓ · the serial port ✓ · the credential ✓) belong to **the machine the profile is used on** ✓. → **The old rule was "the user's copy wins completely"** ✓ → a copy that is written once and never touched **freezes** the profile ✓ → a shipped fix (a renamed board ✓ · a new default ✓) never reaches the machine ✓. That is exactly how the board came to be called `atk-01` on a machine whose shipped profile says `ATK-DLRK3588` ✓ (found on 2026-11-21 ✓). → **The cost** ✓: the loader has to merge the two copies field by field ✓ (and report a stale copy ✓) → and a person who wants a *different* identity has to use a *different* profile id ✓ (the wizard does that already ✓ · `board-<board id>` ✓). |
| SPEC-D29 | The **credential** is a machine-specific value ✓ — and it is **verified** against the host before it is used ✓ | The credential is as machine-specific as the address ✓ (it belongs to the person ✓ · a published repository must not carry it ✓) → it has no home in the profile unless the profile carries it ✓ (`options.key_filename` ✓ · `options.password` ✓). → **A key that does not authenticate is not the credential of that host** ✓ → the criterion is the handshake ✓ (**a measurement ✓** — not a guess ✓) → the key that opens the host is the credential of that host ✓. → **The failure has to say which problem it is** ✓: the host did not answer ✓ (an address problem ✓) · the host answered and refused the credential ✓ (a key problem ✓) · there was no credential at all ✓ (a profile problem ✓) — one message for all three ✓ sends the user looking for a network problem that does not exist ✓ (measured on 2026-11-21 ✓: the board answered ✓ and refused the key ✓ — and the interface said "cannot reach the SSH host" ✓). → **The cost** ✓: one extra handshake per connection while the credential is still unknown ✓ (and it is written down afterwards ✓ → the next time there is none ✓). |

> This paragraph is the original text of 2026-11-12 — it was overturned on 2026-11-16 ✓
> (see the ⛔ marks on those two rows of the table above ✓).

Original wording: the combination of SPEC-D12 and SPEC-D14 was the point that most needed spelling out in that round —
what is trusted is "the agent may write things by itself", not "the agent may bypass the human's confirmation";
SPEC-D12 was therefore narrowed to "a pack takes effect only after a human confirms it".

How it stands today (not the original wording) ✓:

> What is trusted is "the agent may write things by itself" ✓.
> → Board packs take effect unconditionally ✓ (the board description file has the final say ✓)
> → Destructive actions are executed as declared ✓ (no more asking a human every time ✓)
> → The gate is the unified permission area in settings ✓ (dangerous actions are off by default ✓)
> → The reader bypass is blocked by the contract layer ✓ (`02` section 7, rules 28–31 ✓)
>
> The cost is written down here ✓: there is no longer an "a human has to nod before a pack is installed" step ✓ →
> a board pack drafted by an agent takes effect as soon as it is installed ✓ →
> today's fallback is "rules a machine can check" (the validator + the floor + the permission area) ✓, not "a human clicks once" ✓.


## 5. How this maps onto the existing code

The existing `core/` is about 2000 lines, of which about 1500 are orthogonal to the new contract and can be kept as they are:

| Existing module | Position in the new architecture | Disposition |
|---|---|---|
| `core/targets.py` (the `Target` ABC) | the connection layer HAL | Keep. Add a capability face (`pty` and `files` are already embryonic). |
| `core/registry.py` (`register_transport`) | the registration face of the connection layer HAL | Keep. |
| `core/adb_target.py` / `ssh_target.py` / `serial_target.py` / `local_target.py` | the implementations of the connection layer HAL | Keep. Board-specific knowledge has to be cleaned out of here (except for the GNU assumptions of `ls -la`). |
| `core/process.py` | the connection layer HAL | Keep. |
| `core/session_log.py` | a shape reference for the action audit log | Keep (the audit log follows its style). |
| `core/colouring.py` | the display details of the terminal card | Goes along with the terminal card. |
| `core/metrics.py` | Split: the reader kind implementations move into the reader layer; the RK3588-specific paths move into the board pack | Split. |
| `core/profiles.py` (the connection profile) | the connection layer | Keep, but rename (it is called profile today, and that collides with board pack). |
| the whole of `ui/` | the application layer | Throw away and rewrite. |

The idea inside `core/metrics.py` of "one round trip, marker segmentation, report None and not 0 for the unknown" is the right shape for a reader in the new architecture, it has already been validated, and it is inherited as it is.

---

## 6. What this round does not do

- No decision on the shell form, the implementation language or the process model.
- No implementation of the card runtime.
- No implementation of the MCP server.
- No HDMI capture, no multi-board management, no layout sharing, no recording and replay.

The deliverable of this round is only the contracts and one real board pack, plus a verification script that can run against a real board.

---

## 7. Open items and risks

| Item | Description |
|---|---|
| The board pack needs verification on real hardware | The sandbox cannot reach the board (the host's adb port 5037 forwarding is not enabled). The implementation layer needs a probe command that runs against a real board on the Windows host and confirms the actual output format of every reader. |
| The vocabulary boundary | For now there is only the coarse rule "closed core plus `custom.*` private extension". What belongs in the core vocabulary can only be judged once a second board shows up. |
| The contract for continuous streams | A Stream (video / logs / files) currently has only a placeholder definition and is not settled. The interface layer already reserves room for it (`SPEC-D20`: the acquisition side is unified as a Source, `kind ∈ {poll, push}`, v1 implements poll only), but the business contract for a Stream is still undefined. From 2026-11-13 board packs no longer declare `capabilities: [..., stream, ...]` — declaring it would promise something that cannot be delivered, and validation rule 26 rejects it as an error (`02` section 10.7.4). |
| The capability vocabulary | ✅ Settled (2026-11-13, `02` section 10.3): the board-level vocabulary `{shell, exec, stream, files}` and the connection-level vocabulary `{exec, pty, files, exitCode}` are two axes, with a word-sense correspondence table between them; `requires.capabilities` is information and not a gate (serial has `files=false`, and using it as a gate would violate `02` section 10.2). What is still missing is a consistency matrix of "transport × capability" — the `ssh` and `local` rows have no measured basis yet, and writing the rules down as if they were settled would turn them into false rules. |
| Multi-board semantics | Already resolved by `03` section 7.8: the card API takes the host-injected connection context as an implicit scope, tag names inside the card API never carry a prefix, and the binding happens at the layout layer (`(cardId, connectionId)`). The prefix question is isolated in the host's resolution layer, so adding multi-board support later does not require changing the card API |
| The capability-layer vocabulary | The vision document writes `Metric / Video / File / Shell` and `Action / Command`; the contract converges these into `Source / Stream` and `Action`. `Command` does not exist in the contract — and `02-board-pack.md` section 4.1 states plainly that "if the control plane offers nothing but 'send one command', it is a remote control, not a cockpit". The diagram in the vision document has to be updated to match the contract. |
| The layout model | Card sizes, the grid and the layout save format are not settled in this round. |

