# 交付报告 v0.4：居民阶层 · 经营者与选任 · 独立银行

日期：2026-11-02 ｜ 工作区：`/workspace/Coding/multi-city-sim`（本机为 Linux 容器）
分支：`feature/population-management-banking` ｜ 开发起点：`d091196`（= 远程 `origin/main`，开工时无 `develop` 分支）
最终提交：见本报告所在提交（本报告随最终整理提交一起提交，提交号可用 `git log --oneline -1` 查看）。

> 本报告只记录**实际执行过**的验证。文中【暂定】的数值、公式与流程均为可替换原型，不是用户已确认的最终规则；用户已确认的规则单独标注。

## 1. 运行方法（Windows 桌面版）

```powershell
cd <本仓库路径>
npm install
npm run typecheck      # 渲染层 + Electron 主进程类型检查
npm test               # Vitest 全部测试
npm run build          # 类型检查 + Vite 构建 + Electron 主进程编译
npm start              # 启动已构建的桌面应用
# 开发模式：npm run dev
npm run smoke          # 桌面冒烟（需先 build，使用隔离 userData）
npm run sim:report     # 既有机制报告
npx tsx scripts/v04-report.ts 36   # v0.4 代表性模拟报告（本报告第 8 节数据来源）
```

存档槽位：`autosave`、`manual-1`、`manual-2`、`manual-3`；格式版本 `5`，游戏版本 `0.5.0`。

## 2. 三大系统实际完成的功能

### A. 居民职业、财富差异与阶层统计

- 新增 `world.households`：每城 7 个职业群体（管理/生产/销售/研发/公共部门/失业/非劳动力），群体人数由城市人口与企业岗位**派生**，每期重算；不创建逐人实体，一个人只统计一次。
- 每个群体持有可追溯的**手头现金**（`group.cash`）与**银行存款**（`world.banking.deposits` 的 household 账户）；股票权益复用既有 `securities` 账本，按本城人口比例归属本城居民投资实体净资产。
- 收入、个税、福利、股息返还、消费、储蓄全部按群体记账：工资按企业实际支付额与岗位角色拆分；个税按城市既有口径计算后按工资比例分摊；消费预算 = min(收入 × 消费倾向, 群体现金)，区分“想要购买/有效需求/实际成交”；储蓄是真实转账（群体现金 → 居民投资实体）。
- 招聘、裁员、自然变动、跨城迁移时，群体人数与资产按人均转移（迁移者带走人均现金与存款），不复制资金、不丢失资产、不产生负人口。
- 界面：城市人口面板新增“居民阶层”区（职业人数、低/中/高财富阶层人数占比与人均资产、人均收入、统计口径说明）。

### B. 经营者、人才市场、企业选任与玩家经营模式

- 新增 `world.management.operators`：经营者档案（姓名、风格、声望、任职企业、任期、任职历史）。初始世界按确定性规则为每家企业配在任经营者，并**沿用企业原有 `ai.style`**，避免迁移后行为突变。
- 企业经营风格改为由**现任经营者**决定（`currentStyle`，无经营者时回退 `company.ai.style`），风格继续影响利用率、岗位、投资与定价决策，且仍受资金/劳动力/库存/产能/治理约束。
- 选任：企业通常 3 名候选人（有现任 = 现任 + 2；无现任 = 3）；优先从人才市场取，不足时确定性生成（受 `maxNewPerElection` 限制）；候选人固定于议案创建时，玩家可在投票期登记加入；沿用治理模块的**登记日投票权快照**与既有议案生命周期；多候选人计票，得票最多者当选，平票优先现任，无现任平票按 candidateId 字典序；任期 24 个月；任期届满、职位空缺或严重经营问题触发选任，并有冷却避免每月重复议案；落选者回人才市场。
- 玩家持有有投票权股份即可参选；AI 经营者同一时间只能经营一家企业，玩家可同时经营多家。
- 玩家经营模式：手动（持续经营计划，直到修改或到期）/ AI 辅助（日常自动，重大事项生成提案待批准）/ 高度托管（授权范围内自动执行，超范围生成提案）。每家企业的模式与授权独立；未批准不执行；拒绝后同一去重键在冷却期内不重复；需要股东表决的事项（如股息政策）批准后仍走治理议案。
- 界面：企业详情新增“经营者与经营模式”区（现任/风格/任期/选任候选人/投票/模式/授权/持续计划/待处理提案）；城市面板新增人才市场区。

### C. 独立银行系统

- 新增 `world.banking`：存款账户、贷款合同、授信快照与月度统计；`company.debt` 降级为**银行贷款未偿本金的派生镜像**（`syncCompanyDebt` 唯一写入方）。
- 存款：活期月息 0.10%，按月计息入账；玩家可存取款。
- 贷款产品：企业周转 0.50%/24 月、企业扩张 0.60%/36 月、玩家个人 0.60%/24 月；等额本金、按结算前剩余本金计息、首期从放款后下一月开始、最后一期处理尾差、允许提前还款且不收费用。
- 授信：个人 = 可核验净资产（现金 + 存款 + 股票权益 − 未偿）× 50%；企业 = max(0, 现金 + 库存价值 + 产能资产 − 企业债务) × 50%；同一主体全部贷款共享额度，可借 = max(0, 额度 − 当前未偿)；每月基于上一完整月数据生成快照，当月稳定，新增本金立即占用额度。刻意**不使用**每股 1 信用点下限，避免授信虚高。
- 还款：先息后本；逾期宽限 1 个月，第 2 个月仍欠付标记违约（不加罚息、不自动借新还旧）；企业清算时由银行按合同顺序受偿，剩余债务减免留痕。
- 旧 `company.debt` 在 v5 迁移中承接为 `migratedDebt` 合同（本金不变、不清零、不重复计息、幂等）。
- 界面：城市面板新增银行区（存款、授信、贷款、应还、欠款/逾期、申请与提前还款入口、口径说明）。

