import type {
  City,
  Company,
  GoodDefinition,
  GoodId,
  Recipe,
  TradeRoute,
} from '../simulation/contracts/types';

export const GOODS: GoodDefinition[] = [
  {
    id: 'grain',
    name: '谷物',
    category: 'producer',
    unit: '单位',
    basePrice: 22,
    perCapitaMonthlyNeed: 0,
    description: '食品加工的原料，由青原谷物合作社生产。',
  },
  {
    id: 'fiber',
    name: '纤维',
    category: 'producer',
    unit: '单位',
    basePrice: 45,
    perCapitaMonthlyNeed: 0,
    description: '纺织原料，由青原纤维农场生产。',
  },
  {
    id: 'fabric',
    name: '布料',
    category: 'producer',
    unit: '单位',
    basePrice: 120,
    perCapitaMonthlyNeed: 0,
    description: '成衣的中间投入，由岚港与铁谷的纺织厂生产。',
  },
  {
    id: 'metal',
    name: '金属件',
    category: 'producer',
    unit: '单位',
    basePrice: 70,
    perCapitaMonthlyNeed: 0,
    description: '日用品生产所需的金属零部件。',
  },
  {
    id: 'energy',
    name: '能源',
    category: 'producer',
    unit: '单位',
    basePrice: 30,
    perCapitaMonthlyNeed: 0,
    description: '所有生产配方都会消耗的基础投入。',
  },
  {
    id: 'food',
    name: '食品',
    category: 'consumer',
    unit: '单位',
    basePrice: 55,
    perCapitaMonthlyNeed: 26,
    description: '居民基础消费品。',
  },
  {
    id: 'clothing',
    name: '成衣',
    category: 'consumer',
    unit: '单位',
    basePrice: 320,
    perCapitaMonthlyNeed: 1.6,
    description: '居民消费品，需求受收入约束。',
  },
  {
    id: 'household',
    name: '日用品',
    category: 'consumer',
    unit: '单位',
    basePrice: 90,
    perCapitaMonthlyNeed: 5,
    description: '居民日常消费品，使用金属件与能源生产。',
  },
  {
    id: 'farmEquipment',
    name: '农业设备',
    category: 'producer',
    unit: '台',
    basePrice: 120_000,
    perCapitaMonthlyNeed: 0,
    description: '服务农业与纤维农场的设备；企业购买后计入农场设备资产并形成产能。',
  },
  {
    id: 'industryEquipment',
    name: '工业设备',
    category: 'producer',
    unit: '台',
    basePrice: 200_000,
    perCapitaMonthlyNeed: 0,
    description: '服务食品、纺织、成衣、日用品与金属加工的设备。',
  },
  {
    id: 'energyEquipment',
    name: '能源设备',
    category: 'producer',
    unit: '台',
    basePrice: 160_000,
    perCapitaMonthlyNeed: 0,
    description: '服务能源生产企业的发电与输配设备。',
  },
];

export const RECIPES: Record<GoodId, Recipe> = {
  grain: {
    output: 'grain',
    inputs: [{ good: 'energy', qty: 0.02 }],
    description: '1 单位谷物消耗 0.02 能源（农业机械与灌溉的简化）。',
  },
  fiber: {
    output: 'fiber',
    inputs: [{ good: 'energy', qty: 0.02 }],
    description: '1 单位纤维消耗 0.02 能源。',
  },
  fabric: {
    output: 'fabric',
    inputs: [
      { good: 'fiber', qty: 0.95 },
      { good: 'energy', qty: 0.03 },
    ],
    description: '1 单位布料消耗 0.95 纤维与 0.03 能源。',
  },
  food: {
    output: 'food',
    inputs: [
      { good: 'grain', qty: 0.62 },
      { good: 'energy', qty: 0.04 },
    ],
    description: '1 单位食品消耗 0.62 谷物与 0.04 能源。',
  },
  clothing: {
    output: 'clothing',
    inputs: [
      { good: 'fabric', qty: 0.85 },
      { good: 'energy', qty: 0.03 },
    ],
    description: '1 单位成衣消耗 0.85 布料与 0.03 能源。',
  },
  metal: {
    output: 'metal',
    inputs: [{ good: 'energy', qty: 0.25 }],
    description: '1 单位金属件消耗 0.25 能源。',
  },
  energy: {
    output: 'energy',
    inputs: [],
    description: '能源生产没有建模材料投入，仅受员工、产能和资金约束（明确的演示简化）。',
  },
  household: {
    output: 'household',
    inputs: [
      { good: 'metal', qty: 0.22 },
      { good: 'energy', qty: 0.08 },
    ],
    description: '1 单位日用品消耗 0.22 金属件与 0.08 能源。',
  },
  farmEquipment: {
    output: 'farmEquipment',
    inputs: [
      { good: 'metal', qty: 900 },
      { good: 'energy', qty: 300 },
    ],
    description: '1 台农业设备消耗 900 金属件与 300 能源（首版简化配方）。',
  },
  industryEquipment: {
    output: 'industryEquipment',
    inputs: [
      { good: 'metal', qty: 1_400 },
      { good: 'energy', qty: 500 },
    ],
    description: '1 台工业设备消耗 1,400 金属件与 500 能源（首版简化配方）。',
  },
  energyEquipment: {
    output: 'energyEquipment',
    inputs: [
      { good: 'metal', qty: 1_100 },
      { good: 'energy', qty: 400 },
    ],
    description: '1 台能源设备消耗 1,100 金属件与 400 能源（首版简化配方）。',
  },
};

