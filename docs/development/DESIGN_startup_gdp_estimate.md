# 设计稿 A：开局 12 个月 GDP 估计（补充指令 §6）

状态：设计稿（未实现，未提交）。数值口径归「数值与数据」，落地代码归「游戏程序」，契约字段归「架构师」。
依据：`briefs/SUPPLEMENT_ARCHITECT_v1.md` §6、`briefs/DECISIONS_v1.md` #6。
基线：`feature/data-tuning` @ `9cef5b5`。

## A1. 口径（引用冻结结论）

1. GDP 口径沿用现有 `computeCityGdp`：企业产出价值 − 中间投入价值，不含工资、贷款、还款、财政拨款。
   - 现有实现：`ProductionRecord.valueAdded = outputValue − inputValue`，`outputValue = qty × city.market[输出品].price`，
     `inputValue = Σ round2(qty × recipe.qty × city.market[投入品].price)`（`src/simulation/production/production.ts:418-480`）。
2. 估计只用于初始化：不实际生产、不改库存/现金/工资/税收、不写真实历史。
3. 估算产量 = 理论可生产量 × 80%（可配置）。12 个月填同一估计值。
4. 真实月度 GDP 到来后，逐月从最早的估计条目替换。
5. 最小年 GDP 判定值 1 信用点：仅用于破产判定与比率的分母兜底，不创造产出/现金。
6. 旧档优先真实历史；不足 12 个月时同口径估计填补并标注。

## A2. 公式与推导

对城市 `c`：

```
月估计GDP(c) = max(0, Σ_{company∈c} VA(company))

VA(company) = q̂ × P_out(company) − Σ_{input∈recipe(company)} q̂ × r_input × P_in(input)

q̂ = min(company.capacity, laborCapacity(company, city, config, world)) × gdp.startupEstimateUtilization
```

- `q̂` 为估计产量（单位），向下不取整（估计值，非实际库存）。
- `P_out` / `P_in`：`city.market[goodId].price`，新世界初始化时 = `GOODS[good].basePrice × market.initialPriceFactor(0.95)`
  （`src/simulation/core/initializer.ts:35-56`），与真实月结使用的是同一价格来源，口径一致。
- `laborCapacity`：`employees × PRODUCTIVITY[recipeOutput] × city.technology.productivityMultiplier × workforceSkillMultiplier(city)
  × 政策/领导人系数(初始化=1) × production.laborCapacityFactor(1.08)`（`src/simulation/production/production.ts:47-62`）。
- 配方 `RECIPES` 与生产率 `PRODUCTIVITY` 来自 `src/data/demo-data.ts`。
- 配方缺失、`q̂ = 0` 的企业跳过；有员工但估计为 0 的城市按 A6 判据报异常。

### 关键口径陷阱（必须冻结，不能各写各的）

`company.capacity` 初始化时已经 = 员工 × 生产率 × 科技 × 1.08（`initializer.ts:164`），
而 `productionTarget = capacity × utilization`，初始 `utilization = 0.8`。
因此「理论可生产量」必须取 **`min(capacity, laborCapacity)`**（满负荷、未乘利用率），再乘 80%；
**不能**把 `productionTarget` 再乘 80%（会变成 0.64×capacity）。

实测对照（同一初始条件）：

| 解释 | 岚港 | 铁谷 | 青原 | 与首月实际比值 |
| --- | --- | --- | --- | --- |
| 0.8 × min(capacity, laborCapacity)（本稿） | 211,734,164 | 163,279,110 | 175,135,584 | 1.03 / 1.00 / 1.03 |
| 0.8 × productionTarget（错误叠加） | 169,387,331 | 130,623,288 | 140,108,467 | 0.77 / 0.80 / 0.78 |
| 首月实际（同条件跑 1 tick） | 218,588,557 | 163,650,189 | 180,115,710 | — |

结论：本稿解释与首月实际相差 0–3%；错误叠加会低估约 20–23%，属明显失真。

其他必须固定的口径：

