# 运行时素材核验报告

- 报告日期：2026-11-01
- 工作区：`C:\CODING-worktrees\first-playable`
- 范围：只新增/复制 `public/assets/`、`assets/previews/`、`assets/manifests/`、`assets/ATTRIBUTION.md`、`docs/assets/`；**未修改 `src/` 与 `package.json`**；未提交 Git。
- 源包保留在 gitignored 的 `assets/source-packs/`，未整体复制进运行时目录。

## 1. 结论摘要

1. 城市地图使用 **Kenney Roguelike Modern City (2.0)** 的打包图块集（592×448，16×16，37×28=1036 tiles），已作为唯一城市图块体系进入 `public/assets/city/`。
2. 界面使用 **Kenney UI Pack (2.0)** 的 4 个按钮、4 个图标/分隔线、1 个字体，已进入 `public/assets/ui/`。
3. 两个 Kenney 包均为 **CC0 1.0**，包内 `License.txt` 原文已核验并随包分发。字体（Kenney Future）随 UI Pack 分发，许可同上。
4. **Modern City Extension**（OpenGameArt，rubberduck，CC0）已下载并验证尺寸（896×736），状态为 `downloaded-verified-reference-only`：**未复制进 `public/assets`，未混入主场景**。
5. **Rasak Modern Tilesets 未下载**。状态 `blocked-manual-download`，原因与人工步骤见第 7 节。本仓库不存在任何 Rasak 图片、截图或派生物。
6. **Pulse Everyday Streets 未评估**（`not-evaluated`），未下载、未核验。
7. 三个清单 JSON 均通过 `JSON.parse`；所有复制文件与源文件 SHA-256 一致（逐字节相同）。

## 2. 许可结论

| 包 | 许可 | 可随应用分发 | 需署名 | 依据 |
| --- | --- | --- | --- | --- |
| Kenney Roguelike Modern City (2.0) | CC0 1.0 | **是** | 否（Kenney 请求署名但明确“not mandatory”） | 包内 `License.txt` 原文 |
| Kenney UI Pack (2.0)（含 Kenney Future 字体） | CC0 1.0 | **是** | 否（同上） | 包内 `License.txt` 原文 |
| Modern City Extension | CC0 1.0 | 当前**不分发**：仅作备用参考；若日后使用则同属 CC0 可分发 | 否 | OpenGameArt 资源页声明（本地无随包许可文件，证据强度弱于 Kenney） |
| Rasak Modern Tilesets | 未核验 | **否** | 未核验 | 未下载，无许可文件 |
| Pulse Everyday Streets | 未评估 | **否** | 未评估 | 未评估 |

**许可结论：Kenney（城市 + UI + 字体）为 CC0，可随应用自由分发（含商业用途），本项目仍主动署名。Modern City Extension 为 CC0，可作为备用参考，但当前未复制进 `public/assets`，未进入构建产物。Rasak 与 Pulse 在许可核验完成前不得分发。**

## 3. 来源与获取方式

| 来源 | 官方 URL | 下载方式 | 状态 | 本地路径 |
| --- | --- | --- | --- | --- |
| Kenney UI Pack (2.0) | https://kenney.nl/assets/ui-pack | 直接下载 zip | `downloaded-verified-integrated` | `assets/source-packs/kenney_ui-pack.zip` → `assets/source-packs/kenney-ui-pack/` |
| Kenney Roguelike Modern City (2.0) | https://kenney.nl/assets/roguelike-modern-city | 直接下载 zip | `downloaded-verified-integrated` | `assets/source-packs/kenney_roguelike-modern-city.zip` → `assets/source-packs/kenney-modern-city-backup/` |
| Modern City Extension | https://opengameart.org/content/modern-city-extension | 直接下载单张 PNG | `downloaded-verified-reference-only` | `assets/source-packs/modern-city-extension-city_extension.png` |
| Rasak Modern Tilesets | https://rasak.itch.io/rasak-modern | itch.io “Name Your Own Price”（人工） | `blocked-manual-download` | 无 |
| Pulse Everyday Streets 16x16 | https://edfaygo.itch.io/pulse-everyday-streets-1616 | 未尝试 | `not-evaluated` | 无 |

