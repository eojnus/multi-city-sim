// 经营者人才市场：经营者档案的确定性生成、任职/离任、风格查询与池规模控制。
//
// 【演示规则（用户已确认方向，数值见 config.management）】
// - 每个企业在任经营者决定其经营风格；没有 AI 经营者时回退公司 ai.style（旧存档行为不变）。
// - AI 经营者同一时间只能经营一家企业；玩家本人不受此限制（玩家不是 OperatorProfile）。
// - 经营者档案的权威在 world.management.operators；控制权权威在 world.governance.controls。
//   两者通过 control.operatorId 关联：control.operator==='management' + operatorId 表示 AI 经营者；
//   control.operator==='player' 表示玩家经营，operatorId 必须为 null。
// - 本文件不 import governance.ts（governance → elections → manager-pool，
//   这里反向 import 会形成不必要的环）；controls 的补写直接操作权威数组。
//
// 确定性：姓名/风格/声望全部由 world.seed + 城市 id + 序号哈希得出，
// 不消耗 world.rngState（避免改变既有随机序列），也不使用 Math.random / Date.now。

import type {
  Company,
  CompanyControl,
  CompanyStyle,
  ManagementState,
  OperatorProfile,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { OPERATOR_STYLE_DESCRIPTIONS, OPERATOR_STYLE_LABELS } from './types';

const OPERATOR_NOTE = '演示经营者：姓名、风格与声誉为确定性生成，不代表最终人事制度。';
const MANAGEMENT_CONTROL_NOTE = '演示：AI 经营者由市场选任产生；持股本身不直接带来经营权。';
/** 每名经营者最多保留的任职历史条数，避免存档无限增长。 */
const MAX_TENURE_HISTORY = 20;

const SURNAMES = [
  '赵',
  '钱',
  '孙',
  '李',
  '周',
  '吴',
  '郑',
  '王',
  '冯',
  '陈',
  '沈',
  '韩',
  '杨',
  '朱',
  '秦',
  '许',
  '何',
  '顾',
];
const GIVEN_NAMES = [
  '子墨',
  '云帆',
  '承宇',
  '若水',
  '嘉树',
  '明远',
  '静姝',
  '亦舟',
  '文轩',
  '思南',
  '柏川',
  '知微',
  '亦航',
  '书禾',
  '清和',
  '望舒',
  '星河',
  '宛宁',
  '正言',
  '令仪',
];
const STYLE_ORDER: CompanyStyle[] = ['growth', 'steady', 'return'];

/** FNV-1a 风格的字符串哈希；只用于演示数据的确定性生成。 */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function styleFromHash(hash: number): CompanyStyle {
  return STYLE_ORDER[hash % STYLE_ORDER.length] ?? 'steady';
}

/** 经营者 id 约定：`op-${cityId}-${序号}`；城市归属由 id 前缀承载（契约里没有 cityId 字段）。 */
export function operatorCityId(operator: OperatorProfile): string | null {
  const match = /^op-(.+)-(\d+)$/.exec(operator.id);
  return match?.[1] ?? null;
}

function operatorIdPrefix(cityId: string): string {
  return `op-${cityId}-`;
}

/** 确保 world.management 存在且字段合法；旧存档/测试最小世界可能还没有该字段。 */
export function ensureManagementState(world: WorldState): ManagementState {
  const existing = world.management as ManagementState | undefined;
  if (!existing || typeof existing !== 'object') {
    const created: ManagementState = {
      operators: [],
      playerOperations: [],
      nextOperatorNumber: 1,
    };
    world.management = created;
    return created;
  }
  if (!Array.isArray(existing.operators)) existing.operators = [];
  if (!Array.isArray(existing.playerOperations)) existing.playerOperations = [];
  if (!Number.isFinite(existing.nextOperatorNumber) || existing.nextOperatorNumber < 1) {
    existing.nextOperatorNumber = 1;
  }
  return existing;
}

/** 确保 governance 的 boards/motions/controls 数组存在（不导出契约、不触碰规则）。 */
function ensureGovernanceRecords(world: WorldState): void {
  const governance = world.governance as
    | { boards: unknown[]; motions: unknown[]; controls: CompanyControl[] }
    | undefined;
  if (!governance || typeof governance !== 'object') {
    world.governance = { boards: [], motions: [], controls: [] };
    return;
  }
  if (!Array.isArray(governance.boards)) governance.boards = [];
  if (!Array.isArray(governance.motions)) governance.motions = [];
  if (!Array.isArray(governance.controls)) governance.controls = [];
}

function operatorNameForId(world: WorldState, id: string): string {
  const hash = hashString(`${world.seed}:${id}`);
  const surname = SURNAMES[hash % SURNAMES.length] ?? '林';
  const given = GIVEN_NAMES[(hash >>> 8) % GIVEN_NAMES.length] ?? '知远';
  return `${surname}${given}`;
}

/**
 * 确定性生成一名经营者档案并加入人才市场（status='available'）。
 * 供选任候选人不足时补人、也供旧存档迁移使用；不改变企业资产。
 */
export function generateOperator(
  world: WorldState,
  cityId: string,
  tick: number,
  style?: CompanyStyle,
): OperatorProfile {
  const state = ensureManagementState(world);
  // 用单调递增的序号生成 id，避免人才池淘汰后 id 被复用（审计/候选人引用需要稳定 id）。
  let suffix = Math.max(1, Math.floor(state.nextOperatorNumber));
  let id = `${operatorIdPrefix(cityId)}${suffix}`;
  while (state.operators.some((operator) => operator.id === id)) {
    suffix += 1;
    id = `${operatorIdPrefix(cityId)}${suffix}`;
  }
  const hash = hashString(`${world.seed}:${id}`);
  const operator: OperatorProfile = {
    id,
    name: operatorNameForId(world, id),
    style: style ?? styleFromHash(hash >>> 3),
    reputation: round2(0.35 + ((hash >>> 5) % 60) / 100),
    status: 'available',
    companyId: null,
    appointedTick: null,
    termEndTick: null,
    history: [],
    note:
      tick >= 0
        ? `${OPERATOR_NOTE}最近一次进入人才市场：第 ${tick} 月。`
        : OPERATOR_NOTE,
  };
  state.operators.push(operator);
  state.nextOperatorNumber = Math.max(state.nextOperatorNumber, suffix + 1);
  return operator;
}

/** 按 id 查找经营者档案（含已任职与人才市场待选）。 */
export function operatorById(world: WorldState, id: string): OperatorProfile | undefined {
  return world.management?.operators?.find((operator) => operator.id === id);
}

/** 企业现任 AI 经营者；玩家经营或职业经理人经营时返回 null。 */
export function currentOperator(world: WorldState, companyId: string): OperatorProfile | null {
  const control = world.governance?.controls?.find((entry) => entry.companyId === companyId);
  if (!control) return null;
  if (control.operator !== 'management') return null;
  if (!control.operatorId) return null;
  return operatorById(world, control.operatorId) ?? null;
}

/**
 * 企业当前的经营风格：现任 AI 经营者的风格优先，否则回退 company.ai.style。
 * 旧存档/新成立企业可能暂时没有经营者档案，此时必须安全回退（不抛错）。
 */
export function currentStyle(world: WorldState, company: Company): CompanyStyle {
  const operator = currentOperator(world, company.id);
  if (operator) return operator.style;
  return company.ai?.style ?? 'steady';
}

/** 界面展示用的经营者名称；无 AI 经营者时返回“职业经理人”。 */
export function operatorNameFor(world: WorldState, companyId: string): string {
  const control = world.governance?.controls?.find((entry) => entry.companyId === companyId);
  if (control && control.operator !== 'management' && control.operator.type === 'player') {
    return world.player?.name ? `玩家 · ${world.player.name}` : '玩家';
  }
  const operator = currentOperator(world, companyId);
  if (operator) return operator.name;
  return '职业经理人';
}

/** 人才市场待选经营者；可按城市过滤（跨城参选暂不限制）。 */
export function availableOperators(world: WorldState, cityId?: string): OperatorProfile[] {
  const operators = world.management?.operators ?? [];
  return operators
    .filter((operator) => operator.status === 'available')
    .filter((operator) => !cityId || operatorCityId(operator) === cityId)
    .sort((a, b) => b.reputation - a.reputation || a.id.localeCompare(b.id));
}

/** 风格可读标签（界面使用）。 */
export function operatorStyleLabel(style: CompanyStyle): string {
  return OPERATOR_STYLE_LABELS[style] ?? '稳健型';
}

/** 风格可读说明（界面使用）。 */
export function operatorStyleDescription(style: CompanyStyle): string {
  return OPERATOR_STYLE_DESCRIPTIONS[style] ?? OPERATOR_STYLE_DESCRIPTIONS.steady;
}

function sortedCompanies(world: WorldState): Company[] {
  return [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
}

function findControl(world: WorldState, companyId: string): CompanyControl | undefined {
  return world.governance?.controls?.find((entry) => entry.companyId === companyId);
}

function ensureControl(world: WorldState, companyId: string, tick: number): CompanyControl {
  ensureGovernanceRecords(world);
  const existing = findControl(world, companyId);
  if (existing) {
    if (existing.operatorId === undefined) existing.operatorId = null;
    if (existing.termEndTick === undefined) existing.termEndTick = null;
    return existing;
  }
  const control: CompanyControl = {
    companyId,
    operator: 'management',
    basis: 'management',
    sinceTick: tick,
    operatorId: null,
    termEndTick: null,
    note: MANAGEMENT_CONTROL_NOTE,
  };
  world.governance.controls.push(control);
  return control;
}

/** 让一名经营者就任某企业：同时写控制权与经营者档案，保持两处一致。 */
export function employOperator(
  world: WorldState,
  operatorId: string,
  companyId: string,
  tick: number,
  termEndTick: number | null,
  reason: string,
): void {
  const state = ensureManagementState(world);
  ensureGovernanceRecords(world);
  const operator = state.operators.find((entry) => entry.id === operatorId);
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!operator || !company) return;

  // AI 经营者同一时间只能经营一家企业：若已在别处任职，先离任（留痕）。
  if (operator.status === 'employed' && operator.companyId && operator.companyId !== companyId) {
    releaseOperator(world, operatorId, tick, `转任${company.name}（${reason}）`);
  }

  // 该企业若已有另一名 AI 经营者，先让其离任，避免一司两名“现任”。
  const control = ensureControl(world, companyId, tick);
  if (control.operatorId && control.operatorId !== operatorId) {
    const previous = state.operators.find((entry) => entry.id === control.operatorId);
    if (previous) releaseOperator(world, previous.id, tick, `由 ${operator.name} 接任（${reason}）`);
  }

  const continuing = control.operatorId === operator.id;
  control.operator = 'management';
  control.operatorId = operator.id;
  control.basis = 'election';
  // 同一人连任时保留原来的控制权起始时间；新任职/新任者从本 tick 起算。
  if (!continuing) control.sinceTick = tick;
  control.termEndTick = termEndTick;
  control.note = `${MANAGEMENT_CONTROL_NOTE}现任：${operator.name}（${operatorStyleLabel(operator.style)}）。`;

  operator.status = 'employed';
  operator.companyId = company.id;
  operator.appointedTick = tick;
  operator.termEndTick = termEndTick;
  operator.note =
    termEndTick === null
      ? `现任 ${company.name} 经营者（选任）。`
      : `现任 ${company.name} 经营者（选任，任期至第 ${termEndTick} 月）。`;
}

/**
 * 经营者离任：记入任职历史并回到人才市场，同时清空对应控制记录的经营档案引用。
 * 控制权本身不在这里改写（由选任结果决定），只把 operatorId 置空等待选任。
 */
export function releaseOperator(world: WorldState, operatorId: string, tick: number, reason: string): void {
  const state = ensureManagementState(world);
  const operator = state.operators.find((entry) => entry.id === operatorId);
  if (!operator) return;

  if (operator.status === 'employed' && operator.companyId) {
    const company = world.companies.find((entry) => entry.id === operator.companyId);
    operator.history.push({
      companyId: operator.companyId,
      companyName: company?.name ?? operator.companyId,
      fromTick: operator.appointedTick ?? tick,
      toTick: tick,
      reason,
    });
    while (operator.history.length > MAX_TENURE_HISTORY) operator.history.shift();

    const control = world.governance?.controls?.find(
      (entry) => entry.companyId === operator.companyId && entry.operatorId === operator.id,
    );
    if (control) {
      control.operatorId = null;
      control.termEndTick = null;
      control.note = `原经营者已离任（${reason}），等待选任。`;
    }
  }

  operator.status = 'available';
  operator.companyId = null;
  operator.appointedTick = null;
  operator.termEndTick = null;
  operator.note = `人才市场待选（${reason}）。`;
}

/** 某个企业是否已在本次窗口提出选任议案（选任进行中不补人，让空缺走选任流程）。 */
function hasOpenElection(world: WorldState, companyId: string): boolean {
  return (world.governance?.motions ?? []).some(
    (motion) =>
      motion.companyId === companyId &&
      motion.kind === 'operatorElection' &&
      motion.status === 'open',
  );
}

/** 企业是否存在有投票权股份持有人（决定空缺能否通过股东选任解决）。 */
function hasVotingHolders(world: WorldState, companyId: string): boolean {
  const votingClassIds = new Set(
    (world.securities?.classes ?? [])
      .filter((shareClass) => shareClass.companyId === companyId && shareClass.kind === 'voting')
      .map((shareClass) => shareClass.id),
  );
  if (votingClassIds.size === 0) return false;
  return (world.securities?.holdings ?? []).some(
    (holding) =>
      holding.companyId === companyId &&
      holding.shares > 0 &&
      votingClassIds.has(holding.shareClassId),
  );
}

function selectOperator(
  world: WorldState,
  state: ManagementState,
  company: Company,
  desiredStyle: CompanyStyle,
  usedOperatorIds: Set<string>,
): OperatorProfile {
  const cityId = company.cityId;
  const candidates = state.operators.filter(
    (operator) =>
      operator.status === 'available' &&
      !usedOperatorIds.has(operator.id) &&
      !(world.governance?.motions ?? []).some(
        (motion) =>
          motion.status === 'open' &&
          motion.kind === 'operatorElection' &&
          (motion.candidates ?? []).some((candidate) => candidate.operatorId === operator.id),
      ),
  );
  candidates.sort((a, b) => {
    // 优先复用“风格匹配”的人才，保证旧存档企业行为不因引入经营者而突变。
    const aStyle = a.style === desiredStyle ? 0 : 1;
    const bStyle = b.style === desiredStyle ? 0 : 1;
    if (aStyle !== bStyle) return aStyle - bStyle;
    const aLocal = operatorCityId(a) === cityId ? 0 : 1;
    const bLocal = operatorCityId(b) === cityId ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    return b.reputation - a.reputation || a.id.localeCompare(b.id);
  });
  const picked = candidates[0];
  if (picked) return picked;
  // 人才市场不足时确定性生成一名风格匹配的新人，保证“每家企业都有在任经营者”且风格不突变。
  return generateOperator(world, cityId, world.time.tick, desiredStyle);
}

/**
 * 幂等补齐经营者任职关系（迁移与每月结算的安全网）。
 * - 保留仍然一致的在任经营者（不重置任期起点）；
 * - 为“空缺且没有进行中的选任”企业补人，优先复用人才市场，风格尽量匹配 company.ai.style；
 * - 清理未被任何控制记录引用的“已任职”档案，保证 AI 不会同时任职两家。
 */
export function ensureOperators(world: WorldState, config: DemoConfig, tick: number): void {
  const state = ensureManagementState(world);
  ensureGovernanceRecords(world);
  const termMonths = Math.max(1, Math.floor(config.management.termMonths));
  // 只有在“首次建立/迁移”（没有任何经营者档案，或控制记录完全没有引用经营者）时
  // 才自动补任空缺；已运行世界的空缺应交给选任流程（任期届满/空缺/严重问题），
  // 否则岗位空缺永远等不到选任、规则形同虚设。
  const hasReferencedOperator = world.governance.controls.some(
    (control) => typeof control.operatorId === 'string' && control.operatorId.length > 0,
  );
  const bootstrap = state.operators.length === 0 || !hasReferencedOperator;

  const usedOperatorIds = new Set<string>();
  const sortedControls = [...world.governance.controls].sort((a, b) =>
    a.companyId.localeCompare(b.companyId),
  );

  // 第一遍：登记仍然有效的在任关系，并补齐 control 的新字段默认值。
  for (const control of sortedControls) {
    if (control.operatorId === undefined) control.operatorId = null;
    if (control.termEndTick === undefined) control.termEndTick = null;
    if (control.operator !== 'management') {
      // 玩家或持有人经营：不安排 AI 经营者（玩家的任期由选任写入，不在本函数重置）。
      control.operatorId = null;
      continue;
    }
    if (!control.operatorId) continue;
    const operator = operatorById(world, control.operatorId);
    const consistent =
      operator &&
      operator.status === 'employed' &&
      operator.companyId === control.companyId &&
      !usedOperatorIds.has(operator.id);
    if (!consistent) {
      control.operatorId = null;
      continue;
    }
    usedOperatorIds.add(operator.id);
    if (control.termEndTick === null) control.termEndTick = tick + termMonths;
    operator.termEndTick = control.termEndTick;
  }

  // 第二遍：追加/修复缺失的在任关系。
  // - bootstrap（旧存档迁移/首次初始化）：为所有空缺补人，保证每家企业都有经营者；
  // - 已运行世界：空缺交给 maybeOpenElections 走选任；只有“没有投票权股东、无法选任”
  //   的企业才直接补人，避免出现永远无人经营的企业。
  for (const company of sortedCompanies(world)) {
    const control = ensureControl(world, company.id, tick);
    if (control.operator !== 'management') continue;
    if (control.operatorId) continue;
    if (hasOpenElection(world, company.id)) continue;
    if (!bootstrap && hasVotingHolders(world, company.id)) continue;
    const desiredStyle = company.ai?.style ?? 'steady';
    const operator = selectOperator(world, state, company, desiredStyle, usedOperatorIds);
    const termEndTick = tick + termMonths;
    employOperator(world, operator.id, company.id, tick, termEndTick, '岗位空缺补任');
    usedOperatorIds.add(operator.id);
  }

  // 第三遍：清理没有控制记录支撑的“已任职”档案（例如存档被手工编辑过）。
  for (const operator of [...state.operators]) {
    if (operator.status !== 'employed') continue;
    const referenced = world.governance.controls.some(
      (control) => control.operatorId === operator.id && control.companyId === operator.companyId,
    );
    if (referenced) continue;
    releaseOperator(world, operator.id, tick, '任职记录修复：对应控制记录已变更');
  }
}

/**
 * 人才池规模控制（v0.4 验收问题 6 修复）：不得因为池子超限而删除经营者档案。
 *
 * 用户规则：落选者留在人才市场，未来仍可被其他企业聘用；status 只有
 * employed/available，档案、履历与任职历史是长期记录。规模控制改由 elections
 * 的“优先复用同城 available + 限制每次新建数量 + 达到 maxPoolPerCity 后不再新建”
 * 实现，本函数只负责在超限时留下一条提示日志（同一城市只留一条，日志被裁剪后
 * 可再次提示），不改变任何 operator 的 status/companyId/history，因此也不会把
 * 在任经营者变成空闲候选，或让进行中的选任议案丢失候选人。
 */
export function pruneOperatorPool(world: WorldState, config: DemoConfig, tick: number): void {
  const state = ensureManagementState(world);
  const limit = Math.max(0, Math.floor(config.management.maxPoolPerCity));

  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const available = state.operators.filter(
      (operator) => operator.status === 'available' && operatorCityId(operator) === city.id,
    );
    if (available.length <= limit) continue;

    const message =
      `人才市场调整：${city.name} 待选经营者超出建议规模（${limit} 名），` +
      '保留全部现有档案并暂停新增；落选者仍可被其他企业聘用。';
    // 每月都可能超限，同一提示只保留一条，避免世界日志被重复条目淹没。
    if (world.log.some((entry) => entry.message === message)) continue;
    world.log.push({ tick, kind: 'labor', message });
  }

  const maxLog = config.simulation.maxLogEntries;
  while (world.log.length > maxLog) world.log.shift();
}

