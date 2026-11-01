export type DistrictType =
  | 'residential'
  | 'commercial'
  | 'office'
  | 'industrial'
  | 'public'
  | 'park';

export type BuildingKind = DistrictType;

export interface DistrictDefinition {
  id: string;
  name: string;
  type: DistrictType;
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  color: number;
  populationShare: number;
  jobsShare: number;
  landValueFactor: number;
  description: string;
}

export interface BuildingDefinition {
  id: string;
  name: string;
  kind: BuildingKind;
  tileX: number;
  tileY: number;
  width: number;
  height: number;
  districtId: string;
  companyId?: string;
  floors: number;
  households: number;
  jobs: number;
  rentPerMonth: number;
  note: string;
}

export interface CityLayout {
  cityId: string;
  width: number;
  height: number;
  tiles: number[][];
  districts: DistrictDefinition[];
  buildings: BuildingDefinition[];
  spawn: { x: number; y: number };
}

export const TILE_SIZE = 16;
export const MAP_WIDTH = 44;
export const MAP_HEIGHT = 32;

const PAVEMENT = 704;
const ROAD = 712;
const GRASS = 926;
const CROSSWALK = 714;

const STAMPS: Record<string, { col: number; row: number }> = {
  redRoof: { col: 0, row: 0 },
  grayRoof: { col: 9, row: 0 },
  beigeRoof: { col: 18, row: 0 },
  redWall: { col: 0, row: 5 },
  grayWall: { col: 9, row: 5 },
  beigeWall: { col: 18, row: 5 },
};

interface BuildingSpec {
  tileX: number;
  tileY: number;
  stamp: keyof typeof STAMPS;
  kind: BuildingKind;
  districtId: string;
  companyId?: string;
  nameIndex: number;
}

