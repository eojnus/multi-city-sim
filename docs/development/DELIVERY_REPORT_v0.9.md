# v0.9 交付报告：经济循环完善（人口 ×5、真实设备链、生产计划、工资奖金裁员、创业与存档 v9）

日期：2026-11-04
分支：`feature/stock-market-ui-tax`（基线 `3d714c6`，未合并/未改写 main）
存档格式：v9 ｜ 版本号：0.9.0

## 0. 结论摘要

- **任务书 12 节全部落地**：企业上限 160、开局人口 ×5（非劳动 20%/劳动 80%）、消费资金顺序（现金→存款→消费贷）、三类设备商品与真实设备链、生产计划（计划/实际分离、近 3 月销量、目标库存、±20% 与紧急下调）、季度奖金 + 常规 8%/紧急 30% 裁员、创业评分与真实出资/设备/招聘（每城每月 2 家）、GDP 计入公共服务、企业设备/计划面板与人口“需求 vs 成交”、存档 v9 迁移、72 月观察与岚港食品厂跟踪、提交与报告。
- **测试与构建**：`npx vitest run --maxWorkers=1 --testTimeout=60000` → **85 个文件 / 677 项全部通过（89.09s）**；`npm run build`（含 `tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.electron.json`、Vite 构建）通过；72 月报告脚本 exit 0。
- **桌面验收**：真实 Electron + Xvfb，`scripts/acceptance-v09.cjs` → **12/12 项通过、0 条控制台错误**；7 张截图 + report.json 已入仓 `docs/evidence_v0.9/`。
- **残酷但必须明确的结论**：v0.9 的机制全部按任务书实现，但** 72 个月固定条件下经济仍然深度衰退**——三城失业率 98.5%–98.9%、居民消费归零、月 GDP 从 2.4/1.86/1.78 亿降到 2100/1680/966 万、企业从 17 家降到 14 家（倒闭 20 / 创办 17）、设备从 52 台降到 32 台。本轮**没有隐藏、没有用断言掩盖、也没有伪造成交**；根因与结构性判断见第 7 节，供下一轮设计决策使用。
- 本轮验收过程发现并修复了一个真实产品 bug（政府设备库存出售未计入市场供应，导致存档无法读回），并补了回归测试；详见第 5、6 节。

## 1. 分支、基线与环境

- 仓库：`https://github.com/eojnus/multi-city-sim`
- 分支：`feature/stock-market-ui-tax`（在 v0.8.3 交付分支上继续追加，不新开分支）
- 基线提交：`3d714c6`（v0.8.3 股息收益率精度修复）
- 环境：Node v26.13.0 / npm 11.20.0、TypeScript 5.9.3、Phaser 3.90.0、Electron 38.8.6、Vite 7.3.7、Vitest 3.2.7；Linux + Xvfb（1600×1000，`DISPLAY=:99`），Electron 以 `--no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader` 运行。
- 运行约束：本机内存约 2GB，Vitest 必须 `--maxWorkers=1 --testTimeout=60000`；`vite.config.ts` 已同步 testTimeout/hookTimeout 30s。

## 2. 技能（任务书要求列出名称与来源）

| 技能 | 来源 | 本轮用途 |
| --- | --- | --- |
| find-skills | vercel-labs/skills | 检索可用技能并确认安装来源 |
| systematic-debugging | obra/superpowers | 验收失败与读档/市场守恒 bug 的定位流程 |
| diagnosing-bugs | mattpocock/skills | 72 月崩溃的逐月/逐链路诊断 |
| thinking-systems | tjboudreaux/cc-thinking-skills | 把“失业—需求—清算”作为反馈回路分析 |
| data-analysis | claude-office-skills/skills | 72 月报告与对照表整理 |
| game-ui-ux | gamedev-skills | 设备/计划面板的信息层级与密度 |
| frontend-design | anthropics/skills | 面板排版与可读性 |
| web-design-guidelines | vercel-labs/agent-skills | UI 走查（横向溢出、标签可点性） |
| improve-codebase-architecture | obra/superpowers | 设备/生产计划/创业模块拆分 |
| typescript-advanced-types | wshobson/agents | 存档迁移与可选字段的类型约束 |
| verification-before-completion | obra/superpowers | 交付前强制“先跑再报” |

