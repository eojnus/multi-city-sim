# v0.8 交付报告：股票市场窗口、右侧栏标签化、股票联动与税收

- 分支：`feature/stock-market-ui-tax`
- 基线：`6c45000efc4c406d30e22c0a12bd066fc2df61f7`（origin/main）
- 版本：`GAME_VERSION = 0.8.0`，`SAVE_FORMAT_VERSION = 8`
- 本报告记录 v0.8 的实现、口径、验证与 36 个月观察；所有数值与规则除文档标注“已确认”外均为**可替换的暂定演示参数**。

## 0. 结论摘要

1. 新增**独立股票市场大窗口**（可拖动/缩放/关闭，三栏），按“有表决权股 / 仅分红股”两类股份独立显示持仓、报价、挂单与**月度 OHLCV K 线**；K 线只由真实成交（玩家撮合与月结 AI 撮合）生成，无成交月份留空档，旧档显示“暂无数据”。
2. 右侧栏重构为**按对象分标签**：城市 6 个标签、企业 5 个标签、建筑/街区 2 个标签，默认“概况”；切换标签只改 UI 状态，不推进时间、不触发任何 store 命令；市长专属财政/税收面板仍只对现任市长渲染，命令层权限未放宽。
3. 居民投资实体与企业 AI 改为**真实财务驱动**的股票买卖（现金、账面价、利润、负债/权益、K 线动量、风险偏好），全部走真实挂单撮合，不使用随机数、不虚构资金或股份；企业买方只能买有表决权股份。
4. 新增**消费税 5%（含税标价）**、**股息税 10%（从实际分红中扣除）**、**城内交通税收系数 0.5–1.5**（作用于个税/企业所得税/消费税/股息税；>1 的差额作为“交通财政加成”由系统注入政府，<1 的差额作为“交通征收损耗”单独记账，纳税人不补缴、不退款）。
5. 存档升级到 v8：旧档迁移只补空行情、空税账与中性系数，**不虚构历史成交、不改变现金/股份/债务、不重复扣税**。
6. 实际验证：`tsc` 0 错误、`build` 通过、**73 文件 / 586 项测试全绿**、桌面逐项验收 **36/36、0 条控制台错误**、机制冒烟 exit 0。
7. 交付过程中通过桌面走查发现并修复一个真实缺陷：同一 tick 内订单号 `orders.length + 1` 可能复用已释放号段，导致玩家撤单命中他人同号订单；已改为生成唯一订单号并新增回归测试（`tests/stock-order-ids.test.ts`）。该修复使 36 月确定性序列小幅漂移，`bankruptcy-real-run` 已按最终代码实测值重新锁定（结构/守恒断言未放宽）。

## 1. 分支与环境

- 仓库：`https://github.com/eojnus/multi-city-sim`
- 分支：`feature/stock-market-ui-tax`（自 origin/main `6c45000` 创建；main 未改、未合并）
- 本地环境：Node 26 / npm 11；`HOME=/workspace/Coding/.home`、`npm_config_cache=/workspace/Coding/.npm-cache`；Electron 38.8.6（二进制手动解压，`--no-sandbox`）；桌面验收使用 Xvfb `:99` 与隔离 `userData`。

## 2. 技能发现、安装与使用（任务书第三节）

按任务书要求先用 find-skills 搜索“游戏 UI/UX 与桌面信息界面”相关技能，并安装最小集合：

| 技能 | 来源 | 安装量/仓库 star | 在本项目中的用途 |
| --- | --- | --- | --- |
| `game-ui-ux` | `gamedev-skills/awesome-gamedev-agent-skills` | 12.2K 安装 / 6.6K star | 覆盖层窗口的锚点与缩放、最小尺寸、焦点/键盘关闭、界面状态栈、事件驱动更新 |
| `frontend-design` | `anthropics/skills` | 1.1M 安装 / 186.7K star | 深色像素风下的排版层级、色彩与空间节奏，避免模板化面板 |
| `web-design-guidelines` | `vercel-labs/agent-skills` | 817.9K 安装 | ARIA tabs、焦点可见性、可读性、极小窗口紧凑规则 |

此前会话已安装并继续使用：`find-skills`（`vercel-labs/skills`，37.8K star）、`verification-before-completion`（`obra/superpowers`）、`typescript-advanced-types`（`wshobson/agents`）、`improve-codebase-architecture`（`mattpocock/skills`，作为已退役的 `request-refactor-plan` 的后继）。安装位置：`/workspace/Coding/.agents/skills/` 与 `/workspace/Coding/.dsh/skills/`。

## 3. 交付内容

### 3.1 股票市场大窗口