/**
 * 每名员工每月可生产的产出单位数（演示参数）。
 *
 * v1.0 单位标定（task-23）：设备商品（资本品）的单位是“台”，人均月产量按设备类别标定，
 * 必须与 config.equipment.catalog[kind].unitsPerWorkerMonth 保持一致（单一来源为 config，
 * 本表为运行时生产口径，tests/equipment-economics.test.ts 会校验两者相等）。
 * 旧值 0.01 台/员工/月会让 60 员工设备厂月产 0.6 台，无法支撑设备产业。
 */
export const PRODUCTIVITY: Record<GoodId, number> = {
  grain: 520,
  fiber: 180,
  fabric: 95,
  food: 120,
  clothing: 75,
  metal: 100,
  energy: 300,
  household: 140,
  farmEquipment: 0.15,
  industryEquipment: 0.08,
  energyEquipment: 0.09,
};

export interface CitySeed {
  id: string;
  name: string;
  englishName: string;
  tagline: string;
  color: string;
  region: { x: number; y: number; radius: number };
  totalPopulation: number;
  publicJobs: number;
  treasury: number;
  technology: City['technology'];
  politics: City['politics'];
  realEstate: City['realEstate'];
}

export const CITY_SEEDS: CitySeed[] = [
  {
    id: 'lanport',
    name: '岚港',
    englishName: 'Lanport',
    tagline: '港口、纺织与消费品制造中心',
    color: '#4fc3f7',
    region: { x: 232, y: 468, radius: 118 },
    totalPopulation: 120_000,
    publicJobs: 5_000,
    treasury: 60_000_000,
    technology: {
      level: 62,
      researchPoints: 1_240,
      productivityMultiplier: 1 + 62 * 0.002,
      status: 'initial-only',
      note: '科技等级以固定系数影响生产率；研发投入、技术扩散和企业研发尚未实现。',
    },
    politics: {
      approval: 54,
      rulingParty: '进步联盟',
      electionInMonths: 18,
      status: 'initial-only',
      note: '支持率仅影响迁移吸引力；选举、政党和政策系统尚未实现。',
    },
    realEstate: {
      avgHomePrice: 520_000,
      rentIndex: 112,
      vacancyRate: 0.048,
      status: 'initial-only',
      note: '房价、租金与空置率目前仅展示并参与迁移吸引力，住房市场未实现。',
    },
  },
  {
    id: 'ironvale',
    name: '铁谷',
    englishName: 'Ironvale',
    tagline: '金属加工与工业制造基地',
    color: '#ff8a65',
    region: { x: 636, y: 238, radius: 96 },
    totalPopulation: 86_000,
    publicJobs: 4_000,
    treasury: 40_000_000,
    technology: {
      level: 55,
      researchPoints: 860,
      productivityMultiplier: 1 + 55 * 0.002,
      status: 'initial-only',
      note: '科技等级以固定系数影响生产率；研发投入、技术扩散和企业研发尚未实现。',
    },
    politics: {
      approval: 47,
      rulingParty: '工业联合党',
      electionInMonths: 14,
      status: 'initial-only',
      note: '支持率仅影响迁移吸引力；选举、政党和政策系统尚未实现。',
    },
    realEstate: {
      avgHomePrice: 310_000,
      rentIndex: 94,
      vacancyRate: 0.071,
      status: 'initial-only',
      note: '房价、租金与空置率目前仅展示并参与迁移吸引力，住房市场未实现。',
    },
  },
  {
    id: 'greenfield',
    name: '青原',
    englishName: 'Greenfield',
    tagline: '农业、纤维与食品加工腹地',
    color: '#aed581',
    region: { x: 768, y: 548, radius: 86 },
    totalPopulation: 64_000,
    publicJobs: 2_300,
    treasury: 20_000_000,
    technology: {
      level: 68,
      researchPoints: 1_450,
      productivityMultiplier: 1 + 68 * 0.002,
      status: 'initial-only',
      note: '科技等级以固定系数影响生产率；研发投入、技术扩散和企业研发尚未实现。',
    },
    politics: {
      approval: 61,
      rulingParty: '绿野公民党',
      electionInMonths: 22,
      status: 'initial-only',
      note: '支持率仅影响迁移吸引力；选举、政党和政策系统尚未实现。',
    },
    realEstate: {
      avgHomePrice: 280_000,
      rentIndex: 88,
      vacancyRate: 0.083,
      status: 'initial-only',
      note: '房价、租金与空置率目前仅展示并参与迁移吸引力，住房市场未实现。',
    },
  },
];

