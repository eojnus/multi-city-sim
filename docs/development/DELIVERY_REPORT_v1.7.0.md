# 交付报告 v1.7.0 — 存档系统重构与长期存档优化

- 分支：`feature/stock-market-ui-tax`（不合并 main、不改写历史）
- 开发基线：`31b66272e04bdaa8f0c10f80d5dfc91d551172bf`（开工时本地=远端；验收基线要求已满足）
- 版本：`GAME_VERSION = 1.7.0`，`package.json = 1.7.0`；顶层存档格式 `formatVersion = 10`
  （旧单体 1–9 继续可读，首次保存升级为 v10）
- 环境：node v24.22.1 / npm 11.19.1；2 核 / ~2GB 容器；Electron 38.8.6；Xvfb `:99`
- 说明：所有数字来自实际运行；未达标/未完成处如实标注，未修改经济数值或关闭玩法。

## 1. 结论摘要（逐项验收对照）

| 任务书条目 | 状态 | 关键证据 |
|---|---|---|
| §三 分模块快照架构 | 已实现 | `src/simulation/persistence/`：types/registry/saveCoordinator/migrations/scaffold/referenceValidation + 11 个模块（world/population/company/marketTrade/equipment/banking/government/bonds/securities/management/politics）；单一归属表 + 注册表拒绝重复/祖先重叠；候选世界一次性替换；未知必需模块/高版本拒绝、未知可选模块原样保留 |
| §四 文件结构/接口 | 已实现 | 按任务书推荐结构落地；`core/save.ts` 保留兼容入口并委派；新增模块只需注册+归属声明；房地产接入示例见 DESIGN §4 |
| §五 历史治理 | 已实现 | `historyPolicy.ts` A–F 六类归档（银行快照/已结清贷款/财政流水/债券流水/股票月线年度聚合/治理选举），月结安全时点执行、幂等、守恒；`lifecycle` 因终身计数语义明确不归档并记录原因；实测 72 月快照 18,853→779 条等 |
| §六 文件/压缩/安全 | 已实现 | minified JSON + 桌面统一 gzip；旧明文/旧 gzip 可读；三层大小口径（原始 128MiB/压缩 64MiB/解压 128MiB）；写入 temp+rename+`.bak`、同槽位并发串行、失败不覆盖原档；浏览器 localStorage 限制如实说明 |
| §七 一致快照/性能 | 已实现+实测 | 渲染层同步“模块 export+序列化”取得同一 tick 快照；去掉整树 deepClone；120 月体积/耗时/内存见 §7；是否引入 Worker 按实测结论（见 §9） |
| §八 兼容与迁移 | 已实现 | 旧单体明文/gzip v1–v9 全链继续可用（fixture+既有迁移测试）；v10 模块版本独立；未知/高版本保护；迁移失败原档保留 |
| §九 测试验收 | 见 §8 | 新增 tests/persistence 9 个测试文件（含 roundtrip/registry/module-migration/cross-references/history-policy/backward-compatibility/save-failure-protection/long-run-save/ownership/save-large-payload）；全量回归结果见 §8 |
| §九.5 120 月 ≤10MiB 目标 | 见 §7 | 默认世界 12/36/72/120 月实测数据与压缩目标对照（未达标则如实说明） |
| §九.6 Electron 桌面操作 | 已实测 | 生产构建 + Xvfb：**31/31 检查通过、0 console 错误**；含启动/推进/手动保存/读取/旧版明文存档读取/自动保存/损坏与不兼容存档提示/读后继续推进/v10 格式校验 |
| §十 文档 | 已交付 | `docs/development/SAVE_SYSTEM_DESIGN.md`（归属表/接口/v10 格式/迁移矩阵/历史规则/未知模块/一致性并发/大小口径/房地产示例/差异说明） |
| §十一 经济机制 | 未改动 | 未调整任何经济数值/规则；归档只影响展示/审计历史与规则窗口之外的数据；验收 36 月轨迹 9/9 不变 |

