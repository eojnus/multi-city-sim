# 交付报告 v0.7：政府债券 · 政府债务 · 居民消费金融 · 财政可见性

日期：2026-11-02 ｜ 分支：`feature/economy-fiscal-balance`（交付分支）｜ 契约冻结提交：`18e2617c1e1b143146b08fa90de7e7d146a36dbf`（`feature/arch-foundation`）

> 状态：**技术章节（架构师起草，随集成更新）**。证据章节（第 9 节）由验收员补齐；集成记录（第 10 节）随合并更新。
> 文中【暂定】的数值、公式与流程均为可替换原型，**不是用户已确认的最终规则**；用户已确认的规则单独标注。

## 1. 本轮范围

按任务书 §三/§四/§八与 `DECISIONS_v1.md`（v1.4）实现：

- 城市政府债券：发行计划与实售分离、部分成交只按实售形成本金、票息与到期兑付、银行垫付。
- 政府债务口径：银行贷款（含垫付转贷）+ 未偿债券本金 + 已计提未付利息；12 个月 GDP 判定窗口与债务率/风险分级。
- 破产语义：未到期债券本金 + 截至当月已计提未付利息一次性兑付，随后银行贷款与垫付贷款一并勾销；无按比例清偿；当月触发重选、看守期仅维持性操作【团队暂定】。
- 居民群体消费预算与消费贷款（预算口径、授信、贷款真实计入债务）。
- 财政可见性：日志/通知与财政视图按当前市长身份重校验，旧档迁移归类。
- 存档格式 v7（v1–v6 可迁移）与契约空实现签名（供验收先写测试）。

不在本轮范围：银行倒闭（银行无限资金）、按比例清算表、AI 自动发债的完整策略（仅留键位）。

### 1.1 块0 契约冻结交付摘要

| 项 | 实际数据 |
|---|---|
| 契约分支 | `feature/arch-foundation`，起于 `9cef5b5` |
| 契约冻结 commit | `18e2617`（types/config/initializer/metrics/save/simulation/invariants + IMPLEMENTATION_v0.7.md） |
| 契约追加 commits | `19e394c`（#40 字段确认）、`74629d1`（120 月用例超时）、`5fec771`（#42/#43）、`73b8ce5`（#42 校验）、`9011ad9`（数值岗首版值）、`2129b04`（交付报告骨架）及 docs 若干 |
| 文件规模 | 块0 16 个文件、+3186/−23 行；IMPLEMENTATION_v0.7.md 16 节 |
| 验证 | typecheck ✓；vitest 40 文件/306 用例 ✓；build ✓（arch worktree 与交付分支各一次） |
| 空实现签名 | 5 个骨架文件，业务体 TODO（`bonds/debt/gdp-window/household-finance/fiscal-view`）；`metrics.ts` 为实实现 |

## 2. 契约变更（`src/simulation/contracts/types.ts`，版本 7 / 游戏 0.7.0）

### 2.1 枚举扩展（冻结）

| 枚举/联合 | 新增 |
|---|---|
| `BankOwnerKind` | `'government'` |
| `HolderType` | `'operator'`、`'trust'` |
| `LoanPurpose` | `'government'`、`'bondAdvance'`、`'householdConsumption'` |
| `LoanStatus` | `'writtenOff'` |
| `FiscalEntry.kind` | `governmentLoanProceeds`、`governmentLoanRepayment`、`governmentLoanInterest`、`bondIssuanceProceeds`、`bondInterest`、`bondPrincipal`、`bankAdvance`、`debtWriteOff` |
| `NotificationKind` | `'fiscal'`、`'bankruptcy'` |

### 2.2 新结构（权威 vs 派生）

