# v0.7 实现设计（块0 契约冻结稿）

状态：**契约冻结候选（块0 交付）**。冻结后 `src/simulation/contracts/types.ts`、`core/{save,simulation,initializer,invariants}.ts`、
`data/config.ts` 的**结构、键名、字段名、枚举值与函数签名**只能由架构师追加或修正；游戏程序/界面/数值不得自行改名。
本文中标注「团队暂定」的条目是团队为推进开发先定的口径，不是用户已最终确认的策划规则。

- 基线：`feature/arch-foundation`，起始 commit `9cef5b5`（main 基线）
- 存档格式：**v6 → v7**（`SAVE_FORMAT_VERSION = 7`），游戏版本 `0.7.0`
- 上游依据：`briefs/Game3_Combined_Brief.md`（任务书 §三/§四/§八）、`briefs/SUPPLEMENT_ARCHITECT_v1.md`、
  `briefs/DECISIONS_v1.md`（v1 / v1.1 / v1.2）、秘书处块0 追加指令（含 v1.3 口径更正）

---

## 1. 本轮范围

块0 只交付**契约与结构**，不实现业务数值逻辑：

1. 新类型/字段/枚举（政府债券、持债、兑付流水、政府银行贷款、应付项、银行垫付、债务汇总、破产记录、
   居民消费预算快照、居民消费贷款、GDP 估计与判定窗口、权限投影视图）。
2. 存档 v7：迁移函数、校验器、默认值；旧档负财政余额转政府银行贷款、财政余额归零。
3. 月结顺序固定：`computeCityGdp` 之后调用唯一入口 `settleGovernmentDebt`（内部六阶段）。
4. `config` 新键与单位（数值默认值来自暂定方案，数值岗可整段替换；键名冻结）。
5. 不变量钩子（空态也成立）。
6. 可编译的**空实现函数签名**，供验收先写验收测试（先红后绿）。
7. 开局 12 个月 GDP 估计的入口函数与实现（纯估计，不产生现金/产出）。

不做：`src/ui/**` 的界面改版、业务数值实现、数值平衡、验收测试正文（验收员负责）。

---

## 2. 枚举与字段扩展（冻结）

| 类型 | 变更 | 说明 |
|---|---|---|
| `BankOwnerKind` | `+ 'government'` | 政府银行主体，`id = cityId`；银行不复制政府财政余额（`treasury` 是权威） |
| `HolderType` | `+ 'operator' \| 'trust'` | AI 经营者持股；无股东时的无表决权托管持股（不销毁、不转给公司、不增发） |
| `LoanPurpose` | `+ 'government' \| 'bondAdvance' \| 'householdConsumption'` | 政府借款、垫付转借款、居民消费贷款 |
| `LoanStatus` | `+ 'writtenOff'` | 破产勾销（银行不倒闭，勾销必须留痕） |
| `FiscalEntry.kind` | `+ governmentLoanProceeds / governmentLoanRepayment / governmentLoanInterest / bondIssuanceProceeds / bondInterest / bondPrincipal / bankAdvance / debtWriteOff` | 正收入负支出沿用现有约定 |
| `NotificationKind` | `+ 'fiscal' \| 'bankruptcy'` | 财政/破产事件（公开或市长专属由 `visibility` 决定） |
| `City.gdpHistory[*].estimated?` | 可选布尔 | 估计值标注；真实历史必须省略或 `false` |
| `City.bankruptcy?` | 可选对象 | 与 `government.bankruptcy` 同值镜像，迁移后必有 |
| `WorldState.bonds?` | 可选对象 | v6 及以前没有；迁移后必有（空账本） |
| `LogEntry.visibility?` / `PlayerNotification.visibility?` | 可选对象 | 数据层权限表达。**注意字段名**：`PlayerNotification.audience` 已被“通知目标类型”占用，故本轮统一命名 `visibility`，语义为 `{ scope: 'public' \| 'mayor', cityId }` |

> 枚举扩展会连带影响既有 `Record<LoanPurpose, …>` 等穷举映射：块0 已做**最小编译适配**（`banking.ts` 的用途文案、
> `credit.ts` 的主体分支、`ui/panels.ts` 的贷款用途/状态文案、`save.ts` 的持有人类型窄化）。这些只是标签与类型守卫，
> 不含业务逻辑与 UI 布局改动。

---

## 3. 数据结构清单

权威（authoritative）/派生（derived）必须分清：**同一金额只允许一个权威账本**，其余只是展示或对账汇总。

### 3.1 政府债券（全局账本 `world.bonds: BondState`）

