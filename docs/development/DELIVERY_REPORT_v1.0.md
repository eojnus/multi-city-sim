# v1.0 交付报告：经济循环修复与扩充

> 分支：`feature/stock-market-ui-tax`（未合并 main）
> 验收基线：`99ed1e7020a736af8892861e9198e201cb0c37cf`（v0.9 第二轮）
> 交付日期：2026-11-04
> 存档格式：`SAVE_FORMAT_VERSION = 9`（v1.0 未再改格式；旧 v8/v9 存档可读）、`GAME_VERSION = '1.0.0'`

---

## 0. 结论摘要（先说要害）

本轮按任务书 13 节完成了机制层的主体修复与扩充，测试、构建、桌面走查均通过。**但默认世界在第 72 月仍然处于高失业、必需品供应不足、政府反复破产的状态，没有达到“经济循环稳定”的效果**，这一点如实报告，不做粉饰：

- 第 72 月失业率：岚港 95.3% / 铁谷 95.1% / 青原 94.9%；月 GDP 4,407.8 / 2,864.8 / 4,525.0 万；居民消费 1,644.9 / 537.0 / 2,046.8 万，对应期望 20.52 / 14.89 / 11.00 亿。
- 第 72 月食品：需求 9,262,204 / 6,681,234 / 4,928,646 单位，成交 133,373 / 44,380 / 169,160，**缺货率 98%+**；食品价格被顶到上限 121.0。
- 政府历史破产：岚港 1 次（t68）/ 铁谷 4 次（t17/31/48/70）/ 青原 3 次（t16/31/65），第 72 月三城均 solvent。
- 企业创办 60 家 / 倒闭 60 家；岚港食品厂（首发食品企业）在第 68 月倒闭。
- 信用体系恶化：银行合同 1,102 笔，其中 defaulted 835 笔、active 46 笔。

机制层已交付并可用真实数据追溯：65 家开局企业（每城原有 17→新增 16）、三类设备的真实单位经济与真实生产/出售、生产计划纳入缺货信号与信贷约束、消费资金顺序与本地优先、居民闲钱投资实体、旧 v0.9 存档兼容、72 月报告口径修复。**经济仍崩溃的根因是结构性的**（人口 ×5 与私营岗位/产能不匹配、销量锚计划的路径依赖、资本品需求信号缺失、企业认购国债抽走经营现金），不是单点 bug；本轮已把可修的机制修掉、把不可自行决定的规则冲突列出（§9）。

---

## 1. 分支、基线与环境

- 仓库：`https://github.com/eojnus/multi-city-sim`，工作区 `/workspace/Coding/multi-city-sim`。
- 分支：`feature/stock-market-ui-tax`；基线（开工前）`99ed1e7`；`git fetch` 后远程同 SHA、`main` 仍 `6c45000`、无远程新提交、工作区干净。未新建分支、未合并 main、未 rebase/amend/force。
- 技术栈：TypeScript 5.9 + Phaser 3.90 + Electron 38.8 + Vite 7.3 + Vitest 3.2。
- 运行环境：`HOME=/workspace/Coding/.home`、`npm_config_cache=/workspace/Coding/.npm-cache`；Electron 用 `node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader`；Vitest 用 `--maxWorkers=1 --testTimeout=60000`（内存约束）。
- 存档：`SAVE_FORMAT_VERSION` 保持 9（v1.0 未改变存档布局；新增 `equipmentCapacityRemainder` 等字段为可选/带默认值）；`GAME_VERSION` 升到 `1.0.0`。

---

## 2. 技能（名称与来源）

- `find-skills`（vercel-labs/skills）
- `systematic-debugging`（obra/superpowers）
- `diagnosing-bugs`（mattpocock/skills）
- `typescript-advanced-types`（wshobson/agents）
- `verification-before-completion`（obra/superpowers）
- `systematic-debugging` 与 `verification-before-completion` 在本轮主要用于“先取真实运行数据、再改代码、改完复跑”的流程约束。

---

## 3. 任务书 13 节逐条对照

