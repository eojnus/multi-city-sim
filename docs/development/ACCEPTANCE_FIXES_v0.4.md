# 验收修复报告 v0.4.1：政府持股、城市企业税率与跨城超载资金流

日期：2026-11-02 ｜ 工作区：`C:\CODING-worktrees\city-government-transport` ｜ 分支：`feature/city-government-transport`
上一交付提交：`a0e02dc` ｜ 本次修复提交：见交付说明。

> 本报告记录实际执行的验证。跨城差额退回买方是**暂定原型处理**，不是用户已确认的最终商业规则；政府不通过二级市场/融资要约购买股票的限制同样是暂定实现。

## 1. 修复一：政府持股接入证券与公司治理

主要文件：`src/simulation/securities/securities.ts`、`src/simulation/corporate-governance/governance.ts`、`src/ui/panels.ts`。

- `holderExists` / `holderName` / `holderCash` / `creditHolderCash` 增加 `city` 分支：城市政府作为合法股东可被证券系统识别，现金权威为 `city.treasury`。
- `distributeDividend` 增加政府股东分支：股息直接进入对应城市财政，并按城市汇总写一条 `dividendIncome` 财政流水；不再落入“居民投资实体”分支。`DividendResult` 新增 `cities` 与 `cityByCity`，居民投资统计（`investors`、`investorByCity`）只统计居民投资实体。
- `governance.holderIsValid` 与 `holderLabel` 支持 `city`：政府可提案、投票、进入投票权快照和董事席位；仅分红股份仍不能提案/投票（继续由 `holderVotingShares > 0` 与快照控制）。
- 政府自动投票默认**弃权**（暂定），避免 AI 替城市做经营决策；玩家/城市手动投票不受影响。
- UI 持有人显示增加“XX市政府”。
- 暂定限制：城市政府不能作为融资要约出资方，也不能在二级市场下单（避免财政资金进入没有财政流水的证券交易）；已持有的股份仍可分红、投票、进入董事会。

### 复现与验证（`tests/government-equity.test.ts`，6 项）

1. 政府创办企业后分配 1,000 股息：城市财政 +1,000，`result.cities=1,000`，居民实体现金与投资分红统计都不变，财政流水 1 条且金额 1,000。
2. 政府 + 玩家 + 企业 + 居民群体共同持股：分红总额 1,000，各方到账与 `DividendResult` 逐项一致；居民实体只增加留存部分，返还部分计入 `investorDistributionByCity`，两块合计等于其股息。
3. 政府作为有投票权股东：可提出经营者议案、进入登记日快照、投票并取得董事席位；只有仅分红股份的政府股东提案被拒绝（提示需要投票权）。
4. 政府持股、股息、议案与表决在保存读取后保持一致（城市财政、持股、提案人、表决票、董事席位）。
5. 政府持股企业清算：剩余资产进入城市财政、不是居民投资实体，并写 `liquidationProceeds` 财政流水。\n6. 月度财务：政府持股企业的股息进入城市财政，`cityDividendsByCity` 有值而 `investorDividendsByCity` 为 0，企业已付股息与财政入账一致。

## 2. 修复二：城市企业税率实际生效

主要文件：`src/simulation/finance/finance.ts`。

- 企业税款从全局 `config.labor.corporateTaxRate` 改为 **企业所在城市的 `city.corporateTaxRate`**（并夹在 0–1）。
- 税收调整政策继续只修改目标城市的税率；另一城市企业的税款不受影响。
- 企业实际支付、`company.lastMonth.corporateTax`、`finance.corporateTaxByCity` 与随后 `settleGovernment` 写入的 `corporateTax` 财政流水来自同一个 `taxPaid`，不重复计收。
- 亏损不缴税；现金不足时只缴可用金额；旧存档继续保存/读取城市税率。

### 复现与验证（`tests/city-tax.test.ts`，4 项）

1. 相同税前利润 1,000,000：2% 城市缴税 20,000，20% 城市缴税 200,000，企业记录与城市汇总一致。
2. 对一城执行税收调整（+2 个百分点）：该城企业税款从 50,000 变 70,000，另一城保持 100,000。
3. 亏损不缴税；现金只有 50,000 时按 50,000 缴纳，企业记录与 `corporateTax` 财政流水均为 50,000。
4. 城市税率随存档往返保留，读档后按 17% 计算税款。

## 3. 修复三：跨城超载差额退回买方（暂定）