const BUILDING_SPECS: BuildingSpec[] = [
  // 北侧住宅区
  { tileX: 1, tileY: 1, stamp: 'redRoof', kind: 'residential', districtId: 'north-residential', nameIndex: 0 },
  { tileX: 5, tileY: 1, stamp: 'beigeRoof', kind: 'residential', districtId: 'north-residential', nameIndex: 1 },
  { tileX: 1, tileY: 5, stamp: 'redRoof', kind: 'residential', districtId: 'north-residential', nameIndex: 2 },
  { tileX: 5, tileY: 5, stamp: 'beigeRoof', kind: 'residential', districtId: 'north-residential', nameIndex: 3 },
  // 北侧商务区
  { tileX: 12, tileY: 1, stamp: 'grayRoof', kind: 'office', districtId: 'central-business', nameIndex: 0 },
  { tileX: 16, tileY: 1, stamp: 'beigeRoof', kind: 'commercial', districtId: 'central-business', nameIndex: 1 },
  { tileX: 20, tileY: 1, stamp: 'grayRoof', kind: 'office', districtId: 'central-business', nameIndex: 2 },
  { tileX: 24, tileY: 1, stamp: 'redRoof', kind: 'commercial', districtId: 'central-business', nameIndex: 3 },
  { tileX: 12, tileY: 5, stamp: 'beigeRoof', kind: 'commercial', districtId: 'central-business', nameIndex: 4 },
  { tileX: 16, tileY: 5, stamp: 'grayRoof', kind: 'office', districtId: 'central-business', nameIndex: 5 },
  { tileX: 20, tileY: 5, stamp: 'beigeRoof', kind: 'commercial', districtId: 'central-business', nameIndex: 6 },
  { tileX: 24, tileY: 5, stamp: 'grayRoof', kind: 'office', districtId: 'central-business', nameIndex: 7 },
  // 北侧公共与公园
  { tileX: 30, tileY: 1, stamp: 'beigeRoof', kind: 'public', districtId: 'civic-park', nameIndex: 0 },
  { tileX: 38, tileY: 1, stamp: 'grayRoof', kind: 'public', districtId: 'civic-park', nameIndex: 1 },
  // 中侧住宅
  { tileX: 1, tileY: 11, stamp: 'redRoof', kind: 'residential', districtId: 'west-residential', nameIndex: 4 },
  { tileX: 5, tileY: 11, stamp: 'redRoof', kind: 'residential', districtId: 'west-residential', nameIndex: 5 },
  { tileX: 1, tileY: 15, stamp: 'beigeRoof', kind: 'residential', districtId: 'west-residential', nameIndex: 6 },
  { tileX: 5, tileY: 15, stamp: 'beigeRoof', kind: 'residential', districtId: 'west-residential', nameIndex: 7 },
  // 中侧办公
  { tileX: 12, tileY: 11, stamp: 'grayRoof', kind: 'office', districtId: 'midtown-offices', nameIndex: 8 },
  { tileX: 16, tileY: 11, stamp: 'grayRoof', kind: 'office', districtId: 'midtown-offices', nameIndex: 9 },
  { tileX: 20, tileY: 11, stamp: 'beigeRoof', kind: 'commercial', districtId: 'midtown-offices', nameIndex: 8 },
  { tileX: 24, tileY: 11, stamp: 'redRoof', kind: 'commercial', districtId: 'midtown-offices', nameIndex: 9 },
  { tileX: 12, tileY: 15, stamp: 'beigeRoof', kind: 'commercial', districtId: 'midtown-offices', nameIndex: 10 },
  { tileX: 16, tileY: 15, stamp: 'grayRoof', kind: 'office', districtId: 'midtown-offices', nameIndex: 10 },
  { tileX: 20, tileY: 15, stamp: 'grayRoof', kind: 'office', districtId: 'midtown-offices', nameIndex: 11 },
  { tileX: 24, tileY: 15, stamp: 'beigeRoof', kind: 'commercial', districtId: 'midtown-offices', nameIndex: 11 },
  // 中侧工业
  { tileX: 30, tileY: 11, stamp: 'redRoof', kind: 'industrial', districtId: 'industrial-belt', nameIndex: 0, companyId: 'primary' },
  { tileX: 34, tileY: 11, stamp: 'grayRoof', kind: 'industrial', districtId: 'industrial-belt', nameIndex: 1, companyId: 'secondary' },
  { tileX: 38, tileY: 11, stamp: 'redRoof', kind: 'industrial', districtId: 'industrial-belt', nameIndex: 2, companyId: 'tertiary' },
  { tileX: 30, tileY: 15, stamp: 'grayRoof', kind: 'industrial', districtId: 'industrial-belt', nameIndex: 3, companyId: 'quaternary' },
  { tileX: 34, tileY: 15, stamp: 'beigeRoof', kind: 'industrial', districtId: 'industrial-belt', nameIndex: 4, companyId: 'quinary' },
  { tileX: 38, tileY: 15, stamp: 'redRoof', kind: 'industrial', districtId: 'industrial-belt', nameIndex: 5, companyId: 'senary' },
  // 南侧住宅
  { tileX: 1, tileY: 24, stamp: 'beigeRoof', kind: 'residential', districtId: 'south-residential', nameIndex: 8 },
  { tileX: 5, tileY: 24, stamp: 'redRoof', kind: 'residential', districtId: 'south-residential', nameIndex: 9 },
  { tileX: 1, tileY: 28, stamp: 'redRoof', kind: 'residential', districtId: 'south-residential', nameIndex: 10 },
  { tileX: 5, tileY: 28, stamp: 'beigeRoof', kind: 'residential', districtId: 'south-residential', nameIndex: 11 },
  // 南侧工业
  { tileX: 30, tileY: 24, stamp: 'grayRoof', kind: 'industrial', districtId: 'south-industry', nameIndex: 6, companyId: 'septenary' },
  { tileX: 34, tileY: 24, stamp: 'redRoof', kind: 'industrial', districtId: 'south-industry', nameIndex: 7 },
  { tileX: 38, tileY: 24, stamp: 'grayRoof', kind: 'industrial', districtId: 'south-industry', nameIndex: 8 },
  { tileX: 30, tileY: 28, stamp: 'redRoof', kind: 'industrial', districtId: 'south-industry', nameIndex: 9 },
  { tileX: 34, tileY: 28, stamp: 'beigeRoof', kind: 'industrial', districtId: 'south-industry', nameIndex: 10 },
];