| 节 | 要求 | 本轮实现 | 证据 |
|---|---|---|---|
| 一 | Git 检查、不合并 main、不 force、数值可校准须列原值/新值/理由 | 开工前检查通过；全程未动 main；校准见 §4、§8 | Git 记录见 §11 |
| 二 | 人口 ×5；每城新增 16 家企业（17→65）；真实资产；旧档不新增 | `OPENING_COMPANIES` 48 家 + 原 17 家 = 65；全部有员工/现金/设备/库存/股份；旧档迁移路径不经过 initializer 新增分支 | `scripts/opening-v1-report.ts`、`tests/opening-companies-v1.test.ts` |
| 三 | 每城 16 家行业分布；世界有真实设备生产者；规模按需求/产能/原料/劳动/资金 | 每城：食品 3、谷物 3、能源 2、金属 1、设备 3（三类各 1）、纤维/纺织/服装/日用品 4；9 家设备厂 | 同上 + 开局数据表（§4） |
| 四 | 居民现金/存款/基本需求/资金顺序/无供给不成交 | 沿用并加固 v0.9 的顺序（现金→存款≤5%→消费贷）；本轮新增基本需求不乘失业系数、基本需求可突破日常预算至基本需求成本；修复“无现金但有授信”被自指额度回滚的 bug | `src/simulation/markets/consumer.ts`、`tests/consumer-basic-needs.test.ts`、`tests/household-consumption-loans.test.ts` |
| 五 | 居民积蓄→投资实体：真实资金、保留 3 月生活费、每月 0.5% | 重写 `collectInvestableFunds`：按城市/群体实际现金评估，保留 3 个月基本生活费，超出部分每月最多 0.5%，居民现金减、实体现金同额增，失业/非劳动闲置为 0 | `src/simulation/investors/investors.ts`、`tests/investor-funding.test.ts`（11 项） |
| 六 | 食品价格/需求/创业：真实评估、最小规模、真实贷款、障碍记录 | `founding.ts` 11 维评估（价格趋势/可支付缺货/销量/库存/竞争者/原料/设备/劳动力/运输/融资/预期利润）、1/2/4 台档位、真实授信贷款、结构化 `foundingAttempts` 记录障碍；每城每月 ≤2、160 上限 | `src/simulation/companies/founding.ts`、`tests/founding-v1.test.ts`（12 项） |
| 七 | 生产计划纳入缺货/份额/库存/资金/信贷；扩产条件；招聘 vs 采购 | `cityShortageFor` + `companyDemandShare`（产能份额+销量份额各 50%）×20% 吸收；计划纳入 `workingCapitalRoom`（真实授信）；扩产要求连续利用率≥80%、库存≤1 月、保留 2 月工资+偿债 | `production-plan.ts`、`planning.ts`、`tests/production-plan.test.ts`（15 项） |
| 八 | 工资稳定、奖金、裁员 | v0.9 的季度奖金/常规 8%/紧急 30% 裁员保留并经 v1.0 回归验证 | `finance.ts`、`labor.ts`、`tests/labor*.test.ts` |
| 九 | 设备单位不一致修复；三类单位经济 10–20%；真实生产/买卖 | 统一语义：`capacityPerUnit` = 每台设备等效标准工人月数（farm 8 / industry 13 / energy 11）；产能 = 台数 × 等效工人 × 该产品人均产量；设备人均产量 0.15/0.08/0.09 台/月；单位经济利润率 18.0% / 18.8% / 16.9% | `src/simulation/equipment/equipment.ts`、`scripts/equipment-economics.ts`、`tests/equipment-economics.test.ts` |
| 十 | 旧 v0.9 存档兼容（真实旧档 fixture） | 用真实 f942cc9 存档生成 fixture；`normalizeLegacyV09World` 补齐 `equipmentCapacityRemainder`、`pendingLedger`，幂等、不改资金/人口/rng；`validateCompany` 允许缺省余量 | `tests/legacy-v09-save.test.ts`（8 项）、`tests/fixtures/v0.9-real-f942cc9.json` |
| 十一 | 政府/银行/股票等既有规则不回退 | 未改破产判定、兑付、债券窗口、授信、股票撮合规则；全部回归通过 | 全量测试 + acceptance |
| 十二 | UI 可观察性 | 企业设备/计划/成本、人口需求 vs 成交、市场缺货、AI 计划原因（reasons）、设备来源（本城/政府/跨城/二手）、居民基本需求与消费贷 | `src/ui/panels.ts`、`src/app/gameStore.ts`、`tests/ui-*.test.ts` |
| 十三 | 构建/测试/72 月/设备厂真实交易/桌面证据/最终报告 | 全部执行；72 月结论如实报告（未达标）；设备厂自然真实交易已发生（无需构造场景） | §5、§6、§7 |

---

## 4. 开局产业与单位经济（实际数据）

### 4.1 开局企业数与行业分布（65 家）

