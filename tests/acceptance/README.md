# 验收测试（qa/acceptance 分支）

这些用例属于独立验收，全部由验收员维护；开发不要改这里的断言来“修绿”，要改实现后由验收员复跑核销。

## 本轮状态（首轮，基线 feature/arch-foundation @ 18e2617）

- 35 用例：25 绿 / 10 红。
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
```

## 约定

- 先红后绿：块落地后由验收员复跑到绿，再在 `docs/development/ACCEPTANCE_MATRIX_v1.md` 写状态与证据。
- 只用 `src/**` 的公开函数与 `GameStore`/`panels.ts` 渲染字符串，不做快照图片比对；桌面证据走 `artifacts/` 截图。
- 时间口径：`world.time.tick` 从 0 起，开局估计月 tick 为 -12…-1。