## 3. 交付内容（任务书 12 节逐项对照）

### ① 企业上限 160（只计经营中）

`src/data/config.ts`：`lifecycle.maxCompaniesPerCity = 160`；只统计经营中的企业，退出/清算企业不占名额；**初始企业数量仍为 17 家**（`tests/opening-v09.test.ts` 校验）。为避免上限放开后创办节奏暴增，同时把 `maxFoundingsPerCityMonth` 设为 2、清理旧冷却冲突（`foundingCooldownMonths = 0`，由月度上限控制节奏）。

### ② 开局人口 ×5、非劳动 20% / 劳动 80%

`src/simulation/core/initializer.ts`：`total = round(seed.totalPopulation × 5)`、`nonLabor = round(total × 0.2)`、`laborForce = total − nonLabor`；公共部门岗位**不乘 5**（`city.publicSector.jobs = seed.publicJobs`），就业 = 公共部门 + 本城企业员工，且不超过劳动力。整数与百分比均确定性计算，不引入随机。初始财富/需求按新人口重算（居民现金/存款、群体收入、初始需求与成交量口径），72 月观察第 1 个月数据用于核对。
- 初始人口：岚港 600,145（×5 后）、铁谷 430,127、青原 320,083。
- 旧存档迁移**不做人口放大**（见 ⑩）。

### ③ 消费资金顺序：现金 → 存款 → 消费贷

`src/simulation/population/consumption`（消费链路，T2 交付）：先用手头现金；不足时从存款提取，**单月不超过月初存款的 5%**；仍不足才使用消费贷；贷款额度按实际成交额生成，失败原子回滚（不会出现“先记贷款、后未成交”）。预算口径 = 上月可支配收入 × 80% + 现金 × 5%，`HouseholdMonthlyStats.depositWithdrawn` 记录当月提取。测试：`tests/household-savings-withdrawal.test.ts` 等 5 文件 49 项。

### ④ 真实设备链（3 类设备商品 / 设备企业 / 政府库存 / 二手机 / 清算处置）

- `GoodId` 新增 `farmEquipment`、`industryEquipment`、`energyEquipment`；`src/data/demo-data.ts` 三种设备商品（目录价 12 万/20 万/16 万，配方 metal + energy，生产率 0.01 台/员工/月），由设备企业真实生产与销售。
- 新增模块 `src/simulation/equipment/equipment.ts`：`emptyEquipmentAssets`、`equipmentKindForSector`、`equipmentCapacityFor`、`recomputeCompanyCapacity`（同步 `equipmentCapacity` 与 `maxCapacity`）、`buyNewEquipment`（优先同城设备企业库存，其次政府库存；政府库存按目录价收款并入本城财政）、`listUsedEquipment` / `cancelUsedEquipmentOffer` / `buyUsedEquipment`、`disposeCompanyEquipment`（清算时按 45% 残值寻找同城买家，无人购买移交政府设备库存并警告，不变现）、`equipmentFromCapacity`（迁移用）。
- 企业产能 = Σ(设备台数 × 每台产能 300,000 × 城市技术系数)；购买/出售/清算都会重算产能，`checkEquipment` 不变量校验设备与产能一致。
- 政府开局库存（每城）：农业 24 / 工业 60 / 能源 16 台；单企业单月最多买 60 台。
- 二手市场：企业可挂单（默认目录价 × 0.65，可改价），其他企业可买；挂单库存与资金真实转移，不凭空生成。

### ⑤ 生产计划（设备/劳动/计划/实际分离）

