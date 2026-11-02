# 块6：债券/政府债务的 36 月观察表设计（v0.7 契约 + 数值岗首版暂定参数）

> 状态：设计稿（2026-11-02）。**依赖块 1 落地后真实跑**：`WorldState.bonds` 账本、AI 政府自动发债（#29）、
> #42 财政支出基准、政府贷款/垫付、破产兑付。块 0 已具备 `cityDebt()/assessCityFiscalRisk()/recent12MonthGdp()`。
> 脚本侧已留扩展点：`scripts/economy-balance-report.ts` 的 `collectBonds()/BondObservation`（当前返回 null），
> 块 1 落地后只实现映射，报告结构与 CSV 列不变。
> 口径依据：任务书 §五.3/§八.3、DECISIONS #4/#8/#11/#12/#19/#20/#21/#23/#29/#31/#42。

## D0. 目的与边界

1. 回答"新机制跑起来后，36 个月里债券与政府债务是否按设计运转、哪里先坏"。
2. 只做**一次固定条件观察**（同 B2：seed 20261101、开局 2026-01、玩家无操作、默认 AI、36 月、不读档）；
   不做多种子/扫描/反复调参（任务书 §五.3）。
3. 只读：不改变世界、不写存档；异常只报告，不擅自修规则。
4. 如实报告政府恶化、异常倒闭、债发不出去、垫付/欠息累积（§八.3）。

## D1. 债券发行逐期表（每期一行）

| 列 | 字段/口径 | 来源 |
| --- | --- | --- |
| 期号 | issueId（确定性排序：tick → cityId → 期序） | 块1 bonds |
| 城市 | cityId/cityName | 同上 |
| 月 | tick（发行月，认购当月一次撮合 #21） | 同上 |
| 面额/票息/期限 | faceValue / couponRateAnnual / termMonths | config `government.bondMarket` |
| 计划份数 | plannedUnits | 块1 |
| 成交份数 | soldUnits（部分成交只按成交份数 #4） | 块1 |
| 未售出 | unsoldUnits = planned − sold | 计算 |
| 覆盖率 | coverageRatio = sold / planned（planned=0 记 null） | 计算 |
| 成交本金 | soldUnits × faceValue | 计算 |
| 认购主体 | player / investorGroup / company 各自份数；跨城标记（认购主体所在城市 ≠ 发行城市 #4） | 块1 holders |
| 认购时点现金约束 | 企业是否满足 `cash −(1×上月实发工资+1×上月应付利息)`（#23）；玩家/投资实体是否用自有现金 | 块1 + 计算 |
| 备注 | 未售出原因（无合格认购人/现金不足/企业禁购） | 块1 日志，没有则留空 |

## D2. 债券逐月汇总（36 行，进 CSV/JSON）

| 列 | 口径 |
| --- | --- |
| 月 | tick |
| 发行期数 / 城市数 | 当月经 city 计数；用于"多城同时触发"判定 |
| 计划份 / 成交份 / 未售份 | 当月合计 |
| 当月覆盖率 | Σ成交 / Σ计划（当月无发行记 null） |
| 成交本金 | Σ soldUnits × faceValue |
| 跨城认购本金 | 主体城市 ≠ 发行城市的成交本金 |
| 票息支付 / 欠付利息新增 | 当月 12/24 月付息支付额、不足转欠付额（#19） |
| 到期还本 / 银行垫付 | 当月 36 月到期还本、银行无条件垫付额（#19/#8） |
| 期末未偿债券本金 | Σ 未到期债券本金（含本月新发，不含本月还本） |

## D3. 债务轨迹与风险分档（每城 × M1/M12/M36 + 逐月）

| 列 | 口径（全部调契约函数，不重算） |
| --- | --- |
| 银行贷款本金 / 垫付本金 / 债券本金 / 应计未付利息 | `cityDebt()` 五段 |
| 总负债 | `cityDebt().totalDebt`（#11，垫付只计一次） |
| 12 月 GDP 窗口 | `recent12MonthGdp()`：sum / months / 真实月数 / 估计月数（#12） |
| 负债率 | `assessCityFiscalRisk().debtRatio`（分母 max(fiscalRisk.minAnnualGdp, 窗口合计)） |
| 风险档 | normal(<50%) / watch(50–75%) / high(75–100%) / bankrupt(≥100%) |
| 趋势 | riskTrend（与上次结算比，±trendEpsilon 内持平；首月 unknown） |
| 破产标记 | `isCityBankrupt()` / `city.bankruptcy`（#25 同 tick 只判一次） |

## D4. 利息负担与兑付（每城逐月）

| 列 | 口径 |
| --- | --- |
| 债券票息支出 | 当月应付票息（12/24 月期） |
| 政府贷款利息 | `interestPaid` + 欠付利息变动 |
| 银行垫付余额/新增 | advance 段变动（#19 36 月到期/破产垫付） |
| 欠付利息余额 | loans + bonds 的 accrued/arrears（#20 纳入破产负债） |
| 利息负担率 | 月利息支出 / 当月财政支出；月利息 / 月 GDP |
| 与 4% 年化的对照 | 期望票息 ≈ 未偿本金 × 0.04 / 12 × 月数；偏差 >5% 记为异常 |

## D5. 多城同时触发与系统性判据

