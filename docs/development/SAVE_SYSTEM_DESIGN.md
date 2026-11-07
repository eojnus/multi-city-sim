# 存档系统设计（v1.7 模块化快照 + 历史治理）

- 分支：`feature/stock-market-ui-tax`；开发基线 `31b66272e04bdaa8f0c10f80d5dfc91d551172bf`
- 状态：设计契约已定稿；模块实现/历史治理/平台层并行开发中，实测性能与最终数据见
  `docs/development/DELIVERY_REPORT_v1.7.0.md`（交付时回填）。
- 本文件说明：数据归属、模块接口、格式与迁移、历史保留、未知/损坏处理、一致性与并发、大小口径、
  新增系统接入方式。**恢复行为以本文件的归属表为准；任何改动都要同步本表与 `ownedPaths` 测试。**

## 1. 目标与边界

- 目标：把“深拷贝整个 WorldState 再 JSON”升级为“统一存档管理器 + 分模块快照 + 版本迁移 +
  必要历史保留 + 精简 JSON + gzip”，支持未来系统（房地产、科技、更多城市）以模块接入，
  同时保持现有玩法/经济规则不变、旧存档可读、写失败不毁档。
- 非目标：本轮不调整经济体数值；不引入 SQLite/外部数据库；不做事件溯源/回放；不改存档槽位 UI 语义。
- 物理文件：一个槽位仍对应一个文件（`.json`，实际编码由文件头识别）；初版不拆多文件。

## 2. 数据归属表（权威唯一来源）

规则：
1. 每项数据只能有一个**存档归属模块**（`ownedPaths` 声明），注册表拒绝重复/祖先路径重叠。
2. 模块可以读取其他模块数据，但恢复时只写自己拥有的字段。
3. 派生缓存（如 `company.debt`、`company.totalShares`、`player.holdings`、`company.capacity`、
   `city.bankruptcy`）随权威一起持久化，但恢复后由 `core/save.ts` 的既有 `sync*` 函数重建，
   不允许派生值覆盖权威。
4. 复合对象内部不拆分：`Company` 是原子聚合（现金/库存/设备/员工/计划/统计都在 `Company` 内），
   由 `company` 模块整体拥有；`equipment` 模块只拥有全局设备市场 `equipmentMarket`。
   这样避免“企业设备/现金在多个模块各存一份并分别恢复”。
5. `cities[]` 是复合载体：`world` 模块建立城市骨架并拥有身份/区域/通用统计字段，其他模块按
   `cityId` 恢复各自子对象（见 `cities[].*` 行）。

### 2.1 world 模块（`world`，v1，必需，最先恢复）

| 路径 | 性质 | 说明/消费者 |
|---|---|---|
| `seed` / `rngState` / `time` | 权威/配置 | rngState 在 tick 末一次性提交；time 唯一由 tick 推进 |
| `player`（含 roles/cash/holdings 镜像/note） | 权威 | `holdings` 为 securities 派生镜像，恢复后 `syncPlayerHoldings` |
| `cities[].id/name/englishName/tagline/color/region` | 配置 | 城市身份/地图 |
| `cities[].gdp` / `cities[].gdpHistory` | 派生缓存/展示历史 | 月结写入；展示与选举近 2 点读取，不参与破产判定 |
| `cities[].lastMonth` | 派生月报（被下月规则读取） | income/消费/公共工资等字段是下月 AI 与财政判断输入 |
| `cities[].technology` | 权威 | 政策可升级；生产读取 |
| `cities[].realEstate` | 配置占位 | 未来房地产模块接管（见 §4.1） |
| `history` / `log` / `notifications` | 展示历史 | 有上限；UI/权限过滤读取 |
| `lastTick` | 暂存 + 展示 | 上一 tick 结果快照；恢复后**不得重放**其 tick 内消费者（GDP/迁移只在同一 tick 内使用） |

### 2.2 population 模块（`population`，v1，必需，依赖 world）

