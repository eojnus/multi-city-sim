# PROGRESS — multi-city-sim v1.7.0 交接（存档系统重构与长期优化）

> 新会话第一句：`Read /workspace/Coding/multi-city-sim/PROGRESS.md and git log -8, then continue from "Next".`
> 本文件是唯一可信状态；不要从旧对话记忆推断。不要在文件里写 token。

## Goal

v1.7.0（存档系统任务书）：统一存档管理器 + 分模块快照 + 版本迁移 + 必要历史保留 + 精简 JSON + gzip；
先建数据归属表再实现导出/恢复；旧明文/旧 gzip/旧迁移链保留、不破坏玩法；候选世界一次性替换；
128MiB 原始/解压与 64MiB 压缩三层保护并实测；120 月压缩 ≤10MiB 目标；Electron 实机；交付并推送。

## Done（细节见 docs/development/DELIVERY_REPORT_v1.7.0.md 与 SAVE_SYSTEM_DESIGN.md）

- 基线 `31b66272e04bdaa8f0c10f80d5dfc91d551172bf`；分支 `feature/stock-market-ui-tax`；main 未动。
- 版本 `GAME_VERSION/package = 1.7.0`；顶层 `formatVersion = 10`（旧单体 1–9 可读，首次保存升级 v10）。
- `src/simulation/persistence/`：types（SaveModule 接口/格式/错误码/128MiB·64MiB 常量）、registry
  （ID/版本/必需/依赖/归属路径校验）、scaffold（候选世界）、migrations（格式识别/worldMeta）、
  saveCoordinator（minified 导出；读取逐模块校验/迁移→拓扑 restore→afterRestore→跨模块引用→
  既有结构校验→既有 sync→既有不变量→一次性返回；未知必需/高版本拒绝、未知可选 preservedModules 原样
  保留写回、失败不污染当前世界）、referenceValidation（跨模块引用+历史悬空例外）、historyPolicy（A–F）。
- 11 个模块 world/population/company/marketTrade/equipment/banking/government/bonds/securities/
  management/politics；`Company` 原子聚合不拆；派生镜像恢复后走既有 sync；归属表见 DESIGN §2。
- `core/save.ts`：`serializeSave(world,{savedAt,preservedModules})` v10 minified；
  `parseSave` 分派（旧档走既有 v1–v9 迁移链，v10 走协调器）；`createLegacySaveFile`/`serializeLegacySave`
  供旧档夹具；去掉整树 deepClone；`createSaveFile` 现为 v10 模块对象（无 `.world`）。
- 历史治理（月结安全时点、幂等、守恒；72 月实测）：banking.snapshots 18,853→779（每主体 1 条+72 月度
  汇总）；已结清银行贷款 758/居民消费贷 579 归档；fiscal 36 月窗口 5,394 条→归档 3,785/186 桶
  （ledgerLimit 800→12,000 仅 FIFO 保护）；bonds.payments 保留 1,846/归档 779；股票月线 48 根
  （historyMonths 36→120）、年度行 0；议案 145/449；选举 3/9；**lifecycle 不归档**（终身计数语义）。
- 平台层：写盘统一 gzip、读按魔数兼容旧明文、三层限制（128MiB 原始/64MiB 压缩/128MiB 解压）、
  temp+rename+.bak、同槽位并发串行、坏槽位隔离；saveBridge 128MiB UTF-8 预检+浏览器 5–10MB 限制；
  gameStore isSaving 串行/preservedModules 透传/失败释锁与自动存档暂停。