| 城市 | 企业数 | 行业分布（开局） | 就业 / 失业（t1） |
|---|---|---|---|
| 岚港 | 21 | food×4 / agriculture×3 / equipment×3 / utility×3 / appliance×2 / garment×2 / textile×2 / fiber-farm×1 / metal×1 | 64,074 / 416,042（86.7%） |
| 铁谷 | 22 | food×4 / agriculture×3 / equipment×3 / utility×3 / appliance×2 / garment×2 / metal×2 / textile×2 / fiber-farm×1 | 55,061 / 289,041（84.0%） |
| 青原 | 22 | food×4 / agriculture×4 / equipment×3 / utility×3 / appliance×2 / fiber-farm×2 / garment×2 / metal×1 / textile×1 | 49,195 / 206,871（80.8%） |

> 注：表中“21/22”是 t1 已发生 1 家创办/清算后的数量；开局初始化为 65 家（17+48）。世界共有 9 家设备厂（三城 × 农机/工业/能源），是本轮新增的真实资本品生产者。

### 4.2 三类设备单位经济（60 员工、岚港技术系数 1.124、满负荷）

| 设备 | 售价 | 材料+能源 | 月产（台） | 工资/台 | 单位收益 | 利润率 |
|---|---|---|---|---|---|---|
| 农业设备 | 120,000 | 72,000 | 10.93 | 26,378 | 21,622 | 18.0% |
| 工业设备 | 200,000 | 113,000 | 5.83 | 49,459 | 37,541 | 18.8% |
| 能源设备 | 160,000 | 89,000 | 6.56 | 43,964 | 27,036 | 16.9% |

设备厂：2 台自身设备 → 产能 11.24 / 6.74 / 6.74 台/月；建议初始现金 1,152,760（4×月工资，已由 `OPENING_COMPANIES` 的 `cashMonths: 4` 落实）。普通商品仍为 300,000 产出单位/台设备/月，不再混用。

### 4.3 开局岗位与产能

- 岚港：私营就业 61,480 + 公共 5,000；食品产能 5,732,400、谷物 3,709,200；新增设备厂各 2 台工业设备、产能 7–11 台/月。
- 人口口径：总人口 = 就业 + 失业 + 非劳动（劳动人口 80%、非劳动 20%），企业员工与公共岗位不重复；t1 人口 600,145 / 430,127 / 320,083。

---

## 5. 测试与验证（实际执行）

- `npx vitest run --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000`：**95 文件 / 754 项通过**（本轮最终结果见 §11 提交前复核；若有变化以提交前最后一次为准）。
- `npx tsc --noEmit`：0 错误。
- `npm run build`：成功（Vite 客户端 + Electron 主进程/预加载）。
- 新增/更新的关键测试：
  - 开局：`tests/opening-companies-v1.test.ts`（6 项）、`tests/opening-v09.test.ts`（改为 65 家）
  - 设备：`tests/equipment-economics.test.ts`（5 项）、`tests/equipment-market.test.ts`、`equipment-subsidy`、`equipment-intercity`
  - 创业：`tests/founding-v1.test.ts`（12 项）
  - 计划：`tests/production-plan.test.ts`（15 项）
  - 消费：`tests/consumer-basic-needs.test.ts`、`consumer-funding-order`、`consumer-fairness`、`household-consumption-loans`
  - 投资实体：`tests/investor-funding.test.ts`（11 项）
  - 旧档：`tests/legacy-v09-save.test.ts`（8 项，真实 f942cc9 存档）
  - 验收：`tests/acceptance/bankruptcy-real-run.test.ts`（36 月真实序列 + 守恒断言）、`settlement-resume`（H08/H09）
- 数值漂移说明：v1.0 改变了开局企业数、设备单位、计划与消费逻辑，36 月/72 月确定性序列与 v0.9 不同；`bankruptcy-real-run` 的“月份/比率/金额”锁值由真实运行重新生成，守恒与结构断言原样保留（未删除、未放宽为“只检查存在”）。

### 桌面验收（真实 Electron）

- `scripts/acceptance-v09.cjs`（v0.9 验收脚本）在 v1.0 代码上重跑：12 项检查通过、0 控制台错误；证据更新到 `docs/evidence_v0.9/`（7 张 PNG + `report.json`）。
- 覆盖：开局人口结构 600,145（就业/失业/非劳动）、人口“需求 vs 成交”、企业设备表与生产计划（含计划理由）、界面购买设备（政府储备目录价 160,000 与市价 152,000 的差异）、二手设备挂单/买入、股票窗口、存读档一致（diffKeys []）、1100×700 无横向溢出、零控制台错误。
- 说明：v1.0 的 65 家开局与设备产业在同一套面板中可观察，脚本检查项仍全部适用，故未另写一套桌面脚本。