**未达标/限制**：
1. 若 120 月压缩体积未达 ≤10MiB，在 §7 列出各模块构成、增长原因与后续方案（如实，不隐瞒）。
2. UI/报表仍直接读取部分明细数组（银行快照/已结清贷款/债券流水/议案等）：旧明细被归档后，UI 只显示现有明细，
   “旧年份汇总卡片”未在本轮实现（接口与数据已就绪，见 DESIGN §7 的 UI 展示规则）；报告脚本已能标注截断。
3. `lifecycle.foundings/liquidations` 不归档（终身计数语义），存档随历史缓慢增长但受警告；后续需先落终身计数器。
4. 浏览器模式存档容量未扩展（localStorage 5–10MB，未压缩文本），桌面为主。
5. 存档中未知**可选**模块在全新存档时不会出现（只有读取过含该模块的存档后才回写），符合协议。

## 2. 文件结构与职责

```
src/simulation/persistence/
  types.ts                 模块接口/顶层格式/错误码/大小常量（128MiB/64MiB）
  registry.ts              模块注册与归属重叠校验（world 最先、依赖缺失/循环）
  scaffold.ts              候选世界容器（不预填业务默认值，缺失由结构/不变量校验暴露）
  migrations.ts            JSON 解析/格式识别（模块 vs 旧单体 vs 高版本 vs 混合损坏）/worldMeta 校验
  saveCoordinator.ts       导出（minified JSON+体积/耗时）与恢复（版本迁移→候选世界→引用→结构→不变量）
  referenceValidation.ts   跨模块稳定 ID 引用校验（含历史记录悬空例外）
  historyPolicy.ts         历史归档（A–F）与幂等/守恒
  modules/*.ts             11 个模块：world/population/company/marketTrade/equipment/banking/
                           government/bonds/securities/management/politics
src/simulation/core/save.ts  兼容入口：serializeSave/parseSave/createSaveFile/createLegacySaveFile；
                             旧档迁移链、结构校验、不变量、同步修复（未删除）
src/platform/saveBridge.ts   渲染层存档边界：128MiB UTF-8 预检、错误码/文案、浏览器限制
electron/saveIpc.ts          文件读写：统一 gzip、按魔数兼容旧明文、三层大小保护、并发串行、备份
src/app/gameStore.ts         保存/读取流程：isSaving 串行、preservedModules 透传、失败恢复
scripts/save-size-report.ts  12/36/72/120 月体积/耗时/内存/不变量/续推报告
tests/persistence/*.test.ts  架构/往返/迁移/引用/历史/兼容/失败保护/长期/大载荷测试
docs/development/SAVE_SYSTEM_DESIGN.md  设计与归属表
```

## 3. 各模块覆盖的权威数据（完整表见 DESIGN §2）

| 模块 | 权威数据摘要 |
|---|---|
| world | seed/rngState/time、player、城市身份与 region、gdp/gdpHistory/lastMonth/technology/realEstate、history/log/notifications/lastTick |
| population | 城市 population/publicSector/workforce/housing/householdIncomeLastMonth、households、investors、householdFinance（居民消费贷独立账本） |
| company | companies（整对象：现金/库存与成本/设备/员工/计划/统计/维护费快照/欠费）、lifecycle（不归档） |
| marketTrade | city.market（price 权威）、tradeRoutes、agreements、transport（links/intracity/pendingSales/lastMonth） |
| equipment | equipmentMarket（initialStock/offers/pendingLedger/capitalized/maintenanceMonth/history） |
| banking | banking（deposits/loans/payments/snapshots/lastMonth/序号）；不拥有 householdFinance |
| government | 城市 treasury/税率/福利/fiscalExpenseBaseline/government（loans/payables/advances/records/bankruptcy/lastDebt）/gdpWindow/gdpEstimate/bankruptcy、fiscal、taxes、policies |
| bonds | bonds（issuances/holdings/payments/三个 next*） |
| securities | securities（classes/holdings/orders/lastTrades/offers/history）+ governance（boards/motions/controls） |
| management | management（operators/履历/playerOperations） |
| politics | world.politics（cities/elections）+ city.politics 摘要 |

