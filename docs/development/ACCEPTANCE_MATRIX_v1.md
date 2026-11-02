# 验收矩阵 v1 — 经济与财政系统

- 版本：v1（终稿；交付前最后一轮已执行，结果见 §1.7 与 `ACCEPTANCE_RESULTS_v0.7.md`）
- 基线：规划时 `9cef5b5`（v0.6.0，`SAVE_FORMAT_VERSION = 6`）；**最终验收基线 `b85cc0f`**（公开破产面板；qa merge `3177f39`）
- 工作区：`project/wt/qa`，分支 `qa/acceptance`
- 依据：`briefs/Game3_Combined_Brief.md` §八（验证与交付标准）、`briefs/SUPPLEMENT_ARCHITECT_v1.md`、`briefs/DECISIONS_v1.md`、`TEAM_RULES.md`
- 口径优先级：补充指令 > 合并版任务书 > `DECISIONS_v1` > 仓库 `docs/design/GAME_DESIGN_DISCUSSIONS.md`（仅背景）
- 状态说明：`待执行` = 依赖块0冻结/实现落地；`已执行→通过` / `已执行→红（实现未落地）` / `已执行→红（实现有 bug）` = 本轮真实跑过的 UTC 用例结果；`部分通过` = 矩阵条目存在未覆盖子项。执行命令见 §1.2。

---

## 0. 文档依据与冻结口径摘要

| 事项 | 冻结口径 | 依据 |
| --- | --- | --- |
| 债券面额 | 1,000 信用点/份，整数份，1 份起，无半份 | SUPP §4.1–4.2 |
| 发行与成交 | 发行计划与实际成交分开记账；只有成交份数形成本金 | SUPP §4.3；DECISIONS #4 |
| 跨城购买 | 玩家 / 居民投资实体 / 企业可买其他城市债券，用各自实际可用资金 | SUPP §4.4 |
| 企业购债 | 禁止新增贷款购债、禁止认购时自动申请贷款；不要求资金溯源；禁止“先贷款再认购”绕过 | SUPP §5；DECISIONS #5 |
| 债券期限/利率 | 36 个游戏月；年利率 4%（暂定），每满 12 个月付一次（暂定） | Brief §4.2 |
| 到期兑付 | 政府资金不足时银行无条件垫付，持有人第 36 月足额收款，垫付转政府贷款 | Brief §4.1.3 |
| 破产阈值 | 政府总负债 ≥ 本市最近 12 个月 GDP 合计的 100%；GDP 合计下限按 max(1, 合计) | Brief §4.1.4；SUPP §6.6 |
| 破产时点 | 判定当月结算内立即触发重选，过渡期现任市长看守（暂定） | DECISIONS #7 |
| 破产兑付 | 未到期债券本金立即兑付；提前兑付利息按持有月份计提未付部分 | Brief §4.2 |
| 债务勾销 | 原有政府银行贷款 + 垫付形成的贷款一并勾销，不得重复兑付/重复计债 | Brief §4.1.5 |
| 同月到期+破产 | 各债权只付一次，先兑付后勾销 | Brief §4.1.5、§4.2 月结顺序 |
| 分股·有 CEO | 政府股份全部转给现任 CEO（玩家或 AI），保留权利类别，发行总量不变 | Brief §4.1.6 |
| 分股·无 CEO | 除破产政府外现有股东按**主体数量**平分，余数按固定顺序；其他政府算一个主体 | Brief §4.1.6 |
| 无股东兜底 | 无表决权托管持股保存，不销毁不增发（暂定） | Brief §4.2 |
| 消费公式 | 参考额 = 上月实际可支配收入×80% + 当时手头现金×5%；预算 = min(现金, max(0, 参考额)) | Brief §5.1 |
| 消费时点 | 只用手头现金；银行存款不自动纳入；上月收入不再次入账 | Brief §5.1 |
| 居民贷款 | 额度由个人财产决定，非无限；无资产无抵押信用默认关闭（可配置开关） | Brief §5.2 |
| 居民贷款口径 | 贷款是真实债务不是收入；供给不足不得借出无法成交的多余资金 | Brief §5.2 |
| 开局 GDP | 12 个月同值估计；口径 = 产出价值 − 中间投入（不含工资/贷款/财政）；理论产量×80%（可配置）；真实 GDP 逐月从最早替换；最小年 GDP 判定值 1 | SUPP §6；DECISIONS #6 |
| 旧档负财政余额 | 等额转为银行本金，财政余额归零，禁止额外发钱；一次性、可测试、报告列明 | Brief §三；DECISIONS #6 相关 |
| 存档版本 | v6 → v7（待块0冻结确认目标版本号） | 本矩阵假设 |
| 权限 | 非市长可见 5 类 / 不可见 6 类；A 城市长只见 A 城；换任立即重校验；公开投资信息不得附带计划总额/总售额/总债务 | SUPP §7；DECISIONS #9 |
| 桌面验收 | 接受 Linux 无头 Xvfb + Electron 截图，注明环境与分辨率局限 | DECISIONS #10 |
| 交付 | 不推 main；有权限推功能分支，无权限交本地分支 + 完整 SHA + bundle/patch | SUPP §3；DECISIONS #3 |

> 备注（已确认）：秘书处口径中的“居民消费四层分账”按任务书 §5.2 的需求分层落实为：
> ① 期望需求（desired）→ ② 资金支持后的有效需求（受现金与预算约束，affordable/effective）→ ③ 实际成交（sold）→ ④ 缺口分解（资金不足 vs 供给不足）。金额不得跨层重复计入。
> **钉死**：预算公式 `min(手头现金, 上月可支配收入×80% + 手头现金×5%)` 中只有“手头现金”可动用，银行存款与其他资产不参与预算、不得复制到手头（见 AC-D01/D07）。

---

## 1. 基线状态（已执行）

执行环境：`project/wt/qa`（分支 `qa/acceptance`），`HOME`/`npm_config_cache` 按 TEAM_RULES §3 设置，时间 2026-11-02。

| 检查项 | 命令 | 实际结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 退出码 0，无错误 |
| 全量单测 | `npx vitest run` | 退出码 0，**40 个测试文件 / 306 个用例全部通过** |
| 构建 | `npm run build` | 退出码 0，renderer + electron 构建成功 |

证据：完整日志 `/tmp/qa-baseline.log`（本次环境临时文件；需要长期留档时复制到 `artifacts/baseline-9cef5b5/`）。
结论：`9cef5b5` 基线干净，306 用例为后续回归的下限基线；后续每次集成复验必须 ≥306 且无新增失败。

### 1.1 修复前泄漏证据（已执行，2026-11-02）

用现有 Electron 无头流程采集修复前证据，脚本 `scripts/acceptance-leaks-before.cjs`（QA 脚本，不改产品代码）：
`Xvfb :99 -screen 0 1600x1000x24` + `electron --no-sandbox --disable-dev-shm-usage`，窗口 1440×900，默认非市长（`roles.mayorCityId = null`，城市视图可见“参选市长（6.0 万）”按钮）。

| 证据 | 文件 | 内容 |
| --- | --- | --- |
| L0 | `artifacts/qa-before/01-region-default.png` | 区域初始视图（默认 population 图层） |
| L1 | `artifacts/qa-before/02-city-card-lanport-treasury.png` | 城市卡片显示“财政 6000.0 万”（岚港） |
| L2 | `artifacts/qa-before/03-region-map-economy-hint.png` | 经济图层地图节点文字“GDP 0 · 财政 6000.0 万”（Phaser text 对象读取，非 DOM） |
| L3 | `artifacts/qa-before/04-city-overview-fiscal-kpi.png` | 城市概况 KPI“财政 6000.0 万” |
| L4 | `artifacts/qa-before/05-government-fiscal-ledger.png`、`05b-government-section-clip.png` | 政府与政策：财政流水明细（个税/企税/公共工资金额）+ 生效政策预算 |
| L5 | `artifacts/qa-before/06-transport-fiscal-insufficient.png`、`06b-transport-section-clip.png` | 交通面板 4 处“财政资金不足”提示（可反推政府资金不足） |
| L6 | `artifacts/qa-before/07-city-card-after-12m.png` | 推进 12 个月后城市卡片“财政 -5632.2 万”（负余额泄漏） |
| L7 | `artifacts/qa-before/08-region-map-economy-after-12m.png` | 12 个月后地图节点“GDP 4780.2 万 · 财政 -5632.2 万” |

数据与哈希：`artifacts/qa-before/manifest.json`（逐条含 city / 身份 / 字段 / 截图 sha256 / DOM 或画布文字片段）。
12 个月财政数值与任务书 §三基线表一致（岚港 -5,632 万、铁谷 -1,024 万、青原 +4,212 万），可作交叉校验。
运行期间应用级错误 0；仅有 WebGL 软件回退与 ReadPixels 性能提示（无头环境已知噪声，非应用错误）。

---

### 1.2 首轮验收执行记录（2026-11-02，基线 `feature/arch-foundation` @ `18e2617` 合入 `qa/acceptance`）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（0 错误，含 `tests/acceptance/**`） |
| 业务基线 | `npx vitest run tests/`（不含 acceptance） | 306 用例全过，见 §1 基线；合并后单独复跑 `economy-stability` 120 月用例通过（27.3s，接近 30s 超时线，并发时易超时，属测试超时余量问题，非回归） |
| 验收 H 组 | `npx vitest run tests/acceptance/migration-v7.test.ts` | 14/14 通过（H01–H07 已执行项，含 v1–v6 六档全链） |
| 验收 G 组 | `npx vitest run tests/acceptance/gdp-estimate.test.ts` | 6 通过 / 2 红（G04 两条，`pushRealGdpPoint` 空实现） |
| 验收 I 组 | `npx vitest run tests/acceptance/permissions.test.ts` | 5 通过 / 8 红（公开债券投影×2、I03、I04 空实现；I07a/c/d/e、I09 界面未修） |
| 验收合计 | `npx vitest run tests/acceptance` | **35 用例：25 绿 / 10 红**（红全部为“实现未落地”，无权属误判） |
| 构建 | `npm run build` | 待本轮测试文件定稿后执行并补记 |

