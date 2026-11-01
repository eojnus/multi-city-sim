import Phaser from 'phaser';
import type { GameStore } from '../../app/gameStore';
import type { BuildingDefinition, CityLayout, DistrictDefinition } from '../../data/city-layout';
import { TILE_SIZE } from '../../data/city-layout';

const TILE_SCALE = 3;
const FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';
const FLOOR_FONT = '"KenneyFuture", "Microsoft YaHei", sans-serif';

export class CityScene extends Phaser.Scene {
  private store!: GameStore;
  private cityId = '';
  private layout!: CityLayout;
  private unsub: (() => void) | null = null;
  private overlay!: Phaser.GameObjects.Graphics;
  private hover!: Phaser.GameObjects.Graphics;
  private selection!: Phaser.GameObjects.Graphics;
  private dragStart: { x: number; y: number; scrollX: number; scrollY: number } | null = null;
  private didDrag = false;
  private selectedBuildingId: string | null = null;
  private readonly handleResize = (): void => {
    if (!this.cameras || !this.cameras.main || !this.scene.isActive()) return;
    this.applyCameraViewport();
    this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom, 0.45, 1.8));
  };

  constructor() {
    super('CityScene');
  }

  init(data: { cityId?: string }): void {
    this.cityId = data.cityId ?? '';
  }

  create(): void {
    this.store = this.registry.get('store') as GameStore;
    if (!this.cityId) this.cityId = this.store.selectedCityId ?? this.store.world.cities[0]!.id;
    this.layout = this.store.layouts[this.cityId]!;
    this.cameras.main.setBackgroundColor('#08111d');
    this.drawTilemap();
    const s = this.layout.width * TILE_SIZE * TILE_SCALE;
    const h = this.layout.height * TILE_SIZE * TILE_SCALE;
    this.add.rectangle(0, 0, s, h, 0x08111d, 0.14).setOrigin(0).setDepth(1);
    this.drawRoadMarkings();
    this.overlay = this.add.graphics().setDepth(3);
    this.drawDistrictLabels();
    this.createDistrictZones();
    this.createBuildingZones();
    this.hover = this.add.graphics().setDepth(9);
    this.selection = this.add.graphics().setDepth(10);
    this.drawOverlay();
    this.drawSelection();
    this.setupCamera();
    this.setupInput();

    this.unsub = this.store.subscribe(() => this.onStoreChange());
    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsub?.();
      this.scale.off('resize', this.handleResize, this);
    });
  }

  private onStoreChange(): void {
    if (!this.scene.isActive()) return;
    if (this.store.view === 'region') {
      this.scene.start('RegionalScene');
      return;
    }
    if (this.store.selectedCityId !== this.cityId) {
      this.scene.restart({ cityId: this.store.selectedCityId });
      return;
    }
    this.drawOverlay();
    this.drawSelection();
  }

  private drawTilemap(): void {
    const map = this.make.tilemap({
      data: this.layout.tiles,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
    });
    const tileset = map.addTilesetImage('city-tiles', 'city-tiles', TILE_SIZE, TILE_SIZE, 0, 0);
    if (!tileset) return;
    const layer = map.createLayer(0, tileset, 0, 0);
    if (!layer) return;
    layer.setScale(TILE_SCALE).setDepth(0);
  }

  private drawRoadMarkings(): void {
    const g = this.add.graphics().setDepth(2);
    const s = TILE_SIZE * TILE_SCALE;
    g.lineStyle(2, 0xf2c14e, 0.62);
    const dash = s * 0.5;
    const gap = s * 0.5;
    for (const tileX of [10, 28]) {
      const x = tileX * s + s / 2;
      for (let tileY = 0; tileY < this.layout.height; tileY++) {
        if ([8, 9, 10, 21, 22, 23].includes(tileY)) continue;
        const y = tileY * s;
        g.lineBetween(x, y + gap * 0.4, x, y + gap * 0.4 + dash);
      }
    }
    for (const tileY of [9, 22]) {
      const y = tileY * s + s / 2;
      for (let tileX = 0; tileX < this.layout.width; tileX++) {
        if ([9, 10, 11, 27, 28, 29].includes(tileX)) continue;
        const x = tileX * s;
        g.lineBetween(x + gap * 0.4, y, x + gap * 0.4 + dash, y);
      }
    }
    // 少量路口方向箭头
    g.lineStyle(2, 0xe8f4ff, 0.28);
    for (const [x, y] of [[10, 4], [28, 4], [10, 17], [28, 17], [10, 28], [28, 28]] as const) {
      g.lineBetween(x * s + s / 2, y * s + s * 0.35, x * s + s / 2, y * s + s * 0.65);
      g.lineBetween(x * s + s * 0.38, y * s + s * 0.5, x * s + s / 2, y * s + s * 0.35);
    }
  }

  private districtRect(district: DistrictDefinition): { x: number; y: number; w: number; h: number } {
    const s = TILE_SIZE * TILE_SCALE;
    return {
      x: district.tileX * s,
      y: district.tileY * s,
      w: district.tileW * s,
      h: district.tileH * s,
    };
  }

  private drawDistrictLabels(): void {
    for (const district of this.layout.districts) {
      const r = this.districtRect(district);
      const label = this.add.text(r.x + 10, r.y + 8, district.name, {
        fontFamily: FONT,
        fontSize: '13px',
        color: '#dff4ff',
        backgroundColor: 'rgba(8,17,29,0.62)',
        padding: { x: 6, y: 3 },
      }).setDepth(6).setAlpha(0.9);
      label.setShadow(0, 1, '#000000', 2);
    }
    const city = this.store.world.cities.find((entry) => entry.id === this.cityId);
    if (city) {
      this.add.text(TILE_SIZE * TILE_SCALE + 12, 12, `${city.name} · ${city.englishName}`, {
        fontFamily: FONT,
        fontSize: '22px',
        color: '#f4fbff',
        fontStyle: 'bold',
      }).setDepth(12).setShadow(0, 2, '#000000', 4);
    }
  }

  private createDistrictZones(): void {
    for (const district of this.layout.districts) {
      const r = this.districtRect(district);
      const zone = this.add.zone(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      zone.on('pointerover', () => {
        this.drawOutline(r, 0x84e4ff, 0.55);
      });
      zone.on('pointerout', () => {
        this.hover.clear();
        this.drawSelection();
      });
      zone.on('pointerdown', () => {
        if (this.didDrag) return;
        this.store.selectDistrict(district.id);
      });
    }
  }

  private createBuildingZones(): void {
    const s = TILE_SIZE * TILE_SCALE;
    for (const building of this.layout.buildings) {
      const x = building.tileX * s;
      const y = building.tileY * s;
      const w = building.width * s;
      const h = building.height * s;
      const zone = this.add.zone(x + w / 2, y + h / 2, w, h)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      const rect = { x, y, w, h };
      zone.on('pointerover', () => {
        this.drawOutline(rect, 0xffffff, 0.9);
        this.input.setDefaultCursor('pointer');
      });
      zone.on('pointerout', () => {
        this.input.setDefaultCursor('default');
        this.hover.clear();
        this.drawSelection();
      });
      zone.on('pointerdown', () => {
        if (this.didDrag) return;
        this.store.selectBuilding(building.id);
      });
      zone.setData('building', building);
    }
  }

  private drawOutline(rect: { x: number; y: number; w: number; h: number }, color: number, alpha: number): void {
    this.hover.clear();
    this.hover.lineStyle(3, color, alpha);
    this.hover.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }

  private drawSelection(): void {
    this.selection.clear();
    const selectedId = this.store.selectedBuildingId;
    this.selectedBuildingId = selectedId;
    if (selectedId) {
      const building = this.layout.buildings.find((entry) => entry.id === selectedId);
      if (building) {
        this.selection.lineStyle(3, 0xf2c14e, 0.95);
        this.selection.strokeRect(
          building.tileX * TILE_SIZE * TILE_SCALE,
          building.tileY * TILE_SIZE * TILE_SCALE,
          building.width * TILE_SIZE * TILE_SCALE,
          building.height * TILE_SIZE * TILE_SCALE,
        );
        this.selection.fillStyle(0xf2c14e, 0.08);
        this.selection.fillRect(
          building.tileX * TILE_SIZE * TILE_SCALE,
          building.tileY * TILE_SIZE * TILE_SCALE,
          building.width * TILE_SIZE * TILE_SCALE,
          building.height * TILE_SIZE * TILE_SCALE,
        );
      }
    }
    const districtId = this.store.selectedDistrictId;
    if (districtId) {
      const district = this.layout.districts.find((entry) => entry.id === districtId);
      if (district) {
        const r = this.districtRect(district);
        this.selection.lineStyle(2, 0x84e4ff, 0.7);
        this.selection.strokeRect(r.x, r.y, r.w, r.h);
      }
    }
  }

  private drawOverlay(): void {
    this.overlay.clear();
    for (const district of this.layout.districts) {
      const r = this.districtRect(district);
      let color = district.color;
      let alpha = 0.1;
      if (this.store.layer === 'population') {
        color = 0x4fc3f7;
        alpha = 0.04 + district.populationShare * 0.9;
      } else if (this.store.layer === 'economy') {
        color = 0xf2c14e;
        alpha = 0.04 + district.landValueFactor * 0.1;
      } else {
        alpha = 0.16;
      }
      this.overlay.fillStyle(color, alpha);
      this.overlay.fillRect(r.x, r.y, r.w, r.h);
      this.overlay.lineStyle(1, color, 0.4);
      this.overlay.strokeRect(r.x, r.y, r.w, r.h);
    }
  }

  private viewportInsets(): { left: number; right: number; top: number; bottom: number } {
    return {
      left: Math.min(320, this.scale.width * 0.24),
      right: Math.min(400, this.scale.width * 0.3),
      top: 76,
      bottom: 150,
    };
  }

  private applyCameraViewport(): void {
    const camera = this.cameras?.main;
    if (!camera) return;
    const insets = this.viewportInsets();
    const width = Math.max(360, this.scale.width - insets.left - insets.right);
    const height = Math.max(300, this.scale.height - insets.top - insets.bottom);
    camera.setViewport(insets.left, insets.top, width, height);
  }

  private setupCamera(): void {
    const s = TILE_SIZE * TILE_SCALE;
    const camera = this.cameras.main;
    this.applyCameraViewport();
    camera.setBounds(0, 0, this.layout.width * s, this.layout.height * s);
    const mapCenterX = (this.layout.width * s) / 2;
    const mapCenterY = (this.layout.height * s) / 2;
    camera.centerOn(mapCenterX, mapCenterY);
    camera.setZoom(0.45);
    camera.roundPixels = true;
  }

  private setupInput(): void {
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) return;
      this.dragStart = {
        x: pointer.x,
        y: pointer.y,
        scrollX: this.cameras.main.scrollX,
        scrollY: this.cameras.main.scrollY,
      };
      this.didDrag = false;
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.dragStart || !pointer.isDown) return;
      const dx = pointer.x - this.dragStart.x;
      const dy = pointer.y - this.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) this.didDrag = true;
      const camera = this.cameras.main;
      camera.scrollX = this.dragStart.scrollX - dx / camera.zoom;
      camera.scrollY = this.dragStart.scrollY - dy / camera.zoom;
    });
    this.input.on('pointerup', () => {
      this.dragStart = null;
      window.setTimeout(() => {
        this.didDrag = false;
      }, 0);
    });
    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _objects: unknown[], _dx: number, dy: number) => {
      const camera = this.cameras.main;
      const next = Phaser.Math.Clamp(camera.zoom * (dy > 0 ? 0.9 : 1.1), 0.45, 1.8);
      camera.setZoom(next);
    });
  }
}