`src/simulation/companies/production-plan.ts`：计划产量 = 近 3 个月实际销量 + 目标库存（0.5 个月销量），正常月份上调/下调各 ≤ 20%；现金不足或连续积压时允许紧急下调（下限 60%）；无销量历史时以设备产能 × 0.8 作为初始参考；同时保留设备上限、劳动上限与最低维护性产出（`minOutputRatio = 0.05`，且不低于 5% 设备产能）。计划产量、实际产量、岗位需求、设备与劳动上限在 UI 分开显示。净工资账单含稳岗补贴。

### ⑥ 工资稳定 + 季度奖金；常规裁员 8% / 紧急裁员 30%

- `src/simulation/companies/finance.ts`：删除旧的自动扩/缩产能，改为**季度奖金**——连续盈利 3 个月才评估，奖金池 ≤ 最近 3 个月税后利润合计的 10%，发放后至少保留 2 个月工资 + 1 个月已知偿债额，且只用企业自有现金；奖金计入 `wagesPaid`、`bonusPaid` 与 `recentProfits`。
- `src/simulation/companies/labor.ts`：常规裁员上限 8%/月；**紧急裁员**条件 = 连续亏损 ≥ 2 个月且（现金 + 合法授信）< 1 个月工资，可裁 30%；超出常规上限的部分记入 `emergencyLayoffs`。
- `src/simulation/companies/ai/strategy.ts`：招聘补贴按目标岗位 × 1.05 估算，避免“账面岗位够、工资不够”。

### ⑦ 创业评分 + 真实出资/设备/招聘 + 每城每月 2 家

新增 `src/simulation/companies/founding.ts`：评分覆盖任务书列出的全部因素——**售价趋势、销量与未满足需求、同城竞争者与产能份额、设备可获得性、原料本地覆盖与跨城运输加成、工资成本、启动资金与预期利润**。代码中把“工资 + 运输 + 原料”归入 `cost`，把“启动资金 + 预期利润”归入 `profit`（`roi = 预期月利润 / 启动资本`，启动资本包含设备、首批原料与首月工资），最终形成 7 个可解释分项（`price / demand / competition / equipment / supplyChain / cost / profit`）与总分；每个候选行业输出理由与建议启动资本，写入创办日志与成立记录。总分 < 20 不创办；创办时真实采购设备、按需出资并招聘，每城每月最多 2 家。测试：`tests/founding.test.ts`。

### ⑧ GDP 含公共服务

`src/simulation/economy/gdp.ts` 的 `computeCityGdp` 加上 `city.lastMonth.publicWageBill`（当月实际计入居民收入的公共工资），不计转移支付、借款与债务勾销；注资不再增加产能。测试：`tests/gdp-public-service.test.ts`。

### ⑨ UI：企业设备/计划面板 + 人口“需求 vs 成交”

- `src/app/gameStore.ts`：`companyOperatingView`、`equipmentMarketView`、`buyEquipment`、`sellUsedEquipment`、`buyUsedEquipment`、`cancelUsedEquipment` 命令；玩家经营企业时可买新设备（同城设备企业库存/政府储备、目录价）、挂二手、买二手。
- `src/app/panels.ts`：企业「经营」新增设备表（台数/单台产能/合计产能/目录价/市价/可售或政府储备/本月购买出售）、生产计划（计划产量/实际产量/设备上限/劳动上限/计划依据）、二手委托与政府库存；财务表新增奖金/设备买卖/紧急裁员行；人口「就业结构」显示就业/失业/非劳动（人数与占比）与“需求 vs 成交”（需求、实际成交、缺货未满足、资金不足未满足、消费贷支持、存款提取）。
- 面板明确区分“市场参考价”与“政府储备目录价”，避免误解扣款金额。

### ⑩ 存档 v9

`SAVE_FORMAT_VERSION = 9`；`migrateWorldV8ToV9` 为旧档补齐设备商品/设备资产/设备市场/月度统计字段，**不增加产能与现金**（日志写明“不增加产能与现金”），旧产能按 `equipmentFromCapacity` 反推设备台数；旧档不乘 5；读取校验新增设备/市场委托/持债校验（已兑付/清算注销的持债允许引用已退出企业）。测试：`tests/migration-v9.test.ts`；全量读档/往返校验在 `tests/acceptance/settlement-resume.test.ts` 等。

