# v1.1 交付报告：经济循环继续修复

> 分支：`feature/stock-market-ui-tax`（未合并 main）
> 验收基线：`c50e248cdd2823ae215e3989ebae2854962a0886`（v1.0）
> 交付日期：2026-11-04
> 存档格式：`SAVE_FORMAT_VERSION = 9`（v1.1 未改存档布局，新增字段均可选）；`GAME_VERSION = '1.1.0'`

---

## 0. 结论摘要（先说要害）

本轮按任务书 9 节完成了机制修复，测试、构建、桌面走查均通过，且**第 6–12 月的就业与食品供应较 v1.0 基线明显改善**；但**第 24 月后经济再次进入衰退，第 72 月仍未达到任务书的两项观察目标**。结论如实报告，不粉饰：

- 第 72 月（固定种子 20261101、玩家无操作、默认 AI）：失业率 98.7% / 98.2% / 96.7%，月 GDP 2,238.4 / 1,720.8 / 4,416.0 万，居民消费成交 160.9 / 0 / 3,335.8 万（期望 20.43 / 14.81 / 11.02 亿），食品满足率 0.0% / 0.0% / 23.8%，政府历史破产 4 / 4 / 1 次（当前均 solvent）。
- 观察目标核对：
  - “第 12 月基本食品有效需求满足率 ≥90%”：**未达成**（岚港 61.7%、铁谷 0.0%、青原 6.0%）。
  - “第 24 月失业率较开局下降 ≥5 个百分点”：**未达成**（t24 88.0% / 81.0% / 84.3%，t1 为 86.4% / 83.9% / 80.5%，即 +1.6 / −2.9 / +3.8 个百分点；仅铁谷下降 2.9pp）。
- 改善确实存在：t12 就业 140,527 / 108,963 / 74,136，较 v1.0 基线（42,346 / 30,785 / 11,107）提高约 3.3–6.7 倍；t12 失业率 70.7% / 68.6% / 71.1%，基线为 91.2% / 91.1% / 95.7%。设备产业、居民闲钱投资、创业小规模评估、缺货驱动的计划与采购均产生真实效果。
- 再次衰退的**直接机制**：第 6–12 月创办潮（每城累计 20 家）在需求饱和的行业（appliance / fiber-farm / utility / agriculture）堆高工资与债务，而非食品等紧缺环节；企业工资账单超过有效需求，出现大额欠薪（t12 3.03 / 3.74 / 2.90 亿）与紧急裁员（t12 当月 3,198 / 4,067 / 3,389 人），银行合同大面积违约（t12 defaulted 272 / active 118）；裁员又压低居民可支配收入（预算=0.8×收入+5%现金），需求进一步萎缩，最终食品企业现金耗尽、计划归零（t24 岚港食品需求 9,539,093、成交 0、价格 116.9，而食品企业现金 0、欠薪 1.95 亿），进入“欠薪→裁员→需求塌陷→滞销→更欠薪”的螺旋。
- 本轮未再修改用户明确决定的规则（银行无限但授信限制、破产判定与勾销、债券窗口与兑付、股票撮合、工资稳定与奖金规则、每经营者一家等）；已定位但不宜自行更改的结构性问题列在 §9。

---

## 1. 分支、基线与环境

- 仓库：`https://github.com/eojnus/multi-city-sim`，工作区 `/workspace/Coding/multi-city-sim`。
- 分支：`feature/stock-market-ui-tax`；开工基线 `c50e248`（v1.0）；`git fetch` 后远程同 SHA、`main` 仍 `6c45000`、无远程新提交、工作区干净。未新建分支、未合并 main、未 rebase/amend/force。
- 技术栈：TypeScript 5.9 + Phaser 3.90 + Electron 38.8 + Vite 7.3 + Vitest 3.2。
- 环境：`HOME=/workspace/Coding/.home`、`npm_config_cache=/workspace/Coding/.npm-cache`；Electron 用 `node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader`（Xvfb `:99`）；Vitest 用 `--maxWorkers=1 --testTimeout=180000 --hookTimeout=60000`（容器内存约束）。
- 版本：`GAME_VERSION` 由 1.0.0 升为 `1.1.0`，`package.json` 1.1.0；存档格式保持 9（新增字段均可选/有默认值，旧 v9 档可读）。

