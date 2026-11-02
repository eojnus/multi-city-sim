# 设计稿 C：数值参数提案（DECISIONS #23 / #24 / #29 + config 段落地确认）

状态：设计稿（未实现，未提交）。值由「数值与数据」定，键名/结构由「架构师」冻结，规则由「模拟」实现。
依据：`briefs/DECISIONS_v1.md` #19–#31、任务书 §4/§5.2/§5.3、补充指令 §4/§6。
基线：`feature/data-tuning` @ `9cef5b5`。

## C0. 结论摘要

| # | 参数 | 建议值 | 量级影响（初始条件实测） |
| --- | --- | --- | --- |
| 23 | 企业购债流动性保留 | 1.0 × 上月实发工资 + 1.0 × 上月应付利息 | 初始可认购 = 现金 − 1 个月工资 = **现金的 37.5%**；三城企业合计 1.04/0.75/0.63 亿 |
| 24 | 群体消费贷 | 0.6%/月、24 月、额度 = 资产 50%、无抵押默认关闭 | 三城居民可贷合计 9.95/7.27/5.87 亿；人均可贷 8,290/8,457/9,167 |
| 29 | AI 政府自动发债 | 触发 0.5 × 上月财政支出，补足至 1.0 × 上月财政支出，每城每月 ≤ 1 期 | 赤字约 13–15M/月、经济收缩背景下，36 月内可能连续触发并逼近破产线（见 C3 正反馈分析） |

全部为「首版暂定」，无模拟校准；交付报告单列，不写成用户已确认。

config 段划分（秘书处给定，本岗只填值，不抢改结构）：

- `gdpEstimate`：80% 系数、12 月、最小年 GDP 判定值 1。
- `householdCredit`：0.6%/月、24 月、额度 50%、无抵押开关、冻结规则。
- `aiGovernment`：发债触发/补足阈值、每城每月期数上限。
- `bondMarket`：面额 1000、年利率 4%、36 月、每 12 月付息；企业认购保留也放这里（或独立子段，架构师定）。

## C1. #23 企业认购政府债券的流动性保留

### 原值

- 当前**没有企业购债机制**，故该约束无"原值"，属新增规则。
- 现有可复用的现金流约束（必须不重复造口径）：

| 现有逻辑 | 公式 | 位置 |
| --- | --- | --- |
| 采购自有预算 | `cash − 月工资 × company.wageReserveMonths(1) × 0.5` | `src/simulation/production/production.ts:126-128` |
| 企业授信 | 非负账面股权价值 × `banking.creditLimitRate(0.5)`，同一主体共享 | `src/simulation/banking/credit.ts` |
| 工资实发/欠薪 | `company.previousMonth.wagesPaid` / `wageArrears` | `finance.ts` 结算写入 |
| 利息实付 | `company.previousMonth.interestPaid` | `banking.ts` 写入 `lastMonth`，月结复制到 `previousMonth` |

### 建议值

```
可用于认购的现金上限 = max(0, company.cash − (上月实发工资 + 上月应付利息))
月结/首月无上月数据时兜底：
  上月实发工资  ← max(previousMonth.wagesPaid, 当月应发工资 monthlyWageBill(company, config))
  上月应付利息  ← max(previousMonth.interestPaid, 当前未结清贷款本月应计利息)
上限向下取整到整数份（面额 1000）；上限 < 1000 不可认购。
```

参数键建议（`bondMarket` 段，键名待架构师冻结）：

```ts
bondMarket: {
  // ...面额/利率/期限
  companyPurchaseReserve: {
    wageMonths: 1,      // 保留上月实发工资的倍数
    interestMonths: 1,  // 保留上月应付利息的倍数
  },
}
```

### 理由

1. 决策 #23 字面即"1 个月工资 + 1 个月利息"，倍数 = 1.0 是唯一自然取值，无需新调参。
2. 与采购预算（0.5 个月工资）相比更严，符合"购债不得挤占经营与偿债"的意图；采购规则不改。
3. 初始企业现金 = 1.6 个月工资（`company.initialCashWageMonths`），因此初始可认购 = 0.6 个月工资 = 现金的 37.5%，仍保留 1 个月工资 + 0.6 个月缓冲，不会让企业现金见底。
4. 复用 `monthlyWageBill` 与 `previousMonth` 字段，不新建第二套工资/利息口径。

### 影响面（初始条件实测）