| 结构 | 关键字段 | 角色 |
|---|---|---|
| `BondIssuance` 发行批次 | `cityId`、`issuedTick`、`closedTick`、`faceValue`、`couponRateAnnual`、`interestPeriodMonths`、`termMonths`、`planUnits`、`soldUnits`、`unsoldUnits`、`principal`、`maturityTick`、`status`、`lastCouponTick`、`accruedInterest`、`arrearsInterest`、`interestPaid`、`couponsPaid`、`principalRepaid`、`bankAdvancedAmount`、`redeemedTick`、`redemptionReason` | 计划/成交分开；`principal = soldUnits × faceValue`；`unsoldUnits = planUnits − soldUnits`；`accruedInterest`/`arrearsInterest` 为**对账汇总**（权威在持债明细）。批次统计口径（v1.4 #37）：`couponsPaid` 已付票息期数（0–3）、`principalRepaid` 已还本金累计、`bankAdvancedAmount` 累计银行垫付（本金+欠息） |
| `BondHolding` 持债记录 | `issuanceId`、`holder`、`units`、`principal`、`purchasedTick`、`interestStartTick`、`maturityTick`、`lastCouponTick`、`accruedInterest`、`interestPaid`、`redeemedTick`、`status` | 按“持有人 × 批次 × 购买时点”一条；计息从 `max(purchasedTick, issuedTick)` 起 |
| `BondPayment` 兑付流水 | `issuanceId`、`holdingId?`、`holder`、`kind: coupon \| principal \| bankruptcyRedemption`、`principalPaid`、`interestPaid`、`fundedByBankAdvance`、`advanceLoanId` | 逐笔可追溯；幂等键 `(issuanceId, holdingId, tick, kind)`，同笔债权同月同 kind 只兑付一次 |
| `BondHolder` | `kind: player \| investorGroup \| company` | 首版**银行不得认购国债**；可跨城购买 |

### 3.2 政府债务与破产（`city.government: CityGovernmentState`）

| 结构 | 关键字段 | 角色 |
|---|---|---|
| `GovernmentLoanContract` | `purpose: government \| bondAdvance`、`principal`、`outstanding`、`monthlyPrincipal`、`rateMonthly`、`termMonths`、`nextDueTick`、`accruedInterest`、`arrearsInterest`、`missedPayments`、`status: active \| repaid \| writtenOff`、`bondIssuanceId` | **政府银行贷款唯一权威账本**；垫付转贷款也在这里（`purpose='bondAdvance'`） |
| `GovernmentPayable` | `tick`、`kind: bondCoupon \| bondPrincipal \| loanInstalment`、`issuanceId`/`loanId`/`holder`、`principalDue`、`interestDue`、`status: pending \| paid \| paidByAdvance \| arrears \| writtenOff`、`paidTick`、`paymentId` | 当月应付项；幂等锚 `(cityId, tick, kind, issuanceId/loanId/holder)`；保留 N 个结算月 |
| `GovernmentAdvanceRecord` | `purpose: maturity \| bankruptcy`、`issuanceId`、`payableIds`、`principalAdvanced`、`interestAdvanced`、`totalAdvanced`、`loanId` | **只是可追溯流水**，不得再作为独立负债项目与 `bondAdvance` 贷款重复相加 |
| `GovernmentDebtSummary` | 见 §4 | 每月结算末快照；趋势基准；不是账本 |
| `GovernmentBankruptcyRecord` | `totalDebtAtJudgement`、`gdpJudgementValue`、`bondsRedeemedPrincipal`、`bondsRedeemedInterest`、`bondRedemptionCount`、`bankAdvanceCreated`、`bankLoansWrittenOff`、`advancesWrittenOff`、`interestWrittenOff`、`electionTriggeredTick`、`caretakerUntilElection` | 幂等：同一城市同一 tick 一条 |
| `CityBankruptcyState` | `status`、`tick`、`recordId`、`debtRatio` | `government.bankruptcy` 权威，`city.bankruptcy` 镜像 |

### 3.3 居民消费预算与消费贷款（`world.householdFinance`）

| 结构 | 关键字段 | 角色 |
|---|---|---|
| `ConsumerBudgetSnapshot` | `lastMonthDisposableIncome`、`incomeComponent`、`cash`、`cashComponent`、`referenceSpend`、`cashBudget`、`loanAvailable`、`effectiveBudget`、`loanGranted`、`actualSpend`、`unmetByFunding`、`depositsIncluded` | 可审计的月度预算快照，保留 `households.budgetSnapshotMonths` 个月 |
| `HouseholdLoanContract` | `groupId`、`purpose:'consumption'`、`principal`、`outstanding`、`monthlyPrincipal`、`rateMonthly`、`termMonths`、`accruedInterest`、`arrearsPrincipal/Interest`、`missedPayments`、`status` | 居民群体消费贷款权威账本；按群体聚合，不逐人建实体 |
| `HouseholdFinanceState` | `loans`、`nextLoanNumber`、`budgets` | — |

### 3.4 GDP 估计与 12 个月判定窗口

