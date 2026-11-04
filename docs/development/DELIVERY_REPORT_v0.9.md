# v0.9 交付报告（第二轮验收修复）：经济循环完善 + 验收 7 项

日期：2026-11-04（第二轮）
分支：`feature/stock-market-ui-tax`（基线 `3d714c6`；第一轮 v0.9 交付到 `f942cc9`，本轮在其上追加修复，未合并/未改写 main）
存档格式：v9 ｜ 版本号：0.9.0

## 0. 结论摘要

- **第一轮 v0.9 被验收驳回的 7 项已逐条处理**（见第 3 节）：居民消费资金顺序、消费公平性（本地优先/跨城补缺口）、二手设备撤单产能、设备补贴原子性、旧存档设备迁移、跨城设备购买、72 月报告口径。
- **新增/更新测试**：消费资金顺序与公平性、设备市场/补贴/跨城/迁移、破产序列重锁等；`npx vitest run --maxWorkers=1 --testTimeout=60000` → **89 文件 / 700 项全部通过**（修复后重跑，见第 5 节）。`npx tsc --noEmit` 0 错误，`npm run build` 通过。
- **72 月固定条件（种子 20261101、玩家无操作、默认 AI）仍然深度衰退**：三城失业率 98.7%–98.9%、居民消费 0（青原 18 元）、月 GDP 2100.0/1683.0/966.8 万；**三城在 72 月内分别历史破产 5/6/5 次**（t72 当前均 solvent），企业 19 家、设备 37 台、创办 22/倒闭 20。本轮**没有隐藏衰退、没有伪造成交、没有取消破产**。
- **本轮把“为什么”进一步坐实**（第 7 节）：消费归零是**食品供给链断裂**而非居民没钱（t72 居民现金 26.72/25.72/18.57 亿、存款 11.31/8.23/6.50 亿）；直接机制是“工资预留吃掉采购预算 → 原料买不到 → 食品产量归零 → 销量与计划互相压低”，叠加**资本品（设备）缺乏可被创业评分看见的需求信号**，72 个月内没有设备制造企业出现。
- **需要用户决策的冲突已单列**（第 9 节）：人口 ×5 与私营岗位/产能不能同步放大、生产计划以销量为锚看不到未满足需求、初始流动资金 1.6 个月工资、创业启动资本 1400 万–1.08 亿——这些属于任务书明确写死的规则或数值，本轮未擅自更改，只在报告里给出证据与建议。

## 1. 分支、基线与环境

- 仓库：`https://github.com/eojnus/multi-city-sim`
- 分支：`feature/stock-market-ui-tax`（v0.8.3 → v0.9 第一轮 `f942cc9` → 本轮修复）
- 基线：第一轮验收基线 `f942cc9ff9014ba882e95c322e28c5be54938fb4`；原始功能基线 `3d714c6`
- 环境：Node v26.13.0 / npm 11.20.0、TypeScript 5.9.3、Phaser 3.90.0、Electron 38.8.6、Vite 7.3.7、Vitest 3.2.7；Linux + Xvfb（1600×1000，`DISPLAY=:99`），Electron 以 `--no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader` 运行。
- 运行约束：本机内存约 2GB，Vitest 必须 `--maxWorkers=1 --testTimeout=60000`；`vite.config.ts` 已同步 testTimeout/hookTimeout 30s。

## 2. 技能（名称与来源）

| 技能 | 来源 | 本轮用途 |
| --- | --- | --- |
| find-skills | vercel-labs/skills | 检索并确认技能来源 |
| systematic-debugging | obra/superpowers | 消费顺序/设备撤单/补贴副作用/迁移不一致的定位流程 |
| diagnosing-bugs | mattpocock/skills | 食品链断裂与计划死锁的逐月诊断 |
| thinking-systems | tjboudreaux/cc-thinking-skills | 把“工资—采购—产量—销量—裁员—需求”作为反馈回路分析 |
| data-analysis | claude-office-skills/skills | 72 月报告口径与对照表整理 |
| game-ui-ux | gamedev-skills | 设备/计划面板与人口“需求 vs 成交”信息层级 |
| frontend-design | anthropics/skills | 面板排版与可读性 |
| web-design-guidelines | vercel-labs/agent-skills | 桌面走查（横向溢出、标签可点性） |
| improve-codebase-architecture | obra/superpowers | 设备/生产计划/创业模块拆分与消费两阶段调度 |
| typescript-advanced-types | wshobson/agents | 存档迁移余量、可选字段与 MarketState 扩展的类型约束 |
| verification-before-completion | obra/superpowers | 交付前“先跑再报”，不凭测试全绿宣布经济稳定 |

