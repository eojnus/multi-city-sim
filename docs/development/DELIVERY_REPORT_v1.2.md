# v1.2 交付报告：投资归属、购债储备、食品链与创业修复

> 分支：`feature/stock-market-ui-tax`（未合并 main）
> 验收基线：`0fd4a0ead8020514657ac1f90942d1c0b1996b34`（v1.1 最终提交）
> 交付日期：2026-11-04
> 存档格式：`SAVE_FORMAT_VERSION = 9`（v1.2 未改存档布局，新增字段均可选）；`GAME_VERSION = '1.2.0'`

---

## 0. 结论摘要（先说要害）

四项机制修复与创办上限均已实现，类型检查、构建、全量测试、桌面验收全部通过。但**默认世界 72 个月仍未达标，且多项指标比 v1.1 更差**。本报告不粉饰：

- 第 72 月（固定种子 20261101、玩家无操作、默认 AI）：失业率 98.7% / 98.8% / 97.5%，月 GDP 2,353.3 / 1,680.0 / 1,480.1 万，食品满足率 0.0% / 0.0% / 0.9%，政府历史破产 4 / 7 / 3 次，在营企业 17 / 10 / 17 家。v1.1 同条件为失业 98.7% / 98.2% / 96.7%、食品 0.0% / 0.0% / 23.8%、破产 4 / 4 / 1 次、企业 46 / 29 / 40 家。
- 任务书的观察目标继续未达成：**第 12 月食品满足率 ≥90%**（实测 17.3% / 19.5% / 14.8%）、**第 24 月失业率较开局下降 ≥5pp**（t1 为 86.5% / 83.9% / 80.6%，t24 为 98.4% / 97.8% / 98.7%，即 +11.9 / +13.9 / +18.1pp）。
- 变差的直接数据特征：t6/t12 创办数从 v1.1 的 20/20/20 家降到 6/10/7、11/14/13 家；投资实体把现金几乎全部投入新办企业/设备，t72 实体现金仅 1,475 / 1,274 / 1,745（v1.1 为 7.20 / 5.28 / 4.01 亿）；食品厂在 t12 后计划坍缩（t24 全市计划产量 435,764、岗位 1,768、食品厂仅 2 家），工资账单仍高于有效需求，裁员→需求下降的螺旋没有闭合。代码改动与这些数据一致（AI 不再用 `company` 出资人、投资实体现金被抽干），但单一种子下无法把因果完全分离，报告中按“相关/一致”表述。
- §3 的“股息抽干周转金”断点已修复并有测试锁定：有利润也不再越过“2 个月工资 + 1 个月计划原料”储备派息，企业当月现金不会被派空。但 72 月里食品链的断点已转移到“利润转负、需求不足、工资刚性”，不是本轮股息储备能单独闭合的。
- **诚实结论：机制级验收通过，宏观目标未通过。** 未伪造任何成交、资金、测试或桌面结果；72 月数字全部来自 `/tmp/v12-72m.txt` 实跑（同一脚本、同一种子）。

---

## 1. 分支、基线与环境

- 仓库：`https://github.com/eojnus/multi-city-sim`，工作区 `/workspace/Coding/multi-city-sim`。
- 分支：`feature/stock-market-ui-tax`；开工基线 `0fd4a0e`（v1.1 最终提交，远程一致）；`main` 保持 `6c45000efc4c406d30e22c0a12bd066fc2df61f7`。未合并 main、未 force push、未 rebase/amend。
- 技术栈：TypeScript 5.9 + Phaser 3.90 + Electron 38.8.6 + Vite 7.3 + Vitest 3.2。
- 环境：`HOME=/workspace/Coding/.home`、`npm_config_cache=/workspace/Coding/.npm-cache`；桌面验证在 Xvfb `:99`（1600×1000×24）下运行 `node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader`；Vitest 用 `--maxWorkers=1 --testTimeout=60000 --hookTimeout=60000`（容器内存约束）。
- 版本：`GAME_VERSION` 由 1.1.0 升为 `1.2.0`（`src/simulation/contracts/types.ts`），`package.json` 1.2.0；`SAVE_FORMAT_VERSION` 保持 9，旧 v9 档可读（见 §2 与 §4）。`package-lock.json` 版本字段仍为历史的 0.8.3，本轮未改，不影响构建。