### ⑪ 测试 + 72 月观察 + 岚港食品厂跟踪

- 新增/更新测试：`opening-v09`、`production-plan`、`founding`、`compensation`、`household-savings-withdrawal`、`gdp-public-service`、`migration-v9`、`ui-equipment`、`equipment-market` 等；acceptance 序列按当前确定性输出重锁（保留守恒/结构断言，见第 5 节）。
- `scripts/economy-v09-report.ts` 输出 1/12/24/36/72 月三城快照、银行/设备市场/岚港食品厂跟踪与汇总；数据见第 7 节。
- 岚港食品厂：t1 员工 24,840、设备 12 台、计划 3,125,116、现金 2.58 亿；**tick 7 倒闭**。

### ⑫ 提交与推送

见第 11 节（基线/最终 SHA、工作区、测试与桌面结果）。

## 4. 主要新增/修改文件

新增：
- `src/simulation/equipment/equipment.ts`
- `src/simulation/companies/production-plan.ts`
- `src/simulation/companies/founding.ts`
- `tests/opening-v09.test.ts`、`tests/production-plan.test.ts`、`tests/founding.test.ts`、`tests/compensation.test.ts`、`tests/household-savings-withdrawal.test.ts`、`tests/gdp-public-service.test.ts`、`tests/migration-v9.test.ts`、`tests/ui-equipment.test.ts`、`tests/equipment-market.test.ts`
- `scripts/economy-v09-report.ts`、`scripts/acceptance-v09.cjs`
- `docs/evidence_v0.9/`（7 张 PNG + report.json）

修改（主要）：
- 类型/数据：`src/simulation/contracts/types.ts`、`src/data/config.ts`、`src/data/demo-data.ts`
- 核心：`src/simulation/core/initializer.ts`、`save.ts`、`invariants.ts`
- 企业：`lifecycle/lifecycle.ts`、`companies/company.ts`、`finance.ts`、`labor.ts`、`ai/strategy.ts`、`ai/planning.ts`、`production.ts`
- 消费/人口：`population/consumption.ts`、`population/household-groups.ts`
- 经济/财政：`economy/gdp.ts`、`government/finance.ts`
- UI：`src/app/gameStore.ts`、`src/app/panels.ts`、`src/app/ui.ts`
- 测试更新：`tests/simulation.test.ts`、`tests/transport-refund.test.ts`、acceptance 三文件等

## 5. 测试与验证（实际执行）

```bash
npx tsc --noEmit
npm run build
npx vitest run --maxWorkers=1 --testTimeout=60000
npx tsx scripts/economy-v09-report.ts --months=72
```

- `tsc`：通过（0 错误）。
- `npm run build`：通过（renderer + electron，约 12s）。
- Vitest：**85 文件 / 677 项全部通过**，89.09s。
- 72 月报告：exit 0，输出 `/tmp/v09-72m-final2.txt`（206 行）。
- 本轮修整的测试问题（均为 v0.9 规则变化导致的预期值/构造变化，未删除任何守恒或结构断言）：
  - `tests/government-equity.test.ts`：财政增量期望 700,000 → 790,000。差额 90,000 = 清算时 1 台工业设备按 45% 残值（200,000×0.45）卖给同城买家，属 v0.9 真实设备处置新增的现金流入。
  - `tests/company-ai.test.ts`：设备购买抬高真实产能后 `capacity ≤ maxCapacity` 被打破；产品修复 `recomputeCompanyCapacity` 同步抬高 `maxCapacity`。
  - `tests/production-plan.test.ts`：维护性产出下限必须同时受设备上限约束（`min(equipmentCapped, equipmentLimit×5%)`），否则紧急下调会被抬到异常值。
  - acceptance：`bankruptcy-real-run`（岚港 t15/t27、铁谷 t15/t27、青原 t15/t30；t36 负债率 87.566%/82.358%/47.101%；勾销额、债券计划/成交、持债结构均按当前确定性输出重锁，守恒断言保留）；`fiscal-log-visibility` I11c/I11d 改为按城市名限定（三城同日破产时，另一破产城市同名明细对该城市长本人可见，属预期，不是泄漏）；`public-bankruptcy-panel` I10e 在无“未破产城市”时构造 `bankruptcy=solvent + records=[]` 视图验证不展示公告。