const DISTRICT_TEMPLATE: Omit<DistrictDefinition, 'name' | 'description' | 'color'>[] = [
  { id: 'north-residential', type: 'residential', tileX: 1, tileY: 1, tileW: 8, tileH: 7, populationShare: 0.14, jobsShare: 0.03, landValueFactor: 0.85 },
  { id: 'central-business', type: 'commercial', tileX: 12, tileY: 1, tileW: 15, tileH: 7, populationShare: 0.06, jobsShare: 0.24, landValueFactor: 1.45 },
  { id: 'civic-park', type: 'park', tileX: 30, tileY: 1, tileW: 13, tileH: 7, populationShare: 0.02, jobsShare: 0.06, landValueFactor: 1.1 },
  { id: 'west-residential', type: 'residential', tileX: 1, tileY: 11, tileW: 8, tileH: 10, populationShare: 0.2, jobsShare: 0.02, landValueFactor: 0.8 },
  { id: 'midtown-offices', type: 'office', tileX: 12, tileY: 11, tileW: 15, tileH: 10, populationShare: 0.05, jobsShare: 0.2, landValueFactor: 1.35 },
  { id: 'industrial-belt', type: 'industrial', tileX: 30, tileY: 11, tileW: 13, tileH: 10, populationShare: 0.03, jobsShare: 0.3, landValueFactor: 0.95 },
  { id: 'south-residential', type: 'residential', tileX: 1, tileY: 24, tileW: 8, tileH: 7, populationShare: 0.18, jobsShare: 0.02, landValueFactor: 0.7 },
  { id: 'river-park', type: 'public', tileX: 12, tileY: 24, tileW: 15, tileH: 7, populationShare: 0.04, jobsShare: 0.08, landValueFactor: 1.0 },
  { id: 'south-industry', type: 'industrial', tileX: 30, tileY: 24, tileW: 13, tileH: 7, populationShare: 0.02, jobsShare: 0.15, landValueFactor: 0.85 },
];