- 先按企业求和，再对城市取 `max(0, ·)`，与 `computeCityGdp` 的城市级 floor 一致；不对单企业 floor。
- 不把月估计值 ×12 后写回；12 个月合计只用于比率/展示。
- 不把估计值写入 `city.gdp`（当月真实 GDP 保持 0，首月结算后由真实值覆盖）。
- 不修改 `world.history` 的初始点（保持 0），避免把估计混进真实世界历史。

## A3. 数据来源字段

| 量 | 字段/来源 |
| --- | --- |
| 企业产能 | `Company.capacity`（初始化已含 1.08 劳动系数） |
| 员工数 | `Company.employees` |
| 单员工生产率 | `PRODUCTIVITY[Company.recipeOutput]`（`src/data/demo-data.ts`） |
| 城市科技系数 | `City.technology.productivityMultiplier` |
| 初始技能系数 | `City.workforce.skillLevel = 0.3` → `workforceSkillMultiplier = 1.03` |
| 劳动产能上限 | `laborCapacity()`（`src/simulation/production/production.ts:47`） |
| 配方 | `RECIPES[Company.recipeOutput]` |
| 产出/投入价格 | `City.market[goodId].price`（初始化 = basePrice × 0.95） |
| 城市归属 | `Company.cityId` |
| 估计系数 | `gdp.startupEstimateUtilization`（新键） |
| 填充月数 | `gdp.startupEstimateMonths`（新键） |
| 判定兜底 | `government.fiscalRisk.minAnnualGdp = 1`（v0.7 冻结键位） |

## A4. 参数键与默认值（数值段，结构由架构师定）

按秘书处给定的 `gdpEstimate` 段（键名待架构师冻结，本岗只填值；语义不变）：

```ts
gdpEstimate: {
  /** 估算产量 / 理论可生产量。首版假设（补充指令 §6 已定），非模拟校准结果。 */
  utilizationAssumption: 0.8,      // 比例，单位：倍（v0.7 冻结键名，位于 government.gdpEstimate）
  /** 开局填充的估计月数（= 破产判定窗口）。 */
  startupEstimateMonths: 12,           // 月
  /** 最小年 GDP 判定值：最近 12 月合计低于该值时，比率与破产判定按该值计算。 */
  // 最小年 GDP 判定值 1 信用点：v0.7 冻结后位于 government.fiscalRisk.minAnnualGdp
},
```

理由与影响面：

- `0.8`：补充指令 §6 已定的首版假设；实测与首月实际吻合（1.00–1.03），是"正常月份"的合理近似。
  影响面：开局 12 月 GDP、债务/GDP、破产判定、市长面板；只影响估计，不影响真实 GDP 计算。
- `12`：与破产判定窗口一致（§四/§6）；影响面：开局历史长度、旧档填补。
- `1`：纯防除零；影响面：GDP 极低城市的债务率上限（1000 倍）与面板提示，不产生资金。
- 这三个键都是「首版暂定参数」，交付报告单列，不写成用户已确认。

## A5. 接入点

1. **新世界**：`src/simulation/core/initializer.ts` 的 `createInitialWorld`，在 `const world: WorldState = {...}`（约 331 行）
   之后、`createInvestorGroups` 之前调用 `seedStartupGdpEstimates(world, config)`。
   - 只读 `cities` / `companies` / `market`；写 `city.gdpHistory`（12 条，`estimated: true`）与 `city.gdpEstimate` 元数据。
   - 估计条目 tick 取 `-12 … -1`（开局前 12 个虚拟月），真实首月 tick=1 起逐月替换，排序天然正确。
   - 无随机数，与种子无关，结果确定。
2. **逐月替换**：`src/simulation/economy/gdp.ts` 的 `computeCityGdp`：push 真实条目之前，若存在 `estimated` 条目，
   删除最早的一条（`shift`），再 push 真实条目；保持 60 条裁剪逻辑不变。12 个月后估计条目自然清零。
3. **12 月判定合计**：新增 `recent12MonthGdp(city, config)`（放 `economy/gdp.ts`，由游戏程序实现、报告与破产判定共用）：
   `sum = Σ 最近 12 条 gdpHistory.value`，分母 = `max(config.government.fiscalRisk.minAnnualGdp, sum)`。
   比率 = 总负债 / 分母；破产判定按冻结的 100% 阈值（另见 B 稿参数表）。
