# v1.3 交付报告：投资权益流转、库存成本口径、月内分阶段生产、创业机会响应与财政分项

> 分支：`feature/stock-market-ui-tax`｜验收基线：`09a8d1b`｜main 未改动（仍 `6c45000`）
> 环境：Windows 11 + Node/tsx + Electron 38.8.6；Linux 容器复验（Xvfb `:99`，Electron `--no-sandbox`）
> 存档格式：`SAVE_FORMAT_VERSION = 9`（新字段均可选 + 读取归一化，未升版本）；`GAME_VERSION = 1.3.0`

## 0. 结论摘要（先说要害）

v1.3 按任务书七项完成机制修复，测试与桌面验收全绿，但**默认 72 个月经济仍未达到“稳定运行”目标**；本轮不伪造任何人口、资金、生产、成交或财政收入，以下同时给出改进与未达标事实：

1. **居民投资权益**改为按有效份额流转：职业变化/裁员/招聘/迁移时份额随人转移，零人群体不再留存份额，股息实际返还与份额账本一致；旧档/开局资产通过 `openingShares` 记入权益，不凭空增发现金。
2. **库存成本口径**改为移动加权平均：采购入存货资产、生产耗料转成品成本、销售结转 COGS；利润 = 营收 − COGS − 实发工资 − 利息 − 所得税；经营现金流单列。修正了“采购与消耗重复计成本”和“利润不含欠薪导致僵尸企业不退出”。旧档按市价补齐账面并写兼容日志（金额/库存不变）。
3. **月内分阶段生产/交易**：`productionRounds = 2`，第 2 轮只用本月新产出的原料补剩余计划；需求只在第 1 轮记账，成交受第 1 轮未满足额封顶（本地与跨城同口径），不重复记需求、不超卖。24 月岚港食品成交 +45.4%、缺货 −84.4%。
4. **创业评估/扩产**：评估口径与真实采购一致（同城设备企业 + 政府储备；新设企业不走跨城运输），结构化记录每次尝试与障碍；失败原子回滚；AI 每城每月上限 100（上限非目标）、在营上限 160、玩家创办不受 AI 月上限拦截。
5. **居民消费**：失业且收入为 0 的群体仍可动用现金/本月可提存款购买基本食品（不因收入为 0 永不消费）；缺货数量与资金缺口分账，恒等式 `成交 + 未满足 + 资金缺口/价 ≡ 有效需求`。
6. **政府财政分项报告**：checkpoint 与汇总分别报告税收（含交通加成）、公共工资、福利、政策支出、交通、政府贷款本息、债券本息、银行垫付、勾销；账本触达上限时标注“已截断”。
7. **72 个月（种子 20261101，玩家无操作，默认 AI）**：t72 失业率 96.8%/94.5%/96.1%（v1.2 基线 98.7%/98.8%/97.5%）；政府历史破产 0/0/1 次（v1.2 为 4/7/3）；在营企业 95/86/53 家（v1.2 为 17/10/17）；食品“有效需求满足率” 71.7%/100%/52%，但**按人均基本需要量（26 件/人/月）计算的实际覆盖率仅 6.6%/9.9%/8.5%**——有效需求已被收入/预算压到很低，满足率不能等同于“吃饱”。
8. 两项观察目标仍未达成：第 12 月“基本食品有效需求满足率 90%”在有效需求口径下为 99.8%/98.8%/99.4%，但基本需要覆盖率仅约 13.6%/26.2%/20.6%；第 24 月失业率较开局下降 ≥5pp 未达成（88.3%/82.4%/86.5% vs t1 86.5%/83.9%/80.6%，反而上升）。
9. 真实设备产业自然运转：9 家开局设备厂 72 个月累计生产农机 255 / 工业设备 240 / 能源设备 96 台，企业购置 1.51 亿、设备出售收入 7,621.1 万，买方产能真实增加——满足“至少一家设备厂真实生产卖给真实买方”，无需构造场景。

## 1. 分支、基线与环境

| 项 | 值 |
| --- | --- |
| 分支 | `feature/stock-market-ui-tax` |
| 验收基线 | `09a8d1b`（v1.2 交付） |
| main | `6c45000`（全程未合并/未改动） |
| 运行 | `HOME=/workspace/Coding/.home npm_config_cache=/workspace/Coding/.npm-cache`；vitest `--maxWorkers=1 --testTimeout=180000`（1GB heap 需分块）；桌面 `DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs` |
| 存档 | `SAVE_FORMAT_VERSION 9`；`GAME_VERSION 1.3.0`；package 1.3.0 |

