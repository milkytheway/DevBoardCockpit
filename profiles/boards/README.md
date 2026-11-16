# 板型包（board pack）存放处

**格式由契约定义**：`docs/spec/02-board-pack.md`。这里只放包本身。

| 包 | 板子 | 状态 |
|---|---|---|
| `rk3588-atk/` | 正点原子 ATK-DLRK3588 | 🟡 草案，已迁入；核对状态见 `docs/06-契约核对.md` |

> 校验规则共 **31 条**（`docs/spec/02` §七），不是 19 条——
> 评审新增了参数编码、`guard` 子集、回读形式封闭等 5 条。

- 一块板 = 一个目录 = 一个 `board.yaml`（+ 可选 `README.md`、`scripts/`）。
- 校验：`npm run validate:profiles`（规则见 spec/02 §七）。
- 新增一块板的步骤：见 `docs/spec/02-board-pack.md` §八 与 `docs/02-设备事实清单.md`。
- **契约与实测的差异**（比如某个 reader 指向的路径在真板上不存在），
  一律记在 `docs/06-契约核对.md`，不要私自改包。