| 路径 | 性质 | 说明 |
|---|---|---|
| `cities[].population` | 权威(total/laborForce) + 派生(employed 等) | 就业按岗位重算；不变量校验总量 |
| `cities[].publicSector` | 权威 | 公共部门招聘/工资 |
| `cities[].workforce` / `cities[].housing` | 权威 | 技能/培训与住房政策闭环 |
| `cities[].householdIncomeLastMonth` | 权威（下月投资分配输入） | 居民可投资资金上限读取 |
| `households`（groups/lastStats/investorFundingHistory/investorUsageHistory） | 权威现金 + 派生人数 | `groups[].lastMonth.income` 是下月消费预算输入，不可按展示历史裁剪 |
| `investors`（居民投资实体：现金/份额/风险/累计股息） | 权威 | 与 households 通过 investorLedger 关联；不是同一份数据的副本 |
| `householdFinance`（消费贷合同/预算快照） | 权威（独立账本） | 不并入 `banking.loans`；"居民债务"两个口径不可相加 |

### 2.3 company 模块（`company`，v1，必需，依赖 world）

| 路径 | 性质 | 说明 |
|---|---|---|
| `companies`（整个 `Company` 数组：现金/债务镜像/库存与账面成本/设备/员工/计划/AI/统计/初始设备/维护费快照/欠费） | 权威（`debt`/`totalShares`/`capacity` 为派生镜像） | 原子聚合，不拆到其他模块；恢复后 sync + 不变量 |
| `lifecycle`（foundings/liquidations/foundingMonth/next*） | 展示历史 + 序号计数权威 | **不得按展示历史裁剪**：累计创办上限读裁剪后数组当“终身”计数，见 §8.3 |

### 2.4 marketTrade 模块（`marketTrade`，v1，必需，依赖 world）

| 路径 | 性质 | 说明 |
|---|---|---|
| `cities[].market` | `price` 权威（跨 tick），其余每 tick 由 ledgers 重写 | 价格被生产/证券/授信/GDP 读取；月统计只作投影 |
| `tradeRoutes` | 配置 + 删除集 | 运行期只删不增；`distanceKm` 无读取点但保留（避免玩法/数据漂移） |
| `agreements` | 权威 | 参与方/条目允许终态悬空审计 |
| `transport`（links/intracity/pendingSales/lastMonth） | 权威网络 + 下月输入 | `lastMonth.intracity` 是下月配送效率/税收系数输入 |

### 2.5 equipment 模块（`equipment`，v1，必需，依赖 world）

`equipmentMarket`：initialStock/offers（权威）、lastMonthSold、pendingLedger/capitalizedThisTick
（tick 内暂存，落盘用于跨 tick 边界一致性）、maintenanceMonth/maintenanceHistory（月度服务流水，
历史治理可归档旧月）。企业设备本体在 `Company`（company 模块），此处只保留市场与委托。

### 2.6 banking 模块（`banking`，v1，必需，依赖 world）

| 路径 | 性质 | 说明 |
|---|---|---|
| `banking.deposits` / `banking.loans`（含 payments）/ next* | 权威 | 唯一银行账本；`company.debt` 是镜像；政府贷款不在本账本 |
| `banking.snapshots`（CreditSnapshot） | 派生缓存 | 规则只用每主体最新一条；历史治理保留最新+月度汇总 |
| `banking.lastMonth` | 派生统计 | 月内累计项（利息收入/发放）不可重算，需保存 |
| `householdFinance` | 权威（居民消费贷） | 归属见 §2.2（population）；banking 模块**不**拥有它，避免两本账 |

### 2.7 government 模块（`government`，v1，必需，依赖 world）