## 2. v1.3 七项逐条对照

| 任务书条款 | 实现位置 | 验证 |
| --- | --- | --- |
| §2 投资权益随人流转、统一归属 | `src/simulation/population/household-investment.ts`（`effectiveInvestorShares`/`investorEquityWeights`/`splitInvestorEquity`/`allocateMoneyExact`）；`syncHouseholdPeople` 裁员/招聘/职业变化按人数比例转移份额（0.01 最大余数）；`transferInvestorAssetsForMigration` 跨城真实划转实体资金与持股（总股数不变、现金守恒）；`attributeInvestorDividends`/`splitCityHouseholdIncome` 按有效份额分配；旧档 `openingShares` 补齐幂等 | `tests/investor-equity-flow.test.ts` 8 项；全量裁员、迁移 25% 人口、股息 1000 全归单一群体、零人群体 0 份等 |
| §3 库存/COGS/利润/税/分红/现金流口径 | `src/simulation/finance/inventory-cost.ts`（移动加权平均 receive/issue/adjust/writeOff）；采购→存货、生产耗料→成品成本、销售→COGS、运输退款冲减（下限 0）、清算按账面注销；`finance.ts` 利润 = 营收 − COGS − 实发工资 − 税 − 利息；`operatingCashFlow` 单列；AI 经济亏损 = 利润 − 欠薪；税/分红/AI 用新利润 | `tests/inventory-cogs.test.ts` 5 项；`legacy-v09-save` 8/8；抽查 t1 岚港 lp-food：营收 2.386 亿、COGS 1.364 亿、工资 1.195 亿、利润 −0.173 亿、现金 4.23 亿（利润为负是期初存货按开局市价入账，现金流为正） |
| §4 月内分阶段生产/交易 | `config.production.productionRounds = 2`；`simulation.ts` 每 tick 固定轮次「采购→生产」；`production.ts` 第 2 轮按剩余计划/设备/劳动上限采购与生产，需求只记一次，成交以 `${city}|${good}` 的第 1 轮未满足额为上限（本地/跨城共用），成交后冲减 unmet 并同步 `supply = max(supply, sold)`；合同/协议仅第 1 轮 | `tests/production-rounds-v13.test.ts` 4 项；24 月岚港食品成交 60.81M→88.40M、缺货 125.18M→19.47M、食品价 121→81.14；谷物 sold +47% |
| §5 创业/扩产响应机会 | `founding.ts` 结构化评估（需求/价格趋势/竞争者/原料/设备/劳动力/利润/融资）与 `foundingAttempts`（障碍 kind/count、记录上限 80，超出标注截断）；评估与采购同口径（本地设备企业 + 政府储备，新设企业 `allowIntercity:false`）；每城每月 100（上限非目标）、在营 160、玩家创办不受 AI 月上限拦截；`expandCompanyCapacity` 保留运营资金、扩产可跨城 | `tests/founding-v13.test.ts` 6 项、`founding-v1/v11/cap-v12` 全绿；72 月尝试 2,088+ 次（记录截断至最近 80 条），成立率低的原因如实记录：`equipment`（本地+政府设备耗尽）为主、`demand`/`capital` 其次 |
| §6 失业消费与预算/缺货/无需求分账 | `consumer.ts`：失业且收入 0 仍可按现金→本月可提存款→消费贷购买基本食品；缺货 `supplyShortfallQty` 与资金缺口 `unmetFunding` 分账；无真实成交不放贷；基本需求不乘失业系数 | `tests/consumer-unemployed-v13.test.ts` 8 项（收入 0 有现金买 basic 143k、5% 提款 4,999.5、授信贷 143k、无供给零副作用）；24 月三城失业群体成交/缺口/提款/贷款数字 |
| §7 政府财政分项 | `scripts/economy-v09-report.ts` `governmentFiscalDetail`（税收/交通加成/公共工资/福利/政策/交通/贷款/债券/垫付/勾销 + 截断标注）；checkpoint 与汇总逐城输出 | 72 月报告 exit 0；如 t72 岚港：税收 3.53 亿（交通加成 1.82 亿）、公共工资 3.36 亿、福利 2.29 亿、政府贷款 391.8 万/还本息 1.88 亿、发债 2.65 亿/本息 7,699.9 万 |
| §7 测试与多 seed | 全量 117 文件/894 项；`tests/v13-multi-seed-conservation.test.ts`（三 seed 36 月守恒 + 对照）；旧档往返见 §4 | 全绿；多 seed 对照见 §5.4 |

