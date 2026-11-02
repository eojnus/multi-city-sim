# 模拟层实现设计 v1（政府债券 / 破产 / 居民消费与贷款）

状态：**未提交、未改代码**，只读设计稿，供秘书处与架构师冻结契约用。
依据：`briefs/Game3_Combined_Brief.md` + `briefs/SUPPLEMENT_ARCHITECT_v1.md` + `briefs/DECISIONS_v1.md`
（三者冲突时：补充指令 > DECISIONS 冻结表 > 合并版任务书）。
基线：`feature/sim-fiscal` @ `9cef5b5`（v0.6）。

---

## 0. 现状（已核实）

- 无债券、无政府贷款、无财政破产代码。`banking/banking.ts` 只有存款、企业/玩家贷款；`BankOwnerKind = player | household | company | investorGroup`，**没有 government**。
- `City.treasury` 可为负（`fiscal.ts` 里公职工资按名义额支付）；无负债口径。
- `city.gdpHistory` 由 `economy/gdp.ts` 每月写 `{tick,value}`，上限 60；`city.gdp` 由产出增加值算，**无开局估计历史、无 estimated 标记**。
- 居民群体预算在 `household-economy.ts:householdGroupBudget`：`min(上月收入 × 0.96, 手头现金)` —— 与新公式不同。
- 居民群体授信已有雏形：`credit.ts` 的 `household` 分支 = 现金+存款−未偿，额度 = `creditLimitRate`(50%) − 未偿；`serviceOwnerLoans` 已有 grace/违约逻辑。
- 迁移 `rebalanceHouseholdWealthForMigration` 只搬现金/存款；`syncHouseholdPeople` 按人均搬资产，**均无债务**。
- 破产后重选：`politics.advancePolitics` 每月推进任期，选举函数 `holdElection` 未导出。
- 月结顺序在**架构师独占**的 `core/simulation.ts`；本设计给出接入点，请架构师在块 0 加钩子。

---

## 1. 债券全生命周期状态机

### 1.1 数据（建议契约，需架构师落 `contracts/types.ts` + `core/save.ts` v7）

```
world.bonds = {
  issues:   BondIssue[],      // 一期一条
  holdings: BondHolding[],    // 每个持有人 × 每期一条
  payments: BondPayment[],    // 逐笔票息/兑付/垫付记录（可追溯、有上限裁剪）
  nextIssueNumber, nextHoldingNumber, nextPaymentNumber,
  lastSettledTick: number,    // 幂等闸门：同一 tick 只结算一次
}

BondIssue {
  id: 'bond-issue-{n}', cityId,
  faceValue: 1000,            // config.bonds.faceValue
  couponRateAnnual: 0.04,     // config.bonds.couponRateAnnual，发行时锁定
  termMonths: 36,             // config.bonds.termMonths
  unitsPlanned: int, unitsSold: int,
  openTick, maturityTick,     // maturityTick = openTick + termMonths
  status: 'open' | 'closed' | 'matured' | 'redeemedEarly' | 'cancelled',
  lastCouponTick,             // 最近一次付息 tick（0 表示未付过）
  arrearsInterest: number,    // 欠付票息（政府现金不足时记入本字段）
  note: string,
}

BondHolding {
  id, issueId, holder: HolderRef,   // player / investorGroup / company
  units: int, purchaseTick, costPaid,
  status: 'active' | 'paidOff',
  note: string,
}

BondPayment {
  id, cityId, issueId, holdingId, tick,
  kind: 'coupon' | 'principal' | 'insolvencySettle',
  amount, fundedBy: 'treasury' | 'bankAdvance',
  loanId?: string,           // 垫付形成政府贷款时的合同 id
  note: string,
}
```

持有人仅允许 `player / investorGroup / company`（AI 经营者作为 CEO 持股属破产转股问题，见 §4.4；**首版禁止银行认购**，避免左手倒右手（DECISIONS #21））。

### 1.2 状态迁移