文件：`tests/acceptance/helpers.ts`、`migration-v7.test.ts`、`gdp-estimate.test.ts`、`permissions.test.ts`。

### 1.3 第二轮验收执行记录（2026-11-02，集成分支 `2983c2c` → `ee1a949` 合入 `qa/acceptance`）

合并：`0cce81b`（= `2983c2c`，契约追加 #40–#43）→ `55dfcad`（= `ee1a949`，债券状态机 + 审计 #9 文案）。
基线标记：`git tag qa-baseline-pre-bonds ee1a949`（只读记录“实现前”对照点：42 文件 / 328 用例）。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（0 错误，含 `tests/acceptance/**`） |
| 业务基线 | `npx vitest run tests/ --exclude 'tests/acceptance/**'` | **42 文件 / 328 用例全过**（与游戏程序自验一致；稳定性用例超时已放宽） |
| 构建 | `npm run build` | 通过（renderer + electron） |
| 验收合计 | `npx vitest run tests/acceptance` | **59 用例：49 绿 / 10 红** |
| 其中新增 A/B/C | `baseline-a`(4) + `bonds`(15) + `company-bond-subscription`(5) | **24 用例：21 绿 / 3 红** |
| 旧红保留 | H/G/I 首轮 | G04×2（`pushRealGdpPoint` 未落地）、I01×2/I03/I04（`fiscal-view` 空实现）、I07c/d（概况 KPI 仍显示财政） |

**B/C 组结论（@`ee1a949`）**

- 通过：AC-B01–B11、B13；AC-C01–C05 全过。整数份/计划成交分账/多主体归属/跨城/超额截断/确定性顺序/36 月到期/利息周期/大额存量贷款下垫付均符合冻结口径。
- 红：**AC-B12、AC-B14（2 条）**，同一根因，已定位为实现缺口而非用例口径问题：
  - `settleBondMaturity` / `payBondCoupon` / `settleBondBankruptcyRedemption` 只写 `BondPayment` 流水、扣财政/建 `bondAdvance` 贷款，**未把款项记入持有人现金**（`world.player.cash` / 企业 `cash` / 居民投资实体 `cash` 均不变）。
  - 实测：财政充足场景，财政支出 11,200 后持有人现金仍为 0，货币净额减少 11,200；财政为 0 场景，垫付贷款 +11,200、持有人现金 +0，净额同样减少 11,200；破产兑付 20 个月场景净额减少 10,666.67（本金 10,000 + 应计利息 666.67）。
  - 影响：违反 Brief §4.1.3「持有人第 36 月足额收款」与 AC-B14 守恒；若设计打算由第二批月结（`debt.ts` 阶段③）统一入账，则这两条需在第二批合入后复跑转绿，且不得与本次扣款/垫付重复记账。
- 口径说明：AC-B06 的“资金不足”在实现中走“部分成交 0 份、`ok=true`”，不是报错分支；验收按“零副作用（不扣款/不建仓/不产生本金）”判定为通过，建议交付报告写清该口径。

文件：`tests/acceptance/{baseline-a,bonds,company-bond-subscription}.test.ts`、`fixtures/economy-baseline-36m-v07.json`。

### 1.4 第三轮验收执行记录（2026-11-02，UI 块4 `7c5edf7` 合入 `qa/acceptance`）

合并：`33faaf4`（= `7c5edf7`：市长财政面板、债券市场、企业数 KPI、非市长受限占位）。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（0 错误） |
| 业务基线 | `npx vitest run tests/ --exclude 'tests/acceptance/**'` | **42 文件 / 328 用例全过** |
| 构建 | `npm run build` | 通过 |
| 验收合计 | `npx vitest run tests/acceptance` | **59 用例：54 绿 / 5 红** |
| I 组 | `npx vitest run tests/acceptance/permissions.test.ts` | **13/13 全绿**（I01/I03/I04 空实现转绿；I07 按新标记 `mayor-fiscal-panel`/`fiscal-restricted` 改写后转绿） |
| 余红 | — | G04×2（等块2）、B12、B14×2（兑付不入账，等第二批确认） |

### 1.5 第四轮验收执行记录（2026-11-02，块1+块2 `1d138a6` 合入 `qa/acceptance`）

> 注：本节 36 月样本数值在第五轮（sim 块3/4）后已变化，现行样本见 §1.6；本节保留为历史记录。

合并：`3785989`（= `1d138a6`：债券状态机 + 破产清算/月结六阶段/12 月 GDP 窗口 + holdingId 幂等）；随后追平集成分支 `7000db0`（纯文档/数据，merge `f8af0ed`）与交付分支 `d637c27`（data 块6 探针，merge `74467a6`，代码无差异）。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（0 错误，含 `tests/acceptance/**`） |
| 业务基线 | `npx vitest run tests/ --exclude 'tests/acceptance/**'` | **44 文件 / 345 用例全过** |
| 构建 | `npm run build` | 通过（renderer + electron；`dist/electron/saveIpc.js` 存在） |
| 验收合计 | `npx vitest run tests/acceptance` | **84 用例：80 绿 / 4 红**（含新增 H08/H09 3 条） |
| F 组（构造夹具） | `npx vitest run tests/acceptance/bankruptcy.test.ts` | **13/14 绿**，仅 AC-F08 红（同月两段兑付第二段被幂等键吞掉） |
| F 组（真实 36 月） | `npx vitest run tests/acceptance/bankruptcy-real-run.test.ts` | **8/8 绿**（固定条件样本，见下） |
| G 组 | `npx vitest run tests/acceptance/gdp-estimate.test.ts` | **8/8 全绿**（G04×2 转绿：真实值逐月替换） |
| H/I 组 | `migration-v7` / `permissions` | **14/14、13/13 全绿** |
| 余红 | — | B12、B14×2（兑付仍不入持有人现金：块1 债券函数未入账、块2 月结未补；与 F08 为同族“兑付账目”缺陷） |

**真实 36 月破产样本（F-R 组）**

- 固定条件：`Simulation.create()`（默认种子 `20261101`）+ 连续 36 次 `tick()`，玩家无操作；基线 `3785989`。
- 复现命令：`npx vitest run tests/acceptance/bankruptcy-real-run.test.ts`；用例内 `beforeAll` 逐月记录月末负债率快照。
- 探针交叉引用：数值岗 `docs/development/reports/economy-probe-block2.json` → `probe.bankruptcies`（岚港判定负债率 103.6159%/总负债 515,423,777.57/判定 GDP 497,436,959.73；铁谷 103.5096%/317,097,115.03/306,345,548.4；当选人 罗知远/许星野）；测试 `bankruptcy-real-run.test.ts` 已按这些值逐项断言（`toBeCloseTo`）。
- 实测期望值（与秘书处 `1d138a6` / 交付分支 `d637c27` 跑数一致）：岚港 t20、铁谷 t30 各破产一次；t19 岚港 96.9067%（high）、t29 铁谷 91.3379%（high）；判定月比率 103.6%（岚港）>100%；破产兑付 24 期债券本金 768,932,000 + 计提未付利息 19,307,136.64 = 银行垫付 788,239,136.64；24 期 100% 成交（计划=成交 768,932 份）；85 笔持有（71 跨城 / 14 同城，全部 `investorGroup`，无企业/玩家认购）；24 笔 `bondAdvance` + 4 笔政府贷款全部 `writtenOff` 且未偿清零；两城同 tick 重选、`caretakerUntilElection=false`；破产政府持股清零、发行总量不变（`checkInvariants` 空）；次月起靠普通银行贷款重建，t36 负债率 73.0853% / 20.4724%。
- 已知限制（秘书处确认，不判 bug）：**破产后 AI 不再发新债券**（债务分期到期使“禁借新还旧”恒真）；测试 F-R8 已断言所有债券 `issuedTick <= 破产 tick`，作为行为记录。
- 与秘书处口径的差异（已按实测修正）：①“认购主体全部跨城”不成立——本样本 14/85 为同城认购（如 `lanport-invest1` 买岚港债），跨城 71/85；同城认购不违反冻结口径（口径允许跨城，未禁止同城），仅记录事实。②“次月起新债 29/21 笔”按本测试口径（`purpose='government'` 且 `startTick > 破产tick`）在 t36 时为岚港/铁谷各 ≥1 笔且总活跃 16/6 笔，笔数统计方式不同，不判差异。

**桌面走查证据（本轮实际执行，非规划）**

| 脚本 | 命令（Xvfb :99 1600×1000×24） | 结果 |
| --- | --- | --- |
| `scripts/smoke-main.cjs` | `DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage scripts/smoke-main.cjs` | 退出 0；27 项交互；存档/读档日期一致（2027-02）；1100 宽无横向溢出；损坏自动存档安全降级（“autosave 已暂停”、字节保留） |
| `scripts/smoke-fiscal-ui.cjs`（UI 块4 随附） | 同上 | 退出 0；**22/22** 检查过（城市卡片无财政、非市长受限、跨城不泄漏、通知过滤、月报财政列、读档市长身份、GDP 窗口 12 行、债券市场空态、1100×700）；截图 `artifacts/ui-fiscal/01–15` |
| `scripts/acceptance-leaks-after.cjs` | 同上（与 before 同机位 1440×900、同名截图） | 退出 0；**7/7** 断言过：L1 城市卡片、L2 地图经济图层、L3 概况 KPI、L4 政府面板、L5 交通提示、L6 12 月后卡片、L7 12 月后地图均无财政；12 月后三城财政 -5632.2 万/-1024.3 万/+4211.8 万；`artifacts/qa-after/` |
| `scripts/acceptance-after-block2.cjs` | 同上 | 退出 0；7 张 + `manifest.json`（sha256/身份/DOM 摘要，`consoleErrors=[]`）：非市长区域卡片/受限政府章节/月报财政列“—”；市长财政面板（6000.0 万/总负债 0/0.0%/正常）；债券市场认购区（plan 200）；认购 20 份推进 1 月（sold=20、active、财政 59,401,701.42、总负债 20,066.67）；市长月报仅本市有财政值；`artifacts/qa-after-block2/` |
| `scripts/acceptance-desktop.cjs` | 同上 | 退出 0；18/18 检查过（v0.5 九组操作，11 张 `artifacts/acceptance-*.png`）；console 仅 2 条 WebGL 软件回退告警 |

