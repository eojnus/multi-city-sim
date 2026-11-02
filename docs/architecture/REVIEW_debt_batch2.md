# REVIEW：sim 批次2 `government/debt.ts` 只读复核

复核对象：交付分支 `1d138a6`（44 文件 / 345 用例）；对照 `docs/architecture/IMPLEMENTATION_v0.7.md` §5/§7。

| file:line | 问题 | 严重度 |
|---|---|---|
| `src/simulation/government/debt.ts:726` | 赤字转贷按 `Math.max(amount, minAmount)` 借款：赤字 100 会借 10,000，treasury 变 +9,900，违反“负财政余额等额转银行贷款、补足到 0”（迁移口径同） | 阻断 |
| `src/simulation/government/debt.ts:155-245` | 六阶段与契约 §5 不完全对齐：①“归档本月 GDP/收支”实际未实现；额外插入赤字转贷（171）、关闭发行窗口（180）、贷款分期（196）；③④在 `payGovernmentPayables` 内合并（垫付发生在兑付函数内部），文档需同步拆解 | 一般 |
| `src/simulation/government/debt.ts:494` | `bondPrincipal` 应付项的 `interestDue` 与同一持有人的 `bondCoupon`（483）重复记同一笔 `accruedInterest`：只造成对账口径重复，未重复支付 | 一般 |
| `src/simulation/government/debt.ts:565,578,592,611` | `paid` 同时按“支付流水条数”与“应付项条数”累加，`result.payablesPaid` 可大于 `payablesCreated`，统计失真 | 一般 |
| `src/simulation/government/debt.ts:217` | 破产解除只判 `tick > bankruptcy.tick` 且债务率 < 100%，未检查重选是否完成/看守期，次月即可能清 `bankrupt` 镜像（发债仍有 caretaker 拦截，但状态对外显示为 solvent） | 一般 |
| `src/simulation/government/debt.ts:280` | 看守期仅拦截 AI 发债，其他“维持性操作”未在命令层或系统层设闸（DECISIONS #7 未完整实现） | 一般 |
| `src/simulation/government/debt.ts:1002-1006` | 当月选举已由 `advancePolitics` 完成时，`requestImmediateElection` 命中 `politics.ts:298` 守卫返回 ok，但记录仍写 `electionTriggeredTick`，语义上“未重选却记已触发” | 建议 |
| `src/simulation/government/debt.ts:933` | 破产清算幂等：`records.find(record.tick === tick)` 早退，同 tick 重复调用安全 | 通过 |
| `src/simulation/politics/politics.ts:298` | 同 tick 双选举：`lastElectionTick === world.time.tick` 守卫，破产当月不会二次开选 | 通过 |
| `src/simulation/government/debt.ts:240` | `settledTicks` 仅在结算末尾单次 push，入口（139-152）先查该列表，未发现 `lastSettledTick` 类字段双写 | 通过 |
| `src/simulation/government/debt.ts:995,1034` | `city.bankruptcy` 只经 `syncCityBankruptcyMirror` 单点写入，破产当 tick 与解除 tick 互斥 | 通过 |
| `src/simulation/government/debt.ts:166-245` | 阶段间状态：清算后重算 `lastDebt`（203），利息在判定前计提（②），未发现后阶段覆盖前阶段已结算结果 | 通过 |
| `src/simulation/government/debt.ts:476-496` | M36 两笔：`bondCoupon` 与 `bondPrincipal` 应付项分开生成，`payBondCoupon` 与 `settleBondMaturity` 各付一次 | 通过 |