## 3. 验收 7 项逐条对照

### 3.1 居民消费资金顺序（问题一）

- 复现：默认开局第 1 月岚港非劳动群体消费贷约 1350.6 万，月末仍有约 2587.7 万现金与 2035.2 万存款。
- 修复（`src/simulation/markets/consumer.ts`）：预算（收入×80% + 现金×5%）只作为**有效需求缩放口径**，不再等同支付上限；支付顺序改为：
  1. 可用现金（含预算段与“非贷款资金段”的闲置现金）；
  2. 存款提取（单月 ≤ 月初存款 5%，`withdrawHouseholdDeposit` 封顶余额）；
  3. 仍不足才申请消费贷，**贷款额 = 实际成交额中的资金缺口**（现金 + 存款之后的部分），失败原子回滚（`captureStagedSales`/`restoreStagedSales`）。
- 真实世界第 1 月岚港非劳动群体：成交 2495.5 万 = 现金 1663 万 + 存款提取 101.76 万 + 消费贷 730.2 万；现金/存款/贷款逐项核对见 `tests/consumer-funding-order.test.ts`。
- 测试：`tests/consumer-funding-order.test.ts` 4 项（现金充足不借贷、现金不足用存款、现金+存款不足才贷款、有额度无供给不产生债务/无副作用）；`consumer.ts` 顶部文档写明“预算是需求缩放口径，不是资金硬上限”。

### 3.2 消费公平性：本地优先、跨城补缺口（问题六的机制修复）

- 复现：默认开局 T=4，岚港 food 有本地供给（1.91M）但本地 `sold=0`、`unmetDemand=3.10M`，同时岚港食品厂 `exported=1.91M`——青原/铁谷居民按城市 id 顺序先跨城买空了岚港库存，岚港本地居民最后无货。
- 修复：`runConsumerMarkets(world, ledgersByCity, config)` 两阶段——**阶段 A 所有城市先本地成交**（现金预算 → 闲置现金 + 存款提取额度 → 提款，不放贷）；**阶段 B 再按城市顺序处理跨城缺口**（按当前真实 `offeredStock` 重新报价、部分成交、剩余记 `unmetDemand`，现金→存款→贷款顺序，贷款段原子回滚并截断 `pendingSales`/`tradeFlows`）。`runConsumerMarket` 保留为单城兼容包装，`simulation.ts` 只改消费调度。
- 测试：`tests/consumer-fairness.test.ts` 4 项（本地优先剩余才出口、本地无供给时跨城且现金/存款/贷款账目闭合、部分成交不透支、跨城后存读档不变）。

### 3.3 二手设备撤单与产能同步（问题二）

- 修复：`cancelUsedEquipmentOffer(world, companyId, offerId, config)` 返还设备后立即 `recomputeCompanyCapacity`（gameStore 调用同步传参，删除外部手动重算）；挂单、部分成交、撤单、清算、存读档路径统一。
- **独立一致性检查**：`core/invariants.ts` 的 `checkEquipment` 不再只比较 `capacity` 与 `equipmentCapacity` 两个缓存，而是按“整数台数 × 每台产能 × 城市技术系数 + `equipmentCapacityRemainder`”独立推导，与 `equipmentCapacity` 比对（>0.01 报错），并校验 `baseCapacity ∈ [0, capacity]`、余量 < 单台产能；`checkInvariants` 增加 config 参数（`simulation.ts` 的 validate/tick 传入）。
- 测试：`tests/equipment-market.test.ts` 覆盖“挂 2 台 → 部分成交 1 台 → 撤单 1 台 → 存读档往返”后设备/产能/上限一致，篡改缓存可被独立检查报出。

### 3.4 设备补贴与购买原子一致（问题三）