| 路径 | 性质 | 说明 |
|---|---|---|
| `cities[].treasury` | 权威（唯一政府现金） | 不存在政府存款副本 |
| `cities[].incomeTaxRate/corporateTaxRate/unemploymentBenefit/nonLaborTransfer` | 权威（政策可改） | |
| `cities[].fiscalExpenseBaseline` | 派生缓存（AI 发债分母） | |
| `cities[].government`（loans/payables/advances/records/bankruptcy/lastDebt/settledTicks…） | 权威 + 审计 + 派生 | 政府银行债务唯一权威在此；`lastDebt` 派生但被下月趋势读取 |
| `cities[].gdpWindow` | 权威（破产判定唯一口径，12 月） | 不得按展示历史裁剪 |
| `cities[].gdpEstimate` | 派生/说明 | 开局估计来源 |
| `cities[].bankruptcy` | 派生镜像 | 恢复时以 `government.bankruptcy` 为准 |
| `fiscal`（ledger + nextEntryId） | 审计流水 | 余额不在账本（余额 = city.treasury）；历史治理按月×城×kind 归档旧流水，**当月明细必须完整** |
| `taxes`（accrualByCity/historyByCity） | 权威本月 + 12 月历史 | 近 12 月税收是 AI 预算输入，不得裁剪 |
| `policies`（active/history/lastRuns/lastSelection/checkups/fundingMonths/publicJobsMonths） | 权威 + 规则窗口 + 展示 | checkups≥3 月/报告；fundingMonths 当月+回溯 1 月；publicJobsMonths 当月/上月；tracking.runs 上限内 |

### 2.8 bonds 模块（`bonds`，v1，必需，依赖 world）

`bonds.issuances`（条款/实售/回款汇总，`principal`=累计售出毛额）、`bonds.holdings`（逐持有人债权；
`principal≈units×faceValue`；active 未偿用于债务/GDP）、`bonds.payments`（兑付审计 + 同 tick 幂等键）、
三个 `next*Number`。恢复后对账：`interestPaid/principalRepaid` 与 payments 汇总一致（差异只允许历史
旧档缺省，按 0 处理并 warning）。

### 2.9 securities 模块（`securities`，v1，必需，依赖 world）

`securities.classes`（发行量权威）、`holdings`（持股权威；合计=发行量）、`orders`/`offers`（有效临时
委托，TTL 2 月）、`lastTrades`（易失展示）、`history`（月线 OHLCV，展示；退市保留 `exitedTick`）；
`governance`（boards/controls/motions：控制权与议案权威）。`company.totalShares`、`player.holdings`
为派生镜像，恢复后 sync。

### 2.10 management 模块（`management`，v1，必需，依赖 world）

`management`（operators + 履历/在职状态、playerOperations 授权与 standingPlan/proposals、nextOperatorNumber）。
经营者 `companyId` 为空/离职/null 合法；履历中公司可已退出（历史例外）。

### 2.11 politics 模块（`politics`，v1，必需，依赖 world）

`politics`（cities 的候选人/领导人/任期/选举计数 + elections 展示历史）、`cities[].politics`。
领导人必须属于候选人集合；选举历史可归档旧年份（展示摘要）。

## 3. 模块接口（`src/simulation/persistence/types.ts`）

```ts
interface SaveModule<TData> {
  id: SaveModuleId;               // 稳定 ID，注册后不可改名
  version: number;                // 模块数据版本（独立于顶层 formatVersion）
  required: boolean;              // 新格式缺失必需模块 = 损坏
  ownedPaths: readonly string[];  // 数据归属（注册表检查重复/祖先重叠）
  dependsOn?: readonly string[];  // 恢复顺序依赖（稳定拓扑排序；world 最先）
  export(ctx: SaveExportContext): TData;                    // 只读世界 → 纯数据
  validate(data, version): SaveModuleValidation;            // 不依赖运行时的形状/取值校验
  migrate(data, ctx: SaveModuleMigrationContext): TData;    // fromVersion=0 表示模块缺失
  restore(data, ctx: SaveRestoreContext): void;             // 只写自己字段进候选世界
  afterRestore?(ctx: SaveRestoreContext): void;             // 跨模块修复/轻校验
}
```

- 调用顺序（读取）：格式识别 → 顶层元信息 → 每模块 `validate`/`migrate` → 按依赖 `restore` →
  `afterRestore` → 跨模块引用校验 → 现有结构校验 → 既有 sync 修复 → 现有 `checkInvariants` →
  一次性返回候选世界。**候选世界在全部通过前不交给运行时。**
- 导出顺序按注册表顺序；导出必须只读、返回纯数据（不把运行时对象引用交出去）。
- `fromVersion = 0`：模块在新格式存档中缺失（旧档无此系统/未知可选模块）。必需模块执行 `migrate(0)`
  应抛错（缺必需模块=损坏）；可选模块在此实现“旧档初始化规则”，不能凭空编造资金/人口/贷款/股份。