const CITY_NAMES: Record<string, {
  districts: Record<string, { name: string; description: string }>;
  buildings: Record<BuildingKind, string[]>;
  landmark: string;
}> = {
  lanport: {
    landmark: '岚港',
    districts: {
      'north-residential': { name: '海风住宅区', description: '靠近北海堤的旧住宅区，公寓密集，通勤人口多。' },
      'central-business': { name: '港口中央商务区', description: '贸易公司、银行与写字楼集中的滨水商务带。' },
      'civic-park': { name: '灯塔公园与市民中心', description: '医院、学校与城市公园，周末人流集中。' },
      'west-residential': { name: '潮汐里', description: '中等收入家庭聚居区，靠近纺织与食品工厂。' },
      'midtown-offices': { name: '中环办公区', description: '航运、保险与消费品企业的办公楼群。' },
      'industrial-belt': { name: '北港工业带', description: '食品、纺织、日用品与能源企业的主要厂区。' },
      'south-residential': { name: '蓝湾新村', description: '近十年扩张的住宅区，年轻家庭比例较高。' },
      'river-park': { name: '青原河滨公园', description: '河岸步道、市民广场与公共设施。' },
      'south-industry': { name: '南港物流工业区', description: '仓库、能源设施与港口配套工业。' },
    },
    buildings: {
      residential: ['海风公寓', '潮汐里 3 号', '灯塔路公寓', '蓝湾花园 A 座', '旧码头公寓', '海盐街 12 号', '港湾新村 2 栋', '潮声公寓', '蓝湾花园 B 座', '南港里 7 号', '渔火公寓', '望海楼'],
      commercial: ['港口贸易中心', '海产市场', '滨水商业街', '岚港百货', '中央商场', '海运保险大厦', '咖啡与航运', '灯塔书店', '潮汐里商铺', '南港批发市场', '港湾酒店', '海风购物中心'],
      office: ['岚港航运大厦', '港务局办公楼', '区域金融中心', '贸易结算大楼', '物流调度中心', '海图科技园', '中央商务塔', '港口数据楼', '中环 9 号', '岚港商会', '滨水写字楼', '南港创新中心'],
      industrial: ['岚港食品厂', '岚港纺织厂', '岚港日用品厂', '岚港能源公司', '北港仓库', '南港冷库', '成衣车间', '食品加工二线', '港口机械库', '南港能源站', '物流分拨中心', '工业服务楼'],
      public: ['岚港市立医院', '第一中学', '市民服务中心', '港口图书馆'],
      park: ['灯塔公园', '青原河滨公园', '海风广场', '南港绿地'],
    },
  },
  ironvale: {
    landmark: '铁谷',
    districts: {
      'north-residential': { name: '炉城北里', description: '老工业住宅区，砖砌公寓与职工宿舍并存。' },
      'central-business': { name: '铁谷商业街', description: '面向工业区的批发、金融与行政服务。' },
      'civic-park': { name: '高炉纪念公园', description: '由旧厂区改造的公共空间与职业学校。' },
      'west-residential': { name: '铁西里', description: '矿工与冶金工人家庭聚居区。' },
      'midtown-offices': { name: '工业管理区', description: '矿业公司、金属贸易与工程事务所。' },
      'industrial-belt': { name: '高炉工业带', description: '金属加工、纺织与能源企业的核心厂区。' },
      'south-residential': { name: '新炉新村', description: '产业升级后新建的住宅与工人社区。' },
      'river-park': { name: '铁谷河滩公园', description: '河滩修复区、体育场与公共设施。' },
      'south-industry': { name: '南谷重工业区', description: '金属仓库、机械维修与能源设施。' },
    },
    buildings: {
      residential: ['炉城公寓', '铁西里 5 号', '矿工新村', '高炉家园', '铁谷北里', '红砖宿舍', '新炉新村 A 座', '炉火公寓', '南谷里', '铁匠街 9 号', '钢花公寓', '新炉新村 B 座'],
      commercial: ['铁谷批发市场', '金属交易行', '工业品商场', '高炉商业街', '矿工合作社', '铁谷饭店', '五金市场', '南谷商铺', '炉城百货', '工友食堂', '铁谷旅社', '工业服务市场'],
      office: ['铁谷矿业大厦', '冶金工程所', '工业调度中心', '金属贸易楼', '铁谷商会', '工程事务所', '高炉管理楼', '南谷物流办公', '工业设计院', '铁谷银行', '矿务档案楼', '新炉创新站'],
      industrial: ['铁谷金属厂', '铁谷纺织二厂', '铁谷食品厂', '铁谷能源二厂', '铁谷日用品二厂', '高炉仓库', '金属压延车间', '南谷机械厂', '焦化厂区', '铁谷冷库', '重载维修库', '南谷能源站'],
      public: ['铁谷市立医院', '工业职业学校', '矿工文化宫', '铁谷图书馆'],
      park: ['高炉纪念公园', '铁谷河滩公园', '炉火广场', '南谷绿地'],
    },
  },
  greenfield: {
    landmark: '青原',
    districts: {
      'north-residential': { name: '青禾里', description: '低层住宅与家庭农场混合的安静街区。' },
      'central-business': { name: '青原集镇中心', description: '农产品交易、农机服务与小型商业。' },
      'civic-park': { name: '谷仓公园', description: '由旧谷仓改造的公园、学校与农业推广站。' },
      'west-residential': { name: '原野西里', description: '农业合作社成员与加工厂职工的住宅区。' },
      'midtown-offices': { name: '农业服务区', description: '合作社办公、食品检测与物流调度。' },
      'industrial-belt': { name: '青原加工带', description: '谷物、纤维、食品与日用品加工企业。' },
      'south-residential': { name: '新穗新村', description: '年轻家庭与返乡就业者聚居的新住宅区。' },
      'river-park': { name: '青原河湾公园', description: '河湾湿地、步道与公共活动空间。' },
      'south-industry': { name: '南原仓储区', description: '粮食仓储、纤维堆场与能源设施。' },
    },
    buildings: {
      residential: ['青禾里 1 号', '原野公寓', '谷仓新村', '青穗家园', '农友公寓', '绿篱小筑', '新穗新村 A 座', '青原里 8 号', '河湾公寓', '麦田小院', '新穗新村 B 座', '青禾里 12 号'],
      commercial: ['青原农产品市场', '谷物交易所', '农机商行', '青禾百货', '原野集市', '种子与肥料行', '青原饭庄', '南原仓储商店', '绿野商场', '合作社门市', '青原旅店', '农资服务中心'],
      office: ['青原合作社总部', '农业检测中心', '谷物调度楼', '绿野银行', '青原商会', '食品研发站', '物流办公区', '农业推广站', '原野会计所', '青原行政楼', '南原仓储办公', '新穗服务中心'],
      industrial: ['青原谷物合作社', '青原纤维农场', '青原食品加工厂', '青原日用品厂', '青原能源站', '青原制衣厂', '谷物筒仓', '纤维堆场', '南原冷库', '食品包装线', '农机维修库', '南原能源站'],
      public: ['青原卫生院', '青原中学', '农业推广站', '青原图书馆'],
      park: ['谷仓公园', '青原河湾公园', '青禾广场', '南原绿地'],
    },
  },
};