export interface CompanySeed {
  id: string;
  name: string;
  cityId: string;
  sector: Company['sector'];
  recipeOutput: GoodId;
  employees: number;
  wageRate: number;
  priceFactor: number;
  /** v1.0：【可选】开局流动资金（月工资倍数）；缺省沿用 config.company.initialCashWageMonths。 */
  initialCashWageMonths?: number;
  note: string;
}

export const COMPANY_SEEDS: CompanySeed[] = [
  {
    id: 'lp-food',
    name: '岚港食品厂',
    cityId: 'lanport',
    sector: 'food',
    recipeOutput: 'food',
    employees: 27_000,
    wageRate: 4_600,
    priceFactor: 0.99,
    note: '岚港最大的私营雇主，依赖本地与青原谷物。',
  },
  {
    id: 'lp-garment',
    name: '岚港成衣厂',
    cityId: 'lanport',
    sector: 'garment',
    recipeOutput: 'clothing',
    employees: 2_200,
    wageRate: 4_600,
    priceFactor: 1.0,
    note: '成衣出口导向企业，布料来自本地纺织厂。',
  },
  {
    id: 'lp-appliance',
    name: '岚港日用品厂',
    cityId: 'lanport',
    sector: 'appliance',
    recipeOutput: 'household',
    employees: 4_000,
    wageRate: 4_600,
    priceFactor: 1.01,
    note: '生产居民日用品，金属件由铁谷供应。',
  },
  {
    id: 'lp-energy',
    name: '岚港能源公司',
    cityId: 'lanport',
    sector: 'utility',
    recipeOutput: 'energy',
    employees: 1_200,
    wageRate: 4_600,
    priceFactor: 0.98,
    note: '区域性电力与燃料供应商，生产不建模材料投入。',
  },
  {
    id: 'lp-textile',
    name: '岚港纺织厂',
    cityId: 'lanport',
    sector: 'textile',
    recipeOutput: 'fabric',
    employees: 1_700,
    wageRate: 4_600,
    priceFactor: 1.0,
    note: '为成衣厂提供布料，并向铁谷出口。',
  },
  {
    id: 'iv-food',
    name: '铁谷食品厂',
    cityId: 'ironvale',
    sector: 'food',
    recipeOutput: 'food',
    employees: 16_000,
    wageRate: 4_600,
    priceFactor: 1.02,
    note: '工业城市的大型食品加工企业。',
  },
  {
    id: 'iv-metal',
    name: '铁谷金属厂',
    cityId: 'ironvale',
    sector: 'metal',
    recipeOutput: 'metal',
    employees: 2_600,
    wageRate: 4_600,
    priceFactor: 0.99,
    note: '为日用品行业提供金属零部件。',
  },
  {
    id: 'iv-garment',
    name: '铁谷制衣厂',
    cityId: 'ironvale',
    sector: 'garment',
    recipeOutput: 'clothing',
    employees: 2_500,
    wageRate: 4_600,
    priceFactor: 1.0,
    note: '部分布料从岚港输入。',
  },
  {
    id: 'iv-energy',
    name: '铁谷能源二厂',
    cityId: 'ironvale',
    sector: 'utility',
    recipeOutput: 'energy',
    employees: 1_000,
    wageRate: 4_600,
    priceFactor: 1.0,
    note: '服务重工业的能源企业。',
  },
  {
    id: 'iv-textile',
    name: '铁谷纺织二厂',
    cityId: 'ironvale',
    sector: 'textile',
    recipeOutput: 'fabric',
    employees: 1_500,
    wageRate: 4_600,
    priceFactor: 1.01,
    note: '本地成衣厂的第二布料来源。',
  },
  {
    id: 'iv-appliance',
    name: '铁谷日用品二厂',
    cityId: 'ironvale',
    sector: 'appliance',
    recipeOutput: 'household',
    employees: 2_500,
    wageRate: 4_600,
    priceFactor: 0.99,
    note: '利用本地金属件生产日用品。',
  },
  {
    id: 'gf-grain',
    name: '青原谷物合作社',
    cityId: 'greenfield',
    sector: 'agriculture',
    recipeOutput: 'grain',
    employees: 8_500,
    wageRate: 4_600,
    priceFactor: 0.97,
    note: '区域谷物主要供应者，向岚港与铁谷食品厂出口。',
  },
  {
    id: 'gf-fiber',
    name: '青原纤维农场',
    cityId: 'greenfield',
    sector: 'fiber-farm',
    recipeOutput: 'fiber',
    employees: 1_600,
    wageRate: 4_600,
    priceFactor: 0.98,
    note: '为纺织行业提供纤维原料。',
  },
  {
    id: 'gf-food',
    name: '青原食品加工厂',
    cityId: 'greenfield',
    sector: 'food',
    recipeOutput: 'food',
    employees: 8_000,
    wageRate: 4_600,
    priceFactor: 1.03,
    note: '本地食品加工企业，规模小于岚港食品厂。',
  },
  {
    id: 'gf-household',
    name: '青原日用品厂',
    cityId: 'greenfield',
    sector: 'appliance',
    recipeOutput: 'household',
    employees: 2_000,
    wageRate: 4_600,
    priceFactor: 1.0,
    note: '面向本地与周边市场的日用品企业。',
  },
  {
    id: 'gf-energy',
    name: '青原能源站',
    cityId: 'greenfield',
    sector: 'utility',
    recipeOutput: 'energy',
    employees: 600,
    wageRate: 4_600,
    priceFactor: 1.01,
    note: '青原本地能源站，为谷物、纤维、食品和日用品生产供能。',
  },
  {
    id: 'gf-garment',
    name: '青原制衣厂',
    cityId: 'greenfield',
    sector: 'garment',
    recipeOutput: 'clothing',
    employees: 1_000,
    wageRate: 4_600,
    priceFactor: 1.02,
    note: '青原本地成衣供应者，布料主要从岚港输入。',
  },
];