## 6. 桌面走查（真实 Electron）

命令：

```bash
node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs
```

结果：**12/12 通过、0 条控制台错误**（`docs/evidence_v0.9/report.json`）。检查项：

1. 启动、三城、首次推进；
2. 人口 ×5 与 20% / 80% 结构、就业/失业/非劳动互斥；
3. 人口「需求 vs 成交」：第 1 月岚港需求 9.94 亿、实际成交 3.35 亿、缺货未满足约 3.99 亿、资金不足未满足约 2.6 元、消费贷支持 1398.3 万、存款提取 0；
4. 企业「经营」设备表 + 生产计划（计划/实际/设备上限/劳动上限/计划依据），并构造玩家经营以验证权限；
5. 玩家在界面购买 1 台能源设备（政府储备 48→47，目录价扣款 160,000，财政同额入账，产能同步）；
6. 玩家从岚港食品厂挂 2 台工业设备二手（used-1，单价 130,000）；
7. 另一家玩家经营企业买下这 2 台二手设备（资金/设备/产能同步，委托清空）；
8. 股票窗口回归（打开、行数据、关闭）；
9. 存档→读档：现金、股份、持债、设备、市场委托与读档前一致；
10. 1100×700 窗口无横向溢出；城市 6 标签/企业 5 标签可点；
11. 关闭企业后回到城市面板；
12. 零控制台错误（应用内 console 拦截）。

证据（`docs/evidence_v0.9/`）：`v09-01-population-demand-trade.png`、`v09-02-company-equipment.png`、`v09-03-equipment-buy.png`、`v09-04-used-market.png`、`v09-05-buy-used.png`、`v09-06-stock-regression.png`、`v09-07-save-load.png`、`report.json`。

验收过程中发现并被测试锁定的产品 bug：从政府设备库存买设备后，存档校验报“成交 1 超过供应 0”。根因是 `buyNewEquipment` 的政府分支只记 `sold/demand`，未把政府储备释放计入 `supply`；修复为 `ledger.supply += affordable`，并新增 `tests/equipment-market.test.ts` 回归。

## 7. 72 个月固定条件观察（任务书第八节；种子 20261101、玩家无操作、单次运行）

数据来自 `npx tsx scripts/economy-v09-report.ts --months=72`。三城顺序均为岚港 / 铁谷 / 青原。