- `world.bonds: BondState`：`BondIssuance`（计划/实售/未售份数、票息、到期、状态、批次统计 `couponsPaid`/`principalRepaid`/`bankAdvancedAmount`）、`BondHolding`（持有人×批次×购买时点）、`BondPayment`（coupon/principal/bankruptcyRedemption，含 `fundedByBankAdvance`/`advanceLoanId`）。
- `city.government: CityGovernmentState`：`GovernmentLoanContract`（`purpose: government|bondAdvance`，政府银行贷款**唯一权威账本**）、`GovernmentPayable`（应付项，幂等锚 `(cityId,tick,kind,issuance/loan/holder)`）、`GovernmentAdvanceRecord`（**流水，不计入总负债**）、`GovernmentDebtSummary`（月度快照与趋势基准）、`GovernmentBankruptcyRecord`、`CityBankruptcyState`。
- `world.householdFinance: HouseholdFinanceState`：`HouseholdLoanContract`、`ConsumerBudgetSnapshot`。
- `city.gdpWindow: CityGdpPoint[]`（≤12 条，估计月 tick −12…−1、`estimated=true`）、`city.gdpEstimate: GdpEstimateInfo|null`；`city.gdpHistory[*].estimated?: boolean`。
- 权限投影：`ViewerIdentity`、`FiscalVisibility`、`MayorFiscalView`（含 `MayorBondIssuanceView` 计划/实售/未售）、`PublicBondOfferView`（白名单，不含计划总额/总售额/总债务）、`OwnBondHoldingView`。
- `LogEntry`/`PlayerNotification` 新增 `visibility?: FiscalVisibility`（因 `PlayerNotification.audience` 已被占用而改名，语义等价）。

### 2.3 统计字段（v1.4 #37，可选字段，未填充时报告标“近似”）

`CompanyMonthlyStats.operatingCashFlow`；`HouseholdMonthlyStats.budget/loanDrawn/loanFinancedConsumption/unmetFunding`（DECISIONS v1.5 #40 确认追加：只加不改、既有字段语义不变、存档 v7 校验接受缺省、块3 填充）。

**v1.5 #40 四字段定稿**：`HouseholdMonthlyStats` 追加 `budget`（本月消费预算）、`loanDrawn`（本月新借消费贷）、`loanFinancedConsumption`（贷款融资的消费额）、`unmetFunding`（预算缺口），均为**可选**（`?`）字段，旧档/暂未填充时为 `undefined`，不改变既有字段语义；块3 负责填充并补报告口径。`CityMonthlyReport.consumerLoanDrawn/consumerLoanRepaid/consumerLoanOutstanding/bondInterestPaid/bondPrincipalPaid/bankAdvanceThisMonth/totalDebtAtMonthEnd/debtRatioAtMonthEnd/gdpJudgementValue`。

### 2.4 契约追加清单（DECISIONS v1.5 #40–#43，追加式、不改既有语义）

| 编号 | 内容 | 落点 |
|---|---|---|
| #40 | `HouseholdMonthlyStats` 追加四个可选字段 `budget`、`loanDrawn`、`loanFinancedConsumption`、`unmetFunding` | `types.ts`；存档 v7 接受缺省 |
| #42 | `City` 追加可选 `fiscalExpenseBaseline`（开局首月财政支出基线；缺省时 AI 发债退回上月财政支出） | `types.ts` + `save.ts` 可选数值校验 |
| #43 | `aiGovernment` 键名去歧义：`triggerBelowExpenseMonths 0.5`、`maxIssuesPerCityMonth 1`、新增 `topUpToExpenseMonths 1.0`；`maxDebtRatioToIssue 1.0` | `config.ts`（结构/键名由架构定） |
| #43 附带 | 数值岗首版值：`maxPlanUnitsPerIssue 100_000`、`aiGovernment.enabled true`（#29 AI 默认） | `config.ts`（值由数值岗定） |

## 3. 存档 v7 与迁移矩阵

格式版本 `SAVE_FORMAT_VERSION = 7`；分派顺序写死（冻结后不改名，见 `docs/architecture/IMPLEMENTATION_v0.7.md` §6.1）：