版本依据只取包内 License.txt 原文，不臆造版本号：
- UI Pack：`UI Pack (2.0)`，Creation date 12-06-2024
- Roguelike Modern City：`Roguelike Modern City (2.0)`，Creation date 29-10-2022

下载/导入日期：2026-11-01。

## 4. 运行时素材（`public/assets/`）

| 运行时路径 | 来源文件 | 类型 | 尺寸 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- | --- |
| `public/assets/city/kenney-modern-city-tilemap.png` | `kenney-modern-city-backup/Tilemap/tilemap_packed.png` | tilemap | 592×448 | 23387 | `e8b653bd3f32` |
| `public/assets/city/LICENSE-kenney-modern-city.txt` | `kenney-modern-city-backup/License.txt` | license | — | 580 | `24f97fdb24cf` |
| `public/assets/city/TILESET-SPEC.txt` | 由 `Tilesheet.txt` 生成（含原文） | spec | — | 844 | `f16eb2edfc14` |
| `public/assets/ui/buttons/grey/button_rectangle_depth_flat.png` | `kenney-ui-pack/PNG/Grey/Default/…` | ui-image | 192×64 | 383 | `7de9ba1d4bca` |
| `public/assets/ui/buttons/blue/button_rectangle_depth_flat.png` | `kenney-ui-pack/PNG/Blue/Default/…` | ui-image | 192×64 | 383 | `6c709a45aae0` |
| `public/assets/ui/buttons/green/button_rectangle_depth_flat.png` | `kenney-ui-pack/PNG/Green/Default/…` | ui-image | 192×64 | 383 | `f356ba760503` |
| `public/assets/ui/buttons/red/button_rectangle_depth_flat.png` | `kenney-ui-pack/PNG/Red/Default/…` | ui-image | 192×64 | 384 | `8dd648ea9b80` |
| `public/assets/ui/icons/icon_play_light.png` | `kenney-ui-pack/PNG/Extra/Default/…` | ui-icon | 30×34 | 323 | `59faa77de23b` |
| `public/assets/ui/icons/icon_play_outline.png` | `kenney-ui-pack/PNG/Extra/Default/…` | ui-icon | 34×38 | 489 | `3a1337b54cf9` |
| `public/assets/ui/icons/icon_repeat_light.png` | `kenney-ui-pack/PNG/Extra/Default/…` | ui-icon | 41×36 | 435 | `5aa70e5c395f` |
| `public/assets/ui/icons/divider.png` | `kenney-ui-pack/PNG/Extra/Default/divider.png` | ui-image | 64×4 | 89 | `234015ec6516` |
| `public/assets/ui/fonts/KenneyFuture.ttf` | `kenney-ui-pack/Font/Kenney Future.ttf` | font | — | 34160 | `7a55b07f5968` |
| `public/assets/ui/LICENSE-kenney-ui-pack.txt` | `kenney-ui-pack/License.txt` | license | — | 565 | `69f7eaa5e059` |

所有 5 个被要求“保持文件名”的图标/按钮文件名在源包中**均原样存在**，没有任何一项需要“选最接近的同名文件”替代。

`public/assets/city/TILESET-SPEC.txt` 内容 = 说明头 + `Tilesheet.txt` 原文（16×16 图块、1px 间距、37×28=1036 tiles）。

### 4.1 图块规格的重要事实（务必按此使用）

