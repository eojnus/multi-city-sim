# PLAN — v1.6 经济修复（价格 / 竞争 / 维护费 / 退出）

基线：`f483f609599771663de3e8311aaf1bd608edc707`（= origin/feature/stock-market-ui-tax；
用户给的验收基线 `483c6fe` 是它的父提交）。`origin/main` = `6c45000efc4c406d30e22c0a12bd066fc2df61f7`，不动。
分支：`feature/stock-market-ui-tax`。禁止 amend / rebase / force push / 删分支。

## 目标

用户任务书（2026-11-06）六块：
1. 修复 v1.5 验收遗留：①AI 政策月预算为“当月新增危机政策合计额度”而非每项各自额度；
   ②公共岗位统计区分新增岗位/在岗人数/撤销/实付工资（人数 vs 人次）；③债券跨城迁移尾差可累计可追溯。
2. 商品价格：短缺时涨得更快、竞争/积压时回落、长期向基础价值回归（成本上升可偏离）、
   跨城进口必须计入需求侧（不得把进口满足的需求当缺口推价）、可配置速度/上限/上下限。
3. 企业竞争/生产/招聘：真实报价竞争、内部高精度、需求按竞争份额分摊、优先用闲置设备+招聘扩产、
   合理减产裁员卖设备、创业 AI 避免同行业羊群。
4. 生产设备维护费：企业持有设备（含闲置、二手、初始实物出资）每月 = 台数 × 所在城市该类新设备
   当月市场参考单价 × 1%；独立费用进入利润/现金流；收款方为模拟范围外服务商；现金不足按既有借款/
   欠付规则；财务与 AI 决策可见；存档兼容。
5. 企业退出：零员工、长期无产出销售、无恢复能力的企业必须能清算；保留保护期与合理暂时停业；
   清算处理设备/初始锁定返还/库存/债务/股东/员工；释放名额。
6. 继续遵守既有规则（160 企业上限、AI 每月 100、开局人口=原 5 倍、非劳动 20%、防套利、100% GDP 破产、
   非市长看不到市长专属财政、不伪造数据）。

## 分工与写作用域（同时开工，互不重叠）

| 工作流 | owner | 写作用域 |
|---|---|---|
| P1 价格机制 | lead | `src/simulation/markets/markets.ts`、`src/simulation/markets/consumer.ts`、`src/simulation/markets/intercity.ts`、`src/data/config.ts`(market 段)、`tests/price-v16.test.ts` |
| P2 设备维护费 | equip-dev | `src/simulation/equipment/**`、`src/simulation/finance/finance.ts`、`src/simulation/equipment/maintenance.ts`(新)、`src/ui/panels.ts`、`src/data/config.ts`(equipment 段)、`tests/equipment-maintenance-v16.test.ts` |
| P3 竞争/生产/退出 | pool-dev | `src/simulation/companies/**`（production-plan / planning / strategy / lifecycle / founding / company）、`tests/competition-v16.test.ts`、`tests/zombie-exit-v16.test.ts` |
| P4 政策预算与公共岗位 | gov-dev | `src/simulation/policies/**`、`src/simulation/government/**`（如需）、`tests/policy-budget-v16.test.ts` |
| P5 债券迁移尾差 | bank-dev | `src/simulation/investors/investors.ts`、`src/simulation/government/bonds.ts`（如需）、`tests/bond-migration-tail-v16.test.ts` |

Lead 独占（其他人只读，需要改动先 message Lead）：`src/simulation/core/save.ts`、
`src/simulation/contracts/types.ts` 的 `SAVE_FORMAT_VERSION`、`scripts/economy-v09-report.ts`、
`PROGRESS.md`、`docs/`、git 提交/推送。`src/simulation/contracts/types.ts` 与 `src/data/config.ts`
允许多人**追加式 edit**（禁止 write 覆盖），各自只改自己段落；冲突则重读后重试。

## 步骤与验收