| 城市 | 企业现金合计 | 可认购合计 | 占现金 | 对比初始财政 | 单企业示例 |
| --- | ---: | ---: | ---: | ---: | --- |
| 岚港 | 277,918,016 | 104,219,256 | 37.5% | 174% | 岚港食品厂 7,795 万 → 77,947 份 |
| 铁谷 | 200,932,416 | 75,349,656 | 37.5% | 188% | 铁谷食品厂 4,619 万 → 46,191 份 |
| 青原 | 167,058,752 | 62,647,032 | 37.5% | 313% | 青原谷物合作社 2,454 万 → 24,539 份 |

（精确合计：企业现金 645,909,184；可认购 242,215,944，占 37.5%。）

结论：首版企业认购能力远超政府单次发债规模（发债缺口通常 < 数月财政支出），因此该参数**不会**造成认购不足；
它的作用是防止"清空现金买债"以及占用发薪/付息资金。若后续发现企业囤债影响生产，再议上限，不在本次调。

### 边界用例（必须测）

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | 新世界首月（previousMonth 全 0） | 用当月应发工资兜底，可认购 = 现金 − 1 月工资，不得把 1.6 月现金全部花掉 |
| 2 | 现金 = 工资 + 利息 | 可认购 0（不产生负数、不借债） |
| 3 | 现金 < 工资 + 利息 | 不可认购；不得部分扣款；不得自动申请贷款（#5） |
| 4 | 有欠薪 wageArrears > 0 | **建议**直接禁止认购（附加保护，需模拟实现；不在 #23 字面内，报告为待确认） |
| 5 | 新成立企业（无上月、无贷款） | 兜底公式生效，可认购 = 现金 − 当月应发工资 |
| 6 | 刚借入贷款（上月利息 0，本月有合同） | 利息保留用当前合同月应计兜底，不得按 0 计 |
| 7 | 同一窗口多笔认购 / 跨城认购 | 每笔按当时现金校验；累计不超过上限；不重复扣款 |
| 8 | 部分成交（计划 100 份成交 65 份） | 只扣 65 份金额，35 份不形成债务（#21/§4） |
| 9 | 企业处于违约/欠款 | **建议**禁止认购；报告为待确认 |
| 10 | 认购时点是月结内哪一步 | 需模拟明确：读取"上月"字段即 previousMonth，窗口内不得先扣现金再补算上限 |

## C2. #24 居民群体贷款首版参数

### 原值

| 项 | 现值 | 位置 |
| --- | --- | --- |
| 存款月息 | 0.10% | `banking.depositRateMonthly` |
| 个人贷款（玩家） | 0.60%/月、24 月、等额本金、次月起还 | `banking.products.personal` |
| 企业周转贷 | 0.50%/月、24 月 | `banking.products.workingCapital` |
| 企业扩张贷 | 0.60%/月、36 月 | `banking.products.expansion` |
| 授信比例 | 50%（基准：个人 = 可核验净资产；企业 = 非负账面股权价值） | `banking.creditLimitRate` |
| 宽限/违约 | 宽限 1 个月，第 2 个月仍欠付 → defaulted；无罚息 | `banking.graceMonths`、`earlyRepaymentFee: 0` |
| 无抵押信用 | 无 | （新增开关） |

### 建议值

```ts
householdCredit: {
  enabled: true,
  rateMonthly: 0.006,        // 0.6%/月（名义年化 7.2%）
  termMonths: 24,            // 等额本金，次月起还
  creditLimitRate: 0.5,          // 额度 = 可核验资产 × 50%（v0.7 冻结键名）
  allowUnsecuredNoAsset: false,  // 无资产无抵押信用默认关闭（任务书要求"作为待定开关报告"）
  denyWhenDefaulted: true,       // 冻结新授信：存在未结清违约合同
  denyWhenArrearsMonthsAtLeast: 2, // 连续欠付 ≥2 个月（= 宽限 1 个月后仍欠）
}
// graceMonths / 罚息 / 违约标记沿用 banking 现有键，不重复定义
```

**资产口径**（额度基准，必须与现有财富统计一致、不与其他主体重复计算）：
群体可核验资产 = 群体现金 `group.cash` + 群体银行存款 `world.banking.deposits[group]` +
按人口占比归属的投资实体权益（`cityInvestorEquity(cityId) × group.people / 城市群体总人数`，市值口径）。
与 `householdPerCapitaWealth` / 财富阶层统计同一口径（`src/simulation/population/household-groups.ts:550-564`），不新增估值规则。

### 理由