说明：市长身份在 `after-block2` 中通过 fixture 注入（直接写 `world.player.roles.mayorCityId` + `store.emit()`），因生产构建 `setMayorDemo` 被 `import.meta.env.DEV` 拒绝；manifest 的 label 仍写作“fixture: store.setMayorDemo”，实际注入方式以本节说明为准。`artifacts/` 被 `.gitignore` 忽略，未提交，磁盘留档。

### 1.6 第五轮验收执行记录（2026-11-02，交付分支 `316eff4` 合入 `qa/acceptance` = `65c4c28`）

合并：`git merge 316eff4` → qa merge **`65c4c28`**（含 sim 块3/4：居民消费市场/消费贷/银行垫付修复、data 报告、arch 报告）。机器负载 `/proc/loadavg` 4.4–5.7，按秘书处要求单文件串行跑。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（0 错误，含 `tests/acceptance/**`） |
| 业务基线 | `npx vitest run --exclude 'tests/acceptance/**' --no-file-parallelism` | **45 文件 / 363 用例全过** |
| 构建 | `npm run build` | 通过（renderer + electron） |
| 验收合计 | `npx vitest run tests/acceptance --no-file-parallelism` | **101 用例：100 绿 / 1 红**（仅 AC-F08） |
| B 组 | `bonds.test.ts` | **15/15 全绿**（B12/B14 转绿：兑付入账修复后净额差 0） |
| C 组 | `company-bond-subscription.test.ts` | **5/5 全绿** |
| D 组（新） | `household-consumption.test.ts` | **9/9 全绿**（D01–D09） |
| E 组（新） | `household-loans.test.ts` | **8/8 全绿**（E01–E08） |
| F 组（构造夹具） | `bankruptcy.test.ts` | **13/14**，仅 AC-F08 红（见下“实现缺陷”） |
| F 组（真实 36 月） | `bankruptcy-real-run.test.ts` | **8/8 全绿**（样本已按块3/4 重测，见下） |
| G 组 | `gdp-estimate.test.ts` | **8/8 全绿** |
| H 组 | `migration-v7.test.ts`（14）+ `settlement-resume.test.ts`（3） | **17/17 全绿**（H09 改为动态发现破产 tick） |
| I 组 | `permissions.test.ts` | **13/13 全绿** |
| A 组 | `baseline-a.test.ts` | **4/4 全绿**（归档 JSON 自洽；归档本身早于块3/4，见下“基线漂移”） |

**真实 36 月样本重测（块3/4 后，现行基线）**

- 固定条件：`Simulation.create()`（默认种子 `20261101`）+ 36 次 `tick()`，玩家无操作；基线 `65c4c28`；命令 `npx vitest run tests/acceptance/bankruptcy-real-run.test.ts`。
- 与旧样本（§1.5）差异：**岚港 t20→t27 破产、铁谷不再破产（t36 70.0% watch）**；破产兑付 12 期（旧 24 期）本金 467,536,000 + 利息 17,759,713.34 = 垫付 485,295,713.34（旧 788,239,136.64）；24 期债券计划=成交 739,973 份（旧 768,932）；85 笔持有（61 跨城 / 24 同城，全部 investorGroup）；12 笔 `bondAdvance` + 6 笔政府贷款 `writtenOff`（未偿清零）；t36 负债率岚港 32.2%（normal）/铁谷 70.0%（watch）；`checkInvariants` 空。
- **基线漂移需要数值岗确认**：`docs/development/reports/economy-baseline-36m-v07.json`（A05–A07 归档，源 `391909e`）是块3/4 之前的 36 月序列；现测序列已不同，但 A 组只校验归档内部自洽、未重跑 36 月，故仍绿。**交付报告不能把归档数值当作现行 36 月观察值**；建议数值岗重出 `economy-baseline-36m-v07.json`（或标记为历史），AC-K07 以新 JSON 为准。
- 已知限制（沿用秘书处确认，不判 bug）：破产后 AI 不再发新债券（债务分期到期使“禁借新还旧”恒真），F-R8 断言所有岚港债券 `issuedTick <= 破产 tick`。

**本轮实现缺陷（唯一红条，已按 file:line 定位）**

- AC-F08 `tests/acceptance/bankruptcy.test.ts:263`：同月到期 + 破产，本金 10,000 分“财政支付 8,800 + 银行垫付 1,200”两段；`src/simulation/government/bonds.ts:672` `makePayment` 的幂等键 `(issuanceId, holdingId, tick, 'principal')` 不含出资来源，第二段被 `bondPaymentExists` 丢弃 → 流水只记 8,800、`issuance.principalRepaid=8,800`（应 10,000），且持有人少收 1,200（实测 player.cash 10,000，应 11,200）。
- 与 B12/B14 不同：B12/B14 的“兑付不入账”已修复并通过；F08 是同一函数在**两段拆分**下的幂等键缺陷，需 sim 把出资来源（treasury/advance）纳入幂等键或合并为单次支付后一次入账。

**本轮修掉的验收脚本自身问题（非产品缺陷，记录以免误判）**

- AC-B14 旧断言 `player.cash=11,200` 未扣除认购后剩余 10,000 → 改为 `playerCashBefore + 11,200`（净额守恒断言原本已通过）。
- AC-D06 只清空 food 库存仍会买其他消费品 → 清空全部消费类商品；AC-D07 收入 0 时预算应为 50（现金×5%）而非 1,000；AC-D09 跨城进口在结算前挂在出口待结算、货币总量暂时减少 → 用“关闭跨城补货”的配置隔离本地渠道做守恒。
- AC-E07 手工改群体收入后需同步 `lastMonth.netCashChange` 才能通过 `parseSave` 不变量校验（测试夹具修正）。
- 契约文档歧义（已按 DECISIONS #26 执行）：`ConsumerBudgetSnapshot.effectiveBudget` 类型注释写“= cashBudget + loanAvailable”，实现为 `= cashBudget`；D/E 测试与实现一致，建议架构文档修正注释。

### 1.7 第六轮（交付前最后一轮）验收执行记录（2026-11-02，交付分支 `21e699a` 合入 `qa/acceptance` = `78cfc2c`）

- `git merge 21e699a` → qa **`78cfc2c`**（含 sim `3d0d21b` AC-F08 修复：到期兑付把财政段与垫付段合并为一次支付+一次入账）。
- 基线：`npm run typecheck` ✓ 退出 0；`npm run build` ✓ 退出 0；业务 `npx vitest run --exclude 'tests/acceptance/**' --no-file-parallelism` **45 文件 / 366 用例全过**。
- 验收：`npx vitest run tests/acceptance --no-file-parallelism` → **11 文件 / 101 用例全过（101/101，0 红）**。
  - 重点回归：**AC-F08 转绿**（`principalRepaid=10,000`、持有人净收 11,200）；B12/B14 三条货币守恒仍绿；D/E/G/H/I 无回退。
  - H 组存档矩阵 v1–v6 → v7 往返 14 条 + 读档重复结算 3 条全绿（`migration-v7.test.ts`、`settlement-resume.test.ts`）。
- 桌面走查（Xvfb :99 1600x1000x24 + `--no-sandbox --disable-dev-shm-usage`，窗口 1440×900，最终构建）：
  - 新脚本 `scripts/acceptance-final.cjs` → `artifacts/qa-final/`：**8 张 + manifest.json**（逐张 sha256 / city / 身份 / tick / dom 摘要，consoleErrors=[]）。覆盖市民受限态（`fiscal-restricted`）与市长财政面板（`mayor-fiscal-panel`）同城同 tick 对照、债券市场发行/认购（计划 200 份、认购 20 份后 `soldUnits=20`、`totalDebt=20,066.67`）、月度报告非市长财政列占位、市长区域卡片仍无财政。
  - `scripts/smoke-main.cjs` → **退出 0**：27 项交互、存档 formatVersion=7、存读档日期一致（2027-02）、1100 宽无横向溢出、损坏自动存档安全降级（“自动存档已暂停”、字节保留）；`errors` 仅 8 条 WebGL 软件回退告警（无头噪声）。合并结果存 `artifacts/qa-final/smoke-main.json`。
- 唯一红条清单：**无**。历史红条（B12/B14、I07、G04、F08）均已在后续分支修复并复验核销。
- 收敛文档：本轮结果表见 `docs/development/ACCEPTANCE_RESULTS_v0.7.md`（交付报告 §9 引用）。

### 1.8 第七轮（最终 HEAD）验收执行记录（2026-11-02，交付分支 `b85cc0f` 合入 `qa/acceptance` = `3177f39`）

- `git merge b85cc0f` → qa **`3177f39`**（界面 `e49079d`：公开破产面板 + 长周期债券走查取证，+903 行；不动 sim 逻辑）。
- 基线：`npm run typecheck` ✓；`npm run build` ✓；**全量 `npx vitest run --no-file-parallelism` → 57 文件 / 472 用例全过**（业务 45/366 + 验收 12/106）。
- 新增 I 组权限回归 `tests/acceptance/public-bankruptcy-panel.test.ts`（AC-I10a–I10e，5 条，全绿）：
  - 非市长破产城市视图出现 `public-bankruptcy-notice`、垫付/兑付/勾销/股份托管字段；
  - 非市长不出现 `mayor-fiscal-panel`/`fiscal-treasury`/`fiscal-total-debt`/`fiscal-debt-ratio`/`fiscal-risk-badge`/`fiscal-ledger`，受限占位仍在；
  - 市长视角公开面板与财政面板并存；
  - `publicBankruptcy()` 公开投影不含 `treasury/debtRatio/riskLevel/gdpJudgementValue`，且垫付/兑付金额 > 0；
  - 未破产城市投影为 null、面板不渲染。
- 验收合计 **106 条，106 通过 / 0 红**。
- 桌面走查（最终构建重跑）：
  - `scripts/acceptance-final.cjs` → `artifacts/qa-final/` 8 张 + manifest（consoleErrors=[]，逐张 sha256/身份/tick）。
  - `scripts/smoke-main.cjs` 退出 0：27 项交互、存读档 formatVersion=7、损坏档安全降级。
  - `scripts/smoke-fiscal-ui.cjs` 退出 0：**42/42 检查通过**，新增长周期 10 段与破产取证——tick 22 冻结破产前档（负债率 0.94）→ tick 23 岚港真实破产、公开破产面板（看守期/银行垫付/已勾销/股份托管）、债券市场 12 期破产兑付 + 勾销说明；截图 `artifacts/ui-fiscal/`（20 张）+ `artifacts/ui-fiscal-bonds/`（9 张 + NOTES.md）。