| 入口版本 | 迁移函数 |
|---|---|
| `=== 1` | `migrateWorldV1` |
| `<= 2` | `migrateWorldV2ToV3` |
| `<= 3` | `migrateWorldV3ToV4` |
| `<= 4` | `migrateWorldV4ToV5` |
| `<= 5` | `migrateWorldV5ToV6` |
| `<= 6` | `migrateWorldV6ToV7` |

`migrateWorldV6ToV7` 默认值（冻结）：

| 旧状态 | 迁移结果 |
|---|---|
| `city.treasury < 0` | 等额转该城 `GovernmentLoanContract{purpose:'government'}`（利率/期限取 `config.government.loan`，不额外发钱），`treasury = 0` |
| 缺 `world.bonds`/`world.householdFinance`/`city.government` | 建空状态；`city.bankruptcy` 镜像默认 `solvent` |
| GDP 判定窗口缺失 | 优先真实 `gdpHistory`（最近 12 条，`estimated=false`），缺口用开局估计补（tick `-missing…-1`，`estimated=true`）；已有窗口不覆盖 |
| 日志/通知缺 `visibility` | 含财政关键词且能定位城市 → `mayor`；其余 `public` |
| 未知贷款 `status` | 兜底 `'active'`，不猜测结清 |
| 重复执行 | 幂等：不重复转贷、不覆盖已有窗口/估计/可见性、不抛异常 |

迁移后统一 `validateWorldStructure` → `syncCompanyTotalSharesSafe` → `checkInvariants`；`migratedFrom` 记录入口版本。新增校验器：`validateGdpWindow`、`validateGdpInfo`、`validateCityGovernments`、`validateBonds`、`validateHouseholdFinance`、`validateVisibility`。

## 4. 月结顺序（冻结）

`Simulation.tick()` 保持既有顺序，只在 `computeCityGdp` 之后插入：

```
… → settlePolicies → generateProposals → 融资/股票撮合 → publishNotices
  → computeCityGdp                         // 记录本月真实 GDP
  → pushRealGdpPoint(每城)                  // 真实 GDP 入 12 月判定窗口，替换最早估计月
  → settleGovernmentDebt(world, config, logs)  // 政府债务月结唯一入口
  → 历史点 / 不变量校验 / 日志
```

`settleGovernmentDebt` 内部固定阶段（业务实现不得调换）：

| 阶段 | 内容 | 关键约束 |
|---|---|---|
| ① | 归档本月真实 GDP 与财政收支结果 | 估计值不得冒充真实历史 |
| ② | 计提本月利息 + 生成应付项 | 债券票息固定 3 期 M12/M24/M36；**M36 同时生成第 3 期票息与到期本金两笔应付**；幂等锚防重复计提 |
| ③ | 票息与到期兑付，先用财政余额 | M12/M24 票息不足**不垫付**，记欠付利息；M36 本金+欠息不足由银行无条件垫付 |
| ④ | 银行垫付 | 不受授信限制；写 `GovernmentAdvanceRecord` + `bondAdvance` 贷款，逐笔可追溯 |
| ⑤ | 债务汇总与破产判定 | 用阶段②已计提利息；`debtRatio ≥ bankruptAt(1.0)` 即破产 |
| ⑥ | 破产清算与重选 | 一次性兑付本金+已计提未付利息；勾销贷款；当月触发重选 |

同一 tick 幂等：`city.government.settledTicks` 内的 tick 不得重复兑付/清算。

## 5. 口径与计算公式

### 5.1 总负债（DECISIONS v1.1 #11 更正版，冻结）

```
totalDebt = bankLoanPrincipal          // 普通政府贷款未偿本金
          + bankAdvancePrincipal       // bondAdvance 垫付转贷未偿本金（垫付只在这里计一次）
          + bondPrincipalOutstanding   // 未偿债券本金
          + loanAccruedInterest        // 政府贷款已计提未付利息+欠付利息
          + bondAccruedInterest        // 债券已计提未付利息+欠付票息
```