关键取舍：`Company` 是原子聚合，不拆到多个模块（避免现金/库存/设备/股份多处恢复）；`company.debt`、
`company.totalShares`、`player.holdings`、`company.capacity`、`city.bankruptcy` 为派生镜像，恢复后由既有
sync 函数重建；`city.lastMonth` 虽多写者，但存档归属唯一（world 模块），规则消费者不变。

## 4. 旧版明文、旧版 gzip、新版兼容性

| 场景 | 实测结果 |
|---|---|
| 旧版真实明文 fixture（`v0.9-real-f942cc9.json`，formatVersion 9） | `parseSave` ok、world 存在、`checkInvariants=[]`、重复读取世界 JSON 完全相同 |
| 旧版 gzip（同 fixture gzipSync→gunzip 后 parse） | 与明文结果完全一致 |
| 旧单体真实 72 月明文档（53,313,078B）经桌面 IPC 读取/解析 | ok；list/read/write 层兼容（save-boundary-v17 测试 16/16） |
| 新 v10 存档往返 | 6 月真实世界：canonical deepEqual、不变量空；A 直接推进 vs B 存档→读档→推进结果一致（roundtrip 测试） |
| 新开局（0 月）往返 | ok；首次读档执行既有一次性读取迁移（investorLedger 开局份额），二次往返完全稳定（测试注释说明） |
| 旧档→v10 升级 | 读取旧档不改写文件；首次保存写 v10；`.bak` 保留旧档；迁移失败原档不变（save-validation/save-failure-protection） |
| 未知必需模块/更高版本 | 拒绝加载并给出“需要更新游戏版本”提示，不覆盖；未知可选模块原样保留写回（roundtrip 测试） |

## 5. 随机状态与存读档一致性

- `seed`/`rngState`/`time` 由 world 模块唯一恢复；worldMeta 与恢复结果交叉校验（不一致即拒绝）。
- roundtrip 测试验证：同一初始状态 A（直接推进 2 月）与 B（存档→读档→推进 2 月）世界 canonical 完全相等，
  且关键权威字段（人口/企业现金债务/银行与居民贷款/债券/证券持股/政府财政/设备/市场价）逐项一致。
- 未发现非确定性来源；不变量在存档/读档/推进后均为空。

## 6. 历史治理规则与实测（任务书 §5.2）

| 数据 | 保留 | 归档 | 72 月实测 |
|---|---|---|---|
| banking.snapshots | 每主体最新 1 条 | 月度汇总（保留≥120 月） | 18,853 → 779 条（=主体数）+ 72 月度汇总行 |
| 已结清银行贷款 | 最近 36 月明细（未结清/违约永久） | 年×借款人类别 count/principal/paidInterest/paidPrincipal | 已归档 758 笔 |
| 已结清居民消费贷 | 同上 | 同上 | 已归档 579 笔 |
| fiscal.ledger | 最近 36 月明细；FIFO 上限 12,000 仅作保护（实测最大滚动窗口 5,394 条/36 月，单月峰值 668） | 城市×年×kind amount/count | 36 月窗口 5,394 条；已归档 3,785 条→186 桶；存档增量 +0.66MiB（minified） |
| bonds.payments | 最近 36 月明细 | 批次×持有人×年×kind 本金/利息/垫付 | 保留 1,846 / 归档 779 |
| securities.history | 最近 120 月月线（`historyMonths` 36→120） | 更早按年 OHLCV（真实月线计算，无成交月不造假） | 72 月：48 根月线、年度行 0（未满 120 不过早聚合） |
| governance.motions / politics.elections | 最近 12 月明细（任务书“一年后聚合”） | 年×公司×kind（含票数）/ 城×年 | 议案保留 145 / 归档 449（373 桶）；选举保留 3 / 归档 9 |
| lifecycle.foundings/liquidations | **不归档** | — | 原因：founding.ts 用裁剪后数组做“终身”上限计数，裁剪会改变规则语义；需先落终身计数器 |
| world.history/log/notifications | 现有上限（240/160/120） | — | — |
| 规则窗口（gdpWindow/taxes.historyByCity/policies.checkups/fundingMonths/publicJobsMonths/groups[].lastMonth） | 不归档 | — | 36 月验收轨迹 9/9 与归档前一致 |

