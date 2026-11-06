// v1.7 存档系统：体积/性能报告（任务书 §七）。
//
// 默认世界（seed 20261101，玩家无操作）推进到 12/36/72/120 月，在每个检查点测量：
// - 人口、企业数、活跃/已结清贷款、债券批次与持仓、主要历史数组长度；
// - 各模块/顶层字段的未压缩 JSON 字节（新格式按 modules，旧格式按 world 顶层键）；
// - 全部原始字节、gzip 后字节（node:zlib gzipSync level 6）、原始/压缩比；
// - serialize / parse / gzip 耗时，process.memoryUsage()（rss/heapUsed）；
// - 不变量检查结果；parse 后能否继续推进 1 个月。
//
// 结果同时写 console 表与 /tmp/save-size-report.json（不入仓）。
//
// 用法：
//   npx tsx scripts/save-size-report.ts                                  # 12/36/72/120 月
//   npx tsx scripts/save-size-report.ts --months=3 --checkpoints=3       # 冒烟
//   npx tsx scripts/save-size-report.ts --checkpoints=12,36 --out=/tmp/x.json
//
// 注意：120 月约需 20–40 分钟（2 核容器）；边界任务用 --months 限制。脚本不修改世界、不写存档目录。

import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';

interface ReportRow {
  month: number;
  population: number;
  companies: number;
  loans: {
    companyActive: number;
    companySettled: number;
    companyDefaulted: number;
    householdActive: number;
    householdSettled: number;
  };
  bonds: { issuances: number; holdings: number; payments: number };
  history: Record<string, number>;
  moduleBytes: Record<string, number>;
  rawBytes: number;
  gzipBytes: number;
  gzipRatio: number;
  timings: { serializeMs: number; gzipMs: number; parseMs: number; tickMs: number };
  memory: { rssMB: number; heapUsedMB: number };
  invariantProblems: number;
  canContinue: boolean;
  format: 'modules' | 'legacy' | 'unknown';
  tick: number;
}

interface ReportFile {
  generatedAt: string;
  seed: number;
  monthsRun: number;
  checkpoints: number[];
  node: string;
  rows: ReportRow[];
  notes: string[];
}

function parseArgs(argv: string[]): { months?: number; checkpoints?: number[]; out: string } {
  const args: { months?: number; checkpoints?: number[]; out: string } = {
    out: '/tmp/save-size-report.json',
  };
  for (const arg of argv) {
    const [key, value] = arg.split('=');
    if (key === '--months' && value) args.months = Number(value);
    else if (key === '--checkpoints' && value)
      args.checkpoints = value
        .split(',')
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry > 0);
    else if (key === '--out' && value) args.out = value;
  }
  return args;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function mb(value: number): string {
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width, ' ');
}

function padEnd(value: string | number, width: number): string {
  return String(value).padEnd(width, ' ');
}

function nowMs(): number {
  return performance.now();
}

/** 贷款状态统计（企业贷款 + 居民消费贷款）。 */
function loanStats(world: any): ReportRow['loans'] {
  const companyLoans: any[] = world.banking?.loans ?? [];
  const householdLoans: any[] = world.householdFinance?.loans ?? [];
  const count = (loans: any[], statuses: string[]): number =>
    loans.filter((loan) => statuses.includes(loan.status)).length;
  return {
    companyActive: count(companyLoans, ['active', 'defaulted']),
    companySettled: count(companyLoans, ['repaid']),
    companyDefaulted: count(companyLoans, ['defaulted', 'writtenOff']),
    householdActive: count(householdLoans, ['active', 'defaulted']),
    householdSettled: count(householdLoans, ['repaid']),
  };
}

/** 主要历史数组长度（观察增长最快的结构）。 */
function historyCounts(world: any): Record<string, number> {
  const city = world.cities?.[0] ?? {};
  const counts: Record<string, number> = {
    'world.history': world.history?.length ?? 0,
    'world.log': world.log?.length ?? 0,
    'world.notifications': world.notifications?.length ?? 0,
    'fiscal.ledger': world.fiscal?.ledger?.length ?? 0,
    'banking.loans': world.banking?.loans?.length ?? 0,
    'banking.snapshots': world.banking?.snapshots?.length ?? 0,
    'householdFinance.loans': world.householdFinance?.loans?.length ?? 0,
    'householdFinance.budgets': world.householdFinance?.budgets?.length ?? 0,
    'bonds.payments': world.bonds?.payments?.length ?? 0,
    'securities.history': world.securities?.history?.length ?? 0,
    'securities.orders': world.securities?.orders?.length ?? 0,
    'securities.lastTrades': world.securities?.lastTrades?.length ?? 0,
    'equipmentMarket.offers': world.equipmentMarket?.offers?.length ?? 0,
    'equipmentMarket.maintenanceHistory': world.equipmentMarket?.maintenanceHistory?.length ?? 0,
    'lifecycle.foundings': world.lifecycle?.foundings?.length ?? 0,
    'lifecycle.liquidations': world.lifecycle?.liquidations?.length ?? 0,
    'policies.history': world.policies?.history?.length ?? 0,
    'policies.checkups': world.policies?.checkups?.length ?? 0,
    'policies.publicJobsMonths': world.policies?.publicJobsMonths?.length ?? 0,
    'taxes.historyByCity[0]': city.taxes?.historyByCity
      ? (Object.values(city.taxes.historyByCity)[0] as any[])?.length ?? 0
      : 0,
    'city.gdpHistory': city.gdpHistory?.length ?? 0,
    'governance.motions': world.governance?.motions?.length ?? 0,
    'politics.elections': world.politics?.elections?.length ?? 0,
  };
  return counts;
}