- 入口：HUD「股票」按钮；企业右栏「股票」标签内的「查看股票行情」按钮（自动定位到该企业）。
- 布局：左列企业列表（每家企业一行，含城市/行业/两类股份价格/玩家持股/挂单数；搜索框 + 城市筛选 + 行业筛选 + 全部/我的持仓）；中列行情与 K 线；右列基本信息、持仓、买卖下单（股数、限价、快捷数量、预估金额、可用现金、可卖股数）、委托状态与撤单。
- 窗口行为：标题栏拖动、右下角缩放（最小 900×560）、拖动/缩放均夹在可视区域内（至少保留 160px 标题栏可见）、关闭按钮与 Esc 关闭；打开/关闭不改变自动推进（暂停）状态。
- **K 线与口径**：
  - 每根 K 线 = 一个游戏月（`tick` 即月份），OHLCV 由该月全部**真实成交**按时间顺序聚合：open=首笔价、high/low=月内极值、close=末笔价、volume=成交股数、trades=成交笔数。
  - 某月无成交 → 不生成蜡烛（界面提示“暂无成交/暂无数据”），不伪造收盘价；旧档迁移后历史为空，从启用后的真实成交开始累积。
  - 两类股份（有表决权/仅分红）各自独立行情、持仓、挂单与 K 线，互不混用。
  - 价格标识区分：**最近成交价**（最近一笔真实成交）、**账面参考价**（`bookPrice` 账面估值，不可成交）、**挂单价**（买一/卖一），不互相冒充。
  - 成交历史 `securities.lastTrades` 与月度行情 `securities.history` 都随存档保存；读档/重复月结不重复写入（同一 tick 成交按 tick 聚合）。
- 交易规则：买卖分开、类别标注；一级融资（financing offer）资金进企业，二级买卖资金进卖方；不做空、不融资融券、不设涨跌停；未成交部分保留为挂单，撤单只移除委托（不动现金/持股）。

### 3.2 右侧栏标签化

| 上下文 | 标签 | 原功能对应位置 |
| --- | --- | --- |
| 城市 | 概况 | 城市身份、市长演示、KPI、GDP 轨迹 |
| 城市 | 人口 | 人口结构、财富阶层、职业群体、人才市场 |
| 城市 | 企业 | 企业生命周期、企业列表（点击进入企业上下文） |
| 城市 | 市场 | 商品市场、银行、债券、贸易协议（区域视图另含贸易摘要） |
| 城市 | 政府 | 市政府与政策、市长财政、城市税收、竞选；科技/政治/房地产；公共破产公告 |
| 城市 | 交通 | 城内交通网络、跨城线路与项目投资 |
| 企业 | 概况 | 公司头、备注、KPI |
| 企业 | 经营 | 自动经营、经营者与模式、选任、持续经营计划、提案 |
| 企业 | 财务 | 上月损益、岗位分布、库存、注资 |
| 企业 | 股东与治理 | 股东结构、董事会、动议与表决 |
| 企业 | 股票 | 两类股份交易、账本入口、“查看股票行情” |
| 建筑 | 概况 / 相关主体 | 建筑信息；关联企业详情 |
| 街区 | 概况 / 相关主体 | 街区信息；街区内企业列表 |

- 标签状态存于 UI 层（`rightTab` + 上下文键），切换不调用 store 命令、不推进时间、不改变选择；选中对象变化时回到“概况”。
- 权限未变：市长财政/税收、破产金额明细仅该城现任市长可见；非市长看到受限提示。命令层原有校验（发债、贷款、经营、投票等）未放松。
- 结构：新增 `src/ui/right-panel/`（tabs / city-tabs / company-tabs / shared / index）与 `src/ui/stock-window/`（index / chart）；`panels.ts` 复用既有 section 并新增选择器；未引入新前端框架，UI 只读 store 视图并调用既有命令。

### 3.3 股票—居民/企业联动（首版 AI）

- 居民仍以“群体 + 投资实体”参与：`collectInvestableFunds` 继续按收入/存款划拨，投资实体用**自身现金**下单，分红经既有链路返还居民；同一笔居民现金不会同时计入消费与投资。
- 投资实体 AI（`planInvestorOrders`）：
  - 判断输入：持仓与账面价、最近月利润、企业负债/权益、近 6 月 K 线动量、风险偏好、现金与流动性储备。
  - 出价：以账面价为锚、按动量与风险调整限价（首版 ±2% 量级），挂真实限价单；无对手方允许无成交。
  - 频率与预算：每实体每月先卖出少量持仓提供流动性，再用约 35% 可投资现金买入，最多 2 家、每类股份不双向挂单，受 `config.securities.ai` 集中配置。
- 企业 AI（`planCompanyOrders`）：保留 3 个月工资现金后，用至多 min(5% 现金, 50 万) 买入**有表决权**股份；只买有表决权股份（`placeOrder` 强制），持股不自动取得经营权。
- 全部决策使用种子派生的确定性哈希（`stableUnit`），不使用 `Math.random`；不新增贷款绕过信贷/授权，不产生自成交（同一持有人不对倒）。
- 首版局限：不做投资组合优化、不预测季度盈利、不主动发起要约收购；企业战略投资仅按现金比例。

### 3.4 税收与城内交通系数

| 税种 | 税基 | 纳税人 | 归属城市 | 记账 |
| --- | --- | --- | --- | --- |
| 消费税 5% | 居民消费品**实际含税成交额**（只对居民消费，企业采购不征） | 居民群体（最终承担） | 消费发生地（跨城按实际消费城市） | 标价含税：买方付 100、税 5、卖方实收 95；`ledger.consumptionTax` 与 `world.taxes.accrualByCity` 累计，月结入财政 `consumptionTax` |
| 股息税 10% | **实际发放**的股息（玩家、居民投资实体） | 玩家 / 居民投资实体 | 居民实体按所属城市；玩家按其所属城市，否则按发放企业所在地 | 从分红中扣除：应得 1000 → 税 100 → 净收 900；企业/政府股东首版不征；居民实体返还的已税分红不再重复征 |
| 个税 14% | 私人工资 + 公共部门工资 | 居民群体 | 工作城市 | 按交通系数缩放后入财政 |
| 企业所得税 5% | 企业税前利润 | 企业 | 企业所在城市 | 按交通系数缩放后入财政 |