---

## 2. v1.2 验收四项 + 补充逐条对照

| 项 | 要求 | 实现 | 证据 | 结论 |
|---|---|---|---|---|
| §1 投资份额与股息归属 | 居民投资实体的股息按**真实份额**归属到居民，不能按人口平摊；旧档无主资产要有起始份额；跨城迁移份额随人走 | `effectiveInvestorShares(ledger)` = 新增出资份额 + 旧资产 `openingShares`；`ensureInvestorOpeningShares` 把未归属旧资产按群体人口补为起始份额（幂等，读档/同步人口/派息前调用）；`allocateResidentDividendReturns` 按份额分配，1 分尾差用最大余数法闭合；`transferInvestorLedgerForMigration` 在跨城迁移时按人数拆分份额（总额守恒、不产生现金）；`splitCityHouseholdIncome` 与实体现金返还额同额 | `tests/investor-dividend-attribution.test.ts`（9 项：1:3 份额、仅一群体有份额、旧资产、新旧份额合并、迁移、0.01 尾差、旧 v0.9 实档幂等）、`tests/v12-cross-module.test.ts` §1（2 项）、全量回归 | **机制达成**（测试+实跑账本） |
| §2 购债偿债储备含逾期 | 企业购债前的储备必须覆盖下一期真实偿债义务，**含逾期本金与逾期欠息**，不能只算合同分期 | `banking.nextLoanObligation(loan, tick)` 统一给出 due / scheduledPrincipal / interestDue / arrearsInterestDue / arrearsPrincipalDue / collectiblePrincipal / total；`serviceLoan` 与 `government/bonds.companyMonthlyDebtService` 都改用该口径，逾期本金作为未偿本金的子集计入且不重复 | `tests/bond-reserve-v12.test.ts`（6 项：outstanding 20,000 + 逾期本金 8,000 → 储备 9,100、可认购 900；旧实现 8,900；部分偿还后剩余逾期继续计入；末期结清；正常贷款；逾期欠息）；`tests/v12-cross-module.test.ts` §2（2 项：储备=下期义务、实付与储备一致） | **机制达成** |
| §3 食品链最早断点与修复 | 找出食品链最早断裂点并修复，使“缺货→计划→采购→生产”真实成立 | 断点：盈利食品企业按 100% 比例派息，现金被派到低于下月工资+原料，随后无法采购/发薪，计划归零并破产。修复：`finance.companyDividendWorkingCapitalReserve` = 月工资 × `dividendReserveWageMonths`(2) + 计划原料缺口 × `dividendReserveMaterialMonths`(1) × 本城价；派息 = min(现金, 利润×比例, max(0, 现金−储备))。同时采购改为两阶段：阶段 A 全企业先买本地库存，阶段 B 跨城供给按剩余缺口比例分配（不再先到先得） | `tests/v12-food-chain-integration.test.ts`（可支付缺货→计划→真实采购→真实产出）、`tests/production-purchasing-fairness.test.ts`（3 项：本地优先、跨城按缺口比例、预算约束）、`tests/finance*`/`dividends*` 回归 | **机制达成；72 月宏观仍断（见 §5.3）** |
| §4 测试/旧档/72 月/桌面 | 全量测试、旧档兼容、72 月观察、桌面验收 | 全量 111 文件 / 859 项通过；旧 v9 实档读档/往返（`legacy-v09-save`、`legacy-v09-roundtrip-v12`、`save-format-script`）；72 月报告 exit 0；桌面 12/12、0 控制台错误 | §4 全部日志与 `docs/evidence_v1.2/` | **测试/桌面达成；72 月经济未达标** |
| 补充：创办上限 100 | 每城每月创办上限 4→100，且不能让上限变成“目标” | `config.lifecycle.maxFoundingsPerCityMonth = 100`（上限，不是目标）；`lifecycle` 逐次重评估、结构化 `recordFoundingStop` 原因、每次创办前检查 160 在营上限；新企业获得 bootstrap 生产计划（设备产能 × `minOutputRatio` 0.05）与 bootstrap 岗位；岗位数按设备可支撑计算（`outputPerEmployee`），不再用“等效工人”上限 | `tests/founding-cap-v12.test.ts`、`tests/founding-v1/v11/founding.test.ts`、`tests/v12-conservation-72m.test.ts`；72 月实跑：每月尝试 1–14 次、成立 0–2 家，上限未成为约束 | **上限达成；实际创办受资本/设备/原料约束（见 §6.2）** |

