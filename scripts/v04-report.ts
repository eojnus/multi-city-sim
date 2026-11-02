// v0.4 代表性模拟报告脚本（只读观察，不改变游戏规则）。
// 用法：npx tsx scripts/v04-report.ts [months]
//
// 输出：居民阶层、经营者选任、银行授信/贷款/存款的关键数字，供交付报告引用。
// 这是开发/验收工具，不参与游戏运行，也不写入用户存档。

import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { currentOperator } from '../src/simulation/management/manager-pool';
import { availableCredit, creditEvaluation } from '../src/simulation/banking/credit';
import { monthlyWageBill } from '../src/simulation/companies/company';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { depositAccountFor } from '../src/simulation/banking/banking';

const months = Math.max(1, Number(process.argv[2] ?? 36));
const sim = Simulation.create();
const world = sim.state;

console.log(`=== v0.4 代表性模拟：${months} 个月（种子 ${world.seed}）===`);

for (let index = 0; index < months; index += 1) {
  const result = sim.tick();
  if (!result.ok) {
    console.log(`第 ${index + 1} 月结算失败：${result.error}`);
    break;
  }
}

const tick = world.time.tick;
console.log(`\n[时间] 第 ${tick} 期（${world.time.year} 年 ${world.time.month} 月）`);

// ---- 居民阶层 ----
console.log('\n[居民阶层]');
for (const city of world.cities) {
  const stats = world.households.lastStats.find((entry) => entry.cityId === city.id);
  const groups = householdGroupsOfCity(world, city.id);
  const people = groups.reduce((total, group) => total + group.people, 0);
  const cash = groups.reduce((total, group) => total + group.cash, 0);
  const deposits = groups.reduce(
    (total, group) => total + (depositAccountFor(world, { kind: 'household', id: group.id })?.balance ?? 0),
    0,
  );
  const tiers = stats?.tiers
    .map((tier) => `${tier.tier} ${tier.people}人(${(tier.share * 100).toFixed(1)}%, 人均${tier.perCapitaWealth.toFixed(0)})`)
    .join(' / ');
  console.log(
    `  ${city.name}: 群体人数合计 ${people} / 城市人口 ${city.population.total}；` +
      `现金 ${cash.toFixed(0)}，存款 ${deposits.toFixed(0)}，人均收入 ${stats?.perCapitaIncome.toFixed(0) ?? '-'}`,
  );
  console.log(`    阶层：${tiers ?? '无统计'}`);
}

// ---- 经营者与选任 ----
console.log('\n[经营者与选任]');
const employed = world.management.operators.filter((operator) => operator.status === 'employed');
const available = world.management.operators.filter((operator) => operator.status === 'available');
const elections = world.governance.motions.filter((motion) => motion.kind === 'operatorElection');
console.log(
  `  经营者档案 ${world.management.operators.length}（在职 ${employed.length}，人才市场 ${available.length}）；` +
    `选任议案累计 ${elections.length}（通过 ${elections.filter((m) => m.status === 'passed').length}）。`,
);
let styleChanges = 0;
for (const company of world.companies) {
  const operator = currentOperator(world, company.id);
  if (operator && operator.style !== company.ai.style) styleChanges += 1;
}
console.log(`  现任风格与企业原始风格不同的企业：${styleChanges} 家。`);

// ---- 银行 ----
console.log('\n[银行]');
const loans = world.banking.loans;
const activeLoans = loans.filter((loan) => loan.status !== 'repaid');
const totalOutstanding = activeLoans.reduce((total, loan) => total + loan.outstanding, 0);
const totalDeposits = world.banking.deposits.reduce((total, account) => total + account.balance, 0);
console.log(
  `  存款账户 ${world.banking.deposits.length} 个，存款余额合计 ${totalDeposits.toFixed(0)}；` +
    `贷款合同 ${loans.length} 笔（未结清 ${activeLoans.length}，违约 ${loans.filter((l) => l.status === 'defaulted').length}），` +
    `未偿本金合计 ${totalOutstanding.toFixed(0)}。`,
);
console.log(
  `  本月银行流量：发放本金 ${world.banking.lastMonth.principalIssued.toFixed(0)}，` +
    `收回本金 ${world.banking.lastMonth.principalRepaid.toFixed(0)}，` +
    `贷款利息收入 ${world.banking.lastMonth.interestIncome.toFixed(0)}，` +
    `存款利息支出 ${world.banking.lastMonth.interestExpense.toFixed(0)}。`,
);

// ---- 企业授信 vs 月工资 ----
console.log('\n[企业授信额度与月工资对照]');
const rows = [...world.companies]
  .sort((a, b) => b.debt - a.debt)
  .slice(0, 6)
  .map((company) => {
    const evaluation = creditEvaluation(world, { kind: 'company', id: company.id }, DEMO_CONFIG);
    const wage = monthlyWageBill(company);
    const availableNow = availableCredit(world, { kind: 'company', id: company.id }, DEMO_CONFIG);
    return {
      企业: company.name,
      月工资: wage,
      债务: company.debt,
      授信额度: evaluation.limit,
      可借: availableNow,
      额度工资月数: wage > 0 ? evaluation.limit / wage : 0,
    };
  });