/** 各模块/字段未压缩字节：新模块格式按 modules，旧单体格式按 world 顶层键。 */
function measureModules(text: string): {
  format: ReportRow['format'];
  moduleBytes: Record<string, number>;
} {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return { format: 'unknown', moduleBytes: {} };
  }
  if (doc && typeof doc === 'object' && doc.modules && typeof doc.modules === 'object') {
    const moduleBytes: Record<string, number> = {};
    for (const [id, header] of Object.entries<any>(doc.modules)) {
      // 实体字节 = 模块头 + 数据；键名/括号等容器开销很小，按 header 整体计。
      moduleBytes[id] = bytesOf(header);
    }
    return { format: 'modules', moduleBytes };
  }
  if (doc && typeof doc === 'object' && doc.world && typeof doc.world === 'object') {
    const moduleBytes: Record<string, number> = {};
    for (const [key, value] of Object.entries<any>(doc.world)) {
      moduleBytes[key] = bytesOf(value);
    }
    return { format: 'legacy', moduleBytes };
  }
  return { format: 'unknown', moduleBytes: {} };
}

function runCheckpoint(simulation: Simulation, month: number): ReportRow {
  const world = simulation.state as any;
  const before = process.memoryUsage();

  const serializeStart = nowMs();
  const text = serializeSave(simulation.state, new Date().toISOString());
  const serializeMs = nowMs() - serializeStart;
  const rawBytes = Buffer.byteLength(text, 'utf8');

  const gzipStart = nowMs();
  const gzipBytes = gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).length;
  const gzipMs = nowMs() - gzipStart;

  const parseStart = nowMs();
  const parsed = parseSave(text);
  const parseMs = nowMs() - parseStart;
  const after = process.memoryUsage();

  const measured = measureModules(text);
  const invariantProblems = parsed.ok && parsed.world ? checkInvariants(parsed.world).length : -1;

  let canContinue = false;
  let tickMs = 0;
  if (parsed.ok && parsed.world) {
    const resumed = new Simulation(parsed.world);
    const tickStart = nowMs();
    const result = resumed.tick();
    tickMs = nowMs() - tickStart;
    canContinue = result.ok;
  }

  return {
    month,
    population: (world.cities ?? []).reduce(
      (sum: number, city: any) => sum + (city.population?.total ?? 0),
      0,
    ),
    companies: world.companies?.length ?? 0,
    loans: loanStats(world),
    bonds: {
      issuances: world.bonds?.issuances?.length ?? 0,
      holdings: world.bonds?.holdings?.length ?? 0,
      payments: world.bonds?.payments?.length ?? 0,
    },
    history: historyCounts(world),
    moduleBytes: measured.moduleBytes,
    rawBytes,
    gzipBytes,
    gzipRatio: rawBytes > 0 ? Number((rawBytes / gzipBytes).toFixed(2)) : 0,
    timings: {
      serializeMs: Number(serializeMs.toFixed(1)),
      gzipMs: Number(gzipMs.toFixed(1)),
      parseMs: Number(parseMs.toFixed(1)),
      tickMs: Number(tickMs.toFixed(1)),
    },
    memory: {
      rssMB: Number((after.rss / 1024 / 1024).toFixed(1)),
      heapUsedMB: Number((after.heapUsed / 1024 / 1024).toFixed(1)),
      sampleBeforeRssMB: Number((before.rss / 1024 / 1024).toFixed(1)),
    },
    invariantProblems,
    canContinue,
    format: measured.format,
    tick: world.time?.tick ?? 0,
  } as ReportRow;
}