- 模块版本高于当前游戏支持 → 拒绝加载（不得静默降级）；顶层 `formatVersion` 同上。

## 4. 新增系统接入（以房地产为例）

1. 在 `persistence/types.ts` 的 `SaveModuleId` 增加稳定 ID（如 `realEstate`），并声明 `ownedPaths`
   （例如 `cities[].realEstate`、`realEstate` 顶层状态）。
2. 新建 `src/simulation/persistence/modules/realEstateSave.ts`：`version=1`、`required=false`（若旧档
   可安全默认）或 `true`（若运行规则离不开），`dependsOn:['world']`，实现 export/validate/migrate/
   restore；`migrate(data, {fromVersion:0})` 用“旧档初始化规则”（新城市默认空资产/在建项目为空，
   不得改现金/人口/贷款）。
3. 在 `persistence/modules/index.ts` 注册；`world` 模块从 `cities[].realEstate` 的占位恢复中剥离
   （归属迁移：old `world` 字段改为 `realEstate` 模块 owned，版本升级在 `world` 模块 `migrate` 中
   把旧 `realEstate` 数据搬到新模块或标记忽略；顶层 `formatVersion` 视情况 +1）。
4. 更新 `docs/development/SAVE_SYSTEM_DESIGN.md` 归属表 + `tests/persistence/ownership` 测试。
5. 旧档兼容：老存档没有该模块 → 走第 3 步的初始化；新存档含该模块 → 正常恢复；未升级的旧游戏
   读到新存档会因未知**必需**模块拒绝（可选模块则保留数据）。

示例（不实现玩法）：`realEstate` 模块 ownedPaths = `['cities[].realEstate', 'realEstate']`，
data = `{ cities: [{id, realEstate}], projects: [] }`，restore 用 `context.cityOf(id)` 赋值。

## 5. 存档格式与迁移

### 5.1 v10 顶层格式（minified JSON，桌面再 gzip）

```json
{
  "formatVersion": 10,
  "kind": "lanwan-modules",
  "gameVersion": "1.6.1",
  "savedAt": "2026-11-07T00:00:00.000Z",
  "worldMeta": {"tick":72,"year":2032,"month":1,"randomState":123,"seed":20261101,"gameVersion":"1.6.1"},
  "modules": {
    "world":      {"version":1,"required":true,"data":{}},
    "population": {"version":1,"required":true,"data":{}},
    "company":    {"version":1,"required":true,"data":{}}
  },
  "preservedModules": {"futureOptional": {"version":3,"required":false,"data":{}}}
}
```

- `formatVersion` 与模块 `version` 分离；`kind` 交叉校验；模块顺序不敏感，恢复按依赖拓扑排序。
- 物理编码：无美化缩进的 UTF-8 JSON；桌面落盘再 gzip。读取按文件头识别：gzip 魔数 `1f 8b` →
  gunzip 后按 JSON 解析；否则必须是以 `{` 开头的明文 JSON；其他 → 明确“未知格式”错误（不猜测内容）。
- 旧单体存档（`formatVersion 1–9` + `world`）继续走 `core/save.ts` 既有迁移链（v1→…→v9、
  `normalizeLegacyV09World`、`normalizeInventoryCostWorld`），迁移成 WorldState 后再校验；
  读入旧档不立即改写文件，下次保存才写 v10（旧档保留备份 `.bak`）。

### 5.2 迁移规则

| 场景 | 行为 |
|---|---|
| 旧单体 1–9 | 既有迁移链 → WorldState → 业务继续；首次保存写 v10 |
| v10 缺必需模块 | 拒绝（不完整/损坏），当前世界不变 |
| v10 缺可选模块 | 调用该模块 `migrate(undefined, fromVersion=0)` 初始化；无法安全推断则拒绝 |
| v10 模块版本 < 当前 | 调用模块 `migrate` 链式升级（每模块自己处理字段变化） |
| v10 模块版本 > 当前 / 顶层版本 > 当前 | 拒绝并提示“需要更新版本的游戏”；不静默降级、不覆盖 |
| 未知必需模块 | 拒绝加载（保护存档，不丢弃模块后保存） |
| 未知可选模块 | 读取时原样保留到 `preservedModules`，重新保存时写回；若当前版本已接管同名模块则提示丢弃旧数据 |
| 结构/引用/不变量失败 | 拒绝；当前世界与原存档不变；候选世界丢弃 |