| 观察点 | 岚港 | 铁谷 | 青原 |
| --- | --- | --- | --- |
| t1 人口 | 600,145 | 430,127 | 320,083 |
| t1 失业率 | 91.8% | 91.3% | 91.1% |
| t1 月 GDP | 2.40 亿 | 1.86 亿 | 1.78 亿 |
| t1 居民消费 / 期望 | 3.35 / 9.94 亿 | 2.60 / 7.14 亿 | 1.95 / 5.32 亿 |
| t1 企业 / 设备 | 5 / 17 台 | 6 / 12 台 | 6 / 23 台 |
| t12 失业率 | 98.0% | 96.8% | — |
| t12 月 GDP | 2100.7 万 | 1744.5 万 | — |
| t12 负债率 | 35.5% | 46.7% | — |
| t24 失业率 | 98.6% | 98.1% | 98.2% |
| t24 月 GDP | 2100.2 万 | 1680.0 万 | 1454.9 万 |
| t24 负债率（风险） | 68.9%（watch） | 67.1%（watch） | 62.8%（watch） |
| t24 居民消费 | 0 | 0 | 583.0 万（期望 8.67 亿） |
| t36 失业率 | 98.8% | 98.4% | 98.7% |
| t36 月 GDP | 2100.0 万 | 1680.0 万 | 966.0 万 |
| t36 负债率（风险） | 87.6%（high） | 82.4%（high） | 47.1%（normal） |
| t36 计划产量 | 93,890 | 59,680 | 192 |
| t72 就业 / 失业率 | 5,419 / 98.9% | 5,083 / 98.5% | 2,801 / 98.9% |
| t72 月 GDP | 2100.0 万 | 1680.0 万 | 966.0 万 |
| t72 负债（占 12 月 GDP） | 1.14 亿（45.0%） | 1.09 亿（54.2%） | 5,929.5 万（51.2%） |
| t72 居民消费 / 期望 | 0 / 16.30 亿 | 0 / 11.71 亿 | 0 / 8.74 亿 |
| t72 企业 / 设备 | 5 / 8 台 | 5 / 17 台 | 4 / 7 台 |
| t72 计划产量 | 50,372 | 80,735 | 489 |
| t72 居民现金 / 存款 | 30.64 / 26.52 亿 | 24.67 / 26.52 亿 | 15.58 / 26.52 亿 |

其他：

- 银行 t72：存款 26.52 亿、贷款未偿 2650.2 万、合同 133（active 3 / defaulted 109 / repaid 21）；居民贷款合同 181 笔。
- 设备市场 t72：政府库存 farm 89 / industry 182 / energy 49（初始 24/60/16），二手挂单 0；本月新设备成交 0。
- 岚港食品厂：t1 员工 24,840、设备 12 台、计划 3,125,116、现金 2.58 亿；**tick 7 倒闭**。
- 创办合计 17 家（appliance 10 / agriculture 3 / garment 2 / utility 1 / metal 1），倒闭 20 家；72 个月内三城均未政府破产（风险档在 t24–t36 达到 watch/high，t72 回落至 normal/watch/watch）。

### 7.1 结构性判断（必须如实记录）

v0.9 的机制都生效了，但没有逆转 v0.8.3 诊断出的结构性缺口；本轮数据把“为什么”进一步坐实：

1. **需求被 ×5，产能没有**：t1 三城食品需求约 15.6M/月、本地产能约 6.4M/月；grain 需求约 9.7M、产能约 4.4M。设备链给了“可扩产”的路径，但设备企业自身也缺原料/资金，实际只卖出少量新设备（政府库存 24/60/16 台始终未能持续转化）。
2. **计划仍以已实现销量为锚**：销量崩塌后，计划按 ±20% 与 5% 维护下限收缩，看不到跨城未满足需求，因此不会主动为缺口扩产；t36 三城计划产量 93,890 / 59,680 / 192，t72 仍只有 50,372 / 80,735 / 489。
3. **创业受“真实出资 + 设备 + 首月工资”约束**：建议启动资本 14M–108M，居民投资实体现金在 t1 约 2.66 亿、t5 约 1.02 亿、**t6 起为 0**（被创办出资与股票买入耗尽），`chooseFoundingFounder` 返回 null；17 家创办集中在前几个月，t6 之后基本停摆。
4. **工资—现金—清算—失业回路仍在**：企业现金在 t12 已为 0、欠薪 2237 万；t36 紧急裁员 9/36/25；设备随清算移交政府（t72 企业设备 8/17/7 台），失业率维持 98%+，需求侧无法恢复。
5. **消费归零不是因为居民没钱**：t72 居民现金 30.64 / 24.67 / 15.58 亿、存款 26.52 亿，但可支配收入（工资/救济）归零；救济金发放受财政约束（t72 累计税收入账仅 3584.4 / 2936.0 / 1659.9 万），消费预算随之归零。**储蓄→消费/投资的通道仍未打通**，这是下一版最值得优先处理的环节之一。
6. **政府债务没有爆掉，但靠的是“分母缩小”**：t36 负债率 87.6%/82.4%/47.1% 属于 high，t72 回落到 45.0%/54.2%/51.2%，同时 GDP 已降至峰值的 1/10 左右；72 月内未触发破产不代表财政健康。