## 3. 数值校准表

v1.3 只新增一个开关，未改动既有价格、工资、税率、授信、破产、人口规则：

| 参数 | 原值 | 新值 | 理由 | 验证 |
| --- | --- | --- | --- | --- |
| `config.production.productionRounds` | 1（隐式） | 2 | 任务书 §4：月内分阶段生产/交易，让本月新产原料参与本月后续生产 | 24 月食品成交 +45.4%、缺货 −84.4%；`production-rounds-v13` 4 项 |
| `GAME_VERSION` / package | 1.2.0 | 1.3.0 | 版本标识；`SAVE_FORMAT_VERSION` 保持 9（新字段可选 + 归一化） | `legacy-v09-save` 8/8、往返逐字节一致 |

其余数值（人口×5、非劳动 20%、65 家开局、100/月自动创办、160 在营、工资/裁员/奖金、设备产能与单位经济、购债储备、破产阈值等）均沿用 v1.2，未做“为让数据好看”的调整。

## 4. 测试与桌面验证

- `npm run typecheck`：0 错误；`npm run build`：通过（渲染层 + Electron 主进程）。
- 全量：**117 文件 / 894 项全部通过**（按 12 块跑，约 25 分钟；1GB 容器下 vitest worker `Timeout calling "onTaskUpdate"` 为环境噪声，断言全绿；chunk 9 与 economy-stability 单跑 exit 1 同理，复跑 exit 0）。
- 针对性回归：`investor-equity-flow` 8、`inventory-cogs` 5、`production-rounds-v13` 4、`founding-v13` 6、`consumer-unemployed-v13` 8、`investor-dividend-attribution` 11、`bond-reserve-v12` 7、`household-consumption-loans` 9、`legacy-v09-save` 8、`legacy-v09-roundtrip-v12` 5 全绿。
- 重锁说明（保留全部守恒/结构断言，未放宽）：`tests/acceptance/bankruptcy-real-run.test.ts` 按 v1.3 真实 36 月序列锁定——三城均未破产（`records=[]`），t36 负债率 0.274538/0.324716/0.431076（normal），债券 36 期 `plan=sold=2,905,015`、`unsold=0`、holdings 727（active 725）、199 笔票息、33 期欠息合计 105,829,000；`settlement-resume` H09 改为构造破产场景读档幂等；`fiscal-log-visibility`/`public-bankruptcy-panel` 新增 `tests/helpers/v13-bankruptcy.ts` 构造带真实兑付的破产（10/10），因为“真实序列 36 月内无破产城市”不再成立；`economy-stability` 120 月超时 180s→420s（两轮生产后耗时 229s）。
- 桌面验收：build 完成后 `scripts/acceptance-v09.cjs` → **12/12 通过、0 条控制台错误**；7 张 PNG + `report.json` 入仓 `docs/evidence_v1.3/`。检查项含人口×5、需求 vs 成交、企业设备/计划、界面买新设备（走企业卖方：市价 147,440）、挂/买二手设备、股票窗口、存读档一致、1100×700 无横向溢出。

## 5. 72 个月观察（种子 20261101、玩家无操作、默认 AI）

### 5.1 关键节点

| 月 | 岚港就业/失业率 | 铁谷 | 青原 | 岚港食品有效满足率 / 基本需要覆盖率 | 政府历史破产（三城） |
| --- | --- | --- | --- | --- | --- |
| t1 | 64,919 / 86.5% | 55,317 / 83.9% | 49,623 / 80.6% | 99.6% / 43.2% | 0 / 0 / 0 |
| t12 | 66,000 / 86.3% | 63,238 / 81.7% | 45,055 / 82.4% | 99.8% / 13.6% | 0 / 0 / 0 |
| t24 | 56,456 / 88.3% | 60,945 / 82.4% | 34,791 / 86.5% | 99.8% / 11.4% | 0 / 0 / 0 |
| t36 | 40,849 / 91.5% | 50,587 / 85.4% | 28,299 / 89.0% | 40.0% / 22.4% | 0 / 0 / 0 |
| t72 | 15,627 / 96.8% | 19,327 / 94.5% | 10,176 / 96.1% | 71.7% / 6.6% | 0 / 0 / 1（青原 t64） |