`GovernmentAdvanceRecord` 只是流水，**不得**再加总一次。公共口径唯一实现：`src/simulation/government/metrics.ts` 的 `cityDebt` / `recent12MonthGdp` / `assessCityFiscalRisk`（报告脚本、UI、模拟共用）。

### 5.2 债务率与风险分级【暂定】

- 分母 `gdpJudgementValue = max(config.government.fiscalRisk.minAnnualGdp, Σ 最近 12 个月窗口值)`，首版最小年 GDP=1。
- `debtRatio = totalDebt / gdpJudgementValue`；`<0.5` 正常、`[0.5,0.75)` 关注、`[0.75,1.0)` 高风险、`≥1.0` 破产。
- 趋势与上一结算月 `lastDebt.debtRatio` 比较，差绝对值 `< trendEpsilon(0.005)` 为持平，无上月数据为 `unknown`。

### 5.3 开局 GDP 估计【暂定】（DECISIONS #6 / v1.4 #32）

`q̂ = min(capacity, laborCapacity) × utilizationAssumption(0.8)`（80% 只乘一次）；月度估计 = Σ 企业 `q̂ × (产出市场价 − Σ配方投入×市场价)`，夹 max(0)；同值填 12 个月，tick −12…−1，`estimated=true`；真实 GDP 逐月从最早估计月替换；`gdpHistory` 不混入估计值。

### 5.4 债券与破产【部分团队暂定】

- 面额 1000/份、整数份；发行当月一次撮合、不跨月续售；未售出关闭不形成债务；银行不得认购国债；禁止贷款购债。
- 票息年化 4%，M12/M24/M36 各付一次；M36 同时还本。
- 破产兑付 = 未到期债券本金 + 按实际持有月份计提的未付利息（不付未来利息）；随后政府银行贷款与垫付转贷一并勾销，**无按比例清偿、无优先级清偿表**；同月到期+破产各笔只付一次。
- 破产重选：判定当月结算内立即触发；过渡期现任市长看守、仅维持性操作【团队暂定】。
- 破产后政府持股：无 CEO 时在除破产政府外现有股东之间按股东主体数量平均分配；无其他股东转 `trust` 无投票权托管，不销毁、不转给公司、不增发【团队暂定】。

### 5.5 居民消费预算与消费贷【暂定】

- 参考消费额 = 上月实际可支配收入 × 0.8 + 手头现金 × 0.05；现金预算 = `min(现金, max(0, 参考))`；存款首版不自动取出。
- 消费贷额度 = `max(0, 群体财产基准) × 0.5`，月利率 0.6%、24 月，宽限复用 `banking.graceMonths`；新授信冻结条件：存在未结清违约合同或连续欠付 ≥2 月。
- 贷款是真实债务，资金由银行付给商品卖方，不进入居民收入口径；资金不足未满足计入 `unmetFunding`。

## 6. config 新增键（键名冻结；默认值见 `src/data/config.ts`，数值岗可整段替换数值）

