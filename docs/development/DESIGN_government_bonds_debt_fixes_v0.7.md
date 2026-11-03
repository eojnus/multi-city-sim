# v0.7 验收修复口径：政府债券认购窗口与政府贷款计息（问题 1/2/4/7）

适用范围：`src/simulation/government/bonds.ts`、`src/simulation/government/debt.ts`、
`src/data/config.ts`（`config.government`）。本文冻结四项口径，测试与界面文案以此为准。

## 1. 认购窗口（问题 1/2）

**窗口定义**：发行 tick `T` 开启，下一次月结 tick `T + 1` 关闭；即"发行当月一次撮合"。
`Simulation.tick()` 是唯一时间入口、每次只推进 1 个 tick，因此关闭 tick 恒为 `T + 1`
（`bondSubscriptionCloseTick()` 推导，不单独存档）。

- 窗口内玩家（含非市长）可在债券市场认购任何城市（含 AI 城市）的 `offering` 批次：
  整数份、可部分成交，受真实可用资金与剩余可认购份数限制；资金进发行城市财政
  （`receiveTreasury(..., 'bondIssuanceProceeds')`）。
- 窗口关闭时（`settleBondSubscriptionWindow`，在月结政府债务结算开头执行），
  由**居民投资实体与企业**按 `config.government.bondMarket.subscriptionOrder`
  顺序、用各自真实可用资金自动认购剩余份数，然后关闭窗口。
- **玩家不参与自动认购**：自动认购显式跳过 `holder.kind === 'player'`，
  不会自动扣玩家现金；玩家买不买由玩家自己决定。
- 银行不在 `BondHolder` 类型内，天然不能认购国债（`allowBankSubscription: false` 未改变）。
- 认购 0 份不扣款、不建持债记录；未售出份数在关闭后记入 `unsoldUnits`，**不形成债务**。
- 自动认购按"发行当月"记账（`tick = issuedTick`），与玩家窗口内买入的计息起点一致
  （`interestStartTick = issuedTick`）；现金流实际发生在关闭时的月结。
- 幂等：关闭后 `status !== 'offering'`；同一 tick 重复月结由
  `government.settledTicks` 拦截，不会重复认购/重复入账。
- 暂停/加速只改变真实时间，不改变游戏时间，因此不会延长窗口、也不会跳过窗口。

**AI 政府发债**：`maybeAutoIssueGovernmentBond` 只创建 `offering` 发行计划，
不再在同一次月结内认购并关闭。它在 `settleGovernmentDebt` 中于该城本月结算**之后**执行，
使破产当月不会新发（破产状态已在结算写入），也让玩家在发行月内看到并操作。

**存档**：窗口状态由已持久化的 `BondIssuance.issuedTick / status / closedTick` 推导，
`SAVE_FORMAT_VERSION` 保持 v7，无需新增字段或 v8 迁移；读档后窗口判定与不读档一致
（覆盖测试见 `tests/acceptance/government-bond-window.test.ts`）。

## 2. 政府贷款计息口径（问题 4）

`governmentLoanAccrual(loan, tick)` 为纯函数，按**实际未偿本金**逐月计息：

- 以当前实际未偿 `loan.outstanding` 为锚，加上该月及以后实际已还本金
  （`LoanPayment.principalPaid`）回推每月期初未偿：
  `outstanding_before_k = outstanding + Σ_{j≥k} principalPaid_j`。
- 欠付本金（应还未还）因未实际偿还仍留在余额中，下月按更高余额计息；
  提前还款降低余额；结清后不再计息。
- 贷款尚无任何还款记录时（纯函数预演/尚未结算），按计划等额本金余额计息，
  保持既有纯函数测试口径（12000 本金、月息 0.5%、24 期：第 2 月累计 117.5）。
- **欠息单独挂账，不滚入计息本金**：不罚息、不计复利（与既有"不罚息，只记欠付"契约一致）。
  `unpaidInterest = 累计应计 − 已付利息`，欠息不会被抹掉，也不会重复计息。
- `elapsedMonths` 不封顶于 `termMonths`：超期未结清的贷款继续按实际余额计息。
- 示例（验收复现）：本金 24000、月利率 0.5%、24 期等额本金（月还本 1000），
  首月未还本金 → 第 2 月期初未偿仍为 24000，应计利息 **120**（旧口径 115）。

重复月结：`settleCityGovernmentDebt` 由 `settledTicks` 保证同 tick 只结算一次；
纯函数对同一 `(loan, tick)` 重复调用结果相同。

## 3. AI 发债闸门与破产后恢复（问题 7）

旧口径 `hasDebtServiceDueThisTick` 把"政府贷款每月分期到期"也当作禁借新还旧，
而赤字转贷（`borrowForGovernment`，`nextDueTick = startTick + 1`）每月都有分期，
导致闸门恒真、破产后（乃至未破产的赤字城市）AI 永久停发。

闸门判定时点：`settleGovernmentDebt` 在**逐城结算前**计算本月到期项并传入
`maybeAutoIssueGovernmentBond(..., { debtServiceDue })`；本月有到期债券本息时不新发计划
（保持 #29"同月有到期项不新发"），但新发计划的资金要等下一次月结窗口关闭才到账，
因此不会用于偿付本月到期项（不存在同 tick 借新还旧）。

新增参数（`config.government.aiGovernment`，含默认值）：

| 参数 | 默认 | 口径 |
| --- | --- | --- |
| `blockIssuanceOnBondService` | `true` | 本月有**债券**到期本金/票息时禁止新发（#29 禁借新还旧核心） |
| `blockIssuanceOnLoanInstalment` | `false` | 本月有**政府贷款常规分期**时是否禁止新发；默认不阻断 |
| `requireElectionAfterBankruptcy` | `true` | 破产记录进入看守期时，须在该记录之后完成一次重选才恢复发债 |

恢复条件（全部满足才恢复发债）：破产状态已解除（`government.bankruptcy.status === 'solvent'`，
债务/GDP 回落后由月结解除）；若最近破产记录 `caretakerUntilElection`，则
`world.politics.elections` 中存在该城、`tick > record.tick` 的选举记录；
且原有 `maxDebtRatioToIssue`（默认 100%，与破产线一致）闸门仍生效。

不变量：不取消/勾销任何债务（清算仍由 `liquidateBankruptGovernment` 按原规则执行）、
不修改破产判定阈值、不允许银行买债、不新增资金；只调整"何时允许发起新发行"。

## 4. 影响面与剩余风险

- 认购窗口使 AI 发债资金**晚一个月**到账（发行月窗口 → 下月月结认购入账），
  政府短期缺口仍由赤字转贷兜底；36 个月真实序列会漂移，由 Lead 合并后统一重出基线。
- `tests/acceptance/bankruptcy-real-run.test.ts` 的 F-R8"破产后不再发债"是修复前的已知限制，
  修复后该断言预期翻转，需随新基线更新。
- 贷款计息口径变化会使逾期城市的应计利息上升（欠付本金仍计息），进而影响破产判定时点。
