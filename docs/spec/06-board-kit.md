# 06 · Board Kit Format

> **What it is**: everything one board model needs to be used — the board pack
> that describes it, the connections that reach it, the workflow packs that drive
> it and the cards that show it — **in one directory, with the machine-specific
> values left to the person**.
>
> **Why it exists**: the connection profile carries values that belong to *one
> machine and one board* (the serial port, the board's serial number, the
> address). A published repository must not carry them ✓ — so the shipped
> profiles could only carry placeholders ✓, and a placeholder profile is a
> profile that **cannot connect** ✓.
>
> → **A kit replaces the placeholder profile with a template** ✓ — the person
> fills the variables once ✓, and the host writes a concrete profile ✓.
> → **The board pack, the workflow packs and the cards stay exactly where they
> are** ✓ (the kit *refers* to them ✓).
>
> **Drafting status**: drafted (2026-11-21, SPEC-D27 ✓)

---

## 1 · The shape

```
profiles/kits/<kit-id>/
  kit.yaml                 # the manifest ✓
  connections/
    <profile-id>.json      # a connection **template** ✓
```

- **A kit is a directory; a board pack is one YAML file** ✓ → different things ✓.
- The **kit id equals the directory name** ✓ (a kit is always enumerated by its
  directory ✓ — there is no "bind a kit by name" path ✓).
- **The kit id is the model** (what the board reports) ✓ — `ATK-DLRK3588` ✓.
- **`profiles/kits/` is not a root** ✓ — not for connection profiles ✓, not for
  board packs ✓, not for workflow packs ✓, not for cards ✓.

---

## 2 · `kit.yaml` — the manifest

**The field list is closed** ✓ — an unknown field is an error ✓ (the same rule
as the other three artefacts ✓).

