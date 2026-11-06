# PROGRESS — multi-city-sim v1.6 交接

> 新会话第一句：`Read /workspace/Coding/multi-city-sim/PROGRESS.md and git log -8, then continue from "Next".`
> 本文件是唯一可信状态；不要从旧对话记忆推断。不要在文件里写 token。

## Goal

v1.6（按用户 2026-11-06 任务书）：①修复 v1.5 验收遗留（AI 政策月预算合计额度、公共岗位
人数/人次统计、债券迁移微小权益）；②商品价格短缺快涨/进口计入需求/向基础价回归/可配置；
③企业竞争、生产、招聘；④设备月度维护费 = 新设备市场价 1%；⑤僵尸企业退出；⑥既有规则保持。
验收：tsc 0 + 构建成功 + 全量测试全绿 + 72 月默认种子 + 3 个对照种子 + Electron 实机核查 +
交付报告 + 推送功能分支（不合并 main、不改写历史）。

## Done（均已验证）

- 分支 `feature/stock-market-ui-tax`；用户验收基线 `483c6fe2ea98e80291dd3b2244a2cd878255a7f1`；
  开工时本地/远端 HEAD `f483f609599771663de3e8311aaf1bd608edc707`（基线之后的交接文档提交，
  已在其上继续）；`origin/main` 仍 `6c45000efc4c406d30e22c0a12bd066fc2df61f7`。
- 版本 `GAME_VERSION/package = 1.6.0`；`SAVE_FORMAT_VERSION = 9`（未升版，新增字段全部 optional）。
- 本轮提交链（在 `f483f60` 之上）：见本文件末尾“提交/推送”；工作区在交付时应干净。
- **§一.1 AI 政策月预算**：`policies.ts` 以当月体检 `budget` 为 quota，对当月全部在行 AI 危机政策
  按参考需求权重最大余数分配（Σ分项 ≤ quota，修复两项政策各拿满 2× 的问题）；`fundingMonths`
  新增 `quota/policyBudgets/publicWagesAttributed/publicWagesOverQuota`；claim/reserved/unpaid
  按分项封顶；公共工资按 `fiscal.publicWages` 实付归属。测试 `tests/policy-budget-v16.test.ts` 13 项。
- **§一.2 公共岗位统计**：`PolicyState.publicJobsMonths`（jobsAdded/headcount/jobsRemoved/wagesPaid
  + 累计岗位/累计人次分开）；报告覆盖 active+history，真实岗位不再恒 0。同日测试内覆盖。
- **§一.3 债券迁移尾差**：`investors.ts` 份数 = 本金/面额内部全精度（面额 1000 时 1 分 = 1e-5 份），
  4 信用点可迁移；`invariants.ts` 容差不变（仅注释）。测试 `tests/bond-migration-tail-v16.test.ts` 5 项。
- **§二 商品价格**：`markets.ts` 缺口只用 `unmetDemand`（已被跨城进口冲销）；`config.market` 新增
  `shortageRiseSpeed=0.3 / surplusFallSpeed=0.12 / competitionFallSpeed=0.08 / reversionSpeed=0.03 /
  maxMonthlyChange=0.15 / costAnchorFactor=1 / costAnchorMaxFactor=1.6`；锚价 = 上月单位生产成本
  中位数 clamp [基础价, 1.6×基础价]；过剩用“本地成交+进口”覆盖量；无需求不涨。测试
  `tests/price-v16.test.ts` 14 项（含“需求 100/本地 60/进口 40 不涨”）。
- **§三 竞争/生产/招聘**：新增 `companies/pricing.ts`（报价内部 6 位精度、至少 1 分可见变动、
  对手让价、单位成本×(1+3%) 底线）、`companies/cost.ts`（维护费/固定成本/单位成本接入 AI）；
  `production-plan.ts` 可触达需求份额（缺货+资金缺口 5%+降价机会 5%+跨城×0.5）、需求驱动增产
  （盈利+缺货+利用率<80% 用现有设备并招工）；`planning.ts` 卖多余设备（初始设备锁定期整段不卖）；
  `founding.ts` 防羊群。测试 `tests/competition-v16.test.ts` 8 项。
- **§四 设备维护费**：新增 `equipment/maintenance.ts`；tick 开头快照 `company.maintenanceBase/
  maintenancePrices`（D1：月初持有 + 月初价；当月买入下月计费、当月卖出/挂单/破产仍计当月）；
  每类 = 台数 × 月初新机参考单价 × 1%；应计全额进 `preTaxProfit`、现金支付进 `operatingCashFlow`；
  收款方为模拟范围外服务商（`world.equipmentMarket.maintenanceMonth/maintenanceHistory` 独立流水，
  不进设备厂收入/政府税收）；现金不足先真实融资、不足记 `maintenanceArrears`（欠费不得分红、
  不再以贷养欠、清算记坏账）；面板显示台数/单价/费率/维护费/状态。测试
  `tests/equipment-maintenance-v16.test.ts` 16 项。