| 阶段 | 触发 | 迁移 | 资金动作 | 幂等点 |
|---|---|---|---|---|
| 发行计划 | 市长玩家命令 / AI 市政府月结内自动 | 无 → `open` | 不产生债务、不产生现金 | 同一 tick 每城最多 1 期（`maxIssuesPerMonth`）；同 id 已存在则拒绝 |
| 认购 | 月结撮合（同一结算步骤） | `open` → `closed` | 买家现金 → 发行城 `treasury`；`unitsSold` 累加 | `(buyerKey, issueId)` 订单唯一；`unitsSold` 由 0 起算、逐笔落账，禁止二次入账；二次调用被 `lastSettledTick` 拦截 |
| 计息 | 每月月结 | 不变 | 无现金动作，`accrued` = `faceValue×units×rate/12`；**M12/M24/M36 各付一次票息（共 3 次，年化 4%）** | 以 `lastCouponTick` 判重；付款记录存在则跳过 |
| 票息 | `tick = openTick+12/24/36` | 不变 | `treasury` → 持有人现金；不足部分记 `arrearsInterest`（**不垫付**，DECISIONS #19/#33） | `(issueId, dueTick, kind='coupon')` 有 `BondPayment` 即跳过；M36 票息与本金同月、分别判重 |
| 到期兑付 | `tick = openTick+36` | `closed` → `matured` | 应还 = 本金 + **M36 第 3 期票息** + 累计 `arrearsInterest`；`treasury` 先付，差额银行**无条件垫付**并生成政府贷款 | 以 `maturitySettledTick` / `status=matured` / 已有 `principal` 付款记录三重判重 |
| 破产提前兑付 | 同城破产判定成功（§4） | `closed` → `redeemedEarly` | 银行一次性全额垫付**未到期本金 + 截至破产月已计提未付利息**（含欠付票息），不支付未来利息；随后随政府债务一并勾销（DECISIONS #8 更正） | 同 §4 幂等标记；已 `paidOff` 的 holding 不再付；本金与已计提利息按同一规则只付一次 |
| 取消 | 首版不实现（只允许部分成交关闭） | — | — | — |

### 1.3 认购撮合规则（冻结口径：DECISIONS #4/#5）

1. 只按**整数份**；面额 1000 信用点；不支持半份。
2. 发行计划与成交分开记；部分成交只按 `unitsSold` 形成本金，未售出份数不形成债务。
3. 买家（玩家/居民投资实体/企业，可跨城）只能用**现有可支配资金**，不许触发贷款（`openLoan` 在认购路径里根本不可达，只调 `debitOwnerCash`）。
4. 企业认购保留流动性（DECISIONS #23/#34）：`保留额 = 1.0×上月实发工资 + 1.0×上月应付利息`（无上月数据用当月应发兜底），`可用 = max(0, 现金 − 保留额)`；余额不足 1 份即 0 份，**剩余零钱保留**（例：2,500 → 2 份、支出 2,000、保留 500）。**欠薪或存在未结清违约合同的企业禁止认购**（校验先于撮合，失败不扣款）。
5. 排序确定性：按 `ownerKey` 升序（`sameOwner` 同口径），玩家订单与其投资实体分别排序；同一买家同一期只允许一个订单。
6. 撮合容量：`可售 = unitsPlanned − unitsSold`；订单 `份数 = min(floor(可用/1000), 可售)`；逐笔扣款、建 holding、累加 `unitsSold`；`可售=0` 时停止。
7. AI 认购策略（首版暂定）：居民投资实体用 `min(现金×认购比例, 单期上限)`，企业用 §4 流动性口径，玩家仅显式下单；参数集中 config，由数值岗定值。
8. 发行资金进入 `city.treasury` 并写 `FiscalEntry.kind='bondIssued'`（+），兑付/票息写 `bondInterest`/`bondRedemption`（−），全部经 `treasury.ts` 记账。

### 1.4 失败回滚点（必须测试）

