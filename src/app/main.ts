import Phaser from 'phaser';
import '../ui/styles.css';
import { Simulation } from '../simulation/core/simulation';
import { GameStore } from './gameStore';
import { createSaveBridge } from '../platform/saveBridge';
import { installBundledFonts } from '../platform/assets';
import { GameUI } from '../ui/ui';
import { BootScene } from '../presentation/scenes/BootScene';
import { RegionalScene } from '../presentation/scenes/RegionalScene';
import { CityScene } from '../presentation/scenes/CityScene';
import { DEMO_CONFIG } from '../data/config';

async function bootstrap(): Promise<void> {
  await installBundledFonts();
  const bridge = createSaveBridge();
  const store = new GameStore(Simulation.create(), bridge);

  const root = document.getElementById('app');
  if (!root) throw new Error('缺少 #app 根节点');
  root.innerHTML = '';
  const gameRoot = document.createElement('div');
  gameRoot.id = 'game-root';
  root.appendChild(gameRoot);

  const restored = await store.tryRestoreAutosave();
  if (restored) {
    store.toast('已恢复上次自动存档；可从存档面板读取其他手动存档。', 'info');
  }

  const ui = new GameUI(store, bridge);
  ui.mount(root);
  store.bindMenu();

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#08111d',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: '100%',
      height: '100%',
    },
    render: {
      antialias: false,
      pixelArt: true,
      roundPixels: true,
    },
    audio: { noAudio: true },
    scene: [BootScene, RegionalScene, CityScene],
    callbacks: {
      preBoot: (game) => {
        game.registry.set('store', store);
      },
    },
  };
  const game = new Phaser.Game(config);

  let lastAutoTick = Date.now();
  let wasAutoRunning = false;
  window.setInterval(() => {
    if (!store.autoRunning) {
      wasAutoRunning = false;
      return;
    }
    if (!wasAutoRunning) {
      wasAutoRunning = true;
      lastAutoTick = Date.now();
      return;
    }
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastAutoTick < DEMO_CONFIG.ui.autoTickMs) return;
    lastAutoTick = now;
    if (!store.tick()) {
      store.setAutoRunning(false);
    }
  }, 220);

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
    if (event.code === 'Space') {
      event.preventDefault();
      store.setAutoRunning(!store.autoRunning);
    } else if (event.code === 'KeyN') {
      store.tick();
    } else if (event.code === 'KeyR') {
      store.backToRegion();
    } else if (event.code === 'Digit1') {
      store.setLayer('population');
    } else if (event.code === 'Digit2') {
      store.setLayer('economy');
    } else if (event.code === 'Digit3') {
      store.setLayer('industry');
    } else if (event.code === 'Escape') {
      window.dispatchEvent(new CustomEvent('lanwan:escape'));
    }
  });

  window.addEventListener('beforeunload', () => {
    void store.autosave();
  });

  // 仅供自动化烟雾测试读取；不参与游戏逻辑。
  (window as unknown as { __lanwan?: unknown }).__lanwan = { store, game };
}

void bootstrap();