t72 其余指标：月 GDP 1.55 / 1.84 / 0.97 亿；负债率 75.9%（high）/ 55.6%（watch）/ 18.8%（normal）；在营企业 95 / 86 / 53 家（累计成立 19/23/18、倒闭 13/20/27）；居民现金 17.63 / 19.25 / 6.88 亿、存款 5.87 / 4.88 / 3.21 亿；消费贷未偿 102.4 万 / 2.20 亿 / 1.59 亿。

### 5.2 与 v1.2 基线（09a8d1b）对比

| 指标（t72） | v1.2 | v1.3 |
| --- | --- | --- |
| 失业率（岚港/铁谷/青原） | 98.7% / 98.8% / 97.5% | 96.8% / 94.5% / 96.1% |
| 政府历史破产 | 4 / 7 / 3 | 0 / 0 / 1 |
| 在营企业 | 17 / 10 / 17 | 95 / 86 / 53 |
| 食品有效满足率 | 0.0% / 0.0% / 0.9% | 71.7% / 100% / 52% |
| 基本食品需要覆盖率 | 0% / 0% / 0.2% | 6.6% / 9.9% / 8.5% |

结论：v1.3 的“记账/时序/权益/财政”修复让企业存活数与破产次数显著改善，食品有效需求满足率回升；但**居民收入与就业仍持续恶化**，基本需要覆盖率仍低（t72 约 7–10%），远未达到“经济稳定”。t12 失业率 86.3%/81.7%/82.4%（v1.2 91.1%/88.7%/91.8%）有所改善，但 t24 起重新走高。

### 5.3 食品链与设备链时间线

- 食品链（岚港，食品厂产能 → 计划 → 成交 / 有效需求）：t1 4 家 5.73M → 4.36M → 6.74M/6.77M；t12 19 家 14.16M → 5.82M → 2.12M/2.13M（有效需求因收入崩塌缩到 2.13M）；t24 17 家 16.86M → 5.06M → 1.80M/1.80M；t36 10 家 18.21M → 4.58M → 3.52M/8.81M（有效满足率 40%）；t72 4 家 20.90M → 1.04M → 1.04M/1.45M（价 121 上限、覆盖 6.6%）。早期断点已从“盈利企业被分红抽干周转金”转移到**居民收入崩塌导致有效需求萎缩 + 高价格抑制**，食品产能其实充足（20.9M > 需要 15.8M），但计划仅为产能 5%。
- 设备链：9 家开局设备厂 + 后续创办的小设备厂自然生产并售出（农机 255、工业设备 240、能源设备 96 台；企业购置 1.51 亿、出售 7,621.1 万）；t72 政府设备储备 0/0/0（已被各方买空），创业障碍因此以 `equipment` 为主；设备价格 t72 农机 66,000（跌到地板）、工业 110,000、能源 88,000–115,555。
- 谷食物流：t36 起谷物价格上升（t36 28.6、t72 48.4），局部缺货（t36 岚港谷物缺 0.67M）与食品高价并存；t72 岚港谷物成交 0.64M（需求 0.64M），食品价 121 为价格上限。

### 5.4 多 seed 对照（36 月，4 个种子中 3 个）

| 种子 | 岚港 失业/食品满足/企业 | 铁谷 | 青原 | 政府历史破产 |
| --- | --- | --- | --- | --- |
| 20261101 | 91.5% / 40.0% / 104 | 85.4% / 61.0% / 98 | 89.0% / 99.8% / 70 | 0 / 0 / 0 |
| 20261102 | 94.3% / 12.3% / 95 | 87.9% / 32.6% / 90 | 89.3% / 85.9% / 61 | 0 / 0 / 0 |
| 777001 | 96.3% / 7.0% / 106 | 81.2% / 100% / 88 | 88.2% / 100% / 69 | 0 / 0 / 0 |

多 seed 结论一致：机制层修复稳定（守恒/结构全绿、破产显著减少），但城市间分化大、失业率整体仍高，不构成“经济已平衡”的证据。

## 6. 实现文件清单