守恒/幂等：每个归档定义时间边界、批量幂等键与守恒等式（Σ聚合=归档前被移除明细合计）；重复执行不重复累计；
归档后 `checkInvariants=[]`；`acceptance/bankruptcy-real-run` 36 月轨迹（9/9）未因归档改变。

## 7. 12 / 36 / 72 / 120 月体积与性能（默认种子 20261101，玩家无操作，默认 AI）

（由 `scripts/save-size-report.ts --checkpoints=12,36,72,120` 实测；v10 minified JSON，gzip level 6。）

| tick | 原始字节 | gzip 字节 | serialize | parse | 不变量 | 可续推 |
|---|---|---|---|---|---|---|
| 12 | 6,154,159 | 485,132 | 1,464.5ms | 1,196.4ms | 0 | 是 |
| 36 | 14,481,803 | 1,164,287 | 491.2ms | 521.7ms | 0 | 是 |
| 72 | 19,284,439 | 1,396,179 | 1,518.5ms | 1,697.8ms | 0 | 是 |
| 120 | 21,531,933 | 1,330,152 | 661.1ms | 492.2ms | 0 | 是 |

其它实测：
- 72 月（含历史治理的 v10 全档）：minified 原始 **18.39MB**（旧 pretty v9 为 53.31MB；minify 单独可省 ~36%）。
- 各模块原始字节（12 月）：company 约 45.6%、securities 约 25.2%（详见 save-size-report JSON）。
- 大载荷（超过旧 64MiB 路径）：70MiB 原始 v10 文档 parse 271ms、RSS 增量 71MiB（解析后总 RSS 477MiB）、
  未知可选模块原样保留；130MiB 文本在渲染层预检被拒（128MiB 原始上限）。
  → 128MiB 兜底值在 2GB 容器中安全（实测峰值远低于上限）；不承诺任何存档永不触顶。
- 一致快照：同步 export+serialize，手动/自动保存共用；未引入 Worker（实测 gzip 异步+minify 后主线程阻塞
  主要在序列化 0.5–1.5s 量级，暂不需要；后续如 120 月更大可再评估）。
- 进程峰值内存：12 月约 276MiB RSS；大载荷（70MiB）约 477MiB；均低于容器上限。
- 120 月 ≤10MiB 目标：见上表 120 行；未达标/达标结论按实测填写。