---

## 2. 技能（名称与来源）

- `find-skills`（vercel-labs/skills）
- `systematic-debugging`（obra/superpowers）
- `diagnosing-bugs`（mattpocock/skills）
- `typescript-advanced-types`（wshobson/agents）
- `verification-before-completion`（obra/superpowers）

本轮按“先取真实运行数据 → 改代码 → 复跑对比 → 再写结论”的流程执行；所有 72 月数值来自固定种子实跑，不是估算。

---

## 3. 任务书 9 节逐条对照

| 节 | 要求 | 本轮实现 | 证据 |
|---|---|---|---|
| 一 | 生产需求口径：不得用 `producerRequired − sold` 当有支付力缺货；区分计划需要/有效需求/缺货/资金不足/本地与跨城 | `production-plan.ts` 的 `cityShortageFor` 改为“有效需求口径”：`consumerDemand` / `producerDemand` 与 `unmetDemand` 取最大，不再用 `producerRequired`；跨城成交计入 `sold` 后再算缺口 | `src/simulation/companies/production-plan.ts`、`tests/production-demand-v11.test.ts`（10 项） |
| 二 | 居民闲钱投资：真实转账、保留 3 月生活费、每月 ≤1%、零收入可投、不可提存款/借贷、账本可审计、报告可追溯 | `collectInvestableFunds` 重写：0.5%→1%、取消“当月收入为零即不投”、按城市/群体真实现金转账（居民现金减 = 实体现金增）、新增 `HouseholdGroup.investorLedger` 与 `HouseholdState.investorFundingHistory/investorUsageHistory`、`investorFundingReport` 输出逐城/逐群体/逐月明细；修复 `investorCashOfCity` 误用居民群体现金导致“用途快照恒为 0” | `src/simulation/investors/investors.ts`、`tests/investor-funding-v11.test.ts`（8 项）、`tests/investor-funding.test.ts`（11 项） |
| 三 | 创业：真实机会评估、4/2/1 台最小规模、真实出资与合规贷款、原子回滚、每城每月 4 家、非玩家经营者一家 | `founding.ts` 11 维评估 + 1/2/4 台档位 + 真实授信贷款 + 结构化 `FoundingAttemptRecord`（障碍原因）；`foundCompany` 壳→贷款→买设备→出资→股份→补助，任一步失败全回滚；`maxFoundingsPerCityMonth` 2→4；保留 160 在营上限与经营者一家规则 | `src/simulation/companies/founding.ts`、`companies/lifecycle/lifecycle.ts`、`tests/founding-v11.test.ts`（9 项）、`tests/founding-v1.test.ts`（12 项） |
| 四 | 企业周转能力：开局结构保留；新企业购设备后保留“2 月基础工资 + 1 月计划原料”；开局企业按此重算 | `initializer.ts` 开局现金 = 月工资 × 2（`initialCashWageMonths` 1.6→2）+ 1 个月计划原料采购额；新创企业周转金校验在 founding 内执行；65 家结构不变 | `src/simulation/core/initializer.ts`、`scripts/opening-v1-report.ts`、`tests/opening-companies-v1.test.ts` |
| 五 | 企业购债储备：2 月工资 + 1 月原料 + 1 月已知贷款本息；不得贷款购债/占用已分配资金 | `companyPurchaseReserve` 1/1 → `{wageMonths:2, materialMonths:1, debtServiceMonths:1}`；`bondHolderAvailableCash` 按三项扣减；未售份数如实保留 | `src/simulation/government/bonds.ts`、`src/data/config.ts`、`tests/bond-reserve-v11.test.ts`（6 项） |
| 六 | 真实缺货带动存续企业恢复：计划纳入缺货/份额/库存/现金/信贷；招聘/采购/扩产优先级 | 计划 = 近 3 月销量参考 + 可支付缺货 × 份额 × 20% + （目标库存 − 库存），再 ±20% 平滑；扩产条件（连续利用率 ≥80%、库存 ≤1 月销量、保留 2 月工资 + 偿债）；招聘/采购/设备 reasons 透传 `ai.lastPlan.reasons` | `production-plan.ts`、`companies/planning.ts`、`companies/ai/strategy.ts`、`tests/production-plan.test.ts` |
| 七 | 设备产业：单位一致、真实原料/员工/库存/资金、资本品机会、需求/意向/成交分离、旧档兼容 | 沿用 v1.0 单位标定（设备产能 5/3/3 台/月/台设备、人均 0.15/0.08/0.09 台/月）；本轮验证真实生产—真实买方、跨城设备购买、撤单产能恢复、补贴失败回滚、旧 v9 档推进/存读档 | `scripts/equipment-economics.ts`、`tests/equipment-industry-v11.test.ts`（7 项）、`tests/equipment-economics.test.ts` |
| 八 | 消费与基本需求：失业有基本食品需求；现金→存款→贷款；非必需品不因失业归零；缺货/资金缺口分开；无成交不放贷 | 消费四层记录（desired/effective/sold/unmet）；基本需求不乘失业系数、可突破日常预算至基本需求成本或现金+可提存款上限；非基本需求 `affordability` 改为 `clamp(...,0,1)`（修复超预算被消费贷融资的 bug）；贷款只按实际成交额发放 | `src/simulation/markets/consumer.ts`、`tests/consumer-basics-v11.test.ts`（7 项） |
| 九 | 测试、72 月观察、桌面验收、推送与报告 | 全量 103 文件 / 816 项通过；72 月固定条件实跑；桌面 12/12；报告见 §5–§8 | 本报告、`docs/evidence_v1.1/` |