| 场景 | 期望 |
|---|---|
| 买家现金不足 1 份 | 不扣款、不建 holding、`unitsSold` 不变 |
| 认购超出剩余可售 | 只成交可售部分，多出的份数不扣款 |
| 同一 tick 重复结算（读档重放/重复调用） | `lastSettledTick` 拦截，0 元二次扣款 |
| 同月多期到期（A/B 两期同 tick 到期） | 逐期独立结算，每笔只付一次，排序稳定 |
| 票息与到期同月 | 先票息后本金，各自判重；不重复计息 |
| 政府现金不足 | 不抛错；走垫付分支（垫付永不失败） |
| tick 内其他步骤抛错 | `Simulation.tick` 的 deepClone 快照回滚整体状态（现有机制），债券侧只允许"返回失败"，不允许半写 |

---

## 2. 居民消费预算与四层分账

### 2.1 预算公式（冻结口径：任务书 §5.1）

```
参考消费额 = 上月实际可支配收入 × 0.80 + 当时手头现金 × 0.05
现金消费预算 = min(手头现金, max(0, 参考消费额))    // round2
```

- `上月可支配收入` = `group.lastMonth.income`（已核实 = 工资+福利+股息−税+退款，见 `household-economy.ts:applyHouseholdIncome`）。
- 计算时点：月初消费步骤（步骤 7），读的是上一完整月 `lastMonth`，**不再入账、不重复加**。
- 只用手头现金 `group.cash`；**不读银行存款**（`addDepositBalance` 在消费路径不可达）。
- 收入不再是硬上限：收入 0、现金 100,000 → 预算 5,000（验收用例）。
- 80%/5% 进 config：`consumer.cashIncomeRate=0.8`、`consumer.cashStockRate=0.05`，待数值岗确认。

### 2.2 四层分账（每群体 × 每商品 + 城市汇总）

1. **期望需求** `desiredQty`：沿用现公式（人均需求 × 人数 × 就业系数 × 价格弹性 clamp）。
2. **资金支持后的有效需求** `effectiveQty = desiredQty × affordability`，
   `affordability = clamp((现金预算 + 可借额度) / 期望金额, minAffordability, 1)`
   —— **定稿（DECISIONS #26）**：有效需求**不含**可借额度，只用现金预算；贷款只在确认可成交供给后补足现金付不起的部分（见 §3.3）。
3. **实际成交** `boughtQty`：本地 `applyConsumerDemand` → 不足再 `executeIntercityPurchase`，受价格与供给约束。
4. **缺口**（金额与数量双口径）：
   - `fundingGap = max(0, desired − effective)`：资金不足缺口；
   - `supplyGap = max(0, effective − bought)`：供给不足缺口。
   - 两者之和 = 期望 − 成交，不得重复计入同一份缺口。
   - 未成交的钱留在群体现金，不销毁、不算消费。

`ConsumerGroupResult` 扩字段：`desiredCost, effectiveCost, spend, fundingGapQty/Cost, supplyGapQty/Cost`；城市汇总同口径。现有 `budget/spend/desiredCost/unmet/byGroup` 保持兼容。

### 2.3 验收用例

- 现金 100,000 / 上月收入 0 → 预算 5,000，未成交部分留现金。
- 现金 10,000 / 上月收入 100,000 → 预算 = min(10,000, 80,000+500)=10,000。
- 现金 0 / 存款 100,000 → 预算 0（只用手头现金），但可走贷款消费（§3）。
- 收入与现金都 0 → 预算 0，需求记 fundingGap；若无抵押信用关闭则不借款。

---

## 3. 居民群体贷款

### 3.1 额度（冻结口径：财产决定）

```
财产基准 = 手头现金 + 银行存款 − 未偿本金          // 复用 credit.ts household 分支
额度 = max(0, 财产基准) × config.banking.creditLimitRate(0.50)
可借 = max(0, 额度 − 未偿本金)                    // 实时，不缓存
```

- 群体粒度聚合，不逐人生成实体（借款主体 = `{kind:'household', id: groupId}`）。
- 无资产者：基准 0 → 额度 0；`allowUnsecuredCredit=false`（任务书 §5.2 默认关闭的待定开关）。
- 股票权益归居民投资实体，不重复计入群体财产（沿用现有口径）。

### 3.2 真实债务、不计收入