**城内交通税收系数**：

- 保障率 = `clamp(有效城内交通容量 ÷ 城内交通需求, 0, 1)`；需求 0 → 系数 1.0（中性）；需求 > 0 且容量 0 → 保障率 0。
- 系数 = `0.5 + 保障率`（0% → 0.50，50% → 1.00，100% → 1.50）。
- 使用**上一完整月**的 `world.transport.lastMonth.intracity`（在当月结算覆盖之前读取），新游戏首月/旧档无数据 → 中性 1.0。
- 账务：纳税人按基准税缴纳（不因系数多付/少付）；政府入账 = 基准 × 系数；差额>0 记 `transportTaxBonus`（系统注入，正数），差额<0 记 `transportTaxLoss`（负数，单独流出）；0.01 精度、确定性舍入。交通调整不是债务、贷款、成交或 GDP。
- 可对账：`基准税额 + 交通加成 − 交通损耗 = 最终入账`；四税分项求和 = 当月总入账（测试与桌面脚本均校验）。
- 面板：市长「政府」标签新增“税收结算 · 基准税与交通系数”，展示基准税额、系数/保障率、加成、损耗、最终入账与近 6 月历史；非市长不可见。
- **口径局限（如实说明）**：当前 `intracity.demand` 是“城内货物配送成交量”（本地成交 + 进口量），不是居民通勤需求；因此它衡量的是货运配送压力，与任务书的“城内交通需求”只是近似。实测 36 个月内三城保障率恒为 1（容量 ≥ 货运需求），系数恒为 1.50，`transportLoss` 为 0——即“加成”分支被验证，“损耗”分支仅由单元测试覆盖。

### 3.5 存档 v8

- 新增：`securities.history`（每类股份月度 OHLCV 与最近成交）、`world.taxes`（各城当月应计与最多 12 个月历史）、`city.market[goodId].consumptionTax`、`city.lastMonth` 的税收字段、`FiscalEntry` 四种税/加成/损耗类型。
- `migrateWorldV7ToV8`：补空行情、空税账、中性系数（history 为空、accrual 为 0、lastMonth 默认 1.0/0/0），追加 system 日志说明；**不虚构过去成交、不改变任何现金/股份/债务、不重复扣税**，幂等。
- 校验：`validateSecurities` 校验行情（类别存在、tick 严格递增、OHLC 关系、量/笔数非负）；`validateTaxes` 校验税账（城市存在、非负、系数 0.5–1.5、保障率 0–1）。

## 4. 新增/修改文件（主要）

- 新增：`src/simulation/government/taxes.ts`、`src/simulation/securities/history.ts`、`src/ui/right-panel/*`、`src/ui/stock-window/*`、`tests/migration-v8.test.ts`、`tests/stock-candles.test.ts`、`tests/stock-ai.test.ts`、`tests/stock-order-ids.test.ts`、`tests/tax-consumption.test.ts`、`tests/tax-dividend.test.ts`、`tests/tax-transport.test.ts`、`tests/ui-tabs.test.ts`、`tests/ui-stock-window.test.ts`、`scripts/acceptance-v08.cjs`、本报告与 `docs/evidence_v0.8/`。
- 修改：`src/simulation/contracts/types.ts`、`src/data/config.ts`、`src/simulation/core/{initializer,save,simulation}.ts`、`src/simulation/{markets/markets.ts,markets/consumer.ts,markets/intercity.ts,transport/settlement.ts,finance/finance.ts,government/fiscal.ts,securities/securities.ts,investors/investors.ts}`、`src/app/gameStore.ts`、`src/ui/{panels.ts,ui.ts,styles.css}`、`vite.config.ts`（长序列测试超时 30s）、`package.json` 等。

## 5. 测试与验证（实际执行）

```powershell
npm run typecheck   # 0 错误
npm run build       # 通过（Vite + Electron 编译；chunk 体积既有告警）
npx vitest run --maxWorkers=1   # 73 文件 / 586 项全部通过
```