1. 任务书 §5.2 要求"以现有个人贷款规则为基础提出可配置首版"；0.6%/24 月与 `products.personal` 完全一致，居民与企业/玩家同一利率层级，避免为群体另设歧视性利率。
2. 额度 50% 与已冻结的 `banking.creditLimitRate` 一致（任务书重点：贷款额度 50%）；用现有资产口径，避免"财产重复计价"。
3. 存款 1.2%/年 → 贷款利率 7.2%/年，利差 6 个点；银行无限资金、不倒闭，利差只影响居民负担与银行统计，不制造风险。首版无罚息，违约核销 `writtenOff`（#22/#28），不没收存款/股票（#28）。
4. `allowUnsecuredNoAsset: false` 落实"居民借款受个人财产约束，不得无限信用"；无资产群体额度为 0，不因"穷人不能贷款"而隐藏——报告为待定开关。

### 影响面（初始条件实测）

| 城市 | 居民资产合计 | 可贷合计（50%） | 可贷 / 居民月收入 | 人均可贷 |
| --- | ---: | ---: | ---: | ---: |
| 岚港 | 1,989,483,547 | 994,741,773 | 5.6 个月 | 8,290 |
| 铁谷 | 1,454,584,867 | 727,292,433 | 5.6 个月 | 8,457 |
| 青原 | 1,173,360,400 | 586,680,200 | 5.7 个月 | 9,167 |

- 分群体：岚港生产工人可贷 4.24 亿（人均 15,465）、管理层人均 68,595、失业群体人均 2,955（有少量资产，故非 0；无资产者按开关为 0）。
- 月供示例（借 10,000 信用点，24 期等额本金）：月还本 416.67，首月利息 60，月供 476.67 逐月递减；total 利息 750（本金的 7.5%）；若借满人均额度 8,290，月供约 395 ≈ 人均月收入 1,764 的 22%。
- 贷款只填补"现金付不起的部分"（#26），且以可成交供给为上限；不得按可借额度放大有效需求，也不得借出无法成交的钱（任务书 §5.2）。
- 观察影响：居民消费预算在 80%/5% 公式之外会叠加"贷款支持成交"，36 月报告需单列"贷款支持的消费额"与"消费贷余额/逾期"，不能混算成收入。

### 冻结新授信条件（与个人贷款一致；当前代码无显式冻结逻辑，需模拟实现并确认）

建议判定：该借款主体存在任一未结清合同满足
`status === 'defaulted'` 或 `missedPayments ≥ 2` → 新授信可用额度 = 0（冻结）；
欠款清零/合同结清后，下月授信快照恢复。冻结只影响新放款，不影响已有合同计息与还款。
若秘书处/模拟对"冻结"另有口径，以他们为准；本岗只给数值（`denyWhenArrearsMonthsAtLeast: 2` 与现有"宽限 1 个月、第 2 个月违约"一致）。

### 边界用例

1. 无资产群体（旧档迁移、人口清零）：额度 0；`allowUnsecuredNoAsset=false` 时不得放款。
2. 资产含股票权益：股票市值下跌 → 下月额度下降；已放款不追缴、不强制平仓。
3. 群体迁移/死亡：债务归属与守恒由模拟处理；报告要求债务不静默消失（任务书 §5.2）。
4. 供给不足：不得借出无法成交的资金；贷款金额 ≤ min(现金缺口, 该笔供给所需, 剩余额度)。
5. 月供与消费预算时点：**建议先扣当月还款、再算 80%/5% 消费预算**，避免"借钱消费→预算虚高→再借"循环；若模拟选择不同顺序，报告需注明。
6. 违约后：不没收资产（#28），核销记 `writtenOff`，银行 backstop；居民仍可存款，但新授信冻结。

## C3. #29 AI 政府自动发债阈值

### 原值

- 当前**没有政府发债/借款机制**，无原值；相关现有规则：`policies.aiReserveWageMonths: 1`（非玩家政府至少保留 1 个月公共工资）、破产阈值 100% 债务/GDP、银行垫付（#19）。

### 建议值

```ts
aiGovernment: {
  /** 触发：treasury < 上月财政支出 × 该倍数 → 月结内发债补缺口。 */
  triggerBelowExpenseMonths: 0.5,
  /** 补足目标：补到 treasury ≥ 上月财政支出 × 该倍数。 */
  topUpToExpenseMonths: 1.0,
  /** 每城每月最多期数（#29 冻结为 1）。 */
  maxIssuesPerCityMonth: 1,
  /** 最小发行额 = 1 份（1000），缺口不足 1 份不发。 */
  minIssueAmount: 1000,
}
```

- "上月财政支出"口径 = 上月该城财政总支出（公共工资 + 福利 + 政策支出 + 交通支出 + 债券利息/本金等，即 `FiscalEntry` 负向合计）；报告需单列构成。
- 补缺口 = `max(0, 补足目标 − treasury)`，向上取整到整数份（多出 < 1000 信用点）；受 #21 整数份/部分成交/当月一次撮合约束；未售出部分不形成债务。
- 不得借新还旧：到期债券本金由银行垫付（#19），本参数只补经营缺口；破产过渡期不得发债（#31）；破产勾销后需新市长就任（#25）。