---

## 3. 数值校准表（原值 → 新值 / 理由 / 验证）

| 参数或规则 | 原值（v1.1 / 0fd4a0e） | 新值（v1.2） | 理由 | 验证 |
|---|---|---|---|---|
| `config.company.dividendReserveWageMonths` | 无（旧实现硬编码 0.5 × 月工资） | 2 | 派息前保留 2 个月工资，避免把下月工资派成股息 | `tests/dividends*`、`tests/v12-*`、72 月 t6 派息仍发生但现金未被派空 |
| `config.company.dividendReserveMaterialMonths` | 0（未计原料） | 1 | 再保留 1 个月计划原料采购额，保证下月能买料 | 同上；`tests/v12-food-chain-integration.test.ts` |
| 派息上限 | `min(现金, 利润 × 比例)` | `min(现金, 利润 × 比例, max(0, 现金 − 储备))` | 周转储备不可被股息侵占 | `tests/investor-dividends*`、`tests/finance*` |
| `config.government.companyPurchaseReserve` | `{wageMonths:2, materialMonths:1, debtServiceMonths:1}`（v1.1 起） | 不变；§2 起 `debtService` 改用 `nextLoanObligation().total`（含逾期本金/欠息） | 储备必须等于下一期真实义务 | `tests/bond-reserve-v12.test.ts`（9,100 vs 8,900） |
| `lifecycle.maxFoundingsPerCityMonth` | 4 | 100 | 上限而非目标；避免人为压住真实创办 | `tests/founding-cap-v12.test.ts`；72 月 attempts 1–14/月、成立 0–2/月 |
| 开局能源厂员工（`demo-data.ts` energy2 / energy3） | 800 / 700 | 300 / 260 | 能源产能约为需求 2 倍，长期压价、现金耗尽并挤占谷物能源 | 72 月 t1 能源需求/成交正常；`tests/opening-v09*` |
| `finance.ts` 经济亏损（`lossMonths` 口径） | `stats.profit` | `round2(stats.profit − stats.wageArrears)` | 欠薪企业不能靠“账面利润”无限续命，欠薪应计入经济亏损 | `tests/acceptance/bankruptcy-real-run.test.ts`、`tests/v11-economy*` |
| AI 创办出资人顺序 | `['investorGroup','company','government']` | `['investorGroup','government']` | `company` 出资会抽走经营现金，先伤食品/原料企业周转；显式 `founderType:'company'` 仍允许，但要求 2 个月工资缓冲 | `tests/founding*`；72 月 t6 创办 6/10/7（v1.1 20/20/20） |
| 新企业启动计划 | 无（首月常 0 产出） | 设备产能 × `config.production.plan.minOutputRatio`（0.05）的 bootstrap 计划 + bootstrap 岗位，并同步人口/群体 | 新企业首月应有真实计划与招聘，而不是空转 | `tests/founding-cap-v12.test.ts` |
| 计划/目标岗位上限 | 可超过设备所需 | `floor(equipmentLimit / outputPerEmployee(...))` | 防止“有岗位无设备”的过度招聘与工资空耗 | `tests/production-plan.test.ts`、`tests/companies*` |
| 销售量上限 | `reachableSales` | `min(reachableSales, outputQty)` | 不得卖出未生产的量 | `tests/production*` |

未改动：存档格式 9、债券票息/期限/兑付、破产判定与勾销、银行授信、股票撮合、工资稳定/奖金、经营者一家规则。

---

## 4. 测试与桌面验证