const DISTRICT_COLORS: Record<DistrictType, number> = {
  residential: 0x4fc3f7,
  commercial: 0xf2c14e,
  office: 0xb388ff,
  industrial: 0xff8a65,
  public: 0x7ed6a5,
  park: 0x9ccc65,
};

function tileIndex(col: number, row: number): number {
  return row * 37 + col;
}

function stampTiles(tiles: number[][], originCol: number, originRow: number, stamp: keyof typeof STAMPS): void {
  const spec = STAMPS[stamp];
  if (!spec) return;
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const row = tiles[originRow + y];
      if (!row) continue;
      row[originCol + x] = tileIndex(spec.col + x, spec.row + y);
    }
  }
}

function companyOrderForCity(cityId: string, companies: { id: string; cityId: string }[]): string[] {
  const order: Record<string, string[]> = {
    lanport: ['lp-food', 'lp-textile', 'lp-appliance', 'lp-energy', 'lp-garment'],
    ironvale: ['iv-food', 'iv-textile', 'iv-metal', 'iv-energy', 'iv-appliance', 'iv-garment'],
    greenfield: ['gf-grain', 'gf-fiber', 'gf-food', 'gf-energy', 'gf-household', 'gf-garment'],
  };
  return (order[cityId] ?? []).filter((id) => companies.some((company) => company.id === id));
}