- 放款走 `issueLoan`（银行现金增加），**只**写 `LoanContract` / 银行统计；`group.lastMonth.income` 与 `cash` 均不得因借款增加。
- 消费支出照常从 `group.cash` 扣；贷款资金"即时支付给卖方"，不经过 `group.cash`，避免"借入即现金"的错觉。实现上：`paid = cashPortion + loanPortion`，`loanPortion` 直接由银行划给卖方（本地市场/跨城结算），合同记在群体名下。

### 3.3 供给不足时不得借多余（关键顺序）

每群体每商品：
1. 先用现金预算确定可成交数量 `attainableQty`（本地 + 跨城都按实际供给与价格封顶）；
2. `spend = attainableQty × price`；
3. `cashPortion = min(spend, 现金预算剩余)`；`loanPortion = spend − cashPortion`；
4. 仅当 `loanPortion > 0` 且 `loanPortion ≤ 可借额度` 才放款；否则削减成交量到现金可支付量（缺口记 fundingGap）。
→ 借款额恒等于"已成交中现金付不起的部分"，不会出现借了钱却没买到货。

### 3.4 逾期、宽限、违约

- 复用 `serviceOwnerLoans`（graceMonths=1，missedPayments≥2 → `status='defaulted'`），新增 purpose `householdConsumption`（DECISIONS #24：0.6%/月、24 个月，数值岗出建议值）。
- 违约后（DECISIONS #28/#35）：冻结新增授信（`availableCredit=0`）的判定 = **存在未结清违约合同，或连续欠付 ≥2 个月**；宽限复用 `banking.graceMonths`（不另设段），欠款清零/重组后恢复。仅记录通知与统计；首版**不没收存款、股票或其他资产**。
- 还款从群体现金扣；不足则挂欠款（现有 arrears 机制，不另计罚息）。

### 3.5 迁移与人口变化的债务守恒（硬要求）

现状：`rebalanceHouseholdWealthForMigration` 搬现金/存款；`syncHouseholdPeople` 按人均搬资产。债务必须跟随同一套人均规则：

- **跨城迁移**：`perCapDebt = 未偿/people`；随迁移人数 `leaving` 转移 `round2(min(未偿, leaving × perCapDebt))`，源群体未偿减少、目标城对应群体（按 `laborForceMoved` 拆 unemployed/nonLabor）未偿增加；尾差留在源群体（保证 Σ未偿 不变，银行总资产不变）。实现方式：重写受影响 `LoanContract.borrower` 或拆分合同；推荐**拆分合同**（源合同减额 + 目标新合同等额），保留逐笔可追溯。
- **城内在群体间人数变化**（`syncHouseholdPeople`）：同一算法（人均债务随人数转移）。
- **群体人数 → 0 且仍有未偿**：债务不得静默消失。首版兜底：并入同城人数最多的群体（tie-break by groupId 升序）；同城无任何群体时挂该城居民投资实体；两者都无 → 报错中断本步并记日志（测试覆盖），不删债务。
- **不变量测试**：任意迁移/增减后，`Σ loans.outstanding` 与银行 `loansTotal` 逐笔一致；`Σ 各群体未偿` 不变；合同 `principal = paidPrincipal + outstanding` 保持。

---

## 4. 财政破产

### 4.1 判定（冻结口径：任务书 §四 4.1.4 + DECISIONS #6）

```
负债 = Σ 政府银行贷款未偿（borrower = {government, cityId}，**含 bondAdvance 垫付贷款，只计一次**）
     + Σ 未偿债券本金（faceValue × units，status active）
     + 已计提未付利息（欠付票息 + 政府贷款欠付利息，DECISIONS #20/#25/新 #11）
面板可拆分「普通贷款 / 垫付贷款」展示，但判定只加一次（DECISIONS v1.3-F）。
12 月 GDP 合计 = 最近 12 个自然月真实 GDP 之和，历史不足用开局估计值补齐
判定 = 负债 ≥ max(1, 12 月 GDP 合计) × 100%
```