- `npx tsc --noEmit`：**0 错误**（`tsc -p tsconfig.json` + `tsc -p tsconfig.electron.json` 均通过；`npm run build` 的第一步就是 typecheck）。
- `HOME=/workspace/Coding/.home npm_config_cache=/workspace/Coding/.npm-cache npm run build`：**exit 0**（vite 86 modules，15.72s；Electron 主进程 tsc 通过）。日志 `/tmp/v12-build.log`。
- 全量测试（版本号已改为 1.2.0 后重跑）`npx vitest run --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000`：**111 文件 / 859 项全部通过，exit 0，251.89s**。其中新增 8 个 v1.2 文件：`bond-reserve-v12`、`founding-cap-v12`、`investor-dividend-attribution`、`legacy-v09-roundtrip-v12`、`production-purchasing-fairness`、`v12-conservation-72m`、`v12-cross-module`、`v12-food-chain-integration`；受影响套件（legacy-v09-save、save-format-script、acceptance 相关、founding、investor、bond、production-plan、bankruptcy-real-run）均通过。日志 `/tmp/v12-tests.log`。
- 72 月观察：`npx tsx scripts/economy-v09-report.ts --months=72 --checkpoints=1,6,12,24,36,72` **exit 0**，输出 `/tmp/v12-72m.txt`（454 行）；v1.1 基线为 `/tmp/v11-72m.txt`（同脚本、同种子、同 checkpoint）。
- 桌面验收：`DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs` **12/12 通过，consoleErrors = []**（Electron 38.8.6，`report.json` generatedAt `2026-11-04T17:09:25.830Z`）。证据：`docs/evidence_v1.2/report.json` + 7 张 PNG（v09-01…v09-07）。日志 `/tmp/v12-acceptance.log`（仅 dbus/GPU 噪声）。

---

## 5. 72 个月观察（种子 20261101、玩家无操作、默认 AI）

### 5.1 关键节点

| 月份 | 城市 | 人口 | 就业 | 失业率 | 月 GDP | 食品成交 / 需求 | 食品满足率 | 企业（累计成立/倒闭） | 历史破产 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 岚港 | 600,145 | 64,919 | 86.5% | 4.34 亿 | 6,739,519.5 / 6,769,558.7 | 99.6% | 21（0/0） | 0 |
| 1 | 铁谷 | 430,127 | 55,317 | 83.9% | 3.77 亿 | 4,750,520.8 / 4,841,411.4 | 98.1% | 22（0/0） | 0 |
| 1 | 青原 | 320,083 | 49,623 | 80.6% | 3.76 亿 | 3,271,680.0 / 3,913,974.5 | 83.6% | 22（0/0） | 0 |
| 6 | 岚港 | 600,298 | 60,191 | 87.5% | 3.35 亿 | 4,836,484.0 / 5,651,158.7 | 85.6% | 26（6/1） | 0 |
| 6 | 铁谷 | 430,284 | 52,180 | 84.8% | 2.77 亿 | 3,777,570.8 / 3,925,064.6 | 96.2% | 30（10/2） | 0 |
| 6 | 青原 | 321,258 | 38,280 | 85.1% | 1.99 亿 | 2,716,226.7 / 6,414,363.5 | 42.3% | 26（7/3） | 0 |
| 12 | 岚港 | 600,474 | 42,663 | 91.1% | 1.84 亿 | 2,014,207.5 / 11,645,382.4 | 17.3% | 28（11/4） | 0 |
| 12 | 铁谷 | 431,033 | 38,819 | 88.7% | 1.30 亿 | 1,602,710.8 / 8,239,845.6 | 19.5% | 25（14/11） | 0 |
| 12 | 青原 | 322,101 | 21,153 | 91.8% | 8,242.1 万 | 819,947.5 / 5,554,713.1 | 14.8% | 27（13/8） | 0 |
| 24 | 岚港 | 600,904 | 7,858 | 98.4% | 4,401.3 万 | 80,271.7 / 9,161,298.3 | 0.9% | 24（21/17） | 0 |
| 24 | 铁谷 | 433,093 | 7,528 | 97.8% | 5,849.2 万 | 336,929.2 / 6,576,591.7 | 5.1% | 19（21/23） | 0 |
| 24 | 青原 | 322,966 | 3,275 | 98.7% | 1,636.1 万 | 40,943.4 / 4,904,711.7 | 0.8% | 17（18/20） | 1（t21） |
| 36 | 岚港 | 601,497 | 13,819 | 97.1% | 4,632.1 万 | 238,143.1 / 9,141,209.4 | 2.6% | 38（25/18） | 1（t27） |
| 36 | 铁谷 | 434,780 | 12,506 | 96.4% | 1,680.0 万 | 0.0 / 6,691,033.1 | 0.0% | 29（20/22） | 1（t25） |
| 36 | 青原 | 323,699 | 7,131 | 97.2% | 1,217.3 万 | 19,799.8 / 4,914,119.2 | 0.4% | 27（15/20） | 1 |
| 72 | 岚港 | 604,927 | 6,474 | 98.7% | 2,353.3 万 | 0.0 / 9,214,350.3 | 0.0% | 17（29/33） | 4（27/46/58/66） |
| 72 | 铁谷 | 437,924 | 4,238 | 98.8% | 1,680.0 万 | 0.0 / 6,818,217.3 | 0.0% | 10（16/15） | 7（25/37/45/51/57/63/69） |
| 72 | 青原 | 327,108 | 6,426 | 97.5% | 1,480.1 万 | 46,990.8 / 4,964,218.1 | 0.9% | 17（15/12） | 3（21/45/62） |

