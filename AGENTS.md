# AGENTS.md — working notes for agents in this repository

> This file describes how to work on `DevBoardCockpit`, a Windows desktop
> workbench for embedded Linux boards.
> It is written for an agent that has just opened the repository: read it before
> changing anything.

---

## 1. What this project is

One sentence:

> A Windows desktop workbench for embedded Linux developers. A board's
> capabilities are standardised as **semantic tags**, visualisation and control
> as **cards**, and extension as **MCP**, so an AI agent on the host can build
> instruments and switches on demand.

The project has three layers, and they are not interchangeable:

| Layer | Where | Standing |
|---|---|---|
| **Contract** | `docs/spec/` (six documents plus `docs/spec/data/tag-vocabulary.yaml`) | **Authoritative.** The tag vocabulary, the board pack format, the card manifest, the workflow pack format and the MCP tool set are defined here. |
| **Implementation** | `src/` | The Electron shell, the card runtime, the workflow engine and the MCP server. |

There is no separate design document. The contract is the design.

### Three invariants

1. **The contract comes first.** The implementation matches `docs/spec/`
   clause by clause. It does not introduce a second set of names or a second
   set of state semantics.
2. **An agent can make cards.** A card is a directory of files. An agent
   writes it, it takes effect, and changing one line hot-reloads it.
3. **A cockpit, not a remote control.** Every control action reads the board
   back. The interface reports the board's real state, not the state the
   application believes it set.

---

## 2. Reading order

```
README.md                      Start here.
docs/spec/00-overview.md       The two buses and where every rule comes from.
docs/spec/01-tag-contract.md   The tag vocabulary and the five states.
docs/spec/data/tag-vocabulary.yaml
                               Machine-readable authority for the vocabulary.
                               `docs/spec/01` renders it; this file is the source.
docs/spec/02-board-pack.md     Board packs and reader kinds.
docs/spec/03-card-manifest.md  Cards and permissions.
docs/spec/04-mcp-tools.md      The MCP tool set.
docs/spec/05-workflow-pack.md  Workflow packs: how one task is carried out.
docs/02-device-facts.md        Measured facts about a real board. Read before
                               writing a parser, a transport or a tag binding.
docs/tutorial/                 Methodology: how to build a board pack, how to
                               write a card, the terminology.
```

---

## 3. Rules

| Rule | Detail |
|---|---|
| **The contract is authoritative** | To change a tag name, a unit, a state semantic or a board pack field: change `docs/spec/` first, then change the implementation. Change both in one commit, or the conformance tests fail. |
| **One source for the vocabulary** | `docs/spec/data/tag-vocabulary.yaml` is the authority. Edit the YAML, then run `npm run gen:vocabulary`. Never write a second copy of the vocabulary. |
| **Contract changes need a decision record** | Record the decision in `docs/spec/00-overview.md` section 4 under the next `SPEC-D` number, and state the cost as well as the rule. A contract change without a recorded decision is not finished. |
| **`apiVersion`** | `devboard/v1` has not shipped with any release yet, so a correction made before the first release does **not** bump it. After v1 ships, every contract change bumps it. Adding a member to a closed code table is a contract change. |
| **Conformance is the verdict** | The implementation must pass the golden samples that come from the same source as the contract. The samples live in `fixtures/`; the same sample must give the same result on both sides. |
| **Facts carry a status** | Measured / reported by the user / not yet verified. Do not present the second as the first. |
| **Absolute paths** | Windows host paths as `C:\...`; board-side paths as POSIX absolute paths. |
| **No large binaries in the repository** | SDKs, firmware and manuals are referenced by path, never committed. |
| **Write the test before the fix** | Every pure function has a unit test. Real-device samples become golden vectors. |
| **Prove the test still guards** | After fixing a defect, revert the fix and confirm the corresponding test turns red, then restore it and confirm it turns green. "The test passed" does not mean "the test catches the bug". `npm run mutation:check` measures that. |
| **Model the substitute by behaviour** | A fake implementation must simulate the real behaviour — echo every line, run the command, call back asynchronously. Returning the answer the contract expects hides protocol-shape defects. |
| **Run the checks before committing** | `npm run lint && npm run typecheck && npm test` must be green. |
| **Commit messages are English** | `<type>(<scope>): <summary>`, for example `feat(cards): add the thermal card`. |

---

## 4. Where the facts come from

- `docs/02-device-facts.md` — measured paths, commands and pitfalls of a real
  board. The only source of device facts.
- `docs/spec/` — the contract. Where fact and contract disagree, the contract
  wins and the implementation is corrected; the disagreement is recorded, not
  silently patched.

---

## 5. Code conventions

| Item | Convention |
|---|---|
| Language | TypeScript, `strict: true`. No `any`; use `unknown` and narrow. |
| Main / renderer boundary | Device I/O, the tag layer, the action layer, the card registry and the MCP server all live in `main`. The renderer only draws. |
| Cards | Run in a sandboxed iframe. They reach the host only through the whitelisted API in `docs/spec/03-card-manifest.md`. |
| Child processes | On Windows, always `windowsHide: true`, or every command flashes a console window. |
| Tests | vitest. Pure functions get unit tests; real-device samples become golden vectors in `fixtures/`. |
| Samples | Files under `fixtures/` are append-only. To change a parser, add a new sample and keep the old one as a regression input. |