- `gdpHistory` 每次真实月结追加 `{tick, value, estimated:false}`；开局初始化写入 12 条 `{tick:-12..-1, value: 估计值, estimated:true}`（存档校验必须接受负 tick）；**真实 GDP 到来时删除最早估计条目再写入真实值**，窗口取最近 12 条。旧档：只补缺口、不覆盖真实历史。估计口径 `q̂ = min(capacity, laborCapacity) × 0.8`，80% 只乘一次（DECISIONS #32）。
- 估计口径：企业产出价值 − 中间投入（不含工资/贷款/财政），理论产量 × `config.gdp.openingEstimateRate=0.8`；仅初始化计算，不生产、不改库存/现金。公式落在 `economy/gdp.ts`（调用方为架构师 `initializer.ts`），数值参数由数值岗定。
- 比率与判定统一用 `max(1, 合计)`，市长面板标注"GDP 极低，已使用最低判定值"（UI 侧）。

### 4.2 同月结算顺序（固定，写进架构钩子）

```
步骤 16 之后（GDP 已算完）新增「财政债务与债券结算」：
  a. 债券票息（12/24 月）+ 到期兑付（36 月）—— 按 issueId/kind 确定性排序；
     不足部分：票息→欠付利息；到期本金+欠付票息→银行无条件垫付（purpose='bondAdvance'）
  b. 政府银行贷款本息（含 a 产生的垫付贷款）：有现金则付，不足转欠付、**不罚息、不垫付**
  c. 刷新政府负债总额（口径见 §4.1，垫付只计一次）
  d. 计算 12 月 GDP 合计，判定破产
  e. 破产清算 + 当月立即选举

（顺序依据 DECISIONS #27：刚性支出在步骤 15 已完成 → 债券到期本息 → 银行贷款本息 → 垫付兜底。）
```

- 财政刚性支出已在步骤 15 完成；`treasury` 为负时先自动借政府普通贷款补足到 0（不得留负余额，旧档负余额迁移由架构师 v7 做，我只提供函数与测试）。
- 债券到期与破产同月：b 先付到期债权（每笔只一次），f 只对**仍未兑付**的 holding 垫付；已 `paidOff` 的不再付、不再计入负债。

### 4.3 破产清算动作

1. 未到期债券本金 + 截至破产月按实际持有月份已计提未付利息（含欠付票息，不支付未来利息）：银行立即全额垫付，持有人收款（`BondPayment.fundedBy='bankAdvance'`），`holding.status='paidOff'`，`issue.status='redeemedEarly'`。
2. 勾销：原政府银行贷款 + 垫付形成的新贷款，全部核销（`LoanStatus` 需新增 `'writtenOff'`，待契约；金额进报告）。银行不倒闭、资金无限。
3. 股份转移（见 §4.4）。
4. 当月立即选举：直接调用选举流程（需导出 `holdElection` 或新增 `requestImmediateElection(cityId)`），过渡期现任市长看守（仅维持性操作，UI 侧限制）；选举结果写事件日志。
5. 破产事件幂等：`city.bankruptcy = { declaredTick, eventId, status:'declared' }`；同 tick 重复调用 no-op；`lastSettledTick` 全局闸门。

### 4.4 破产政府股份转移（冻结口径：任务书 §四 4.1.6 + DECISIONS #8）

对每家企业中 `holder = {type:'city', id: 破产城市}` 的全部股份：

1. 有现任 CEO（`CompanyControl.operator` 非 `'management'` 且有 `operatorId`）→ 全部转给该 CEO（玩家或 AI 经营者）。
   - AI 经营者目前不是合法 `HolderType`（只有 player/company/investorGroup/city）→ 需架构师扩展 `'operator'`（DECISIONS #22）。**不得**转给 CEO 所经营的公司。
2. 无 CEO → 在除破产政府外**现有股东主体**之间按**主体数量**平均分配（不是按原持股比例）：每主体 `floor(总量/主体数)`，余数按 `ownerKey` 升序每个主体 +1；股份类别与发行总量不变。
3. 除破产政府外无任何股东 → 无表决权托管：新增 `HolderType 'trust'`（id = `trust-{companyId}`），股份数量保留、不销毁、不增发；投票统计排除 trust。
4. 每步后做不变量校验：该类股份 totalShares 不变、Σ持股 = totalShares。

### 4.5 财政风险预警（模拟层出数，界面按市长权限展示）

