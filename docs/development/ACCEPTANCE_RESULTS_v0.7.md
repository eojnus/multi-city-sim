# 验收结果 v0.7（交付前最终验收）

- 验收对象：交付分支 **`b85cc0f`**（界面 `e49079d`：公开破产面板 + 长周期债券走查取证），合入 qa/acceptance 的 merge commit **`3177f39`**。
- 执行人：验收员（独立验收，不改 `src/**`）。
- 执行时间：2026-11-02（UTC）。
- 结论：**验收 106 条全部通过（106/106），0 红**；全量测试 57 文件 / 472 用例全绿；typecheck、build 通过；三套桌面走查脚本退出 0。

## 1. 基线（`b85cc0f` / qa `3177f39`）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 退出 0 |
| 构建 | `npm run build` | ✅ 退出 0 |
| 全量测试 | `npx vitest run --no-file-parallelism` | ✅ **57 文件 / 472 用例全过**（业务 45/366 + 验收 12/106） |
| 验收全组 | `npx vitest run tests/acceptance --no-file-parallelism` | ✅ 12 文件 / 106 用例 |

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
| I10 公开破产面板权限（本轮新增） | 5 | 5 | 0 | `tests/acceptance/public-bankruptcy-panel.test.ts` |
| **合计** | **106** | **106** | **0** | 逐条状态见 `docs/development/ACCEPTANCE_MATRIX_v1.md` §1.8/§2 |

## 3. 红条清单

无。历史红条均已在后续分支修复并复验核销：B12/B14 兑付未入账（`316eff4`）、I07 界面财政泄漏（`7c5edf7`）、G04 真实 GDP 回填（`1d138a6`）、F08 同月两段兑付幂等键（`21e699a`）。

## 4. 桌面走查证据（`b85cc0f` 最终构建，Xvfb :99 1600x1000x24 + Electron，窗口 1440×900）

| 证据 | 内容 | 路径 |
|---|---|---|
| 走查主场景 8 张 + manifest | 市民受限态 vs 市长财政面板（同城同 tick 对照）、债券发行/认购、月度报告、区域卡片 | `artifacts/qa-final/`（sha256/city/身份/tick/DOM；consoleErrors=[]） |
| 主交互冒烟 27 项 | 存读档（formatVersion=7、日期一致）、1100 宽无横向溢出、损坏自动存档安全降级 | `artifacts/smoke-main.json` + `artifacts/smoke-*.png` |
| 权限/债券/破产 42 项检查 | 20 张权限与债券市场截图，含长周期 tick 22→23：岚港破产、公开破产面板（看守期/银行垫付/已勾销/股份托管）、12 期破产兑付 | `artifacts/ui-fiscal/`（20 张）、`artifacts/ui-fiscal-bonds/`（9 张 + `NOTES.md`） |
| 历史轮次留档 | qa-before 10 / qa-after 10 / qa-after-block2 7 | `artifacts/{qa-before,qa-after,qa-after-block2}/` |

说明：`artifacts/` 被 `.gitignore` 忽略，证据仅磁盘留档；本节证据均为 `b85cc0f` 构建产物。

## 5. 已在矩阵中单列的已知限制（不判红，交付报告需披露）

1. **36 月基线漂移**：sim 块3/4 后真实序列为仅岚港 t27 破产、垫付 485,295,713.34、成交 739,973 份；`fixtures/economy-baseline-36m-v07.json` 早于块3/4，仅用于 A 组归档自洽校验，AC-K07 需数值岗重出基线。
2. **破产后 AI 不再发债**：债务分期到期使“禁借新还旧”恒真，属当前实现行为。
3. **债券认购同城/跨城**：真实 36 月样本 61 跨城 + 24 同城（全部 `investorGroup`）；口径只要求允许跨城，不禁止同城。
4. **企业清算**：银行实收 0、债务减免约 40% 未偿；银行 36/36 月利差为负；部分企业利润基本全分红、现金不足 2 个月工资（影响可认购额度）。
5. **契约注释歧义**：`ConsumerBudgetSnapshot.effectiveBudget` 类型注释写“cashBudget+loanAvailable”，实现按 DECISIONS #26 为 `= cashBudget`。

## 6. 建议写入交付报告 §9 的三行结论

1. 在最终 HEAD **`b85cc0f`** 上独立验收 **106 条全部通过（A–I 十组 + I10 公开破产面板，0 红）**；全量 57 文件 472 用例、typecheck、build 全绿。
2. 桌面走查在 Xvfb+Electron 真实环境完成：市民可见公开破产事实（看守期/垫付/勾销/托管）但看不到财政余额/流水/债务率/风险档；市长可见本市财政面板；债券发行/认购、月报、存读档与损坏档降级均符合契约；三套脚本退出 0，证据含 sha256 manifest（`artifacts/qa-final/`、`artifacts/ui-fiscal-bonds/`）。
3. 仍有 4 项已知限制与 1 处契约注释歧义（36 月基线待重出、破产后 AI 不再发债、企业清算/银行利差/分红结构、`effectiveBudget` 注释），已在 ACCEPTANCE_MATRIX §1.8 与本文披露，不影响 v0.7 验收通过结论。