居民现金/存款（t72）：岚港 54.33 亿 / 15.77 亿；铁谷 49.78 亿 / 12.74 亿；青原 27.30 亿 / 11.19 亿。

### 5.2 与 v1.1 基线（0fd4a0e）对比

| 指标 | v1.1 | v1.2 | 判断 |
|---|---|---|---|
| t6 失业率（岚港/铁谷/青原） | 79.3% / 69.5% / 73.5% | 87.5% / 84.8% / 85.1% | **更差**（+8.2 / +15.3 / +11.6pp） |
| t12 失业率 | 70.7% / 68.6% / 71.1% | 91.1% / 88.7% / 91.8% | **明显更差**（+20.4 / +20.1 / +20.7pp） |
| t72 失业率 | 98.7% / 98.2% / 96.7% | 98.7% / 98.8% / 97.5% | 持平或略差 |
| t72 食品满足率 | 0.0% / 0.0% / 23.8% | 0.0% / 0.0% / 0.9% | 岚港/铁谷持平为零，**青原更差** |
| t72 在营企业 | 46 / 29 / 40 | 17 / 10 / 17 | **明显更少** |
| t72 政府历史破产 | 4 / 4 / 1 | 4 / 7 / 3 | 岚港持平，**铁谷/青原更差** |
| t6 累计创办 | 20 / 20 / 20 | 6 / 10 / 7 | **显著更少** |
| t72 实体现金 | 7.20 / 5.28 / 4.01 亿 | 1,475 / 1,274 / 1,745 | 现金几乎全部转为股权/设备（非消失，见 §5.4） |
| 设备产业累计生产 | farm 90 / industry 107 / energy 42 台 | farm 73 / industry 63 / energy 38 台 | 略少 |
| 设备购置支出 / 出售收入 | 1.11 亿 / 3,574.6 万 | 7,598.4 万 / 1,325.8 万 | 规模缩小 |
| 居民→投资实体累计转入 | 4.25 / 2.73 / 4.23 亿 | 4.54 / 3.69 / 2.29 亿 | 岚港/铁谷增加，青原减少 |
| 股息收（返还/留存） | 8.29 亿（5.80/2.49）/ 4.40 亿（3.08/1.32）/ 10.19 亿（7.13/3.06） | 8.80 亿（6.16/2.64）/ 4.73 亿（3.31/1.42）/ 5.71 亿（4.00/1.71） | 青原明显减少（企业利润下降） |
| 企业购债 checkpoint 新认购 | 0 | 0 | 均无余钱；存量见 §5.4 |

### 5.3 食品链时间线（岚港，v1.2）

