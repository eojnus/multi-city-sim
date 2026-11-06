# PROGRESS — multi-city-sim v1.6.1 交接

> 新会话第一句：`Read /workspace/Coding/multi-city-sim/PROGRESS.md and git log -8, then continue from "Next".`
> 本文件是唯一可信状态；不要从旧对话记忆推断。不要在文件里写 token。

## Goal

v1.6.1（v1.6 验收第二轮任务书）：①未成交二手挂单设备仍计维护费（挂单不能逃费）；②清算先处置
资产、再用真实清算资金偿付维护服务商（当月+旧欠，不足才坏账）→ 银行 → 股东；③存档边界：64MiB
文案修正、默认世界 72 月经实际桌面接口写入/读取/推进下月、长期方案（gzip）、自动/手动失败不覆盖；
④回归与交付：保留 v1.6 全部规则，构建/针对性测试/全量回归/Electron 实测，如实报告经济问题，推送分支。

## Done（均已验证）

- 分支 `feature/stock-market-ui-tax`；验收基线 `b266962935f5ea83d1a2831fd98508aba83658ff`（本轮开工
  HEAD=远端）；`origin/main` 仍 `6c45000efc4c406d30e22c0a12bd066fc2df61f7`（未合并、未改写历史）。
- 版本 `GAME_VERSION/package = 1.6.1`；`SAVE_FORMAT_VERSION = 9`（未升版，新字段全部 optional）。
- 提交链（基线 `b266962` 之上）：见本文件末尾“提交/推送”（推送后回填远端 SHA）。
- **§一 未成交挂单设备维护费**：`maintenance.ts` 新增 `maintenanceBilledUnits(world, company)`
  = 当前 equipment + 该企业未成交二手挂单 units（逐类）；月初快照 / 无快照直调回退 / AI
  `estimatedMonthlyMaintenance` 三处同口径；成交/撤单按月初持有时点切换责任；不影响 equipment /
  capacity / 产能重算。测试 `tests/maintenance-listing-v17.test.ts` 7 项；用户复现（2 台工业设备
  高价挂单未成交）第 2 月仍计 3,800（v1.6 为 0）。
- **§二 清算维护费偿付顺序**：`maintenance.ts` 拆两段：`planCompanyMaintenanceOnLiquidation`
  （处置前算应计，避免设备卖出后漏计）→ `settleCompanyMaintenanceOnLiquidation`（处置收入到账后：
  先付当月→旧欠→不足才坏账，`skipFinancing` 不新增借款）；`lifecycle.liquidateCompany` 顺序改为
  “设备处置收入入账 → 维护费 → 银行债务 → 股东分配”；`LiquidationRecord` 追加 5 个 optional
  对账字段（`equipmentProceeds/equipmentMaintenanceDue/Paid/ArrearsRepaid/WrittenOff`），`save.ts`
  增加数值校验。复现例：现金 0+旧欠 10,000+当月 3,800+处置 180,000 → 实付 13,800、坏账 0、股东
  166,200（v1.6：坏账 13,800、股东 180,000）。测试 `tests/liquidation-maintenance-order-v17.test.ts` 6 项。
- **§三 存档边界**：`electron/saveIpc.ts` 与 `src/platform/saveBridge.ts` 统一 64MiB 上限与文案
  `存档过大（超过 64MB / 64MiB 限制）`（读写 list 一致、写失败带 `too-large`）；72 月默认世界存档
  实测 **53,313,078B（50.8MiB，64MiB 的 79%）**，t48→t72 增长 11.78MB（≈491KB/月，约 80–90 月撞限）；
  实现桌面 **gzip 压缩**（≥4MiB、zlib 异步、落盘约 2.47MB/4.6%、21.6×；旧明文按 gzip 魔数兼容，
  list 双格式，不删任何债券/贷款/权益/追溯数据，格式版本仍 9）；渲染层上限预检改 UTF-8 字节口径；
  自动存档写失败暂停且不覆盖原档、手动失败 toast 注明原档未修改。测试 `tests/save-boundary-v17.test.ts` 18 项
  （含 72 月真实写入/读取/解析/推进实测）。
- **acceptance 重锁**：`tests/acceptance/bankruptcy-real-run.test.ts` 按 v1.6.1 真实 36 月轨迹重锁
  （F-R2 负债率 t19/27/28/36、F-R3 票息 779 笔/欠息 32 期、F-R4 计划=成交 3,199,219/持债 816、
  F-R5/F-R8 债务与贷款 35/35/34、F-R9 政策资金），重锁后 9/9 绿。
- **验证证据**：
  - `npx tsc --noEmit` = 0；`npx tsc -p tsconfig.electron.json --noEmit` = 0；`npm run build` 成功。
  - 针对性回归：维护/清算/存档/守恒等 10 文件 64/64 绿；v17 三文件 30/30 绿；save-boundary 18/18。
  - 全量回归：140 个测试文件分 12 块执行（12 文件/块，`--testTimeout=900000`）；分块结果见交付报告 §6.1。
  - Electron（生产构建 + Xvfb :99，Electron 38.8.6）：**27/27 检查通过、0 console 错误**；证据
    `docs/evidence_v1.6.1/`；含 72 月档桌面接口端到端（源 53,313,078B → 读取 3.0s → 推进 1 月
    10.7s → 写入 gzip 2,495,647B/3.3s → 再读取 3.3s；startTick 72 → advancedTick 73）。
  - 经济（如实，72 月航拍）：失业 90.9%/88.5%/81.1%；基本食品覆盖 14.0%/33.4%/30.8%；负债率
    50.2%(watch)/**98.0%(high)**/50.7%(watch)；岚港食品价触上限 121；在营企业 477、零员工 0。
  - 交付报告：`docs/development/DELIVERY_REPORT_v1.6.1.md`；README v1.6.1。