- 复现：无供应时 `expandCompanyCapacity` 返回购买失败，但补贴已到账（企业 +95,000、财政 −95,000）。
- 修复（`src/simulation/companies/lifecycle/lifecycle.ts`）：改为 **plan → 按实际成交额结算补贴 → execute**；规划阶段只计算可买数量与预算，成交后按实际台数与金额结算补贴，失败/缩量不产生任何副作用；补贴上限 = min(政策剩余预算, 财政可用, 实际成交额 × 补贴率)；预算公式 `min(cash + subsidyCapacity, subsidyCapacity / rate, cash / (1 − rate) − 0.01)`；缩量/失败 `refundEquipmentSubsidy` 原路退回财政与 `policy.spent`/`city.lastMonth.policySpending`。
- 测试：`tests/equipment-subsidy.test.ts` 7 项（无供应、资金不足、部分成交、政府储备卖方、企业卖方、预算封顶、规划后库存变化导致整体失败时资金/财政/库存/设备/账本零副作用）。

### 3.5 旧存档设备迁移（问题四）

- 复现：旧档按整台设备取整反推，却保留旧 `capacity` 数值，导致设备推导产能与缓存不一致，后续重算突变。
- 修复：
  - 新开局/迁移统一“设备为准”：`capacity = 整数台数 × 每台产能 × 城市技术系数 + equipmentCapacityRemainder`；
  - `Company.equipmentCapacityRemainder` 显式存储旧档余量（v8→v9 用 `floor(capacity / 每台产能)` 映射设备，余量 = 旧 capacity − 台数 × 每台产能 × 技术系数），余量不随设备买卖转移、随企业清算消失；
  - 初始器按整数台数反推后令 `baseCapacity/maxCapacity` 与新产能一致；
  - `validateCompany` 校验余量非负有限，独立不变量校验余量 < 单台产能。
- 测试：`tests/migration-v9.test.ts` 5 项（v8 映射与日志、余量往返、真实购买后存读档、迁移→tick→购买→再往返稳定，`checkInvariants` 均为空）；`SAVE_FORMAT_VERSION` 保持 **9**（第一轮未发布，余量字段直接并入 v9 布局）。

### 3.6 跨城设备购买与创业设备口径（问题六设备部分）

- `buyNewEquipment` 拆为 `planNewEquipmentPurchase`（同城企业 → 政府储备 → 跨城按单价升序，默认允许跨城）→ `executeNewEquipmentPlan`（先整体校验卖方与库存，再原子转移）；跨城复用既有 intercity 模型：卖方库存减、写 `transport.pendingSales`（月末按运力结算、容量损失退回买方）、买方城市 ledger `intercityImported/demand`、`TradeFlow.path='intercityPurchase'`，失败无副作用。
- `founding.ts` 的 `availableEquipment` 与实际采购同源（`newEquipmentSupply`：本地 + 政府 + 跨城），评估与成交口径一致；评分维度未动。
- 测试：`tests/equipment-intercity.test.ts` 3 项（跨城真实付款出库 + 运输记录 + 月末结算资金守恒、同城优先、创业评估 units == 实际购买 units）。

### 3.7 72 月报告修复（问题五）

`scripts/economy-v09-report.ts`：

1. **政府历史破产次数**：改用 `city.government.records`（破产历史）并列出 tick，而非只看观察时刻的 `bankruptcy.status`；同时标注记录上限 8 条与截断情况。
2. **居民存款按城市汇总**：按本城群体 id 过滤存款账户，不再把全世界存款重复写到每座城市。
3. **保留窗口与统计口径**：财政流水标注“窗口累计 N 条、起始 tick、ledgerLimit 800、是否截断”；税收标注 12 月窗口（`config.tax.historyMonths`）；破产记录上限 8；企业创办/倒闭上限 60；明确“贷款合同全量保留，principal 合计即全期累计”。
4. **区分“有预算但缺货”与“资金不足”**：消费四层输出（成交 / 期望 / 有本地供给但资金不足 / 预算缩量未形成购买 / 有预算但缺货 / 消费贷支持 / 本月发放 / 存款提取）。其中“有本地供给但资金不足”= `unmetFunding`，“有预算但缺货”= 有效需求内 `unmetDemand × 市价`（下限估算）。
5. **重写交付报告**：删除“分母缩小使债务率下降”等方向不符的表述；t72 负债率 38.4%/59.6%/36.1% 是**在 72 月内发生 5/6/5 次破产、债务被勾销与重发之后的当前值**，与 t36 的 55.9%/94.5%/9.9% 不可直接比较（第 7 节给出逐月证据）。
6. **设备商品账本**：`buyNewEquipment` 的成交不再直写 `city.market`（会被 `finalizeMarkets` 覆盖而丢失），改为写 `EquipmentMarketState.pendingLedger`，由 `createWorldLedgers` 合并（`supply += sold`，`sold ≤ supply`）后清空；初始器补空数组，存档校验可选字段兼容旧档。