- [x] S0 基线确认：`git fetch` 后 HEAD=`f483f60`=远端、main=`6c45000`、工作区干净、tsc=0、
  `tests/founding-compat-v15.test.ts` 10/10。证据已入会话记录。
- [x] S1 价格机制（lead）：`finalizeMarkets` 缺口=`ledger.unmetDemand`（已由跨城进口冲销）；
  新配置 `shortageRiseSpeed=0.3 / surplusFallSpeed=0.12 / competitionFallSpeed=0.08 / reversionSpeed=0.03 /
  maxMonthlyChange=0.15 / costAnchorFactor=1 / costAnchorMaxFactor=1.6`；锚价 = 上月单位生产成本中位数
  （clamp 到 [base, base×1.6]）；高于锚回归、低于锚仅有真实需求/成本压力时回归；无需求不涨。
  证据：`npx tsc --noEmit` exit 0；`npx vitest run tests/price-v16.test.ts --maxWorkers=1` → 14/14 通过
  （含 需求100/本地60/进口40 不涨、短缺快涨封顶 15%、过剩回落、高位回归、成本锚、上下限、不伪造成交）；
  `npx tsx scripts/economy-v09-report.ts --months=3 --checkpoints=1,3` exit 0 且输出新增“价格与供需”行。
  备注：同一时刻 24 月整链不变量校验失败于持债记录（bank-dev 在途改动），与价格无关，待其修复后复验。
- [x] S2 设备维护费（equip-dev）：新增 `src/simulation/equipment/maintenance.ts`（月初快照 D1、
  月初参考价、逐类 1%、欠付/坏账、月度独立流水），`finance.ts` 计入税前利润与经营现金流，
  `equipment.ts` 清算先补收，`panels.ts` 展示台数/单价/维护费/状态，`simulation.ts` tick 开头快照。
  证据：`tests/equipment-maintenance-v16.test.ts` 16/16 绿；tsc 0；旧测试抽样 96 项绿。
- [x] S3 竞争/生产/招聘 + 僵尸退出（pool-dev）：新增 `companies/pricing.ts`（6 位内部精度、
  至少 1 分变动、成本底线、对手报价）、`companies/cost.ts`（维护费/固定成本接入），
  `production-plan.ts` 可触达需求份额+需求驱动增产、`planning.ts` 多余设备出售（锁定期整段不卖）、
  `founding.ts` 防羊群、`lifecycle.ts` 删 `wage<=0` 守卫 + `idleMonths`(6)→清算。
  证据：`tests/competition-v16.test.ts` 8/8、`tests/zombie-exit-v16.test.ts` 7/7 绿；
  `tests/v14-conservation.test.ts` 3/3 回归修复。
- [x] S4 政策总额度 + 公共岗位（gov-dev）：`policies.ts` 当月体检 budget 为 quota、按参考需求
  权重最大余数分配到各政策、claim/reserved/spent/unpaid 按分项封顶；`publicJobsMonths` 区分
  新增岗位/在岗人数/撤销/实付工资与累计人次。证据：`tests/policy-budget-v16.test.ts` 13/13 +
  v15 16/16 + v14 35/35 绿；复现 600 万 vs 1200 万已修（分项合计=quota）。
- [x] S5 债券迁移尾差（bank-dev）：`investors.ts` 份数=本金/面额全精度（面额 1000 时 1 分=1e-5 份），
  4 信用点可迁移（源 1000→996/目标 0→4，合计守恒）；`invariants.ts` 仅注释更新、容差不变。
  证据：`tests/bond-migration-tail-v16.test.ts` 5/5 + `investor-dividend-distribution` 10/10 绿；
  24/72 月整链不变量为空。