---

## 6. 72 个月固定条件观察（种子 20261101、玩家无操作、默认 AI）

### 6.1 人口/就业/GDP/负债

| 月 | 城市 | 人口 | 就业 | 失业率 | 月 GDP | 负债率 | 历史破产 |
|---|---|---|---|---|---|---|---|
| t1 | 岚港 | 600,145 | 64,074 | 86.7% | 4.43 亿 | 0.0% | 0 |
| t1 | 铁谷 | 430,127 | 55,061 | 84.0% | 3.86 亿 | 0.0% | 0 |
| t1 | 青原 | 320,083 | 49,195 | 80.8% | 3.84 亿 | 0.0% | 0 |
| t12 | 岚港 | 600,697 | 42,346 | 91.2% | 7,634.5 万 | 12.9% | 0 |
| t12 | 铁谷 | 431,724 | 30,785 | 91.1% | 2,921.8 万 | 24.1% | 0 |
| t12 | 青原 | 321,087 | 11,107 | 95.7% | 1,476.1 万 | 35.6% | 0 |
| t24 | 岚港 | 601,085 | 36,327 | 92.4% | 8,776.3 万 | 86.7% | 0 |
| t24 | 铁谷 | 434,028 | 28,444 | 91.8% | 1,907.3 万 | 40.0% | 1 |
| t24 | 青原 | 321,774 | 12,492 | 95.1% | 1,190.5 万 | 52.6% | 1 |
| t36 | 岚港 | 602,148 | 33,554 | 93.0% | 7,640.3 万 | 52.0% | 0 |
| t36 | 铁谷 | 435,424 | 18,608 | 94.7% | 2,161.2 万 | 36.8% | 2 |
| t36 | 青原 | 322,558 | 10,800 | 95.8% | 977.2 万 | 26.5% | 2 |
| t72 | 岚港 | 605,966 | 22,976 | 95.3% | 4,407.8 万 | 16.2% | 1（t68） |
| t72 | 铁谷 | 439,584 | 17,305 | 95.1% | 2,864.8 万 | 13.1% | 4（t17/31/48/70） |
| t72 | 青原 | 324,677 | 13,142 | 94.9% | 4,525.0 万 | 14.3% | 3（t16/31/65） |

### 6.2 消费与食品（t72）

| 城市 | 消费成交 | 期望消费 | 食品需求 | 食品成交 | 食品缺货 | 食品价 |
|---|---|---|---|---|---|---|
| 岚港 | 1,644.9 万 | 20.52 亿 | 9,262,204 | 133,373 | 9,128,832 | 121.0 |
| 铁谷 | 537.0 万 | 14.89 亿 | 6,681,234 | 44,380 | 6,636,854 | 121.0 |
| 青原 | 2,046.8 万 | 11.00 亿 | 4,928,646 | 169,160 | 4,759,486 | 121.0 |

居民现金：38.81 / 35.14 / 28.95 亿；存款：15.58 / 13.29 / 11.60 亿 —— **消费低迷不是“没钱”，而是没有可供购买的商品**（缺货量≈全部有效需求、期末库存 0）。

### 6.3 企业、设备产业、创办倒闭（t72）

- 企业数：岚港 75 / 铁谷 52 / 青原 31；累计成立 37/12/11，累计倒闭 32/20/8；岚港食品厂 t68 倒闭。
- 设备产业累计：生产农机 60 台 / 工业设备 39 台 / 能源设备 36 台；企业购置支出 4,382.5 万；设备出售收入 656.9 万。
- **设备厂真实生产→卖给真实买方（自然发生，非构造）**：岚港农机累计售出 24 台、青原农机 14 台、铁谷农机 14 台；铁谷工业 6 台、铁谷能源 6 台、青原工业 3 台、岚港工业 2 台。
- 银行（t72）：存款 40.62 亿；贷款未偿 3.22 亿；合同 1,102 笔（active 46 / defaulted 835 / repaid 221）。

---

## 7. 食品链与设备链时间线

### 7.1 食品链（岚港，t1–t72）