## Next（按序）

1. **等用户验收**；本轮已推送（本地=远端 SHA 见末尾）。提醒撤销本轮使用的 PAT。
2. 新会话基线确认：`git rev-parse HEAD origin/feature/stock-market-ui-tax origin/main`、
   `git status --short`、`npx tsc --noEmit`。
3. 若继续开发：分支保持不变、不 amend/rebase/force、不合并 main、每步有命令验证；开工先 `git fetch`。
4. 若继续修经济，优先看交付报告 §9：铁谷负债 98.0% 逼近 100% 破产线、高失业、食品覆盖低、
   行业集中、72 月渲染层 serializeSave 52MB（~0.8s UI 冻结，本轮未改）。
5. 待用户确认：清算偿付顺序把维护服务商排在银行债务之前（按任务书 §二）；如需银行优先只改
   `lifecycle.liquidateCompany` 一处顺序。

## Open questions

- 用户是否接受 v1.6.1；下一轮是否继续修宏观经济（高失业/食品覆盖/铁谷债务）。
- 维护费欠费在清算中的顺位是否需要改为银行优先（当前服务商优先，符合本轮任务书）。
- 是否需要把 72 月渲染层序列化开销（52MB JSON.stringify，~0.8s）优化（例如分帧/Worker），
  属既有成本，本轮未改。

## Key facts（环境与坑）

- 仓库 `/workspace/Coding/multi-city-sim`；node v24.22.1 / npm 11.19.1；**2 核 / ~2GB 容器**。
- 环境：`export HOME=/workspace/Coding/.home; export npm_config_cache=/workspace/Coding/.npm-cache`。
- 测试：`npx vitest run <files> --maxWorkers=1 --testTimeout=900000 --hookTimeout=1500000`；
  `tests/economy-stability.test.ts`（16+120+40 月）约 20–25 分钟；容器偶发
  `[vitest-worker]: Timeout calling "onTaskUpdate"`（exit≠0 但断言全绿，报告如实说明）。
  分块脚本参考 `/tmp/run-v161-chunks.sh`（临时文件，12 文件/块）；当前全量 140 个测试文件。
- **`tsc` 不检查 `scripts/`**：改报告/验收脚本后必须 `npx tsx scripts/economy-v09-report.ts
  --months=3 --checkpoints=1,3` 冒烟；Electron 验收脚本需先 `npm run build`。
- 桌面验收：先 `npm run build`，再 `DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox
  --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs`；证据目录
  `docs/evidence_v1.6.1/`。72 月档验收素材由临时脚本生成到 `/tmp/v16-acceptance/t72-save.json`
  （不在仓库；重新生成约 6–7 分钟，脚本本次已删除；需要时按交付报告 §5.2 说明用 tsx 重建）。
- 存档：`formatVersion 9`；桌面上限 64MiB（UTF-8 字节），≥4MiB gzip 落盘（`.json` 后缀 + gzip 魔数，
  旧明文兼容）。`saves:list` 的 `size` 为解压后真实字节数。
- 关键文件：`src/simulation/equipment/maintenance.ts`（计费口径/清算结算）、
  `equipment/equipment.ts`（挂单/处置）、`companies/lifecycle/lifecycle.ts`（清算顺序）、
  `contracts/types.ts`（LiquidationRecord 对账字段）、`core/save.ts`（可选字段校验）、
  `electron/saveIpc.ts` + `src/platform/saveBridge.ts` + `src/app/gameStore.ts`（存档边界/失败语义）、
  `scripts/acceptance-v09.cjs`、`scripts/economy-v09-report.ts`。
- 已踩过的坑（不要重复）：①挂单设备仍属卖方，维护费计费台数 = equipment + 未成交挂单；只影响计费
  台数，不要改 equipment/产能重算；②清算应计必须在设备处置**前**算（处置后台数已变），结算必须在
  处置收入到账**后**（否则先记坏账）；③桌面存档上限判定用 UTF-8 字节，渲染层旧 `text.length`
  对中文会放过超限文本；④压缩文件不能按明文 JSON 直接 parse，`saves:list` 必须先按 gzip 魔数分流；
  ⑤规则变更会改变 acceptance/全量轨迹，重锁数值要整段替换并注明版本，不要只改一两个断言。


## 提交/推送（本轮）

- 本轮提交链（在 `b266962935f5ea83d1a2831fd98508aba83658ff` 之上）：
  - `1c1a9d2` feat(v1.6.1)：挂单设备仍计维护费、清算维护费优先偿付、桌面存档 gzip 与 64MiB 文案
  - `d7aee46` test(v1.6.1)：3 个 v17 测试 + acceptance 按 v1.6.1 轨迹重锁 + 桌面验收扩展
  - `5e00909` docs(v1.6.1)：交付报告、README 1.6.1、PLAN/PROGRESS、桌面证据（27/27，**已推送的交付 HEAD**）
  - 推送 SHA 回填提交（HEAD，见 `git log -1`）
- **推送成功（已核验）**：`b266962..5e00909  feature/stock-market-ui-tax -> feature/stock-market-ui-tax`；
  本地 HEAD = `origin/feature/stock-market-ui-tax` = `5e00909a72b7a93a8eeb5a4bcab12b4f0beb9ca6`；
  `origin/main` 仍 `6c45000`（未合并、未改写历史）。PAT 仅作单次命令环境变量，未写入文件，验收后请撤销。
