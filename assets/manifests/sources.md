# 美术资源来源与验收状态

最后更新：2026-11-01。详细证据、哈希、尺寸和许可原文见 `assets/manifests/` 与 `docs/assets/ASSET_REPORT.md`。

| 资源 | 用途 | 官方来源 | 实际状态 | 运行时路径 |
| --- | --- | --- | --- | --- |
| Rasak Modern Tilesets | 计划中的首选城市视觉 | https://rasak.itch.io/rasak-modern | **未下载（blocked-manual-download）**：itch.io “Name Your Own Price” 需人工完成购买/下载流程；未绕过、未伪造。2026-11-01 复核页面为 HTTP 200，文件 `Rasaks_Modern_Tileset.rar` 15 MB，页面标签 48×48 / RPG Maker MV/MZ / orthogonal；官方截图呈现俯视/3/4 建筑立面、水平垂直道路，**不是菱形等距**。手动步骤见 `asset-sources.json` 与 `ASSET_REPORT.md` 第 7 节。 | 无 |
| Kenney UI Pack (2.0) | 界面按钮、图标、字体 | https://kenney.nl/assets/ui-pack | 已下载并核验：CC0 1.0，包内 License.txt 原文已保留；4 个按钮、4 个图标/分隔线、Kenney Future 字体已进入运行时。 | `public/assets/ui/` |
| Kenney Roguelike Modern City (2.0) | 独立备用城市方案（当前城市地图实际使用） | https://kenney.nl/assets/roguelike-modern-city | 已下载并核验：CC0 1.0；`tilemap_packed.png` 592×448，16×16，37×28=1036 tiles，**实测 spacing=0、margin=0**（Tilesheet.txt 的 1px 描述属于未分发的 `tilemap.png`）。作为当前唯一城市图块体系。 | `public/assets/city/kenney-modern-city-tilemap.png` |
| Modern City Extension | Kenney 备用体系扩展 | https://opengameart.org/content/modern-city-extension | 已下载并核验尺寸 896×736；CC0 声明；状态 `downloaded-verified-reference-only`，**未复制进运行时、未混入主场景**。 | 仅 `assets/source-packs/`（gitignored） |
| Pulse Everyday Streets 16×16 | 候补/风格参考 | https://edfaygo.itch.io/pulse-everyday-streets-1616 | 未评估、未下载；不进入首版。 | 无 |

## 风格与隔离决定

- 当前城市地图 **只使用 Kenney Roguelike Modern City** 一套 16×16 图块；没有混入 Rasak、Modern City Extension 或 Pulse 的像素。
- 界面 **只使用 Kenney UI Pack**。
- Kenney 城市包与 Modern City Extension 属于独立备用体系；若未来切换，必须一次性替换图块集合并同步 `asset-catalog.json`、`asset-sources.json`、`licenses.json` 和游戏内署名。
- Rasak 未获取，因此首版不能声称“已使用 Rasak 主美术”。游戏内“资源署名”面板明确标注这一点。

## 清单与预览

- `assets/manifests/asset-catalog.json`：资源 ID、来源文件、运行时路径、尺寸、许可、作者、SHA-256、导入状态。
- `assets/manifests/asset-sources.json`：五个来源状态与 Rasak 人工步骤。
- `assets/manifests/licenses.json`：许可核验结论。
- `assets/previews/kenney-modern-city-tilemap-4x.png`、`kenney-modern-city-sample-block.png`、`kenney-ui-buttons.png`：预览图。
- `assets/ATTRIBUTION.md`：发布物署名文本。

原始下载包保留在 gitignored 的 `assets/source-packs/`，不纳入 Git；运行时只分发已核验许可的 Kenney 子集。