- 红条清单：**无**。

## 2. 验收矩阵

图例：优先级 P0 = 交付前必须通过（失败即阻断）；P1 = 应通过，失败须书面说明缺口；P2 = 观察项/一致性检查。
验证方法：UT = 单测；IT = 集成测试（真实 `Simulation.tick`）；OBS = 脚本观察（数据表/JSON）；DESK = 无头 Electron 走查；AUDIT = 静态审计（代码/HTML 字符串）；FILE = 文件字节比对。

### A. 基线回归与不变量

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-A01 | 每次集成后跑类型检查/构建/相关测试（Brief §八.1） | 在 `wt/qa` 合并 `feature/economy-fiscal-balance` 后执行 | 命令 | typecheck/vitest/build 退出码 + 文件/用例数；失败用例清单 | P0 | 待执行 |
| AC-A02 | 区分“本来就坏”和“改坏了”（TEAM_RULES §1） | 以 306 用例为基线，逐条比对失败用例名 | 命令 + 对比 | 失败用例名 diff 表；归因结论 | P0 | 待执行 |
| AC-A03 | 财务唯一权威、逐笔可追溯（Brief §三） | 月结后 `checkInvariants(world)` 为空；读档/迁移后同样为空 | IT | 用例名 + 断言；不变量问题列表为空 | P0 | 待执行 |
| AC-A04 | 资金守恒（Brief §三、§八.1） | 定义并断言“世界资金总额”口径（现金 + 存款 + 财政余额 + 银行垫付/贷款镜像 + 在外债券本金等）在月结/认购/兑付/破产/读档前后闭合 | IT | 守恒等式用例；差额 = 0 的输出片段 | P0 | 待执行 |
| AC-A05 | 企业倒闭清算银行实收 0（既有基线，本轮不改） | 6 家倒闭企业债务全额减免，合计 166,267,450；银行实收 0；占期末未偿 40.0% | OBS | 36 月基线 JSON（种子 20261101）`banking.defaultedOutstanding / outstanding` + 清算 Anomaly 文本 | P2（已知限制，不判失败） | 已执行→通过（归档数值） |
| AC-A06 | 银行利差持续为负（既有基线，块6 复核） | 36/36 个月利息收入 < 利息支出；M36：778,449.56 vs 1,878,615.19 | OBS | 基线 JSON `banking.interestIncome/interestExpense` + monthly 序列 | P2（已知限制，不判失败） | 已执行→通过（归档数值） |
| AC-A07 | 分红/现金流动性观察（影响 #23 企业可认购额度） | 3 家企业利润基本全分红且现金 < 2 个月工资：岚港纺织厂、青原纤维农场、青原食品加工厂 | OBS | 基线 JSON `profitVsCash` / `companiesTop` + Anomaly 文本 | P2（观察项，不判失败） | 已执行→通过（归档数值） |

> **已知限制（不判失败，交付报告单列）**：AC-A05/A06/A07 是既有基线行为，本轮不修、不阻断交付，但必须在交付报告“已知限制”章节逐条列出并注明数据来源。
> **基线漂移提示（2026-11-02 第五轮）**：该归档生成于 sim 块3/4 之前；块3/4（居民消费/消费贷）合入后 36 月序列已变化（见 §1.6：仅岚港 t27 破产、垫付 485,295,713.34）。A05–A07 仍作为“归档数据自洽”证据，但**不能当作现行 36 月观察值**；交付报告 AC-K07 需用数值岗重出的新基线。
> 期望值权威来源：`tests/acceptance/fixtures/economy-baseline-36m-v07.json`（从数值岗归档 `docs/development/reports/economy-baseline-36m-v07.json` 复制，源提交 `391909e`，sha256 前缀 `dcbce239e2ff7947`；固定种子 20261101、36 月、玩家无操作）。测试 `baseline-a.test.ts` 只校验归档数值之间的自洽与阈值（不重跑 36 月），避免把“读不到外部归档”变成假红。


### B. 政府债券

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-B01 | 面额与整数份（SUPP §4.1–4.2） | 1,000/份；1 份起；非整数份/非整数倍金额拒绝，不四舍五入、不部分入账 | UT | 用例名 + 拒绝错误文案 + 前后账目不变断言 | P0 | 已执行→通过 |
| AC-B02 | 计划与实际成交分账（SUPP §4.3） | 计划 100 份售 65 份 → 本金 65,000；未售 35 份不形成债务、不入账 | UT | 用例名 + 计划/成交/本金三值断言 | P0 | 已执行→通过 |
| AC-B03 | 部分成交资金一次入账 | 政府可用资金 = 原值 + 65,000，仅一次；重复提交不重复入账 | UT/IT | 前后余额差 + 幂等断言 | P0 | 已执行→通过 |
| AC-B04 | 多主体认购归属（SUPP §4.4） | 玩家 / 居民投资实体 / 企业各自扣款；债券归属、利息、兑付记到正确持有人 | UT | 各主体现金差 + 持仓记录断言 | P0 | 已执行→通过 |
| AC-B05 | 跨城购买 | A 城主体买 B 城债券：扣 A 主体资金、记 B 城债务、利息/兑付由 B 城付 | UT/IT | 双城账目断言 + 归属记录 | P1 | 已执行→通过 |
| AC-B06 | 资金不足不成交 | 可用资金 < 1,000 → 拒绝；不扣款、不成交、不产生本金、不留脏记录 | UT | 错误文案 + 账目/持仓零变化 | P0 | 已执行→通过（口径：0 份成交，非报错） |
| AC-B07 | 无重复扣款 | 同一认购批重复调用、失败重试、并发式重复提交只扣一次 | UT | 现金差与成交份数断言 | P0 | 已执行→通过 |
| AC-B08 | 无超额发行 | 累计成交份数 ≤ 计划份数；超额部分截断/拒绝；计划 0 不得发行 | UT | 成交份数、本金、拒绝记录 | P0 | 已执行→通过 |
| AC-B09 | 确定性排序（SUPP §4.5） | 固定种子与配置下认购顺序、成交结果可复现 | UT | 两次运行结果深度相等 | P2 | 已执行→通过 |
| AC-B10 | 36 个月到期 | 第 35 月不兑付；第 36 月自动兑付本金 + 按口径利息，足额到账 | IT | tick 序列账目 + 到期状态断言 | P0 | 已执行→通过 |
| AC-B11 | 利息计付 | 年利率 4%；每满 12 个月付一次；不重复计息；提前破产兑付按持有月份计提未付利息 | UT/IT | 利息金额断言（含边界月份） | P1 | 已执行→通过 |
| AC-B12 | 银行无条件垫付（Brief §4.1.3） | 政府资金不足（含 0/负）时到期仍全额兑付；垫付额转政府银行贷款并计入负债；持有人收款完整 | IT | 兑付前后持有人现金、政府贷款、总负债断言 | P0 | 已执行→通过（块3 兑付入账后，财政支付/垫付/破产兑付三条净额差 0） |
| AC-B13 | 垫付不受普通授信限制 | 垫付不受政府普通贷款额度限制，不因授信不足失败 | IT | 额度不足场景仍兑付成功 | P0 | 已执行→通过 |
| AC-B14 | 债券总账守恒 | 认购扣款 = 政府融资入账；兑付 = 持有人收款；垫付 = 政府贷款增加；全链闭合，无凭空资金 | IT | 守恒等式 + 差额 0 | P0 | 已执行→通过（块3 兑付入账后，财政支付/垫付/破产兑付三条净额差 0） |

### C. 企业购债限制

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-C01 | 认购不触发贷款（SUPP §5） | 认购前后银行 `loans` 数量、本金、企业债务均不变 | UT | 前后快照断言 | P0 | 已执行→通过 |
| AC-C02 | 禁止“先贷款再认购”绕过 | 不存在认购时自动申请贷款路径；贷款 `purpose` 不含购债；自动流程无法先放贷再认购 | AUDIT + UT | 代码审计记录 + 用例（调用自动流程后无新增贷款） | P0 | 已执行→通过 |
| AC-C03 | 只用现有可支配资金 | 购债后企业现金 ≥ 0；若实现流动性保留规则，按配置保留额断言 | UT | 现金断言 | P0 | 已执行→通过 |
| AC-C04 | 已有贷款企业不一律禁止 | 有存量贷款的企业仍可用自有资金购买，但不得新增贷款 | UT | 购买成功 + 贷款不变 | P1 | 已执行→通过 |
| AC-C05 | 现金不足/非整数份拒绝 | 拒绝且无副作用（不扣款、不贷款、不成交） | UT | 错误文案 + 零变化断言 | P0 | 已执行→通过 |

