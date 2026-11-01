import Phaser from 'phaser';
import type { GameStore } from '../../app/gameStore';
import { REGION_LINKS } from '../../data/demo-data';
import { formatMoney, formatNumber } from '../../simulation/core/math';
import type { City, TradeFlow } from '../../simulation/contracts/types';

const DESIGN_WIDTH = 1200;
const DESIGN_HEIGHT = 760;
const FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';

interface CityNode {
  city: City;
  container: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Arc;
  core: Phaser.GameObjects.Arc;
  hit: Phaser.GameObjects.Arc;
  nameText: Phaser.GameObjects.Text;
  dataText: Phaser.GameObjects.Text;
}

interface FlowDot {
  dot: Phaser.GameObjects.Arc;
  from: { x: number; y: number };
  to: { x: number; y: number };
  control: { x: number; y: number };
  t: number;
  speed: number;
  color: number;
}

export class RegionalScene extends Phaser.Scene {
  private store!: GameStore;
  private content!: Phaser.GameObjects.Container;
  private nodes: CityNode[] = [];
  private flowDots: FlowDot[] = [];
  private unsub: (() => void) | null = null;
  private lastClickAt = new Map<string, number>();

  constructor() {
    super('RegionalScene');
  }

  create(): void {
    this.store = this.registry.get('store') as GameStore;
    this.cameras.main.setBackgroundColor('#07111d');
    this.drawBackdrop();
    this.content = this.add.container(0, 0);
    this.refresh();
    this.unsub = this.store.subscribe(() => this.onStoreChange());
    this.scale.on('resize', this.fitCamera, this);
    this.fitCamera();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsub?.();
      this.scale.off('resize', this.fitCamera, this);
    });
  }

  private onStoreChange(): void {
    if (!this.scene.isActive()) return;
    if (this.store.view === 'city') {
      this.scene.start('CityScene', { cityId: this.store.selectedCityId });
      return;
    }
    this.refresh();
  }

  private fitCamera(): void {
    // 给左侧城市列表、右侧详情面板和顶部/底部 HUD 留出安全区，
    // 避免城市节点被 UI 覆盖而无法点击。
    const camera = this.cameras?.main;
    if (!camera) return;
    const uiLeft = Math.min(320, this.scale.width * 0.24);
    const uiRight = Math.min(400, this.scale.width * 0.3);
    const uiTop = 76;
    const uiBottom = 150;
    const availableW = Math.max(360, this.scale.width - uiLeft - uiRight);
    const availableH = Math.max(300, this.scale.height - uiTop - uiBottom);
    const zoom = Phaser.Math.Clamp(
      Math.min(availableW / DESIGN_WIDTH, availableH / DESIGN_HEIGHT),
      0.45,
      1.4,
    );
    camera.setViewport(uiLeft, uiTop, availableW, availableH);
    camera.setZoom(zoom);
    camera.centerOn(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
  }

  private drawBackdrop(): void {
    const g = this.add.graphics();
    g.fillStyle(0x07111d, 1);
    g.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    // 海面网格
    g.lineStyle(1, 0x1b3b4d, 0.35);
    for (let x = 0; x < DESIGN_WIDTH; x += 60) {
      g.lineBetween(x, 0, x, DESIGN_HEIGHT);
    }
    for (let y = 0; y < DESIGN_HEIGHT; y += 60) {
      g.lineBetween(0, y, DESIGN_WIDTH, y);
    }
    // 陆地
    const land = new Phaser.Geom.Polygon([
      0, 610, 120, 700, 300, 748, 520, 720, 720, 690, 930, 640,
      1080, 560, 1170, 430, 1110, 260, 980, 120, 760, 58, 520, 86,
      300, 150, 120, 300, 30, 440,
    ]);
    g.fillStyle(0x0e2324, 1);
    g.fillPoints(land.points, true);
    g.lineStyle(2, 0x2c5a56, 0.9);
    g.strokePoints(land.points, true);
    // 等高线
    g.lineStyle(1, 0x21423d, 0.55);
    for (let i = 1; i <= 4; i++) {
      g.strokeEllipse(560, 390, 780 - i * 90, 520 - i * 62);
    }
    // 河流
    const river = new Phaser.Curves.Spline([
      new Phaser.Math.Vector2(140, 380),
      new Phaser.Math.Vector2(420, 300),
      new Phaser.Math.Vector2(640, 360),
      new Phaser.Math.Vector2(840, 420),
      new Phaser.Math.Vector2(1040, 650),
    ]);
    const riverPoints = river.getPoints(48);
    g.lineStyle(10, 0x12384a, 0.95);
    g.beginPath();
    g.moveTo(riverPoints[0]!.x, riverPoints[0]!.y);
    for (const point of riverPoints.slice(1)) g.lineTo(point.x, point.y);
    g.strokePath();
    g.lineStyle(3, 0x3fa1bf, 0.55);
    g.beginPath();
    g.moveTo(riverPoints[0]!.x, riverPoints[0]!.y);
    for (const point of riverPoints.slice(1)) g.lineTo(point.x, point.y);
    g.strokePath();
    // 边缘暗角
    g.fillStyle(0x02070d, 0.55);
    g.fillRect(0, 0, DESIGN_WIDTH, 40);
    g.fillRect(0, DESIGN_HEIGHT - 40, DESIGN_WIDTH, 40);
  }

  private refresh(): void {
    this.content.removeAll(true);
    this.nodes = [];
    this.flowDots = [];
    this.drawRegionLinks();
    this.drawTradeFlows();
    for (const city of this.store.world.cities) this.createCityNode(city);
    this.drawLegend();
  }

  private linkCurve(a: City, b: City): { points: { x: number; y: number }[]; control: { x: number; y: number } } {
    const midX = (a.region.x + b.region.x) / 2;
    const midY = (a.region.y + b.region.y) / 2;
    const dx = b.region.x - a.region.x;
    const dy = b.region.y - a.region.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const control = { x: midX - (dy / len) * 46, y: midY + (dx / len) * 46 };
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = (1 - t) * (1 - t) * a.region.x + 2 * (1 - t) * t * control.x + t * t * b.region.x;
      const y = (1 - t) * (1 - t) * a.region.y + 2 * (1 - t) * t * control.y + t * t * b.region.y;
      points.push({ x, y });
    }
    return { points, control };
  }

  private drawRegionLinks(): void {
    const g = this.add.graphics();
    for (const link of REGION_LINKS) {
      const a = this.store.world.cities.find((city) => city.id === link.from);
      const b = this.store.world.cities.find((city) => city.id === link.to);
      if (!a || !b) continue;
      const { points } = this.linkCurve(a, b);
      g.lineStyle(7, 0x18384a, 0.9);
      g.beginPath();
      g.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) g.lineTo(point.x, point.y);
      g.strokePath();
      g.lineStyle(2, 0x6fb6ca, 0.55);
      g.beginPath();
      g.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) g.lineTo(point.x, point.y);
      g.strokePath();
      const mid = points[Math.floor(points.length / 2)]!;
      const label = this.add.text(mid.x, mid.y - 14, link.label, {
        fontFamily: FONT, fontSize: '11px', color: '#9bc8d6',
      }).setOrigin(0.5).setAlpha(0.8);
      this.content.add(label);
    }
    this.content.add(g);
  }

  private drawTradeFlows(): void {
    const flows = this.store.currentTradeFlows();
    const grouped = new Map<string, { flow: TradeFlow; qty: number }>();
    for (const flow of flows) {
      const key = `${flow.fromCityId}>${flow.toCityId}:${flow.good}`;
      const current = grouped.get(key);
      if (current) current.qty += flow.qty;
      else grouped.set(key, { flow, qty: flow.qty });
    }
    const g = this.add.graphics();
    let index = 0;
    for (const entry of grouped.values()) {
      const a = this.store.world.cities.find((city) => city.id === entry.flow.fromCityId);
      const b = this.store.world.cities.find((city) => city.id === entry.flow.toCityId);
      if (!a || !b) continue;
      const { points, control } = this.linkCurve(a, b);
      const color = entry.flow.good === 'food' || entry.flow.good === 'clothing' || entry.flow.good === 'household'
        ? 0xf2c14e
        : 0x66e0c2;
      g.lineStyle(2, color, 0.75);
      g.beginPath();
      g.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) g.lineTo(point.x, point.y);
      g.strokePath();
      const mid = points[Math.floor(points.length / 2)]!;
      void mid;
      const dot = this.add.circle(a.region.x, a.region.y, 3.5, color, 0.95);
      this.content.add(dot);
      this.flowDots.push({
        dot,
        from: { x: a.region.x, y: a.region.y },
        to: { x: b.region.x, y: b.region.y },
        control,
        t: (index * 0.23) % 1,
        speed: 0.00016 + (index % 4) * 0.00002,
        color,
      });
      index++;
    }
    this.content.add(g);
  }

  private industryLead(city: City): string {
    const counts = new Map<string, number>();
    for (const company of this.store.companiesForCity(city.id)) {
      counts.set(company.sector, (counts.get(company.sector) ?? 0) + company.employees);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed';
    const labels: Record<string, string> = {
      agriculture: '谷物', 'fiber-farm': '纤维', textile: '纺织', food: '食品',
      garment: '成衣', metal: '金属', utility: '能源', appliance: '日用品',
    };
    return labels[top] ?? '综合';
  }

  private createCityNode(city: City): void {
    const selected = this.store.selectedCityId === city.id;
    const layer = this.store.layer;
    const baseRadius = layer === 'population' ? 16 + city.population.total / 9000 : 24;
    const container = this.add.container(city.region.x, city.region.y);
    const boundary = this.add.circle(0, 0, city.region.radius, 0x000000, 0)
      .setStrokeStyle(1, Phaser.Display.Color.HexStringToColor(city.color).color, 0.22);
    const glow = this.add.circle(0, 0, baseRadius + 18, Phaser.Display.Color.HexStringToColor(city.color).color, 0.08);
    const ring = this.add.circle(0, 0, baseRadius + 7, 0x000000, 0).setStrokeStyle(2, Phaser.Display.Color.HexStringToColor(city.color).color, selected ? 1 : 0.55);
    const core = this.add.circle(0, 0, baseRadius, Phaser.Display.Color.HexStringToColor(city.color).color, 0.92);
    const inner = this.add.circle(0, 0, baseRadius * 0.42, 0x07111d, 0.75);
    const nameText = this.add.text(0, -baseRadius - 30, city.name, {
      fontFamily: FONT, fontSize: '22px', color: '#f4fbff', fontStyle: 'bold',
    }).setOrigin(0.5);
    let dataLine = '';
    if (layer === 'population') {
      dataLine = `人口 ${formatNumber(city.population.total)} · 失业 ${(city.population.unemployed / Math.max(1, city.population.laborForce) * 100).toFixed(1)}%`;
    } else if (layer === 'economy') {
      dataLine = `GDP ${formatMoney(city.gdp)} · 财政 ${formatMoney(city.treasury)}`;
    } else {
      dataLine = `主导产业 ${this.industryLead(city)} · 就业 ${formatNumber(city.population.employed)}`;
    }
    const dataText = this.add.text(0, baseRadius + 12, dataLine, {
      fontFamily: FONT, fontSize: '11px', color: '#a9d7e6',
    }).setOrigin(0.5);
    const hit = this.add.circle(0, 0, baseRadius + 22, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    container.add([boundary, glow, ring, core, inner, nameText, dataText, hit]);
    this.content.add(container);

    hit.on('pointerover', () => {
      ring.setStrokeStyle(3, 0xffffff, 0.95);
      this.tweens.add({ targets: container, scale: 1.06, duration: 110 });
    });
    hit.on('pointerout', () => {
      ring.setStrokeStyle(2, Phaser.Display.Color.HexStringToColor(city.color).color, selected ? 1 : 0.55);
      this.tweens.add({ targets: container, scale: 1, duration: 110 });
    });
    hit.on('pointerdown', () => {
      const now = this.time.now;
      const last = this.lastClickAt.get(city.id) ?? 0;
      this.lastClickAt.set(city.id, now);
      if (now - last < 360) {
        this.store.enterCity(city.id);
      } else {
        this.store.selectCity(city.id);
      }
    });

    if (selected) {
      const pulse = this.add.circle(0, 0, baseRadius + 14, 0x000000, 0).setStrokeStyle(2, 0xf2c14e, 0.9);
      container.add(pulse);
      this.tweens.add({
        targets: pulse,
        scale: 1.35,
        alpha: 0.15,
        duration: 1400,
        yoyo: true,
        repeat: -1,
      });
    }

    this.nodes.push({ city, container, ring, core, hit, nameText, dataText });
  }

  private drawLegend(): void {
    const text = this.add.text(28, DESIGN_HEIGHT - 74, '区域战略地图 · 单击城市查看概况 / 双击或面板按钮进入城市', {
      fontFamily: FONT, fontSize: '12px', color: '#8fb9c9',
    });
    this.content.add(text);
    const layerLabel: Record<string, string> = {
      population: '人口图层', economy: '经济图层', industry: '产业图层',
    };
    const badge = this.add.text(28, DESIGN_HEIGHT - 50, `当前：${layerLabel[this.store.layer]} · 基础年份 ${this.store.world.time.year}`, {
      fontFamily: FONT, fontSize: '12px', color: '#f2c14e',
    });
    this.content.add(badge);
  }

  override update(_time: number, delta: number): void {
    for (const flow of this.flowDots) {
      flow.t += delta * flow.speed;
      if (flow.t > 1) flow.t -= 1;
      const t = flow.t;
      const x =
        (1 - t) * (1 - t) * flow.from.x +
        2 * (1 - t) * t * flow.control.x +
        t * t * flow.to.x;
      const y =
        (1 - t) * (1 - t) * flow.from.y +
        2 * (1 - t) * t * flow.control.y +
        t * t * flow.to.y;
      flow.dot.setPosition(x, y);
      flow.dot.setAlpha(0.35 + Math.sin(t * Math.PI) * 0.65);
    }
  }
}