- t1：食品需求 6,769,558.7 / 成交 6,739,519.5（99.6%），价 52.3；企业利润 +1.48 亿、工资 2.88 亿、无欠薪。
- t6：需求 5,651,158.7 / 成交 4,836,484.0（85.6%），价 54.3；工资 3.07 亿、利润 +7,108.3 万、紧急裁员 320 人；本月创办 6 家。
- t12：需求 11,645,382.4 / 成交 2,014,207.5（17.3%），价 72.5；工资 1.96 亿、利润 −2,388.7 万、紧急裁员 5,859 人；谷物成交 1,296,021.9（缺 787,065.2）。
- t24：需求 9,161,298.3 / 成交 80,271.7（0.9%），价 121.0（价格上限）；全市计划产量 435,764、岗位 1,768；食品厂只剩 2 家；谷物需求 49,768.3（食品厂几乎不再采购）。
- t36：成交 238,143.1（2.6%）；计划产量 1,581,106；工资 4,222.1 万、利润 −1,572.5 万。
- t72：成交 0（0.0%），需求 9,214,350.3；食品厂 2 家，全市企业 17 家。

**断点解释（与 v1.1 的差别）**：v1.1 的断点是“盈利企业 100% 派息 → 周转金被派空”，v1.2 已在机制上堵住（t6 仍派息 4,335.2 万，但保留 2 月工资 + 1 月原料储备，现金 10.25 亿）。本样本里食品满足率仍在 t12 之后坍缩，直接数据是 t12 利润转负、工资 > 营收、紧急裁员 5,859 人，随后 t24 计划产量只剩 435,764。也就是说，**断点已从“派息抽干现金”转移到“需求不足 + 工资刚性”**；后者不是本轮股息/采购改动能单独闭合的。

### 5.4 居民投资、股息与购债（t72 累计）

| 城市 | 累计转入 | 期末实体现金 | 股息收（返还/留存） | 累计投资 | 购债新认购 |
|---|---|---|---|---|---|
| 岚港 | 4.54 亿 | 1,475 | 8.80 亿（6.16 / 2.64） | 11.22 亿 | 0 |
| 铁谷 | 3.69 亿 | 1,274 | 4.73 亿（3.31 / 1.42） | 8.06 亿 | 0 |
| 青原 | 2.29 亿 | 1,745 | 5.71 亿（4.00 / 1.71） | 7.91 亿 | 0 |

- 期末实体现金 ≈ 0 不是资金消失：累计投资（11.22 / 8.06 / 7.91 亿）大于累计转入与返还股息之和，实体把现金换成了新办企业股权与设备。后果是后期创办缺少现金缓冲，`workingCapital` 拒绝占比升高。
- 企业购债存量（active）：企业 1.50 亿 / 居民投资实体 1.60 亿；checkpoint 当月新认购均为 0（企业无余钱），但期中发生过真实认购，§2 储备规则在测试中单独锁定。

### 5.5 设备产业（v1.2 实跑）

- 9 家设备厂累计生产：农机 73 台、工业设备 63 台、能源设备 38 台；企业购置支出 **7,598.4 万**、设备出售收入 **1,325.8 万**（真实成交）。
- t72 企业设备存量（farm / industry / energy）：岚港 75 / 68 / 3；铁谷 58 / 0 / 0；青原 72 / 48 / 2。铁谷工业设备归零，与其 t72 只剩 10 家企业、月 GDP 1,680 万一致。
- t6/t12 设备购置：19.6/28.6/41.2 万、24.0/49.7/60.5 万；设备出售收入同期 19.6/19.6/19.6 万、16.8/24.5/24.5 万。

---

## 6. 已知问题（诚实清单）

