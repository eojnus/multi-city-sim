# 素材署名 / Asset Attribution

本文件面向发布物：列出游戏运行时**实际使用**的第三方素材及其署名方式。
清单与核验细节见 `assets/manifests/` 与 `docs/assets/ASSET_REPORT.md`。

## 运行时使用的素材

### Kenney Roguelike Modern City (2.0) — 城市地图

- 作者：Kenney（https://www.kenney.nl）
- 许可：Creative Commons Zero（CC0 1.0 Universal）— https://creativecommons.org/publicdomain/zero/1.0/
- 使用范围：`public/assets/city/kenney-modern-city-tilemap.png`（城市地图图块集）
- 署名：CC0 不要求署名，本项目自愿署名。
- 许可全文：`public/assets/city/LICENSE-kenney-modern-city.txt`

### Kenney UI Pack (2.0) — 界面

- 作者：Kenney（https://www.kenney.nl）
- 许可：Creative Commons Zero（CC0 1.0 Universal）— https://creativecommons.org/publicdomain/zero/1.0/
- 使用范围：`public/assets/ui/buttons/`（按钮）、`public/assets/ui/icons/`（图标与分隔线）、`public/assets/ui/fonts/KenneyFuture.ttf`（界面字体）
- 署名：CC0 不要求署名，本项目自愿署名。
- 许可全文：`public/assets/ui/LICENSE-kenney-ui-pack.txt`

### Kenney Future 字体

- 字体：Kenney Future，随 Kenney UI Pack (2.0) 分发
- 作者：Kenney（https://www.kenney.nl）
- 许可：CC0 1.0 Universal
- 运行时路径：`public/assets/ui/fonts/KenneyFuture.ttf`

## 游戏内署名文案（建议）

> City tiles: Kenney — Roguelike Modern City (CC0)
> UI & font: Kenney — UI Pack (CC0)
> https://www.kenney.nl

## 未使用的素材

- **Rasak Modern Tilesets** — 未使用，**计划中**（尚未下载，尚未核验许可）。
  下载与接入需人工完成 itch.io 的 “Name Your Own Price” 流程，步骤见 `assets/manifests/asset-sources.json` 与 `docs/assets/ASSET_REPORT.md`。
  在许可与规格核验完成前，不得复制、发布或署名其素材。
- **Modern City Extension**（OpenGameArt，作者 rubberduck，CC0）— 未使用，仅作备用参考；未复制进 `public/assets/`，未混入主场景。

## 说明

- 本项目未使用任何来源不明或许可未核验的素材。
- 如后续接入上述“未使用”素材，必须同步更新本文件、`assets/manifests/asset-catalog.json` 与 `assets/manifests/licenses.json`。
