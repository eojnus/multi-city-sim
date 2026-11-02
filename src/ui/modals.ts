// 模态框内容渲染：存档/读档、参数与假设、资源署名、月度报告。
import type { GameStore, SaveSlotView } from '../app/gameStore';
import { DEMO_CONFIG } from '../data/config';
import { GOODS } from '../data/demo-data';
import type { GoodId } from '../simulation/contracts/types';
import {
  aggregateTradeFlows,
  cityName,
  deltaClass,
  esc,
  goodName,
  localizeTime,
  logKindLabel,
  money,
  num,
  pct,
  signClass,
  signedPointPercent,
  sizeLabel,
  tickDate,
  worldTotals,
} from './format';

export type ModalKind = 'save' | 'load' | 'assumptions' | 'credits' | 'report';

export interface ModalState {
  kind: ModalKind;
  slots: SaveSlotView[] | null;
  busy: string | null;
  pendingDelete: string | null;
  pendingOverwrite: string | null;
  confirmReset: boolean;
  notice: string | null;
  error: string | null;
  copyLabel: string | null;
}

const MODAL_META: Record<ModalKind, { kicker: string; title: string; testId: string; wide: boolean }> = {
  save: {
    kicker: 'SAVE CONSOLE',
    title: '存档',
    testId: 'modal-save',
    wide: false,
  },
  load: {
    kicker: 'LOAD CONSOLE',
    title: '读取存档',
    testId: 'modal-load',
    wide: false,
  },
  assumptions: {
    kicker: 'PARAMETERS & ASSUMPTIONS',
    title: '参数与假设',
    testId: 'modal-assumptions',
    wide: true,
  },
  credits: {
    kicker: 'ASSET CREDITS',
    title: '资源署名',
    testId: 'modal-credits',
    wide: true,
  },
  report: {
    kicker: 'MONTHLY REPORT',
    title: '月度报告',
    testId: 'modal-report',
    wide: true,
  },
};

function modalHeader(kind: ModalKind, description: string): string {
  const meta = MODAL_META[kind];
  return `
    <header class="modal-head">
      <span class="kicker">${meta.kicker}</span>
      <h2>${meta.title}</h2>
      <p>${description}</p>
      <button type="button" class="icon-btn modal-close" data-action="close-modal" data-focus-key="modal-close" aria-label="关闭对话框" title="关闭（Esc）">×</button>
      <span class="ken-divider modal-divider"></span>
    </header>`;
}

function modalFooter(note: string, actions: string): string {
  return `
    <footer class="modal-foot">
      <span class="modal-foot-note">${note}</span>
      <div class="modal-foot-actions">${actions}</div>
    </footer>`;
}

function saveLoadTabs(kind: 'save' | 'load'): string {
  return `
    <div class="modal-tabs" role="tablist" aria-label="存档与读档">
      <button type="button" class="modal-tab ${kind === 'save' ? 'is-active' : ''}" data-action="switch-modal" data-modal="save" data-focus-key="modal-tab-save" role="tab" aria-selected="${kind === 'save'}">存档</button>
      <button type="button" class="modal-tab ${kind === 'load' ? 'is-active' : ''}" data-action="switch-modal" data-modal="load" data-focus-key="modal-tab-load" role="tab" aria-selected="${kind === 'load'}">读取</button>
    </div>`;
}