`tilemap_packed.png` 的真实几何是 **592×448 = 37×16 × 28×16，间距 0、边距 0**（592/16=37、448/16=28 整除）。`Tilesheet.txt` 里写的 “1px spacing” 描述的是**未打包**的 `Tilemap/tilemap.png`（该文件存在但未分发），不是本运行时文件。
因此渲染时：`index = col + row * 37`，`frame` 的 `spacing = 0`、`margin = 0`。`asset-catalog.json` 中已按真实值记录为 `spacing: 0, margin: 0`，并在 `notes` 中说明差异，避免接入时错位。

## 5. 预览图（`assets/previews/`，可提交）

| 文件 | 生成方式 | 尺寸 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| `kenney-modern-city-tilemap-4x.png` | 打包图块集最近邻放大 4× | 2368×1792 | 561332 | `8fe6c803ec8d` |
| `kenney-modern-city-sample-block.png` | 3 个 3×3 图块裁剪（col0,row0 / col9,row0 / col0,row5）各最近邻放大 8×，横排，间隔 16px | 1184×384 | 30950 | `fe355f6a7a49` |
| `kenney-ui-buttons.png` | 4 个按钮横排，最近邻放大 2×（即“放大 1 倍”） | 1536×128 | 6554 | `a8507245b672` |

生成参数：`System.Drawing`，`InterpolationMode.NearestNeighbor`、`PixelOffsetMode.Half`、`CompositingMode.SourceCopy`，无平滑、无模糊。

抽样图目视确认（`kenney-modern-city-sample-block.png`）：三块分别呈现红色屋顶模块、灰色屋顶模块、红砖外墙 + 女儿墙，边缘为硬像素，说明 col0/row0、col9/row0、col0/row5 三处均为有效建筑模块区域，裁剪偏移正确。

## 6. 实际集成范围与隔离说明

- **城市地图图层**：只用 Kenney Roguelike Modern City 一套图块；未混入 Modern City Extension、Rasak、Pulse 的任何像素。
- **界面层**：只用 Kenney UI Pack 的按钮/图标/分隔线/字体。
- **备用体系隔离**：Modern City Extension 仅存在于 gitignored 的 `assets/source-packs/`（单文件 896×736，SHA-256 `558d3c652489`），未进入 `public/assets/`，当前构建产物不包含它，也不参与任何 atlas/frame 配置。若切换体系，必须一次性替换并同步 catalog，禁止两套像素混排。
- **后续代码接入（2026-11-01 初版实现）**：`src/presentation/scenes/BootScene.ts` 以 `frameWidth/frameHeight = 16`、spacing 0 加载 `assets/city/kenney-modern-city-tilemap.png`；`CityScene.ts` 按 `col + row * 37` 直接使用 tile 索引组装 44×32 街区。`src/ui/` 通过 `assetUrl()` 使用 `public/assets/ui/` 的按钮/图标/字体。因此前述“已进入运行时资源目录”现在同时是“已被代码加载”。

## 7. Rasak Modern Tilesets：阻塞原因与人工步骤

**状态：`blocked-manual-download`（未下载）。**
原因：itch.io 的 *Name Your Own Price* 需要走页面上的购买/下载流程（含登录、0 元结账、生成下载链接）。这是需要人工确认的交易流程，不能自动化绕过，也不应伪造产物。因此本仓库没有 Rasak 的任何文件。

人工步骤：

1. 浏览器打开 https://rasak.itch.io/rasak-modern 。
2. 点击 **Download Now**。
3. 在 **Name your own price** 页面金额填 **0**（或自愿付费），继续。
4. 按 itch.io 提示完成流程（登录/邮箱验证等），下载压缩包。
5. 解压 `.rar` 到 `assets/source-packs/rasak-modern/`（该目录被 `.gitignore` 忽略，不会提交）。
6. 完整保留包内 `LICENSE` / `README` / credits 文件，不得删除或改名。
7. **人工核对 48×48 tile 规格**：读 README，并实测抽样图块像素尺寸（以及是否存在间距/边距）；不要仅凭描述下结论。
8. 许可与规格都确认后，才在 `assets/manifests/asset-catalog.json` 增加条目（`usageStatus` 先给 `reference-only`），并复制**经批准的子集**到 `public/assets/`。
9. 未经作者许可，不要把 Rasak 原图提交到公开仓库；本报告与清单中也不得出现其素材文件。

