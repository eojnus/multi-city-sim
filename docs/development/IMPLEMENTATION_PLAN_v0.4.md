# 实现设计 v0.4：居民阶层 · 经营者与选任 · 独立银行

状态：开发中设计记录（随实现更新）。基线提交 `d091196`，分支 `feature/population-management-banking`。
本文记录**数据权威、结算顺序、跨模块契约**，以及**暂定参数**。暂定参数集中在本文件第 5 节与 `src/data/config.ts`，不是已确认的最终规则。

## 1. 数据权威（谁拥有什么）

| 数据 | 唯一权威 | 说明 |
| --- | --- | --- |
| 城市人口 `total/employed/unemployed/nonLabor/laborForce` | `city.population`（`population.ts` 的 `setCityPopulation`） | 不因新增居民群体而改变语义；P = E + U + N 与 E = Σ雇主 仍是硬不变量 |
| 就业人数与岗位 | 公共部门 `publicSector` + 企业 `employees/roles`（`labor.ts` 协调） | 居民群体的“职业人数”由这两处**派生**，不另存人口 |
| 居民群体现金 | `world.households.groups[].cash` | 群体手头现金；不是人口，也不是股票 |
| 居民群体银行存款 | `world.banking.deposits`（owner.kind = 'household'） | 不在群体上复制镜像，避免双份权威 |
| 居民股票权益 | `world.securities`（居民投资实体作为持有人） | 群体按本城人口比例归属实体净资产（暂定口径，见 §5） |
| 企业现金/库存/产能 | `company` 既有字段 | 贷款不改变这些字段的归属 |
| 企业债务 | `world.banking.loans`（borrower.kind = 'company'） | `company.debt` 仅为**派生镜像** = 该企业未偿贷款本金合计 |
| 经营者任职 | `world.governance.controls` + `world.management.operators` | 控制权与经营者档案分离；选任结果写 control，档案写 operator |
| 选任议案与投票 | `world.governance.motions`（kind = `operatorElection`） | 复用登记日投票权快照与既有计票流程；候选人存在 `motion.candidates` |
| 存款余额/贷款本金/应计利息/还款计划/逾期 | `world.banking` | 银行是这些字段的唯一写入方 |
| 玩家经营模式/授权/提案 | `world.management.playerOperations` | UI 只能发命令，不能直接改 |

**禁止**：人口重复计数；在银行或居民模块复制一份持股权威；`company.debt` 与银行合同各记一套总债务；UI 直接改世界状态。

## 2. 月度结算顺序（v0.4）

在 v0.3 固定顺序基础上插入三处：**经营者/选任推进**（最前）、**银行月度结算与授信快照**（人口之后、企业计划之前）、**玩家经营提案生成与执行**（企业计划内）、**居民群体收入/税/福利/储蓄入账**（财政之后）。

```
0  快照 deepClone（失败整体回滚）
1  经营者与选任：任期到期/空缺/严重经营问题 → 开启选任议案；
   计票期结束的选任议案按候选人得票结算 → 写控制权与经营者档案
2  政治：市长任期/选举；非玩家政府按弱项与领导人倾向选政策
3  交通建设推进与维护
4  人口自然变动 + 迁移（迁移原子；群体人口随之重算，现金/存款按人均跟随迁移）
5  银行月度结算：存款计息 → 贷款计息/到期还款/欠款/违约标记（用结算前剩余本金）
6  授信估值快照：基于上一完整月数据生成，当月稳定
7  企业计划：读取**现任经营者风格**（无经营者时回退企业 ai.style）；
   玩家经营企业按模式处理（手动计划 / AI 辅助提案 / 高度托管授权执行）
8  劳动力匹配（招聘/裁员，原子重算 E/U/N）
9  企业成立与倒闭（倒闭清算先偿还银行贷款，再按持股分配）
10 长期合同与政府协议
11 生产资料采购（成交后按需银行流动性借款）
12 生产
13 居民消费（群体预算 = 现金 × 倾向，受实际现金约束；区分想要/有效需求/成交）
14 区域外出口
15 跨城运输结算（卖方所得期末入账）
16 价格与市场统计
17 治理：非选任议案计票 → 重选董事
18 企业财务：工资 → 企业所得税 → 银行还本付息（优先于股息）→ 股息 → 产能
19 城市财政与居民收入：个税/福利/公共工资/股息返还按群体入账
20 政策执行（补贴/培训/纾困/研发/住房/救助）
21 居民可投资资金：群体现金 → 本城居民投资实体（真实转账）
22 融资要约与二级股票撮合
23 玩家通知（选任、待批准提案、贷款到期/违约）
24 GDP/历史/不变量校验
```

关键时点约定：

- **放款**发生在两个 tick 之间的玩家/自动命令中；`nextDueTick = startTick + 1`，首期从下一月开始。
- **还款**在步骤 18，排在工资与企业所得税之后、股息之前：债务偿付优先于分红。
- **本月放款的利息**：不计入本月，首期还款时按“结算前剩余本金”计算一个月利息。
- **存款利息**在步骤 5 按月初余额计息并入账；**贷款利息**在同一步骤计息、在步骤 18 实际支付。
- **授信快照**在步骤 6 生成；当月新增本金立即占用额度（可借额度按当前未偿实时计算）。
- **选任议案**在步骤 1 创建，投票期 `electionOpenTicks = 2` 个月，故玩家有 1–2 个操作窗口登记参选/投票。
- **失败回滚**：整月快照回滚；单个跨模块操作（放款、还款、选任计票、群体资产迁移）先校验后提交。