- **§五 僵尸企业**：删除 `checkBankruptcies` 的 `wage<=0 continue` 漏洞；`CompanyAiState.idleMonths`
  （读 previousMonth、保护期清零、有经营即清零）；`idleExitMonths=6` + 现金+授信 < 1 月固定成本
  （工资+维护费+偿债）且无恢复计划 → 复用 `liquidateCompany`。测试 `tests/zombie-exit-v16.test.ts` 7 项。
- **§六 存档容量**：15 个月世界实测 12.09MB，旧 8MB 上限导致桌面存档失败；`src/platform/saveBridge.ts`
  与 `electron/saveIpc.ts` 上限统一 64MB。
- **集成期修复**：①维护费月度流水“月末欠付”改为“月初存量 + 本月增量”（旧实现跨月清算会扣成负数，
  72 月实测 -2,839），`tests/v16-crosscut.test.ts` 12 月逐月对账；②v14 守恒测试因“锁定期内卖设备”
  回归 → 锁定期整段不卖（pool-dev）；③v15 权限测试因公司现金与受限值偶然同值误报 → 只扫政府区块；
  ④v11 旧档测试允许“真实出售/挂单”导致的设备减少；⑤inventory-cogs/production-feedback 利润恒等式
  补维护费项；⑥acceptance 36 月轨迹按 v1.6 重锁。
- **验证证据**：
  - `npx tsc --noEmit` = 0（含 tests）；`npx tsc -p tsconfig.electron.json --noEmit` = 0；
    `npm run build` 成功。
  - 新增 7 个 v1.6 测试文件：价格 14 / 维护费 16 / 政策 13 / 债券 5 / 竞争 8 / 僵尸 7 / 横切 3 = 66 项全绿。
  - 全量回归：136 个测试文件分 11 块（12 文件/块）执行；块 1（含重锁后 acceptance 9/9）、块 2
    （settlement-resume H08 单跑 13/13 绿）、块 3/5/7/10 全绿、块 6/8/9 断言全绿（仅容器
    `onTaskUpdate` RPC 噪声 exit≠0）、块 11/12 全绿；块 4 用 `--testTimeout=900000` 重跑
    （economy-stability 120 月测试约 16 分钟，默认 180s 会超时；属容器性能边界，不是断言失败）。
  - 72 月默认 seed 20261101：t72 失业 93.4%/84.7%/87.4%，基本食品覆盖率 24.2%/22.2%/30.0%，
    食品价 79.64/85.27/77.28（基础 55，成本锚上限 88），负债率 78.5%(high)/50.6%/60.9%(watch)，
    设备维护费 40.0/60.0/31.2 万/月，AI 政策 quota 600 万 = 分项 300+300 万、实支 499.9 万，
    公共岗位在岗 476 人/实发 199.9 万/月。完整 checkpoint 数据见交付报告第 7 节。
  - 3 对照种子 36 月（20261102/777001/424242）：均 exit 0、不变量 0、无破产；失业 82.0–90.1%、
    食品覆盖率 14.5–38.7%、负债率 23.4–42.7%；运行时长 123.9s / 172.6s / 168.1s。
  - Electron（生产构建 + Xvfb :99，Electron 38.8.6）：**24/24 检查通过、0 console 错误**；证据
    `docs/evidence_v1.6/`（report.json + 9 PNG）；含 14 个月真实 tick 后的价格规则、维护费
    结算/面板、政策额度分项、公共岗位、存读档（维护费快照/欠费/政策额度）检查。
  - 交付报告：`docs/development/DELIVERY_REPORT_v1.6.md`；README v1.6.0。

## Next（按序）

1. **等用户验收/推送**：本地提交已完成；**推送需要用户提供新 PAT**（旧 PAT 已按要求撤销；仓库无
   SSH key、无 credential helper）。做法：仅作环境变量 `GH_PUSH_TOKEN`：
   `git -c credential.helper='!f(){ echo username=x-access-token; echo "password=$GH_PUSH_TOKEN"; };f'
   -c http.version=HTTP/1.1 push origin feature/stock-market-ui-tax`，失败重试 3 次；推送后
   `git fetch` 核验本地=远端、main 未变，并提醒撤销 token。
2. 新会话先做基线确认：`git rev-parse HEAD origin/feature/stock-market-ui-tax origin/main`、
   `git status --short`、`npx tsc --noEmit`。
3. 若继续开发：沿用仓库约定——基线 SHA、分支不变、不 amend/rebase/force、不合并 main、
   每步有命令验证；开工先 `git fetch` 确认远端无新提交。