4. **旧档迁移**：`src/simulation/core/save.ts` v6→v7（架构师块 0）：加载后若 `city.gdpHistory.length < 12`，
   用同口径公式（基于加载时的企业/城市/价格状态）补 `12 − 已有真实月数` 条估计条目，**前置**到历史数组最前，
   并 `estimated: true`、写 `city.gdpEstimate.note = '旧存档缺口，估计值'`；不覆盖任何真实条目；已有 ≥12 条则不补。
   - 注意：迁移只补缺口，不重算真实历史；旧档企业可能已倒闭/裁员的，按当前状态估计并如实标注。
5. **存档校验**：`validateCity` 的 gdpHistory 校验允许可选 `estimated: boolean`（缺省视为真实）；
   v7 之后新写的估计条目必须显式带 `estimated: true`。
6. **不变量**（架构师 `invariants.ts`）：每城估计条目 ≤ 12；估计条目必须位于真实条目之前；
   12 月合计 ≥ 0；估计条目存在时城市 GDP 不得被当成真实值参与"真实历史"统计。
7. **UI**（界面程序，非本岗）：公共 GDP 历史中估计段需标注"开局估计"；12 月判定合计/债务率/预警仅市长可见
   （DECISIONS #9），非市长不显示；估计值不得显示成"真实历史"。

## A6. "明显失真"判据（交付必须逐项报告，超限不静默换公式）

| # | 判据 | 阈值（观察口径） | 实测（预览） |
| --- | --- | --- | --- |
| 1 | 估计月 GDP / 同条件首月真实 GDP | 0.85–1.25 | 1.03 / 1.00 / 1.03 ✅ |
| 2 | 估计月 GDP / 同城月工资总额 | 0.8–2.5 | 1.22 / 1.30 / 1.68 ✅ |
| 3 | 初始财政余额 / 12 月估计合计（≈初始债务率） | 0.5%–20% | 2.4% / 2.0% / 1.0% ✅ |
| 4 | 城内有生产企业但估计 = 0 | 必须报异常 | 无 |
| 5 | 估计条目数 | 新世界 = 12；旧档 ≤ 12 且 = 12 − 真实月数 | — |
| 6 | 估计条目与真实条目混排/重复计入 | 不允许 | — |
| 7 | 估计值 ×12 后回写月值/写入 `city.gdp` | 不允许 | — |

说明：判据 1 只在交付时做一次内部对照（跑 1 tick，不写入正式历史），不是游戏运行时逻辑；
判据 2/3 是量级合理性检查，不是经济规律。若因价格/产能/旧档状态导致超限，报告口径限制，不换公式。

## A7. 交付数据（预览，已按本稿公式实算，未实现）

固定条件：`createInitialWorld(DEMO_CONFIG)`，seed `20261101`，起始 2026-01，无玩家操作。

| 城市 | 月估计 GDP | 12 月估计合计 | 月工资总额 | 初始财政 | 首月实际 GDP | 估计/实际 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 岚港 | 211,734,164 | 2,540,809,964 | 173,698,760 | 60,000,000 | 218,588,557 | 1.03 |
| 铁谷 | 163,279,110 | 1,959,349,318 | 125,582,760 | 40,000,000 | 163,650,189 | 1.00 |
| 青原 | 175,135,584 | 2,101,627,007 | 104,411,720 | 20,000,000 | 180,115,710 | 1.03 |
| 世界 | 550,148,858 | 6,601,786,296 | 403,693,240 | 120,000,000 | 562,354,456 | 1.02 |

企业级明细（估算产量 = 0.8 × capacity；价格为初始市场价）。表中数字四舍五入到整数，行间合计可能有 ≤1 信用点差异：