function slotCard(slot: SaveSlotView, state: ModalState, mode: 'save' | 'load'): string {
  const isAuto = slot.slot === 'autosave';
  const busy = state.busy === slot.slot;
  const exists = slot.exists;
  const deleting = state.pendingDelete === slot.slot;
  const overwriting = state.pendingOverwrite === slot.slot;
  const isLoad = mode === 'load';
  const status = slot.error
    ? '读取异常'
    : exists
      ? isAuto
        ? '自动存档'
        : '已有存档'
      : '空槽位';
  const meta = slot.error
    ? esc(slot.error)
    : exists
      ? `${esc(localizeTime(slot.savedAt))}<br>格式 v${num(slot.formatVersion ?? 0)} · 游戏 v${esc(slot.gameVersion ?? '—')} · ${sizeLabel(slot.size)}`
      : '尚未写入。保存后可在读取面板恢复当前世界。';
  return `
    <div class="slot ${isAuto ? 'is-auto' : ''} ${exists ? 'has-save' : 'is-empty'}">
      <div class="slot-head">
        <b>${esc(slot.label)}</b>
        <span class="slot-badge ${exists ? '' : 'is-empty'}">${status}</span>
      </div>
      <div class="slot-meta">${meta}</div>
      ${
        deleting
          ? `<div class="slot-confirm">
              <span>删除 ${esc(slot.label)} 后无法恢复。</span>
              <button type="button" class="ken-btn ken-btn--red ken-btn--mini" data-action="confirm-delete" data-slot="${esc(slot.slot)}" data-focus-key="modal-confirm-delete-${esc(slot.slot)}" ${busy ? 'disabled' : ''}>确认删除</button>
              <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="cancel-delete" data-focus-key="modal-cancel-delete" ${busy ? 'disabled' : ''}>取消</button>
            </div>`
          : overwriting
            ? `<div class="slot-confirm">
                <span>覆盖 ${esc(slot.label)} 的现有存档？</span>
                <button type="button" class="ken-btn ken-btn--green ken-btn--mini" data-action="confirm-overwrite" data-slot="${esc(slot.slot)}" data-focus-key="modal-confirm-overwrite-${esc(slot.slot)}" ${busy ? 'disabled' : ''}>确认覆盖</button>
                <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="cancel-overwrite" data-focus-key="modal-cancel-overwrite" ${busy ? 'disabled' : ''}>取消</button>
              </div>`
            : `<div class="slot-actions">
                ${
                  isAuto
                    ? '<span class="slot-auto-note">推进时自动写入</span>'
                    : isLoad
                      ? ''
                      : `<button type="button" class="ken-btn ken-btn--blue ken-btn--mini" data-action="save-slot" data-slot="${esc(slot.slot)}" data-testid="slot-save-${esc(slot.slot)}" data-focus-key="modal-save-${esc(slot.slot)}" ${busy ? 'disabled' : ''}>${busy ? '写入中…' : '保存'}</button>`
                }
                <button type="button" class="ken-btn ${isLoad ? 'ken-btn--blue' : 'ken-btn--grey'} ken-btn--mini" data-action="load-slot" data-slot="${esc(slot.slot)}" data-testid="slot-load-${esc(slot.slot)}" data-focus-key="modal-load-${esc(slot.slot)}" ${!exists || busy ? 'disabled' : ''}>${busy ? '处理中…' : '读取'}</button>
                <button type="button" class="ken-btn ken-btn--grey ken-btn--mini slot-delete" data-action="request-delete" data-slot="${esc(slot.slot)}" data-testid="slot-delete-${esc(slot.slot)}" data-focus-key="modal-delete-${esc(slot.slot)}" ${!exists || busy ? 'disabled' : ''}>删除</button>
              </div>`
      }
    </div>`;
}

function resetCard(state: ModalState): string {
  return `
    <div class="reset-card">
      <div>
        <b>新世界</b>
        <p>重新初始化模拟世界。当前未保存的进度会丢失；自动存档会被新的推进覆盖，手动存档仍保留。</p>
      </div>
      ${
        state.confirmReset
          ? `<div class="reset-confirm">
              <span>确认重置？此操作无法撤销。</span>
              <button type="button" class="ken-btn ken-btn--red ken-btn--mini" data-action="confirm-reset" data-testid="btn-confirm-reset" data-focus-key="modal-confirm-reset">确认新世界</button>
              <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="cancel-reset" data-focus-key="modal-cancel-reset">取消</button>
            </div>`
          : `<button type="button" class="ken-btn ken-btn--red ken-btn--mini" data-action="request-reset" data-testid="btn-reset-world" data-focus-key="modal-request-reset">新世界…</button>`
      }
    </div>`;
}