### D. 居民消费

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-D01 | 消费预算公式（Brief §5.1） | 参考额 = 上月实际可支配收入×80% + 当时手头现金×5%；预算 = min(手头现金, max(0, 参考额))；80%/5% 从配置读取。**只有手头现金可动，存款/其他资产不参与** | UT | 多组数值用例 + 公式断言 + 存款不变断言 | P0 | 已执行→通过（公式与配置读取；存款/其他资产不参与） |
| AC-D02 | 计算时点与不重复入账 | 用上月实际可支配收入与本月初手头现金；上月收入不再次入账 | UT | 时点场景用例 + 收入账户不变断言 | P0 | 已执行→通过（同 tick 重复快照一致；上月收入不再次入账） |
| AC-D03 | 无收入但有积蓄（Brief §5.1） | 10 万现金 + 上月收入 0 → 预算 5,000 | UT | 精确数值断言 | P0 | 已执行→通过（10 万现金 + 上月收入 0 → 预算 5,000） |
| AC-D04 | 四层分账（Brief §5.2） | 期望需求→资金支持后有效需求→实际成交→缺口分解；同一笔预算不跨层/跨商品重复计 | UT | 四层金额关系断言（effective ≤ desired，sold ≤ effective，缺口分类合计一致） | P1 | 已执行→通过（成交 ≤ 现金预算 + 实际放款；缺口非负） |
| AC-D05 | 群体隔离（Brief §5.1） | 各群体独立预算与账户，不挪用他群体资金；跨城退款按原群体归属；无群体标记按人口比例兜底且合计守恒 | UT | 群体现金差 + 退款归属断言 | P0 | 已执行→通过（各群体独立预算/现金，不挪用他群体资金） |
| AC-D06 | 供给不足（Brief §5.1） | 缺货不扣款、未成交资金保留、`unmet` 记录；本地成交 + 进口 = 实际成交 | UT | 现金/库存/需求记录断言 | P1 | 已执行→通过（无库存不成交不扣款、记供给缺口；补库存后扣款=成交额） |
| AC-D07 | 银行存款/资产不纳入预算（钉死） | 预算只用手头现金；不得把存款或其他资产复制/折算到手头；结算前后存款余额不变 | UT | 现金/存款/资产/预算断言 | P0 | 已执行→通过（90 万存款不参与，预算 50；结算前后存款不变） |
| AC-D08 | 确定性 | 固定种子下逐群体消费结果可复现 | UT | 两次运行深度相等 | P2 | 已执行→通过（两次独立运行 byGroup 深度相等） |
| AC-D09 | 消费不创造资金 | 群体现金减少额 = 实际支出；全群体合计守恒 | UT | 守恒等式 | P0 | 已执行→通过（关闭跨城补货后世界总现金不变） |

### E. 居民贷款

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-E01 | 额度由财产决定（Brief §5.2） | 非无限信用；财产口径不与其他投资主体重复计算；无资产无抵押默认关闭 | UT | 额度上限用例 + 重复计价反例 | P0 | 已执行→通过（额度 = 财产基准×50%−未偿；放款后等额下降） |
| AC-E02 | 无资产信用开关 | 默认关闭、集中配置；报告说明“不是用户禁止穷人贷款” | UT + AUDIT | 配置键 + 默认值 + 关闭/开启行为 | P1 | 已执行→通过（无资产额度 0、借款被拒；默认开关 allowUnsecuredNoAsset=false） |
| AC-E03 | 贷款是真实债务 | 发放不记为收入；发放→消费→利息→还款可追溯；账目逐笔一致 | UT | 合同字段 + 现金/债务断言 | P0 | 已执行→通过（放款入现金不计收入；还款先息后本、逐笔流水） |
| AC-E04 | 供给不足不借多余钱 | 无货可买时不产生无法成交的贷款；贷款额 ≤ 实际可成交金额 | UT | 贷款额/成交额断言 | P0 | 已执行→通过（无供给不放款；有供给放款=实际成交额、每月 ≤1 笔、≤ 额度） |
| AC-E05 | 逾期与违约 | 连续欠付 ≥2 月标记 `defaulted`；清偿/核销路径明确；不重复计罚息（若未实现罚息须说明） | UT | 状态迁移用例 | P1 | 已执行→通过（欠付 1 月 active、连续 2 月 defaulted；违约后额度冻结） |
| AC-E06 | 迁移/人口变化守恒（Brief §5.2） | 群体迁移、人口变化后债务归属不变；目标群体无账户自动开户；失败回滚不丢钱 | UT | 迁移前后债务合计断言 + 回滚用例 | P0 | 已执行→通过（迁移后两城合计未偿守恒、不产生现金） |
| AC-E07 | 读档不重复放贷/计息 | 保存→读档→再结算不重复发放贷款、不重复计息 | IT | 读档前后贷款/利息快照 | P0 | 已执行→通过（读档同 tick 重放不重复扣款/不重复流水） |
| AC-E08 | 贷款联动的需求分层 | 贷款额→有效需求→成交链路正确；资金不足/供给不足缺口分类正确 | UT | 分层金额断言 | P1 | 已执行→通过（现金预算 0 → 有效需求 0；贷款事后补足，spend=loanFinanced） |

### F. 破产、清算与分股

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-F01 | 破产阈值口径（Brief §4.1.4） | 总负债 = 政府银行贷款 + 未偿债券本金（+ 欠付利息，按冻结口径）；比率 ≥100% 破产 | UT/IT | 负债构成与比率断言 | P0 | 已执行→通过（单测 F01 + 真实样本 F-R1/R2：负债=贷款+未偿债券本金+欠付利息，判定 102.5%） |
| AC-F02 | 阈值边界与动态 GDP | 99.99% 不破产；100% 破产；GDP 增长后比率下降可不破产 | UT | 边界用例 | P0 | 已执行→通过（99.99%/100% 边界用例；GDP 增长后比率下降场景） |
| AC-F03 | 最小判定值 1（SUPP §6.6） | 12 月 GDP 合计 <1（含 0/极低估计）时，比率与判定统一按 max(1, 合计)；不除零；市长面板标注“GDP 极低，已使用最低判定值” | UT/IT | 数值断言 + 文案断言 | P0 | 已执行→通过（合计<1 时按 max(1,合计)；不除零） |
| AC-F04 | 当月立即重选（DECISIONS #7） | 破产判定在同一结算内立即触发选举，非下月；选举记录关联破产；过渡期看守规则按冻结口径 | IT | tick 内事件顺序断言 | P0 | 已执行→通过（F04 + 真实样本 F-R6：破产同 tick 选举、caretaker=false） |
| AC-F05 | 破产幂等 | 同一结算点只清算一次；重复结算/重复 tick 不重复破产、不重复选举 | IT | 二次调用后状态不变断言 | P0 | 已执行→通过（重复结算/重复 tick 状态不变） |
| AC-F06 | 提前兑付未到期债券 | 破产时立即兑付未到期本金（+ 计提未付利息）；已兑付不得在 36 月到期时重复付 | IT | 兑付次数/金额断言 | P0 | 已执行→通过（F06 + F-R3：12 期提前兑付；到期不重复付） |
| AC-F07 | 债务勾销 | 原政府银行贷款 + 垫付贷款一并勾销；不新增现金；不保留为政府债务 | IT | 勾销前后负债/现金断言 | P0 | 已执行→通过（F07 + F-R5：12 笔 bondAdvance + 6 笔政府贷款勾销、未偿清零、不新增现金） |
| AC-F08 | 同月到期 + 破产 | 到期债券与提前兑付债券各只付一次；先兑付后勾销；无重复支付/重复计债 | IT | 同月场景账目断言 | P0 | 已执行→通过（`21e699a` 修复：财政段+垫付段合并为一次支付一次入账；断言 `principalRepaid=10,000`、持有人净收 11,200；复跑 `bankruptcy.test.ts` 14/14 绿） |
| AC-F09 | 有 CEO 分股（Brief §4.1.6） | 政府股份全部转给现任 CEO（玩家或 AI）；保留权利类别；发行总量不变；不转给 CEO 所经营的公司 | UT | 持股表断言 | P0 | 已执行→通过（有 CEO：政府股份全部转 CEO，总量不变） |
| AC-F10 | 无 CEO 分股（Brief §4.1.6） | 除破产政府外现有股东按主体数量平分（非按比例）；余数按可复现固定顺序；其他政府算一个主体 | UT | 持股断言（含不整除场景） | P0 | 已执行→通过（无 CEO：按主体数量平分、余数固定顺序、其他政府算一个主体） |
| AC-F11 | 无股东兜底 | 无 CEO 且无其他股东时，无表决权托管持股保存，不销毁不增发 | UT | 持股总量断言 | P1 | 已执行→通过（无股东兜底：托管持股保存，不销毁不增发） |
| AC-F12 | 读档重放幂等 | 破产月存档→读档→不再重复结算/选举/兑付；读档不重复结算（含到期） | IT | 存档前后状态与事件次数断言 | P0 | 已执行→通过（破产月存档→读档→不重复结算/选举/兑付） |
| AC-F13 | 破产前后状态一致 | 破产后新政府余额/负债一致，无重复计债；后续月份可正常结算 | IT | 连续 tick 状态断言 | P1 | 已执行→通过（破产后连续 tick 状态一致，无重复计债） |
| AC-F14 | 风险预警分级（Brief §4.2） | <50% 正常、50–75% 关注、75–<100% 高风险、=100% 破产；颜色 + 文字 + 环比方向；仅市长可见 | UT + DESK | 分级用例 + 面板截图 | P1 | 部分通过（分级/文案/仅市长可见单测通过；桌面仅覆盖 normal 档，high/破产档未截图） |

### G. 开局 GDP 估计

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-G01 | 12 个月同值估计 + 标注（SUPP §6.4） | 每城历史 12 个月填同一估计值；数据标注为估计（非真实记录） | UT | 历史数组断言 + 标注字段 | P0 | 已执行→通过（首轮 2026-11-02） |
| AC-G02 | GDP 口径（SUPP §6.1–6.3） | 产出价值 − 中间投入；不含工资/贷款/还款/财政；理论产量×80%（可配置） | UT | 计算用例 + 配置键 | P0 | 已执行→通过（首轮 2026-11-02，G03 口径复算一致） |
| AC-G03 | 初始化无副作用（SUPP §6.4） | 估计只用于初始化：不生产、不改库存/现金/工资/税收 | UT | 初始化前后世界快照断言 | P0 | 部分通过（估计不写真实 GDP/历史/月报；库存/现金未单独断言） |
| AC-G04 | 真实值逐月替换（SUPP §6.5） | 真实月度 GDP 到来后从最早月份逐月替换；真实值不受 80% 系数影响 | IT | 13 个月 tick 历史断言 | P0 | 已执行→通过（块2 `pushRealGdpPoint` 落地：真实值逐月替换，13 月 tick 历史断言通过） |
| AC-G05 | 最小判定值 1（SUPP §6.6） | 合计 <1 时判定与比率按 1；面板显示指定文案；不创造产出/现金 | UT + DESK | 数值 + 文案断言 | P0 | 部分通过（判定分母 max(1,窗口合计) 已过；面板“GDP 极低”专用文案桌面未覆盖） |
| AC-G06 | 旧档兼容（SUPP §6.7） | 优先真实历史；不足 12 个月用同口径估计填补并标注；估计不写成真实历史 | UT | 迁移后历史/标注断言 | P1 | 已执行→通过（H03 覆盖：真实历史优先、缺口估计补标注） |
| AC-G07 | 报告数据（SUPP §6 末段） | 交付报告列出每城初始月估计、12 月合计、依据参数 | AUDIT | 报告字段核对 | P1 | 待执行 |
| AC-G08 | 禁止“首月×12”（SUPP §6 末段） | 新游戏首月未结算（`city.gdp = 0`）时不得用首月实际 GDP×12 | AUDIT + UT | 代码审计 + 初值 0 场景用例 | P0 | 已执行→通过（首月 gdp=0、估计不写入真实值；代码审计未见首月×12） |

