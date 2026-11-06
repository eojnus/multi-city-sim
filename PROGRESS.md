# PROGRESS — multi-city-sim v1.5 交接

> 新会话第一句：`Read /workspace/Coding/multi-city-sim/PROGRESS.md and git log -8, then continue from "Next".`
> 本文件是唯一可信状态；不要从旧对话记忆推断。不要在文件里写 token。

## Goal

v1.5 验收修复（6 项）：①非市长财政信息泄露；②债券无流动性时跨城迁移权益；③食品成交/覆盖率报告口径；
④AI 政策预算与资金执行衔接；⑤初始设备兼容入口；⑥构建/回归/完整测试/72 月对照/Electron/报告/推送。
验收：`tsc 0` + 分块全量测试全绿 + Electron 19/19 + 72 月与多 seed 数据 + 报告/版本 + 推送 feature 分支
（不合并 main、不改写历史）。

## Done（均已验证）

- **已交付并推送**：分支 `feature/stock-market-ui-tax`；基线 `a20f1cb7303a237c7499415b2b6862f32e53f24d`；
  **本地 HEAD = 远端 = `483c6fe2ea98e80291dd3b2244a2cd878255a7f1`**；`origin/main` 仍
  `6c45000efc4c406d30e22c0a12bd066fc2df61f7`；工作区干净；版本 `GAME_VERSION/package = 1.5.0`；
  `SAVE_FORMAT_VERSION = 9`（未变）。
- 本轮提交链（`a20f1cb..483c6fe`）：`85a8673` feat(v1.5) → `ea5b3c2` test(acceptance) →
  `1958a17` fix(v1.5) → `b6bda6e` test(acceptance) → `887aa93` docs(v1.5) → `483c6fe` docs。
- **§一 非市长财政权限**：`src/ui/panels.ts` AI 体检拆公开/受限（`ai-government` / `ai-checkup-restricted` /
  `fiscal-restricted`）；`src/app/gameStore.ts::policyView` 非市长 budget/spent/tracking 金额为 null、
  defaultBudget null、history 空；`src/simulation/policies/policies.ts` 5 处带金额日志加
  `visibility:{scope:'mayor'}`。测试 `tests/ui-fiscal-permission.test.ts` 15 项。
- **§二 债券无流动性迁移**：`src/simulation/investors/investors.ts` 迁移时按价值比例真实拆债券持债
  （0.01 份粒度、目标实体合并防碎片、不改兑付），`src/simulation/core/invariants.ts` 一处 0.01 容差。
  测试 `tests/investor-dividend-distribution.test.ts` 10 项（复现例：A 仅 10,000 债券、迁出 5,000，迁移者守恒）。
- **§三 食品口径**：`scripts/economy-v09-report.ts::cityFoodMetrics`：居民实际成交=Σ`group.lastMonth.basicSoldUnits`
  （含进口）/基本需要；新增 `HouseholdMonthlyStats.basicEffectiveUnits?`（`src/simulation/markets/consumer.ts` 落账）；
  `scripts/v14-seed-compare.ts` 同步。青原 t72 覆盖率由旧 23.2% 修正为 51.2%。测试
  `tests/food-report-coverage-v15.test.ts` 4 项。
- **§四 AI 政策资金**：`policies.ts` 新增 `preparePolicyFunding`/`finalizePolicyFunding`/`policyFundingMonthlyReport`；
  `PolicyState.fundingMonths`、`ActivePolicy.referenceBudget/reservedThisMonth/unpaidThisMonth/fundingSourceThisMonth`
  （`types.ts`）；tick 15b 顺序（`core/simulation.ts`）；先立项后融资（`deferFunding`）、按 `effects.aiCrisisPolicy`
  标记资助、公共岗位纳入、85% 借款上限/100% 破产/玩家市长边界不变；修复完成政策 `spent>budget` 存档校验 bug
  （总预算=参考×(monthsRemaining+1)）。测试 `tests/ai-policy-funding-v15.test.ts` 16 项 +
  `tests/ai-government-v14.test.ts` 35 项。
- **§五 初始设备兼容入口**：`src/simulation/companies/lifecycle/lifecycle.ts` 分发条件改为
  `!usesLegacyFoundingPath(request)`（plan 走 v1.0 实物出资；显式 capital 为旧语义且正常游戏不可达，已标注）。
  测试 `tests/founding-compat-v15.test.ts` 10 项。
- **验证证据**：
  - `npx tsc --noEmit` = 0；`npm run build` 成功。
  - 分块全量 130 个测试文件（12 文件/块，11 块）全部通过；首轮 3 类失败已闭环（chunk2 预算预期没跟上、
    chunk6 政策转移支付未落地居民群体、chunk11 crosscut 报告舍入/多种子超时），复跑 chunk1 12/107、
    chunk2 12/128、chunk6 12/103、chunk11 中 crosscut 10/10 + v13 多种子 4/4，均绿。
  - acceptance 终锁（36 月）：**无破产**（records 空）；t36 负债率 0.286466/0.414176/0.409088；债券 36 期
    计划=成交=3,014,448；持债 985；券息 1,041 笔；政府贷款 105 笔 active（未偿 593,130,865.77）；
    fundingMonths 24 月/城、unpaid=0；combined 7 套件 68/68。
  - 72 月默认 seed 20261101：t72 失业 91.8%/88.5%/90.6%，基本食品覆盖率 16.3%/10.9%/13.3%，
    负债率 46.3%/45.2%/66.5%，AI 政策每月真实借款/实支约 799.9 万（未达标记入报告，未改口径）。
  - 4 seed 36 月对照：均 exit 0/不变量 0/无破产；AI 实支约 2.07–2.10 亿/城；失业 78.4–93.8%；
    覆盖率 10.9–78.4%；负债率 28.5–53.5%。
  - Electron：`npm run build` 后 `DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox
    --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs` → **19/19、0 console 错误**；
    证据入仓 `docs/evidence_v1.5/`（report.json + 9 PNG）。
  - 与 v1.4 报告差异：受控实验在临时 worktree 检出 `3830894` 用同脚本/参数跑 72 月，**逐项复现 v1.4 报告数字**；
    差异来自提交 `0d6831a`（回退 `Simulation.create` 预写 openingShares），非脚本/参数/环境。
