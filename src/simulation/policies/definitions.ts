import type { PolicyDomain, PolicyId } from '../contracts/types';

/**
 * 15 项用户已确认纳入的政策。每一项都必须有对象、可操作入口、
 * 财政/税收影响与至少一项真实进入模拟的效果；具体参数集中在 data/config.ts。
 *
 * 这里只放不随数值调整的元数据（名称、领域、作用对象、实现说明），
 * 便于界面与报告逐项对应，避免把参数散落在各模块。
 */
export interface PolicyDefinition {
  id: PolicyId;
  name: string;
  domain: PolicyDomain;
  /** 政策对象的玩家可读描述。 */
  target: string;
  /** 实际进入模拟的效果摘要（交付报告与界面共用）。 */
  effect: string;
  /** 是否产生直接的财政支出。 */
  spendsTreasury: boolean;
  /** 该政策在实现中属于最小原型还是已接入既有系统。 */
  maturity: '既有系统' | '最小闭环';
}

export const POLICY_DEFINITIONS: PolicyDefinition[] = [
  {
    id: 'hiringSubsidy',
    name: '新增招聘补贴',
    domain: 'employment',
    target: '在本市新增雇佣的企业',
    effect: '按新雇员工工资比例发放一次性补贴；企业 AI 按补贴后的用工成本决定招聘，实际招聘受失业人口限制。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'retentionSubsidy',
    name: '稳岗补贴',
    domain: 'employment',
    target: '不裁员的在岗员工',
    effect: '按在岗员工工资比例按月补贴；企业 AI 按补贴后的工资成本决定裁员，保留岗位越多补贴越多。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'vocationalTraining',
    name: '职业培训',
    domain: 'employment',
    target: '本市失业居民',
    effect: '按预算培训失业居民，提高城市技能水平；技能提高企业单位员工产出与招聘匹配速度（最小技能机制）。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'publicJobs',
    name: '公共岗位计划',
    domain: 'employment',
    target: '本市失业居民',
    effect: '用财政资金扩大公共部门岗位，优先从失业人口中招聘；工资由财政按月支付。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'startupSupport',
    name: '初创扶持',
    domain: 'enterprise',
    target: '本市新成立企业',
    effect: '降低创办所需自有资本，并由财政按比例向新企业注入启动资金；不凭空生成员工或设备。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'companyRelief',
    name: '企业纾困',
    domain: 'enterprise',
    target: '现金不足且连续亏损的本市企业',
    effect: '向符合条件的企业拨付纾困资金，暂缓倒闭判定；资金来自财政，不保证企业长期存活。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'equipmentSubsidy',
    name: '设备与扩产补助',
    domain: 'industry',
    target: '进行设备/扩产投资的本市企业',
    effect: '财政承担企业扩产投资的一部分；扩产实际增加产能并消耗企业自有资金（最小设备机制）。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'keyIndustrySupport',
    name: '重点产业扶持',
    domain: 'industry',
    target: '本市选定的重点行业企业',
    effect: '重点行业企业获得有上限的生产率加成与少量拨款，实际影响产出与利润。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'researchGrant',
    name: '研发资助',
    domain: 'technology',
    target: '本市研发活动',
    effect: '财政投入转化为研究点，达到阈值提升城市科技等级，从而提高企业生产率（最小研发机制）。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'educationInvestment',
    name: '教育投入',
    domain: 'technology',
    target: '本市劳动力',
    effect: '长期、缓慢提高城市技能水平，进而影响单位员工产出与招聘匹配（最小教育机制）。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'intercityTradeSupport',
    name: '跨城贸易支持',
    domain: 'trade',
    target: '本市跨城销售企业',
    effect: '对因运输容量不足造成的该笔收益损失给予财政补偿；容量规则本身不变，企业仍少获得收益。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'transportInvestment',
    name: '交通基础设施投资',
    domain: 'trade',
    target: '城内或城际公路/铁路',
    effect: '由财政出资开工升级线路；建成后运输容量提高，同样需求下收益惩罚减轻。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'unemploymentAid',
    name: '失业救助',
    domain: 'welfare',
    target: '本市失业居民',
    effect: '按月向失业居民发放额外转移支付，提高居民可支配收入并影响下月消费；支出受财政限制。',
    spendsTreasury: true,
    maturity: '既有系统',
  },
  {
    id: 'housingSupport',
    name: '住房支持',
    domain: 'welfare',
    target: '本市住房需求',
    effect: '财政建设住房单元并发放租金补贴；住房存量影响城市迁入吸引力与租金指数（最小住房机制）。',
    spendsTreasury: true,
    maturity: '最小闭环',
  },
  {
    id: 'taxAdjustment',
    name: '税收调整',
    domain: 'fiscal',
    target: '本市个人所得税/企业所得税',
    effect: '在授权范围内调整税率；下月税收与居民可支配收入随之变化，调整记录进入财政流水。',
    spendsTreasury: false,
    maturity: '既有系统',
  },
];

export const POLICY_IDS: PolicyId[] = POLICY_DEFINITIONS.map((definition) => definition.id);

/** 玩家可读的领域名称；不要在国际界面展示内部 domain 键。 */
export const POLICY_DOMAIN_LABELS: Record<PolicyDomain, string> = {
  employment: '就业',
  enterprise: '企业',
  industry: '产业',
  technology: '科技',
  trade: '贸易',
  welfare: '民生',
  fiscal: '财政',
};

export function policyDomainLabel(domain: PolicyDomain): string {
  return POLICY_DOMAIN_LABELS[domain] ?? domain;
}

export function policyDefinition(policyId: PolicyId): PolicyDefinition {
  const definition = POLICY_DEFINITIONS.find((entry) => entry.id === policyId);
  if (!definition) throw new Error(`未知政策 ${policyId}`);
  return definition;
}

export function policyName(policyId: PolicyId): string {
  return policyDefinition(policyId).name;
}