- 新增/更新的关键用例：
  - `tests/stock-candles.test.ts`（10）：同月多笔聚合成一根、无成交月不生成、lastTrade 与 OHLC 一致、裁剪、旧档空容器、`matchOrders` 当日成交写入且不重复。
  - `tests/stock-ai.test.ts`（8）：投资实体/企业用真实现金与股份下单、企业只买有表决权股份、无对手方无成交、确定性、跳过玩家经营企业、不产生负现金。
  - `tests/stock-order-ids.test.ts`（2）：同 tick 释放号段后订单号不冲突、连续下单唯一——覆盖本次桌面走查发现的真实缺陷。
  - `tests/tax-consumption.test.ts`（7）：100 含税 → 居民付 100、税 5、卖方 95；部分成交按实际成交额；企业采购不征；跨城归属消费地；退款同步；读档不重复。
  - `tests/tax-dividend.test.ts`（3）：1000 → 税 100 / 净 900；居民实体返还不再征；企业/政府股东不征。
  - `tests/tax-transport.test.ts`（7）：0%/50%/100% 保障率 → 0.5/1.0/1.5；无需求中性；无容量 0.5；加成/损耗分账；跨月使用上一月；四税同系数。
  - `tests/ui-tabs.test.ts`（8）/`tests/ui-stock-window.test.ts`（12）：标签集合、默认概况、切换不改状态、对象切换重置、权限提示、窗口尺寸/拖动/缩放/关闭、下单撤单状态、空 K 线。
  - `tests/migration-v8.test.ts`（4）：v7→v8 补账不造数据、幂等、v8 往返、v4 长链迁移。
  - 既有回归（银行/债券/破产/治理/交通/消费/居民债务等）全部通过；`tests/acceptance/bankruptcy-real-run.test.ts` 按最终代码实测序列重新锁定（岚港 t28 破产；t36 负债率 64.2% watch / 51.2% watch / 0%），保留全部守恒与结构断言。

## 6. 桌面走查（真实 Electron，任务书第四节）

运行：

```bash
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox \
  --disable-gpu --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v08.cjs
```

结果：**36/36 项通过、0 条控制台错误**；截图 10 张 + JSON 已入仓 `docs/evidence_v0.8/`（不依赖被 gitignore 的 `artifacts/`）：

- `v08-01-region-overview.png`：区域视图 + 右栏标签（默认概况）
- `v08-02-city-tab-{population,companies,market,government,transport}.png`：城市 6 标签
- `v08-03-company-operation.png` / `v08-04-company-stocks.png`：企业 5 标签与行情入口
- `v08-05-stock-window-empty.png`：新世界空 K 线（暂无成交/暂无数据）
- `v08-06-stock-window-moved.png`：拖动/缩放/边界夹取后的窗口
- `v08-07-stock-window-candles.png`：推进两个月后由真实成交生成的月 K 线
- `v08-08-stock-window-order.png`：限价单挂出（未成交、现金不变）
- `v08-09-city-tax-mayor.png`：市长税收面板（基准税/系数/加成/损耗/最终入账）
- `v08-10-small-window.png`：1100×700 无横向溢出
- `acceptance-v08.json`：逐项检查与结果

覆盖场景：标签切换与状态不变、对象切换、两类股份切换、窗口打开/拖动/缩放/关闭/Esc、空 K 线与真实成交、搜索/筛选/我的持仓、下单/委托/撤单、市长与非市长税收权限、存读档保留行情与税账、控制台错误。另：`npm run smoke`（`scripts/smoke-main.cjs`）已适配“企业列表在「企业」标签内”，exit 0。

## 7. 36 个月固定条件观察（任务书第八节；仅 1 次，种子 20261101、玩家无操作）

命令：`npx tsx scripts/economy-balance-report.ts`（耗时 3.6s，exit 0，末期不变量通过）。

| 指标（M36 / 36 月累计） | 岚港 | 铁谷 | 青原 |
| --- | --- | --- | --- |
| M36 GDP | 21,168,683 | 36,240,521 | 98,481,677 |
| 36 月经营收入（剔除融资） | 976,431,637 | 1,106,224,362 | 1,592,992,746 |
| 36 月经营支出（剔除融资） | 1,262,600,803 | 1,066,848,111 | 558,952,603 |
| 经营差额 | −286,169,166 | +39,376,251 | +1,034,040,143 |
| 融资净额（发债 + 政府贷款 − 票息/还贷） | +491,267,108 | +190,407,239 | 0 |
| 期末财政 | 42,987,015 | 0 | 661,373,712 |
| 期末总负债（负债/GDP） | 192,931,901（64.0%，watch） | 195,954,774（51.0%，watch） | 0（0%） |
| 政府破产 | 1 次（M28，重选罗知远） | 0 | 0 |
| M36 居民实际消费 / 期望 | 46,822,901 / 280,705,496 | 47,375,239 / 199,342,845 | 65,443,069 / 122,361,143 |
| 世界银行 | 存款 18.80 亿；贷款未偿 2.49 亿；未结清 128 / 违约合同 96；本月利差 −163.7 万（36/36 月为负） | | |
| 债券 | 20 期，计划 705,855 / 成交 670,024 / 未售 35,831；票息 714.5 万；还本 3.084 亿；银行垫付 3.129 亿 | | |
| 企业 | 17 → 37 家（成立 27 / 倒闭 7）；7 家清算零回收，减免 1.519 亿（占期末未偿 61.0%） | | |
| 居民消费贷 | 家庭金融账本 1,985 笔未偿（含拆分；全部为消费贷） | | |

**近 12 个月税收（税账只保留 12 个月历史；系数本月=1.50，三城保障率均 1）**：

| 城市 | 个税 | 企业所得税 | 消费税 | 股息税 | 交通加成 | 交通损耗 | 最终入账 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 岚港 | 96,298,761 | 5,780,922 | 26,113,861 | 10,009,786 | 46,067,777 | 0 | 138,203,330 |
| 铁谷 | 99,679,481 | 9,808,828 | 55,620,356 | 23,353,005 | 62,820,557 | 0 | 188,461,671 |
| 青原 | 214,183,008 | 54,072,298 | 58,392,165 | 90,226,279 | 138,957,917 | 0 | 416,873,750 |

