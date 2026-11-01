import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    this.load.spritesheet('city-tiles', 'assets/city/kenney-modern-city-tilemap.png', {
      frameWidth: 16,
      frameHeight: 16,
    });
  }

  create(): void {
    if (!this.textures.exists('city-tiles')) {
      this.add.text(24, 24, '城市 tile 资源加载失败：请检查 assets/city/kenney-modern-city-tilemap.png', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '16px',
        color: '#ff8a80',
      });
    }
    this.scene.start('RegionalScene');
  }
}