**结论：本轮 12 节机制是“把缺的工具补上”，不是“调参让经济不死”。** 72 月仍崩溃，且崩溃路径与 v0.8.3 诊断一致；若要进入“可持续增长”，下一轮需要动的是结构（需求—产能匹配、储蓄→投资/消费通道、计划锚点、清算与再就业），而不是继续微调单个系数。此为已知问题，不隐藏。

## 8. 首版暂定参数（集中配置）

`src/data/config.ts`（全部为可替换演示值，非最终策划）：

- 人口：`initialPopulationMultiplier 5`、`initialNonLaborShare 0.2`、`participationRate 0.8`。
- 企业与创办：`maxCompaniesPerCity 160`、`maxFoundingsPerCityMonth 2`、`foundingCooldownMonths 0`。
- 生产计划：`salesLookbackMonths 3`、`targetInventoryMonths 0.5`、`maxUp/DownAdjust 0.2`、`emergencyDownAdjust 0.6`、`stuckInventoryMonths 2`、`initialSalesFactor 0.8`、`minOutputRatio 0.05`。
- 设备：目录价 farm 12 万 / industry 20 万 / energy 16 万、`capacityPerUnit 300,000`、`usedPriceFactor 0.65`、`liquidationPriceFactor 0.45`、政府库存 24/60/16、`maxBuyUnitsPerMonth 60`。
- 工资/奖金/裁员：`bonusEveryMonths 3`、`bonusProfitShare 0.1`、`bonusReserveWageMonths 2`、`bonusDebtServiceMonths 1`；`maxMonthlyLayoffRate 0.08`、`emergencyLossMonths 2`、`emergencyCashWageMonths 1`、`emergencyLayoffShare 0.3`。
- 创业：`FOUNDING_MIN_SCORE = 20`（`src/simulation/companies/founding.ts`）。

## 9. 未完成项与已知限制

- **经济仍崩溃**（见第 7 节）：机制完整但结构缺口未闭合；本轮未通过改参数掩盖。
- 设备新机成交在 t1 之后接近 0：设备企业自身受原料/资金/计划锚点约束，政府库存消耗后没有补货，二手市场无成交（企业缺现金）。
- 创业在 t6 后停摆：投资实体现金耗尽；居民 30 亿+现金无法转化为实体投资（储蓄→投资通道）。
- 消费归零：失业救济受财政约束，居民可支配收入归零；储蓄未回流消费。
- 银行仍为负利差、顺周期（存款利息支出 > 贷款利息收入），见 v0.8.3 诊断；本轮未改银行规则。
- 桌面验收为 Xvfb 无头截图，Windows 真机表现需按第 10 节复验；1100×700 仅验证无横向溢出，未做全分辨率矩阵。
- 72 月观察为单次固定种子，不是统计显著性结论；跨种子稳定性未验证。

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

- 基线：`3d714c6`（分支 `feature/stock-market-ui-tax`）
- 本版提交（分阶段）：
  1. `a13b4a7` feat(sim)：人口 ×5、真实设备链、生产计划、奖金裁员、创业评分、GDP 公共服务、存档 v9、设备市场供应修复与测试
  2. `46a98fe` feat(ui)：企业设备/生产计划面板与人口“需求 vs 成交”
  3. `740aeab` test(acceptance)：v0.9 桌面验收脚本、72 月报告脚本与证据（12/12）
  4. 本文档与 README/版本号（docs 提交）
- 最终本地/远程 SHA、工作区状态：见提交推送后的交付回复
- 测试：85 文件 / 677 项通过；`tsc` 与 `npm run build` 通过；桌面 12/12、0 控制台错误。
- 未合并 main、未 force、未改写已推送历史。