/**
 * 新世界/旧存档迁移：生成初始经营者人才池，并为每家企业安排在任经营者。
 *
 * - 每城生成 initialPoolPerCity 名 available 经营者（姓名/风格/声望确定性生成）；
 * - 每家企业分配一名在任经营者：优先人才市场同城且风格匹配者，
 *   这样旧存档的 company.ai.style 行为不会突变；不足时生成风格匹配的新人；
 * - 写入 control.operatorId / basis='election' / termEndTick=tick+termMonths；
 * - 不改动企业现金、股权或任何经营字段。
 */
export function createInitialManagement(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): ManagementState {
  ensureGovernanceRecords(world);
  const state = ensureManagementState(world);
  const poolSize = Math.max(0, Math.floor(config.management.initialPoolPerCity));
  const termMonths = Math.max(1, Math.floor(config.management.termMonths));
  const termEndTick = tick + termMonths;
  const alreadyInitialized = state.operators.length > 0;

  // 1) 为没有经营者的企业安排初始经营者：优先复用同城 + 风格匹配的现有档案
  //    （迁移场景），否则生成一名风格匹配的新人，保证旧存档 company.ai.style 行为不突变。
  for (const company of sortedCompanies(world)) {
    const control = ensureControl(world, company.id, tick);
    if (control.operator !== 'management' || control.operatorId) continue;
    const desiredStyle = company.ai?.style ?? 'steady';
    const reusable = state.operators.find(
      (operator) =>
        operator.status === 'available' &&
        operator.style === desiredStyle &&
        operatorCityId(operator) === company.cityId,
    );
    const operator = reusable ?? generateOperator(world, company.cityId, tick, desiredStyle);
    employOperator(world, operator.id, company.id, tick, termEndTick, '初始就任');
  }

  // 2) 每城生成初始人才池（available），让首次选任有可复用候选人。
  //    仅在首次初始化时生成，重复调用不会无限增长经营者。
  if (!alreadyInitialized) {
    for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
      for (let index = 0; index < poolSize; index++) {
        const style = styleFromHash(hashString(`${world.seed}:${city.id}:style:${index}`));
        generateOperator(world, city.id, tick, style);
      }
    }
  }

  // 3) 安全网：幂等补齐（例如迁移数据里已有部分经营者的企业）。
  ensureOperators(world, config, tick);

  world.log.push({
    tick,
    kind: 'system',
    message: `经营者人才市场建立：${state.operators.length} 名经营者档案，其中 ${state.operators.filter((operator) => operator.status === 'available').length} 名待选；每家企业已安排在任经营者（风格沿用原企业风格）。`,
  });
  const maxLog = config.simulation.maxLogEntries;
  while (world.log.length > maxLog) world.log.shift();
  return state;
}

/** 供测试/界面使用：企业任期剩余月数（无任期信息时返回 null）。 */
export function termMonthsLeft(world: WorldState, companyId: string, tick: number): number | null {
  const control = findControl(world, companyId);
  if (!control || control.termEndTick === null || control.termEndTick === undefined) return null;
  return Math.max(0, control.termEndTick - tick);
}