### 依据

1. **0.5 触发**：初始三城财政可支撑 1.39–1.84 个月支出；0.5 倍等于"只剩半个月支出"的危险区才举债，不会开局就发债；比 1.0 触发少 2–3 倍发行次数，观察更干净。
2. **补到 1.0 倍**：补满 1 个月支出缓冲，避免"补到刚好过线→下月又触发"的每月边界抖动；每期规模 ≤ 约 0.5 个月支出，有界。
3. **每城每月 1 期**（#29 已定）：与补足目标配合后，典型节奏 2–4 个月一期，便于追踪单期与缺口对应关系。
4. 与现有 `aiReserveWageMonths: 1` 的保守方向一致（1 个月工资 → 1 个月总支出，更完整）。
5. 若秘书处希望 36 月内看到更多发债样本，可改 `triggerBelowExpenseMonths: 1.0`（约每月一期、单期更小）；本岗建议保持 0.5/1.0，把"高频举债"留给后续调参。

### 正反馈/借新还旧螺旋分析（结论：反馈存在但不爆炸，主要风险是结构性赤字）

- **利息反馈**：4%/年 → 月 0.333% 本金。债务/GDP 50% 时月息 ≈ 月 GDP 的 2%，约为月支出（≈月 GDP 18%）的 **11%**；100% 时约 **22%**。即高债务下"利息推高支出 → 推高触发阈值（阈值与支出挂钩）→ 更早发债"构成正反馈，但单期新增债务的利息（每期 ≤0.5 月支出 → 月息 ≈ 支出 2%×0.5×0.333 ≈ 0.17%）可忽略，反馈要累积到高债务才显著。
- **借新还旧**：被 #19/#29 规则切断——到期本金由银行无条件垫付，不由新债偿还；发债只补经营缺口，故不存在"发新还旧"的指数螺旋。
- **主因是结构性赤字，且经济收缩会放大它**：以岚港 M3 为例，月收入 27.6M vs 月支出 32.6M，赤字 4.9M ≈ 支出 15%。**但只读试跑（现有基线、未接债券机制、固定种子 36 月）显示经济显著收缩**：岚港 GDP 从 M1 218.6M → M12 47.8M → M36 27.3M，财政从 +60M → M36 −422.8M（≈ −13～15M/月）；铁谷 M36 财政 −247.4M。按 M36 年化 GDP 约 0.3–0.6B 计算，仅靠赤字累积就足以让债务/GDP 在 36 月内逼近或超过 100%。因此正反馈路径（经济收缩 → 税基缩小 → 赤字扩大 → 自动发债 → 债务率上升 → 预警/破产）在默认参数下是**现实路径而非理论风险**；观察脚本必须能捕捉破产与银行垫付，不能只看月度断面。
- **对阈值的含义**：经济收缩时"上月财政支出"本身可能下降，阈值随之下降，发债规模被动缩小；但赤字/支出比高时仍会连续触发。建议实现时对"上月财政支出"设下限（如不低于初始公共工资+福利的估算），避免通缩期阈值过低导致发债不足——**此为逻辑建议，需模拟确认**，数值上不新增系数。
- **破产后循环**：#8 勾销 + #25 允许重新累计；若政策不变，破产-重选-再借可能周期出现，观察口径需记录"破产次数/重选后就任时间/再次发债时间"。
- **多城联动**：跨城认购会把资金从富城引向穷城债；银行不认购（#21），银行风险只体现在垫付与勾销规模，不体现为银行挤兑。

### "连续多城同时触发"观察口径（写进 36 月报告）

| 观察项 | 口径 |
| --- | --- |
| 触发频率 | 每城每期是否触发、连续触发月数、同月触发城数 |
| 发行与成交 | 计划份数/金额、实际成交、未售出比例、单期缺口覆盖度（成交/缺口） |
| 认购结构 | 本城/外城 居民投资实体、企业、玩家；银行认购必须为 0（#21） |
| 跨城资金 | 外城主体购买本城债的金额（按购买主体所在城汇总） |
| 债务轨迹 | 债务/GDP 月值、斜率、预警档位变化（50/75/100%） |
| 利息负担 | 票息支出 / 月支出、欠付利息余额 |
| 兑付与垫付 | 12/24 月票息实付/欠付；36 月还本；银行垫付次数与金额 |
| 破产联动 | 是否同月破产、破产后重选与再次发债时间 |
| 异常判据 | 连续 2 个月 ≥2 城同时触发 → 报"系统性财政压力"；单城债务/GDP 36 月涨 >50 个百分点 → 报"债务快速恶化" |