1. **触发矩阵**：36 行 × 3 城，每格 = 未触发 / 触发但未发行（计划被 maxPlanUnitsPerIssue 或闸门挡住）/
   发行 → 成交 / 部分成交 / 未售出。
2. **系统性压力**：连续 2 个月 ≥2 城触发（或 ≥2 城发行）→ 记"系统性压力"异常（C3 口径）。
3. **跨城资金**：三城合计企业/居民可用于认购的现金 vs 当月发行计划，判断"债发不出去"是需求侧还是供给侧。
4. **借新还旧检查**：若某城同月既有到期债券垫付、又有新发行成交 → 违反 #29，立即报异常（非比例清偿/#8）。

## D6. 自动异常判据（债券/债务新增，B5 的 15 条继续适用）

1. 单期未售出 > 50%（覆盖率 < 50%）。
2. 银行认购国债（allowBankSubscription=false 被违反，#21）。
3. 企业认购时违反 #23 保留额（可认购额 < 成交本金）或企业贷款购债（#5）。
4. 12/24 月票息未按时支付但未记欠付（应为"不足→欠付"，不罚息 #19/#27）。
5. 银行垫付发生但未形成 bondAdvance 贷款/未计入 #11 总负债。
6. 欠付利息未计入破产负债（#20）。
7. 破产时未全额兑付未到期债券本金，或按比例清偿（#8）；同月到期+破产重复兑付。
8. 负债率连续 3 月上升且已过 watch(50%)；或任一城风档达 high/bankrupt。
9. 连续 2 月 ≥2 城触发/发行（系统性压力）。
10. 债券成交份数 > 计划份数，或 soldUnits 非整数份、非 1000 面额整数倍（#4）。
11. 同月既有到期垫付又新增发行成交（借新还旧，#29）。
12. 计划份数 > maxPlanUnitsPerIssue（块1 校验漏掉的证据）。
13. #42 分母未用 max(上月财政支出, fiscalExpenseBaseline)（触发频率异常高/低时可反推）。

## D7. 数字自洽校验（"一次观察要能说明问题"的关键）

1. 每期：planned = sold + unsold；sold × faceValue = 成交本金。
2. 每城：Δ期末债券本金 = 当月成交本金 − 当月还本；Δ总负债 = Δ银行借款 + Δ垫付 + Δ债券 + Δ应计利息（#11 五项闭合）。
3. 票息：累计票息 ≈ Σ(每期成交本金 × 4%/12 × 持有月数)（第 36 月含第 3 期票息，#36）。
4. 兑付：破产/到期银行垫付 = 未到期本金 + 已计提未付利息（#19/#20）；银行垫付 = 政府 advance 贷款新增（createLoanContract=true）。
5. 跨城：三城认购本金合计 ≤ 三城合格主体可用现金合计；无凭空资金。
6. 不变量违规 = 0（`world.lastTick.invariants`）。
7. 定性判据：M36 三城总负债/负债率/风档、是否出现破产、是否出现"发不出去"的月份——这四项是交付报告数值章节的结论骨架。

## D8. 脚本扩展点与输出格式

- 代码：`scripts/economy-balance-report.ts`
  - `BondIssueRow` / `BondObservation` / `collectBonds(world)`：块 1 落地后只实现映射（issues + months 两段）。
  - 报告 `[D]` 段已预留："债券合计：发行 N 期，计划/成交/未售，票息（欠付），还本，银行垫付"。
  - JSON：`report.bonds = { issues: [...], months: [...] }`；未落地为 `null`（不得输出 [] 伪装无发行）。
  - CSV：逐月主表追加 D2 列（bondIssues/bondPlanned/bondSold/bondUnsold/bondCoverage/bondBankAdvance/bondCouponPaid/bondArrears/bondPrincipalRepaid）。
- 命令（块 1 落地后重跑，作为"改动后"对照 `economy-baseline-36m-v07.*`）：

```
npx tsx scripts/economy-balance-report.ts --repeat \
  --json=docs/development/reports/economy-after-bonds-36m.json \
  --csv=docs/development/reports/economy-after-bonds-36m.csv
```

## D9. 验收与交付

- 验收：块 6 跑通（exit 0、--repeat 确定性通过、不变量 0）；D7 七项自洽全过；D6 判据逐条给出"触发/未触发"。
- 交付报告数值章节：D3 三城断面表 + D2 逐月表 + D5 系统性判据结论 + 与 B10 改动前基线逐项对照（GDP/财政/违约/债务）。
- 样本局限：单一固定条件；AI 策略固定；不覆盖玩家操作路径；块 1 若在观察期调整参数，需注明参数版本（configSignature）。

## D10. 待确认（块 1 实现时）

1. `WorldState.bonds` 的最终结构（发行计划/成交/持有人/票息/还本/垫付字段名）——本稿的 D1/D2 是**需求清单**，不是结构定义。
2. 债券利息是否计入银行利息收入/支出统计（当前银行口径只含贷款）；若计入需说明，否则 D4 的"银行利差"会低估。
3. 破产兑付在银行侧形成 bondAdvance 贷款的还款安排（#19 无条件垫付）：是否计息、是否走 grace，沿用 advance 段 0.005/24 即可，需确认。
4. #42 `city.fiscalExpenseBaseline` 的写入时点（initializer 首月结算后）与是否存档迁移。