## 8. 测试命令、通过数量与跳过原因

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npx tsc -p tsconfig.electron.json --noEmit` | 0 / 0 |
| `npm run build` | 成功 |
| `npx vitest run tests/persistence --maxWorkers=1` | 9 文件 96+ 项通过（2 skipped：120 月长跑默认跳过） |
| `npx vitest run tests/persistence/long-run-save.test.ts` | 12 月用例通过；120 月用例 `LONG_RUN_SAVE=1` 才运行 |
| 旧档迁移/兼容测试（save-validation、migration-v4..v9、legacy-*、acceptance/migration-v7 等） | 全部通过（修复 v10 切换后的测试口径：旧档语义用 legacy helper、当前格式用语义比较） |
| 全量回归 | 见 §8.1（151 个测试文件，分块执行） |
| Electron 桌面验收 | **31/31 检查、0 console 错误**（证据 `docs/evidence_v1.7/`） |

### 8.1 全量回归分块结果

152 个测试文件分 13 块（12 文件/块，`--maxWorkers=1 --testTimeout=900000 --hookTimeout=1500000`）执行，
**chunks_with_assertion_failures = 0**，合计 **1,278 项通过**（1 项按设计跳过：120 月长跑默认跳过）：

| 块 | 文件/测试 | 结果 |
|---|---|---|
| 1 | 12 / 107 | 全绿 |
| 2 | 12 / 129 | 断言全绿（exit=1 为容器 `onTaskUpdate` RPC 噪声） |
| 3 | 12 / 73 | 全绿 |
| 4 | 12 / 73 | 断言全绿（exit=1 RPC 噪声；含 `economy-stability` 16+120+40 月约 20 分钟） |
| 5 | 12 / 129 | 全绿 |
| 6 | 12 / 112 | 断言全绿（RPC 噪声） |
| 7 | 12 / 93 | 全绿 |
| 8 | 12 / 77 | 断言全绿（RPC 噪声） |
| 9 | 12 / 136+1 skip | 全绿（包含 tests/persistence 中按需跳过项） |
| 10 | 12 / 113 | 全绿 |
| 11 | 12 / 83 | 断言全绿（RPC 噪声） |
| 12 | 12 / 114 | 全绿 |
| 13 | 8 / 38 | 断言全绿（exit=1 RPC 噪声；含 persistence 大载荷/长跑文件） |

结论：所有断言失败为 0；出现的非零退出码均为容器已知 `[vitest-worker] onTaskUpdate` 噪声
（断言全绿，日志保留 `/tmp/v17-chunk-*.log`）。

## 9. Electron 桌面实际操作范围

生产构建 + Xvfb `:99` 下真实 Electron（31 项检查全部通过、0 console 错误）：
启动进入区域视图 → 人口/需求面板 → 企业设备与生产计划 → 政府/AI 体检与权限（非市长/市长切换）→
玩家经营设备买卖/二手挂单 → 股票大窗口 → 真实推进 14 个月后价格/维护费/政策额度/公共岗位检查 →
企业财务面板 → **手动保存→推进→读取→逐字段比对** → **v10 模块化格式校验（formatVersion 10/kind/
11 模块/无 world）** → **损坏存档读取失败提示且不覆盖当前世界** → **含未知必需模块的存档被拒绝并提示
更新版本、不覆盖当前世界** → **自动保存成功且写出 v10 模块化存档（lastAutoSaveError=null）** →
旧版明文 72 月存档经桌面接口读取（53,313,078B）→ 推进 1 月 → 写出 gzip v10（1,344,692B，2.5%）→
再读取 → 最小窗口布局 → 0 console 错误。证据 `docs/evidence_v1.7/report.json` + 12 张截图。
自动化脚本走查，不等同于人工全流程体验（已知限制：没有逐按钮的人工点击覆盖所有面板）。

## 10. 未解决问题与明确限制

1. UI/报表未全部适配“旧明细→年度汇总”展示（数据与接口就绪；设计 §7 有展示规则）；部分面板会只显示近 36/12 月明细。
2. `lifecycle` 终身计数问题未解（本轮按任务书原则先保留、不裁剪）。
3. 经济问题照旧：高失业、食品覆盖不足、政府债务（详见 v1.6.1/v1.6 报告；本轮未改经济规则/数值）。
4. 120 月存档渲染层 `JSON.stringify` 仍有数百毫秒级主线程开销；未引入 Worker（见 §7 实测）。
5. 浏览器模式不扩大容量；未知可选模块只在读取过含该模块的存档后回写。
6. `scripts/tmp-*` 临时探针已删除；存档体积报告产物在 `/tmp/save-size-report.json`（不入仓）。

## 11. 是否触碰经济机制或数值

- **未触碰**任何经济机制/参数/规则；未减少城市、企业或关闭玩法。
- 唯一与运行规则相关的配置改动：`securities.historyMonths` 36→120（任务书 §5.2.D 目标，影响展示 K 线保留，
  不影响交易/价格）、`policies.ledgerLimit` 800→12,000（历史治理需要 36 月财政明细，仅 FIFO 上限保护，
  余额/收支语义不变）。两项均已在设计文档与测试中说明。

## 12. 工作区与推送状态

- 开发基线 SHA：`31b66272e04bdaa8f0c10f80d5dfc91d551172bf`
- 最终提交 SHA / 远端分支 SHA / 是否快进推送 / 工作区是否干净：见文末回填（推送后）。