| 结构 | 关键字段 | 角色 |
|---|---|---|
| `CityGdpPoint` | `tick`、`value`、`estimated` | `city.gdpWindow`：最多 12 条、按 tick 升序；估计月 tick 为 **−12…−1**、`estimated=true`（存档校验接受负 tick），真实月 tick > 0 |
| `GdpEstimateInfo` | `monthlyValue`、`annualValue`、`utilizationAssumption`、`minAnnualGdp`、`method`、`createdAtTick`、`note` | `city.gdpEstimate`：估计口径留档；**估计值不是真实交易**。开局口径（v1.4 #32）：`q̂ = min(capacity, laborCapacity) × utilizationAssumption(0.8)`（80% 只乘一次），再乘 `(产出市场价 − Σ配方投入×市场价)` 求和 |

`city.gdpHistory` 仍只放展示用真实历史；`city.gdpWindow` 只用于债务率与破产判定。两者不得混用。

### 3.5 权限投影视图（store/UI 唯一允许读取的形状）

`ViewerIdentity{ playerId, mayorCityId }`、`FiscalVisibility{ scope, cityId }`、
`MayorFiscalView`（含 `issuances: MayorBondIssuanceView[]`，计划/实售/未售/本金分开）、
`PublicBondOfferView`（白名单，不含计划总额/总售额/总债务）、`OwnBondHoldingView`。
投影函数在 `src/simulation/government/fiscal-view.ts`（块0 空实现，块4 填）。
财政与 GDP 的**公共计算口径**（v1.4 #36，已实现，见 §12）只能经 `metrics.ts` 的
`cityDebt` / `recent12MonthGdp` / `assessCityFiscalRisk` 取得；报告脚本、UI、模拟都不得另写一套。

---

## 4. 总负债口径与利息计提时点（冻结）

**总负债 = 政府全部银行贷款未偿本金（含因垫付形成的 `bondAdvance` 贷款）+ 未偿债券本金 + 已计提未付利息。**

`GovernmentDebtSummary` 五段分子，**判定时直接相加，每项只计一次**：

```
totalDebt = bankLoanPrincipal          // 普通政府贷款未偿本金（不含垫付）
          + bankAdvancePrincipal       // bondAdvance 贷款未偿本金（垫付只在这里计一次）
          + bondPrincipalOutstanding   // 未偿债券本金（soldUnits × faceValue 的未偿部分）
          + loanAccruedInterest        // 政府贷款已计提未付利息 + 欠付利息
          + bondAccruedInterest        // 债券已计提未付利息 + 欠付票息
```

- `GovernmentAdvanceRecord.totalAdvanced` 是**流水**，不得再单独加入 `totalDebt`（v1.3 口径更正）。
- 分母：`gdpJudgementValue = max(config.government.fiscalRisk.minAnnualGdp, Σ city.gdpWindow.value)`；
  `debtRatio = totalDebt / gdpJudgementValue`。
- 风险分级：`< normalBelow(0.5)` 正常；`[0.5, 0.75)` 关注；`[0.75, 1.0)` 高风险；`≥ 1.0` 破产。
- 趋势：与**上一个已结算月**同口径 `lastDebt.debtRatio` 比较；差绝对值 `< trendEpsilon` 为持平，无上月数据为 `unknown`。
- **计提时点**：月结阶段②（生成应付项同时）先把本月利（票）息计提进 `accruedInterest`/`arrearsInterest`，
  再做阶段⑤判定，保证利息不漏计、破产判定不晚一拍。日/月边界一律用游戏月，不按自然月。

---

## 5. 月结顺序（冻结）

现有 `Simulation.tick()` 顺序保持不变，只在 `computeCityGdp` 之后插入两个 v0.7 步骤：

```
… → settlePolicies → generateProposals → 融资/股票撮合 → publishNotices
  → computeCityGdp                                   // 16   记录本月真实 GDP
  → pushRealGdpPoint(每个城市)                        // 16a  真实 GDP 入 12 月判定窗口（替换最早估计月）
  → settleGovernmentDebt(world, config, logs)        // 16b  政府债务月结唯一入口
  → 历史点/不变量校验/日志
```

`settleGovernmentDebt` **内部固定六阶段**（业务实现不得调换顺序）：

| 阶段 | 内容 | 关键约束 |
|---|---|---|
| ① | 记录本月真实 GDP 与财政收支结果（`settleGovernment` 已在前序完成，阶段①只读取/归档） | 估计值不得冒充真实历史 |
| ② | 计提本月利息 + 生成应付项 | 幂等锚 `(cityId,tick,kind,issuance/loan/holder)`；重复执行不得重复计提。债券票息**固定 3 期：M12/M24/M36**（v1.4 #33）；**M36 同时生成「第 3 期票息」与「到期本金」两笔应付**，不得只按 2 期建模 |
| ③ | 票息与到期兑付：先用财政余额 | M12/M24 票息财政不足**不垫付**，记 `arrears` 欠付利息；**M36 到期本金+全部欠息**不足由银行无条件垫付 |
| ④ | 银行无条件垫付 | 不受授信限制；必须写 `GovernmentAdvanceRecord` + `bondAdvance` 贷款；逐笔可追溯 |
| ⑤ | 债务汇总与破产判定 | 用阶段②已计提的利息；`debtRatio ≥ bankruptAt` 即破产 |
| ⑥ | 破产清算与重选 | 见 §7；同一 tick 幂等（`settledTicks`） |