## 8. 未使用 / 未下载项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Modern City Extension（896×736） | 已下载、已验证、**仅参考** | 未复制进 `public/assets`；不混搭 |
| Rasak Modern Tilesets | 未下载（阻塞） | 见第 7 节 |
| Pulse Everyday Streets | 未评估 | 未打开页面、未核验许可、未下载 |
| Kenney 包内其余内容（1036 张单图 Tiles/、Sounds/、Vector/、Yellow/Double 等） | 未复制 | 只保留运行所需子集；原始包留在 gitignored 目录 |
| `Modern City Extension` 的许可文件 | 无本地文件 | 单张 PNG 未附许可；结论依据 OGA 资源页，已在 `licenses.json` 标注证据较弱 |

`assets/source-packs/` 根目录另有 `crop_buildings.png`、`crop_ground.png`、`crop_roads.png`、`grid_*.png` 等早期分析产物，**未复制、未引用、未纳入清单**。

## 9. 核验命令与实际输出

### 9.1 JSON 有效性

```
node -e "const fs=require('fs');for(const f of ['assets/manifests/asset-catalog.json','assets/manifests/asset-sources.json','assets/manifests/licenses.json']){const s=fs.readFileSync(f,'utf8');const j=JSON.parse(s);console.log('OK',f,Array.isArray(j)?('array len='+j.length):('keys='+Object.keys(j).join(',')))}"
```

输出：

```
OK assets/manifests/asset-catalog.json array len=10
OK assets/manifests/asset-sources.json keys=generatedAt,scope,sources
OK assets/manifests/licenses.json keys=verificationDate,verificationMethod,licenses
```

### 9.2 复制一致性（SHA-256 源 ↔ 运行时）

```
Get-FileHash -LiteralPath <src> -Algorithm SHA256 ; Get-FileHash -LiteralPath <dst> -Algorithm SHA256
```

输出：

```
public/assets/city/kenney-modern-city-tilemap.png  identical=True
public/assets/ui/LICENSE-kenney-ui-pack.txt  identical=True
public/assets/city/LICENSE-kenney-modern-city.txt  identical=True
public/assets/ui/fonts/KenneyFuture.ttf  identical=True
```

按钮/图标以同样的 `Get-FileHash` 比对，逐个与源文件一致（上表哈希即为源文件哈希）。

### 9.3 PNG 尺寸（System.Drawing 读取 IHDR）

```
Get-ChildItem public/assets -Recurse -Filter *.png | % { $i=[System.Drawing.Image]::FromFile($_.FullName); "$($_.Name) $($i.Width)x$($i.Height)"; $i.Dispose() }
```

输出：

```
kenney-modern-city-tilemap.png 592x448
button_rectangle_depth_flat.png 192x64      (×4，分属 grey/blue/green/red)
divider.png 64x4
icon_play_light.png 30x34
icon_play_outline.png 34x38
icon_repeat_light.png 41x36
```

预览图尺寸：`kenney-modern-city-tilemap-4x.png 2368x1792`、`kenney-modern-city-sample-block.png 1184x384`、`kenney-ui-buttons.png 1536x128`（预览生成脚本保存后回读确认）。

### 9.4 源包哈希（留档）

```
kenney_roguelike-modern-city.zip   519937   2a3f36b1bc3a3d1cb4b9da051c493d163c493fe54adc66e78e76b3fb4abcfc56
kenney_ui-pack.zip                 1229750  a8a14a234911eb648c062622915c93e79e94e97cb7f9f375a70f6617f1174318
modern-city-extension-city_extension.png 86204  558d3c65248971e977832d4cc364ecf3e8cc7f758e928cb8080777ce7dd26667
```

## 10. 与任务书字面要求的偏差（如实说明）