### 5.3 读取后修复规则与“开局份额”唯一初始化时点（v1.7 验收修复）

读档不是第二次模拟：**v10 模块化存档读取只做“候选世界重建 + 结构/引用/不变量校验 + 派生镜像同步”，
不得改写已保存的权威值**。读取后允许执行的修复仅限：

1. `syncCompanyTotalSharesSafe`：由 `securities.classes` 重算 `company.totalShares`、`player.holdings`
   镜像（派生字段，权威在证券模块；修复幂等）；
2. 随机种子合法性校验（不合法直接拒绝读取）。

**`investorLedger.openingShares`（居民投资实体“开局无主旧资产”起始份额）不在读档时预写。**
它的唯一初始化时点是**第一次月度结算中首次需要有效份额时**（`ensureInvestorOpeningShares` 在
股息归属/投资实体资金用途等确定性位置幂等调用，按城市一次性分配，之后不再重算）。原因：

- 起始份额 = 城市投资实体净资产（现金 + 持股估值）− 已有投入份额；净资产会随当月现金流变化；
- 若读档时提前计算，会用“读档时点”净资产，与直接推进时（tick 内稍后时点）计算的结果不同，
  导致同 rngState 下居民现金/股息/城市居民收入等后续结果分叉（v1.7 验收问题一）；
- 新开局（v1.4 语义）本身不预写该字段，读取时也不应“补写”一个保存时并不存在的值。

兼容规则：**旧单体存档（formatVersion 1–9）**仍保留既有的一次性补齐——旧档读取时调用
`ensureInvestorOpeningShares`（按城市幂等：任一群体已有合法值则同城其余补 0，不重算；从未初始化的
城市才按无主净资产分配），不重复分配、不增减现金、不覆盖已有份额。旧档首次保存为 v10 后该字段随
权威状态持久化，之后不再触发读取补齐。

回归覆盖：`tests/persistence/opening-shares-timing.test.ts`（tick 0 直接推进 vs 存档→读档→推进、
连续 6 tick 全量状态一致、中途读档不改变状态、旧档补齐幂等/不覆盖已有份额/不增减现金）。

## 6. 必须完整保留的数据（不得按历史裁剪）

- 时间/随机状态；全部城市与权威人口/财政；居民群体人数/职业/现金/存款/收入消费状态；
- 全部存续企业现金/所有权/设备/库存/员工/生产状态与决策输入（`previousMonth`/`salesHistory`/
  `recentProfits`/`productionPlan`/维护费快照与欠费）；
- 未结清/违约中贷款（银行与居民消费贷两本账）、未到期/待兑付债券与持有人、当前股票持仓/权益结构/
  有效订单；未完成设备挂单/清算权利；当前政策与剩余期限；
- 破产判定所需 12 月 GDP 窗口与开局估计；近 12 月税收历史；AI 预算检查所需的政策 checkups≥3 月/
  fundingMonths 当月+回溯 1 月/publicJobsMonths 当月+上月；
- 生产/价格/税收/AI 实际读取的历史窗口（见归属表）；
- 玩家身份/资金/企业控制权/进行中的决策；`lifecycle` 计数与展示历史（不得裁剪）；
- 任何影响下一次推进或恢复一致性的状态。

## 7. 历史记录保留与汇总规则

原则：先核对消费者再裁剪；只归档“只读历史/派生缓存”；不删除未结清义务、有效资产、规则窗口；
汇总必须有时间边界、字段、幂等键、守恒等式与 UI 展示规则。

