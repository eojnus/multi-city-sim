# 验收测试（qa/acceptance 分支）

这些用例属于独立验收，全部由验收员维护；开发不要改这里的断言来“修绿”，要改实现后由验收员复跑核销。

## 本轮状态（第五轮，交付分支 `316eff4` 合入 = qa `65c4c28`）

- **101 用例：100 绿 / 1 红**。
- 已绿：A01–A07、B01–B14、C01–C05、D01–D09（新）、E01–E08（新）、F01–F07/F09–F14、F-R1–R8、G01–G08、H01–H09、I01–I09（含泄漏回归 7 条）。
- 余红（1 条，已 file:line 定位并报秘书处）：
  - F08：同月“财政 8,800 + 垫付 1,200”两段兑付，第二段被 `src/simulation/government/bonds.ts:672` 的 `makePayment` 幂等键 `(issuanceId,holdingId,tick,'principal')` 吞掉，`principalRepaid` 少记 1,200、持有人少收 1,200。需把出资来源纳入幂等键或合并为单次支付后一次入账。
- 真实样本（块3/4 后重测）：`Simulation.create()`（种子 20261101）+ 36 次 `tick()`，玩家无操作；仅岚港 t27 破产（t36 负债率 32.2%），垫付合计 485,295,713.34，24 期债券计划=成交 739,973 份（12 期破产兑付、12 期存续）。旧样本（岚港 t20/铁谷 t30、788,239,136.64）已作废，见矩阵 §1.6。
- 本轮同时修正 4 处验收脚本自身口径问题（B14 净额、D06 多商品、D07 收入 0 预算、D09 跨城待结算），非产品缺陷，详见矩阵 §1.6。

## 跑法

```bash
npx vitest run tests/acceptance                              # 验收全组（101 条）
npx vitest run tests/acceptance/migration-v7.test.ts         # H 组：存档迁移 v1–v7
npx vitest run tests/acceptance/settlement-resume.test.ts    # H08/H09：读档重放幂等
npx vitest run tests/acceptance/gdp-estimate.test.ts         # G 组：开局 GDP 估计
npx vitest run tests/acceptance/permissions.test.ts          # I 组：权限白名单与泄漏回归
npx vitest run tests/acceptance/bonds.test.ts                # B 组：债券
npx vitest run tests/acceptance/company-bond-subscription.test.ts  # C 组：企业购债
npx vitest run tests/acceptance/bankruptcy.test.ts           # F 组：破产/清算/分股（夹具）
npx vitest run tests/acceptance/bankruptcy-real-run.test.ts  # F 组：真实 36 月样本
npx vitest run tests/acceptance/baseline-a.test.ts           # A 组：36 月基线已知限制
npx vitest run tests/acceptance/household-consumption.test.ts # D 组：居民消费
npx vitest run tests/acceptance/household-loans.test.ts       # E 组：居民消费贷
```

## 约定

- 先红后绿：块落地后由验收员复跑到绿，再在 `docs/development/ACCEPTANCE_MATRIX_v1.md` 写状态与证据。
- 只用 `src/**` 的公开函数与 `GameStore`/`panels.ts` 渲染字符串，不做快照图片比对；桌面证据走 `artifacts/` 截图（脚本见矩阵 §4）。
- 时间口径：`world.time.tick` 从 0 起，开局估计月 tick 为 -12…-1。
