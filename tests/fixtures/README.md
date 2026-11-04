# 真实旧版存档 fixture

## v0.9-real-f942cc9.json

- **生成版本**：`f942cc9`（v0.9 发布提交，`SAVE_FORMAT_VERSION = 9`、`GAME_VERSION = '0.9.0'`）
- **生成方式**（在隔离 worktree 中用旧版代码生成，不是用当前代码伪造）：
  ```bash
  cd /workspace/Coding/multi-city-sim
  git worktree add /tmp/v09-old f942cc9
  ln -s /workspace/Coding/multi-city-sim/node_modules /tmp/v09-old/node_modules
  # 在 /tmp/v09-old 下用 tsx 运行生成脚本（Simulation.create(DEMO_CONFIG) → 5 × tick() → 该版本 serializeSave）
  cd /tmp/v09-old && /workspace/Coding/multi-city-sim/node_modules/.bin/tsx gen-v09-save.ts
  ```
- **世界**：默认三城演示世界（`DEMO_CONFIG`），固定种子 `seed = 20261101`（初始 `rngState = 2923674663`），玩家无操作，默认 AI。
- **推进月数**：5 个月（保存时 `time.tick = 5`、`savedAt = 2026-10-01T00:00:00.000Z`）。
- **关键规模**：30 家企业（开局 17 家 + 5 个月内存续/创办）；人口 `lanport 600077 / ironvale 430560 / greenfield 320965`。
- **为什么保留**：该文件是真实旧版 v0.9 存档，`Company` 尚无 `equipmentCapacityRemainder` 字段、
  `EquipmentMarketState` 尚无 `pendingLedger`；用于回归验证当前代码读取旧档时不会因缺字段失败，
  且读取不会重新执行“人口 ×5 / 新开局追加企业”等新版本逻辑。由 `tests/legacy-v09-save.test.ts` 读取。