---

## 4. 数值校准表（原值 → 新值 / 理由 / 验证）

| 参数 | 原值（v1.0/c50e248） | 新值（v1.1） | 理由 | 验证 |
|---|---|---|---|---|
| `company.initialCashWageMonths` | 1.6 | 2.0 | 任务书 §4：新创/开局企业购设备后需保留 2 个月基础工资；叠加 1 个月计划原料，避免开局即现金紧张 | 开局报告：65 家现金合计提高；`tests/opening-companies-v1.test.ts`、全量 |
| 开局现金组成 | 月工资 × 月数 | 月工资 × 月数 + 1 个月计划原料采购额（初始化一次性） | 同上；运行中不无条件注资 | `scripts/opening-v1-report.ts`；t1 原料采购 4959 万（真实交易） |
| `lifecycle.maxFoundingsPerCityMonth` | 2 | 4 | 任务书 §3 | `tests/founding-v11.test.ts`、`tests/opening-v09.test.ts` |
| 创业规模档位 | 单一估算 | 4 / 2 / 1 台设备依资金降档 | 任务书 §3：大项目资本不足按最小可行规模重测 | `tests/founding-v11.test.ts`（9 项） |
| `investors.idleCashMonthlyInvestShare` | 0.5% | 1% | 任务书 §2 | `tests/investor-funding-v11.test.ts` |
| 投资零收入门槛 | 当月收入为 0 不投 | 取消；按闲钱（保留 3 月生活费）计算 | 任务书 §2 | 同上；t6 起逐月有真实转入 |
| `government.companyPurchaseReserve` | `{wageMonths:1, interestMonths:1}` | `{wageMonths:2, materialMonths:1, debtServiceMonths:1}` | 任务书 §5：不得占用已分配周转资金购债 | `tests/bond-reserve-v11.test.ts`（6 项） |
| 非基本消费 affordability | `clamp(..., minAffordability, 1)` | `clamp(..., 0, 1)` | 任务书 §8：非必需品可受收入影响，但不得被超出预算的消费贷融资 | `tests/consumer-basics-v11.test.ts`、`tests/household-consumption-loans.test.ts` |
| 生产缺货信号 | `producerRequired − sold`（含买不起的原料） | `consumerDemand/producerDemand + unmetDemand` 的有效需求口径 | 任务书 §1 | `tests/production-demand-v11.test.ts`（10 项） |