- 验证：tsc（repo+electron）=0；`npm run build` 成功；Electron **28/28、0 console 错误**
  （`docs/evidence_v1.7/`，含手动保存→推进→读取、v10 格式校验、旧明文 72 月档读取→推进→gzip v10 写出）；
  tests/persistence 10 文件全绿（roundtrip 含 A 直接推进 vs B 存档→读档→推进一致、0 月开局幂等、
  未知可选模块保留；大载荷 70MiB parse 271ms/RSS+71MiB、130MiB 预检拒绝）。
  体积：12 月 6,154,159/gzip 485,132；36 月 14,481,803/1,164,287；72 月 19,284,439/1,396,179；
  120 月 raw 21,531,933/gzip 1,330,152（1.27MiB，**≤10MiB 目标达标**）；72 月 v10 minified 18.39MB（旧 pretty v9 53.31MB）；长期趋势 t72→t120 仅 +2.25MB（历史治理收敛）。
  经济规则/数值未改动；36 月 acceptance 轨迹 9/9 未因归档改变。

## v1.7 验收修复轮（基线 3efbc5c，进行中）

1. **新开局存读档改变后续经济结果（已修）**：v10 读档不再预写 `investorLedger.openingShares`；
   唯一初始化时点 = 第一次月度结算中首次需要有效份额时（tick 内确定性、按城市幂等）。旧单体档仍在
   读取时一次性补齐（幂等/不覆盖已有份额/不增减现金）。回归：`tests/persistence/opening-shares-timing.test.ts`
   （tick0 A 直接推进 vs B 存档→读档→推进、连续 6 tick 全量一致、中途读档、旧档幂等）；
   `roundtrip.test.ts` 0 月用例已收紧为逐字段完全相等。设计说明见 DESIGN §5.3。
2. **成功写入后备份保留（已修）**：electron/saveIpc 写序 temp → hardlink/copy 生成 `.bak.next` →
   原子 rename 成 `.bak` → 原子 rename temp→主档；成功后保留 `.bak`=上一版本（单备份轮换）；
   旧格式升级同槽位覆盖保留旧明文备份；中断恢复：主档缺失+备份存在时 read/list 回退并标记
   `recoveredFromBackup`，下一次写先恢复主档；新增 `saves:read-backup`、list `backupExists`；
   除轮换/显式删槽位外不删 `.bak`。测试：save-boundary 21/21、save-failure-protection 21/21。
   注意：`.bak` 是“上一版本”，不是无限历史；依赖同目录硬链接（失败回退 copyFile）。
3. **历史数据显示（已修）**：UI 在财政流水/债券兑付/议案/银行-居民贷款/K 线等面板标注“近期明细窗口+
   更早已归档为年度汇总”，并接入只读年度汇总区块（股票年度 OHLCV 等）；财政归档仅市长可见、
   债券公开汇总排除破产垫付；未改经济数值/存档格式。测试：ui-history-archive-v17 7/7 + 受影响
   UI/acceptance 119/119。未覆盖：选举历史列表、授信快照历史面板、设备维护费历史/世界日志展示。
4. 修复轮仍待完成：受影响测试/构建/Electron 复验、提交推送（不合并 main、不改写既有提交）。

## Next（按序）

1. 等用户验收；提交/推送状态见末尾；提醒撤销本轮 PAT。
2. 后续优先：UI/报表“旧明细→年度汇总”展示；lifecycle 终身计数器后再归档；120 月 serialize
   主线程开销评估（Worker/增量）；浏览器存储扩展。
3. 新系统接入：DESIGN §4（房地产示例）→ types.ts 加 SaveModuleId、声明 ownedPaths、新建
   modules/xxxSave.ts、index.ts 注册、更新归属测试/DESIGN、模块 version+1 并写 fromVersion=0 规则
   （不得造资金/人口/贷款/股份）。
4. 基线确认：`git fetch` → `git rev-parse HEAD origin/feature/stock-market-ui-tax origin/main` →
   `git status --short` → `npx tsc --noEmit`。

## Open questions

- UI 归档汇总卡片实现时机；股票 120 月窗口是否需同步 UI。
- 是否拆分多物理文件（当前单文件 gzip，接口已允许换后端）。
- lifecycle 终身计数迁移方案。

## Key facts（环境与坑）