1. **72 月仍收缩，且比 v1.1 差**：任务书两项观察目标（t12 食品 ≥90%、t24 失业较开局 −5pp）继续未达成；本报告不声称经济已稳定。
2. **创办显著减少**：AI 出资人去掉 `company` 后，t6 累计创办 6/10/7 家（v1.1 20/20/20）；投资实体现金又被新办企业/设备吸干，后期 `workingCapital` 拒绝增多。100 上限从未成为约束（每月尝试 1–14 次、成立 0–2 家）。是否恢复 `company` 出资（带 2 月工资缓冲）、或给投资实体保留现金，需要玩法决策。
3. **食品链仍未闭合**：股息储备修复了“盈利派息抽干周转金”，但 t12 起利润转负、工资 > 营收、计划坍缩；需求/工资刚性是主因，需要消费预算、工资或行业结构层面的决策。
4. **政府设备库存是全局池**：`equipmentMarket` 的政府设备库存在三城间共享（跨城购买计入同一池），若要求按城记账需另立机制。
5. **新办企业首月产出比例**：bootstrap 计划 = 设备产能 × 0.05，若设备交付/招聘在月内未完成，首月仍可能 0 产出；72 月运行未单独统计该比例，需后续加审计。
6. **投资实体几乎零现金、权益集中在股权/设备**：分红仍按份额返还，但实体没有现金缓冲，创办/设备采购受资本约束。
7. **企业购债在 checkpoints 上均为 0**：§2 的储备规则只在测试中验证（9,100 vs 8,900）；默认样本中企业无余钱，无法用实跑展示更多购债。
8. **政府破产更多**：铁谷 7 次、青原 3 次、岚港 4 次（v1.1 为 4/4/1）；t72 当前均 solvent，但这是反复勾销/重发后的状态，不代表财政改善。
9. **单一种子**：72 月为固定种子（20261101）单次观察，不能外推为概率结论；运行约 8 分钟。
10. **package-lock.json 版本字段仍为 0.8.3**（历史遗留，本轮未改，不影响构建/安装）。

---

## 7. Windows 复验步骤

```powershell
cd C:\CODING-worktrees\multi-city-sim
git fetch origin
git checkout feature/stock-market-ui-tax
git pull --ff-only
npm install
npm run typecheck
npm test
npm run build
node node_modules\electron\install.js   # 若安装脚本被 npm 策略拦截
node node_modules\esbuild\install.js
npm run dev
```

桌面逐项验收（无 Xvfb 的 Windows 真机可直接运行）：

```powershell
node scripts\acceptance-v09.cjs
```

预期：12/12 通过、0 控制台错误，截图与 `report.json` 写入 `docs\evidence_v1.2\`。

72 月观察：

```powershell
npx tsx scripts\economy-v09-report.ts --months=72 --checkpoints=1,6,12,24,36,72
```

---

## 8. Git 与 SHA

- 开工基线：`0fd4a0ead8020514657ac1f90942d1c0b1996b34`（v1.1 最终提交，远程一致）。
- 本轮提交（`git log --oneline 0fd4a0e..HEAD`）：
  - `a07022d` feat(sim)：v1.2 投资股息账本、购债逾期储备、食品链与创业修复（36 文件，+3,345/−266）
  - `d5fe737` test(acceptance)：v1.2 报告脚本与桌面证据（9 文件，+71/−2）
  - 本报告提交：docs：v1.2 交付报告、README 与版本 1.2.0
- 最终 SHA 与远程同步状态见 §9（推送后补记）。
- `main` 保持 `6c45000efc4c406d30e22c0a12bd066fc2df61f7`；未合并 main、未 force、未 rebase/amend；仓库内无 GitHub token 字面量，推送 token 仅作环境变量、临时文件已删除。

---

## 9. 最终状态

- 三阶段交付提交：`a07022d`（feat）、`d5fe737`（test）、`79ca6ea`（docs，本报告所在提交）。
- 最终交付 SHA：`79ca6ea41ae5e1690e27c860f9c83d65260f3ecf`。
- 推送核对：`origin/feature/stock-market-ui-tax` = `79ca6ea`（0fd4a0e..79ca6ea 已接受）；`main` = `6c45000efc4c406d30e22c0a12bd066fc2df61f7`。
- 本补记提交只更新本节与 token 措辞，其 SHA 见 `git log -1`；补记推送后远程 HEAD 指向该补记提交。
- `git status --short` 为空；`git grep` 无 GitHub token 字面量；token 临时文件已删除。