## 4. 主要新增/修改文件（本轮）

新增：

- `tests/consumer-fairness.test.ts`、`tests/consumer-funding-order.test.ts`、`tests/equipment-subsidy.test.ts`、`tests/equipment-intercity.test.ts`

修改（主要）：

- 消费/人口：`src/simulation/markets/consumer.ts`（支付顺序 + 两阶段 `runConsumerMarkets`）、`src/simulation/core/simulation.ts`（消费调度、贸易合同顺序）
- 设备：`src/simulation/equipment/equipment.ts`（plan/execute、跨城、撤单重算、pendingLedger、余量、政府供应计入 supply）、`src/simulation/markets/intercity.ts`
- 企业/生命周期：`src/simulation/companies/lifecycle/lifecycle.ts`（补贴原子性、购设备计划）、`src/simulation/companies/founding.ts`（设备来源口径）、`src/simulation/companies/production-plan.ts`（首月零销量污染修复）
- 核心：`src/simulation/core/initializer.ts`（设备为准）、`save.ts`（v9 余量、校验）、`invariants.ts`（独立产能推导）、`contracts/types.ts`（`equipmentCapacityRemainder`、`EquipmentMarketState.pendingLedger`）
- 报告/验收：`scripts/economy-v09-report.ts`、`scripts/acceptance-v09.cjs`

## 5. 测试与验证（实际执行）

```bash
npx tsc --noEmit
npm run build
npx vitest run --maxWorkers=1 --testTimeout=60000
npx tsx scripts/economy-v09-report.ts --months=72
node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs
```

- `tsc`：0 错误。
- `npm run build`：通过（renderer + electron）。
- Vitest：**89 文件 / 700 项全部通过**（含重锁后的破产序列与 transport 断言）。
- 72 月报告：exit 0，输出见第 7 节。
- 桌面验收：**12/12 通过、0 控制台错误**，证据 `docs/evidence_v0.9/`（本轮代码重跑）。

本轮测试口径变化（均为规则/机制变化导致的预期值或构造变化，未删除守恒/结构断言）：

- `tests/acceptance/bankruptcy-real-run.test.ts`：按修复后的 36 月确定性序列重锁——破产 tick 岚港 `[17,29]`、铁谷 `[15,27]`、青原 `[15,34]`；t19 比率 0.103191/0.285289/0.314935（均 normal）；t36 岚港 0.558868 watch、铁谷 0.944946 high、青原 0.099426 normal；债券 61 期（计划 2,122,664 = 成交 1,571,501 + 未售 551,163）；持债 187（active 24 / redeemed 163）；兑付流水 163 笔（逐次 22/8/26/9/69/29，与各 record 本金/利息/勾销逐项一致）。保留“兑付=银行垫付”“勾销=记录金额”“债券计划=成交+未售”“持有人分类合计”“无 active 孤儿债权”等守恒断言。
- `tests/economy-stability.test.ts`：transport 断言改为“40 个月内记录到的最大 capacity/maintenancePaid > 0”（实测 maxCapacity 3,600,000、maxMaintenancePaid 13,950；t40 三城破产后 corridors 为空，末态 0 属真实状态）。
- `tests/acceptance/household-consumption.test.ts` AC-D04/D05：消费上限改为“现金 + 存款提取 + 贷款”；`tests/consumer-loan-atomicity.test.ts` 末例改为清空所有城市消费品库存（两阶段语义下 B 阶段会跨城用消费贷）；`tests/acceptance/household-loans.test.ts` AC-E04/E08 供给放大到 20,000,000（阶段 A 先消耗本地库存）；`tests/household-savings-withdrawal.test.ts` 首例放宽到 |spend−budget| ≤ 0.05（0.01 网格舍入）；`tests/households.test.ts` 净现金流加入 Σ`depositWithdrawn`。
- 第一轮已有的修复仍保留：`government-equity` 财政增量 790,000、`company-ai` 的 `maxCapacity` 同步、`production-plan` 维护下限受设备上限约束、I11c/I11d 城市名限定、I10e 无 solvent 城市时构造视图。