**与 v0.7.2 对比（同条件）**：

- M36 GDP：岚港 20.75M → 21.17M；铁谷 4.24M → 36.24M；青原 108.30M → 98.48M；世界 133.29M → 155.89M。
- 负债：岚港 127.74M(40%) → 192.93M(64%)；铁谷 72.10M(34%) → 195.95M(51%)；青原 0 → 0。
- 破产：v0.7.2 岚港 M29、铁谷 M31 → v0.8 仅岚港 M28；铁谷通过消费税/股息税/交通加成获得更多财政现金流，36 月内未破产（其支出仍高于经营收入，靠发债维持，不能解读为“财政健康”）。
- 青原转为**经营盈余**：36 月经营收入 1.593B vs 支出 0.559B，财政 661M 且无负债；主要来自居民消费贷扩张与高税收（青原消费贷未偿 2.04 亿、股息税 0.90 亿）。

**必须区分“经营改善”与“融资/垫付/勾销”**：

- 岚港/铁谷 36 月经营支出仍高于经营收入（岚港 −286M、铁谷 +39M 但月结财政仍转负）；M36 财政余额没有继续恶化，主要来自发债（4.33 亿/1.90 亿）、政府贷款与破产勾销（3.62 亿），**不是经营收支改善**。
- 破产兑付由银行无条件垫付并最终勾销：岚港 M28 垫付 3.129 亿、勾销普通贷款 0.489 亿、欠息 0；银行负利差 36/36 月，7 家清算零回收减免 1.519 亿。破产成本目前是**隐性**的（不落在任何主体资产负债表上，也不进财政流水）。
- 消费仍显著低于期望（三城约 17%–40%），主因供给/资金约束与居民可支配收入；消费贷未偿高（青原 2.04 亿）且违约合同占比高（银行违约未偿 80.6%）。
- 结构性结论：本版税制提高了政府现金流与债券认购，但没有解决“经营支出 > 经营收入 + 隐性破产成本 + 消费不足”的结构性问题；不做结论性“经济平衡已验证”声明。单一种子、单一条件，不能外推概率。

## 8. 首版暂定参数（集中配置）

- `config.tax`：`consumptionTaxRate 0.05`、`dividendTaxRate 0.10`、`transport { minGuarantee 0, maxGuarantee 1, baseFactor 0.5, neutralFactorWhenNoDemand 1 }`、`historyMonths 12`。
- `config.securities`：`historyMonths 36`、`tradeHistoryLimit 400`；`ai { enabled, lookbackMonths 6, maxBuyOrdersPerGroup 2, maxSellOrdersPerGroup 4, groupBudgetShare 0.35, companyBudgetCap 500000, companyBudgetShare 0.05, companyReserveWageMonths 3, requireNonNegativeProfit, takeProfitRatio 0.15, riskWeight 0.6 }`。
- 36 月债券参数、银行利率、破产门槛（12 月 GDP 100%）等均为既有已确认/暂定规则，本版未修改。

## 9. 未完成项与已知限制

1. 城内交通需求沿用“本地成交 + 进口”的货物配送量，不是居民通勤；实测保障率恒为 1、系数恒为 1.50，“交通征收损耗”只在单测中出现。要真正评估交通对税收的压力，需要单独的通勤/道路拥堵口径。
2. 居民消费贷合同数随群体变化拆分而增长（本次 36 月为 1,985 笔），虽已用“同还款计划碎片合并”控制增长，但仍是线性增长；后续可做聚合账本。
3. K 线为月度 OHLCV，未提供分钟/日线、成交量加权均价等；AI 交易频率为每月一次（月结），不做日内高频。
4. AI 投资为首版规则型：不做组合优化、不基于财报预测、不做要约收购；企业投资上限较小（5% 现金、50 万）。
5. 股息税首版对企业/政府股东不征；居民实体返还已税分红不重复征，但跨境归属按“所属城市”简化。
6. 消费税只对居民消费品（食品/日用品等消费类商品）征收，服务/住房等尚无消费口径。
7. 桌面证据为 Xvfb 无头截图；Windows 真机表现需按第 10 节复验。
8. 数值平衡仍是单种子 36 月观察，不能外推为概率结论。

## 10. Windows 复验步骤

1. `npm install`；若 Electron/esbuild 安装脚本被拦截：`node node_modules\electron\install.js`、`node node_modules\esbuild\install.js`。
2. `npm run typecheck`、`npm test`、`npm run build`。
3. `npm start`：HUD「股票」打开窗口 → 拖动/缩放/关闭；切换两类股份；推进 1–2 个月后查看 K 线；下一笔限价单并撤单；右栏城市/企业标签逐项切换。
4. 市长身份：在「政府」标签查看“税收结算”面板；清除市长身份后确认金额不可见（命令层也会拒绝）。
5. 存档 → 推进 → 读档，确认 K 线、税账、持仓不变。
6. 参考截图：`docs/evidence_v0.8/`。

## 11. Git

- 分支：`feature/stock-market-ui-tax`（不在 main 上提交、不合并、不 force push、不改写已推送历史）
- 基线：`6c45000efc4c406d30e22c0a12bd066fc2df61f7`
- 最终提交与远程 SHA：见文末提交记录（本报告随文档提交一并推送）。

