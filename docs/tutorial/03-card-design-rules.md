# Card design rules

> Who this is for: anybody writing a card — a human or an agent.
> Scope: the inside of a card. The shell around it belongs to the host.
> Every rule here is mechanical where it can be: the ones that can be tested
> name the test that enforces them.

A card is a file, and an agent writes it. That only works if the rules for a
good card are written down, otherwise every agent invents its own visual
language and the workbench turns into a pile of noise.

---

## 1. The principle

**One card is one claim.** If you cannot say in one sentence what the card
asserts, split it.

| Good | Bad |
|---|---|
| "The CPU is at 37 % overall" | "Information about the CPU" |
| "2.1 GB of 8 GB is in use" | "A pile of memory numbers" |
| "The SoC is at 62 °C and is already throttling" | "The temperature situation" |
| "This board is an ATK-DLRK3588, 4 × A55 and 4 × A76" | "Board identity" |

**Attention is zero-sum.** N cards with k focal points each make N·k
competing focal points. Six cards on one screen are only readable if each of
them has at most one.

> The goal is not to make each card more beautiful. The goal is to make each
> card weaker, so that the one thing that matters can be seen.

The mechanism behind "the cards get messy as they multiply" is this: more
cards means a smaller share of attention per card, so every card has to push
harder to be noticed, and the result is a mess. The fix is the opposite of
the instinct. Concentrate the attention in one place and let the rest be
quiet.

---

## 2. The information budget

```
┌─────────────────────────────────────┐
│  the title bar — the host draws it   │
├─────────────────────────────────────┤
│                                     │
│            one primary readout       │   the number that matters
│                                     │
│   at most two auxiliary readouts     │   the numbers that qualify it
│                                     │
│   one status line                   │   how fresh it is, what it means
│                                     │
└─────────────────────────────────────┘
```

| Item | Budget |
|---|---|
| Primary readout | 1 |
| Auxiliary readouts | ≤ 2 |
| Status line | 1 |
| Self-drawn trend graph | 0 |
| Different data shapes in one card | ≤ 2 |

A **data shape** is a way of presenting data that looks different from the
others: a dial, a bar, a grid, a sparkline, a number. Two shapes next to
each other make the reader switch mental modes, and neither reads well. Two
is the limit; one is better.

**Trends and history belong to the host.** The detail panel next to the
workbench already shows the sample stream, the raw readings and the
observation window. A card that draws its own sparkline duplicates that and
spends the attention budget twice.

---

## 3. Colour

### 3.1 Three legitimate sources

| Source | Who may use it | What it is |
|---|---|---|
| `--cockpit-*` | cards and shell | the semantic layer: background, surface, border, text, accent, and the state colours |
| `--shell-mat-*` | shell only | the material layer: veils, edges, sheens, shadows. A card cannot reach it. |
| `color-mix()` on those two | cards and shell | light and dark modulation of a semantic colour |

Everything else is forbidden in a card stylesheet: a hex value, an `rgb()`,
an `hsl()`, a colour keyword. The test suite rejects it.

The reason is not taste. A literal colour is a second source of truth, and a
second source of truth drifts. The theme is defined once in
`src/shared/theme/seed.ts`; a card that hard-codes a colour is a card that
breaks when the theme changes.

### 3.2 The semantic layer

These are the aliases a card may use. The contract fixes them, and the
theme test keeps the list complete: an alias that goes missing fails the
suite rather than silently changing a skin.

| Alias | Meaning |
|---|---|
| `--cockpit-bg` | the application background |
| `--cockpit-bg-elevated` | panel headers, inputs, overlays |
| `--cockpit-surface` | the surface of a panel or a card |
| `--cockpit-surface-active` | the selected surface |
| `--cockpit-border` | a hairline separator |
| `--cockpit-border-strong` | a panel border or an input border (≥ 3:1) |
| `--cockpit-text` | body text and the digits of a readout |
| `--cockpit-text-dim` | secondary text, units, labels |
| `--cockpit-text-faint` | weakened text and empty states |
| `--cockpit-accent` | the single accent: selection, focus, links |
| `--cockpit-accent-2` | a second accent, the second series of a chart |
| `--cockpit-ok` | ok / live |
| `--cockpit-warn` | degraded / stale |
| `--cockpit-danger` | error / destructive |
| `--cockpit-unavailable` | unavailable: the board does not offer this |
| `--cockpit-series-1` … `--cockpit-series-7` | the series of a chart |
| `--cockpit-radius`, `--cockpit-font-mono`, `--cockpit-font-ui` | geometry and type |

### 3.3 Colour expresses state, never identity

A GPU is blue and an NPU is purple: that is an identity colour, and it is
forbidden. Identity is expressed with a text label. Colour is reserved for
"ok / stale / dangerous / unavailable".