1. **UI 按钮落地路径**：4 个按钮源文件同名（`button_rectangle_depth_flat.png`，仅颜色目录不同），若平铺到同一目录会互相覆盖。为“保持文件名”且不丢文件，落到 `public/assets/ui/buttons/{grey,blue,green,red}/`，文件名不变。图标同理归入 `public/assets/ui/icons/`，字体按任务书改名为 `KenneyFuture.ttf`。
2. **间距/边距**：任务书的 “spacing 1 / margin 0（来自 Tilesheet.txt）” 与实际分发的 `tilemap_packed.png` 不符——该文件是 0 间距、0 边距的打包版（592×448 正好整除）。清单按实测写 `spacing: 0, margin: 0`，并在 `TILESET-SPEC.txt` 与 catalog `notes` 里注明 1px 描述属于未分发的 `tilemap.png`。这是唯一一处有意偏离任务书数值的地方，理由是事实优先。
3. **`kenney-ui-buttons.png`** 采用 2× 最近邻（“放大 1 倍”），故为 1536×128；若需 1× 版本可重生成。
4. **`asset-catalog.json` 顶层结构**：任务书要求“数组”，已按数组实现；`asset-sources.json` / `licenses.json` 为便于表达状态使用了对象包裹（`sources` / `licenses` 数组），符合“必须是有效 JSON”。

## 11. 遗留事项

- `src/` 接入 Phaser 加载这些路径（本次未改代码）。
- Rasak 需人工走完 itch.io 流程后再核验与接入。
- Pulse 若要评估，需先做许可核验。
- 若启用 Modern City Extension，需要一次性替换城市图块体系并同步三个 manifest。

## 12. Rasak 复核与视角评估（2026-11-01，验收修复轮次）

**取得状态：仍未下载。** 官方页面 https://rasak.itch.io/rasak-modern 在 2026-11-01 复核为 HTTP 200；页面显示：

- Updated：2026-10-27 15:13 UTC
- 价格：**Name Your Own Price**（最低 0），点击 `Download Now` 进入 `/purchase`
- 文件：`Rasaks_Modern_Tileset.rar`（15 MB）
- 标签：2D、**48×48**、asset pack、modern、pixel art、**RPG Maker MV / MZ**、tileset
- 作者说明：超过 40 个现代 tileset；允许商业/非商业使用与编辑，需署名 Rasak
- 这些是**页面文字**，不等于随包 LICENSE/README 已核验；**包级条款、图集尺寸、间距、图块网格仍未核验**。

**下载阻塞与人工步骤：** 同第 7 节；itch.io 的 Name Your Own Price 购买/下载流程需要人工完成。未绕过、未自动提交任何表单，也没有保留任何 Rasak 图片、截图或派生文件。原始 .rar 仍需人工获取后放入 gitignored 的 `assets/source-packs/rasak-modern/`，再核验包内许可与规格。

**视角判断（仅从官方页面截图与标签，不修改地图）：**

- 官方截图呈现**正交方格网格**、水平/垂直道路、俯视/3/4 建筑立面（RPG Maker 风格），**不是菱形等距（diamond isometric）**。
- 与当前 Kenney 16×16 顶视图块体系不兼容：如果采用 Rasak，需要整体替换为 48×48 的正交图块、重排 44×32 城市布局、重设相机与交互尺度；不能与 Kenney 混搭。
- 若未来采用“斜俯视”，**普通斜俯视（orthogonal 2.5D / 3/4 立面）比菱形等距更接近 Rasak 的素材形态**；菱形等距需要另一套真正的等距图块和坐标/碰撞/点击体系。当前先保留 Kenney 顶视方案，不擅自重做地图视角。

**结论：** 首版仍使用已核验的 Kenney 备用体系；Rasak 的“已取得/已核验/已集成”均不能声称。视角选型需架构负责人决定，建议在人工作品到手并检查完整图块后再做。