# 17. v0.8.1 复验修复记录（2026-11-03）

- 开发基线：`010888ecdc62febfd4ef527ded8d97524f5ad886`
- 本轮代码提交：`bc0b43b`（模拟/税收/历史）、`a0eac87`（K 线/股票窗口/桌面脚本）；文档与证据提交随本次推送给出
- `SAVE_FORMAT_VERSION` 保持 8，`GAME_VERSION` 升级为 `0.8.1`（仅新增可选字段与放宽校验，v8 旧档可读）

## 17.1 交通税收加成/损耗在财政流水中重复计算

**根因**：`settleCityTaxes` 先把“调整后的最终税收”记入财政流水，又各记一笔 `transportTaxBonus` / 负数 `transportTaxLoss`；市长财政视图按流水金额正负分别汇总为收入/支出，于是系数 1.5 时收入显示为基准 100 + 调整 50（加倍），系数 0.5 时收入 50、支出 50、净额 0。

**修复**：财政流水改为按**基准税额**记四税，交通调整单列：

- `incomeTax` / `corporateTax` / `consumptionTax` / `dividendTax` 分录金额 = 各自基准税额（备注“基准税额；交通调整单列”）；
- `transportTaxBonus` 记正数、`transportTaxLoss` 记负数，净额 = 实际入账；
- 政府财政余额仍只增加“最终入账”（基准 × 系数），纳税人仍只付基准税额；加成由系统注入、损耗按原口径单独流出；
- 四税可分别查询基准税额、交通调整额与最终收入（`CityTaxMonth` 四组 base/revenue + `transportBonus/Loss`），市长面板“基准税 / 交通系数 / 加成 / 损耗 / 最终入账”与流水逐项一致。

**测试**：新增 `tests/tax-ledger-consistency.test.ts`（5 项）：系数 1.5 → 财政 +150、流水 `incomeTax 100 + bonus 50`、面板收入 150/支出 0/净额 150；系数 1.0；系数 0.5 → 收入 100/支出 50/净额 50；四税 taxNet = `totalRevenue`、重复结算清账；读档后再结算不重复入账。按新口径更新 `tests/tax-transport.test.ts`（四税基准分录 + 加成/损耗，净额 49,500）。

## 17.2 K 线无成交月份的时间轴

**根因**：`renderStockChart` 以蜡烛数组下标均匀排布横坐标，1 月与 12 月有成交时仍相邻；成交量柱在固定高度 SVG 内可越出底部被裁切。

**修复**：`src/ui/stock-window/chart.ts`

- 横坐标按真实游戏月份映射：`x(tick) = left + (tick - firstTick + 0.5) × slot`，无成交月不生成蜡烛，只留空档；
- 月份刻度（最多 6 个）、空档纵向虚线 `.gap-mark` 与提示，meta 显示“覆盖 N 个月 · 空档 M 个月无成交”，悬停月份取该蜡烛真实 tick；
- 价格区与成交量区各自预留高度（`PRICE_BOTTOM = 高度 − 边距 − 成交量区 − 间隔`），成交量柱底边量化为整数并限制在基线（168）以内，不再越界；
- 新增 `data-months` / `data-gap-months` / 蜡烛 `data-tick`，便于回归测试与验收脚本核对；
- 不伪造任何 OHLCV：无成交月份没有蜡烛，成交量柱为空。

**测试**：`tests/ui-stock-window.test.ts` 增至 18 项（1 月与 12 月有成交 → 覆盖 12 个月、空档 10 个月且两根蜡烛间距 > 400px；连续月份无空档；单笔成交居中且 `data-tick` 正确；成交量柱底 ≤ 168；两类股份标题与数据独立；已退出企业只读渲染）。

## 17.3 企业退出前的真实股票历史

**根因**：`ensureStockHistory` 以现存 `securities.classes` 为依据清理历史；企业退出时股份类别被移除，随后一次调用就删掉该企业全部 K 线。

**修复**：

- `StockClassHistory` 增加可选 `companyName`、`exitedTick`；`ensureStockHistory` 保留不在现存类别中的历史条目并标记首次退出月份，存续类别同步名称并清除退出标记；`recordStockTrade` 忽略已退出类别，不会给退出企业追加成交；
- `validateSecurities` 放宽为：历史条目只要 `shareClassId/companyId` 为非空字符串、`kind` 合法即可（允许引用已退出企业），类别仍存在时继续校验一致；可选字段类型校验；
- `GameStore.stockMarketView` 在经营中企业之后追加已退出历史行（`exited: true`、`tradable: false`），明细展示企业名、类别、最后成交、退出月份与 K 线；`tradeShares` 对已退出企业/注销股份返回失败（“该企业已退出市场或股份已注销：不可再交易。”）；
- 股票窗口对退出企业显示“已退出 / 不可交易”标识与说明，隐藏下单表单；读档、刷新、其他企业交易均不清除历史。

**测试**：新增 `tests/stock-history-retention.test.ts`（4 项）：退出后 K 线/最后成交/名称快照保留并带 `exitedTick`；反复刷新与其他企业交易不清除、退出月不变；v8 存档校验允许历史引用已退出企业与类别；GameStore 列表/明细只读且下单被拒。