- `households.consumerBudget`：`lastIncomeShare 0.8`、`cashShare 0.05`、`depositsIncluded false`。
- `households.householdCredit`：`rateMonthly 0.006`、`termMonths 24`、`creditLimitRate 0.5`、`minLoanAmount 100`、`denyWhenDefaulted true`、`denyWhenArrearsMonthsAtLeast 2`、`maxLoansPerGroupPerMonth 1`、`allowUnsecuredNoAsset false`（额度口径占位）。
- `households.budgetSnapshotMonths 24`。
- `government.bondMarket`：面额 1000、年化 0.04、付息周期 12、期限 36、单次计划上限 100000 份（数值岗首版值）、发行间隔 1 月、认购顺序 `player → investorGroup → company`、银行不得认购、发行月单次撮合。
- `government.companyPurchaseReserve`：`wageMonths 1`、`interestMonths 1`（企业购债流动性保留，#23）。
- `government.loan`（0.005/24/10000）、`government.advance`（0.005/24/createLoanContract）。
- `City.fiscalExpenseBaseline?`（v1.5 #42，可选）：开局首月财政支出基线，AI 发债按倍数计算的参考；缺省退回上月财政支出，存档 v7 接受缺省。
- `government.fiscalRisk`：0.5 / 0.75 / 1.0 / minAnnualGdp 1 / trendEpsilon 0.005。
- `government.gdpEstimate`：0.8、12 月、method 文本。
- `government.bankruptcy`：`triggerElectionSameTick true`、`shareDistribution 'byHolderCount'`、`custodyShareKind 'nonVoting'`。
- `government.aiGovernment`（v1.5 #43 改名冻结）：`enabled true`（#29 AI 默认开启，块1 实现前无副作用）、`triggerBelowExpenseMonths 0.5`（月支出倍数）、`maxIssuesPerCityMonth 1`、`topUpToExpenseMonths 1.0`、`maxDebtRatioToIssue 1.0`；块1 实现触发逻辑。
- `government.payableRetentionMonths 24`、`maxBankruptcyRecords 8`。
- `banking.products` 增加 `government`/`bondAdvance`/`householdConsumption` 三项（仅为枚举闭合与台账展示）。

## 7. 最小编译适配清单（枚举扩展的连带修改，**不改原逻辑**，交付单列）

| 文件 | 改动 |
|---|---|
| `src/simulation/banking/banking.ts` | `LOAN_PURPOSE_LABELS` 增加 3 个新用途标签；`ownerExists` 增加 `'government'` 分支（城市存在即有效） |
| `src/simulation/banking/credit.ts` | `ownerLabel`/`ownerCash`/`creditOwnerCash`/`debitOwnerCash` 增加 `'government'` 分支（镜像财政余额，不复制存款）；`ownerCreditBase` 返回 `{baseValue:0, method:'netWorth'}`（银行不给政府授信） |
| `src/ui/panels.ts` | `LOAN_PURPOSE_LABELS` / `LOAN_STATUS_LABELS` 各补充新枚举文案（仅展示） |
| `src/simulation/core/save.ts` | `HolderRef` 改为复用 `types.ts` 的 `HolderRef`（避免联合扩展后窄化失败） |

上述改动不改变既有行为；若后续块1/3 需要扩大 `BankOwnerKind` 的实际业务语义，由架构师追加契约，不在本轮自动扩展。

## 8. 已知限制与未完成项

- 块1（债券/债务/月结业务）、块3（居民消费预算与消费贷）、块4（界面与权限投影）的业务体在块0 为空实现+TODO，由对应岗位按 `IMPLEMENTATION_v0.7.md` §13 完成。
- `aiGovernment` 自动发债策略未实现，仅键位占位。
- 统计字段为可选：未填充时报告使用近似式并标注。
- 政府债务在银行台账中仅镜像展示，权威在 `city.government`；若某块把政府贷款同时写入 `banking.loans` 并可被 `cityDebt` 统计，会构成双计（不变量已提供 `lastDebt` 对账检查）。
- **企业清算债务全额减免（既有规则，本轮沿用）**：企业倒闭清算时银行按合同受偿，剩余债务全额减免并留痕。数值岗 36 月基线显示 6 家倒闭企业银行实收 0、减免合计 166,267,450（占期末未偿 40.0%）；本轮不改变该规则，但它会显著压低银行利息收入、放大负利差，属于需要在经济平衡中确认的已知偏差。
- **银行负利差（既有规则，本轮沿用）**：存款月息 0.10%，而部分贷款（政策性/政府垫付 0.5%/月）与坏账核销叠加后，36 个月基线中 36/36 月利息收入 < 利息支出（M36 0.78M vs 1.88M）。银行不倒闭、资金无限，本轮不建模银行资本充足率与破产。
- **破产后 AI 发债不恢复（v0.7 已知限制，不修）**：赤字转成的政府贷款每月分期到期，使 AI 发债的“禁借新还旧”判定恒真，城市只能靠银行普通贷款重建债务；岚港 t36 负债率 73.0% 再次逼近 100%，属机制性限制，v0.7 不修。
- **勾销口径（DECISIONS_v1.md #44）**：`writtenOff` 贷款必须 `outstanding=0`、`paidPrincipal=principal`、`status='writtenOff'`；报表必须单列“已勾销”，不得计入“已还本金”。岚港 t27 破产垫付 485.3M 属已勾销，不是已还。
- **银行垫付成本隐性**：破产垫付由银行全额核销，银行无资本/亏损口径、不倒闭，破产成本不体现在银行报表，属已知近似。
- **跨城持有人不承担破产损失**：破产时未到期债券由银行全额兑付本息，跨城持有人（`investorGroup`）不承担发行人违约损失，风险由政府/银行端吸收。
- **公开破产面板已实现（`e49079d`）**：市民可见破产状态、银行垫付、已勾销与股份托管信息；不可见财政余额与收支流水，符合 #9 白名单。
- 桌面走查、Xvfb 截图与泄漏回归由验收员按验收矩阵执行，本文不预填结果。
- `tests/economy-stability.test.ts` 的 120 月用例超时由 30s 放宽到 60s（commit `74629d1`）：2 核本机多 worktree 并行时该用例实测 36–38s，属环境争用，非功能回退。