## C4. `bondMarket` 落地确认（值已由补充指令/决策冻结，本岗只确认键与默认值）

```ts
bondMarket: {
  faceValue: 1000,            // 每份面额（补充指令 §4，已定）
  couponRateAnnual: 0.04,     // 票面年利率 4%（补充指令 §4，已定）
  termMonths: 36,             // 期限（补充指令 §4，已定）
  couponIntervalMonths: 12,   // 每 12 月付息（DECISIONS #19）
  unitsPerIssueMin: 1,        // 整数份，最小 1 份
  unitsPerIssueMax: null,     // 不设每期上限；仅受破产阈值与认购主体资金约束
  bankMaySubscribe: false,    // 银行不得认购国债（#21）
  subscriptionWindowMonths: 1,// 发行当月一次撮合，不跨月续售（#21）
}
```

- **待澄清**：36 月到期时是否支付第 3 期票息？按"4% 年利率 + 每 12 月付息"，应为 12/24/36 各付 4%（合计 12%）；但 #19 写"12/24 月付票息、36 月还本"。本岗建议：36 月支付第 3 期票息 + 本金（否则实际年化仅 2.67%），请架构师/秘书处确认后我同步到报告输出。
- 票息计算基数 = 每份面额 1000 × 4% = 40 信用点/份/年；部分月持有不足 12 月如何计提（破产时"实际持有月份计提"，#19）需模拟定口径，数值上按月 1/12 计提即可。

## C5. `gdpEstimate` 落地确认

```ts
gdpEstimate: {
  utilizationAssumption: 0.8, // 补充指令 §6 已定：估算产量 = 理论可生产量 × 80%（v0.7 冻结键名）
  startupEstimateMonths: 12,     // 12 个月估计值
  // 最小年 GDP 判定值 1 信用点在冻结结构中位于 government.fiscalRisk.minAnnualGdp（v0.7 §10）
}
```

- 80% 与 1 均为补充指令/决策给定，不是本岗自选；本岗只确认键名建议、默认值与"明显失真"判据（见 A 稿 §A6）。
- 口径陷阱：理论可生产量 = `min(company.capacity, laborCapacity)`，不能再乘 `utilization`（详见 A 稿 §A2）。
- 键名与归属若架构师另定，我按冻结键回填数值，不自行改结构。

## C6. 参数间相互影响（写进交付报告）

1. 企业购债能力（C1）远大于发债规模（C3），首版不会出现认购不足；政府债主要被本城企业与居民投资实体吸收，跨城资金流动规模小。
2. 群体贷款（C2）会在 80%/5% 消费公式之外增加消费能力；若同时允许企业购债（C1），需观察"居民借钱消费 → 企业收入增加 → 企业买债 → 政府少发债"的链条，但 36 月内属观察项，不预设结论。
3. 政府发债利息计入财政支出 → 抬升 C3 的触发阈值（正反馈，见 C3）；同时抬高总负债（#11），影响预警档位与破产判定。
4. 最小年 GDP 判定值 1（C5）只在 GDP 极低时生效，默认 36 月不会触发；报告需打印"是否使用兜底"。

## C7. 待确认（已由秘书处 DECISIONS v1.4 #32–36 拍板，2026-11-02）

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 36 月第 3 期票息 | **支付第 3 期票息 + 本金**（合计 3 次票息，否则年化不足 4%）；破产提前兑付按实际持有月份计息。 |
| 2 | grace/罚息 | 复用 `banking.graceMonths`，不在 `householdCredit` 段内另设。 |
| 3 | 冻结新授信 | 存在违约合同或连续欠付 ≥2 月 → 新授信 0；当前代码无现成逻辑，待游戏程序实现并由模拟确认。 |
| 4 | 欠薪/违约企业购债 | **首版禁止认购**（C1 边界 4/9 已拍板）。 |
| 5 | 键名/共用函数 | 键名以架构师块 0 为准；`cityDebt()/assessCityFiscalRisk()/recent12MonthGdp()` 放契约层共用，报告脚本与 UI 都调它，不各写一套。 |
| 6 | 理论可生产量 | **冻结 `min(capacity, laborCapacity)`，80% 只乘一次**；估计条目 tick −12…−1、`estimated=true`，架构师保证存档校验接受负 tick。 |

## C8. v0.7 冻结键名落地对账（2026-11-02；只改数值与注释，结构与键名未动）