## 6. 桌面走查（真实 Electron）

命令：

```bash
node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs
```

结果：**12/12 通过、0 条控制台错误**（`docs/evidence_v0.9/report.json`）。检查项：

1. 启动、三城、首次推进；
2. 人口 ×5 与 20% / 80% 结构、就业/失业/非劳动互斥；
3. 人口「需求 vs 成交」：第 1 月岚港需求 9.94 亿、实际成交 3.47 亿、有预算但缺货等分项；
4. 企业「经营」设备表 + 生产计划（计划/实际/设备上限/劳动上限/计划依据），并构造玩家经营以验证权限；
5. 玩家在界面购买 1 台能源设备（政府储备、目录价扣款、财政同额入账、产能同步）；
6. 玩家从岚港食品厂挂 2 台工业设备二手（used-1，单价 130,000）；
7. 另一家玩家经营企业买下这 2 台二手设备（资金/设备/产能同步，委托清空）；
8. 股票窗口回归（打开、行数据、关闭）；
9. 存档→读档：现金、股份、持债、设备、市场委托与读档前一致；
10. 1100×700 窗口无横向溢出；城市 6 标签/企业 5 标签可点；
11. 关闭企业后回到城市面板；
12. 零控制台错误（应用内 console 拦截）。

证据（`docs/evidence_v0.9/`）：`v09-01-population-demand-trade.png`、`v09-02-company-equipment.png`、`v09-03-equipment-buy.png`、`v09-04-used-market.png`、`v09-05-buy-used.png`、`v09-06-stock-regression.png`、`v09-07-save-load.png`、`report.json`。

## 7. 72 个月固定条件观察（种子 20261101、玩家无操作、默认 AI）

数据来自 `npx tsx scripts/economy-v09-report.ts --months=72`。三城顺序均为岚港 / 铁谷 / 青原。

| 观察点 | 岚港 | 铁谷 | 青原 |
| --- | --- | --- | --- |
| t1 人口 / 就业 | 600,145 / 38,792 | 430,127 / 29,330 | 320,083 / 24,003 |
| t1 失业率 | 91.9% | 91.5% | 90.6% |
| t1 月 GDP | 2.38 亿 | 1.84 亿 | 1.79 亿 |
| t1 居民消费 / 期望 | 3.47 / 9.94 亿 | 2.43 / 7.13 亿 | 1.90 / 5.32 亿 |
| t1 食品需求 / 成交 | 4,025,810 / 4,025,810 | 2,902,214 / 2,797,200 | 2,223,436 / 1,226,880（进口 829,870） |
| t1 企业 / 设备 | 5 / 17 台 | 6 / 12 台 | 6 / 23 台 |
| t12 失业率 | 97.2% | 94.4% | 95.5% |
| t12 月 GDP | 3496.3 万 | 1878.3 万 | 1018.7 万 |
| t12 负债率 | 25.6% | 47.0% | 45.9% |
| t12 食品需求 / 成交 | 797,923 / 0 | 600,194 / 0 | 516,383 / 0 |
| t12 企业现金 / 欠薪 | 0 / 3677.0 万 | 47.6 万 / 7182.2 万 | 26.0 万 / 4444.4 万 |
| t24 失业率 | 98.4% | 97.3% | 98.1% |
| t24 月 GDP | 2115.4 万 | 1698.5 万 | 1907.0 万 |
| t24 负债率 | 43.4% | 64.4% | 52.1% |
| t24 历史破产 | 1 次（tick 17） | 1 次（tick 15） | 1 次（tick 15） |
| t36 失业率 | 98.8% | 98.3% | 98.4% |
| t36 月 GDP | 2100.0 万 | 1680.1 万 | 1039.3 万 |
| t36 负债率（风险） | 55.9%（watch） | 94.5%（high） | 9.9%（normal） |
| t36 历史破产 | 2 次（17/29） | 2 次（15/27） | 2 次（15/34） |
| t72 就业 / 失业率 | 5,259 / 98.9% | 4,438 / 98.7% | 2,795 / 98.9% |
| t72 月 GDP / 近 12 月 GDP | 2100.0 万 / 2.52 亿 | 1683.0 万 / 2.04 亿 | 966.8 万 / 1.16 亿 |
| t72 负债（占 12 月 GDP） | 9671.4 万（38.4%） | 1.21 亿（59.6%） | 4194.8 万（36.1%） |
| t72 居民消费 / 期望 | 0 / 16.29 亿 | 0 / 11.71 亿 | 18 元 / 8.74 亿 |
| t72 食品需求 / 成交 | 687,502 / 0 | 713,375 / 0 | 583,316 / 0 |
| t72 企业 / 设备 | 4 / 12 台 | 8 / 13 台 | 7 / 12 台 |
| t72 居民现金 / 存款 | 26.72 / 11.31 亿 | 25.72 / 8.23 亿 | 18.57 / 6.50 亿 |
| t72 历史破产 | 5 次（17/29/41/54/67） | 6 次（15/27/37/49/59/67） | 5 次（15/34/46/56/68） |