`settleGovernmentDebt` 对同一 tick 是幂等的：已在 `city.government.settledTicks` 中的 tick 不得重复兑付/清算。

---

## 6. 存档 v7

### 6.1 迁移函数与顺序（写死，冻结后不改名）

`src/simulation/core/save.ts` 的 `parseSave` 分派顺序（按入口 `formatVersion`）：

| 入口版本 | 迁移函数 | 结果 |
|---|---|---|
| `=== 1` | `migrateWorldV1` | v1 → 当前内存结构（v2 语义） |
| `<= 2` | `migrateWorldV2ToV3` | v2 → v3 |
| `<= 3` | `migrateWorldV3ToV4` | v3 → v4 |
| `<= 4` | `migrateWorldV4ToV5` | v4 → v5 |
| `<= 5` | `migrateWorldV5ToV6` | v5 → v6 |
| `<= 6` | **`migrateWorldV6ToV7`** | v6 → v7（本块新增） |

迁移后统一执行 `validateWorldStructure` → `syncCompanyTotalSharesSafe` → `checkInvariants`；
`migratedFrom` 记录**入口版本**（例如 v5 档迁移后为 5）。

### 6.2 v6 → v7 迁移规则（冻结）

1. **负财政余额**（`city.treasury < 0`）：等额转为该城 `GovernmentLoanContract`：
   `purpose='government'`、`principal = outstanding = −treasury`、利率/期限取 `config.government.loan`、
   `startTick = world.time.tick`、`nextDueTick = tick + 1`、`status='active'`；随后 `treasury = 0`。
   **不额外发放现金**，其他资产/负债不变；旧债务利息从迁移后开始按合同计提（不追溯）。
2. **新增状态默认值**：`world.bonds = createEmptyBondState()`、`world.householdFinance = createEmptyHouseholdFinanceState()`、
   `city.government = createEmptyGovernmentState()`、`city.bankruptcy` 镜像（默认 `solvent`）。
3. **GDP 判定窗口（只补缺口、不覆盖真实历史，v1.4 #32）**：优先真实 `gdpHistory`（按 tick 升序取最近 12 条，`estimated=false`），
   不足 12 条用开局估计补齐（`estimated=true`，tick = `-missing … -1`）；已有 `gdpWindow` 的 v7 档不重建、不覆盖真实点。
   `city.gdpEstimate` 记录口径与参数。存档校验接受负 tick（估计月）。旧档**不使用**“首月实际 GDP × 12”。
4. **日志/通知可见性**：缺 `visibility` 的条目按内容归类——含财政关键词（财政/赤字/负债/债券/国债/垫付/破产/预算/兑付/发债/债务）
   且能定位 `cityId` → `{scope:'mayor',cityId}`；否则 `{scope:'public',cityId:null}`。
   无法定位城市的条目保守归 public。
5. **未知贷款状态兜底**：`banking.loans[*].status` 与政府贷款状态不在合法集合时置 `'active'`，不猜测结清。
6. **迁移说明日志**：追加一条 `kind='system'`、`visibility=public` 的迁移日志（只描述规则，不含任何财政金额）。
7. **幂等**：`migrateWorldV6ToV7` 在“已含 v7 字段的世界”上重复执行：
   不重复转贷（`treasury=0` 不再触发）、不重复追加状态、不覆盖已有窗口/估计/可见性；不得抛异常。
   `tests/legacy-save-files.test.ts` 的 downgrade 法（从当前世界删字段生成旧档）覆盖此要求。

### 6.3 读取校验（新增）

`validateWorldStructure` 新增：`validateGdpWindow`、`validateGdpInfo`、`validateCityGovernments`、
`validateBonds`、`validateHouseholdFinance`，以及 log/notification 的 `visibility` 组合校验
（`public` 必须 `cityId=null`；`mayor` 必须非空 `cityId`）。

---

## 7. 债券生命周期与破产语义（冻结）

### 7.1 债券

| 阶段 | 规则 |
|---|---|
| 发行计划 | 正整数份、≤ `maxPlanUnitsPerIssue`；同城两次发行间隔 ≥ `minMonthsBetweenIssues`；写 `planUnits`，`soldUnits=0` |
| 认购 | 发行当月一次撮合，不跨月续售；按 `subscriptionOrder`（玩家 → 居民投资实体 → 企业）确定性顺序；只用真实可支配资金；禁止贷款购债、禁止认购时自动贷款；部分成交按实售份数形成本金；未售出关闭后记 `unsoldUnits`，不形成债务；银行不得认购 |
| 票息（3 期：M12/M24/M36） | 每满 `interestPeriodMonths=12` 计提并按持债支付，共 3 期（v1.4 #33）；M12/M24 财政不足时**不垫付**，转欠付利息（`status='arrears'`，累计到 `issuance.arrearsInterest` 与持债记录），`couponsPaid` 只在不欠付时递增 |
| 到期（M36） | **第 3 期票息 + 本金 + 全部欠付利息**；财政不足部分由银行**无条件垫付**（`bondAdvance` 贷款 + `GovernmentAdvanceRecord`）。同月两笔应付都必须生成，不得漏第 3 期票息 |
| 破产 | 银行立即兑付**未到期债券本金 + 按实际持有月份计提的未付利息**（不支付未来利息）；每笔只兑付一次 |
| 同月到期 + 破产 | 到期部分先在阶段③/④各付一次；阶段⑥只处理**尚未结清**的债权，不重复记债/勾销 |