**总原则**：`docs/architecture/IMPLEMENTATION_v0.7.md` §10 的键名/结构由架构师冻结，本岗只填数值、标"首版暂定"。下表"原值"= 架构师块 0 的占位默认值，"新值"= 本岗落地值；未列单位按键注释（份/信用点/月/年化比例/月利率）。

### C8.1 三个实质改动（其余保持冻结值）

| 键 | 原值 | 新值 | 单位 | 理由 | 影响面 |
| --- | --- | --- | --- | --- | --- |
| `government.bondMarket.maxPlanUnitsPerIssue` | 10,000 | **100,000** | 份/城/次 | 补足 1 个月支出约需 16–21 千份（岚港 21.0M/月、铁谷 16.8M/月，面额 1000）；10 千份上限会把正常补缺口的发行压到 47–63%，人为制造"未售出/发行不足"。100,000 份=1 亿≈单城 3–5 个月支出，仍属防误操作的 sanity cap，不是政策上限。 | 只影响块 1 `planIssue` 的输入校验；不改债券规则。 |
| `government.aiGovernment.enabled` | false（占位） | **true** | 布尔 | 任务书 §五.3"应 AI 默认"：AI 市长缺钱时自动发债是默认行为，不应要求玩家先开开关；块 1 实现前该开关无副作用，基线不受影响。 | 块 1 起，AI 城市在满足触发条件时会自动发债；玩家城市不受影响（由玩家操作）。 |
| `government.aiGovernment.triggerBelowExpenseMonths` | 1.0（旧键名 `autoIssueWhenTreasuryBelow`，按信用点误读） | **0.5** | 上月财政支出倍数（非信用点） | C3 设计口径：财政余额 < 上月支出 × 0.5 才触发，避免开局就举债（初始财政可撑 1.84/1.61/1.39 个月支出，0.5 倍触发点约在赤字累计 1.3–1.5 个月后）。v1.5 #43 已由架构师改名并冻结（`triggerBelowExpenseMonths`），单位歧义消除。 | 块 1 实现触发逻辑；分母按 #42 取 max(上月支出, fiscalExpenseBaseline)。 |
| `government.aiGovernment.topUpToExpenseMonths` | 无此键（新增） | **1.0** | 上月财政支出倍数 | 发债后把财政补到 1.0 倍月支出，避免"补一半又立刻低于阈值"的边界抖动；份数 = ceil(缺口/faceValue)。 | 块 1 起影响单期发行规模。 |
| `government.aiGovernment.maxIssuesPerCityMonth` | 1（旧键名 `autoIssuePlanUnits`，易误读成份数） | **1** | 期/城/月 | 决策 #29 每城每月最多 1 期；改名消除"份数"歧义。 | 无变化。 |
| `government.aiGovernment.maxDebtRatioToIssue` | 0.5 | **1.0** | 债务/GDP 比例 | 发债闸门应卡在破产线而不是 50%：债务率 50%–100% 正是最需要补缺口的区间，卡 0.5 会让财政在 50% 后靠欠付硬着陆。1.0 与 `fiscalRisk.bankruptAt` 一致（#25/#31）。 | 块 1 起影响 AI 发债频率；不改破产判定。 |

### C8.2 全表对账（未标注"改"的均为冻结值落地，理由=对应决策/任务书条款）