## 3. 跨模块契约（函数级）

### 3.1 居民群体（`population/household-groups.ts`、`household-economy.ts`）

```ts
createInitialHouseholds(world, config): HouseholdState        // 新世界：注入初始财富
migrateHouseholds(world, config): HouseholdState              // 旧档：cash=0，不造钱
syncHouseholdPeople(world, config): void                      // 从人口+岗位派生人数；人口变动时按人均转移现金
householdGroupsOfCity(world, cityId): HouseholdGroup[]
attributeHouseholdIncome(world, finance, config, logs): void   // 工资/福利/股息返还 → 群体现金
chargeHouseholdTaxAndSpend(...)                               // 个税、消费支出从群体现金扣
householdWealthStats(world, config, tick): HouseholdWealthStats[]  // 阶层快照
rebalanceHouseholdCashForMigration(world, fromCityId, toCityId, people): void
```

### 3.2 经营者与选任（`management/*.ts`、`corporate-governance/governance.ts`）

```ts
createInitialManagement(world, config, tick): ManagementState
ensureOperators(world, config, tick): void
currentOperatorStyle(world, company): CompanyStyle
maybeOpenElections(world, config, tick, logs): void
openOperatorElection(world, company, config, tick, trigger, logs): ActionResult
registerPlayerCandidate(world, motionId, config, tick): ActionResult
castElectionVote(world, motionId, holder, candidateId, tick): ActionResult
tallyElection(world, motion, config, tick): { winnerCandidateId, result }
applyOperatorElectionResult(world, motion, config, tick): void   // 由 governance.closeMotions 调用
planPlayerOperatedCompany(world, company, config, tick, logs): boolean  // 由 companies/planning 调用
decideProposal(world, proposalId, approve, config, tick): ActionResult
```

### 3.3 银行（`banking/*.ts`）

```ts
createInitialBanking(config): BankingState
creditEvaluation(world, owner, config): CreditEvaluation      // base/limit/outstanding/available
refreshCreditSnapshots(world, config, tick): void
openLoan(world, request, config, tick): ActionResult & { loan? }
repayLoan(world, loanId, amount, config, tick): ActionResult
deposit(world, owner, amount, config, tick): ActionResult
withdraw(world, owner, amount, config, tick): ActionResult
settleBankMonth(world, config, tick, logs): void
ensureCompanyLiquidity(world, company, targetCash, config, tick): number
migrateLegacyCompanyDebt(world, config, tick): number        // v5 迁移
```

## 4. 不变量（新增）

1. 每城 `Σ household.people == city.population.total`；群体人数非负；群体现金 ≥ 0。
2. 每城 `Σ household.cash` 的变化可解释：收入 − 消费 − 储蓄 + 分红返还（统计字段与现金变动一致，容差 0.05）。
3. 银行：`Σ deposit.balance` 与银行统计一致；每笔贷款 `outstanding == principal − paidPrincipal + arrearsPrincipal`（容差 0.01）。
4. 每笔贷款 `outstanding == principal − paidPrincipal`（容差 0.01），且 `arrearsPrincipal ≤ outstanding`（逾期本金是未偿本金的子集，不重复计息）；`company.debt == Σ 该公司未结清（active + defaulted）贷款 outstanding`（容差 0.01）。
5. 经营者：`control.operatorId` 指向的经营者 `status='employed'` 且 `companyId` 一致；同一 AI 经营者不得同时出现在两家企业。
6. 选任议案：`candidates` 非空且 `candidateId` 唯一；`eligible` 快照持有人合法；投票人必须在快照内且票重 ≤ 快照股数。
7. 玩家经营：待批准提案在批准前不得执行（由执行函数保证）。

## 5. 暂定参数（本次实现默认值）

| 项目 | 暂定值 | 依据 |
| --- | --- | --- |
| 居民群体 | 每城 7 类职业；阶层阈值 人均总资产 15,000 / 60,000 | 制造可解释初始差距，可配置 |
| 初始财富 | 管理 18 个月收入、生产 6、销售 5、研发 7、公共 5、失业 2、非劳动力 3；55% 存银行 | 仅新世界注入 |
| 经营者 | 任期 24 月、每次 3 名候选人、每城初始池 5 人、池上限 12 人 | 用户已确定任期与候选人数 |
| 严重经营问题 | 连续亏损 ≥ 4 月且现金 < 0.5 月工资、经营 ≥ 6 月、冷却 6 月 | 与既有倒闭判定口径对齐 |
| 重大事项阈值 | 投资 30 万、招聘 5 人、贷款 20 万、调价 5% | 企业规模差异可配置 |
| 银行利率 | 存款 0.10%/月；周转 0.50%/24 月；扩张 0.60%/36 月；个人 0.60%/24 月 | 用户已确定首版数值 |
| 授信 | 基准 × 50% − 未偿；个人基准 = 净资产，企业基准 = 非负账面股权 | 用户已确定 |
| 逾期 | 宽限 1 月，第 2 月违约，不罚息，不收提前还款费 | 用户已确定 |
| 旧债务 | 迁移为 12 期承接贷款，利率 0.50%，本金 = 原 `company.debt` | 不重复计息、不清零 |

## 6. 已知取舍（交付报告会展开）

- 股票权益按群体人口比例归属本城居民投资实体，首版不区分各群体的投资组合。
- 旧存档迁移不创造居民现金/存款（避免凭空造钱），迁移后群体财富主要来自投资实体权益归属。
- 银行资金无限意味着存款利息会净增加货币量；这是用户已确定的定位，记录在案，不做央行冲销。