### 8.1 块6 实测事实（36 月独立复跑，`8f18e13`，交付分支经 `f324d90` 合入，**已发生，不是理论上限**）

- 破产：**仅岚港 t27** 进入破产，判定负债率 **102.5%**（总负债 561,851,754.85 / 判定 GDP 548,097,298.46）。银行垫付 **485,295,713.34**（破产兑付债券本金 467,536,000 + 未付利息 17,759,713.34，共 31 笔），随后勾销政府银行贷款：勾销银行普通贷款本金 **75,735,776.76**、未清偿利息 **820,264.75**。
- 铁谷：t36 **未破产**，实测负债率 **70.0%**（期末负债 399,136,143.67）；青原未触发（负债率 0）。
- GDP 三点：M1 562,354,455.65 → M12 233,072,379.67 → M24 217,615,506.15 → M36 174,921,250.38。
- M36 财政：岚港 0 / 铁谷 0 / 青原 +49,610,497.23。**0 是融资与清算补足的结果，不是经营改善**：岚港/铁谷经营收入 419.1M / 428.6M vs 经营支出 1,149.5M / 845.7M，融资净额 670.4M / 377.2M，期末负债 132.0M / 399.1M。
- 股份转移：破产记录为“0 个主体”——数据条件不满足、**未触发验证**（不得写“验证通过”）。
- 债券：24 期全部成交（未售 0），持有人全部为 `investorGroup`，跨城持有覆盖三城；累计银行垫付与破产兑付金额一致（485,295,713.34）。
- 该结果说明现有参数下破产在 36 月观察窗内真实触发，经济平衡需按“已发生”而非“理论上限”评估。

## 9. 验收证据（由验收员补齐）

- [ ] 三件套实际输出（typecheck / vitest 文件与用例数 / build）
- [ ] 存档矩阵：v1–v6 旧档 → v7 往返，不覆盖用户存档
- [ ] 桌面走查截图：市长/非市长、跨城、发债、到期、垫付、破产、换任、空态
- [ ] 泄漏回归：`panels.ts:346`、`RegionalScene.ts:266`、`panels.ts:761/945–1003` 修复前后证据
- [ ] 验收用例清单与红/绿结果（90–110 条目标）
- [ ] 每城开局 GDP 估计数值表与 36 月观察指标

## 10. 集成记录（秘书处/架构师填）