### H. 存档迁移（v1–v6 → v7）

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-H01 | v6 → v7 结构迁移 | 新字段补齐（债券、政府贷款、GDP 估计等）；迁移后 `formatVersion` 为 7、`migratedFrom=6`、不变量为空、资产守恒 | UT | 用例 + 字段/不变量断言 | P0 | 已执行→通过（migratedFrom=6、结构补齐、不变量空、货币总量不变） |
| AC-H02 | 旧档负财政余额转贷款（Brief §三） | 等额转为银行本金，财政余额归零；不额外发钱；只转一次、重复读档幂等 | UT | 迁移前后资产等式 + 二次读档断言 | P0 | 已执行→通过（等额转 government 贷款、treasury=0、不追溯利息、重复读档幂等） |
| AC-H03 | 估计 GDP 迁移标注 | 旧档估计值带标记；真实历史不被覆盖；估计不冒充真实 | UT | 字段与历史断言 | P1 | 已执行→通过（真实历史保留 estimated=false，缺口 -10…-1 估计补标注） |
| AC-H04 | v1–v5 旧档兼容 | v1/v2/v3/v4/v5 各至少一档可迁移至 v7；既有迁移（v3 表决快照、v5 旧债务、v6 市场账本）不回归 | UT | 每版用例 + 关键字段断言 | P0 | 已执行→通过（v1–v6 六档全链迁移，不变量空） |
| AC-H05 | 往返幂等 | 旧档→迁移→序列化→再读：状态一致；不重复转换、不重复计息/计债 | UT | 往返深度相等断言 | P0 | 已执行→通过（迁移→保存→再读幂等，无重复转贷/重复日志） |
| AC-H06 | 不覆盖用户存档（TEAM_RULES §6） | 迁移只读：读取/迁移不写回原文件，原文件字节不变；失败不写入 | FILE | 文件字节比对（sha256 前后一致） | P0 | 已执行→通过（临时目录文件字节不变、目录无新增） |
| AC-H07 | 安全失败 | 损坏 JSON、未来版本、缺关键字段返回可读错误，不抛异常、不臆造资产 | UT | 错误文案 + 文件未变 | P0 | 已执行→通过（损坏 JSON/未来版本/缺城市均返回可读错误） |
| AC-H08 | 新档到期/破产结算一致 | v7 保存后在到期月/破产月读档，结算结果与不读档一致 | IT | 双路径结果对比 | P0 | 已执行→通过（`settlement-resume.test.ts`：到期前 1 月存档→读档/连续推进逐字段一致；本金流水 1 条；破产前存档同法） |
| AC-H09 | 迁移后读档不重复结算 | 迁移后保存再读档，不重复结算债券到期/破产 | IT | 事件次数断言 | P0 | 已执行→通过（同文件：同档读两次推进结果一致；破产后读档不重放 t20 兑付、不重复建垫付贷款） |

### I. 权限白名单

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-I01 | 非市长可见 5 类（SUPP §7） | 城市公开信息；当月 GDP 与普通 GDP 历史；已发行债券必要投资信息（发行城市/期限/票面利率/面额/可认购数量/自己持有到期与应得）；自持债券与收款记录；公开选举与破产事件 | UT + DESK | 渲染 HTML 包含断言 + 截图 | P0 | 已执行→通过（fiscal-view 落地后：日志/通知/公开债券投影/自持视图均按白名单过滤） |
| AC-I02 | 非市长不可见 6 类（SUPP §7） | 财政资金/余额及变化；收入/支出/赤字/流水明细；银行贷款余额/全部未偿债券本金/总负债；12 月 GDP 合计/债务率/风险等级/预警/趋势；兑付计划/应还款/垫付/预算明细；发债与借款操作 | UT + DESK | HTML 不包含断言 + DOM 文本断言 + 截图 | P0 | 已执行→通过（canViewMayorFiscal/isVisibleTo/非市长视图为 null） |
| AC-I03 | **间接泄漏**：公开投资信息不附带敏感汇总（SUPP §7 末段） | 公开债券投资信息（发行城市/期限/票面利率/面额/可认购数量/自持到期与应得）之外，不得出现**发行计划总额、全部已售额、政府总债务**，也不得以可推算字段间接给出；非市长页面/接口/文案均无这些值 | UT + DESK | 渲染 HTML 与 DOM 文本断言（正向白名单字段存在、敏感汇总字符串不存在）+ 截图 | P0 | 已执行→通过（公开投影含城市/面额/利率/期限，不含计划总额、总售额、政府总债务） |
| AC-I04 | A 城 / B 城切换 | 玩家任 A 城市长时只见 A 城专属财政；B 城按普通玩家权限 | UT + DESK | 两城渲染对比 + 截图 | P0 | 已执行→通过（buildMayorFiscalView：A 城市长仅见 A 城；B 城为受限占位） |
| AC-I05 | 换任后立即重校验 | 换任/离职/破产重选后同一会话内立即生效，无需重启 | UT + DESK | 状态切换用例 + 截图 | P0 | 已执行→通过（任命/退任后同会话立即生效，日志过滤随身份变化） |
| AC-I06 | 操作入口与执行校验 | 非市长不能通过正常 UI 路径发债/借款；执行函数本身也校验，不只隐藏按钮 | UT + DESK | 操作被拒 + 无状态变化 | P0 | 待执行 |
| AC-I07a | 旧泄漏·城市卡片财政余额（DECISIONS #9） | 非市长时城市卡片不得出现 `财政 <金额>`；仅保留公开指标（人口/就业/失业/公开 GDP） | UT + DESK | `renderLeftRegion` HTML 断言 + 修复前后截图对照 | P0 | 已执行→通过（城市卡片对所有身份均不显示财政；`renderLeftRegion` 断言 + 证据 L1/L6） |
| AC-I07b | 旧泄漏·区域地图节点财政（DECISIONS #9） | 非市长时经济图层节点文字不得含 `财政`/余额；只显示公开 GDP 或中性信息 | AUDIT + DESK | 画布 text 对象断言 + 修复前后截图对照 | P0 | 已执行→通过（地图经济图层仅公开 GDP；画布 text 断言 + 证据 L2/L7） |
| AC-I07c | 旧泄漏·城市概况 KPI 财政（DECISIONS #9） | 非市长时城市概况 KPI 不得显示财政余额（`src/ui/panels.ts:539`） | UT + DESK | 渲染断言 + 截图对照 | P0 | 已执行→通过（概况 KPI 财政块改为“企业数量”；证据 L3 + 走查 01） |
| AC-I07d | 旧泄漏·政府面板财政流水与政策预算（DECISIONS #9） | 非市长时政府与政策面板不得显示财政流水明细、政策预算/已支出等（`src/ui/panels.ts:761`、`945–1003`）；可保留公开选举信息与参选入口 | UT + DESK | 渲染断言 + 截图对照 | P0 | 已执行→通过（非市长仅 `fiscal-restricted` 占位；证据 L4 + 走查 02） |
| AC-I07e | 旧泄漏·交通/政策“财政资金不足”提示（DECISIONS #9） | 非市长时不得通过“财政资金不足”等状态文案反推政府资金（`src/ui/panels.ts:1030/1075/1082/1131/1144`）；市长视角仍应有该提示 | UT + DESK | `transport-why` 文本断言（非市长 0 处、市长存在）+ 截图对照 | P0 | 已执行→通过（非市长 0 处“财政资金不足”；市长仍有提示；证据 L5） |
| AC-I07f | 旧泄漏·通知/图表/存档模态/HUD 复核（DECISIONS #9） | 逐项审计通知、图表、存档模态、HUD 是否含财政余额/负债/流水/风险字段；HUD 仅允许玩家现金/净值与世界公开 GDP | AUDIT + DESK | 审计表（文件:行 → 结论）+ 截图 | P0 | 部分通过（通知已核销；图表/存档模态/HUD 本轮未逐项审计） |
| AC-I07g | 泄漏核销记录 | 每个修复点必须有“修复前证据 + 修复后同机位证据 + 断言通过”三件套，逐条核销，缺一不算完成 | AUDIT | 本文件 §2.5 核销表更新 | P0 | 已执行→通过（LK-1–5 三件套齐全；LK-6 通知已核销、其余部分） |
| AC-I08 | 模拟层不受限 | 权限只在 UI 展示与操作层；模拟逻辑正常读取财政数据 | AUDIT | 代码审计记录 | P1 | 已执行→通过（审计：模拟层仍正常读写财政/收入） |
| AC-I09 | 默认开局非市长 | 开局玩家非任何城市市长，城市卡片/地图提示不得显示该城财政余额（当前基线泄漏） | UT + DESK | 断言 + 截图 | P0 | 已执行→通过（默认非市长；区域卡片/地图/概况均无城财政） |