function renderSaveLoad(store: GameStore, state: ModalState): string {
  const kind = state.kind as 'save' | 'load';
  const loading = state.slots === null;
  const slots = state.slots ?? [];
  const isSave = kind === 'save';
  const description = isSave
    ? '写入自动存档或三个手动槽位。覆盖已有存档需要二次确认。'
    : '从槽位恢复世界。读取失败不会覆盖当前进度。';
  const body = `
    ${modalHeader(kind, description)}
    ${saveLoadTabs(kind)}
    <div class="modal-body">
      ${state.error ? `<div class="modal-alert is-error" role="alert">${esc(state.error)}</div>` : ''}
      ${state.notice ? `<div class="modal-alert is-ok" role="status">${esc(state.notice)}</div>` : ''}
      ${
        loading
          ? `<div class="slot-grid slot-grid--loading">
              ${[0, 1, 2, 3].map(() => '<div class="slot is-loading"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>').join('')}
            </div>`
          : `<div class="slot-grid">${slots.map((slot) => slotCard(slot, state, kind)).join('')}</div>`
      }
      ${isSave ? resetCard(state) : '<p class="note">读取成功后视图会回到区域地图；当前选中的城市与建筑会被清除。</p>'}
      <p class="note">存档位置：${
        store.bridge.mode === 'desktop'
          ? `桌面应用数据目录${store.bridge.saveDirectory ? `（${esc(store.bridge.saveDirectory)}）` : ''}`
          : '浏览器 localStorage（开发回退）'
      }。自动存档在每次推进后写入。</p>
    </div>
    ${modalFooter(
      isSave
        ? '手动存档不会被「新世界」删除。所有槽位使用同一存档格式 v1。'
        : '读取失败时，当前进度不会被覆盖。',
      `
        <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="switch-modal" data-modal="${isSave ? 'load' : 'save'}">切换到${isSave ? '读取' : '存档'}</button>
        <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="close-modal">关闭</button>
      `,
    )}`;
  return body;
}

function renderAssumptions(store: GameStore): string {
  const assumptions = DEMO_CONFIG.meta.assumptions;
  const settlement = [
    '人口自然变动与城市间迁移',
    '企业计划与劳动力匹配（招聘 / 裁员）',
    '期初供应与长期跨城贸易合同',
    '生产资料采购：本地市场 + 区域补货',
    '生产：消耗库存、记录产出与增加值',
    '居民消费：使用上一个月已实现收入',
    '区域外净出口（开放经济演示）',
    '价格与市场统计结算',
    '企业财务：工资、税、股息、信贷、产能',
    '城市财政与居民收入',
    'GDP、历史记录与库存守恒审计',
  ];
  const body = `
    ${modalHeader('assumptions', '以下均为可替换的演示方案 v0.1，不是正式策划规则，也不构成经济预测。')}
    <div class="modal-body">
      <div class="modal-meta-row">
        <span class="chip chip--gold">${esc(DEMO_CONFIG.meta.label)}</span>
        <span class="chip">1 回合 = 1 游戏月</span>
        <span class="chip">起始 ${DEMO_CONFIG.simulation.startYear}-${String(DEMO_CONFIG.simulation.startMonth).padStart(2, '0')}</span>
        <span class="chip">自动推进 ${(DEMO_CONFIG.ui.autoTickMs / 1000).toFixed(1)} 秒 / 月</span>
      </div>
      <section class="modal-section">
        <h3>核心假设</h3>
        <ol class="assumption-list">
          ${assumptions.map((item) => `<li>${esc(item)}</li>`).join('')}
        </ol>
      </section>
      <section class="modal-section">
        <h3>GDP 口径</h3>
        <p>游戏内 GDP 采用演示口径：<b>本月企业产出价值 − 中间投入价值</b>，不含公共服务、投资与净出口调整。它用于观察月度生产变化，不等同于国民经济核算中的正式 GDP。</p>
        <p>人口、就业与失业为群体统计；不逐人模拟，也不包含通勤、技能匹配或非正规就业。</p>
      </section>
      <section class="modal-section">
        <h3>月度结算顺序</h3>
        <ol class="settlement-list">
          ${settlement.map((item) => `<li>${esc(item)}</li>`).join('')}
        </ol>
        <p class="note">任一步骤失败或库存守恒校验不通过时，整期会回滚到月初快照。</p>
      </section>
      <section class="modal-section">
        <h3>系统接入状态</h3>
        <div class="unimplemented-list">
          <div>
            <span>科技</span>
            <p>研发资助把财政投入转为研究点，累计到阈值后提升等级与生产率；教育投入提高劳动力技能。等级与生产率随政策变化。</p>
            <em>status: 已接入（演示）</em>
          </div>
          <div>
            <span>政治</span>
            <p>候选人、领导人与任期由选举模块推进；玩家可参选市长，当选后自行选择 15 项政策。</p>
            <em>status: 已接入（演示）</em>
          </div>
          <div>
            <span>房地产</span>
            <p>住房支持会建设住房单元并发放租金补贴；住房买卖与地价形成仍未接入。</p>
            <em>status: 初始展示</em>
          </div>
        </div>
      </section>
      <section class="modal-section">
        <h3>玩家与注资参数</h3>
        <div class="param-grid">
          <div><span>起始现金</span><b>${money(DEMO_CONFIG.player.startingCash)}</b></div>
          <div><span>单次最低注资</span><b>${money(DEMO_CONFIG.player.minInvestment)}</b></div>
          <div><span>单次最高注资</span><b>${money(DEMO_CONFIG.player.maxInvestment)}</b></div>
          <div><span>注资产能增益</span><b>演示汇率</b></div>
        </div>
        <p class="note">注资同时补充营运资金并按演示汇率提升产能，不是真实资本形成模型。企业现金不足时的营运资金信贷 / 债务重组也仅为演示。</p>
      </section>
      <p class="note">参数集中定义于 <code>src/data/config.ts</code> 的 <code>DEMO_CONFIG</code>；修改参数会改变模拟节奏，业务代码不散落魔法数字。</p>
    </div>
    ${modalFooter(
      '可复制为纯文本，用于策划评审或问题记录。',
      '<button type="button" class="ken-btn ken-btn--blue ken-btn--mini" data-action="copy-modal">复制全文</button><button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="close-modal">关闭</button>',
    )}`;
  return body;
}