- [ ] S6 交叉验收测试（lead）：新增 §七.4 的 7 个构造场景集成测试 + 旧测试回归抽样。
- [ ] S7 全量回归：`tsc --noEmit`（含 electron tsconfig）、`npm run build`、分块全量 130+ 测试文件全绿。
- [ ] S8 数据：默认种子 20261101 72 月 + 3 个对照种子（36 月），报告第 1/6/12/24/36/72 月各城指标。
- [ ] S9 Electron 实机核查（价格、维护费、居民消费、政策权限、股票、存读档），证据入仓。
- [ ] S10 交付：`docs/development/DELIVERY_REPORT_v1.6.md`、README/PROGRESS 更新、commit、推送功能分支。

## 关键设计决策（Lead 定，owner 按此实现）

- D1 维护费持有时点：**当月月初持有**（tick 开头在重置设备市场统计处快照每企业各类台数，
  如 `simulation.ts:152-155` 附近）。当月买入从下月起计费；当月卖出/挂单/返还/破产仍计当月费用
  （防止二手挂单立即扣减 equipment 台数来逃费，`equipment.ts:654`）。价格取同一时点：
  月初新设备市场参考价。
- D2 维护费收款方：模拟范围外“城市外部设备维护服务商”，记独立费用流水，不进设备厂收入、不记政府税收。
- D2b 维护费计入**税前利润**：减在 `finance.ts` 的 `preTaxProfit`（178-180 行）里，让所得税/净利/分红/
  奖金/破产判断都看到；欠付记应付，补付时冲负债不再计费用。
- D3 价格锚：`anchor = clamp(上月单位生产成本中位数 × costAnchorFactor, basePrice, basePrice × costAnchorMaxFactor)`；
  成本锚只在有真实生产数据（previousMonth.sold > 0）时启用。
- D4 债券尾差：保持 0.01 份不变量，持债记录新增 optional `tailPrincipal`（面额计）：
  迁移零头记入迁移者尾差并从源实体扣除（守恒），累计到最小单位再实体化；付息/兑付/存档按尾差结算。
- D5 版本：`GAME_VERSION=1.6.0`；**不升 `SAVE_FORMAT_VERSION`（保持 9）**。所有新持久字段 optional、
  缺省 0/回退（参考 save.ts:1120-1123 v1.4 先例），旧档可读且旧设备开始计费。Lead 负责 save.ts 容错。
- D6 判断“僵尸企业”：连续 `idleExitMonths`（默认 6）个月无产出且无销售（或产出与销售均≈0）、
  现金/授信不足以覆盖 1 个月固定成本（工资+维护费+偿债）、且无纾困观察期 → 清算；
  经营活动出现即计数清零；短于门槛的停业不清算；新企业保护期与暂时停业保护期保留。
  核心修复点：删除 `checkBankruptcies` 的 `if (wage <= 0) continue;` 守卫（lifecycle.ts:1770-1771）。
- D7 价格缺口口径：只用 `ledger.unmetDemand`（已被跨城进口冲销）+ `ledger.demand` 作缺口率；
  不用 `demand - sold`（会把进口满足的需求误当缺口），不用 unmetFunding（买不起不推价）。

## 风险与约束

- 2 核 / ~2GB：同一时刻最多 1 个 vitest 进程；全量测试与 72 月运行由 Lead 串行执行。
- 不伪造数据；测试数字难看也要如实报告。
- 修改 scripts/ 后必须 `npx tsx scripts/economy-v09-report.ts --months=3 --checkpoints=1,3` 冒烟
  （tsc 不覆盖 scripts，PROGRESS:87-88）。
- 全量测试用分块脚本（12 文件/块，参考 /tmp/run-v14-chunks.sh）；容器偶发
  `Timeout calling "onTaskUpdate"` → 进程 exit≠0 但断言全绿，报告如实说明（PROGRESS:84-86）。
- Electron 证据路径要用新目录 `docs/evidence_v1.6/`（不要覆盖 v1.5 证据，需改脚本内路径）。
- 时间预算：72 月约 10-13 分钟；4 seed 36 月约 12-15 分钟；全量分块约 25-40 分钟；Electron 约 3-5 分钟。
- 每步完成后把证据（命令+结果）写回本文件对应步骤。