| 数据 | 明细保留 | 汇总/归档 | 守恒与幂等 | UI 展示 |
|---|---|---|---|---|
| `banking.snapshots` | 每主体最新 1 条 | optional 月度汇总（limit/outstanding/主体数/按类别），≥120 月 | 归档月只汇总一次（幂等键 tick） | 借贷面板使用最新快照；历史只显示汇总 |
| 已结清银行贷款 | 最近 36 月明细（所有未结清/违约/有引用合同永久保留） | 按 年×借款人类别 汇总 count/principal/paidInterest/paidPrincipal | 幂等：已归档记录不再在明细中；Σ 聚合 = 归档前被删明细合计 | 贷款列表只显示明细；旧年份显示汇总卡片 |
| 已结清居民消费贷 | 同上 | 同上 | 同上 | 同上 |
| `fiscal.ledger` | 最近 36 月明细（当月必须完整） | 按 城市×年×kind 汇总 amount/count | 每 (city,kind,year) 汇总幂等；金额不涉及余额 | 财政流水列表显示近期；旧年份显示汇总 |
| `bonds.payments` | 最近 36 月明细 | 按 issuance×holder×年×kind 汇总 principalPaid/interestPaid | 幂等键同 tick 兑付；Σ 聚合 = 旧明细合计 | 持债/兑付历史显示汇总 |
| `securities.history` | 每类最近 120 月月线 | 更早按年 OHLCV（由真实月线计算；无成交月不生成 K 线） | 年度 OHLC 由该年月线首开/最高/最低/末收与成交量合计；重复汇总不重复 | K 线窗口显示月线；更早显示年度聚合 |
| `governance.motions`（已决）、`politics.elections` | 最近 12 月明细（任务书 §5.2.F“一年后聚合”） | 按年聚合（数量/结果摘要/得票） | 幂等键 year；只归档终态 | 当前与近年纪要显示明细；更早显示年度统计 |
| `equipmentMarket.maintenanceHistory` | 现有 **60 月上限**（`config.equipment.maintenanceHistoryMonths=60`，已 bounded；按 tick 幂等流水，用于服务商对账/审计） | 本轮**不额外归档**（未证明“更旧明细无审计价值”；60 月窗口已使增长有界） | 窗口由既有 sink 保证；服务商债权余额仍在各企业 `maintenanceArrears` | 维护费面板显示当前/近期；更早月份不显示 |
| `world.history/log/notifications` | 现有上限（240/160/120） | 保持现有裁剪（不额外归档；已 bounded） | — | 现有 UI 不变 |
| 城市趋势 `city.gdpHistory` | 现有 60 月上限（`economy.gdpHistoryMonths`） | 保持现有裁剪（不额外聚合；60 月窗口是规则/UI 需要） | — | 现有 UI/报告窗口 |
| 企业趋势 `company.salesHistory/recentProfits` | 现有小窗口（生产计划/奖金判定输入） | 不裁剪（规则输入，非展示历史） | — | 现有企业面板 |
| `lifecycle.foundings/liquidations` | **不归档**（见 §8.3） | — | — | 现有列表 |
| `city.gdpWindow`、`taxes.historyByCity`、`policies.checkups/fundingMonths/publicJobsMonths`、`groups[].lastMonth.income` 等 | 规则窗口，**不归档** | — | — | 现有 UI |

执行时机：**月度结算全部完成后的安全时点**（`Simulation.tick()` 末尾），作为游戏数据生命周期行为统一执行；
不在保存时修改世界。归档是幂等的（可重复执行不重复累计），且必须保证“直接继续推进”与“存档→读档→
继续推进”在相同随机状态与操作下结果一致（测试覆盖）。

## 8. 未知模块、版本与损坏处理

1. 未知必需模块：拒绝加载；保留原文件；提示需要更新游戏版本；禁止读后保存造成丢数据。
2. 未知可选模块：读取时原样保留（`preservedModules`），重新保存写回；若无法无损保留则拒绝。
3. 模块/顶层版本高于当前：拒绝加载与保存覆盖（不降级）。
4. 缺必需模块（v10）：视为损坏；与“旧版根本没有该系统”区分——后者由旧单体迁移链处理。
5. 损坏（JSON/gzip/结构/引用/不变量失败）：明确错误码与用户可读文案；候选世界丢弃；原文件保留。
6. 恢复失败绝不部分覆盖当前运行世界：读取先构造候选世界，全部校验通过后由 GameStore 一次性替换。

## 9. 一致快照、并发与失败恢复

- **一致快照**：保存入口在渲染层同步执行“模块 export + JSON 序列化”后才 await 平台写入；JS 单线程
  下 tick 不可能与快照交错，因此快照对应同一 tick。手动保存/自动保存共用同一入口。