### J. 桌面走查（Xvfb + Electron）

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-J01 | 启动与稳定性（Brief §六、§八.2） | `Xvfb :99 -screen 0 1600x1000x24` + `electron --no-sandbox --disable-dev-shm-usage scripts/acceptance-fiscal.cjs` 启动成功；无 renderer gone、无应用级 console error（WebGL 软件回退/ReadPixels 性能提示按无头环境噪声记录，不计为应用错误） | DESK | 启动日志 + 错误分类清单 + 截图 | P0 | 已执行→通过（smoke-main 27 项、fiscal-ui 22/22、acceptance-desktop 18/18 退出 0；console 仅 2 条 WebGL 软件回退告警，按无头噪声记录） |
| AC-J02 | 导航与基础操作 | 区域 → 城市 → 返回；HUD 日期/GDP/现金更新；时间推进 | DESK | 截图 + DOM 读数 JSON | P1 | 已执行→通过（smoke-main：区域→城市→返回、HUD 日期/GDP/现金、时间推进） |
| AC-J03 | 发债操作 | 市长面板显示发债入口；认购 → 部分成交 → 未售出金额 → 政府资金到账；非市长无入口 | DESK | 截图 + 前后数值 JSON | P0 | 部分通过（`qa-final` 05/06 + 块2 走查：发债计划 200 份→认购 20 份→次月 active、财政到账、总负债 20,066.67；**部分成交/未售**未在桌面覆盖） |
| AC-J04 | 债券到期 | 推进 36 个月，持有人收到本息；到期状态与账目一致 | DESK | 截图 + tick 序列数据 | P0 | 未完成（36 月桌面推进未执行；到期单测 B10 已通过） |
| AC-J05 | 银行垫付 | 政府余额不足场景仍足额兑付；面板说明垫付 | DESK | 截图 + 贷款/负债读数 | P0 | 未完成（桌面垫付场景未造；B12 实现缺口未修，桌面复验待修复后） |
| AC-J06 | 风险预警 | 分级颜色 + 文字 + 环比方向；仅市长可见 | DESK | 截图（市长/非市长对比） | P1 | 部分通过（走查 04：normal 档 + 环比占位；high/破产档未桌面覆盖） |
| AC-J07 | 破产与重选 | 触发破产 → 立即重选事件 → 新政府状态；事件通知可读 | DESK | 截图 + 事件日志 | P0 | 未完成（桌面破产重选未造；真实 36 月为脚本层复现，非桌面） |
| AC-J08 | 权限视图 | 同城非市长逐页面 DOM 断言无敏感字段；A/B 城切换；换任后立即变化 | DESK | DOM 断言 JSON + 截图 | P0 | 已执行→通过（fiscal-ui 22/22 + leaks-after 7/7 + after-block2 7 张 DOM 断言） |
| AC-J09 | 存读档 | 保存 → 推进 → 读取日期/数据一致；重启恢复自动存档；不覆盖用户存档 | DESK | 截图 + 读数 JSON + 文件字节 | P0 | 已执行→通过（smoke-main：存档→推进→读档日期一致；损坏自动存档安全降级） |
| AC-J10 | 窗口尺寸 | 1100×700 无横向溢出、文字不裁切 | DESK | `scrollWidth ≤ innerWidth + 2` + 截图 | P2 | 已执行→通过（fiscal-ui 1100×700：`scrollWidth ≤ innerWidth`） |
| AC-J11 | 截图清单 | 归档 `artifacts/`，命名与步骤对应；注明无头环境与分辨率局限 | DESK | 截图路径清单 | P1 | 已执行→通过（`artifacts/{qa-final,qa-before,qa-after,qa-after-block2,ui-fiscal,acceptance-*}` 清单见 §4） |
| AC-J12 | 缺口如实报告 | 无法完成项写明原因、已尝试方式、替代证据；不用单测冒充 UI 验收 | AUDIT | 报告缺口章节 | P0 | 部分通过（缺口已在 §4 与 `ACCEPTANCE_RESULTS_v0.7.md` §5 如实披露；交付报告缺口章节待撰写人引用） |

### K. 交付报告（Brief §八.3–8.5 + SUPP §8）

| ID | 要求（来源） | 冻结口径 | 验证方法 | 证据形式 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-K01 | 文档依据与冲突（SUPP §8） | 列出所用文档、优先级、与仓库 `GAME_DESIGN_DISCUSSIONS.md` 的实质冲突 | AUDIT | 报告章节核对 | P1 | 待执行 |
| AC-K02 | 分支 / SHA / 推送状态（SUPP §3） | 完整 commit SHA；探测推送权限；无权限则本地分支 + bundle/patch，不索要 token | AUDIT | 报告字段 + `git rev-parse` + bundle 存在性 | P0 | 待执行 |
| AC-K03 | 每城开局 GDP 估计（SUPP §6） | 月估计值、12 月合计、依据参数逐城列出 | AUDIT | 报告数据表 | P0 | 待执行 |
| AC-K04 | 债券口径（SUPP §8） | 面额/利率/付息/部分成交/跨城/企业限制/垫付口径 | AUDIT | 报告章节 | P0 | 待执行 |
| AC-K05 | 白名单检查结果（SUPP §8） | 逐页面/逐入口的实际检查结果 | AUDIT | 报告检查表 | P0 | 待执行 |
| AC-K06 | 暂定参数与未完成项（TEAM_RULES §6） | 集中配置参数全表；区分“用户已确认/首版暂定/建议”；未完成项与待决策项 | AUDIT | 报告表格 | P0 | 待执行 |
| AC-K07 | 固定条件 36 月集成观察（Brief §八.3、§5.3） | 第 1/12/36 月各城财政、负债率、企业成立/倒闭、居民消费与贷款；注明样本局限；不删除事件/隐藏数值 | OBS | 数据表（CSV/JSON）+ 报告 | P1 | 待执行 |
| AC-K08 | 逐条完成状态（Brief §八.5） | 每项要求标注完成/部分完成/未完成及原因 | AUDIT | 报告清单 | P0 | 待执行 |
| AC-K09 | 模块结构与关键文件（Brief §八.4） | 实际模块结构、月结与债券现金流、GDP 估计与替换、迁移行为 | AUDIT | 报告章节 | P1 | 待执行 |
| AC-K10 | UI 操作方式与验证命令（Brief §八.4） | UI 操作步骤、验证命令与结果、当前限制 | AUDIT | 报告章节 | P1 | 待执行 |

### 2.5 旧界面泄漏核销跟踪表（P0）

| 编号 | 位置 | 泄漏字段 | 修复前证据 | 修复后核销证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| LK-1 | `src/ui/panels.ts:346` 城市卡片 | 财政余额 | `artifacts/qa-before/02-city-card-lanport-treasury.png`、`07-city-card-after-12m.png` | `artifacts/qa-after/02-city-card-lanport-treasury.png`、`07-city-card-after-12m.png`（同机位无财政）+ `renderLeftRegion` 断言 + 走查 `qa-after-block2/01` | 已核销 |
| LK-2 | `src/presentation/scenes/RegionalScene.ts:266` 经济图层 | GDP + 财政余额 | `artifacts/qa-before/03-region-map-economy-hint.png`、`08-region-map-economy-after-12m.png`（画布 text 证据） | `artifacts/qa-after/03-…`、`08-…`（同机位仅“GDP <值>”，无财政）+ 画布 text 断言（leaks-after L2/L7） | 已核销 |
| LK-3 | `src/ui/panels.ts:539` 城市概况 KPI | 财政余额 | `artifacts/qa-before/04-city-overview-fiscal-kpi.png` | `artifacts/qa-after/04-city-overview-fiscal-kpi.png`（KPI 为“企业数量”）+ 渲染断言 + 走查 `qa-after-block2/01` | 已核销 |
| LK-4 | `src/ui/panels.ts:761`、`945–1003` 政府面板 | 财政流水、政策预算/已支出 | `artifacts/qa-before/05-government-fiscal-ledger.png`、`05b-government-section-clip.png` | `artifacts/qa-after/05-…`、`05b-…`（非市长仅“仅市长可见”占位）+ `qa-after-block2/02`（hasRestricted=true、无 panel/ledger）+ `ui-fiscal/02` | 已核销 |
| LK-5 | `src/ui/panels.ts:1030/1075/1082/1131/1144` 交通/政策提示 | “财政资金不足”状态 | `artifacts/qa-before/06-transport-fiscal-insufficient.png`、`06b-transport-section-clip.png`（4 处） | `artifacts/qa-after/06-…`、`06b-…`（非市长 0 处）+ `ui-fiscal/04` 市长仍有该提示 + `transport-why` 断言 | 已核销 |
| LK-6 | 通知 / 图表 / 存档模态 / HUD | 财政/负债/风险字段 | 首轮审计未见（需确认） | `ui-fiscal` 通知重过滤用例通过；图表/存档模态/HUD 尚未逐项审计 | 部分核销（通知已核销，其余待审计） |

核销标准：修复后在同一环境（Xvfb 1600×1000、窗口 1440×900、同身份、同城市、同月份）重拍同机位截图，并附 DOM/画布断言；两者都通过才在交付报告标“已核销”。

---

## 3. 测试文件规划（`tests/acceptance/**`）

所有文件放在 `project/wt/qa/tests/acceptance/`，由现有 vitest 配置 `tests/**/*.test.ts` 自动纳入；不修改产品代码。