- 交付报告：`docs/development/DELIVERY_REPORT_v1.5.md`；README v1.5.0。

## Next（按序）

1. **等用户新任务书/验收反馈**；新会话先做基线确认：`git rev-parse HEAD origin/feature/stock-market-ui-tax
   origin/main`、`git status --short`、`npx tsc --noEmit`。
2. 若继续开发：新建任务时沿用本仓库约定——基线 SHA、分支不变、不 commit 由 owner 做（Lead 收口）、
   每步有命令验证；开工先 `git fetch`，确认远端无新提交。
3. 若需再次推送：需用户提供新 PAT（旧 PAT 已被要求撤销）。做法：仅作环境变量
   `GH_PUSH_TOKEN`，`git -c credential.helper='!f(){ echo username=x-access-token; echo "password=$GH_PUSH_TOKEN"; };f'
   -c http.version=HTTP/1.1 push origin feature/stock-market-ui-tax`，失败重试 3 次；推送后
   `git fetch` 核验本地=远端、main 未变，并提醒撤销 token。
4. 若继续修经济：优先看 `DELIVERY_REPORT_v1.5.md` §7 已知问题（高失业/食品覆盖低、AI 借款推高债务、
   债券按城基金份额共享、0.01 份尾差、capital 兼容路径不可达）。

## Open questions

- 用户是否接受 v1.5（§六 要求等待验收）；下一轮是否继续修宏观经济（当前失业 ~90%、覆盖率 10–16%）。
- 桌面权限检查使用显式身份夹具（生产构建 `setMayorDemo` 被 DEV 门禁禁用，直接设
  `world.player.roles.mayorCityId`），是否需要补“真实选举上任”的桌面路径。

## Key facts（环境与坑）

- 仓库 `/workspace/Coding/multi-city-sim`；node v24.22.1 / npm 11.19.1；**2 核 / ~2GB 容器**。
- 环境：`export HOME=/workspace/Coding/.home; export npm_config_cache=/workspace/Coding/.npm-cache`
  （root 的 `/root/.npm` 无权限）。
- 测试：`npx vitest run <files> --maxWorkers=1 --testTimeout=180000 --hookTimeout=1500000`；
  容器偶发 `[vitest-worker]: Timeout calling "onTaskUpdate"` → 进程 exit≠0 但断言全绿（不是产品失败，
  报告里如实说明）。分块脚本：12 文件/块（参考 `/tmp/run-v14-chunks.sh`，临时文件）。
- **`tsc` 不检查 `scripts/`**（不在 tsconfig）：报告脚本运行时错误（变量重名等）只能在 `npx tsx` 冒烟时发现；
  改脚本后必须 `npx tsx scripts/economy-v09-report.ts --months=3 --checkpoints=1,3` 冒烟。
- 报告/数据：72 月约 10–13 分钟（`scripts/economy-v09-report.ts --months=72 --checkpoints=1,6,12,24,36,72
  --seed=20261101`）；4 seed 36 月约 12–15 分钟（`scripts/v14-seed-compare.ts --months=36
  --seeds=20261101,20261102,777001,424242`）。
- 桌面：先 `npm run build`，再 `DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox
  --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs`；证据目录在脚本内
  `docs/evidence_v1.5/`（换版本要改脚本里的 evidence 路径）。
- Git：无 SSH 密钥、无 credential helper；不要 amend/rebase/force、不合并 main。
- 校验工作区干净后提交；commit 拆分参考：feat(sim) / test(acceptance) / docs。
- 历史 team 角色（本会话有，新会话默认没有，需要时重新 spawn）：gov-dev（政策/政府）、banking-dev（投资/银行）、
  pool-migration-dev（企业/设备/迁移）、ui-dev（UI）、consumption-dev（消费）、tests-dev（测试）、wages-dev（生产/工资）。
- 关键文件：`src/simulation/policies/policies.ts`、`policies/ai-labor.ts`、`government/{fiscal,bonds,debt,treasury}.ts`、
  `core/simulation.ts`（tick 顺序）、`contracts/types.ts`、`core/save.ts`、`markets/consumer.ts`、`investors/investors.ts`、
  `population/household-*.ts`、`companies/{lifecycle,founding}.ts`、`equipment/equipment.ts`、
  `src/ui/panels.ts`、`src/app/gameStore.ts`、`scripts/economy-v09-report.ts`。
- 已踩过的坑（不要重复）：① `settlePolicies` 在启动当月也执行一次 → 总预算必须 ×(months+1)（否则存档
  `spent>budget` 校验失败）；② 政策转移支付必须同时落地 `group.cash/income/benefits/netCashChange`，且
  `city.lastMonth.householdIncome` 只加政策实发、不能赋值为含退款的 `householdIncomeLastMonth`（会重复计退款）；
  ③ 报告脚本变量重名会让 tsx 运行时才报错；④ 桌面生产构建不能用 `setMayorDemo`（DEV 门禁）。