- 投资权益：`src/simulation/population/household-investment.ts`（新）、`src/simulation/investors/investors.ts`、`src/simulation/population/household-economy.ts`、`household-groups.ts`、`household-finance.ts`、`src/simulation/core/save.ts`、`src/simulation/contracts/types.ts`。
- 库存成本：`src/simulation/finance/inventory-cost.ts`（新）、`src/simulation/finance/finance.ts`、`src/simulation/production/production.ts`、`src/simulation/markets/*`、`src/simulation/trade/*`、`src/simulation/equipment/equipment.ts`、`save.ts`。
- 月内分阶段：`src/simulation/core/simulation.ts`、`src/simulation/production/production.ts`、`src/data/config.ts`。
- 创业/扩产：`src/simulation/companies/founding.ts`、`src/simulation/companies/lifecycle/lifecycle.ts`。
- 消费：`src/simulation/markets/consumer.ts`、`src/simulation/markets/markets.ts`。
- 报告脚本：`scripts/economy-v09-report.ts`（`--seed`、政府财政明细、企业成本、食品链、居民投资权益、失业群体、基本需要覆盖率、创业尝试截断标注）。
- 测试：新增 `tests/investor-equity-flow.test.ts`、`tests/inventory-cogs.test.ts`、`tests/production-rounds-v13.test.ts`、`tests/founding-v13.test.ts`、`tests/consumer-unemployed-v13.test.ts`、`tests/v13-multi-seed-conservation.test.ts`、`tests/helpers/v13-bankruptcy.ts`；重锁 5 个 acceptance/稳定性测试（见 §4）。

## 7. 已知问题（诚实清单）

1. **宏观仍未稳定**：基本食品需要覆盖率 t72 仅 6.6%/9.9%/8.5%；失业率 94.5–96.8%；食品价格触及 121 上限；居民收入/就业继续下滑。
2. **根本结构张力未解决**：人口×5 但开局 65 家的食品产能/就业有限，且工资刚性 + 高价格使大量居民买不起；v1.3 未新增开局规模（任务书要求保留开局结构），只修复机制。
3. **要素市场瓶颈**：政府设备储备 t72 已 0/0/0，新企业无法取得设备（创业障碍 `equipment` 74/80）；设备厂价格跌到地板后利润薄，扩产意愿低。
4. **财政**：岚港 t72 负债率 75.9%（high），靠新发债/贷款滚动；未触发破产但风险高。青原 t64 破产 1 次。
5. **投资权益分配**：青原投资实体账本现金仅 1,430（收益已用于投资），居民转账与投资用途表可由报告复算，但“实体留存现金”分布不均，属投资决策结果而非记账错误。
6. **记录窗口**：破产记录 8 条、创办/倒闭 60 条、财政 800 条、创业尝试 80 条；超出的历史不可得，报告已逐处标注截断。
7. **性能**：72 月观察约 130s（2 核高负载容器）；120 月稳定性测试 229s。

## 8. Windows 复验步骤

```powershell
git checkout feature/stock-market-ui-tax
git pull --ff-only
$env:HOME = "C:\path\to\.home"; $env:npm_config_cache = "C:\path\to\.npm-cache"
npm ci
npm run typecheck
npm run build
npx vitest run --maxWorkers=1 --testTimeout=180000
npx tsx scripts/economy-v09-report.ts --months=72 --seed=20261101
node scripts/acceptance-v09.cjs   # 需先启动 Electron 依赖，Windows 下用 npm run dev 或 electron 直接运行
```

## 9. Git 与 SHA

- 基线：`09a8d1b`（v1.2）；main：`6c45000`（未改动）。
- 本轮提交（本地 = 远程 `origin/feature/stock-market-ui-tax`）：
  - `0dde78d` feat(v1.3)：模拟层 + 测试（src + tests，含版本 1.3.0）
  - `3deb27a` test(acceptance)：72 月报告脚本 + 桌面证据 `docs/evidence_v1.3`
  - `0c80ab2` docs(v1.3)：交付报告 + README + 1.3.0 版本标识
- 最终本地/远程 SHA：`0c80ab214b159b23805d54fd71799dee3f951415`
- 工作区：干净；PAT 仅以环境变量使用并已删除临时文件（建议在 GitHub 撤销该 token）。
- 未合并 main、未 rebase/amend/force、未改写已推送历史；PAT 仅以环境变量使用，未落盘。