### 与原系统的联动

- 财政：个税/福利/公共工资/股息返还按群体入账；财政流水仍逐条记录。
- 证券/治理：居民与玩家持股、分红、表决、董事会、融资要约全部沿用既有权威，不复制第二套持股。
- 企业生命周期：新企业下一期自动获得经营者；倒闭时先偿还银行贷款、释放经营者、清理控制权与玩家经营记录。
- 交通/协议/政策：跨城交易融资改走银行；居民跨城购买退款按人口比例计入群体现金；政策补贴仍按既有路径进入企业/居民。

## 3. 新增/调整模块与数据权威

| 数据 | 权威 | 说明 |
| --- | --- | --- |
| 城市人口 `total/employed/unemployed/nonLabor/laborForce` | `city.population` | 语义未变；P=E+U+N 与 E=Σ雇主仍是硬不变量 |
| 居民群体人数 | 由人口 + 公共部门 + 企业岗位角色派生 | 不另存人口，不重复计数 |
| 居民群体现金 | `world.households.groups[].cash` | 手头现金 |
| 居民银行存款 | `world.banking.deposits`（owner.kind='household'） | 不在群体上复制镜像 |
| 居民股票权益 | `world.securities`（居民投资实体持股） | 群体按人口比例归属实体净资产（暂定口径） |
| 企业现金/库存/产能 | `company` 既有字段 | 贷款不改变归属 |
| 企业债务 | `world.banking.loans` | `company.debt` 仅派生镜像 |
| 经营者任职 | `world.management.operators` + `world.governance.controls` | 档案与治理控制权分离 |
| 选任议案/投票 | `world.governance.motions`（kind='operatorElection'，新增 `candidates` 字段） | 复用登记日快照与既有议案生命周期 |
| 玩家经营模式/授权/提案 | `world.management.playerOperations` | UI 只发命令 |
| 存款/贷款/利息/逾期 | `world.banking` | 银行唯一写入方 |

新增文件：`src/simulation/population/household-groups.ts`、`household-economy.ts`、`src/simulation/management/{types,manager-pool,elections,operations}.ts`、`src/simulation/banking/{types,credit,banking,settlement}.ts`、`scripts/v04-report.ts`、测试 4 个、文档 2 个。
修改：`contracts/types.ts`（v5 类型）、`data/config.ts`（households/management/banking 段）、`core/{initializer,simulation,save,invariants}.ts`、`corporate-governance/governance.ts`、`companies/{planning,ai/strategy,lifecycle/lifecycle,credit}.ts`、`finance/finance.ts`、`government/fiscal.ts`、`investors/investors.ts`、`markets/consumer.ts`、`population/population.ts`、`production/production.ts`、`trade/trade.ts`、`app/gameStore.ts`、UI 三文件、README、package.json。

## 4. 本次自行选择的暂定参数（全部集中在 `src/data/config.ts`）

| 项目 | 暂定值 | 说明 |
| --- | --- | --- |
| 居民群体 | 每城 7 类职业；阶层阈值 人均总资产 15,000 / 60,000 | 低/中/高 |
| 初始财富 | 管理 18、生产 6、销售 5、研发 7、公共 5、失业 2、非劳动力 3 个月群体收入；55% 存银行 | **仅新世界注入**；旧档迁移不造钱 |
| 消费倾向 | 96%，且不超过群体现金 | 与既有 consumer.propensity 一致 |
| 经营者 | 任期 24 月、每次 3 名候选人、每城初始空闲人才 5 名（另为每家企业配在任经营者）、池上限 12 名、每次选任最多新生成 2 人 | 人才池超限时按声望/入职时间确定性淘汰并留痕 |
| 严重经营问题 | 连续亏损 ≥ 4 月、现金 < 0.5 月工资、经营 ≥ 6 月、同一企业冷却 6 月 | 与既有倒闭判定口径对齐 |
| 重大事项阈值 | 投资 30 万、招聘 5 人、贷款 20 万、调价 5% | 超过才需玩家批准 |
| 玩家默认授权 | 投资 50 万/月、招聘 8 人/月、贷款 30 万、投资/招聘/贷款/调价全开 | 高度托管默认值 |
| 手动计划有效期 | 12 个月 | 到期需玩家重新设定 |
| 银行利率 | 存款 0.10%/月；周转 0.50%/24 月；扩张 0.60%/36 月；个人 0.60%/24 月 | 用户已确定的首版数值 |
| 授信 | 基准 × 50% − 未偿；个人 = 净资产，企业 = 非负账面股权 | 用户已确定；刻意保守的双重约束 |
| 逾期 | 宽限 1 月，第 2 月违约，不罚息，不收提前还款费 | 用户已确定 |
| 旧债务 | 迁移为 12 期承接贷款，利率 0.50%，本金 = 原 `company.debt` | 不重复计息、不清零 |
| 自动流动性借款（v0.5 起） | 企业现金不足发薪/采购时，按可借额度自动借入周转贷款；**每笔借款独立合同、独立期限与首期**，不再并入旧合同（避免旧合同到期提前收新本金） | 仍受同一额度限制，不是借新还旧；每笔可在贷款卡片中单独查看 |

## 5. 存档版本与迁移