`fiscalRisk(city)` 纯函数返回（不写 UI、不做权限）：
- `gdp12` = 最近 12 个月合计（真实 + 估计，按 tick 窗口，`max(1, 合计)`）；
- `debtRatio = 总负债 / gdp12`；
- `level`：`normal`（<50%）、`watch`（50%–<75%）、`high`（75%–<100%）、`insolvent`（≥100%，仅判定，不提前触发）；
- `direction`：与**上一个已结算月的同口径结算后值**比较，`up | down | flat`；无上月数据为 `null`（显示"—"）；
- 附带 `estimatedMonths` / `realMonths` / `usedFloor` 标记，供面板标注"估计占比"与"已使用最低判定值"。

阈值集中 config（`fiscal.riskWatch=0.5`、`riskHigh=0.75`、`riskInsolvent=1.0`，暂定）。判定与预警同源，避免两套口径。权限过滤在 UI（DECISIONS #9），模拟层只提供数据。

---

## 5. 月结接入点（需架构师钩子，我不可改 `core/simulation.ts`）

口径函数统一由契约层提供（DECISIONS #36）：`cityDebt()`、`assessCityFiscalRisk()`、`recent12MonthGdp()` 在 `government/fiscal-view.ts`（契约层），债券汇总字段进 `WorldState.bonds` 契约。我的 `debt.ts` 只**调用**这些函数做清算/垫付，不自行重算负债率与 12 月 GDP；报告与 UI 同源。

请在 `core/simulation.ts` 的 tick 中加入 4 个调用（顺序敏感）：

1. 步骤 5 之后（人口迁移后）：`transferHouseholdDebtOnMigration`（债务随人口/迁移转移；实际在 `rebalanceHouseholdWealthForMigration` / `syncHouseholdPeople` 内部调用更稳，需核对调用点）。
2. 步骤 15 财政结算内：`settleGovernmentDebtService`（政府贷款本息）或放在 3.a。
3. 步骤 16 `computeCityGdp` 之后：`settleGovernmentDebt`（bonds + advance + insolvency + election）——一个入口，内部顺序固定。
4. 开局 `initializer.ts` 调用 `seedOpeningGdpEstimates(world, config)`。

另需契约扩展：`BankOwnerKind + 'government'`、`HolderType + 'operator' | 'trust'`、`LoanPurpose + 'government' | 'bondAdvance' | 'householdConsumption'`、`LoanStatus + 'writtenOff'`、`FiscalEntry.kind + bond* / bankAdvance`、`City.gdpHistory[*].estimated?`、`City.bankruptcy?`、`WorldState.bonds?`。

---

## 6. 计划新增 / 修改文件

### 新增（我的写作用域：`src/simulation/**`、`tests/*.test.ts`）

| 路径 | 内容 |
|---|---|
| `src/simulation/government/bonds.ts` | 发行计划、撮合认购、计息、票息、到期兑付、垫付、付款记录、幂等闸门 |
| `src/simulation/government/insolvency.ts` | 负债汇总、12 月 GDP 窗口判定、破产清算、股份转移、立即选举触发 |
| `src/simulation/population/household-consumption.ts` | 预算公式、四层分账、缺口计算（从 `consumer.ts` 抽出的纯函数） |
| `src/simulation/population/household-loans.ts` | 群体授信/消费放款/违约冻结/债务随人口迁移拆分 |
| `src/simulation/economy/gdp-window.ts` | 12 月窗口、估计历史 seed、真实替换、`max(1, 合计)` |

### 修改

| 路径 | 改动 |
|---|---|
| `src/simulation/government/fiscal.ts` | 负 treasury 自动借政府贷款补足；写入 bond/bank 财政流水 |
| `src/simulation/economy/gdp.ts` | `computeCityGdp` 写 `estimated:false`；导出窗口函数 |
| `src/simulation/population/household-economy.ts` | `householdGroupBudget` 换成新公式（保留旧函数兼容测试） |
| `src/simulation/markets/consumer.ts` | 四层分账 + 贷款消费接入（成交后才借） |
| `src/simulation/population/population.ts` | 迁移时债务随行（调 household-loans） |
| `src/simulation/population/household-groups.ts` | `syncHouseholdPeople` 债务随人数转移 |
| `src/simulation/banking/banking.ts` | 政府/居民贷款产品接入、垫付、核销、`writtenOff` 处理 |
| `src/simulation/banking/credit.ts` | household 消费贷款额度用途与违约冻结 |
| `src/simulation/politics/politics.ts` | 导出/新增 `requestImmediateElection`（破产重选） |
| `src/simulation/securities/securities.ts` | 破产股份转移、trust 托管、投票排除 |
| `src/simulation/notifications.ts` | 债券到期/垫付/违约/破产事件通知（按权限过滤市长方可见） |