其他：

- 银行 t72：存款 26.04 亿、贷款未偿 3169.8 万、合同 279（active 7 / defaulted 247 / repaid 25）；居民贷款合同 58 笔（消费贷累计发放 7793.6 万，未偿 0）。
- 设备市场 t72：政府库存 farm 77 / industry 189 / energy 49（**世界共享池**，配置值为每城 24/60/16 × 3 城 = 72/180/48 起；清算移交使总量略增），二手挂单 0，本月新设备成交 0。
- 岚港食品厂：t1 员工 24,840、设备 12 台、产能 4,046,400、计划 3,075,264、现金 2.58 亿；**tick 8 倒闭**。
- 创办合计 22 家（garment 4 / appliance 7 / utility 2 / agriculture 5 / metal 3 / fiber-farm 1），倒闭 20 家；清算减免 0；72 月内三城各破产 5/6/5 次（当前均 solvent）。
- 消费四层（t1 岚港）：成交 3.47 亿 / 期望 9.94 亿 / 有本地供给但资金不足 3 元 / 预算缩量未形成购买 6.47 亿 / 有预算但缺货 0.1 件≈7 元。**“预算缩量”是 affordability 缩放（收入低），不是供给不足；“有预算但缺货”才是供给缺口。**

### 7.1 消费归零不是没钱：资金与供给的分离证据

- t12 三城消费 0，但居民现金 14.34/12.98/11.82 亿、存款 10.66/7.76/6.21 亿；t72 居民现金 26.72/25.72/18.57 亿、存款 11.31/8.23/6.50 亿。
- 同期“有本地供给但资金不足”= 0（t12/t72 三城均为 0），而“有预算但缺货”= 食品需求全额（t12 岚港 79.8 万件、t72 岚港 68.8 万件）。因此**不是居民不愿/不能付钱，而是市场上没有食品**。
- 居民预算 = min(现金, 0.8×上月税后收入 + 5%×现金)。失业后收入归零，但现金仍在累积（无消费渠道），预算并未归零；affordability 缩放使有效需求随收入下降——这是“预算缩量未形成购买”的来源。

### 7.2 食品链断裂时间线（逐月证据）