主要文件：`src/simulation/transport/settlement.ts`、`src/simulation/contracts/types.ts`、`src/simulation/core/invariants.ts`、`src/simulation/core/save.ts`。

### 采用的暂定方案

1. 成交时买方仍按成交价全额付款并取得货物；卖方暂不入账。
2. 月末按城市对汇总全部跨城路径需求，统一计算 `penaltyRate`。
3. 卖方实得 = 成交额 × (1 − penaltyRate)。
4. **差额退回买方**：企业买方增加现金并冲减本月采购支出；居民买方增加城市居民可支配收入并冲减消费支出。买方最终净支付 = 卖方实得。
5. `capacityLoss` 仍表示相对原销售金额的收入减少；`buyerRefund = gross − sellerProceeds`，记录在交通结算明细中。恒等式：`grossValue = sellerProceeds + buyerRefund`。
6. 不得额外扣卖方现金，不得把差额变成政府/运输方收入；跨城贸易支持仍只按损失补偿卖方（财政支出，单独记账）。

以复现场景为例：买方原付 10,160，容量惩罚 50%，卖方实得 5,080，买方收到退款 5,080，净支付 5,080；成交数量仍为 100，库存不变。

### 覆盖范围

- 企业长期合同、政府牵头协议、企业跨城采购、居民跨城购买四条现有路径共用同一结算函数，因此都执行退款。
- 部分成交按实际成交额退款；完全买不起时没有成交、没有待结算记录、四个主体资金不变。
- 卖方不存在（异常路径）时，买方付款全额退回，并在日志说明，不凭空补钱给不存在的卖方。
- 旧存档：`TransportTradeRecord.buyerRefund` 为可选字段；旧历史记录没有该字段时按“退款=容量损失”兼容校验，历史资金不改写。新的待结算交易按新规则结算。

### 复现与验证（`tests/transport-refund.test.ts`，9 项）

1. 复现场景：买方原付 10,160 / 卖方 5,080 / 退款 5,080 / 净支付 5,080，数量 100。
2. 未超载：无退款、无容量损失，买方付全额。
3. 容量提升：同样 100 单位需求从超载变为不超载，退款和损失归零。
4. 多卖家多笔：逐笔退款，卖方所得合计等于买方净支付。
5. 政府牵头协议：协议价仍记录总额 10,160，买方净支付 5,080，卖方 5,080，条目状态与交付量正常。
6. 资金不足：完全买不起时不成交、无待结算；部分成交按实际金额退款。
7. 居民跨城购买：退款计入城市居民收入并冲减消费支出，卖方所得不变。
8. 旧存档兼容：删除历史记录 `buyerRefund` 后仍可读取，历史买方现金不变，不变量通过。

## 4. 实际执行的验证

- `npm run typecheck`：通过。
- `npm run build`：通过（仅 Vite 既有 chunk 体积警告）。
- `npx vitest run`：**26 个测试文件、170 项全部通过**（含原有 151 项，新增政府持股 6、城市税率 4、跨城退款 9）。
- 桌面 GUI 冒烟：**未执行**。本机 `node_modules/electron` 缺少可执行文件，`node node_modules/electron/install.js` 未能落地二进制；脚本与隔离 userData 逻辑未改动，需在有 Electron 的图形环境复验 `npm run smoke:mechanisms`。没有把未执行的测试写成通过。

## 5. 分支、提交与仍存在的限制

- 分支：`feature/city-government-transport`；最终提交号见交付说明；未合并 `main`、未推送。
- 限制：
  - 差额退回买方是暂定方案；另一种“买方按原价支付、差额作为无主体损失”或“差额归运输方/政府”等规则仍需用户决定。
  - 政府股东自动投票默认弃权是暂定行为；政府是否应主动推动分红/经营者议案待设计。
  - 政府仍不能通过股票市场或融资要约取得新股份；政府持股只来自创办企业。是否允许购买存量股份、如何做财政审计，待用户决定。
  - 协议条目的 `paidValue` 仍按合同总额记录，退款记录在交通结算明细中；如果未来需要按净额重写合同记录，需要单独的规则与兼容方案。
  - 企业采购支出按退款后的净额记录，但生产记录中的投入价值仍使用生产时点的市场价格；跨城退款发生在生产之后，两者口径的差异已在报告说明，尚未调整为逐笔重算生产记录。
  - 旧存档的历史超载记录不会追溯退款；只有新结算按新规则执行。