4. 若继续修经济：优先看交付报告 §9（高失业/食品覆盖低、债务率上升、行业集中 agriculture、
   idle 但现金充足企业占名额、食品价高于基础价、公共岗位规模小）。

## Open questions

- 用户是否接受 v1.6；下一轮是否继续修宏观经济（当前失业 ~85–93%、基本食品覆盖 19–30%）。
- “长期无经营但现金/授信充足”的企业是否也应强制退出（当前 D6 只清算“无恢复能力”的僵尸企业）。
- 食品价格高于基础价（成本锚达 1.6× 上限）是否符合预期，是否要放开/收紧成本锚上限。

## Key facts（环境与坑）

- 仓库 `/workspace/Coding/multi-city-sim`；node v24.22.1 / npm 11.19.1；**2 核 / ~2GB 容器**。
- 环境：`export HOME=/workspace/Coding/.home; export npm_config_cache=/workspace/Coding/.npm-cache`
  （root 的 `/root/.npm` 无权限）。
- 测试：`npx vitest run <files> --maxWorkers=1 --testTimeout=180000 --hookTimeout=1500000`；
  大世界（企业数接近 160/城）单月 tick 2–5 秒：`tests/economy-stability.test.ts`（16+120+40 月）
  需 `--testTimeout=900000`（120 月测试自带 1,200s 超时，实测约 978s）；容器偶发
  `[vitest-worker]: Timeout calling "onTaskUpdate"` → exit≠0 但断言全绿（不是产品失败）。
  分块脚本参考 `/tmp/run-v16-chunks.sh`（临时文件，12 文件/块）。
- **`tsc` 不检查 `scripts/`**（不在 tsconfig）：改报告脚本后必须
  `npx tsx scripts/economy-v09-report.ts --months=3 --checkpoints=1,3` 冒烟。
- 报告/数据：72 月约 10–13 分钟（`scripts/economy-v09-report.ts --months=72
  --checkpoints=1,6,12,24,36,72 --seed=20261101`）；3 个对照种子 36 月约 2–3 分钟/种子
  （`scripts/v14-seed-compare.ts --months=36 --seeds=20261102,777001,424242`）。
- 桌面：先 `npm run build`，再 `DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox
  --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs`；证据目录
  `docs/evidence_v1.6/`（换版本要改脚本内路径）。Xvfb 需先启动。
- 存档：`formatVersion 9` 不升版，新增字段全部 optional；桌面存档大小上限 64MB（15 月实测 12.09MB）。
- Git：无 SSH 密钥、无 credential helper；不要 amend/rebase/force、不合并 main。
- 关键文件：`src/simulation/markets/markets.ts`（价格）、`policies/policies.ts`（额度/公共岗位）、
  `equipment/maintenance.ts`（维护费）、`companies/{pricing,cost,production-plan,planning,founding}.ts`、
  `companies/lifecycle/lifecycle.ts`（退出）、`investors/investors.ts`（债券迁移）、
  `core/{simulation,save,invariants}.ts`、`data/config.ts`、`contracts/types.ts`、`ui/panels.ts`、
  `scripts/economy-v09-report.ts`、`scripts/acceptance-v09.cjs`。
- 已踩过的坑（不要重复）：①设备维护费“月末欠付”必须按“月初存量+本月增量”，否则跨月清算出现负数；
  ②初始设备锁定期内 AI 不得出售该行业设备（v14 守恒测试比“锁定台数”更严）；
  ③v15 权限测试的受限金额可能与企业现金偶然同值，检查范围要限定在政府区块；
  ④旧档测试允许真实出售/挂单导致的设备减少（不是重算抹掉）；
  ⑤利润恒等式（inventory-cogs/production-feedback）必须含 `maintenanceDue`；
  ⑥acceptance 36 月轨迹在规则变更后需要按真实 v1.6 序列重锁（不要只改一两个断言）。

## 提交/推送（本轮）

- 本轮提交链（在 `f483f609599771663de3e8311aaf1bd608edc707` 之上）：
  - `b2064d7` feat(v1.6)：规则与产品代码（价格/竞争/维护费/退出/政策额度/存档上限/报告脚本）
  - `aa0ea0a` test(v1.6)：7 个新测试 + acceptance 重锁 + 兼容回归修复 + 桌面验收脚本
  - `35cb76d` docs(v1.6)：交付报告、README 1.6.0、PLAN、桌面证据（24/24）
  - 另有一次“SHA 回填”docs 提交（HEAD，见 `git log -1`）
- 本地 HEAD = 上述回填提交；**截至本文件提交时未推送**（无 SSH key / 无 credential helper /
  旧 PAT 已撤销）。`origin/feature/stock-market-ui-tax` 仍 `f483f60`，`origin/main` 仍 `6c45000`。
- 推送步骤见“Next 1”；推送后把远端 SHA 回填到本文件与交付报告 10.3。