## 17.4 桌面证据与窗口交互复查

`scripts/acceptance-v08.cjs` 扩展为 42 项检查并重跑（Xvfb + Electron，隔离 userData）：

- 新增 `ensureWindowInside`：极限拖动触发夹取后，把窗口缩放到 ≤1200×760 并拖回 (16,16)，断言完整可见（`left/top ≥ 0`、`right/bottom ≤ 视口`）后再截图；
- 新增空档 K 线检查（最多推进 8 个月寻找 `months - candles ≥ 2` 的类别，断言 `data-gap-months ≥ 2` 且空档标记数 ≥ 2）；
- 新增两类股份切换检查（列表行全部属于 `:non-voting` 类别；无真实成交时显示“暂无成交”，不伪造）；
- 新增税收一致性检查：四税 + 加成 − 损耗的流水净额 = 税收月报最终入账，且市长面板收入 − 支出 = 流水净额；
- 新增企业退出检查：删除一家有真实成交的企业后，窗口显示“已退出”历史、保留蜡烛、无下单表单、`tradeShares` 被拒；
- **结果：42/42 通过、0 条控制台错误**；证据（17 张 PNG + JSON）已入仓 `docs/evidence_v0.8/`，关键截图：
  - `v08-06-stock-window-moved.png`：极限拖动后拖回屏幕内（1200×760 @ 16,16）；
  - `v08-07-stock-window-candles.png`：真实成交的完整 K 线与成交量；
  - `v08-11-stock-window-gap.png`：覆盖 9 个月、空档 2 个月的 K 线；
  - `v08-12-stock-window-nonvoting.png`：两类股份切换；
  - `v08-13-stock-exited-history.png`：企业退出后的历史行情与只读状态。

## 17.5 本轮验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（渲染层 + Electron 主进程，0 错误） |
| `npm run build` | 通过（`multi-city-sim@0.8.1`） |
| `npx vitest run --maxWorkers=1` | **75 个测试文件 / 601 项全部通过** |
| `node scripts/acceptance-v08.cjs`（Xvfb + Electron，隔离 userData） | **42/42 项通过、0 条控制台错误** |
| 证据 | `docs/evidence_v0.8/`（17 张 PNG + `acceptance-v08.json`） |

## 17.6 仍存在的问题与已知限制

- 城内交通需求仍以“本地成交 + 进口”的货物配送量近似，不是居民通勤；实测 36 个月保障率恒为 1、系数恒为 1.50，“交通征收损耗”分支目前只由单元测试覆盖。要评估交通对税收的真实压力，需要单独的通勤/道路拥堵口径。
- 非投票股份目前没有 AI 对手方，真实行情通常为空；窗口会显示“暂无成交”，这符合“不为成交造假”的规则，但市场活跃度有限。
- 家庭贷款合同数仍随群体变化线性增长（36 月约 2 千笔），已用“同还款计划碎片合并”抑制指数增长，后续仍需按还款计划聚合的账本结构。
- 股票 AI 仍为首版规则型（月度一次、无做市/组合优化），企业投资上限较小；消费税只覆盖居民消费品，股息税首版对企业/政府股东不征。
- 桌面证据为 Xvfb 无头截图，Windows 真机表现需按第 10 节复验；经济平衡未作为本轮目标，也未调整任何数值。

# 18. v0.8.2 复验补充修复记录：仅分红股 AI 交易（2026-11-03）

## 18.1 基线

- 分支：`feature/stock-market-ui-tax`
- 修复前基线：`7442e0a97168913d5959944490c7ac411c1bb27f`（v0.8.1）
- `SAVE_FORMAT_VERSION` 保持 8（无结构变更），`GAME_VERSION` 升级为 `0.8.2`。

## 18.2 问题

`planInvestorOrders` 的居民投资实体卖出逻辑只取 `votingClassOf`，因此仅分红股份永远没有自动卖出路径；买入候选同样以投票权股份为主。默认条件 12 个月观察中，有表决权股份出现 66 笔二级成交、仅分红股份 0 笔。

## 18.3 修复内容

### 居民投资实体（`src/simulation/investors/investors.ts`）

- 新增 `classesForCompany()`（返回企业两类股份类别）与 `dividendYieldOf()`（`lastDividend / 总股本 / 账面价`），卖出与买入候选都遍历**两类股份**。
- 卖出：只对**真实持仓**挂单，数量不超过持仓；仅分红股份基础卖出比例为 `nonVotingSellShare`（0.004），投票权沿用原流动性比例。现金低于 `minCashToInvest × nonVotingCashPressureMultiple` 时，仅分红卖出比例乘 `nonVotingCashPressureBoost`，并以 `nonVotingCashPressureLimitPremium`（0.995×账面）挂单换取成交；股息收益率 ≥ `nonVotingDividendHoldThreshold` 时按 `nonVotingDividendHoldFactor` 惜售。止盈/风险规则与投票权一致。
- 卖出配额：投票权卖单仍覆盖 `maxSellOrdersPerGroup` 家企业（保持既有市场流动性），仅分红卖单独立计数，最多 `nonVotingMaxSellOrdersPerGroup`（2）笔——两类股份的订单上限互不挤占，避免“只有投票权在卖”。
- 买入：两类股份都可形成买单；仅分红打分加 `nonVotingBuyBias + min(股息率, 0.1) × nonVotingDividendWeight`，限价为 `账面价 × (1 − 风险溢价 + nonVotingBidPremium)`。买入预算、企业买方限制、同类别禁双向挂单、确定性（`stableUnit`）规则不变。
- 企业买方仍只能买有表决权股份（既有校验未放宽）。