未改动的数值（保留并说明）：`company.initialInventoryMonths` 保持 1.2（0.5 实验未带来持续改善，且会让开局企业原料过薄）；设备单位标定沿用 v1.0；破产判定、银行授信、债券票息/兑付、股票撮合规则不变。

---

## 5. 测试与桌面验证

- `npx tsc --noEmit`：0 错误。
- `npm run build`：通过（渲染层 + Electron 主进程）。
- 全量测试 `npx vitest run --maxWorkers=1 --testTimeout=180000 --hookTimeout=60000`：**103 文件 / 816 项全部通过**（284.33s）。进程退出码为 1 的唯一原因是容器内存压力下的 vitest worker IPC 超时 `Timeout calling "onTaskUpdate"`（与断言无关；v1.0 亦复现，属运行环境限制）。
- 桌面验收 `node_modules/electron/dist/electron ... scripts/acceptance-v09.cjs`：**12/12 项通过、0 条控制台错误**；证据（7 张 PNG + `report.json`）写入 `docs/evidence_v1.1/`。本轮新增确认：t0 人口 600,000/430,000/320,000（×5）、非劳动 20%；界面买设备走真实企业卖方（市价 147,440、卖方库存 −1、卖方现金 +147,440）；二手挂单/撤单/买入；存读档 diffKeys 为空；1100×700 无横向溢出。
- 70/72 月观察：`npx tsx scripts/economy-v09-report.ts --months=72 --checkpoints=1,6,12,24,36,72` exit 0；输出含每城历史破产、居民投资转入/用途、企业购债、创业尝试与障碍、食品满足率、设备供需与设备产业累计。

---

## 6. 72 个月观察（种子 20261101、玩家无操作、默认 AI）

### 6.1 关键节点

| 月份 | 城市 | 人口 | 就业 | 失业率 | 月 GDP | 食品满足率 | 历史破产 |
|---|---|---|---|---|---|---|---|
| 1 | 岚港 | 600,145 | 65,184 | 86.4% | 4.43 亿 | 98.5% | 0 |
| 1 | 铁谷 | 430,127 | 55,521 | 83.9% | 3.86 亿 | 98.1% | 0 |
| 1 | 青原 | 320,083 | 49,926 | 80.5% | 3.84 亿 | 86.6% | 0 |
| 6 | 岚港 | 600,089 | 99,218 | 79.3% | 4.29 亿 | 87.0% | 0 |
| 6 | 铁谷 | 430,703 | 105,088 | 69.5% | 3.87 亿 | 98.8% | 0 |
| 6 | 青原 | 321,048 | 67,969 | 73.5% | 1.17 亿 | 27.1% | 0 |
| 12 | 岚港 | 599,661 | 140,527 | 70.7% | 3.38 亿 | 61.7% | 0 |
| 12 | 铁谷 | 433,139 | 108,963 | 68.6% | 2.05 亿 | 0.0% | 0 |
| 12 | 青原 | 320,923 | 74,136 | 71.1% | 6,955.4 万 | 6.0% | 0 |
| 24 | 岚港 | 599,835 | 57,493 | 88.0% | 4,653.3 万 | 0.0% | 0 |
| 24 | 铁谷 | 434,593 | 65,958 | 81.0% | 2,574.6 万 | 0.0% | 1（t23） |
| 24 | 青原 | 322,612 | 40,418 | 84.3% | 1.53 亿 | 25.5% | 0 |
| 36 | 岚港 | 601,263 | 16,395 | 96.6% | 2,552.1 万 | 0.0% | 1（t31） |
| 36 | 铁谷 | 435,679 | 29,463 | 91.5% | 3,519.7 万 | 0.0% | 1（t23） |
| 36 | 青原 | 323,312 | 22,847 | 91.2% | 8,390.0 万 | 14.2% | 0 |
| 72 | 岚港 | 605,472 | 6,187 | 98.7% | 2,238.4 万 | 0.0% | 4（31/44/56/66） |
| 72 | 铁谷 | 438,832 | 6,241 | 98.2% | 1,720.8 万 | 0.0% | 4（23/45/59/71） |
| 72 | 青原 | 325,846 | 8,545 | 96.7% | 4,416.0 万 | 23.8% | 1（t64） |