---

## 6. Do not

- Rename a tag or redefine a state semantic without changing the contract first.
- Write implementation code against an unreviewed contract.
- Let the renderer touch a device directly, bypassing the tag and action layers.
- Give cards a back door: same-origin access, arbitrary `postMessage`, direct
  filesystem access.
- Read board state one file per round trip. It pollutes `/proc/stat`.
- Run sampling and actions concurrently on one connection. A serial line has
  one wire; the traffic interleaves.
- Interpolate parameters into commands. Encode them by type.
- Rely on the iframe `sandbox` attribute alone to cut network access. The host
  must inject the CSP.
- Treat `unavailable` as `0`.
- Edit the contract documents as a side effect of an implementation change.

---

## 7. Adding a dependency

npm installs `optionalDependencies` per platform (`@esbuild/win32-x64` versus
`@esbuild/linux-x64`, `@rollup/rollup-win32-*` versus `-linux-*`). Installing
on one platform therefore removes the other platform's packages, and the
toolchain stops working there.

- On the Windows host: run `npm install`, then restore the other platform's
  packages with `bash scripts/acceptance/linux-natives.sh restore` from a
  Linux environment.
- To change `package-lock.json`, use `npm install --package-lock-only`. It
  rewrites the lock file and leaves `node_modules` untouched.

`package.json` and `package-lock.json` must stay in sync. `npm ci` installs
from the lock file alone, and a dependency listed only in `package.json` will
be missing.

---

## 8. The fake device

```bash
npm run dev                    # the fake board ships and is on by default
COCKPIT_FAKE=off npm run dev   # no fake board at all
COCKPIT_FAKE=only npm run dev  # only the fake board
```

The fake board (`src/main/hal/fake/`) runs at the HAL boundary: the real
board packs, the real reader kinds, the real tag store and the real samplers
all run; only the layer that talks to the board is replaced.

| Rule | Reason |
|---|---|
| The fake board emits raw text only — jiffies, kB, `@Hz`, millidegrees. It never produces a percentage and never produces a state. | The five states are the contract (`docs/spec/01`). A fake that invents them is a second copy of the contract, and it will drift. |
| The fake board's connection profile is never written to disk. | `profiles/targets/` stays clean. |
| The fake board is **never an automatic runtime candidate** — it only becomes one when it is the only board there is (`COCKPIT_FAKE=only`). | It is synthetic data, and it always connects. Left in the running, it wins the race against the real board, the runtime samples synthetic data, and the interface shows the fake board as the board the person is on (found on 2026-11-21). |
| The real boards are listed **first**; the fake one comes last. | The default selection has to be the real board — the fake one is synthetic data. |
| The production build **does** contain it — the user decided that on 2026-11-21. | The fake board is useful without the hardware ✓; the interface labels it as synthetic data on every screen ✓ and the real boards come first ✓. `scripts/check-build.ts` **asserts the marker is there** ✓. |

Without it, the shell can only be developed against absent hardware — and an
interface that has never seen `unavailable` or `error` meets both for the first
time the moment the board drops off.

### The fake board and the real one

They are **two boards** ✓ — never one ✓:

| | The real board | The fake board |
|---|---|---|
| Its identity | its `device_key` ✓ | its own ✓ (`fake-board` ✓) |
| Its terminal | on its own page ✓ | on its own page ✓ |
| Its role | the runtime samples it ✓ | **only when it is asked for** ✓ |

→ **One board's information never shows up under another board** ✓ — the
terminal page belongs to the board that is current ✓ (and to the machines ✓ —
they are not boards ✓) · the sidebar draws the group of the board that is
current ✓ and puts the sessions of the other boards in one group of their own
✓ (they have to stay closable ✓ — a serial port is exclusive ✓).

---

## 9. Commands

```bash
npm run dev                # electron-vite development mode
npm run build              # three-stage build plus a self-check of the output
npm run lint               # ESLint
npm run typecheck          # tsc --noEmit, both projects
npm test                   # vitest
npm run test:cards         # Playwright against a real Electron build
npm run validate:profiles  # validate the board packs
npm run probe:board -- --profile <profile>
                             # run the readers against a real board
npm run gen:vocabulary     # regenerate the vocabulary from the YAML
npm run gen:vocabulary:check
                             # assert YAML = document tables = code vocabulary
npm run mutation:check     # mutation testing: prove the regression tests guard
npm run check:package      # validate the packaged application
npm run dist               # build the Windows installer
```

> `npm run gen:vocabulary:check` is a separate script entry on purpose. Under
> PowerShell, `npm.ps1` swallows the arguments after `--`, which would turn the
> check into a regeneration — and regeneration rewrites the contract document.
> A standalone entry behaves the same on every platform.

`npm run mutation:check` rewrites source files in place while it runs. Do not
run it while another agent is editing the same tree.