1. **t1 正常**：岚港食品需求 4.03M 全部成交；lp-food 期初谷物 2.34M、产 3.13M 食品；青原谷物库存 6.67M；三城食品有进口/出口。
2. **t2 起现金流锁死**：企业初始现金 = 月工资 × 1.6（`initialCashWageMonths`），采购预算 = max(0, cash − 1 个月工资预留)。首月销售回款尚未覆盖第二月工资 + 原料，`cashTight` 触发生产计划紧急下调（base × 0.4）+ ±20% 平滑；`materialSupportedOutput` 同步收缩。
3. **t2–t5 谷物链条收缩**：唯一农业企业 gf-grain（青原）因 cashTight 连续下调计划（4.14M → 3.32M → 1.33M → 1.91M → 0.31M）；贸易合同/政府协议在旧顺序下先于市场抽走库存（本轮已改为“市场采购优先、合同补足”，但企业预算为 0 时仍买不到），市场谷物供给接近 0。
4. **t4–t5 食品厂断粮**：lp-food 采购预算被工资预留吃掉（现金 2.57 亿 → 1.43 亿 → 1810 万），t4 起本地食品成交 0（供给曾被青原/铁谷跨城买走——本轮已修两阶段本地优先），t5 起食品产量骤降。
5. **t8 lp-food 倒闭**；t12 三城食品供给 0、需求 798K/600K/516K 全部缺货；企业现金 0、欠薪 3677/7182/4444 万，紧急裁员 6/216/0。
6. **之后进入稳定低水平**：失业率 98%+，居民收入归零，食品需求数量随 affordability 缩到 60–70 万件/月，企业因无销售/无原料长期计划≈0，t72 月 GDP 仅剩 966.8 万–2100 万。

### 7.3 设备链缺口：资本品没有“可被看见的需求”

- 72 个月内**没有出现设备制造企业**：创办行业只有 garment/appliance/utility/agriculture/metal/fiber-farm。原因不是资金，而是创业评分读取的是“消费品市场”需求；设备商品由 `buyNewEquipment` 的企业采购形成，初始政府储备又能满足少量扩产，因此设备商品的 `city.market.demand` 长期为 0，评分 `demand/profit` 为 0，永远达不到 `FOUNDING_MIN_SCORE = 20`。
- 结果：设备只能来自政府库存（世界共享池 72/180/48）与清算回收（t72 77/189/49，几乎不消耗），真实新设备成交 0；任务书 ④ 的“设备企业”在机制上存在，但默认世界里没有企业会选择进入。
- 这是下一轮必须修的结构问题（可在创业评分中引入资本品订单/政府储备消耗信号），本轮未擅自改规则。

### 7.4 创业停摆

- 创办 22 家集中在前 6 个月；建议启动资本 1400 万–1.08 亿，而居民可投资实体现金 t6 起为 0（被前几轮创办出资与股票买入耗尽）；`chooseFoundingFounder` 之后长期返回 null。
- 本轮没有放松出资要求（不伪造成交/资金）。

### 7.5 政府破产与债务

- 三城在 72 月内分别破产 5/6/5 次（t72 均 solvent）；t36 铁谷负债率 94.5%（high）后于 t37 破产并被勾销，t72 回落到 59.6%。
- **不能把 t72 的 38.4%/59.6%/36.1% 解读为“财政改善”**：它是多次破产勾销 + 债务重发 + GDP 分母缩小的共同结果；报告已同时展示历史破产次数、勾销、当前负债与 12 月 GDP。

**结论：本轮按验收要求修复了 7 项机制问题并补了回归测试，但默认世界的经济仍然崩溃；崩溃主因是“人口 ×5 与私营产能/岗位 1×”“销量锚定计划 + 工资预留吃光采购预算”“资本品需求信号缺失”三条结构性规则，而不是某一处代码 bug。** 依据任务书“不要为达成某个测试数字取消破产 / 改用户明确规则前先报告冲突”，本轮未改这些规则，详见第 9 节。

## 8. 首版暂定参数（集中配置）

`src/data/config.ts`：

- 人口：`initialPopulationMultiplier 5`、`initialNonLaborShare 0.2`、`participationRate 0.8`。
- 企业与创办：`maxCompaniesPerCity 160`、`maxFoundingsPerCityMonth 2`、`foundingCooldownMonths 0`。
- 生产计划：`salesLookbackMonths 3`、`targetInventoryMonths 0.5`、`maxUp/DownAdjust 0.2`、`emergencyDownAdjust 0.6`、`stuckInventoryMonths 2`、`initialSalesFactor 0.8`、`minOutputRatio 0.05`。
- 设备：目录价 farm 12 万 / industry 20 万 / energy 16 万、`capacityPerUnit 300,000`、`usedPriceFactor 0.65`、`liquidationPriceFactor 0.45`、政府库存（每城配置，运行时为世界共享池）24/60/16、`maxBuyUnitsPerMonth 60`。
- 工资/奖金/裁员：`initialCashWageMonths 1.6`、`wageReserveMonths 1`（采购预留）；`bonusEveryMonths 3`、`bonusProfitShare 0.1`、`bonusReserveWageMonths 2`、`bonusDebtServiceMonths 1`；`maxMonthlyLayoffRate 0.08`、`emergencyLossMonths 2`、`emergencyCashWageMonths 1`、`emergencyLayoffShare 0.3`。
- 创业：`FOUNDING_MIN_SCORE = 20`。