| 段.键 | 原值 → 新值 | 单位 | 理由 |
| --- | --- | --- | --- |
| `households.consumerBudget.lastIncomeShare` | 0.8 → 0.8 | 比例 | 任务书 §5.1：上月实际可支配收入 × 80% |
| `households.consumerBudget.cashShare` | 0.05 → 0.05 | 比例 | 任务书 §5.1：手头现金 × 5% |
| `households.consumerBudget.depositsIncluded` | false → false | 布尔 | 存款不自动当现金，避免"复制"购买力 |
| `households.householdCredit.rateMonthly` | 0.006 → 0.006 | 月利率 | 与玩家个人贷款同档（C2；年化 7.2%） |
| `households.householdCredit.termMonths` | 24 → 24 | 月 | 与个人贷款一致（C2） |
| `households.householdCredit.creditLimitRate` | 0.5 → 0.5 | 比例 | 群体财产 × 50%，与 `banking.creditLimitRate` 同口径（C2） |
| `households.householdCredit.minLoanAmount` | 100 → 100 | 信用点 | 小额群体也能借到最低额度，避免碎片合同；上限已由额度约束 |
| `households.householdCredit.denyWhenDefaulted` | true → true | 布尔 | v1.4 #35：有未结清违约 → 冻结新授信 |
| `households.householdCredit.denyWhenArrearsMonthsAtLeast` | 2 → 2 | 月 | v1.4 #35：连续欠付 ≥2 月冻结；grace 复用 `banking.graceMonths` |
| `households.householdCredit.maxLoansPerGroupPerMonth` | 1 → 1 | 笔/群体/月 | 防拆单绕额度 |
| `households.householdCredit.allowUnsecuredNoAsset` | false → false | 布尔 | 任务书 §5.2：无资产无抵押默认关闭（开关） |
| `households.budgetSnapshotMonths` | 24 → 24 | 月 | 预算/审计快照保留 |
| `government.bondMarket.faceValue` | 1000 → 1000 | 信用点/份 | 债券面额冻结（#4/#19） |
| `government.bondMarket.couponRateAnnual` | 0.04 → 0.04 | 年化 | 票面 4% |
| `government.bondMarket.interestPeriodMonths` | 12 → 12 | 月 | 每 12 月付息（#19） |
| `government.bondMarket.termMonths` | 36 → 36 | 月 | 期限 36 月，第 36 月付第 3 期票息+本金（#36） |
| `government.bondMarket.maxPlanUnitsPerIssue` | 10000 → **100000** | 份/城/次 | 见 C8.1 |
| `government.bondMarket.minMonthsBetweenIssues` | 1 → 1 | 月 | 与 #29"每城每月最多 1 期"一致，防连续发行 |
| `government.bondMarket.maxSoldRatio` | 1 → 1 | 比例 | 允许全部售出；未售出按 #21 当月关闭 |
| `government.bondMarket.subscriptionOrder` | ['player','investorGroup','company'] → 不变 | 枚举序 | #21 确定性撮合顺序 |
| `government.bondMarket.riskPricedCoupon` | false → false | 布尔 | 首版固定票面，不做风险定价 |
| `government.bondMarket.allowBankSubscription` | false → false | 布尔 | #21 银行不得认购国债 |
| `government.bondMarket.singleMonthSubscription` | true → true | 布尔 | #21 发行当月一次撮合，不跨月 |
| `government.bondMarket.couponGuaranteedByBank` | false → false | 布尔 | #19 12/24 月票息不垫付、记欠付；36 月/破产才垫付 |
| `government.companyPurchaseReserve.wageMonths` | 1 → 1 | 月工资 | #23 保留 1.0×上月实发工资（C1） |
| `government.companyPurchaseReserve.interestMonths` | 1 → 1 | 月利息 | #23 保留 1.0×上月应付利息（C1） |
| `government.loan.rateMonthly` | 0.005 → 0.005 | 月利率 | 沿用企业周转贷款 0.5%/月（年化 6%） |
| `government.loan.termMonths` | 24 → 24 | 月 | 等额本金、次月起还 |
| `government.loan.minAmount` | 10000 → 10000 | 信用点 | sanity min，防碎片合同 |
| `government.loan.allowActiveBorrowing` | true → true | 布尔 | 首版允许政府主动借款维持支出 |
| `government.advance.rateMonthly` | 0.005 → 0.005 | 月利率 | 垫付转贷款沿用银行口径 |
| `government.advance.termMonths` | 24 → 24 | 月 | 同上 |
| `government.advance.createLoanContract` | true → true | 布尔 | 垫付逐笔可追溯（#19/#22） |
| `government.fiscalRisk.normalBelow` | 0.5 → 0.5 | 比例 | 预警分档 50%（任务书 §五.3） |
| `government.fiscalRisk.watchBelow` | 0.75 → 0.75 | 比例 | 75% 高风险档 |
| `government.fiscalRisk.bankruptAt` | 1.0 → 1.0 | 比例 | 破产阈值 100% |
| `government.fiscalRisk.minAnnualGdp` | 1 → 1 | 信用点 | 补充指令：最小年 GDP 判定值 1，防除零 |
| `government.fiscalRisk.trendEpsilon` | 0.005 → 0.005 | 比例 | ±0.5pp 内视为持平 |
| `government.gdpEstimate.utilizationAssumption` | 0.8 → 0.8 | 比例 | 补充指令：理论可生产量 ×80%，只乘一次（#32） |
| `government.gdpEstimate.windowMonths` | 12 → 12 | 月 | 破产判定窗口 12 月 |
| `government.gdpEstimate.method` | 文本 → 不变 | — | 估算口径写入存档，供 UI/报告标注 |
| `government.bankruptcy.triggerElectionSameTick` | true → true | 布尔 | 判定当月结算内重选（团队暂定） |
| `government.bankruptcy.shareDistribution` | byHolderCount → 不变 | 枚举 | 无 CEO 时按股东主体数均分（团队暂定） |
| `government.bankruptcy.custodyShareKind` | nonVoting → 不变 | 枚举 | 无主股份不得销毁/增发 |
| `government.aiGovernment.*` | 见 C8.1 | — | — |
| `government.payableRetentionMonths` | 24 → 24 | 月 | 应付项/审计保留 |
| `government.maxBankruptcyRecords` | 8 → 8 | 条 | 破产记录保留 |
| `banking.products.government.rateMonthly / termMonths` | 0.005/24 → 0.005/24 | 月利率/月 | 政府银行贷款产品，同企业周转口径 |
| `banking.products.bondAdvance.rateMonthly / termMonths` | 0.005/24 → 0.005/24 | 月利率/月 | 银行垫付转贷款产品 |
| `banking.products.householdConsumption.rateMonthly / termMonths` | 0.006/24 → 0.006/24 | 月利率/月 | 群体消费贷，与个人贷款同档 |