### 6.2 与 v1.0 基线（c50e248）对比

| 指标 | v1.0 基线 | v1.1 | 判断 |
|---|---|---|---|
| t12 就业（岚港/铁谷/青原） | 42,346 / 30,785 / 11,107 | 140,527 / 108,963 / 74,136 | 明显改善（3.3–6.7 倍） |
| t12 失业率 | 91.2% / 91.1% / 95.7% | 70.7% / 68.6% / 71.1% | 改善 20–25pp |
| t72 失业率 | 95.3% / 95.1% / 94.9% | 98.7% / 98.2% / 96.7% | 略差 |
| t72 居民消费成交 | 1,644.9 / 537.0 / 2,046.8 万 | 160.9 / 0 / 3,335.8 万 | 岚港/铁谷更差，青原改善 |
| t72 食品满足率 | 1.4% / 0.7% / 3.4%（成交/需求） | 0.0% / 0.0% / 23.8% | 青原改善，岚港/铁谷更差 |
| 设备产业累计 | 生产 60/39/36 台、出售收入 656.9 万 | 生产 90/107/42 台、购置 1.11 亿、出售收入 3,574.6 万 | 明显扩大且真实成交 |
| 居民→投资实体 | 0.5% 口径、规模小 | 累计转入 4.25 / 2.73 / 4.23 亿；实体现金 7.20 / 5.28 / 4.01 亿；累计投资 7.92 / 7.08 / 14.77 亿 | §2 机制生效 |
| 创业 | 60 家成立 | 80 次尝试（56 成立 / 24 被拒，障碍全部 `workingCapital`） | 小规模可创办，资本仍是最常见障碍 |
| 企业购债（72 月） | 企业认购挤占经营现金（t10 单企 33.47M） | 企业新认购 0；居民投资实体持债 2.81 亿 | §5 储备规则生效（但企业也无余钱） |
| 政府历史破产 | 1 / 4 / 3 | 4 / 4 / 1 | 岚港、青原变化，铁谷持平 |

### 6.3 食品链时间线（岚港）

- t1：食品需求 6,985,968 / 成交 6,878,880（98.5%），价格 52.3；食品厂满产，现金 3.55 亿。
- t6：需求 6,126,941 / 成交 5,332,917（87.0%）；当月紧急裁员 3,264 人，企业工资 4.37 亿、利润 −558.1 万、欠薪 4,895.3 万。
- t12：需求 6,541,939 / 成交 4,036,398（61.7%），价格 57.5；谷物需求 2,529,674、成交 2,332,198（可采购）；企业利润 −9,605.1 万、欠薪 3.03 亿、紧急裁员 3,198 人；银行合同 defaulted 272 / active 118。
- t24：需求 9,539,093 / 成交 0，价格 116.9；谷物需求 0（无生产计划）、库存 762,084；食品企业现金 1.05 亿、欠薪 1.95 亿；岚港食品厂员工 16,149、设备 23 台、计划 387,780、现金 0。
- t27：岚港食品厂（首发食品企业）倒闭；t36 岚港食品满足率 0.0%，只剩 2 家食品企业。