## 9. 未解决项与需要用户决策的冲突

1. **人口 ×5 vs 私营岗位/产能 1×（规则冲突）**：任务书要求人口 ×5 且公共岗位不乘 5，但未要求私营企业岗位/产能同步放大。默认开局失业率即 91%+，工资收入支撑不了 5× 消费需求。曾实验把私营岗位/产能 ×5：t1 失业率 64.4%、GDP 10.22 亿、消费 5.80/10.80 亿、食品成交 6.67M，但 t1 计划 20.5M 远超需求 → 库存 12.1M，t12 失业回升 95.4%、t72 98.3% 仍崩溃。该实验已回退，是否采纳需用户确认。
2. **生产计划以销量为锚（规则冲突）**：任务书 ⑤ 明确“近 3 月销量 + 目标库存 + ±20%”，但该锚点在跨城需求存在时看不到缺口，会持续压缩计划。建议下一版把“未满足需求/跨城订单”作为额外目标信号；需用户确认是否修改 ⑤。
3. **初始流动资金 1.6 个月工资（数值）**：首月无销售 + 采购需预留 1 个月工资，必然 cashTight；实验加到 3 个月只延后崩溃约 3 个月，说明不是万能药，但 1.6 是否合理需策划确认。
4. **创业启动资本 1400 万–1.08 亿（数值）**：居民可投资实体现金总量不足以支撑持续创办；是否放宽出资/引入外部投资需用户确认。
5. **资本品需求信号缺失（机制）**：设备商品无消费品市场需求，创业评分看不到；“设备企业”在默认世界不会出现。建议下一版让创业评分读取设备订单/政府储备消耗。
6. **经济仍崩溃**：本轮不以调参掩盖；第 7 节给出完整证据。
7. **桌面验收为 Xvfb 无头截图**，Windows 真机表现需按第 10 节复验；1100×700 仅验证无横向溢出，未做全分辨率矩阵。
8. **72 月观察为单次固定种子**，不是统计显著性结论；跨种子稳定性未验证。
9. 政府设备库存是**世界共享池**（配置为每城值，运行时合并为 3 城总量），任何城市都可消耗其他城市份额；是否符合任务书“政府初始库存”语义需确认（当前在报告与验收中按共享池解释）。
10. 企业清算时名下政府债券已按持股转给股东（无兼容股东则标记 redeemed），`lifecycle` 仍保留极少量指向已退出企业的历史持债（均 redeemed，无 active 孤儿）；建议后续统一清理或在 UI 做容错。

## 10. Windows 复验步骤

```powershell
cd C:\CODING-worktrees\mechanisms-foundation   # 或本次分支的本地目录
npm install
npm run build
npx vitest run --maxWorkers=1 --testTimeout=60000
npx tsx scripts/economy-v09-report.ts --months=72
npm run dev
```

桌面验收（需先 `npm run build` 生成 `dist/`）：

```powershell
node_modules\electron\dist\electron.exe scripts\acceptance-v09.cjs
```

验收脚本会自行启动 Electron、操作 DOM、截图到 `artifacts/acceptance-v09/` 并复制到 `docs/evidence_v0.9/`（`artifacts/` 在 `.gitignore` 中）。若 Electron 安装脚本被策略拦截，先执行 `node node_modules\electron\install.js`。

## 11. Git

- 基线：`3d714c6`（v0.8.3）；第一轮 v0.9 交付：`a13b4a7` → `46a98fe` → `740aeab` → `f942cc9`。
- 本轮（验收修复）按阶段提交：sim 修复与测试、报告脚本与证据、文档/版本。
- 最终本地/远程 SHA、工作区状态、测试与桌面结果：见本次交付回复。
- 未合并 main、未 force、未改写已推送历史。
