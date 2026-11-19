# Board packs

The format is defined by the contract: `docs/spec/02-board-pack.md`. This
directory holds the packs themselves.

| Pack | Board | State |
|---|---|---|
| `rk3588-atk/` | ATK-DLRK3588 (Alientek) | Verified against real hardware |

> The contract defines 31 validation rules, not 19. The review added five:
> parameter encoding, guard subset checking, the closed set of readback forms,
> and two more.

- One board is one directory holding one `board.yaml`, plus an optional
  `README.md` and `scripts/`.
- Validate with `npm run validate:profiles`.
- To add a board, follow `docs/spec/02-board-pack.md` section 8.