- 不再深拷贝整个 WorldState：模块 export 返回新对象（纯数据），随后立即 minified 序列化；避免
  “deepClone + stringify”双份内存峰值。
- **锁与并发**：渲染层 `isSaving` 互斥（手动/自动保存串行，重复触发排队/跳过）；主进程对同一槽位
  写入串行化（队列/拒绝），不同槽位互不影响；写序 = temp → 备份轮换（hardlink/copy 到 `.bak.next`
  → 原子 rename 成 `.bak`）→ 原子 rename temp→主档。`.bak` 是上一版本并**保留**（单备份轮换，见 §10）；
  备份生成/替换/迁移/解压失败都不触碰原档。
- 失败恢复：释放锁、恢复自动运行/自动保存状态、明确 toast（“保存失败…；原存档未被修改”），不无限
  “正在保存”。自动存档写失败暂停自动写入并保留原档（区分“读损坏暂停”和“写失败暂停”）。
- 性能阶段测量：快照组装 / 序列化 / IPC 传输 / gzip / 落盘 / 读取解压 / 解析恢复分别测量并写入
  `scripts/save-size-report.ts` 与交付报告；是否引入 Worker 以实测为准（本轮不预设）。

## 10. 文件、压缩与大小口径

- 新存档：minified JSON；桌面 **gzip 落盘**；旧明文/旧 gzip 均可读；写统一 gzip；读取按魔数识别。
- 三层大小限制（显示口径必须写明）：
  1. 原始文本（未压缩 UTF-8）≤ **128 MiB**：渲染层预检 + 主进程校验，超限返回 `too-large`；
  2. 磁盘压缩文件 ≤ **64 MiB**：防异常文件（正常 gzip 远小于此）；
  3. 解压输出 ≤ **128 MiB**：gunzip `maxOutputLength` + 校验，防压缩炸弹。
  三处文案统一，不得界面提示与主进程口径不一致。128MiB 是可配置兜底值，实测内存峰值见交付报告；
  若实测表明不安全会调整并同步文档/常量/文案。
- 浏览器 localStorage：保存未压缩文本且容量通常 5–10MB，不能与桌面能力等同；超限明确报错并提示
  使用桌面版；本轮不扩展浏览器容量（报告中说明限制）。
- 写安全与备份（v1.7 验收修复，成功写入后**保留** `.bak`）：
  - 写序：先写 `${slot}.json.tmp-<pid>-<seq>` → 从当前主档生成“下一份备份”到
    `${slot}.json.bak.next-<pid>-<seq>`（同目录 hardlink 零拷贝；文件系统不支持时回退 copyFile）
    → 原子 rename 轮换为 `${slot}.json.bak` → 原子 rename temp→主档。主档替换使用 rename，
    不存在“主档缺失”窗口；**备份生成失败立即中止，主档与旧备份均不动**；替换失败时主档仍是旧版本，
    且 `.bak` 已与旧主档同内容（主/备至少一方完整可读）。
  - **成功覆盖后保留 `.bak` = 本次写入前的上一版本**（不删除；首次写入没有旧主档则不产生备份）。
    连续保存是“单备份轮换”：第 N 次成功后 `.bak`=第 N-1 版，更早版本被轮换掉；主档始终是最新。
    旧格式（v1–9）升级首次覆盖时，`.bak` 逐字节保留升级前旧明文，仍可按旧格式读取（`parseSave`）。
  - 中断恢复：主档缺失但 `.bak` 存在（旧替换算法在“主档→备份 / temp→主档”之间崩溃的窗口）时，
    `saves:read`/`saves:list` 回退到备份并标记 `recoveredFromBackup`；下一次写入先把备份恢复为主档
    再继续轮换。**除轮换替换与用户显式删除槽位外，绝不主动删除 `.bak`**。
  - 可读取性：`saves:read-backup` 返回备份的解码结果；`saves:list` 增加 `backupExists`（以及可选
    `recoveredFromBackup` 标记），不改变既有字段与 `size`（解压后原始字节）口径。
  - 失败/中断安全：所有失败路径清理 `.tmp-*` / `.bak.next-*`，不产生半成品 `.bak`；同槽位并发仍串行。