### 明确不改（硬边界）

`src/ui/**`、`src/app/**`、`src/simulation/contracts/types.ts`、`core/{save,simulation,initializer,invariants}.ts`、`src/data/config.ts`（结构）、`docs/architecture/**`、`package.json`、构建配置。

### 路径归属（重要，避免与架构师 stub 双份实现）

架构师块0 已按最终落点新建 stub：`src/simulation/government/{bonds,debt,fiscal-view}.ts`、`src/simulation/economy/gdp-window.ts`、`src/simulation/population/household-finance.ts`。
合入 `feature/arch-foundation` 后：**以 stub 路径为准**填实现；本稿原计划的 `government/insolvency.ts` → 并入 `government/debt.ts`，`population/household-consumption.ts` + `household-loans.ts` → 并入 `population/household-finance.ts`，`economy/gdp-window.ts` 同名保留；不另建平行文件。合入后先向秘书处报「设计稿文件清单 → 实际路径」映射表，批准后再开第一批编码。

### 需要别人配合

- 架构师：§5 的契约扩展 + tick 钩子 + v7 迁移（旧档负余额、bonds 默认值、gdpHistory estimated）。
- 数值岗：全部暂定参数数值（利率、80%/5%、认购比例、GDP 80% 系数、流动性保留）。
- 界面：非市长不可见字段（本设计不涉 UI，但类型里避免把敏感字段塞进公开模型）。

---

## 7. 计划测试文件（全部新增，`tests/*.test.ts`）

| 文件 | 覆盖 |
|---|---|
| `tests/bonds-issuance.test.ts` | 整数份、部分成交、跨城/多主体、超额拒绝、现金不足不扣款、禁止贷款认购、剩余零钱保留、同 tick 重复结算 |
| `tests/bonds-lifecycle.test.ts` | 36 月到期、12/24 月票息、计息精度与 round2、垫付生成政府贷款、同月多期到期、票息+到期同月 |
| `tests/government-insolvency.test.ts` | 100% 判定、GDP 窗口、垫付勾销、股份转 CEO/按主体平分/无股东托管、当月立即选举、破产幂等、同月到期+破产无重复 |
| `tests/gdp-window.test.ts` | 12 月估计 seed、逐月替换真实值、`max(1,合计)`、旧档缺口补齐、estimated 标记不被改写 |
| `tests/household-consumption-budget.test.ts` | 80/5 公式、无收入有积蓄=5,000、只用手头现金、四层缺口、现金不足留钱 |
| `tests/household-consumption-loans.test.ts` | 额度=财产×50%−未偿、供给不足不借多余、借款不计收入、逾期/违约冻结、无资产不借 |
| `tests/household-debt-conservation.test.ts` | 迁移/城内人数变化债务守恒、群体归零兜底、合同拆分、存档往返 |
| `tests/fiscal-save-roundtrip.test.ts` | 存档往返后债券到期/破产只结算一次（读档重放幂等）、旧档迁移后余额口径 |

命名均不与现有 `tests/` 冲突（已核对）。

---

## 8. DECISIONS v1.3 冻结项落实（#25–#31，原 7 条待决全部拍定）