### 6.4 设备产业链（v1.1 新验证）

- 9 家设备厂累计生产：农机 90 台、工业设备 107 台、能源设备 42 台；企业购置支出 1.11 亿、设备出售收入 3,574.6 万。
- 逐厂真实售出：岚港农机 51 台（生产 46）、铁谷工业 44（43）、青原工业 41（41）、岚港工业 25（23）、青原农机 26（22）、铁谷农机 26（22）、铁谷能源 17（15）、青原能源 17（14）、岚港能源 15（13）。
- 结论：**自然状态下已有“设备厂真实生产并卖给真实买方”**，不依赖构造场景；设备资本化审计、撤单产能恢复、补贴失败回滚、跨城设备运输均在测试与运行中成立。

---

## 7. 实现位置（主要文件）

- 生产需求口径与计划：`src/simulation/companies/production-plan.ts`、`src/simulation/companies/planning.ts`、`src/simulation/companies/ai/strategy.ts`
- 居民闲钱投资：`src/simulation/investors/investors.ts`
- 创业与生命周期：`src/simulation/companies/founding.ts`、`src/simulation/companies/lifecycle/lifecycle.ts`
- 企业购债储备：`src/simulation/government/bonds.ts`、`src/data/config.ts`
- 消费与基本需求：`src/simulation/markets/consumer.ts`、`src/simulation/population/household-finance.ts`
- 开局现金与周转：`src/simulation/core/initializer.ts`、`src/data/demo-data.ts`
- 报告脚本：`scripts/economy-v09-report.ts`（v1.1 新增居民投资/购债/创业尝试/食品满足率）、`scripts/opening-v1-report.ts`、`scripts/equipment-economics.ts`
- 测试：`tests/production-demand-v11.test.ts`、`tests/investor-funding-v11.test.ts`、`tests/founding-v11.test.ts`、`tests/bond-reserve-v11.test.ts`、`tests/consumer-basics-v11.test.ts`、`tests/equipment-industry-v11.test.ts`、`tests/v11-economy.test.ts`、`tests/v11-behaviors.test.ts`，以及按 v1.1 行为更新的既有测试（bankruptcy 序列重锁、旧档推进阈值、整数分股、融资触发前提等）。

---

## 8. 数据口径与来源

- 人口/就业/失业：`city.population`（就业=企业员工+公共岗位，失业=劳动力−就业，非劳动 20%）；失业率 = 失业 /（就业+失业）。
- 消费：`household.lastMonth`（成交/期望/资金缺口/存款提取）与 `city.market[good]`（供给/需求/成交/缺货/跨城进口/期末库存/价格）；“食品满足率”= 食品成交 / 食品有效需求。
- 企业：`company.lastMonth`（营收/原料/工资含奖金/利息/税/利润/现金/债务/欠薪/设备购置/出售）、`world.lifecycle`（成立/倒闭，上限 60 条）。
- 居民投资：`world.households.investorFundingHistory/investorUsageHistory`（逐月逐城转入、股息收/返还/留存、用于投资额）、`group.investorLedger`（逐群体投入/份额/股息归属）。
- 购债：`world.bonds.holdings`（按 holder 类型与 status 汇总；本月新认购按 `purchasedTick` 统计，合并持仓可能低估，故同时给出存量）。
- 创业：`world.lifecycle.foundingAttempts`（成立/被拒与障碍原因）。
- 财政：`city.government`、`world.fiscal.ledger`（窗口上限 800）、`world.taxes.historyByCity`（12 个月窗口）、`city.government.records`（破产历史，上限 8）。
- 设备：`world.equipmentMarket`（政府库存/二手挂单/pendingLedger）、`company.equipment*`、`ProductionRecord`。

---