- t1：食品需求 7,319,669 / 成交 6,878,880（缺货 4.4%），食品厂满产（4,046,400 产能、12 台设备）。
- t2–t10：食品价格从 52.5 缓慢上行；期间食品企业现金流被“工资 + 原料 + 股息 + 国债认购”多重挤压。
- t11 起：谷物/能源采购不足（当地谷物企业设备产能远大于实际劳动产能、招聘速度跟不上），食品产量下滑。
- t12：食品需求 11,861,189 / 成交 0；t1 的 4 家食品企业到 t12 只剩 3 家，岚港仅 1 家。
- t24 / t36：食品成交维持在 0–83 万（需求 900 万+），价格 121（上限）。
- t68：岚港食品厂（首发企业）倒闭；t72 食品成交 133,373 / 需求 9,262,204。
- 结论：**食品链断裂的触发点不是需求，而是“有设备、有失业人口、但企业现金被工资/国债/原料锁死 → 计划收缩 → 裁员 → 需求下降”的正反馈**；详见 §8。

### 7.2 设备链

- 新单位标定后，设备厂在 t1 即有真实供给与真实成交（t1 岚港农机库存 13.5 台；t2 起新创办企业购买设备）。
- t72 设备产业累计生产 135 台（60+39+36），企业购置支出 4,382.5 万；农机类设备成交最活跃（农机 60 台产量里售出 52 台）。
- 能源设备成交最少（岚港/青原能源设备厂累计售出 0），因为能源企业数量与扩产意愿最低，属真实需求不足，不是账本丢失（设备市场账本已改为 pending 合并并可读）。

---

## 8. 本轮修复的机制位置（文件清单）

| 主题 | 文件 |
|---|---|
| 开局 65 家 | `src/data/demo-data.ts`（`OPENING_COMPANIES`）、`src/simulation/core/initializer.ts` |
| 设备产业/单位 | `src/simulation/contracts/types.ts`（`SectorId 'equipment'`、`equipmentCapacityRemainder`、`capitalizedThisTick`）、`src/simulation/equipment/equipment.ts`、`src/data/config.ts`（`outputCapacityPerUnit`、`unitsPerWorkerMonth`）、`src/simulation/core/invariants.ts`（独立推导校验）、`src/simulation/core/save.ts`（迁移/校验） |
| 设备审计 | `src/simulation/core/simulation.ts`（`capitalized` 扣减）、`src/simulation/markets/markets.ts`（pendingLedger 合并） |
| 创业 | `src/simulation/companies/founding.ts`、`src/simulation/companies/lifecycle/lifecycle.ts`（`foundCompany` v1 路径） |
| 生产计划 | `src/simulation/companies/production-plan.ts`（缺货信号/份额/信贷约束）、`src/simulation/companies/planning.ts` |
| 消费 | `src/simulation/markets/consumer.ts`（两阶段本地优先、资金顺序、贷款快照口径）、`src/simulation/population/household-finance.ts`（`prechecked`/`skipCreditLimit` 可选参数） |
| 投资实体 | `src/simulation/investors/investors.ts` |
| 旧档兼容 | `src/simulation/core/save.ts`（`normalizeLegacyV09World`） |
| 报告口径 | `scripts/economy-v09-report.ts`（历史破产、每城存款、窗口标注、消费分账、设备产业流水） |
| UI | `src/app/gameStore.ts`、`src/ui/panels.ts`、`src/ui/format.ts`、`src/presentation/scenes/RegionalScene.ts` |

### 8.1 本轮校准的数值（原值 → 新值 → 理由）

| 项 | 原值 | 新值 | 理由 |
|---|---|---|---|
| 设备产能语义 | `capacityPerUnit = 300000`（所有产品通用） | farm 8 / industry 13 / energy 11（等效工人月数）+ 该产品人均产量 | 原口径把“台/月”和“产出单位/月”混用，导致设备厂启动资本数百亿；统一后单位经济利润率 16.9–18.8% |
| 设备制造人均产量 | 未定义 | 0.15 / 0.08 / 0.09 台/人/月 | 与设备厂 60 员工的真实产能匹配 |
| 开局企业 | 17 家 | 65 家（每城 +16） | 任务书二/三：补食品/谷物/能源/金属/设备/纺织服装日用品缺口，提供真实设备生产者 |
| 企业初始库存 | 1.2 个月 | 1.2 个月（保持不变） | 曾试 0.5 改善早期成交，但 1.2 下设备产业已能自然成交，故保留原值、减少基线漂移 |
| 设备出售统计 | 只记 `sold/revenue` | 另记 `equipmentSold` | 72 月报告能区分“设备产业售出收入”与普通商品销售（t72：656.9 万） |
| 国债认购储备 | 1 个月工资 + 1 个月利息 | 保持原值（未改） | 属既有规则；仅在报告中列明流动性风险（§9） |