### C8.3 落地后仍需确认（不由本岗改结构）

1. **（已解决）`autoIssueWhenTreasuryBelow` 键名单位冲突**：v1.5 #43 已由架构师改名为 `triggerBelowExpenseMonths`（月支出倍数），并新增 `topUpToExpenseMonths`、把 `autoIssuePlanUnits` 改为 `maxIssuesPerCityMonth`；本岗数值 0.5 / 1.0 / 1 已在改名后配置中核对一致，歧义消除。
2. **`maxPlanUnitsPerIssue` 100,000 份是 sanity cap**：若后续城市支出规模或面额改变，需按"3–5 个月支出/面额"重算。
3. **#42 分母兜底**：`city.fiscalExpenseBaseline` 由 initializer 首月结算后写入（架构师已加可选字段），块 1 触发逻辑按 max(上月财政支出, baseline) 取分母；本岗不改逻辑。
4. **真实 GDP 替换仍为块 1 TODO**（`pushRealGdpPoint` 空实现）：在块 1 合入前，所有债务率/预警都按开局估计窗口（岚港 2.54B 等）计算，前期显著稀释；UI 必须显示估计月数（#12），报告里我同时给真实口径与判定口径两个数（B10.4）。
5. `householdCredit.minLoanAmount=100` 是按"群体最小可贷单位"估的 sanity 值；若 UI 出现个位数群体的碎片合同，再下调到 1。

## C9. DECISIONS v1.5（#37–#41）确认记录（2026-11-02，秘书处评审通过）

| # | 内容 | 与本文档的关系 |
| --- | --- | --- |
| #37 | 企业购债保留额 `{wageMonths:1, interestMonths:1}`；可认购额向下取整到 1000 面额整数份，不足 1 份=0；兜底用 max 方案；欠薪/违约 0；不得申贷/透支 | 与 C1 完全一致，已落地 `government.companyPurchaseReserve`；config 已填值 |
| #38 | 群体贷款 0.006/24、`creditLimitRate 0.5`、无资产默认关、单笔最低 100、每群体每月 ≤1 笔；资产基准=现金+存款+按人数分摊 cityInvestorEquity（不重复计价）；冻结/解冻条件采纳 | 与 C2 一致；键名按 v0.7 冻结（`denyWhenDefaulted`/`denyWhenArrearsMonthsAtLeast`/`allowUnsecuredNoAsset`），无同名新键 |
| #39 | 消费预算：先扣当月还款，再 `min(扣款后现金, 0.8×上月可支配收入 + 0.05×扣款后现金)`；**收入基数不扣还款**（避免双重扣减） | 取代 C2 中"先扣还款再算预算"的文字歧义；实现归块 3，参数在 `households.consumerBudget` |
| #40 | `HouseholdMonthlyStats` 四个字段（预算/新贷/贷款融资消费/资金缺口）批准做追加式契约变更 | 等架构师 SHA 后再引用，本岗不自行改 `types.ts`；报告脚本当前只用既有字段 |
| #41 | 键名以 `config.ts` 冻结为准：`creditLimitRate` / `allowUnsecuredNoAsset` / `denyWhenDefaulted` / `denyWhenArrearsMonthsAtLeast` / `utilizationAssumption` / `fiscalRisk.minAnnualGdp` | 已核对：config.ts 与脚本均用冻结键名；设计稿中旧提案键名已同步替换（保留"建议值"原意） |

**落地状态**：全部数值已进 `src/data/config.ts`（SHA `bb46ff6`）；`scripts/economy-balance-report.ts` 已用冻结键名与契约函数跑通 36 月基线并存档 `docs/development/reports/economy-baseline-36m-v07.{json,csv}`。`HouseholdMonthlyStats` 四字段待架构师契约变更 SHA 后接入（不阻塞当前基线）。