### 首版参数（`config.securities.ai`，集中配置）

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `nonVotingSellShare` | 0.004 | 仅分红股份每月基础卖出比例 |
| `nonVotingMaxSellOrdersPerGroup` | 2 | 仅分红卖单上限（与投票权分开计数） |
| `nonVotingSellLimitPremium` | 1.02 | 常规仅分红卖单限价（账面价倍数） |
| `nonVotingCashPressureMultiple` | 2 | 现金低于多少倍 `minCashToInvest` 视为现金紧张 |
| `nonVotingCashPressureBoost` | 2.5 | 现金紧张时卖出比例倍数 |
| `nonVotingCashPressureLimitPremium` | 0.995 | 现金紧张时限价（低于账面，换取成交） |
| `nonVotingDividendHoldThreshold` | 0.002 | 惜售的股息率阈值 |
| `nonVotingDividendHoldFactor` | 0.6 | 惜售时卖出比例倍数 |
| `nonVotingBuyBias` | 0.02 | 仅分红买入打分加成 |
| `nonVotingDividendWeight` | 2 | 股息率对买入打分的权重 |
| `nonVotingBidPremium` | 0.015 | 仅分红买入限价相对账面价的溢价 |

设计意图：仅分红股份的流动性略低于投票权（符合“只分红、无控制权”的定位），但在股息率有吸引力或现金紧张时仍会参与交易；不保证每月成交，也不制造对手方。

## 18.4 测试

| 测试 | 结果 |
| --- | --- |
| `tests/stock-ai-nonvoting.test.ts`（新增 7 项） | 通过 |
| `tests/stock-ai.test.ts`（卖单上限按类别拆分） | 8/8 |
| `tests/acceptance/bankruptcy-real-run.test.ts`（序列按新实测重锁） | 8/8 |
| 全量 `npx vitest run --maxWorkers=1` | **76 个文件 / 608 项全部通过** |

新增用例覆盖：仅分红卖单存在且不超过持仓；仅分红买单金额不超过真实现金；两个居民实体价格匹配时真实成交并核对现金/股份/K 线；只有一方或价格不匹配不成交；企业买方买仅分红被拒；两类 K 线独立且存读档后不重复成交；同一实体无自成交；存入/读取存档后再次撮合不重复。

序列漂移说明：仅分红交易改变了居民投资实体与企业的现金流，进而影响公司利润、股息与财政，36 月真实序列整体前移（岚港破产由 t28 变为 t30）。测试按最终代码实测值重锁，结构/守恒断言（兑付守恒、计划=成交+未售、writtenOff 清零、次月重建、同 tick 重选、不变量为空）全部保留。

## 18.5 桌面验证

- `node scripts/acceptance-v08.cjs`（Xvfb + Electron，隔离 userData）：**43/43 项通过、0 条控制台错误**。
- 新增场景：在股票窗口切到「仅分红」类别，找到 AI 挂出的可成交卖单，玩家按卖价买入 10 股；断言 `lastTrade.buyer === 'player'`、玩家现金减少、持仓增加、K 线出现该笔真实成交。
- 证据：`docs/evidence_v0.8/`（18 张 PNG + `acceptance-v08.json`），新增 `v08-14-nonvoting-trade.png`；同时重截了窗口内 K 线、空档 K 线与退出企业历史。

## 18.6 市场效果（默认条件、12 个月实测）

- 有表决权股份：7 笔二级成交（AI 之间），K 线持续累积。
- 仅分红股份：AI 之间撮合极少（卖价约 1.02×账面、AI 买价约 1.00×账面，通常不交叉）；但 AI 会持续挂出**可成交的仅分红卖单**，玩家可在窗口中真实买入。12 个月内 AI 之间 0 笔仅分红成交，符合“无真实对手方允许无成交、不制造行情”的规则。
- 企业买方仍只能买投票权股份，因此仅分红的主要对手方是居民实体与玩家。

## 18.7 仍存在的问题

- 仅分红股份的 AI 流动性仍低：卖价略高于买价，AI 之间成交主要发生在现金紧张（0.995×账面）时；若希望提高活跃度，可后续引入仅分红做市或按股息率定价，但本轮未改数值。
- 两类股份共享同一账面参考价，未做差异化估值。
- 家庭贷款合同线性增长、银行负利差、居民消费低于期望、交通税收系数恒 1.50 等 v0.8 已记录的问题不变。

## 18.8 本轮验证汇总

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（渲染层 + Electron 主进程，0 错误） |
| `npm run build` | 通过（`multi-city-sim@0.8.2`） |
| `npx vitest run --maxWorkers=1` | **76 个测试文件 / 608 项全部通过** |
| `node scripts/acceptance-v08.cjs` | **43/43 项通过、0 条控制台错误** |
| 证据 | `docs/evidence_v0.8/`（18 张 PNG + JSON） |