---

## 9. 未解决问题与需要用户决策的冲突

1. **人口 ×5 与私营岗位/产能不匹配**：开局 65 家企业只有约 16.9 万私营岗位（三城合计），而劳动人口约 96 万；t1 失业率 80.8–86.7%。这是“近 100% 失业”的结构性源头，不是单点 bug。需要用户决定：是否按人口 ×5 同步放大私营企业规模/岗位（本轮曾试过 ×5 员工/产能，t1 失业率降到 64%，但会彻底改变所有基线、且与“保留原有 17 家规模”冲突，已回退）。
2. **企业认购国债抽走经营现金**：`settleBondSubscriptionWindow` 每月把企业“可支配现金”（只保留 1 个月工资 + 1 个月利息）换成国债，单城单月可达 3,000 万+；企业次月现金不足 → 减产 → 裁员 → 需求下降。属 v0.7 既有规则（企业可用现有资金购债、禁止贷款购债），本轮未改储备口径；建议提高到 2–3 个月工资并做动态化，需用户批准。
3. **销量锚计划的路径依赖**：即便加入缺货信号（20%/月吸收）与信贷约束，计划仍以近 3 月销量为基准；一旦企业经历 1–2 个月零成交（例如下游有期初库存、贸易合同先行），计划会被压低并触发紧急下调，之后只能 ±20% 爬升，形成“计划锁定”。
4. **资本品需求信号缺失**：设备厂有产能、有真实买方，但设备需求在账本上不可见（采购发生在市场账本创建之前/之间），导致 AI 扩产判断缺少“设备缺口”信号；本轮已修报告口径与审计，但“计划/创业是否把设备可获得性作为需求信号”仍受第 3 条限制。
5. **信用额度依赖投资实体权益（股价）**：居民授信额度 = 财产基准 × 0.5，而财产基准含投资实体权益；股价波动会轻微改变额度。已修复“消费阶段按快照额度放款”的自指回滚 bug，但“权益→授信→消费→权益”的放大链条仍在，建议后续单列 follow-up。
6. **经济仍崩溃（未达标）**：见 §0 与 §6，明确报告未达标，不伪造成交、不取消破产、不禁止倒闭。

---

## 10. Windows 复验步骤

```bat
git clone https://github.com/eojnus/multi-city-sim.git
cd multi-city-sim
git checkout feature/stock-market-ui-tax
git rev-parse HEAD
npm ci
npx tsc --noEmit
npx vitest run --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
npm run build
node_modules\electron\dist\electron.exe --no-sandbox scripts\acceptance-v09.cjs
```

进入游戏后建议查看：岚港城市面板（人口/就业/失业/需求 vs 成交）、企业面板（设备/计划/实际/成本/AI 原因）、股票窗口与存档读档；`docs/evidence_v0.9/` 有本轮桌面证据。

---

## 11. Git

- 分支：`feature/stock-market-ui-tax`
- 基线：`99ed1e7020a736af8892861e9198e201cb0c37cf`
- 本轮提交：见提交后的交付回复（分阶段提交：模拟/数据/测试；UI/报告；文档/版本）
- `main`：保持 `6c45000efc4c406d30e22c0a12bd066fc2df61f7`，未合并、未 force、未改写历史。
- 未提交内容：无（提交前复核工作区干净）。

---

## 12. 结论

- **机制层**：任务书 13 节要求的主体已实现并验证（65 家开局、职责/资产齐全、三类设备单位经济与真实交易、计划纳入缺货/信贷、消费资金顺序与本地优先、投资实体真实资金、旧档兼容、报告口径修复）。
- **结果层**：默认世界 72 月仍高失业、必需品短缺、政府反复破产，**明确未达到“经济循环稳定”的验收目标**；根因是结构性的（§9），需要用户在“人口 ×5 是否同步放大私营规模”“国债认购储备”“销量锚计划是否改为需求锚”三处做规则决策后，才能进入下一轮调参。
- 本轮没有为让数字好看而伪造人口/资金/生产/设备/订单/成交/财政收入；所有 72 月数据可用 `npx tsx scripts/economy-v09-report.ts --months=72` 复现。