| 决定 | 落实点 |
|---|---|
| #25 再次破产/再发债 | §4.1 判定：勾销后允许重新累计，同一 tick 只判一次；`city.bankruptcy.caretaker=true` 期间发债/政府投资入口返回失败 |
| #26 有效需求不含可借额度 | §2.2 定稿：有效需求只用现金预算；§3.3 先确认可成交供给再对现金付不起部分放款 |
| #27 偿付顺序 | §4.2 定稿：刚性支出（步骤 15）→ 债券到期本息 → 银行贷款本息；不足转欠付、不罚息，仅到期债券由银行垫付兜底 |
| #28 违约不没收资产 | §3.4：冻结新增授信 + 通知，不处置存款/股票/资产 |
| #29 AI 政府自动发债 | §1.4：与玩家共用同一 `issueBond` 校验路径（整数份/部分成交/不借新还旧），无后门；`treasury < 上月财政支出×阈值` 触发，每城每月 ≤1 期，阈值数值岗 |
| #30 householdCredit 独立 config 段 | §3.1/§6：键归架构师、值归数值岗，不复用 personal 产品参数 |
| #31 破产过渡期 | §4.3：现任市长看守；禁新发债/新增政府投资，直至重选完成、新市长就任 |
| #32 开局 GDP 口径 | §4.1：`min(capacity, laborCapacity)×0.8`，tick −12…−1、estimated:true，真实到来删最早估计；旧档只补缺口 |
| #33 三次票息 | §1.2：M12/M24/M36 各付票息，M36 同时还本，合计 3 次（年化 4%）；破产提前兑付按实际持有月计未付票息 |
| #34 企业认购限制 | §1.3-4：欠薪/未结清违约企业禁止认购；保留额 = 1.0×上月实发工资 + 1.0×上月应付利息（无上月用当月应发兜底） |
| #35 群体贷冻结 | §3.4：未结清违约合同或连续欠付 ≥2 月 → 新授信 0；grace 复用 `banking.graceMonths` |
| #36 公共口径归契约层 | §5：`cityDebt/assessCityFiscalRisk/recent12MonthGdp` 由契约层提供，我调用不重算；债券汇总进 `WorldState.bonds` |

本稿结构定稿，等待架构师契约冻结后按批次开工。

---

## 9. 守恒/幂等/回滚一览

- 资金守恒：认购 buyer→treasury；票息/兑付 treasury→holder；垫付 银行→holder 且 +政府贷款；核销只减银行资产。每笔进 `BondPayment` + `FiscalEntry`。
- 债券守恒：`unitsSold = Σ holding.units`（active + paidOff 合计）；`Σ 每期本金 = Σ 持有份额`。
- 幂等键：`bonds.lastSettledTick`、`(issueId, holdingId, dueTick, kind)` 付款记录、`city.bankruptcy.declaredTick`、垫付贷款 id `gov-advance-{issueId}-{tick}`。
- 垫付记账：一笔垫付只有一份 `LoanContract(purpose='bondAdvance')`，总负债/银行存量均从合同读，面板拆分子项不重复计入。
- 回滚：tick 级 deepClone 快照；业务失败只返回 `{ok:false}` 或跳过，不半写。
- 确定性：所有排序用 id/ownerKey 升序；随机仅用 `DeterministicRng`（本设计无随机，AI 认购全部确定性）。

---

## 10. 实施批次（契约冻结后）

| 批次 | 内容 | 前置 | 测试 |
|---|---|---|---|
| 1 | 债券状态机：发行/认购/计息/票息/到期/垫付 + 付款记录 + 幂等 | 契约 #22、bonds 类型、成员 `BankOwnerKind 'government'` | `bonds-issuance`、`bonds-lifecycle` |
| 2 | 破产与清算：负债汇总、12 月 GDP 窗口、判定、垫付、勾销、股份转移、当月重选、过渡期 | 批次 1 + `settleGovernmentDebt` 钩子 + gdpHistory.estimated | `gdp-window`、`government-insolvency`、`fiscal-save-roundtrip` |
| 3 | 居民消费：预算公式（80%+5%）、四层分账、缺口 | 契约 consumer 段、credit 快照兼容 | `household-consumption-budget` |
| 4 | 居民群体贷款：额度/供给后放款/不计收入/违约/债务随迁移 | 批次 3 + `householdCredit` 段 + 迁移钩子 | `household-consumption-loans`、`household-debt-conservation` |

每批：`npm run typecheck` + `npx vitest run <本批测试>` + 回归全量，再报秘书处。不一次铺开。