### 7.2 破产与重选（团队暂定）

- 触发：阶段⑤ `debtRatio ≥ config.government.fiscalRisk.bankruptAt`（首版 1.0）。
- 兑付：`settleBondBankruptcyRedemption` 一次性支付“本金 + 截至当月已计提未付利息”，写 `BondPayment.kind='bankruptcyRedemption'`。
- 勾销：随后政府原有银行贷款与本次垫付形成的贷款**一并勾选为 `writtenOff`**；不存在按比例清偿、无优先级分配表。
- 财政余额不参与破产兑付。
- 重选：判定当月结算内立即触发（`config.government.bankruptcy.triggerElectionSameTick`）；
  过渡期现任市长看守、**仅维持性操作**，直到重选完成。
- 政府持股：无 CEO 时在除破产政府外的现有股东之间按**股东主体数量**平均分配；无其他股东时转 `trust` 无表决权托管持股，
  不得销毁、不得转给公司、不得增发。

---

## 8. 权限边界（数据层表达，冻结）

- 存储期过滤只是缓存；**渲染期必须按当前 `viewer.mayorCityId` 重新过滤**（换任/离职/破产重选/读档立即生效）。
- 非市长可见：城市公开信息、当月 GDP 与普通历史、已发行债券的必要投资信息（面额/票面利率/期限/到期日/可认购份数）、
  自持债券与收款记录、公开选举与破产事件、税率。
- 仅市长可见：财政余额、收支流水、政府贷款与债券本金/总债务、12 月判定合计与债务率/风险等级/预警/趋势、
  兑付计划与预算、发债与借款操作；A 城市长只见 A 城。
- 公开债券信息**不得**附带发行计划总额、总售额、政府总债务。
- 对外投影只允许 `MayorFiscalView` / `PublicBondOfferView` / `OwnBondHoldingView`；
  日志/通知用 `visibleLogEntries` / `visibleNotifications`，不得直接读 `world.log` 渲染。

---

## 9. 居民消费预算与消费贷款（团队暂定）

- 参考消费额 = 上月实际可支配收入 × `lastIncomeShare(0.8)` + 手头现金 × `cashShare(0.05)`。
- 现金预算 = `min(手头现金, max(0, 参考消费额))`；有积蓄即可消费，上月收入不是硬上限。
- 银行存款首版不自动取出（`depositsIncluded=false`），不把存款复制到手头。
- 有效预算 = 现金预算 + 消费贷款可用额度（资金支持后的有效需求，不等于成交）。
- 消费贷款：额度 = `max(0, 群体财产基准) × creditLimitRate(0.5)`；月利率 0.6%、期限 24 月；
  逾期宽限沿用 `banking.graceMonths`（v1.4 #35，不新开 grace 键）；是真实债务，资金由银行支付给商品卖方，不进入居民收入口径；不得无限信用。
- 新授信冻结条件（v1.4 #35，冻结）：存在未结清违约合同（`denyWhenDefaulted`），或连续欠付 ≥ `denyWhenArrearsMonthsAtLeast(2)` 个月时，不得新增消费贷。
- 因资金不足未满足计入 `unmetByFunding`（与“供给不足未满足”分开）。

---

## 10. config 新键（键名冻结；默认值为团队暂定，数值岗可整段替换）

### 10.1 `households`

| 键 | 单位/含义 | 首版默认 |
|---|---|---|
| `consumerBudget.lastIncomeShare` | 比例 | 0.8 |
| `consumerBudget.cashShare` | 比例 | 0.05 |
| `consumerBudget.depositsIncluded` | 布尔 | false |
| `householdCredit.rateMonthly` | 月利率 | 0.006 |
| `householdCredit.termMonths` | 月 | 24 |
| `householdCredit.creditLimitRate` | 比例 | 0.5 |
| `householdCredit.minLoanAmount` | 信用点 | 100 |
| `householdCredit.denyWhenDefaulted` | 布尔（新授信冻结条件，#35） | true |
| `householdCredit.denyWhenArrearsMonthsAtLeast` | 月（连续欠付阈值，#35） | 2 |
| `householdCredit.maxLoansPerGroupPerMonth` | 笔/月 | 1 |
| `householdCredit.allowUnsecuredNoAsset` | 布尔（额度口径占位；实际授信条件以 #35 为准） | false |
| `budgetSnapshotMonths` | 月 | 24 |