- 仓库 `/workspace/Coding/multi-city-sim`；node v24.22.1 / npm 11.19.1；2 核 ~2GB 容器。
- env：`export HOME=/workspace/Coding/.home; export npm_config_cache=/workspace/Coding/.npm-cache`。
- 测试：`npx vitest run <files> --maxWorkers=1 --testTimeout=900000 --hookTimeout=1500000`；
  全量 151 文件分块（/tmp/run-v17-chunks.sh，12 文件/块）；economy-stability ~20 分钟；120 月体积报告
  20–40 分钟（nice 会被长测试抢占）；容器偶发 `[vitest-worker]: onTaskUpdate timeout`（断言全绿，
  如实说明）。
- v10 要点：`serializeSave` 无 `world`，旧档夹具用 `createLegacySaveFile/serializeLegacySave`；
  `parseSave` 兼容旧明文(1–9)/旧 gzip/v10；electron 层按 gzip 魔数识别编码；大小上限常量在
  electron/saveIpc 有一份拷贝（rootDir 限制），由 save-boundary parity 测试校验，改动需同步。
- 历史治理只在 `Simulation.tick()` 月结安全时点执行；不得在保存时改世界；必须幂等+守恒；
  lifecycle 禁止归档（founding.ts:552-577 终身计数）。
- 模块归属：`ownedPaths` 不得重叠（含祖先路径）；Company 不拆；新增模块跑 ownership.test + DESIGN §2。
- 数据/脚本：`scripts/save-size-report.ts --checkpoints=12,36,72,120`（JSON → /tmp/save-size-report.json）；
  旧 72 月 prettysave 素材 /tmp/v16-acceptance/t72-save.json（非仓库）。
- Electron：先 `npm run build`，再 `DISPLAY=:99 ... electron --no-sandbox --disable-dev-shm-usage
  --enable-unsafe-swiftshader scripts/acceptance-v09.cjs`；证据 docs/evidence_v1.7/。
- Git：无 SSH key/credential helper；不要 amend/rebase/force、不合并 main、不删功能分支。
- 已踩坑：① serializeSave 已 v10（无 world），旧单体文档必须 legacy helper；② 首次读档有一次性
  investorLedger 迁移，0 月首轮不等同未迁移世界，比较关键字段+二次往返稳定；③ 0 月可选数组
  investorFundingHistory/investorUsageHistory 不存在，validate 用 optionalArray；④ 模块 ID 允许
  camelCase 但必须小写字母开头、不得含 hyphen；⑤ 归档后 UI/报表直读明细会变短，按 DESIGN §7 显示汇总，
  不得把汇总当逐笔；⑥ 财政 FIFO 上限只是保护，36 月以上旧流水应由 historyPolicy 归档。

## 提交/推送（本轮）

- 本轮提交链（基线 `31b6627` 之上）：
  - `147e54c` feat(persistence)：骨架（格式/注册表/协调器/引用校验）
  - `32a0548` fix(persistence)：候选世界骨架与真实类型对齐
  - `2502e0e` docs(save)：SAVE_SYSTEM_DESIGN.md v1
  - `4d9af42` feat(v1.7)：模块/历史治理/平台层/core 委派/版本 1.7.0
  - `8504de5` test(v1.7)：persistence 10 文件 + 既有测试 v10 适配
  - `7282187` docs(v1.7)：交付报告/DESIGN/README/PLAN/PROGRESS/证据/脚本（**已推送的交付 HEAD**）
  - 推送 SHA 回填提交（HEAD，见 `git log -1`）
- **推送成功（已核验）**：`31b6627..7282187` 快进推送，随后推送回填/文档对齐提交；
  **最终本地 HEAD = `origin/feature/stock-market-ui-tax`** 以 `git log -1` 为准；
  `origin/main` 仍 `6c45000`（未合并、未改写历史）。PAT 仅作单次命令环境变量，未写入文件，验收后请撤销。
