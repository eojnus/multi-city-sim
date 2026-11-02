# 验收测试（qa/acceptance 分支）

这些用例属于独立验收，全部由验收员维护；开发不要改这里的断言来“修绿”，要改实现后由验收员复跑核销。

## 本轮状态（第四轮，集成 `1d138a6` / 文档 tip `7000db0`，merge `f8af0ed`）

- 84 用例：**80 绿 / 4 红**。
- 已绿：A05–A07、B01–B11/B13、C01–C05、F01–F07/F09–F14、F-R1–R8（真实 36 月破产样本）、G01–G08、H01–H09、I01–I09（含泄漏回归 7 条）。
- 余红（全部为已定位实现缺陷，已报秘书处）：
  - B12、B14 ×2：债券兑付只写流水/扣财政/建垫付贷款，**未把款项记入持有人现金**（货币净额凭空减少）；块1/块2 均未修，等 sim 修 `creditOwnerCash` 后复跑。
  - F08：同月“财政 8800 + 垫付 1200”两段兑付，第二段被 `makePayment` 幂等键 `(issuanceId,holdingId,tick,'principal')` 吞掉，`issuance.principalRepaid` 少记 1200。
- 真实样本：`Simulation.create()`（种子 20261101）+ 36 次 `tick()`，玩家无操作；岚港 t20、铁谷 t30 破产，垫付合计 788,239,136.64，24 期债券 100% 成交且全部破产兑付（见矩阵 §1.5）。

## 跑法

```bash
npx vitest run tests/acceptance                              # 验收全组（84 条）
npx vitest run tests/acceptance/migration-v7.test.ts         # H 组：存档迁移 v1–v7
npx vitest run tests/acceptance/settlement-resume.test.ts    # H08/H09：读档重放幂等
npx vitest run tests/acceptance/gdp-estimate.test.ts         # G 组：开局 GDP 估计
npx vitest run tests/acceptance/permissions.test.ts          # I 组：权限白名单与泄漏回归
npx vitest run tests/acceptance/bonds.test.ts                # B 组：债券
npx vitest run tests/acceptance/company-bond-subscription.test.ts  # C 组：企业购债
npx vitest run tests/acceptance/bankruptcy.test.ts           # F 组：破产/清算/分股（夹具）
npx vitest run tests/acceptance/bankruptcy-real-run.test.ts  # F 组：真实 36 月样本
npx vitest run tests/acceptance/baseline-a.test.ts           # A 组：36 月基线已知限制
```

## 约定

- 先红后绿：块落地后由验收员复跑到绿，再在 `docs/development/ACCEPTANCE_MATRIX_v1.md` 写状态与证据。
- 只用 `src/**` 的公开函数与 `GameStore`/`panels.ts` 渲染字符串，不做快照图片比对；桌面证据走 `artifacts/` 截图（脚本见矩阵 §4）。
- 时间口径：`world.time.tick` 从 0 起，开局估计月 tick 为 -12…-1。