| 文件 | 覆盖条目 | 说明 |
| --- | --- | --- |
| 文件 | 覆盖条目 | 状态 |
| --- | --- | --- |
| `helpers.ts` | — | 已落地：`newWorld()`（默认种子 20261101）、旧档降级构造器（v1–v6）、世界资金守恒口径 `totalMoney`、面板渲染辅助。 |
| `baseline-a.test.ts` | AC-A05–A07 | 4 条，已执行→通过（归档 JSON 自洽与阈值；不重跑 36 月）。 |
| `bonds.test.ts` | AC-B01–B14 | 15 条，全绿（B12/B14 于块3 兑付入账后转绿）。 |
| `company-bond-subscription.test.ts` | AC-C01–C05 | 5 条，全绿。 |
| `household-consumption.test.ts` | AC-D01–D09 | 9 条，全绿（消费预算/四层分账/群体隔离/供给不足/守恒）。 |
| `household-loans.test.ts` | AC-E01–E08 | 8 条，全绿（额度/无资产/真实债务/不借多余钱/违约/迁移/读档幂等/需求分层）。 |
| `bankruptcy.test.ts` | AC-F01–F14 | 14 条，全绿（AC-F08 于 `21e699a` 修复后转绿）。 |
| `bankruptcy-real-run.test.ts` | AC-F01/F04/F06/F07/F09–F13 的真实样本交叉验证 | 8 条，全绿（块3/4 后新固定样本，见 §1.6：岚港 t27）。 |
| `gdp-estimate.test.ts` | AC-G01–G08 | 8 条，全绿。 |
| `migration-v7.test.ts` | AC-H01–H07 | 14 条，全绿。 |
| `settlement-resume.test.ts` | AC-H08–H09 | 3 条，全绿（到期月/破产月双路径一致性 + 重复读档幂等）。 |
| `permissions.test.ts` | AC-I01–I09、AC-I07a–g | 13 条，全绿（含泄漏回归 7 条）。 |
| `public-bankruptcy-panel.test.ts` | AC-I10a–I10e | 5 条，全绿（公开破产面板：市民见破产事实、不见财政细节；市长双面板并存）。 |
| `scripts/acceptance-leaks-before.cjs` | AC-I07、LK-1–6 | 修复前证据采集（已执行），产物 `artifacts/qa-before/`。 |
| `scripts/acceptance-leaks-after.cjs` | LK-1–5、AC-I07a–e | 修复后同机位复拍 + 7/7 断言（已执行），产物 `artifacts/qa-after/`。 |
| `scripts/acceptance-after-block2.cjs` | AC-I01–I04、J03、J06、J08 | 块2 桌面证据 7 张 + manifest（已执行），产物 `artifacts/qa-after-block2/`。 |
| `scripts/acceptance-final.cjs` | AC-I01–I04、J03、J04 发行/认购、J08 | 最终轮桌面证据 8 张 + manifest（sha256/city/身份/tick/DOM），产物 `artifacts/qa-final/`。 |
| `scripts/smoke-main.cjs`（代码组已有） | AC-J01/J02/J09/J10 | 27 项交互通过（已执行）。 |
| `scripts/smoke-fiscal-ui.cjs`（UI 块4 随附） | AC-J08/J10、AC-I07 | 22/22 通过（已执行），产物 `artifacts/ui-fiscal/`。 |
| `scripts/acceptance-desktop.cjs` | AC-J01/J02 | 18/18 通过（已执行），产物 `artifacts/acceptance-*.png`。 |
| `docs/development/ACCEPTANCE_MATRIX_v1.md` | — | 本文件。 |
| `docs/development/ACCEPTANCE_RESULTS_v0.7.md` | AC-K01–K10 | 最终结果表（组别/用例数/通过/失败/证据路径），交付报告 §9 引用。 |

当前验收用例总数 **106**（业务基线 366 之外）；**P0 余红 0 条**（AC-F08 于 `21e699a` 修复并复验通过，§1.7；公开破产面板于 `b85cc0f` 合入并新增 I10，§1.8）。

规划值约 90–110 个，实际落地 106 个；最终构建全量 = 业务 366 + 验收 106 = **472 用例**（全绿）。

---

## 4. 桌面走查执行记录（实际脚本与产物）

环境：Linux 无头，`Xvfb :99 -screen 0 1600x1000x24`，Electron 窗口 1440×900（小窗口用例 1100×700），`--no-sandbox --disable-dev-shm-usage`，`userData` 隔离到 `artifacts/electron-user-data*/`。

**环境修复记录**：`/var/lib/xkb` 原为指向沙箱外不可写路径的符号链接，Xvfb 启动报 `Cannot open "/var/lib/xkb/server-99.xkm"` 后段错误；用一次 `danger-full-access` 执行 `rm -f /var/lib/xkb && mkdir -p /var/lib/xkb && chmod 1777 /var/lib/xkb` 后恢复。另注意：清理 Xvfb 不能用 `pkill -f "Xvfb :99"`（会匹配到执行该命令的 shell 自身，SIGTERM 掉整条作业），改用 `pgrep -x Xvfb | xargs -r kill`。

> **第七轮（最终 HEAD `b85cc0f` = qa `3177f39`）状态**：三套桌面脚本已在最终构建重跑并全部退出 0；修后证据在 `artifacts/qa-final/`（8 张 + manifest）、`artifacts/ui-fiscal/`（20 张，42/42 检查）、`artifacts/ui-fiscal-bonds/`（9 张 + NOTES.md，含 tick 23 公开破产面板与 12 期破产兑付）。下表 `qa-before`/`qa-after`/`qa-after-block2` 产物为历史轮次留档，非现行构建。`artifacts/` 被 `.gitignore` 忽略，仅磁盘留档。


| 产物目录 | 脚本 | 张数/断言 | 内容 |
| --- | --- | --- | --- |
| `artifacts/qa-before/` | `acceptance-leaks-before.cjs` | 10 张（8 张 + 2 裁切）+ manifest | 修复前泄漏：城市卡片财政、地图节点“GDP 0 · 财政 6000.0 万”、概况 KPI、政府面板流水、交通 4 处“财政资金不足”、12 月后负财政 |
| `artifacts/qa-after/` | `acceptance-leaks-after.cjs` | 10 张（同名同机位）+ manifest；7/7 断言 | 修复后对照：以上位置均无财政；12 月后三城财政 -5632.2 万/-1024.3 万/+4211.8 万 |
| `artifacts/qa-after-block2/` | `acceptance-after-block2.cjs` | 7 张 + manifest（sha256/身份/DOM）；7/7 断言 | 非市长：区域卡片无财政、政府章节受限、月报财政列“—”；市长：财政面板、债券市场、认购 20 份后推进 1 月、月报仅本市有财政 |
| `artifacts/ui-fiscal/` | `smoke-fiscal-ui.cjs` | 15 张；22/22 检查 | 城市卡片、非市长/市长政府面板、跨城不泄漏、通知过滤、月报财政列、读档市长身份、GDP 窗口 12 行、债券市场空态、1100×700 |
| `artifacts/acceptance-*.png` | `acceptance-desktop.cjs` | 11 张；18/18 检查 | v0.5 九组操作（区域/城市/阶层/操作模式/贷款/选举/银行/存读档） |
| `artifacts/qa-final/` | `acceptance-final.cjs` | 8 张 + manifest（sha256/身份/tick/DOM）；consoleErrors=0 | 市民受限态 vs 市长财政面板（同城同 tick）、债券发行 200 份/认购 20 份后结算、月报财政列、区域卡片无财政 |
| `artifacts/ui-fiscal/` | `smoke-fiscal-ui.cjs` | 20 张；42/42 检查 | 权限/财政面板/债券市场/通知/报告/小窗口（最终构建重跑） |
| `artifacts/ui-fiscal-bonds/` | `smoke-fiscal-ui.cjs`（长周期段） | 9 张 + NOTES.md | tick 22 破产前档（0.94）→ tick 23 岚港破产：公开破产面板（看守期/垫付/勾销/托管）、债券市场 12 期破产兑付 |

**缺口（如实记录）**：J04 仅覆盖“发行/认购”桌面路径，**36 月桌面到期**未走；J05（桌面垫付）、J07（桌面破产重选）仍未做桌面截图；F14 high/破产档面板截图未完成。原因：需桌面连续推进 36 月或注入高负债，本轮以单测 + 真实 36 月脚本（`bankruptcy-real-run.test.ts`）+ 债券市场桌面路径替代，交付报告需在缺口章节注明。

## 5. 证据与判定规范

1. 每条 P0 必须有可复现命令与输出；未执行的条目标“未执行”，不得写成“通过”。
2. 单测证据：`文件:用例名` + 关键断言 + ≤10 行输出片段。
3. 命令证据：命令、退出码、通过/失败数量；失败用例逐条列出并归因（本来就坏 / 改坏）。
4. 截图证据：绝对/相对路径 + 分辨率 + 环境（Xvfb 1600×1000×24，Linux 无头）+ 该图证明的断言。
5. 数据证据：36 月观察、GDP 估计、债券账目等以 CSV/JSON 放 `artifacts/`，报告引用路径。
6. 文件证据：旧档“不覆盖用户存档”用 sha256 前后比对，记录两值。
7. 任何与冻结口径不一致的实现，按“缺陷”记录并报秘书处；不自行改生产代码，不擅自改口径。
8. P0 全部通过才判定交付可验收；P1 失败须在报告写明缺口与影响；P2 仅记录。

---

## 6. 依赖块0冻结的接口（风险与请求）

块0 将提供**可编译的函数签名与空实现**（业务体由游戏程序填），因此 B–G 组测试可先按签名写、先编译、后断言；`SAVE_FORMAT_VERSION=7` 与迁移函数名先用占位名，块0 冻结后一次性对齐（秘书处已确认）。以下为执行本矩阵所需的最小契约面（名称仅建议，以块0冻结契约为准）：

1. `SAVE_FORMAT_VERSION = 7` 与迁移入口命名（`migrateWorldV6ToV7`）。
2. 类型：政府债券（发行计划/成交/持有人/到期日/利率）、政府银行贷款、GDP 估计标记、破产状态与幂等标记、托管持股。
3. 纯函数/结算入口：认购、到期兑付、垫付、破产判定、清算、分股、债务比率计算。
4. 配置键：`bonds`（面额/利率/付息周期/期限）、`gdpEstimate`（80% 系数/下限 1）、`bankruptcy`（阈值/预警分级）、`householdCredit`（额度/开关）。
5. 权限判定函数（如 `canViewDetailedFiscal(world, cityId)`），且 UI 渲染必须经过它。
6. 月结顺序说明（GDP 记录 → 财政收支 → 应付 → 到期兑付 → 垫付 → 负债率/破产 → 清算），用于 AC-F08/AC-B14 的时序断言。
7. 迁移幂等标记字段名（用于 AC-H02/H05/H09）。

---

## 7. 执行顺序与里程碑

1. **块0 冻结后**：合并 `feature/arch-foundation` 到 `qa/acceptance`，先跑 AC-A01/A02 回归，确认 306 用例不退化。
2. **模拟线落地后**：按 B → C → D → E → F → G 顺序写并执行单测/集成测试；先 P0 后 P1。
3. **迁移落地后**：执行 H 组（含 v1–v5 链与文件字节比对）。
4. **UI 落地后**：执行 I 组字符串级断言 + 桌面 J 组走查。
5. **交付前**：执行 K 组报告核对 + 固定条件 36 月观察（AC-K07），汇总 `ACCEPTANCE_REPORT_v1.md`。
6. 每轮集成后重跑 AC-A01/A02，记录用例数变化与失败归因；发现问题写报告给秘书处，开发修复后复验。