- `SAVE_FORMAT_VERSION = 5`（v0.5 未改格式）、`GAME_VERSION = '0.5.0'`、`package.json 0.5.0`。v0.4.0 写出的存档可直接读取。
- 迁移链 v1 → v2 → v3 → v4 → **v5** 全部保留；`parseSave` 按 `formatVersion` 逐跳迁移，`migratedFrom` 记录最老源版本。
- v5 迁移内容：补齐 `world.households`（现金/存款为 0，不造钱）、`world.management`（确定性生成经营者，沿用原 `company.ai.style`）、`world.banking`（空账本 + 旧债务承接）、`CompanyControl` 新字段（`operatorId/termEndTick/basis='election'`）、`Motion.candidates`；迁移后重算阶层统计。
- 校验：`validateWorldStructure` 新增 households/management/banking 校验（结构、引用、数值、枚举、候选人与选票一致性）；`checkInvariants` 新增三类检查（群体人数合计 = 城市人口、群体现金流闭合、经营者无双任职、贷款未偿 = 本金 − 已还、企业债务镜像 = 贷款未偿）。
- **无法保证的部分**：仓库内没有真实历史 v1–v4 存档文件，迁移用结构忠实的降级存档验证（见 `tests/migration-v4.test.ts`、`tests/migration-v5.test.ts`、`tests/legacy-save-files.test.ts`）；用户机器上可能存在的特殊旧数据未逐一验证。旧档迁移后居民现金/存款为 0，财富主要来自投资实体权益归属。

## 6. 实际执行的验证