function renderCredits(): string {
  const body = `
    ${modalHeader('credits', '已集成素材的许可与来源。外部链接会在系统浏览器中打开。')}
    <div class="modal-body">
      <div class="credit-grid">
        <article class="credit-card">
          <div class="credit-card-head">
            <h3>Kenney Roguelike Modern City 2.0</h3>
            <span class="license">CC0 1.0</span>
          </div>
          <p>城市 tile 地图与建筑外观。作为当前城市地图的备用素材体系，已随项目分发。</p>
          <p class="credit-links">
            <a href="https://kenney.nl/assets/roguelike-modern-city" target="_blank" rel="noreferrer">kenney.nl/assets/roguelike-modern-city</a>
          </p>
          <span class="credit-status is-ok">已下载 · 已集成</span>
        </article>
        <article class="credit-card">
          <div class="credit-card-head">
            <h3>Kenney UI Pack 2.0</h3>
            <span class="license">CC0 1.0</span>
          </div>
          <p>按钮材质、播放 / 循环图标与分隔线。控制台主操作按钮直接使用其按钮贴图。</p>
          <p class="credit-links">
            <a href="https://kenney.nl/assets/ui-pack" target="_blank" rel="noreferrer">kenney.nl/assets/ui-pack</a>
          </p>
          <span class="credit-status is-ok">已下载 · 已集成</span>
        </article>
        <article class="credit-card">
          <div class="credit-card-head">
            <h3>Kenney Future</h3>
            <span class="license">CC0 1.0</span>
          </div>
          <p>控制台品牌字与部分数字的像素字体；正文中文回退到 Microsoft YaHei。</p>
          <p class="credit-links">
            <a href="https://kenney.nl/assets/kenney-fonts" target="_blank" rel="noreferrer">kenney.nl/assets/kenney-fonts</a>
          </p>
          <span class="credit-status is-ok">已下载 · 已注入</span>
        </article>
        <article class="credit-card is-pending">
          <div class="credit-card-head">
            <h3>Rasak Modern Tilesets</h3>
            <span class="license license--pending">计划中</span>
          </div>
          <p>原计划的主素材体系，但<b>尚未获取、未下载、未集成</b>。当前版本没有使用 Rasak 的任何图像。待人工下载并核验许可后再接入。</p>
          <span class="credit-status is-pending">未下载 · 未集成</span>
        </article>
        <article class="credit-card is-pending">
          <div class="credit-card-head">
            <h3>Modern City Extension</h3>
            <span class="license license--pending">备用参考</span>
          </div>
          <p>仅作为城市地图的备用参考，没有加入构建或运行时资源。</p>
          <span class="credit-status is-pending">参考 · 未集成</span>
        </article>
        <article class="credit-card">
          <div class="credit-card-head">
            <h3>Phaser 3</h3>
            <span class="license">MIT</span>
          </div>
          <p>地图渲染与场景管理引擎。</p>
          <p class="credit-links">
            <a href="https://phaser.io" target="_blank" rel="noreferrer">phaser.io</a>
          </p>
          <span class="credit-status is-ok">已集成</span>
        </article>
      </div>
      <section class="modal-section">
        <h3>许可说明</h3>
        <p>Kenney 素材以 <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer">Creative Commons Zero (CC0 1.0)</a> 发布，可免费用于个人、教育与商业项目；署名并非强制，但本项目仍在此列出。许可原文随资源分发：</p>
        <ul class="path-list">
          <li><code>public/assets/ui/LICENSE-kenney-ui-pack.txt</code></li>
          <li><code>public/assets/city/LICENSE-kenney-modern-city.txt</code></li>
        </ul>
        <p class="note">字体与图标同样来自 Kenney 的 CC0 资源包；中文界面使用系统字体回退，不附带商业字体。</p>
      </section>
    </div>
    ${modalFooter(
      '素材署名页可通过顶部「署名」或 Electron 菜单随时打开。',
      '<button type="button" class="ken-btn ken-btn--blue ken-btn--mini" data-action="copy-modal">复制署名</button><button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="close-modal">关闭</button>',
    )}`;
  return body;
}