| Field | Meaning |
|---|---|
| `apiVersion` | The known version ✓ (`devboard/v1` ✓) |
| `kind` | `BoardKit` ✓ |
| `id` | The kit id ✓ (= the directory name ✓) |
| `model` | **What the board reports** ✓ — matched with `exact` or `substring` ✓ (the same two modes the board pack's `match` has ✓) |
| `board_pack` | The board pack this kit is for ✓ (it must exist in the same distribution ✓) |
| `device_key` | The identity of the board this kit connects to ✓ (the interface groups by it ✓) |
| `workflows` | The ids of the workflow packs that belong to this board ✓ (they must exist ✓) |
| `cards` | The ids of the cards that belong to this board ✓ (they must be installed ✓) |
| `variables` | What the person has to fill in ✓ (the type table is the one of `05` §2 ✓) |

### 2.1 `variables`

Each entry: `type` (from the closed table of `05` §2 ✓) · `label` ✓ ·
`required` ✓ · `default` (optional ✓) · `description` (optional ✓).

> **A variable without a type does not exist** ✓ — the type is what makes the
> substitution checkable ✓ (a number must not become a string ✓).

---

## 3 · The connection templates

- A template is a **connection profile** (the same fields ✓) whose values may
  contain **placeholders** ✓.
- **A placeholder is exactly `${name}`** ✓ — nothing else is recognised ✓
  (no nesting ✓ · no escaping ✓ · no default values inside the placeholder ✓).
  → **A typo is a typo** ✓ — it is never guessed ✓.
- **The placeholders of a template must be declared in the kit's `variables`** ✓
  → an undeclared one is an error ✓.
- **The templates are not connection profiles** ✓ — they are not read by the
> profile loader ✓, and `parseProfile` must not accept them as profiles ✓.

---

## 4 · Installing a kit

1. The person picks the board (**the transport and the serial parameters** ✓ —
   the same single step the wizard asks for ✓).
2. The host reads the model ✓.
3. The host looks for the kit whose `model` matches ✓ — **exactly one** ✓.
   → **Zero or several → the host says so and picks none** ✓ (never a guess ✓).
4. The host asks for the kit's variables ✓ (the ones with no value yet ✓).
5. The host writes **one connection profile per template** into the **user
   profile directory** ✓ → **the user's copy wins over the built-in one** ✓.
6. **The board pack, the workflow packs and the cards need no step** ✓ — they
   are already there ✓.

### 4.1 The variables live in the **user data directory**

> → **Not in `profiles/settings.json`** ✓ — that file is inside the application
> archive ✓ and is **read-only** once the application is installed ✓.
> → They live next to the other per-machine state ✓
> (`permissions.json` ✓ · `layout.json` ✓ · the user profile directory ✓).

### 4.2 Installing twice does not destroy anything

→ A profile that **already exists** is **not overwritten** ✓ — installing a kit
again only fills in what is missing ✓.
→ (The wizard is the one thing that overwrites ✓ — it probes again ✓ — so
overwriting there is the point ✓.)

### 4.3 The result must be re-checked

→ **After the substitution the profile is validated again** ✓ — a value that
does not fit the schema is an error, not a profile that fails later ✓.
→ **The result must not contain `${` any more** ✓.

### 4.4 The values may be **detected** ✓

→ The **person is the authority** ✓ — but the host may **propose** ✓:
the board's serial number (`adb devices` ✓) · the address the board reports
about itself (`adb shell ip -4 addr show` ✓) · the serial port (**the one
that answers** ✓ — a port that exists proves nothing ✓).
→ **Exactly one candidate → it may be filled in** ✓.
→ **Several candidates → the person says which one** ✓ (the board setup ✓).
→ **No candidate → it is reported** ✓ — never invented ✓.
→ **A connection without a board pack never receives a board's address** ✓
(the host's own shell ✓ · the guest machine ✓ — it has an address of its
own ✓).

---

## 5 · The rules

| # | Rule | Why |
|---|---|---|
| 1 | The manifest's field list is **closed** ✓ | the other three artefacts are closed ✓ — a field that is silently ignored is a field that was misspelled ✓ |
| 2 | The manifest declares `apiVersion` and `kind: BoardKit` ✓ | the other three artefacts declare both ✓ — otherwise the host cannot tell what it is reading ✓ |
| 3 | **The templates never enter a runtime scan path** ✓ | today that is only true because the four scanners are not recursive ✓ — a rule makes it a fact instead of a coincidence ✓ |
| 4 | A placeholder is exactly `${name}` ✓ | nothing else is recognised ✓ — never guessed ✓ |
| 5 | **Every placeholder of a template is declared** in the kit's `variables` ✓ | an undeclared placeholder is an error ✓ |
| 6 | **A variable has a type** ✓ (the table of `05` §2 ✓) | otherwise a number can turn into a string and be rejected only at run time ✓ |
| 7 | **The substituted result is validated again** ✓ and **contains no `${`** ✓ | the profile schema checks the presence of a field but hardly its type ✓ — without this check a leftover placeholder becomes a profile that cannot connect ✓ |
| 8 | The kit's `model` is matched with `exact` or `substring` ✓ (the two modes of the board pack's `match` ✓) | a second meaning for "matches" would be a second dialect ✓ |
| 9 | **Zero or several matching kits → the host picks none and says so** ✓ | the same "never guess" the board pack binding has ✓ |
| 10 | The kit's connections **share one `device_key`** ✓ and **declare one `board_pack`** ✓ | otherwise one physical board appears twice in the interface ✓ — and the conflict warning does not see it ✓ |
| 11 | Installing a kit writes the profiles into the **user profile directory** ✓ | the user's copy wins over the built-in one ✓ |
| 12 | A kit may only refer to a board pack / workflow packs / cards **that exist in the same distribution** ✓ | a kit is not a self-contained container ✓ — a reference to something that is not there fails silently otherwise ✓ |
| 13 | The **variables live in the user data directory** ✓ | `profiles/settings.json` is inside the read-only archive ✓ |
| 14 | Installing a kit does not overwrite an existing profile ✓ | installing is "fill in what is missing" ✓ |
| 15 | Installing a kit is a **host-local action** ✓ — it is not an MCP tool ✓ | the MCP tool set is closed ✓ (§3 has two exceptions ✓ — this is not one of them ✓) |
| 16 | `apiVersion` is **not bumped** ✓ (`devboard/v1` has not shipped with any implementation ✓) | the version discipline of the contract layer ✓ |
| 17 | The machine-specific values may be **detected** ✓ — but **only when there is exactly one candidate** ✓ | the detection is a proposal ✓ · several candidates are a question for the person ✓ · none are reported ✓ |

---

## 6 · What a kit does **not** change

- The **board pack** stays at `profiles/boards/<id>/board.yaml` ✓
  (**the directory name equals the pack id** ✓ — the "bind by name" path
  requires it ✓ — that rule is written down in `02` §8 ✓).
- The **workflow packs** stay at `profiles/workflows/*.yaml` ✓ and their ids
  keep the `name.name` shape ✓ (`rk3588-atk.build-run` ✓ — rule 4 of `05` §9 ✓
  allows it ✓ — **no change to that rule** ✓).
- The **cards** stay at `cards/<id>/` ✓ — the card id is the directory name ✓
  ✓ — a kit **refers** to cards ✓, it does not carry them ✓ (the card roots are
  two ✓ and a kit is not one of them ✓).
- The **connection profiles** keep their ids ✓ (`board-adb` ✓) — the model is
  carried by `device_key` ✓, not by the id ✓ (**the built-in workflow packs
  refer to those ids** ✓ — changing them would break eight packs ✓).

---

## 7 · The kit of the fake board

> The fake device is **synthetic data** ✓ — its profile is made up in memory
> ✓ and is **never written to disk** ✓.
> → **A kit of the fake board carries no connection template** ✓ — the host
> provides that board ✓.
> → The kit only declares the board pack ✓ (the generic pack ✓ — it is a
> **recipe** ✓, it is not a model ✓ — so it is reached by naming it ✓, never
> by matching it ✓).

---

*2026-11-21 · the rules come from two independent reviews ✓ (contract consistency ✓ and
implementability ✓) — the corrections they forced are in the text above ✓.*