/**
 * v1.0：开局扩充企业。
 *
 * 每座城市在原有企业之外新增 16 家（食品 3、谷物 3、能源 2、金属 1、
 * 设备制造 3、纤维/纺织/成衣/日用品 4），使各城形成可互相供应的产业链。
 * 规模按本地居民与企业需求、原料供应、设备与劳动产能估算；设备台数由
 * initializer 依员工数与设备单位经济反推，不在此处双写。全部资产在初始化
 * 阶段一次性创建（属于开局前已有资产），旧存档读取不会追加。
 */
interface OpeningCompanyEntry {
  suffix: string;
  name: string;
  sector: Company['sector'];
  output: GoodId;
  employees: number;
  priceFactor: number;
  /** 设备厂首月要采购金属/能源，流动资金按 4 个月工资预留；其余企业沿用全局默认。 */
  cashMonths?: number;
  note: string;
}

function openingEntries(): OpeningCompanyEntry[] {
  return [
    // 食品加工 3 家：承接城市基本食品需求，规模按人口×人均需要与现有产能估算。
    { suffix: 'food2', name: '食品二厂', sector: 'food', output: 'food', employees: 4_000, priceFactor: 1.01, note: '第二家食品加工企业，面向本地基本食品需求。' },
    { suffix: 'food3', name: '食品三厂', sector: 'food', output: 'food', employees: 3_600, priceFactor: 1.02, note: '中型食品加工企业，补充本地食品供给。' },
    { suffix: 'food4', name: '食品四厂', sector: 'food', output: 'food', employees: 3_200, priceFactor: 1.03, note: '小型食品加工企业，服务本地与邻近市场。' },
    // 谷物/农业 3 家：降低对青原单一谷物来源的依赖。
    { suffix: 'grain2', name: '谷物二厂', sector: 'agriculture', output: 'grain', employees: 2_000, priceFactor: 0.98, note: '本地谷物种植，供应城市食品与饲料链。' },
    { suffix: 'grain3', name: '谷物三厂', sector: 'agriculture', output: 'grain', employees: 1_900, priceFactor: 0.99, note: '本地谷物种植合作社，补充区域粮食供给。' },
    { suffix: 'grain4', name: '谷物四厂', sector: 'agriculture', output: 'grain', employees: 1_800, priceFactor: 1.0, note: '小型谷物农场，面向本地食品企业。' },
    // 能源 2 家：为新增加的食品/谷物/设备产能供能。
    // v1.2 校准：原 800/700 人使每城能源劳动产能约 0.64M/月，而开局能源需求约 0.45M/月，
    // 叠加原有能源站后长期约 2 倍过剩 → 价格跌到地板、能源企业现金耗尽 → 粮食缺能停产。
    // 按开局需求估到约 0.54M/月（含原有能源站），留出短缺时的招聘空间。
    { suffix: 'energy2', name: '能源二厂', sector: 'utility', output: 'energy', employees: 300, priceFactor: 0.99, note: '本地第二座能源站，服务新增工业产能。' },
    { suffix: 'energy3', name: '能源三厂', sector: 'utility', output: 'energy', employees: 260, priceFactor: 1.01, note: '分布式能源站，补充城市能源供给。' },
    // 金属/基础材料 1 家：为设备与日用品企业供应金属件。
    { suffix: 'metal2', name: '金属二厂', sector: 'metal', output: 'metal', employees: 1_200, priceFactor: 1.0, note: '金属件加工企业，供应本地设备与日用品生产。' },
    // 设备制造 3 家：农业、工业、能源设备各一家，形成世界内真实设备来源。
    { suffix: 'farm-equipment', name: '农机设备厂', sector: 'equipment', output: 'farmEquipment', employees: 60, priceFactor: 1.0, cashMonths: 4, note: '农业设备制造企业，向本地与跨城农场出售农机。' },
    { suffix: 'industry-equipment', name: '工业设备厂', sector: 'equipment', output: 'industryEquipment', employees: 60, priceFactor: 1.02, cashMonths: 4, note: '工业设备制造企业，供应食品、纺织、成衣与金属企业。' },
    { suffix: 'energy-equipment', name: '能源设备厂', sector: 'equipment', output: 'energyEquipment', employees: 60, priceFactor: 1.0, cashMonths: 4, note: '能源设备制造企业，服务本地与跨城能源站。' },
    // 纤维/纺织/成衣/日用品合计 4 家：补齐该城原产业链缺口。
    { suffix: 'fiber2', name: '纤维农场', sector: 'fiber-farm', output: 'fiber', employees: 1_200, priceFactor: 1.0, note: '本地纤维种植，为纺织企业提供原料。' },
    { suffix: 'textile3', name: '纺织三厂', sector: 'textile', output: 'fabric', employees: 1_800, priceFactor: 1.0, note: '本地布料生产企业，供应成衣与出口市场。' },
    { suffix: 'garment3', name: '成衣三厂', sector: 'garment', output: 'clothing', employees: 1_500, priceFactor: 1.02, note: '成衣制造企业，面向本地居民消费。' },
    { suffix: 'appliance3', name: '日用品三厂', sector: 'appliance', output: 'household', employees: 1_500, priceFactor: 1.0, note: '日用品制造企业，服务本地居民日常消费。' },
  ];
}