| 步骤 | 来源分支 | merge SHA | 提交主题 | typecheck | vitest | build |
|---|---|---|---|---|---|---|
| 0 | `feature/arch-foundation` | `1b1459c` | 块0 契约冻结：v0.7 财政契约与存档 v7 | ✓ | 40 文件 / 306 用例 ✓ | ✓ |
| 0b | `feature/arch-foundation` | `22adfc4` | v0.7 交付报告骨架（仅 docs） | ✓ | 40 文件 / 306 用例 ✓ | ✓ |
| 0c | `feature/ui-fiscal` | `644085a` | 财政可见性第一批（审计 #1/#3–#8/#10–#13/#16 + 回归） | ✓ | 未单记；下一合并点合计 41 文件 / 315 用例 ✓ | ✓ |
| 0d | `feature/arch-foundation` | `2983c2c` | 契约追加 #40–#43 + 稳定性用例超时放宽 | ✓ | 41 文件 / 315 用例 ✓ | ✓ |
| 1 | `feature/sim-fiscal` | `ee1a949` | 政府债券状态机（发行/认购/票息/到期/破产兑付/垫付）+ 审计 #9 | ✓ | 42 文件 / 328 用例 ✓ | ✓ |
| 2 | `feature/data-tuning` | `da2dcaa` | 数值参数回填、36 月基线脚本与档案、块6 观察表 | ✓ | 42 文件 / 328 用例 ✓ | ✓ |
| 3 | `feature/ui-fiscal` | `7c5edf7` | 块4 财政面板/债券市场/KPI 企业数（投影+命令+走查） | ✓ | 未单记；下一合并点合计 42 文件 / 328 用例 ✓ | ✓ |
| 4 | `feature/arch-foundation` | `b24afdd` | 契约追加 `BondPayment.holdingId`（幂等键） | ✓ | 42 文件 / 328 用例 ✓ | ✓ |
| 5 | `feature/sim-fiscal` | `1d138a6` | 块1 债券状态机 + 块2 破产清算/月结六阶段/12 月 GDP 窗口 + holdingId 幂等补全 | ✓ | 44 文件 / 345 用例 ✓ | ✓ |
| 10 | `feature/data-tuning` | `d637c27`（含 `9bf24d2`、`fd1da67`） | 块6 探针（36 月破产/重选/融资拆解）与报告脚本修复、B10.4 过期标注 | ✓ | 44 文件 / 345 用例 ✓ | ✓ |
| 11 | `feature/sim-fiscal` | `08311cd`（含 `110ec41`、`2553cd1`） | 块3/4 居民消费预算与群体消费贷 + 债券兑付三点入账/应付项金额与笔数分字段/贷款欠付并入 | ✓ | 45 文件 / 362 用例 ✓ | ✓ |
| 12 | `feature/data-tuning` | `316eff4`（含 `40a3c86`） | 破产后限贷已知限制与 D11 实测列 | ✓ | 45 文件 / 363 用例 ✓ | ✓ |

- 当前集成分支 HEAD：`b85cc0f`（代码合并点；其后文档提交不改变用例数）。后续 #8 验证与最终冻结后再更新。核对日 2026-11-02。
- 在途：sim 批次3 = 债券兑付入账修复（§11 #6，货币守恒）+ `payablesInArrears` 贷款欠付统计（§11 #4）+ `payablesPaid` 统计口径（§11 #2），合入后更新本表。
- 用例数分阶段口径：块0 `1b1459c` 306 → #40–#43 `2983c2c` 315 → 债券第一批 `ee1a949` 328 → 数据/UI 合并 `da2dcaa`/`7c5edf7`/`b24afdd` 328 → 块2 `1d138a6` 345。
- 数值段合并后核对：`aiGovernment` 保持 #43 新键名（`triggerBelowExpenseMonths`/`maxIssuesPerCityMonth`/`topUpToExpenseMonths`/`maxDebtRatioToIssue`），`maxPlanUnitsPerIssue 100_000`，无结构回退。

- 交付分支：`feature/economy-fiscal-balance`；禁止推送 main、禁止 force push。
- 推送状态：本机无推送凭据（`git push --dry-run` 返回 `could not read Username`），交付以本地完整 SHA + bundle/patch 为准。

## 11. 缺陷与修复记录（架构师维护）