| 城市 | 企业 | 估计产量 | 产出价值 | 中间投入 | 增加值 |
| --- | --- | ---: | ---: | ---: | ---: |
| 岚港 | 食品厂 lp-food | 3,146,481 | 164,403,613 | 44,359,084 | 120,044,529 |
| 岚港 | 成衣厂 lp-garment | 160,237 | 48,712,182 | 15,664,011 | 33,048,171 |
| 岚港 | 日用品厂 lp-appliance | 543,836 | 46,497,992 | 9,196,269 | 37,301,722 |
| 岚港 | 能源公司 lp-energy | 349,609 | 9,963,855 | 0 | 9,963,855 |
| 岚港 | 纺织厂 lp-textile | 156,838 | 17,879,585 | 6,503,699 | 11,375,886 |
| 铁谷 | 食品厂 iv-food | 1,841,357 | 96,210,893 | 25,959,448 | 70,251,445 |
| 铁谷 | 金属厂 iv-metal | 249,350 | 16,581,802 | 1,776,622 | 14,805,180 |
| 铁谷 | 制衣厂 iv-garment | 179,820 | 54,665,280 | 17,578,304 | 37,086,976 |
| 铁谷 | 能源二厂 iv-energy | 287,712 | 8,199,792 | 0 | 8,199,792 |
| 铁谷 | 纺织二厂 iv-textile | 136,663 | 15,579,605 | 5,667,081 | 9,912,524 |
| 铁谷 | 日用品二厂 iv-appliance | 335,664 | 28,699,272 | 5,676,078 | 23,023,194 |
| 青原 | 谷物合作社 gf-grain | 4,338,248 | 90,669,377 | 2,472,801 | 88,196,575 |
| 青原 | 纤维农场 gf-fiber | 282,673 | 12,084,277 | 161,124 | 11,923,154 |
| 青原 | 食品加工厂 gf-food | 942,244 | 49,232,241 | 13,283,754 | 35,948,487 |
| 青原 | 日用品厂 gf-household | 274,821 | 23,497,206 | 4,647,225 | 18,849,981 |
| 青原 | 能源站 gf-energy | 176,671 | 5,035,116 | 0 | 5,035,116 |
| 青原 | 制衣厂 gf-garment | 73,613 | 22,378,291 | 7,196,019 | 15,182,272 |

（这些数字由 `/tmp/gdp-preview.ts` 只读试算得到，脚本未提交、未进入仓库；实现后由正式脚本/报告复算。）

## A8. 需要的契约字段（请转架构师）

1. **必需**：`City.gdpHistory` 条目追加可选字段 `estimated?: boolean`（`src/simulation/contracts/types.ts:259`）。
   缺省 = 真实，旧档兼容；v7 新写估计条目必须显式 true。
2. **必需**：`SAVE_FORMAT_VERSION` 6→7 与 `migrateWorldV6ToV7`（旧档缺口填补，见 A5.4）。
3. **建议**：`City.gdpEstimate?: { method: string; monthly: number; months: number; filledAtTick: number; params: Record<string, number>; note: string }`
   ——报告与 UI 标注"估计值"用；若不加，可由 `estimated` 条目 + 重算推出，但报告要多写推断逻辑。
4. **必需（B 稿共用）**：12 月判定合计 helper `recent12MonthGdp(city, config)` 与比率/破产判定函数签名；
   报告脚本只调用，不自行另写一套口径。
5. **UI 需求（界面程序）**：估计段标注 + 判定合计/比率/预警的市长权限校验。

## A9. 未决问题（已由 DECISIONS v1.4 #32–36 裁定，2026-11-02）

**结论**：理论可生产量冻结为 `min(capacity, laborCapacity)`、80% 只乘一次；估计条目 tick −12…−1、`estimated=true`，架构师保证存档校验接受负 tick；参数键名以架构师块 0 为准；落地顺序：契约冻结 → config 数值段回填 → 初始化与 GDP 替换逻辑落地 → 失真判据逐项复核。

（以下为原待决条目，保留备查）

1. "理论可生产量"定义按本稿冻结为 `min(capacity, laborCapacity)`；若架构师/模拟认为应取其它基线，需明确，否则会重演 0.64 低估。
2. 估计条目 tick 用 `-12…-1`（虚拟月）还是全填 `0`：本稿建议前者，便于"逐月替换最早"和排序；若存档校验不接受负 tick 需架构师确认。
3. 旧档补缺口时，若真实历史 >12 条但中间有缺月（理论上不会），是否需要插值——本稿不插值，只补窗口缺口。
4. 是否需要把"估计值"也写入 `world.history`：本稿建议不写，避免污染真实世界历史；若 UI 需要世界级曲线，另加标记字段（架构师定）。