function openingCompanySeeds(cityId: string, cityName: string, prefix: string): CompanySeed[] {
  return openingEntries().map((entry) => ({
    id: `${prefix}-${entry.suffix}`,
    name: `${cityName}${entry.name}`,
    cityId,
    sector: entry.sector,
    recipeOutput: entry.output,
    employees: entry.employees,
    wageRate: 4_600,
    priceFactor: entry.priceFactor,
    initialCashWageMonths: entry.cashMonths,
    note: entry.note,
  }));
}

/** 三城各自新增的 16 家开局企业（共 48 家；加上原有 17 家，新开局共 65 家）。 */
export const OPENING_COMPANIES: CompanySeed[] = [
  ...openingCompanySeeds('lanport', '岚港', 'lp'),
  ...openingCompanySeeds('ironvale', '铁谷', 'iv'),
  ...openingCompanySeeds('greenfield', '青原', 'gf'),
];

export const TRADE_ROUTE_SEEDS: TradeRoute[] = [
  {
    id: 'route-grain-lanport',
    fromCityId: 'greenfield',
    toCityId: 'lanport',
    fromCompanyId: 'gf-grain',
    toCompanyId: 'lp-food',
    good: 'grain',
    monthlyTarget: 1_900_000,
    distanceKm: 186,
    active: true,
    note: '青原谷物 → 岚港食品厂，区域主粮供应链；运输成本尚未模拟。',
  },
  {
    id: 'route-grain-ironvale',
    fromCityId: 'greenfield',
    toCityId: 'ironvale',
    fromCompanyId: 'gf-grain',
    toCompanyId: 'iv-food',
    good: 'grain',
    monthlyTarget: 1_000_000,
    distanceKm: 240,
    active: true,
    note: '青原谷物 → 铁谷食品厂，工业城市的主粮输入。',
  },
  {
    id: 'route-fiber-lanport',
    fromCityId: 'greenfield',
    toCityId: 'lanport',
    fromCompanyId: 'gf-fiber',
    toCompanyId: 'lp-textile',
    good: 'fiber',
    monthlyTarget: 160_000,
    distanceKm: 186,
    active: true,
    note: '青原纤维 → 岚港纺织厂。',
  },
  {
    id: 'route-fiber-ironvale',
    fromCityId: 'greenfield',
    toCityId: 'ironvale',
    fromCompanyId: 'gf-fiber',
    toCompanyId: 'iv-textile',
    good: 'fiber',
    monthlyTarget: 145_000,
    distanceKm: 240,
    active: true,
    note: '青原纤维 → 铁谷纺织二厂。',
  },
  {
    id: 'route-metal-lanport',
    fromCityId: 'ironvale',
    toCityId: 'lanport',
    fromCompanyId: 'iv-metal',
    toCompanyId: 'lp-appliance',
    good: 'metal',
    monthlyTarget: 140_000,
    distanceKm: 240,
    active: true,
    note: '铁谷金属件 → 岚港日用品厂。',
  },
  {
    id: 'route-metal-greenfield',
    fromCityId: 'ironvale',
    toCityId: 'greenfield',
    fromCompanyId: 'iv-metal',
    toCompanyId: 'gf-household',
    good: 'metal',
    monthlyTarget: 60_000,
    distanceKm: 210,
    active: true,
    note: '铁谷金属件 → 青原日用品厂。',
  },
  {
    id: 'route-fabric-ironvale',
    fromCityId: 'lanport',
    toCityId: 'ironvale',
    fromCompanyId: 'lp-textile',
    toCompanyId: 'iv-garment',
    good: 'fabric',
    monthlyTarget: 20_000,
    distanceKm: 240,
    active: true,
    note: '岚港布料 → 铁谷制衣厂，补充本地布料缺口。',
  },
  {
    id: 'route-fabric-greenfield',
    fromCityId: 'lanport',
    toCityId: 'greenfield',
    fromCompanyId: 'lp-textile',
    toCompanyId: 'gf-garment',
    good: 'fabric',
    monthlyTarget: 72_000,
    distanceKm: 186,
    active: true,
    note: '岚港布料 → 青原制衣厂。',
  },
];

export const REGION_LINKS: { from: string; to: string; label: string }[] = [
  { from: 'lanport', to: 'ironvale', label: '滨海公路' },
  { from: 'ironvale', to: 'greenfield', label: '山谷铁路' },
  { from: 'greenfield', to: 'lanport', label: '青原河运' },
];