function printSummary(rows: ReportRow[]): void {
  console.log('\n=== v1.7 存档体积/性能摘要（原始文本 minified JSON / gzip） ===');
  console.log(
    [
      padEnd('月', 4),
      padEnd('人口', 10),
      padEnd('企业', 5),
      padEnd('原始字节', 12),
      padEnd('gzip字节', 11),
      padEnd('压缩比', 8),
      padEnd('serialize', 10),
      padEnd('gzip', 7),
      padEnd('parse', 8),
      padEnd('rssMB', 8),
      padEnd('不变量', 6),
      padEnd('可续推', 6),
    ].join(''),
  );
  for (const row of rows) {
    console.log(
      [
        padEnd(row.month, 4),
        padEnd(row.population, 10),
        padEnd(row.companies, 5),
        padEnd(row.rawBytes, 12),
        padEnd(row.gzipBytes, 11),
        padEnd(`${row.gzipRatio}x`, 8),
        padEnd(`${row.timings.serializeMs}ms`, 10),
        padEnd(`${row.timings.gzipMs}ms`, 7),
        padEnd(`${row.timings.parseMs}ms`, 8),
        padEnd(row.memory.rssMB, 8),
        padEnd(row.invariantProblems, 6),
        padEnd(row.canContinue ? 'yes' : 'NO', 6),
      ].join(''),
    );
  }
}

function printModuleBytes(row: ReportRow): void {
  const entries = Object.entries(row.moduleBytes).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  console.log(
    `\n=== 第 ${row.month} 月各${row.format === 'modules' ? '模块' : '顶层字段'}未压缩字节（合计 ${row.rawBytes}，容器开销 ${row.rawBytes - total}） ===`,
  );
  for (const [name, value] of entries) {
    const pct = row.rawBytes > 0 ? (value / row.rawBytes) * 100 : 0;
    console.log(`${padEnd(name, 34)} ${pad(value, 12)}  ${pct.toFixed(1)}%`);
  }
}

function printHistory(row: ReportRow): void {
  console.log(`\n=== 第 ${row.month} 月主要历史数组长度 ===`);
  const entries = Object.entries(row.history).sort((a, b) => b[1] - a[1]);
  for (const [name, value] of entries) console.log(`${padEnd(name, 34)} ${pad(value, 8)}`);
  console.log(
    `贷款: 企业在贷 ${row.loans.companyActive} / 已结清 ${row.loans.companySettled} / 违约勾销 ${row.loans.companyDefaulted}；` +
      `居民在贷 ${row.loans.householdActive} / 已结清 ${row.loans.householdSettled}`,
  );
  console.log(
    `债券: 批次 ${row.bonds.issuances} / 持仓 ${row.bonds.holdings} / 流水 ${row.bonds.payments}`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const checkpoints = args.checkpoints ?? [12, 36, 72, 120];
  const maxMonth = args.months ?? Math.max(...checkpoints);
  const targets = new Set(checkpoints.filter((month) => month <= maxMonth));

  console.log(
    `v1.7 存档体积报告：seed=20261101 默认世界，推进到第 ${maxMonth} 月；检查点 ${[...targets].sort((a, b) => a - b).join(', ')}`,
  );
  const simulation = Simulation.create();
  const rows: ReportRow[] = [];
  const startedAt = nowMs();
  for (let month = 1; month <= maxMonth; month += 1) {
    const result = simulation.tick();
    if (!result.ok) throw new Error(`第 ${month} 月推进失败：${result.error}`);
    if (targets.has(month)) {
      const row = runCheckpoint(simulation, month);
      rows.push(row);
      console.log(
        `[checkpoint] month=${month} tick=${row.tick} raw=${row.rawBytes} gzip=${row.gzipBytes} ` +
          `serialize=${row.timings.serializeMs}ms parse=${row.timings.parseMs}ms invariants=${row.invariantProblems}`,
      );
    }
  }
  const elapsedMs = nowMs() - startedAt;

  printSummary(rows);
  if (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    printModuleBytes(last);
    printHistory(last);
  }

  const report: ReportFile = {
    generatedAt: new Date().toISOString(),
    seed: 20261101,
    monthsRun: maxMonth,
    checkpoints: [...targets].sort((a, b) => a - b),
    node: process.version,
    rows,
    notes: [
      `推进 ${maxMonth} 月耗时 ${(elapsedMs / 1000).toFixed(1)}s（2 核容器实测）。`,
      '原始字节 = serializeSave 输出文本的 UTF-8 字节；gzip 字节 = zlib gzipSync(level 6)。',
      'v10 模块化 API 下 serializeSave 输出 minified JSON（无美化缩进）；旧单体 API 下为 pretty JSON，原始字节会明显偏大。',
      'moduleBytes：新格式按 modules[key] 头+数据计；旧格式按 world 顶层字段计；rows 中 rawBytes 与 moduleBytes 合计之差为 JSON 容器开销。',
    ],
  };
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nJSON 报告已写入 ${args.out}`);
}

main();