- 存档列表：兼容旧明文/旧 gzip/新 gzip；一项损坏不影响其他槽位；显示字段含 savedAt/gameVersion/
  formatVersion；`size` 口径为**原始数据大小**（解压后字节），另可显示压缩后文件大小，二者不得混淆。

## 11. 与任务书的差异/取舍（依据真实代码）

1. **Company 不拆分**：任务书允许“根据现有系统边界决定”；为避免企业现金/库存/设备/股份在多个模块
   各存一份，`company` 模块整体拥有 `Company[]`，`equipment` 模块只拥有 `equipmentMarket`。
2. **policies 归属 government**（ownership 分析 B 组的结论）；politics 模块只拥有世界/城市选举政治状态。
3. **city.lastMonth / city.gdp / gdpHistory** 归 world（通用城市报告/统计），`gdpWindow/gdpEstimate/
   fiscalExpenseBaseline/bankruptcy` 归 government（财政判定/破产口径）；依据见两份 ownership 报告。
4. **lifecycle 不归档**：`foundings/liquidations` 裁剪会改变“终身累计上限”语义，本轮保留并记录。
5. **股票月线目标 120 月**：当前实现上限 36 根/类；本轮按任务书目标放宽到 120 月 + 更早年度聚合，
   并验证 `investors` 近 6 月读取窗口与 UI 不受影响。
6. **`tradeRoutes.distanceKm` 无读取点**：保留持久化（避免破坏既有数据/潜在外部工具），不裁剪。
7. **`lastTick` 入档但恢复后不重放**：它是上一 tick 结果的展示快照；GDP/迁移等 tick 内消费者不会在
   读档后重新执行。
8. **旧档迁移链不删除**：`core/save.ts` 既有 v1–v9 迁移与校验保留，新格式在其后新增分支。

## 12. 实测性能与未解决问题

默认世界 seed 20261101、玩家无操作、默认 AI；v10 minified JSON + gzip level 6（详见
`scripts/save-size-report.ts` 与交付报告 §7）：

| tick | 原始字节 | gzip 字节 | serialize | parse | 不变量 |
|---|---|---|---|---|---|
| 12 | 6,154,159 | 485,132 | 1,464ms | 1,196ms | 0 |
| 36 | 14,481,803 | 1,164,287 | 491ms | 522ms | 0 |
| 72 | 19,284,439 | 1,396,179 | 1,519ms | 1,698ms | 0 |
| 120 | 21,531,933 | 1,330,152 | 661ms | 492ms | 0 |

- 历史治理前 72 月真实世界 v10 minified 约 18.39MB（旧 pretty v9 为 53.31MB）。
- 大载荷：70MiB 原始 v10 文档 parse 271ms、RSS 增量 71MiB（解析后总 RSS 477MiB）；
  130MiB 文本在渲染层预检被拒。128MiB 原始/解压上限在 2GB 容器中安全（实测远低于上限）。
- 一致快照：同步“模块 export + minified 序列化”，手动/自动保存共用；未引入 Worker
  （实测序列化 0.5–1.5s 为主线程开销，gzip 已异步；后续更大存档再评估）。
- 进程内存：12 月约 276MiB RSS；70MiB 大载荷约 477MiB RSS。

### 已知未解决/待决策

- `fiscal.ledger` 全局 800 条 FIFO 可能挤掉当月早段流水：需按实测月度条目数决定“按月保底”策略。
- 已结清消费贷悬空引用两处校验口径冲突（`referenceValidation` 放宽 vs `core/save.ts` 严格）：
  归档实现前必须统一（采用修复结构校验/放宽历史例外并在文档记录）。
- `Motion.proposedBy` 退市不清理但结构校验严格：需测试确认是否会读档失败并决定修复。
- 债券汇总（issuance.interestPaid/principalRepaid）与 payments 无对账：恢复时补对账或至少 warning。
- 政府贷款 id 前缀不一致（迁移 `gloan-` vs 运行期 `govloan-`）：只影响工具解析，不改数据。
- `lifecycle` 终身计数问题：本轮不归档；后续如需裁剪必须先新增终身计数器并迁移。