### 10.2 `government`

| 键 | 单位/含义 | 首版默认 |
|---|---|---|
| `bondMarket.faceValue` | 信用点/份 | 1000 |
| `bondMarket.couponRateAnnual` | 年化利率 | 0.04 |
| `bondMarket.interestPeriodMonths` | 月（付息周期） | 12 |
| `bondMarket.termMonths` | 月（期限） | 36 |
| `bondMarket.maxPlanUnitsPerIssue` | 份/城/次 | 100000（数值岗首版值） |
| `bondMarket.minMonthsBetweenIssues` | 月 | 1 |
| `bondMarket.maxSoldRatio` | 比例 | 1 |
| `bondMarket.subscriptionOrder` | 主体顺序 | `['player','investorGroup','company']` |
| `bondMarket.riskPricedCoupon` | 布尔 | false |
| `bondMarket.allowBankSubscription` | 布尔（首版禁止） | false |
| `bondMarket.singleMonthSubscription` | 布尔 | true |
| `bondMarket.couponGuaranteedByBank` | 布尔（票息不垫付） | false |
| `companyPurchaseReserve.wageMonths` | 月（企业购债保留工资，#23/#37） | 1 |
| `companyPurchaseReserve.interestMonths` | 月（企业购债保留利息，#23/#37） | 1 |
| `loan.rateMonthly` / `loan.termMonths` | 月利率 / 月 | 0.005 / 24 |
| `loan.minAmount` | 信用点 | 10000 |
| `loan.allowActiveBorrowing` | 布尔 | true |
| `advance.rateMonthly` / `advance.termMonths` | 月利率 / 月 | 0.005 / 24 |
| `advance.createLoanContract` | 布尔 | true |
| `fiscalRisk.normalBelow` / `watchBelow` / `bankruptAt` | 比例分档 | 0.5 / 0.75 / 1.0 |
| `fiscalRisk.minAnnualGdp` | 信用点（最小年 GDP 判定值） | 1 |
| `fiscalRisk.trendEpsilon` | 比例容差 | 0.005 |
| `gdpEstimate.utilizationAssumption` | 比例（理论产量利用率） | 0.8 |
| `gdpEstimate.windowMonths` | 月 | 12 |
| `gdpEstimate.method` | 文本（估算口径） | 见文件 |
| `bankruptcy.triggerElectionSameTick` | 布尔 | true |
| `bankruptcy.shareDistribution` | 枚举 | `'byHolderCount'` |
| `bankruptcy.custodyShareKind` | 枚举 | `'nonVoting'` |
| `aiGovernment.enabled` | 布尔（#29 AI 默认开启；块1 实现前无副作用） | true |
| `aiGovernment.triggerBelowExpenseMonths` | 月支出倍数（v1.5 #43 改名；财政余额 < 上月支出×该值触发） | 0.5 |
| `aiGovernment.maxIssuesPerCityMonth` | 期/城/月（v1.5 #43 改名） | 1 |
| `aiGovernment.topUpToExpenseMonths` | 月支出倍数（v1.5 #43 新增；补足目标） | 1.0 |
| `aiGovernment.maxDebtRatioToIssue` | 比例（债务/GDP 上限，与破产线一致） | 1.0 |
| `payableRetentionMonths` | 月 | 24 |
| `maxBankruptcyRecords` | 条 | 8 |

### 10.3 其他

`banking.products` 新增 `government` / `bondAdvance` / `householdConsumption` 三项（仅为类型闭合与银行台账展示，
权威账本在 `city.government` / `world.householdFinance`）；`meta.assumptions` 追加 7 条暂定说明。

---

## 11. 不变量清单（新增 `checkGovernmentDebtInvariants`）

实现位置：`src/simulation/core/invariants.ts`，由 `checkInvariants` 统一调用；空态也必须通过。

**债券**：`principal = soldUnits × faceValue`；`unsoldUnits = planUnits − soldUnits`；`0 ≤ soldUnits ≤ planUnits`；
`Σ 持债 units = soldUnits`；`Σ 持债 principal = 批次 principal`；`Σ 持债 accruedInterest ≈ issuance.accruedInterest`（容差 0.05）；
兑付流水 id 唯一、金额非负、引用的批次存在。

**政府债务**：贷款 `outstanding = principal − paidPrincipal`；垫付贷款未偿合计 = 汇总 `bankAdvancePrincipal`；
普通贷款未偿合计 = 汇总 `bankLoanPrincipal`；`totalDebt` = 五段分子之和；`debtRatio = totalDebt / gdpJudgementValue`；
`gdpJudgementValue = max(1, gdpWindowSum)`；应付项金额非负、`pending` 不得有结清 tick；垫付记 `totalAdvanced = principal + interest`；
`riskLevel='bankrupt'` 时 `government.bankruptcy.status='bankrupt'`。