## 9. 未解决问题与需要用户决策的冲突（诚实清单）

1. **创办潮与需求结构错配**：t6 前每城累计成立 20 家，行业集中在 appliance / fiber-farm / utility / agriculture；工资账单（t6 4.37 亿）与有效消费需求（成交 3.72 亿）不匹配，利润转负后靠银行/债券融资维持，最终大规模欠薪与裁员。是否需要在创业评估中显式约束“行业有效需求/工资成本比”或限制低需求行业的创办数量，需要玩法决策。
2. **居民预算公式抑制需求**：预算 = 0.8×收入 + 5% 现金（基本需求可突破），在有 38 亿现金/15 亿存款的 t24，需求仍因收入崩塌而萎缩（成交 624 万 vs 期望 18.97 亿）。这符合“预算不是资金硬上限”的既有定义，但也是衰退放大器；是否允许更多动用存款/财富消费，需要用户确认。
3. **企业购债虽被储备规则约束，但企业全程无余钱认购**（企业 0 / 投资实体 2.81 亿），原“购债抽走周转金”问题在 v1.1 默认样本中未再出现（无余钱）；若经济改善后企业有盈余，储备比例是否足够需再观察。
4. **食品链二次断裂的精确触发点**：t12 仍有 61.7% 满足率且谷物可采购，t24 食品成交归零、价格 116.9、食品企业计划 387,780/现金 0/欠薪 1.95 亿。当前证据指向“工资账单→欠薪→裁员→需求塌陷”，但欠薪起点（t12 3.03 亿）与银行 defaulted 272 笔的先后关系需更细粒度记账才能完全归因；本轮未改工资/裁员规则。
5. **创业拒绝全部因 `workingCapital`**（24 次）：小规模档位已实现，但最小规模仍要求真实设备+原料+2 月工资+1 月原料周转，资金不足时只能拒绝；是否放宽“最小可行规模”或引入联合出资更多档位，需要用户确认。
6. **破产后政府持股**：最终代码下破产城市会重新创办企业并持有 primary 股份（铁谷 co-ironvale-89、青原 co-greenfield-87）。当前产品逻辑允许政府创办企业，故测试按现状锁定；若“政府不应持股”是目标规则，需用户明确。
7. **观察目标未达成**：第 12 月食品满足率 90%、第 24 月失业率较开局下降 5pp 均未实现；本报告给出数据与机制解释，不声称经济已稳定。
8. **环境限制**：全量 vitest 在容器内存压力下出现 worker IPC 超时（断言全绿、退出码 1）；Windows 真机复验需按 §10 执行。

---

## 10. Windows 复验步骤

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

预期：12/12 通过、0 控制台错误，截图与 `report.json` 写入 `docs\evidence_v1.1\`。

72 月观察：

```powershell
npx tsx scripts\economy-v09-report.ts --months=72 --checkpoints=1,6,12,24,36,72
```

---

## 11. Git

- 开工基线：`c50e248cdd2823ae215e3989ebae2854962a0886`（v1.0，远程一致）。
- 本轮提交（`git log --oneline c50e248..HEAD`）：
  - `0c7cac6` feat(sim)：v1.1 经济循环继续修复（src + 测试，29 文件改动、8 个新测试文件）
  - `e5f7dc9` test(acceptance)：v1.1 报告脚本字段与桌面验收证据
  - `2274b31` docs：v1.1 交付报告、README 与版本 1.1.0
- 最终 SHA：`2274b31917a63999b2e1c2f683ef19d738703521`；远程 `feature/stock-market-ui-tax` 同 SHA，`main` 仍 `6c45000efc4c406d30e22c0a12bd066fc2df61f7`，工作区干净。
- 未合并 main、未 force、未 rebase/amend；仓库内无 GitHub token 字面量。
- 推送使用细粒度 PAT（仅环境变量，不落盘，临时文件已删除）；推送后建议在 GitHub 撤销该 token。