> 以下命令均在本机实际执行（Linux 容器，Node v24，仓库根 `multi-city-sim/`）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run typecheck` | 通过（渲染层 + Electron 主进程，0 错误） |
| 2 | `npm run build` | 通过（Vite 构建 + Electron 主进程编译；仅提示 renderer chunk > 500 kB，属既有告警） |
| 3 | `npx vitest run` | **30 个测试文件 / 247 项全部通过** |
| 4 | `npx vitest run tests/banking.test.ts` | 23 项通过 |
| 5 | `npx vitest run tests/management.test.ts` | 25 项通过 |
| 6 | `npx vitest run tests/households.test.ts tests/migration-v5.test.ts` | 23 项通过（households 14、migration-v5 9） |
| 7 | `npx vitest run tests/ui-panels.test.ts` | 9 项通过 |
| 8 | `./dev-desktop.sh smoke`（Xvfb + Electron `--no-sandbox`） | 退出码 0；生成 8 张截图到 `artifacts/`；自动存档暂停/恢复、旧存档迁移、小窗口溢出等既有断言通过；截图可见新「居民阶层与职业群体」区块 |
| 9 | 桌面机制冒烟 `scripts/mechanisms-smoke.cjs`（Xvfb） | 退出码 0；4 张截图；存档格式断言读取真实文件得到 `fileFormatVersion 5`、`fileGameVersion 0.4.0`、`ok: true` |
| 10 | `npx tsx scripts/v04-report.ts 36` | 完成 36 个月模拟，末期不变量通过（数据见第 7 节） |
| 11 | v0.5 `npx tsc --noEmit` | 通过（0 错误） |
| 12 | v0.5 `npm run build` | 通过（同上，仅既有 chunk 体积告警） |
| 13 | v0.5 `npx vitest run` | **37 个测试文件 / 291 项全部通过**（2026-11-02 实测） |
| 14 | v0.5 桌面逐项验收 `scripts/acceptance-desktop.cjs`（Xvfb + Electron，隔离 userData） | **18/18 项通过，0 条控制台错误**；截图 `artifacts/acceptance-*.png`，结果 JSON `artifacts/desktop-acceptance.json` |
| 15 | v0.5 存档往返（桌面第 8 组 + `tests/save-validation.test.ts`） | 保存→推进→读取后时间/现金/存款/贷款/债务一致；运行数月后的存档（含已退出企业的终态协议记录）可正常读回 |

**基线回归**：既有 26 个测试文件在本次改动后全部保持通过；其中 5 个既有测试按新口径更新了断言，原因均为本次机制变化（不是放宽断言）：
- `tests/trade-atomic.test.ts`：旧“按工资额度”信贷 → 新“账面股权 50% − 未偿”银行授信；融资断言改为“存在 workingCapital 贷款合同且债务镜像一致”。
- `tests/transport-refund.test.ts`：资金不足用例改为用承接贷款把授信压到 0（银行是债务唯一权威）。
- `tests/lifecycle.test.ts`：清算/倒闭判定用例改为先建立银行承接贷款，再断言偿还与减免。
- `tests/economy-stability.test.ts`：120 期长期用例显式放宽超时（世界规模扩大导致耗时上升，不是失败）。
- `tests/save-format-script.test.ts`：游戏版本断言由硬编码 `0.3.0` 改为读取 `GAME_VERSION`。

**新增测试覆盖（对应任务书第十四节）**：
- 初始阶层人口与城市总人口一致、职业人数派生、阶层统计口径（`households`）。
- 招聘/裁员/迁移时人口与资产不重复、不消失、合计守恒（`households`）。
- 收入入账闭合、消费受现金约束、储蓄真实转账（`households`）。
- 不同经营者风格影响实际经营、AI 经营者不得双任职、玩家可经营多家（`management`）。
- 3 人候选规则、登记日快照、投票与平票（现任优先 / 无现任字典序）、任期触发不重复（`management`）。
- 玩家 AI 辅助提案未批准不执行、批准后执行、拒绝后冷却（`management`）。
- 市值/财产额度、贷款立即占用额度、还款释放额度、借款不虚增额度（`banking`）。
- 存款/取款/计息/还款/逾期账目一致、旧债务迁移不重复计息、清算受偿（`banking`）。
- v4→v5 迁移不造钱、旧债承接、经营者风格保留、未来版本拒绝、损坏存档保护、文件字节不变（`migration-v5`）。
- 存档往返保留居民群体/经营者/银行状态（`households`、`migration-v5`）。
- 固定种子 + 相同操作产生完全一致的世界（`economy-stability`、`households`）。

**未执行/不可执行**：
- Windows 本机打包（`npm run package`）未执行：需要联网下载 electron-builder 资源，本机未验证。
- 真实历史 v1–v4 存档：仓库内不存在，迁移用结构忠实的降级存档验证；验收方如有真实旧档，可直接调用 `parseSave` 复验。

## 7. 代表性模拟结果（`npx tsx scripts/v04-report.ts 36`，种子 20261101）

36 个月后（第 36 期，2029 年 1 月），末期 `checkInvariants` 为空：

**居民阶层（人数合计 = 城市总人口）**

| 城市 | 人口 | 群体现金 | 存款 | 人均收入 | 低/中/高阶层人数（人均资产） |
| --- | --- | --- | --- | --- | --- |
| 岚港 | 120,813 | 17.32 亿 | 7.30 亿 | 556 | 74,904 (11,898) / 33,280 (36,424) / 12,629 (110,744) |
| 铁谷 | 86,627 | 7.70 亿 | 5.32 亿 | 247 | 53,709 (5,061) / 26,469 (30,047) / 6,449 (89,039) |
| 青原 | 64,599 | 9.80 亿 | 4.30 亿 | 455 | 0 / 53,630 (24,662) / 10,969 (75,703) |

**经营者与选任**：经营者档案 57 名（在职 37、人才市场 20）；选任议案累计 58 个（通过 53）；18 家企业的现任风格已与“企业原始风格”不同（说明换人后经营倾向确实改变）。

**银行**：存款账户 21 个，存款余额 16.92 亿；贷款合同 46 笔（未结清 41、曾违约 30），未偿本金 1.44 亿；本月发放本金 694 万、收回本金 725 万、贷款利息收入 49 万、存款利息支出 169 万。

**企业授信额度与月工资对照（债务最高的 6 家）**

| 企业 | 月工资 | 债务 | 授信额度 | 额度/月工资 | 当前可借 |
| --- | --- | --- | --- | --- | --- |
| 岚港成衣厂 | 1,353.8 万 | 8,334 万 | 1.839 亿 | 13.6 个月 | 1.006 亿 |
| 岚港能源公司 | 277.4 万 | 1,983 万 | 1,983 万 | 7.2 个月 | 0 |
| 铁谷纺织二厂 | 393.3 万 | 1,585 万 | 1,184 万 | 3.0 个月 | 0 |
| 铁谷金属厂 | 716.2 万 | 1,229 万 | 1,229 万 | 1.7 个月 | 0 |
| 青原日用品厂 | 787.5 万 | 376 万 | 5,509 万 | 7.0 个月 | 5,133 万 |
| 岚港日用品厂 | 1,109.1 万 | 357 万 | 2,347 万 | 2.1 个月 | 1,990 万 |

**玩家**：现金 200 万，存款 0，个人授信额度 100 万，可借 100 万。

**观察到的异常与解释（不做无根据的调参）**：
1. **违约比例偏高**：46 笔合同中 30 笔曾违约（多数仍继续计息并尝试收款）。原因是长期薄利企业在现金不足时按已确认的“财产/市值额度”规则自动借入周转贷款（未加用户尚未决定的额外偿债能力审批），债务与月供叠加后容易欠付。这是需要架构师决定的边界（见第 8 节）。
2. **青原城的“低财富阶层”人数为 0**：该城各职业群体的人均总资产（含按人口比例归属的居民投资实体权益）都高于中档阈值；阶层是按**群体人均**划分的，不是逐人分布，因此单个职业群体整体跨过阈值时会出现整档为空。这是首版聚合口径的已知粗糙点。
3. **存款远大于贷款**：居民初始财富中 55% 存入银行（仅新世界注入），叠加存款利息净增加货币量，导致存款规模持续变大；这是“银行资金无限 + 存款计息”的既定定位，未做央行冲销。
4. **货币总量随存款利息净增加**：本月存款利息支出 169 万即净增货币量；不影响不变量校验，但长期通胀效应未调参。

## 8. 未完成事项、已知问题与需要总架构师决策的边界

1. **自动流动性借款的债务压力**：企业长期薄利时，按月自动借入周转贷款会形成债务累积；模拟中观察到较高比例的违约合同（详见第 7 节）。用户尚未决定是否加入“偿债能力审批”，本版按已确认规则**未加额外门槛**。是否收紧自动借款、缩短周转期限或加入审批，需架构师决定。
2. **居民股票权益归属口径**：首版按本城人口比例归属居民投资实体净资产，不区分各群体自己的投资组合与投资偏好；如需更细的群体投资组合，需要新增契约。
3. **财富阶层阈值与初始财富**：均为演示参数，未做长期平衡；初始财富仅新世界注入。
4. **银行资金无限导致货币净增加**：存款利息支出（月 0.1%）会净增加货币量；这是用户已确定的定位，未做央行冲销，长期通胀效应未调参。
5. **选任细节**：候选人“通常 3 名”在市场人才不足时可能少于 3 名（受 `maxNewPerElection` 限制）；空缺企业有 2 个 tick 的选任窗口期，期间由 `currentStyle` 回退风格继续经营。
6. **人才池淘汰**：契约中经营者状态只有 `employed/available`，超限淘汰时从名录移除并在 history/world.log 留痕（未新增 `retired` 状态）。
7. **旧信贷模块**：`src/simulation/companies/credit.ts` 已标记废弃、生产代码无调用方（仅测试用于构造“额度耗尽”场景）。
8. **桌面 GUI 验证**：本机为 root + 无显示器容器，使用 `dev-desktop.sh`（Xvfb + `--no-sandbox`）运行；GUI 冒烟的实际执行情况见第 9 节。
9. **未实现（按任务书明确排除）**：银行破产/挤兑/央行、政府借款与担保、完整公司法/银行监管/破产法院、房地产开发、地图扩张、逐人居民实体。

## 9. 界面入口与操作方式

- **居民阶层**：进入任一城市 → 右侧面板「居民阶层与职业群体」区（`data-testid="population-strata-section"`），展示职业人数、阶层占比与人均资产、统计口径说明。
- **人才市场**：城市面板「人才市场」区（`data-testid="talent-market-section"`），展示空闲经营者的姓名、风格、声望与上一段任职；其他企业现任经营者不在名单内。
- **银行**：城市面板「银行」区（`data-testid="bank-section"`），玩家可存取款、申请个人贷款、提前还款；选中同城企业时展示企业授信、贷款与还款入口；显示额度口径与逾期宽限说明。
- **经营者与选任**：企业详情「经营者与经营模式」区（`data-testid="company-operator"`），展示现任/风格/剩余任期/选任候选人/投票与登记入口、三种经营模式切换、授权三档预设、持续经营计划表单、待批准提案的批准/拒绝按钮。
- 操作结果都会通过既有 toast、通知与自动存档反馈；未批准提案不会执行，无投票权股东不会看到投票入口。

## 10. 验证记录索引

验证命令与结果见第 6 节；代表性模拟见第 7 节。

## 11. 对外部验收最有价值的文件与入口

- 设计记录：`docs/development/IMPLEMENTATION_PLAN_v0.4.md`（数据权威、月度顺序、暂定参数）
- 核心模块：`src/simulation/population/household-groups.ts`、`household-economy.ts`、`src/simulation/management/`、`src/simulation/banking/`
- 结算顺序：`src/simulation/core/simulation.ts`（`tick()` 内注释编号）
- 存档迁移：`src/simulation/core/save.ts`（`migrateWorldV4ToV5`）
- 不变量：`src/simulation/core/invariants.ts`（`checkHouseholds/checkManagement/checkBanking`）
- 配置：`src/data/config.ts` 的 `households`、`management`、`banking` 段
- 测试：`tests/households.test.ts`、`tests/migration-v5.test.ts`、`tests/banking.test.ts`、`tests/management.test.ts`、`tests/ui-panels.test.ts`
- 界面入口：城市面板（居民阶层、人才市场、银行）、企业详情（经营者与经营模式）
- 模拟报告脚本：`scripts/v04-report.ts`

---

# 12. v0.5 验收修复记录（2026-11-02）

本节记录总架构师验收后的 7 项问题修复、第 9 节贷款压力复核、第 10 节 Electron 桌面逐项验证与第 11 节回归结果。基线为分支 `feature/population-management-banking` 的提交 `24365e32cf10d4d660e4484e1addca8aecf65e3f`（与远程同名分支一致，工作区干净）。

## 12.1 修复前基线

- 分支：`feature/population-management-banking`；基线提交：`24365e3`。
- 问题复现与根因均在基线代码上确认，修复期间未合并 `main`、未 force push、未删除既有功能。

## 12.2 逐项修复

### 问题 1：经营权限（贷款/还款）

- **根因**：`src/app/gameStore.ts` 的 `takeLoan`/`repayBankLoan` 直接调用银行 `openLoan`/`repayLoan`，没有任何经营权校验；实测无经营权的岚港食品厂可借 1000，债务 0 → 1000。
- **修复**：
  - 新建 `src/simulation/management/financing.ts`：`playerOpenLoan`（个人贷款仅限本人；企业贷款需 `canOperate`，持有股票不等于经营权；`migratedDebt` 不允许玩家发起）与 `playerRepayBankLoan`（企业贷款需经营权）。
  - `gameStore.ts` 的命令改为调用上述领域入口，实现“命令层 + 领域入口”双重校验；失败时现金/贷款/债务/存档/通知零变化。
  - `bankView()` 的 company 增加 `canOperate`；`panels.ts` 对无经营权企业显示 `bank-company-no-operator` 提示并隐藏企业贷款/还款按钮。UI 隐藏只是提示，业务校验仍在领域层。
  - 银行内部 AI 企业的自动融资仍直接走 `drawWorkingCapital`，不受玩家命令校验影响（区分“系统内部合法决策”）。
- **测试**：`tests/loan-permissions.test.ts`（6 项：无经营权借款/还款失败且世界序列化前后一致、授权后可借可还、个人贷款、AI 内部放款、主体类型错配拒绝）。

### 问题 2：自动贷款绕过经营授权

- **根因**：发薪（`finance.ts` 的 `ensureCompanyLiquidity`）、生产采购（`production.ts` 成交后补流动性）、跨城进口（`trade.ts`）直接 `drawWorkingCapital`，完全绕开玩家经营模式、授权额度与提案。
- **修复**：
  - `operations.ts` 新增 `requestAutomaticLoan`（`AutomaticLoanDecision`）统一裁决：非玩家经营企业直接允许；`manual` 一律拒绝（采购受限/欠薪照旧并写 warning 解释）；`!auth.allowLoan` 拒绝；近期拒绝/过期提案在冷却期（`proposalCooldownMonths`）内拒绝；额度 = min(需求, 实时可借)；自动上限在 `assisted` 为 `majorThresholds.loanAmount - 0.01`、`delegated` 为 `auth.maxLoanAmount`，超出则只生成待批准提案（不先借后报）。
  - `financing.planCompanyWorkingCapital` 只裁决不放款，`drawPlannedWorkingCapital` 在成交前放款；`finance/production/trade` 全部改为“先裁决/先放款，再执行采购/进口”，避免部分成交与绕过。
  - `decideProposal` 批准贷款后 `openLoan`，并在合同 note 标记来源（玩家指令/玩家批准提案/托管授权内自动/自动流动性批次）。
- **测试**：`tests/loan-authorizations.test.ts`（8 项：manual 不举债、assisted 小额自动/超阈值提案、delegated 授权上限、allowLoan=false、拒绝后冷却、AI 自动融资、发薪/采购手动模式不举债且有解释日志）。

### 问题 3：并入旧合同导致提前到期

- **根因**：`banking.drawWorkingCapital` 把新借款并入同企业已有 `active` 周转合同，并重算 `monthlyPrincipal = principal / termMonths`；旧合同进入末期时按全部 `outstanding` 收款，导致第 23 期追加 2400 后第 24 期要求还 2500。
- **修复**：`drawWorkingCapital` 改为每笔借款通过 `issueLoan` 生成**独立合同**（独立 `startTick/nextDueTick/termMonths/principal/monthlyPrincipal`，首期下月），note 前缀 `自动流动性批次（第 N 期）`；额度仍由同一 `availableCredit` 共享占用与释放，旧合同到期不会提前收新本金。
- **测试**：`tests/loan-batches.test.ts`（4 项：旧贷第 23 期追加后两份合同各自期限、旧合同末期只收自身未偿、同月多次追加、提前还款不影响新合同、各笔按自身未偿计息且 Σ未偿 == `company.debt`）。

### 问题 4：职业工资无差异

- **根因**：`company.monthlyWageBill = round2(employees × wageRate)` 使用单一工资率；`splitCityHouseholdIncome` 按岗位人数等比分企业实发工资，同企业各职业人均工资相同。
- **修复**：`config.labor.occupationWageMultipliers`（管理 1.6 / 研发 1.35 / 销售 1.15 / 生产 0.95，按初始岗位权重加权约 +4.6%，理由与口径写在 config 注释）；`company.ts` 新增 `WAGE_ROLES`、`occupationWageRate(company, occupation, config)`、`companyWageBill(company, config)`，`monthlyWageBill(company, config?)` 兼容旧调用；策略、授信、生命周期、初始化、投资实体的工资调用点全部传 config；工资成本、居民收入、个税与消费均随职业工资率变化。`splitCityHouseholdIncome` 第 1 段改为按“岗位人数 × 职业工资率”权重用最大余数法拆分实发工资（欠薪时按实发总额定比，舍入尾差可对账）。
- **测试**：`tests/occupation-wages.test.ts`（4 项：同企业不同职业人均工资不同、企业实发 = 各职业实收之和、税与资金转移对账、公共部门/失业/非劳动力口径不变）。

### 问题 5：全城统一消费预算

- **根因**：`consumer.runConsumerMarket` 先用全城预算（`cityHouseholdBudget`）统一缩放购买，再在 `recordHouseholdConsumption` 按群体现金比例分摊支出，导致富群体替穷群体买单、每群体支出可能超过自身可用资金。
- **修复**：逐群体结算——每个群体用自己的 `householdGroupBudget = min(月收入 × 消费倾向, 群体现金)`；按人均预算升序处理；逐商品先本地 `applyConsumerDemand`，不足再 `executeIntercityPurchase({ consumer: true, householdGroupId })`；每群体成交后用 `recordGroupConsumption` 只扣自身现金并记录消费/未满足需求；全城字段为各群体之和（`ConsumerResult.byGroup`）。退款链路：`PendingIntercitySale.householdGroupId` → 运输结算按群体聚合 `{total, byGroup}` → `applyHouseholdIncome` 按实际购买群体归属（无 groupId 的旧记录按人口兜底）。缺货时只按实际成交扣款。
- **测试**：`tests/consumption-groups.test.ts`（6 项：零现金组隔离、预算/现金上限与账目闭合、缺货不扣款、退款归属、人口兜底、固定种子复现）；另更新 `tests/transport-refund.test.ts` 与 `tests/households.test.ts` 中与新口径不一致的旧断言（不是放宽，见 12.6）。

### 问题 6：人才池超限删人

- **根因**：`management/manager-pool.ts` 的 `pruneOperatorPool` 在 available 超过 `maxPoolPerCity` 时直接从 `state.operators` 过滤删除经营者档案，落选者无法再被聘用。
- **修复**：不再删除任何档案与履历；超出建议规模时只写一条去重提示日志（“保留全部现有档案并暂停新增；落选者仍可被其他企业聘用”）。控量改为：`electionCandidates` 优先复用同城 available 池，排除在任/已用/他案提名，新建候选受 `maxNewPerElection` 与剩余容量限制；池满时允许候选人不足仍开选任（界面可见候选人数量）。
- **测试**：`tests/pool-retention.test.ts`（7 项：超限不删人、落选者可参加后续选任、在任 AI 不作为空闲候选、选任期间候选人固定、池满仍可运行等）；`tests/management.test.ts` 对应断言同步更新。

### 问题 7：迁移丢存款

- **根因**：`household-groups.rebalanceHouseholdWealthForMigration` 直接从源群体扣现金与存款，但目标账户不存在时 `addDepositBalance` 静默 return，导致源扣款、目标不入账（复现：2,970,000 → 1,485,000）。
- **修复**：新增 `ensureGroupDepositAccount`，迁移前先确保目标群体存款账户存在；`addDepositBalance` 返回 boolean；迁移采用“先建账户、再原子转出/转入”，任一失败则存款留在原群体（不销毁）。按迁移人口中 `laborForceMoved` 与非劳动力部分分别从源城的 unemployed / nonLabor 群体按人均资产转移，目标城对应群体入账（可解释的群体分配）。`syncHouseholdPeople` 的招聘/裁员/自然变化路径改为两阶段提交（先预建目标账户，失败则保留原群体）。迁移函数返回 `{cashMoved, depositMoved, transferred}` 供审计。
- **测试**：`tests/migration-accounts.test.ts`（7 项：目标无账户时存款守恒、旧存档迁移、跨城现金+存款守恒、反复迁移、非劳动力分摊、sync 路径等）。股票权益：居民投资实体权益仍按本城人口比例归属，**不随迁移转移**（本轮未实现、也未假装实现，见 12.6）。

### 补充修复：运行数月后的存档无法读回

- **发现方式**：第 10 节桌面验证第 8 组“保存 → 推进 → 读取”实测 `loadSlot` 返回 false；用 `parseSave` 复现得到 `协议 agreement-3 的参与企业无效`。
- **根因**：企业倒闭时协议被标记为 `declined`/`failed`/`fulfilled` 留作审计，但 `validateWorldStructure` 要求协议参与方与条目的企业 ID 必须仍然存在，导致有企业退出的存档无法读回（既有问题，v0.5 验收的存档往返会触发）。
- **修复**：终态记录放宽——`participants[].decision === 'declined'` 与 `items[].status ∈ {fulfilled, failed, declined}` 允许引用已退出企业；未终结的引用仍然拒绝。历史审计保留，不清空。
- **测试**：`tests/save-validation.test.ts` 新增 2 项（终态允许 + 未终结拒绝），并验证往返后记录仍在。

## 12.3 存档与版本

- `SAVE_FORMAT_VERSION = 5`（本轮未改结构）；`GAME_VERSION = '0.5.0'`；`package.json`/`package-lock.json` 0.5.0。
- v0.4.0 的 v5 存档可直接读取（无迁移）；v4 及更早仍走 v4 → v5 迁移链，迁移规则未变。
- 银行每笔自动流动性借款现在是独立合同，旧存档中的合并合同仍按原期限正常偿还（迁移不静默改旧本金）。

## 12.4 第 10 节 Electron 桌面逐项验证（实际执行）

执行环境：Linux 容器 + Xvfb `:99`（1600×1000）+ Electron 38（`--no-sandbox`），脚本 `scripts/acceptance-desktop.cjs` 使用隔离 `userData`（`artifacts/desktop-acceptance-user-data`），不触碰真实存档；真实 DOM 点击 + 同一命令层，结果写入 `artifacts/desktop-acceptance.json`。

| # | 操作 | 结果 |
| --- | --- | --- |
| ① | 启动 → 区域 → 进入岚港 → 人口阶层区块 | 通过；`population-strata-section` 存在，含“阶层/职业” |
| ② | 职业收入 / 阶层 / 消费数据 | 通过；7 个职业群体收入各不相同（管理 19,186,141 / 生产 109,429,472 / 销售 17,346,774 / 研发 12,173,742 / 公共 18,603,512 / 失业 2,391,162 / 非劳动力 15,531,219）；三档阶层 low 77,792 人 / middle 39,257 / high 2,980；岚港当月消费 106,339,563.71 |
| ③ | 未经营企业不能贷款/还款 | 通过；界面显示“你没有该企业的经营权…”且无企业贷款/还款按钮；命令层调用失败，债务 0 → 0、贷款合同数不变，toast 含“经营权” |
| ④ | 合法经营权企业切换三种模式 | 通过（测试前置授予经营权后）：manual / assisted / delegated 均通过界面按钮切换成功 |
| ⑤ | 需授权的贷款提案：批准前不生效、批准后生效 | 通过；assisted 模式制造资金缺口后生成待批准提案 32,031,565.88，批准前债务 0、贷款 0；批准后债务 32,031,565.88 |
| ⑥ | 经营者选任：候选人 / 登记参选 / 投票 / 计票 | 通过；界面显示 3 名 AI 候选人，玩家登记参选并投 500 股；投票期结束后议案 `passed`，结果“孙星河 当选（得票最多）…玩家 500 股”（测试前置：脚本按二级市场规则外注入 500 股，真实路径是在交易界面买入） |
| ⑦ | 存款 / 取款 / 个人贷款 / 还款 | 通过；存 500,000 → 存款 500,000；取 200,000 → 存款 300,000；个人贷 100,000；提前还 50,000 后未偿 50,000、已还本金 50,000 |
| ⑧ | 保存 → 推进 → 读取 | 通过；`manual-1` 保存后推进 1 月再读取，时间/现金/存款/贷款数/债务全部恢复一致 |
| ⑨ | 控制台错误、按钮可达性、小窗口 | 通过；0 条控制台错误；54 个 `data-action` 元素均带有效动作、无零尺寸/隐藏按钮；1100×700 窗口无横向溢出 |

截图：`artifacts/acceptance-01-region.png` … `acceptance-09-small-window.png`；JSON：`artifacts/desktop-acceptance.json`（18/18 项通过、0 错误）。

说明：桌面脚本用“测试前置”直接写入经营权与 500 股投票权（选任获胜/二级市场买入不在本轮 7 项修复范围内），其余操作都通过真实命令层；脚本注释与结果 JSON 均标注了该前置。

**Windows 桌面复验步骤**（本机为无显示容器，未在 Windows 上手工点击）：

1. `npm install` → `npm run build` → `npm run start`（Windows 版入口 `npm run dist`/`package` 需联网下载 electron-builder 资源，本机未验证）。
2. 区域视图点岚港 → 进入城市，右侧确认「居民阶层与职业群体」与「银行」区块。
3. 点选未经营的企业（如岚港食品厂）→ 银行区块应提示无经营权且无企业贷款按钮；尝试通过控制台命令也不应改变债务。
4. 通过选任获胜或交易界面取得经营权后，切换 manual/assisted/delegated，观察提案与贷款行为。
5. 在 assisted 模式下把企业现金压低（或运行到资金紧张），确认出现“待批准”贷款提案；批准前债务不变，批准后生效。
6. 观察选任议案候选人、登记参选与投票按钮、投票期结束后的结果日志。
7. 银行区块做存款/取款/个人贷款/还款；保存到槽位后推进 1 个月再读取，确认状态一致；查看开发者工具 Console 是否报错。

## 12.5 第 9 节贷款结构与偿债压力复核

固定种子 20261101、36 个月（`npx tsx scripts/v04-report.ts 36`），v0.5 数据：

| 指标 | v0.4.0（修复前口径） | v0.5（每笔独立合同） |
| --- | --- | --- |
| 贷款合同数 | 46 | 217（自动流动性批次 217；平均期限 24.0 月） |
| 未偿本金 | 1.44 亿 | 1.664 亿 |
| 未结清 | 41 | 210（active 72 + defaulted 138） |
| 曾逾期/欠款 | 30 | 142 |
| 借款人层面出现违约合同的企业 | 未单独统计 | 23 家（共 37 家）；违约合同未偿 1.046 亿，占全部未偿 62.9% |
| 企业清算 | 未列 | 7 次；银行实收 2,575，减免 1.093 亿（减免未计入实收还款） |
| 全部未结清合同下月应还本息 | 未列 | 约 3,975 万 |

**口径说明**：合同数从 46 增至 217 主要是“每笔自动补缺都是独立合同”的计数放大（问题 3 要求的修复），不代表借款总量等比例增加；借款人层面（23/37 家企业有违约合同、62.9% 未偿属违约合同）更能反映压力。

**原因分析（未改已确认规则）**：
1. 自动流动性只补工资/采购缺口，不改善盈利；长期薄利企业持续以新合同滚动短期债务。
2. 授信按账面权益（`companyEquityBase`）计算，亏损企业账面权益仍可能为正，额度未反映偿债能力。
3. 用户尚未确定“贷款审批是否看偿债能力/现金流”，因此没有加入该规则（避免把暂定规则当已确认玩法）。
4. 违约后合同继续计息并尝试收款，企业仍可在剩余额度内经营，违约状态更易累积。
5. 清算减免计入 `paidPrincipal` 但不计入 `principalRepaid`，报告中单独列出，避免被误读为实收还款。

**建议（需用户/架构师确认后再改规则）**：
- 授信额度加入偿债能力系数（如利息覆盖倍数、连续亏损月数），或对已违约企业暂停新增自动流动性、只允许提案。
- 更早触发经营者选任/重组，或引入明确的债务重组规则（当前不自动借新还旧）。
- 若希望缓解“存款利息净增货币”，需引入央行/财政冲销（用户已确定银行资金无限，未扩展）。

## 12.6 未解决项与已知边界

- 偿债压力偏高（见 12.5），本轮只报告与建议，未修改用户未确认的审批规则。
- 财富阶层按“群体人均财富”聚合，仍存在粗糙点（青原 middle 0 人、high 38.0%，因为该城群体人均分布集中）；这是统计口径问题，不是资金守恒问题。
- 居民投资实体股票权益不随人口迁移转移（按本城人口比例归属），本轮如实报告，未假装实现。
- 桌面验证在 Xvfb + 隔离 userData 下完成；Windows 真实 GUI 与打包（`npm run package`）未执行，需联网资源。
- 选任/持股在桌面脚本中用测试前置；真实“赢得选任”路径需多数股权，未在桌面完整走通。
- 市长选举、政党、政府贷款、央行、银行破产仍未实现（用户未确认，不做扩展）。
- 更新了两个既有测试的口径（`transport-refund` 的下期预算改为 Σ 群体预算；`households` 的跨城退款由“第 3 个月必现”改为 12 个月窗口内出现一次），原因是逐群体预算使跨城补货规模下降，机制本身已被新测试覆盖，不是放宽断言。

## 12.7 修复前后提交

- 修复前基线：`24365e32cf10d4d660e4484e1addca8aecf65e3f`（远程同名分支一致）。
- 问题 1/2/3：`c457614`。
- 问题 4/5/6/7：`435bdf4`。
- 存档终态记录修复 + 验证脚本：`b944b38`。
- 文档与版本（本节）：见分支 `feature/population-management-banking` 的 HEAD 提交。
- 推送：同一 feature 分支，未合并 `main`、未 force push。