**GDP 窗口**：≤ 12 条、按 tick 升序、值非负；估计月 `estimated=true` 且 tick < 0；真实月 `estimated=false` 且 tick > 0。

**居民消费金融**：贷款引用存在的城市/群体；`outstanding ≥ 0` 且不超过合同本金。

**批次统计**：`couponsPaid ∈ {0,1,2,3}`；`principalRepaid ≤ principal`；`bankAdvancedAmount ≥ 0`。

**公共口径一致性**：invariants 中 `lastDebt` 五段与 `metrics.cityDebt` 同源，若二者不一致视为契约违约（防止各写一套）。

---

## 12. 块0 交付的可编译空实现函数（签名冻结，块归属见 §13）

| 文件 | 函数 | 块 |
|---|---|---|
| `src/simulation/government/bonds.ts` | `issueGovernmentBond`、`subscribeGovernmentBond`、`closeGovernmentBondSubscription`、`payBondCoupon`、`settleBondMaturity`、`settleBondBankruptcyRedemption`、`bondHolderAvailableCash`、`bondSubscriptionOrder`、`bondsOf` | 块1（模拟） |
| `src/simulation/government/debt.ts` | `settleGovernmentDebt`（唯一入口）、`settleCityGovernmentDebt`、`accrueGovernmentDebtInterest`、`buildGovernmentPayables`、`payGovernmentPayables`、`applyBankAdvance`、`borrowForGovernment`、`serviceGovernmentLoans`、`computeGovernmentDebtSummary`、`evaluateGovernmentBankruptcy`、`liquidateBankruptGovernment`、`distributeBankruptGovernmentShares` | 块1（模拟） |
| `src/simulation/government/gdp-window.ts` | `sumGdpWindow`、`gdpJudgementValue`、`pushRealGdpPoint` | 块1（模拟） |
| `src/simulation/government/metrics.ts` | `cityDebt(world,cityId)`、`recent12MonthGdp(world,cityId,config?)`、`assessCityFiscalRisk(world,cityId,config?)`、`isCityBankrupt(city)`（v1.4 #36 **已实现**，报告/UI/模拟共用唯一口径） | 块0 已完成 |
| `src/simulation/population/household-finance.ts` | `householdCreditLimit`、`householdOutstanding`、`householdConsumerBudgetSnapshot`、`borrowForConsumption`、`repayHouseholdLoans` | 块3（居民） |
| `src/simulation/government/fiscal-view.ts` | `canViewMayorFiscal`、`isVisibleTo`、`buildMayorFiscalView`、`buildPublicBondOffer`、`buildOwnBondHoldingViews`、`visibleLogEntries`、`visibleNotifications` | 块4（界面） |
| `src/simulation/core/initializer.ts` | `createEmptyGovernmentState`、`createEmptyBondState`、`createEmptyHouseholdFinanceState`、`estimateCityMonthlyGdp`、`buildGdpWindow`、`seedOpeningGdpEstimates` | 块0 已完成 |
| `src/simulation/core/save.ts` | `migrateWorldV6ToV7`、`classifyLegacyVisibility`、`collectBondIssuanceIds` | 块0 已完成 |

空实现的约定：保守返回（`{ok:false,error:'尚未实现'}` / 0 / `[]` / `null`），**不得**产生现金、债务、日志或界面可见变化；
验收可先按签名写测试，块1/3/4 填业务后转绿。

---

## 13. 块拆分与依赖顺序（契约冻结后并行）

| 块 | 归属 | 写作用域 | 前置 |
|---|---|---|---|
| 块0 | 架构 | `contracts/types.ts`、`core/{save,simulation,initializer,invariants}.ts`、`data/config.ts`、`docs/architecture/**` | — |
| 块1 | 游戏程序（模拟） | `simulation/government/{bonds,debt,gdp-window}.ts`、`fiscal.ts`/`treasury.ts` 的接入 | 块0 冻结 |
| 块2 | 数值/数据 | 数值表与 `config` **数值**（不改键名/结构）；开局 GDP 估算设计、36 月观察指标 | 块0 冻结 |
| 块3 | 游戏程序（居民） | `population/household-finance.ts`、消费结算接入 | 块0 冻结 |
| 块4 | 界面 | `ui/**`、`fiscal-view.ts` 实现、泄漏审计 | 块1 的类型稳定 + 块0 冻结 |
| 块5 | 验收 | `tests/acceptance/**`、`docs/development` 证据章节、`scripts/**` | 块1/3/4 落地 |

集成顺序（秘书处 `INTEGRATION_PLAN_v1.md`）：**arch → sim → data → ui → qa**；每步 `git merge --no-ff` 后
typecheck + vitest 全量 + build 三绿才进下一步。

---

## 14. 测试矩阵建议（给验收，先红后绿）

