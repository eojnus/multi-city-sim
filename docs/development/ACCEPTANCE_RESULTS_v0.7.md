# 验收结果 v0.7（交付前最后一轮）

- 验收对象：交付分支 `21e699a`（含 sim `3d0d21b` AC-F08 修复），合入 qa/acceptance 的 merge commit **`78cfc2c`**。
- 执行人：验收员（独立验收，不改 `src/**`）。
- 执行时间：2026-11-02（UTC）。
- 结论：**验收 101 条全部通过（101/101），0 红**；业务基线 45 文件 366 用例通过；typecheck、build 通过。

## 1. 基线

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 退出 0 |
| 构建 | `npm run build` | ✅ 退出 0 |
| 业务基线 | `npx vitest run --exclude 'tests/acceptance/**' --no-file-parallelism` | ✅ 45 文件 / 366 用例 |
| 验收全组 | `npx vitest run tests/acceptance --no-file-parallelism` | ✅ 11 文件 / 101 用例 |

## 2. 验收分组结果

| 组别 | 用例数 | 通过 | 失败 | 证据文件 |
|---|---|---|---|---|
| A 基线不变量（36 月归档自洽 + 已知限制） | 4 | 4 | 0 | `tests/acceptance/baseline-a.test.ts` |
| B 政府债券 | 15 | 15 | 0 | `tests/acceptance/bonds.test.ts` |
| C 企业购债 | 5 | 5 | 0 | `tests/acceptance/company-bond-subscription.test.ts` |
| D 居民消费 | 9 | 9 | 0 | `tests/acceptance/household-consumption.test.ts` |
| E 居民消费贷 | 8 | 8 | 0 | `tests/acceptance/household-loans.test.ts` |
| F 破产/清算/分股（夹具） | 14 | 14 | 0 | `tests/acceptance/bankruptcy.test.ts` |
| F-R 真实 36 月破产序列 | 8 | 8 | 0 | `tests/acceptance/bankruptcy-real-run.test.ts` |
| G 开局 12 月 GDP 估计 | 8 | 8 | 0 | `tests/acceptance/gdp-estimate.test.ts` |
| H 存档迁移 v1–v7 与读档幂等 | 17 | 17 | 0 | `tests/acceptance/migration-v7.test.ts`（14）、`tests/acceptance/settlement-resume.test.ts`（3） |
| I 权限白名单与泄漏回归 | 13 | 13 | 0 | `tests/acceptance/permissions.test.ts` |
| **合计** | **101** | **101** | **0** | 逐条状态见 `docs/development/ACCEPTANCE_MATRIX_v1.md` §1.6/§2 |

## 3. 红条清单

无。上一轮唯一红条 **AC-F08**（同月到期+破产时“财政段+垫付段”两段兑付，第二段被 `makePayment` 幂等键丢弃）在 `21e699a` 已修复：`bonds.test.ts` F08 用例断言 `principalRepaid=10,000`、持有人净收 11,200，通过。

历史红条（均已在后续分支修复，留档）：B12/B14 兑付未入账（`316eff4` 修复）、I07 界面财政泄漏（`7c5edf7`）、G04 真实 GDP 回填（`1d138a6`）。

## 4. 桌面走查证据（修后）

| 证据 | 内容 | 路径 |
|---|---|---|
| 走查主场景 8 张 + manifest | 市民受限态 vs 市长财政面板（同一城市同一 tick 对照）、债券市场发行/认购、月度报告、区域卡片 | `artifacts/qa-final/`（`manifest.json` 含 sha256/city/身份/tick/dom 摘要，consoleErrors=[]） |
| 主交互冒烟 | 27 项交互、存读档、窗口缩放、损坏存档降级 | `artifacts/smoke-main.json` + 截图（`scripts/smoke-main.cjs`） |
| 更早轮次留档 | qa-before 10 / qa-after 10 / qa-after-block2 7 / ui-fiscal 15 / acceptance-* 11 | `artifacts/{qa-before,qa-after,qa-after-block2,ui-fiscal}/` |

说明：`artifacts/` 被 `.gitignore` 忽略，证据仅磁盘留档；本轮 `qa-final/` 为 `21e699a` 构建产物，旧目录未覆盖。

## 5. 已在矩阵中单列的已知限制（不判红，交付报告需披露）

1. **36 月基线漂移**：sim 块3/4 后真实序列为仅岚港 t27 破产、垫付 485,295,713.34、成交 739,973 份；`fixtures/economy-baseline-36m-v07.json` 早于块3/4，仅用于 A 组归档自洽校验，AC-K07 需数值岗重出基线。
2. **破产后 AI 不再发债**：债务分期到期使“禁借新还旧”恒真，属当前实现行为。
3. **债券认购同城/跨城**：真实 36 月样本 61 跨城 + 24 同城（全部 `investorGroup`）；口径只要求允许跨城，不禁止同城。
4. **企业清算**：银行实收 0、债务减免约 40% 未偿；银行 36/36 月利差为负；部分企业利润基本全分红、现金不足 2 个月工资（影响可认购额度）。
5. **契约注释歧义**：`ConsumerBudgetSnapshot.effectiveBudget` 类型注释写“cashBudget+loanAvailable”，实现按 DECISIONS #26 为 `= cashBudget`。

## 6. 建议写入交付报告 §9 的三行结论

1. 在 `21e699a` 上独立验收 **101 条全部通过（A–I 十组，0 红）**；typecheck、build、业务 366 用例与验收 101 用例均为绿，AC-F08 等历史缺陷已复验核销。
2. 桌面走查在 Xvfb+Electron 真实环境完成：市民看不到财政、市长可见本市财政面板；债券发行/认购、月度报告、存读档/损坏档降级均按契约行为，consoleErrors 为 0（证据 `artifacts/qa-final/`，sha256 逐张在 manifest）。
3. 仍有 4 项已知限制与 1 处契约注释歧义（36 月基线待重出、破产后 AI 不再发债、企业清算/银行利差/分红结构、`effectiveBudget` 注释），已在 ACCEPTANCE_MATRIX §1.6 与本文披露，不影响 v0.7 验收通过结论。