| # | 现象 / 根因 | 处理 | 状态 |
|---|---|---|---|
| 1 | `economy-stability` 确定性用例在 index 6 红灯：AI 自动发债的认购序列含 `player`，导致玩家现金被被动扣光、后续投资失败 | sim 批次2 修复（`54e2d7f`）：`maybeAutoIssueGovernmentBond` 认购循环跳过 `holder.kind === 'player'`，玩家买债只能由玩家主动操作 | 已修，345 用例绿 |
| 2 | `payablesPaid` 把“支付笔数”混入金额累加（`debt.ts:565/578/592/611`），`result.payablesPaid` 可大于 `payablesCreated`，月报统计失真 | sim 批次3 已修：金额与笔数分字段统计（详见 `docs/architecture/REVIEW_debt_batch2.md`） | 已修（`08311cd`/`316eff4`） |
| 3 | `tests/economy-stability.test.ts` 120 月用例 30s 超时 | `74629d1` 放宽到 60s 并注明定性依据：2 核多 worktree 并行争用 36–40s，基线单跑 12–16s；单跑 3 用例 13.60s 通过 | 已修 |
| 4 | 贷款分期欠付未计入 `payablesInArrears`：`payGovernmentPayables` 只统计债券两类（`debt.ts:504` 生成 `loanInstalment`；`debt.ts:864-872` 在 `serviceGovernmentLoans` 内回填状态，但其 `inArrears` 未并入 `GovernmentSettlementResult`），月报少计政府贷款欠付 | sim 批次3 已修：贷款欠付并入 `payablesInArrears`（`debt.ts:203-204` 合计）。注：复核确认 payable 状态有回填，不会“永远 pending” | 已修（`08311cd`/`316eff4`） |
| 5 | `scripts/economy-balance-report.ts:68` 使用不存在的 `world.investorGroups`（应为 `world.investors`，见 `types.ts:1852`）；脚本不在 tsconfig 内故 typecheck 未拦住，交付分支上直接运行崩溃 | 数值岗工作区已修，待提交并合入交付分支 | 待修（待合入） |
| 6 | **债券兑付未给持有人入账**：`payBondCoupon`/`settleBondMaturity`/`settleBondBankruptcyRedemption` 只写 `BondPayment`、扣财政、建 `bondAdvance` 贷款，未把兑付额记入持有人现金，货币净额凭空减少；QA AC-B12/B14 实测：财政充足到期净额 −11,200、垫付分支 −11,200、破产兑付 20 个月 −10,666.67。违反 Brief §4.1.3 与货币守恒 | sim 批次3 已修：三个兑付点用 `banking/credit.ts:85 creditOwnerCash` 各记一次（幂等命中不记、避免与 `debt.ts` 阶段③双记），补三条货币守恒测试（`110ec41`） | 已修（`08311cd`/`316eff4`） |
| 7 | 赤字转贷被 `minAmount` 抬高：`debt.ts:750` 对小于 10,000 的赤字强制借到 10,000，`treasury` 转正、凭空多背债多计息（违反“等额补足到 0”） | sim 已修（`6d4b240`）：`borrowForGovernment(..., { exact: true })` 赤字精确补足到 0，AI 主动借款保留 10,000 下限，并补两条测试 | 已修（`947eed5`，交付分支） |
| 8 | **同月“到期+破产”拆分支付被幂等键吞掉**：兑付分两段出资（财政段/垫付段）支付时幂等键不含出资来源，第二段命中 `bondPaymentExists`；`bonds.ts:672` 的 `makePayment((issuanceId,holdingId,tick,'principal'))` 使流水少记 1,200、`issuance.principalRepaid` 少 1,200（8,800 vs 10,000）、持有人少收 1,200（QA 第五轮 AC-F08） | 已派 sim：优先“多段出资合并为一次支付+一次入账”，或幂等键加入 fundingSource；补“拆分守恒 + 同 tick 重放”两条测试 | 修复中 |