1. **存档迁移**：v6 负财政余额 → 1 笔政府贷款且 `treasury=0`；重复迁移不产生第二笔；v1→v7 全链迁移成功。
2. **GDP 估计**：开局 12 条 `estimated=true`、tick 为负、同值；真实 GDP 逐月替换最早估计月；`gdpHistory` 不混入估计值。
3. **债券**：部分成交只按实售形成本金；未售出不形成债务；超额发行/重复扣款被拒；银行认购被拒；企业不得贷款购债。
4. **票息/到期/垫付**：M12/M24 财政不足不垫付、记欠息；M36 同月生成「第 3 期票息 + 本金」两笔应付，不足全额垫付并生成 `bondAdvance` 贷款 + 垫付记录；`couponsPaid` 共 3 期。
5. **总负债口径**：五段之和；垫付不重复计入；应计利息计入分子；`debtRatio` 与分母一致。
6. **破产**：`ratio ≥ 1` 当月触发；兑付“本金 + 实际持有月份未付利息”；同月到期 + 破产每笔只付一次；
   银行债务与垫付一并勾销；当月触发重选、看守期仅维持性操作。
7. **权限**：非市长读不到余额/流水/总负债/判定/趋势；换任与读档后立即失效；公开债券信息不含计划总额/总售额/总债务。
8. **居民预算**：80%/5% 公式、现金约束、存款不计入、额度 50%、贷款是债务非收入、月度快照可审计。
9. **不变量**：空态通过；债券守恒、总负债对账、GDP 窗口排序在业务实现后仍通过。

---

## 15. 待定签名 / 未决事项

- `aiGovernment` 仅为结构占位：数值岗给 `{0.5, 1.0, 1}`（v1.4），键名与数值已落 config，但三者语义映射（阈值/份数/债务率上限）待游戏程序确认后填触发逻辑。
- `householdCredit.allowUnsecuredNoAsset` 是“无资产者能否获得消费贷”的额度口径占位；实际新授信条件已按 v1.4 #35 冻结（违约/连续欠付），默认 false 不代表用户禁止穷人贷款。
- `bondMarket.riskPricedCoupon` 预留风险定价开关；首版固定票面利率。
- 债券认购中“企业流动性保留”口径（#23）由模拟块实现，便于测试的口径常量放在 `government.bondMarket` 之外（模拟内部函数）。
- 若后续需要“破产后旧市长通知立即失效”的审计脚本，由界面块新增，不在块0 范围。

---

## 16. 冲突与口径记录

1. 秘书处消息中“破产时未付利息不兑付”的括注与 `DECISIONS_v1.md` #8/#19 不一致；按 §4.2 与 #8 更正版执行：
   **本金 + 按实际持有月份计提的未付利息**（不支付未来利息）。
2. 早前“清算按银行垫付优先受偿、其余按本金比例”的团队暂定已被 #8 覆盖：**不存在按比例清偿**。
3. `PlayerNotification` 的可见性字段不能命名为 `audience`（已占用），统一为 `visibility`，语义在 §2 说明。
4. 枚举扩展导致既有业务文件的穷举映射改为新增标签（`banking.ts`/`credit.ts`/`ui/panels.ts`/`save.ts`），属最小编译适配，
   不改变原逻辑；交付报告单列。
5. v1.3（#11 更正）：总负债只计一次垫付，`GovernmentAdvanceRecord` 不再作为独立负债项；已按 `bankAdvancePrincipal` 口径实现 `metrics.cityDebt`。
6. v1.4（#32/#33/#35/#36/#37）：GDP 估计 `q̂=min(capacity,laborCapacity)×0.8`、估计 tick −12…−1；债券票息 3 期（M36 票息+本金同月两笔）；消费贷授信冻结条件与 grace 复用 `banking.graceMonths`；三个公共口径函数落在 `metrics.ts` 并由 `debt.ts` 复用；统计字段以可选字段定稿（未填充时报告标“近似”）。
7. 数值岗给的 `householdCredit{0.006,24,0.5,false}` 第 4 个值按 `allowUnsecuredNoAsset=false` 落位；新增的 `denyWhenDefaulted/denyWhenArrearsMonthsAtLeast` 为 #35 冻结条件，非数值岗参数。
8. v1.5（#40）：`HouseholdMonthlyStats` 追加 `budget`、`loanDrawn`、`loanFinancedConsumption`、`unmetFunding` 四个**可选**字段（只加不改，既有字段语义不变，存档 v7 校验接受缺省）；块3 填充，报告在未填充时标“近似”。
9. v1.5（#43）：`aiGovernment` 键名去歧义——`autoIssueWhenTreasuryBelow` → `triggerBelowExpenseMonths`（0.5，月支出倍数）、`autoIssuePlanUnits` → `maxIssuesPerCityMonth`（1 期/城/月）、新增 `topUpToExpenseMonths`（1.0，补足目标）；键名冻结，块1 按倍数口径实现。
10. v1.5（#42）：`City` 新增可选字段 `fiscalExpenseBaseline`（开局首月结算后写入；缺省时 AI 发债分母退回上月财政支出；存档 v7 校验接受缺省，存在则必须是有限数值）。