for (const row of rows) {
  console.log(
    `  ${row.企业}: 月工资 ${row.月工资.toFixed(0)}，债务 ${row.债务.toFixed(0)}，` +
      `授信额度 ${row.授信额度.toFixed(0)}（≈${row.额度工资月数.toFixed(1)} 个月工资），当前可借 ${row.可借.toFixed(0)}`,
  );
}

// ---- 贷款结构与偿债压力（验收第 9 节）----
console.log('\n[贷款结构与偿债压力]');
const autoBatches = loans.filter((loan) => loan.note.includes('自动流动性批次'));
const playerCommands = loans.filter((loan) => loan.note.includes('来源：玩家指令'));
const playerApproved = loans.filter((loan) => loan.note.includes('来源：玩家批准提案'));
const planAuto = loans.filter((loan) => loan.note.includes('来源：托管授权内自动'));
const migratedDebt = loans.filter((loan) => loan.purpose === 'migratedDebt');
const everLate = loans.filter(
  (loan) => loan.missedPayments > 0 || loan.payments.some((payment) => payment.arrears > 0),
);
const activeNow = loans.filter((loan) => loan.status === 'active');
const defaultedNow = loans.filter((loan) => loan.status === 'defaulted');
const termSum = loans.reduce((total, loan) => total + loan.termMonths, 0);
console.log(
  `  合同 ${loans.length} 笔（平均期限 ${(termSum / Math.max(1, loans.length)).toFixed(1)} 个月）：` +
    `自动流动性批次 ${autoBatches.length}、托管授权内自动 ${planAuto.length}、` +
    `玩家指令 ${playerCommands.length}、玩家批准提案 ${playerApproved.length}、旧债迁移 ${migratedDebt.length}。`,
);
console.log(
  `  未偿 ${activeLoans.reduce((total, loan) => total + loan.outstanding, 0).toFixed(0)}，` +
    `未结清 ${activeNow.length}，当前违约 ${defaultedNow.length}，曾逾期/欠款 ${everLate.length}。`,
);
// 合同计数会放大压力观感（每笔自动补缺都是独立合同），这里补充借款人层面的口径。
const borrowersWithDefault = new Set(
  defaultedNow
    .filter((loan) => loan.borrower.kind === 'company')
    .map((loan) => loan.borrower.id),
);
const defaultedOutstanding = defaultedNow.reduce((total, loan) => total + loan.outstanding, 0);
console.log(
  `  借款人层面：出现违约合同的企业 ${borrowersWithDefault.size} 家；` +
    `违约合同未偿 ${defaultedOutstanding.toFixed(0)}（占全部未偿 ${((defaultedOutstanding / Math.max(1, totalOutstanding)) * 100).toFixed(1)}%）。`,
);
const liquidations = world.lifecycle.liquidations;
const liquidationRepaid = liquidations.reduce((total, item) => total + item.debtRepaid, 0);
const liquidationForgiven = liquidations.reduce((total, item) => total + item.debtForgiven, 0);
console.log(
  `  企业清算 ${liquidations.length} 次：银行实收 ${liquidationRepaid.toFixed(0)}，减免（未计入实收还款）${liquidationForgiven.toFixed(0)}。`,
);
// 下月到期本金 + 当期利息（用于判断“可借额度能否覆盖月供”）。
let nextDueTotal = 0;
for (const loan of activeLoans) {
  if (loan.nextDueTick > tick + 1) continue;
  const finalPeriod = loan.nextDueTick - loan.startTick >= loan.termMonths;
  const principal = finalPeriod ? loan.outstanding : Math.min(loan.monthlyPrincipal, loan.outstanding);
  nextDueTotal += principal + loan.outstanding * loan.rateMonthly;
}
console.log(`  全部未结清合同下月应还本息约 ${nextDueTotal.toFixed(0)}（含利息）。`);

// ---- 玩家 ----
const playerCredit = creditEvaluation(world, { kind: 'player', id: 'player' }, DEMO_CONFIG);
console.log(
  `\n[玩家] 现金 ${world.player.cash.toFixed(0)}，存款 ${(depositAccountFor(world, { kind: 'player', id: 'player' })?.balance ?? 0).toFixed(0)}，` +
    `个人授信额度 ${playerCredit.limit.toFixed(0)}，可借 ${playerCredit.available.toFixed(0)}。`,
);

// ---- 不变量 ----
console.log(`\n[不变量] 最近一期：${world.lastTick.invariants.length === 0 ? '通过' : world.lastTick.invariants.join('；')}`);