function deltaValue(current: number, previous: number | undefined, formatter: (value: number) => string): string {
  if (previous === undefined) return '<span class="report-delta">基准</span>';
  const delta = current - previous;
  return `<span class="report-delta ${signClass(delta)}">${delta > 0 ? '+' : ''}${formatter(delta)}</span>`;
}

function renderReport(store: GameStore): string {
  const world = store.world;
  const totals = worldTotals(world, store.playerNetWorth);
  const history = world.history;
  const last = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : undefined;
  const groups = aggregateTradeFlows(world.lastTick.tradeFlows);
  const totalTradeValue = groups.reduce((total, group) => total + group.value, 0);
  const external = world.lastTick.externalExports;
  const externalValue = external.reduce((total, entry) => total + entry.value, 0);
  const priceChanges: {
    cityId: string;
    good: GoodId;
    price: number;
    change: number;
  }[] = [];
  for (const city of world.cities) {
    for (const good of GOODS) {
      const market = city.market[good.id];
      if (!market) continue;
      if (Math.abs(market.lastPriceChangePct) < 0.0005) continue;
      priceChanges.push({
        cityId: city.id,
        good: good.id,
        price: market.price,
        change: market.lastPriceChangePct,
      });
    }
  }
  priceChanges.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const topPrices = priceChanges.slice(0, 6);
  const monthLogs = world.log.filter((entry) => entry.tick === world.time.tick).slice(-8).reverse();
  const body = `
    ${modalHeader('report', `${esc(store.dateLabel)} · 第 ${world.time.tick} 回合。数据来自当前演示口径。`)}
    <div class="modal-body">
      ${
        world.time.tick === 0
          ? '<div class="modal-alert is-info">尚未推进月份。以下为初始状态；推进 1 月后会生成第一份完整月度报告。</div>'
          : ''
      }
      <div class="report-grid">
        <div class="report-kpi is-gold">
          <span>世界 GDP</span>
          <b>${money(totals.gdp)}</b>
          ${deltaValue(totals.gdp, previous?.gdp, (value) => money(value))}
        </div>
        <div class="report-kpi">
          <span>世界人口</span>
          <b>${num(totals.population)}</b>
          ${deltaValue(totals.population, previous?.population, (value) => num(value))}
        </div>
        <div class="report-kpi">
          <span>就业</span>
          <b>${num(totals.employed)}</b>
          ${deltaValue(totals.employed, previous?.employed, (value) => num(value))}
        </div>
        <div class="report-kpi ${totals.unemploymentRate > 0.08 ? 'is-warn' : ''}">
          <span>失业</span>
          <b>${num(totals.unemployed)}</b>
          <span class="report-delta">失业率 ${pct(totals.unemploymentRate)}</span>
        </div>
        <div class="report-kpi is-teal">
          <span>玩家净值</span>
          <b>${money(totals.netWorth)}</b>
          ${deltaValue(totals.netWorth, previous?.playerNetWorth, (value) => money(value))}
        </div>
      </div>
      <section class="modal-section">
        <h3>城市表现</h3>
        <div class="table-wrap">
          <table class="report-table" aria-label="城市月度表现">
            <thead>
              <tr>
                <th scope="col">城市</th>
                <th scope="col">GDP</th>
                <th scope="col">人口</th>
                <th scope="col">失业率</th>
                <th scope="col" title="财政余额仅该城市市长可见">财政</th>
                <th scope="col">居民收入</th>
                <th scope="col">迁移净额</th>
              </tr>
            </thead>
            <tbody>
              ${world.cities
                .map((city) => {
                  const migration = city.lastMonth.migrationIn - city.lastMonth.migrationOut;
                  return `<tr>
                    <td class="city-name">${esc(city.name)}</td>
                    <td>${money(city.gdp)}</td>
                    <td>${num(city.population.total)}</td>
                    <td>${pct(city.population.laborForce > 0 ? city.population.unemployed / city.population.laborForce : 0)}</td>
                    <td>${
                      // 补充指令 §7：政府可用财政资金仅该城市市长可见。
                      store.isMayorOf(city.id)
                        ? money(city.treasury)
                        : '<span class="is-restricted-inline" title="财政余额仅该城市市长可见">—</span>'
                    }</td>
                    <td>${money(city.householdIncomeLastMonth)}</td>
                    <td class="${signClass(migration)}">${migration > 0 ? '+' : ''}${num(migration)}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </section>
      <section class="modal-section">
        <h3>区域贸易与价格</h3>
        <div class="report-columns">
          <div>
            <h4>本月跨城成交</h4>
            ${
              groups.length === 0
                ? '<p class="note">本月暂无成交。</p>'
                : `<p class="report-total">${groups.length} 条路线 · 货值 ${money(totalTradeValue)}</p>
                   <table class="report-table compact">
                     <thead><tr><th>路线</th><th>商品</th><th>数量</th><th>价值</th></tr></thead>
                     <tbody>
                       ${groups
                         .slice(0, 6)
                         .map(
                           (group) => `<tr>
                             <td>${esc(cityName(world, group.fromCityId))} → ${esc(cityName(world, group.toCityId))}</td>
                             <td>${esc(goodName(group.good))}</td>
                             <td>${num(group.qty)}</td>
                             <td>${money(group.value)}</td>
                           </tr>`,
                         )
                         .join('')}
                     </tbody>
                   </table>`
            }
            ${
              external.length > 0
                ? `<p class="note">区域外出口 ${external.length} 笔 · ${money(externalValue)}。</p>`
                : '<p class="note">本月没有区域外出口记录。</p>'
            }
          </div>
          <div>
            <h4>主要价格变化</h4>
            ${
              topPrices.length === 0
                ? '<p class="note">本月价格无显著变化，或尚未推进月份。</p>'
                : `<ul class="price-list">
                    ${topPrices
                      .map(
                        (entry) => `<li>
                          <span>${esc(cityName(world, entry.cityId))} · ${esc(goodName(entry.good))}</span>
                          <b>${num(entry.price, 1)} <em class="${deltaClass(entry.change)}">${signedPointPercent(entry.change)}</em></b>
                        </li>`,
                      )
                      .join('')}
                  </ul>`
            }
          </div>
        </div>
      </section>
      <section class="modal-section">
        <h3>本月事件</h3>
        ${
          monthLogs.length === 0
            ? '<p class="note">本月暂无日志。</p>'
            : `<ul class="report-log">
                ${monthLogs
                  .map(
                    (entry) => `<li class="log-${entry.kind}">
                      <span class="log-kind">${esc(logKindLabel(entry.kind))}</span>
                      <span>${esc(entry.message)}</span>
                    </li>`,
                  )
                  .join('')}
              </ul>`
        }
      </section>
      <p class="note">报告由当前世界状态即时生成；价格变化为上月结算结果，贸易为 lastTick 实际流量。</p>
    </div>
    ${modalFooter(
      `报告时点：${esc(store.dateLabel)} · T${world.time.tick} · 数据口径：${esc(DEMO_CONFIG.meta.label)}`,
      '<button type="button" class="ken-btn ken-btn--blue ken-btn--mini" data-action="copy-modal">复制摘要</button><button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="close-modal">关闭</button>',
    )}`;
  return body;
}

export function renderModal(store: GameStore, state: ModalState): string {
  const meta = MODAL_META[state.kind];
  const content =
    state.kind === 'save' || state.kind === 'load'
      ? renderSaveLoad(store, state)
      : state.kind === 'assumptions'
        ? renderAssumptions(store)
        : state.kind === 'credits'
          ? renderCredits()
          : renderReport(store);
  return `
    <div class="modal-backdrop">
      <section
        class="modal ${meta.wide ? 'modal--wide' : ''}"
        role="dialog"
        aria-modal="true"
        aria-label="${meta.title}"
        tabindex="-1"
        data-modal-kind="${state.kind}"
        data-testid="${meta.testId}"
      >
        ${content}
        ${
          state.copyLabel
            ? `<div class="copy-toast" role="status">${esc(state.copyLabel)}</div>`
            : ''
        }
      </section>
    </div>`;
}

export { MODAL_META };