export function createCityLayout(
  cityId: string,
  companies: { id: string; cityId: string; name: string }[],
): CityLayout {
  const names = CITY_NAMES[cityId] ?? CITY_NAMES.lanport!;
  const tiles: number[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: number[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) row.push(PAVEMENT);
    tiles.push(row);
  }

  // 公园与绿地
  for (const district of DISTRICT_TEMPLATE) {
    if (district.type === 'park' || district.type === 'public') {
      for (let y = district.tileY; y < district.tileY + district.tileH; y++) {
        for (let x = district.tileX; x < district.tileX + district.tileW; x++) {
          const row = tiles[y];
          if (row && row[x] !== undefined) row[x] = GRASS;
        }
      }
    }
  }

  // 道路
  for (const roadX of [9, 10, 11, 27, 28, 29]) {
    for (let y = 0; y < MAP_HEIGHT; y++) {
      if (tiles[y]) tiles[y]![roadX] = ROAD;
    }
  }
  for (const roadY of [8, 9, 10, 21, 22, 23]) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (tiles[roadY]) tiles[roadY]![x] = ROAD;
    }
  }
  for (const [x, y] of [[10, 9], [28, 9], [10, 22], [28, 22]] as const) {
    if (tiles[y]) tiles[y]![x] = CROSSWALK;
  }

  // 公园水池与树木
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const row = tiles[2 + y];
      if (row) row[34 + x] = tileIndex(24 + x, 5 + y);
    }
  }
  const treeTiles = [401, 402, 403, 404, 405, 406, 438, 439, 440, 441, 442, 443];
  const treeSpots: [number, number][] = [
    [32, 5], [37, 3], [41, 2], [41, 6],
    [33, 6], [37, 6], [40, 5], [41, 4],
    [13, 25], [14, 28], [18, 26], [22, 24], [25, 29],
    [12, 24], [12, 28], [20, 24], [24, 28], [25, 24],
    [8, 4], [8, 6], [8, 13], [8, 17], [8, 26], [8, 29],
    [14, 7], [23, 7], [31, 7], [35, 7], [39, 7],
    [14, 20], [18, 20], [23, 20], [31, 20], [35, 20], [39, 20],
    [14, 31], [18, 31], [23, 31], [31, 31], [35, 31], [39, 31],
  ];
  treeSpots.forEach(([x, y], index) => {
    const row = tiles[y];
    if (row && row[x] !== ROAD) row[x] = treeTiles[index % treeTiles.length]!;
  });

  const districts: DistrictDefinition[] = DISTRICT_TEMPLATE.map((layout) => ({
    ...layout,
    name: names.districts[layout.id]?.name ?? layout.id,
    description: names.districts[layout.id]?.description ?? '',
    color: DISTRICT_COLORS[layout.type],
  }));

  const companyIds = companyOrderForCity(cityId, companies);
  const companyMap = new Map(companies.map((company) => [company.id, company]));
  const counters: Record<BuildingKind, number> = {
    residential: 0, commercial: 0, office: 0, industrial: 0, public: 0, park: 0,
  };

  const buildings: BuildingDefinition[] = BUILDING_SPECS.map((spec, index) => {
    stampTiles(tiles, spec.tileX, spec.tileY, spec.stamp);
    const nameList = names.buildings[spec.kind];
    let name = nameList[spec.nameIndex % nameList.length] ?? `${spec.kind} ${index}`;
    if (spec.districtId === 'industrial-belt') name = name.replace('南港', '北港');
    if (spec.districtId === 'south-industry') name = name.replace('北港', '南港');
    counters[spec.kind] += 1;
    const district = districts.find((entry) => entry.id === spec.districtId);
    const companyId =
      spec.kind === 'industrial' && counters.industrial - 1 < companyIds.length
        ? companyIds[counters.industrial - 1]
        : undefined;
    const company = companyId ? companyMap.get(companyId) : undefined;
    return {
      id: `${cityId}-b${String(index + 1).padStart(2, '0')}`,
      name: company && spec.kind === 'industrial' ? company.name : name,
      kind: spec.kind,
      tileX: spec.tileX,
      tileY: spec.tileY,
      width: 3,
      height: 3,
      districtId: spec.districtId,
      companyId,
      floors: spec.kind === 'office' ? 8 + (index % 7) : spec.kind === 'residential' ? 4 + (index % 4) : 2 + (index % 3),
      households: spec.kind === 'residential' ? 70 + ((index * 17) % 90) : 0,
      jobs: spec.kind === 'residential' ? 0 : spec.kind === 'park' ? 6 : 20 + ((index * 23) % 180),
      rentPerMonth: Math.round((district?.landValueFactor ?? 1) * (spec.kind === 'commercial' ? 38_000 : spec.kind === 'office' ? 52_000 : 14_000)),
      note:
        spec.kind === 'industrial'
          ? '厂区以固定 tile 模块拼装；企业与产能数据来自模拟层。'
          : spec.kind === 'public'
            ? '公共设施目前为展示与就业归属，不参与政策或服务产出结算。'
            : '建筑外观来自 Kenney 城市 tile 模块；住房市场尚未接入模拟。',
    };
  });

  return {
    cityId,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    tiles,
    districts,
    buildings,
    spawn: { x: 18, y: 13 },
  };
}

export function districtColor(type: DistrictType): number {
  return DISTRICT_COLORS[type];
}
