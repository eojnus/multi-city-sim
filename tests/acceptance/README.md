# 验收测试（qa/acceptance 分支）

这些用例属于独立验收，全部由验收员维护；开发不要改这里的断言来“修绿”，要改实现后由验收员复跑核销。

## 本轮状态（第二轮，集成分支 @ ee1a949，含债券状态机）

- 59 用例：49 绿 / 10 红（首轮 35 条 + 新增 A 组 4、B 组 15、C 组 5）。
- 新增绿：A05–A07（36 月基线已知限制，归档数值自洽）、B01–B11/B13、C01–C05。
- 新增红：B12、B14 ×2 —— 兑付流水已记、财政已扣/垫付贷款已建，但**持有人现金未入账**（资金净额减少 11,200 / 10,666.67）。属实现缺口，等第二批月结或债券实现补齐后复跑。
- 红全部是“实现未落地”，不是缺陷回归：
  - G04 ×2：`pushRealGdpPoint`（块2）仍为空实现，真实月未入窗。
  - I01 ×2、I03：`buildPublicBondOffer` / `buildOwnBondHoldingViews`（块4）空实现。
  - I04：`buildMayorFiscalView`（块4）空实现。
  - I07a/I07c/I07d/I07e、I09：界面泄漏修复（块4）尚未落地，非市长仍能看到财政信息。

## 跑法

```bash
npx vitest run tests/acceptance            # 验收组
npx vitest run tests/acceptance/migration-v7.test.ts   # H 组：存档迁移
npx vitest run tests/acceptance/gdp-estimate.test.ts   # G 组：开局 GDP 估计
npx vitest run tests/acceptance/permissions.test.ts    # I 组：权限白名单与泄漏回归
npx vitest run tests/acceptance/bonds.test.ts          # B 组：债券
npx vitest run tests/acceptance/company-bond-subscription.test.ts  # C 组：企业购债
npx vitest run tests/acceptance/baseline-a.test.ts     # A 组：36 月基线已知限制
```

## 约定

- 先红后绿：块落地后由验收员复跑到绿，再在 `docs/development/ACCEPTANCE_MATRIX_v1.md` 写状态与证据。
- 只用 `src/**` 的公开函数与 `GameStore`/`panels.ts` 渲染字符串，不做快照图片比对；桌面证据走 `artifacts/` 截图。
- 时间口径：`world.time.tick` 从 0 起，开局估计月 tick 为 -12…-1。