The reason is that a colour that means "GPU" cannot also mean "danger", so
the moment a second meaning appears the reader has to guess. Text is
unambiguous and it costs nothing.

### 3.4 The colour budget

Within one screen:

- at most 3 semantic colours in play (ok, stale, danger);
- one accent, for the selection;
- one background glow. More than one turns the background into noise.

---

## 4. The seven hard rules

**4.1 Colour expresses state, not identity.** See §3.3.

**4.2 State uses the classes the host injects.** The host injects
`.cockpit-value`, `.cockpit-value--stale`, `.cockpit-value--error`,
`.cockpit-unavailable`, `.cockpit-pending`, `.cockpit-empty`,
`.cockpit-broken`, `.cockpit-degraded`, plus `.cockpit-label`,
`.cockpit-unit`, `.cockpit-note` and `.cockpit-age`. A card that implements
its own state colours builds a second state language, and the two drift.

**4.3 Do not repeat what the host already does.** The title bar, the status
dot, the menu, the detail panel and the action controls all exist. A card
that redraws them spends its budget on something the user already has.

**4.4 No glow in the normal state.** A card that shines while everything is
fine makes a real problem invisible. At most one element may glow, and only
while something is wrong.

**4.5 No gradient that encodes data.** A gradient fill makes "how much"
harder to read, not easier: the eye reads the bright end, not the length.
Use a solid fill for a quantity.

**4.6 One font weight and one size hierarchy.** A card with three weights
has no hierarchy, because everything shouts.

**4.7 Motion only answers an action.** An animation that runs on its own is
noise. An animation that follows a click is feedback.

---

## 5. When to split a card

Split when any of these is true:

- the claim cannot be stated in one sentence;
- there are more than two data shapes;
- the budget is exceeded;
- two of the readouts change at a different rate and compete for attention;
- the card only becomes interesting when a second card is open.

Splitting is not a failure of the card. Six quiet cards that each say one
thing beat one busy card that says six.

---

## 6. What the host already provides

Do not rebuild these:

| The host provides | Do not rebuild it as |
|---|---|
| the card title, the subtitle, the status dot, the menu | a card-level header |
| the detail panel: the sample stream, the raw readings, the observation window | a sparkline, a history table |
| the action controls and their confirmation | a slider, a toggle, a button row |
| the `.cockpit-*` state classes | a status chip with its own colours |
| the `--cockpit-*` theme variables | a literal colour |

---

## 7. The self-check

Paste this at the top of a new card and answer every line.

```
[ ] The card states one claim, in one sentence.
[ ] There is one primary readout and at most two auxiliary ones.
[ ] There is one status line and no self-drawn trend graph.
[ ] There are at most two data shapes.
[ ] No colour literal appears in the stylesheet.
[ ] Every colour comes from a --cockpit-* variable.
[ ] No colour identifies a thing; colours only carry state.
[ ] State comes from the host-injected .cockpit-* classes.
[ ] Nothing glows unless something is wrong, and then at most one thing does.
[ ] No gradient encodes a quantity.
[ ] One font weight, one size hierarchy.
[ ] The card does not redraw the title bar, the detail panel or an action.
[ ] The card is quiet enough that a neighbour on the same screen stays readable.
```

---

## 8. The mechanical verdicts

The rules that can be tested are tested. A rule that only lives in a
document decays.

| Test | What it holds |
|---|---|
| `tests/web/visual-material.test.ts` | no colour literal in a non-generated stylesheet; the card injects only the contract variables |
| `tests/unit/theme/map.test.ts` | the alias list is complete, both skins provide every alias, the generated artefacts match the seed, the contrast holds, and every state has a class |
| `tests/web/shell-consistency.test.ts` | the terminal and the alias layer come from the same source |
| `tests/unit/contrast.test.ts` | the contrast of the semantic colours (≥ 4.5:1, or 3:1 for large text and borders) |
| `npm run gen:theme:check` | the generated CSS is the seed plus the material layer |
| `npm run check:language` | the repository stays English, so a card written in Chinese is a review finding |

---

## 9. What is a rule and what is not

| This | Belongs to the contract? |
|---|---|
| A card may only use the contract aliases, never a literal colour | **Yes** — the contract fixes the variables a card may rely on |
| A card expresses state with the host-injected classes | **Yes** |
| The information budget, the shape limit, the self-check list | **No** — these are review criteria, not a runtime contract |

The distinction matters. The contract is the hard boundary between the host
and a card. This document is the soft boundary of a design review. Turning
a matter of taste into a contract turns design taste into an API, and it
would take the freedom away from the people who write the cards.

---

*A card is not there to show what the board can do. It is there so that a
person can read the state of the board at a glance.*