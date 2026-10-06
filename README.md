# dsh-tool-modpack

[![npm version](https://img.shields.io/npm/v/dsh-tool-modpack.svg)](https://www.npmjs.com/package/dsh-tool-modpack)
[![license](https://img.shields.io/npm/l/dsh-tool-modpack.svg)](LICENSE)

> DeepSeek Harness（DSH）Tool 插件集：**22 个 `modpack_*` 工具**，覆盖 Minecraft 整合包从规划、环境搭建、
> 模组管理、配置定制、任务书生成、**界面设计（含 AI 生图）**、本地化、测试验证到多平台发布的完整生命周期。
> 零 MCP 依赖、零外部构建工具：Modrinth API 与生图 API 都走原生 `fetch`，依赖解析 / 打包 / SNBT 生成 / UI 组装全部在插件内部实现。

---

## 1. 快速开始

```powershell
# 1) 安装依赖并构建
cd H:\ai\dsh-tool-modpack
pnpm install
pnpm run build          # tsc → lib/

# 2) 类型检查 + 全部测试 + 构建（一条命令跑完）
pnpm run verify

# 3) 装进 DSH profile（例如 desktop / web）—— 三选一
dsh plugin --profile desktop add dsh-tool-modpack                       # npm（0.1.0 起已发布，推荐）
dsh plugin --profile desktop add "github:cyy13045/dsh-tool-modpack"     # GitHub 源（随包发布 lib/，免构建）
dsh plugin --profile desktop add "link:H:\ai\dsh-tool-modpack"          # 本地目录（改代码时用）

#    如果被 pnpm 的供应链策略拦下（Lockfile failed supply-chain policy check）：
#    $env:npm_config_minimum_release_age="0"; dsh plugin --profile desktop add <同上>
```

重启 / 重载 DSH 后，Agent 即可看到 22 个 `modpack_*` 工具。

**临时试装（不改 profile，只叠加一层 patch）：**

```powershell
dsh --profile web --patch H:\ai\dsh-tool-modpack\cordis.patch.yml
```

---

## 2. 目录结构

```
dsh-tool-modpack/
├── cordis.patch.yml     # bundle patch 层：把本包插进 loader 根列表
├── package.json         # dsh.bundle.patch 指向 cordis.patch.yml；main = lib/index.js
├── tsconfig.json        # NodeNext + strict，输出 lib/
├── vitest.config.ts
├── src/
│   ├── index.ts         # 插件入口：name / inject / apply + 22 个 defineTool
│   ├── modrinth.ts      # Modrinth REST API v2 客户端（宽松映射，不假设响应结构）
│   ├── resolver.ts      # 依赖解析器（BFS + 环检测，最大深度 50）+ 冲突规则表
│   ├── packer.ts        # 自研 zip 读写 + mrpak / CurseForge zip / 手动整包导出
│   ├── config-gen.ts    # 配置覆盖生成器（json / toml / properties / snbt，深合并 + 备份）
│   ├── quest-gen.ts     # FTB Quests SNBT 生成器（含自研 SNBT 序列化器）
│   ├── image-gen.ts     # AI 生图客户端（Provider 抽象）+ PNG 编码 + sharp 后处理
│   ├── ui-pack.ts       # UI 材质包组装器（pack.mcmeta / PackMenu / Polytone / Vistas）
│   ├── i18n.ts          # 本地化：扫描 + 术语表翻译 + 语言资源包打包
│   ├── tester.ts        # 结构校验 + 测试清单生成
│   ├── publisher.ts     # 多平台发布元数据生成
│   └── util.ts          # 共享层（fetch 抽象、CRC32、限速器、路径闸门、fs 小工具）
└── tests/
    ├── resolver.spec.ts
    ├── packer.spec.ts
    ├── quest-gen.spec.ts
    ├── image-gen.spec.ts
    ├── ui-pack.spec.ts
    ├── i18n.spec.ts
    └── tools.spec.ts    # 额外：22 工具端到端（真实 Cordis 上下文 + output.schema 校验）
```

> `src/util.ts` 与 `tests/tools.spec.ts` 是在原始骨架之外新增的两个文件：前者收敛被多模块复用的工具函数，
> 后者用来验证「注册契约 + 输出契约 + 落盘行为」，避免只测模块而漏掉插件入口。

---

## 3. 22 个工具（7 阶段）

| 阶段 | # | 工具 | 职责 |
| --- | --- | --- | --- |
| **一 规划与初始化** | 1 | `modpack_plan` | 由主题生成规划：配色、模组分类与候选模组、里程碑、任务章节大纲、生图 prompt、风险清单、后续工具序列 |
| | 2 | `modpack_create` | 建实例目录结构（mods/config/resourcepacks/shaderpacks/ftbquests/packmenu/polytone/ui/publish）+ 实例元数据 + README |
| | 3 | `modpack_setup_env` | Java 主版本推导、内存建议、Aikar 风格 G1GC 参数、`instance.cfg` / `jvm-args.txt` / `start.bat` / `start.sh` |
| **二 模组管理** | 4 | `modpack_search_mods` | Modrinth 搜索（版本 + 加载器 + 分类 + 排序 + 分页） |
| | 5 | `modpack_add_mod` | 选定版本 → 递归解析依赖 → 下载 jar 到 `mods/` → 冲突检查 |
| | 6 | `modpack_resolve_deps` | 只解析不下载：拓扑顺序、角色（root/required/optional/embedded）、深度、请求者、缺版本/循环/超限问题 |
| | 7 | `modpack_check_conflicts` | 多版本、声明式不兼容、内置社区规则表（Sodium×OptiFine / JEI·REI·EMI / Fabric×Forge …） |
| | 8 | `modpack_add_optimization` | light / balanced / aggressive 三档性能模组清单（Fabric 与 Forge 两套，client / server 分开） |
| **三 配置与内容** | 9 | `modpack_gen_config` | 生成/深合并配置覆盖（json·toml·properties·snbt）+ `options.txt` + `server.properties` + 模组配置路径建议 |
| | 10 | `modpack_gen_quests` | 生成 FTB Quests SNBT（chapters / chapter_groups / data），任务与奖励 id 确定性派生 |
| | 11 | `modpack_add_resources` | 资源包 / 光影包 / 数据包下载与本地 zip 纳入 |
| | 12 | `modpack_gen_readme` | 中/英双语 README（环境要求、安装步骤、模组清单、任务章节、FAQ、许可致谢） |
| **四 界面设计（含 AI 生图）** | 13 | `modpack_gen_ui_theme` | UI 设计方案：配色、风格关键词、背景/全景 6 面/按钮/图标/HUD/容器 prompt、PackMenu 布局骨架、UI 方案栈 |
| | 14 | `modpack_gen_menu_bg` | AI 生成主界面背景：`single`（一张图铺 6 面做静态全景）或 `panorama`（6 面各一张，统一 1024×1024）+ 渐变叠加层 |
| | 15 | `modpack_gen_ui_textures` | AI 生成 UI 材质：button / icon / hud / container / tooltip，自动尺寸与 prompt 模板 + 纯色背景抠除 |
| | 16 | `modpack_assemble_ui_pack` | 组装材质包：`pack.mcmeta` + 纹理 + PackMenu 按钮 JSON + Polytone 修饰符 + Vistas 清单 + lang，可选 zip |
| **五 本地化** | 17 | `modpack_scan_i18n` | 扫描待翻译：lang 缺键、FTB Quests 文本、PackMenu 按钮键、硬编码中文 |
| | 18 | `modpack_translate` | 批量翻译并打包语言资源包（显式译文 > 自定义词典 > 内置术语表） |
| **六 测试与验证** | 19 | `modpack_validate` | 结构/模组/依赖/配置语法/资源包/任务书/**凭据泄漏**七类校验 + markdown 报告 |
| | 20 | `modpack_gen_test_plan` | 七大类测试清单（blocker/major/minor）markdown 表格 |
| **七 打包与发布** | 21 | `modpack_export` | 导出 mrpak / CurseForge zip / 手动整包 zip，返回体积、sha256、包内条目 |
| | 22 | `modpack_publish` | 多平台发布元数据（Modrinth / CurseForge / GitHub Release / 社区帖）+ changelog + sha256 清单 + 合规检查 |

### 典型调用链

```
modpack_plan → modpack_create → modpack_setup_env
            → modpack_search_mods → modpack_add_mod → (modpack_resolve_deps / modpack_check_conflicts) → modpack_add_optimization
            → modpack_gen_config → modpack_gen_quests → modpack_add_resources → modpack_gen_readme
            → modpack_gen_ui_theme → modpack_gen_menu_bg ┐
                                     modpack_gen_ui_textures ┴→ modpack_assemble_ui_pack
            → modpack_scan_i18n → modpack_translate
            → modpack_validate → modpack_gen_test_plan
            → modpack_export → modpack_publish
```

`modpack_gen_ui_theme` 的输出（`palette` / `backgroundPrompt` / `panoramaPrompts` / `buttonPrompt` / `layout`）
可以直接喂给 `modpack_gen_menu_bg`、`modpack_gen_ui_textures`、`modpack_assemble_ui_pack`。

---

## 4. 界面设计阶段的硬性技术规格

### 4.1 原版主界面全景图

| 文件 | 方向 | 说明 |
| --- | --- | --- |
| `panorama_0.png` | North | 立方体六面，每面必须 **1024×1024**、FOV 90、相邻面相差 90° |
| `panorama_1.png` | East | |
| `panorama_2.png` | South | |
| `panorama_3.png` | West | |
| `panorama_4.png` | Up | 旋转必须与 `panorama_0` 一致 |
| `panorama_5.png` | Down | 旋转必须与 `panorama_0` 一致 |
| `panorama_overlay.png` | 叠加层 | 仅 1.20.2+ 的原版主菜单会叠加 |

路径固定为 `assets/minecraft/textures/gui/title/background/`。
本插件用 `type: "single"` 时会把同一张图写进 6 个面（静态全景，原版即可显示），并额外保留 `background.png`
给读取单张贴图的模组用；用 `type: "panorama"` 时逐面生成。

### 4.2 PackMenu（Forge / NeoForge，1.15+）

按钮定义是**资源**，由 `SimpleJsonResourceReloadListener("buttons")` 加载，因此路径为：

```
assets/<namespace>/buttons/<name>.json
```

字段名严格对齐 `JsonButton.deserialize`：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `x` / `y` / `width` / `height` | 尺寸与偏移（受 `anchor` 影响） | 0 / 0 / 0 / 0 |
| `texture` | 纹理资源位置 | `minecraft:textures/gui/widgets.png` |
| `u` / `v` / `hoverU` / `hoverV` | 悬停态切图坐标 | 0 |
| `texWidth` / `texHeight` | 源纹理尺寸 | 256 |
| `widgets` | 是否按原版 widgets 九宫拉伸 | 纹理名含 `widgets` 时 true |
| `langKey` / `hoverLangKey` | 文案语言键 | — |
| `action` | `CONNECT_TO_SERVER` / `LOAD_WORLD` / `REALMS` / `RELOAD` / `OPEN_GUI` / `OPEN_URL` / `QUIT` / `NONE` | 必填 |
| `data` | `CONNECT_TO_SERVER`=地址、`OPEN_GUI`=ScreenType、`OPEN_URL`=链接、`LOAD_WORLD`=世界名 | 视 action 必填 |
| `anchor` | `DEFAULT` / `TOP_LEFT` … `MIDDLE_CENTER` / `SPLASH` / `TITLE` / `JAVAED` / `FORGE` 等 15 个 | `DEFAULT` |
| `fontColor` / `hoverFontColor` | 0xRRGGBB 整数 | 16777215 |
| `textXOffset` / `textYOffset` | 文字偏移 | 0 / -4 |
| `dropShadow` / `active` / `scaleX` / `scaleY` | 渲染细节 | true / true / 1 / 1 |

`OPEN_GUI` 的 `data` 必须是 `ScreenType`：`SINGLEPLAYER` / `MULTIPLAYER` / `MODS` / `LANGUAGE` /
`OPTIONS` / `ACCESSIBILITY` / `RESOURCE_PACKS` / `SUPPORTERS`。

> ⚠️ PackMenu 自己的内置资源包读的是 `<gamedir>/packmenu/resources/`（folder pack）而不是本整合包的
> `resourcepacks/`。因此 `modpack_assemble_ui_pack` 会**同时**写两处，并在需要时写 `config/packmenu.json`
> （`"Folder Pack": true`、幻灯片 `general.slideshow.Textures`、`Panorama Variations` 等）。
> PackMenu 只存在于 Forge/NeoForge；Fabric 侧请改用 Vistas 或纯资源包方案（工具会给出提示）。

### 4.3 Polytone GUI 修饰符（1.19+）

```
assets/<namespace>/polytone/gui_modifiers/<name>.json
```

字段对齐 `GuiModifier.CODEC`：`target_type`（`menu_id` / `menu_class` / `screen_class` / `screen_title`）、
`target`、`slot_modifiers`、`texts`、`sprites`、`widget_modifiers`、`special_offsets`、
`title_x_offset` / `title_y_offset` / `label_x_offset` / `label_y_offset`、
`x_offset` / `y_offset` / `width_offset` / `height_offset`、`title_color` / `label_color`、`condition`。

- `sprites[]`：`{ texture, x, y, width, height, z?, tooltip? }`，`texture` 必须是 **gui sprite**
  资源位置（形如 `<ns>:widget/frame`，对应 `assets/<ns>/textures/gui/sprites/widget/frame.png`）。
- `texts[]`：`{ text, x, y, z?, color?, centered? }`。
- 用 `screen_class` / `screen_title` 时不允许改槽位位置（上游会直接报错）。

### 4.4 Vistas（Fabric 1.20+）

纯资源包即可添加全景与菜单音乐：`assets/<namespace>/panoramas.json`，条目含 `cubemapId`、
`rotationControl`（`frozen` / `speedMultiplier` …）、`visualControl`（`fov` / `colorR`…）、可选 `musicSound`。

### 4.5 资源包目录结构（写入前逐条校验）

```
assets/<ns>/textures/gui/title/background/panorama_0..5.png
assets/<ns>/textures/gui/title/background/panorama_overlay.png
assets/<ns>/textures/gui/sprites/{widget,icon,hud,container,tooltip}/*.png
assets/<ns>/textures/gui/widgets.png , icons.png
assets/<ns>/buttons/<name>.json            # PackMenu
assets/<ns>/polytone/gui_modifiers/<n>.json
assets/<ns>/panoramas.json                 # Vistas
assets/<ns>/lang/<locale>.json
pack.mcmeta
```

`validateUiAssetPath()` 会拒绝：非 `assets/` 开头、含 `..`、命名空间非法（只允许小写字母数字与 `_.-`）、
`textures/` 下非 `.png`、`assets/<ns>/` 下出现白名单外的子目录。**路径写错不会报错、只会静默不生效，
所以这里直接 throw。**

### 4.6 pack_format 对照（`packFormatFor`）

| MC | format | MC | format |
| --- | --- | --- | --- |
| 1.16.2–1.16.5 | 6 | 1.20.2 | 18 |
| 1.17–1.17.1 | 7 | 1.20.3–1.20.4 | 22 |
| 1.18–1.18.2 | 8 | 1.20.5–1.20.6 | 32 |
| 1.19–1.19.2 | 9 | 1.21–1.21.1 | 34 |
| 1.19.3 | 12 | 1.21.2–1.21.3 | 42 |
| 1.19.4 | 13 | 1.21.4 | 46 |
| 1.20–1.20.1 | 15 | 1.21.5 | 55 |
| | | 1.21.6 | 63 |
| | | 1.21.7–1.21.8 | 64 |

1.20.2+ 会额外写入 `supported_formats`；表未覆盖的新版本号（如 `26.1`）回落为最新已知值并在结果里给出说明。

---

## 5. AI 生图

### 5.1 Provider 抽象

```ts
interface ImageProvider {
  readonly id: 'pollinations' | 'wanx' | 'sdapi'
  readonly requiresKey: boolean
  readonly minIntervalMs: number
  generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage>
}
```

| Provider | 是否需要 Key | 环境变量 | 默认模型 | 限速 |
| --- | --- | --- | --- | --- |
| **Pollinations.ai（默认）** | 否 | — | `turbo` | 匿名约 1 req/15s |
| 通义万相 V2 | 是 | `DASHSCOPE_API_KEY`（或 `WANX_API_KEY`）+ `WANX_WORKSPACE_ID` | `wan2.6-t2i` | 2s |
| Stable Diffusion API | 是 | `SD_API_KEY` | `stable-diffusion-xl` | 2s |

- Key 一律从 `process.env` 读取，**代码里没有任何硬编码 Key**；缺失时抛出带环境变量名的明确错误，
  并提示「免 Key 可用 provider="pollinations"」。
- Pollinations 实测行为：必须带 `model` + `nologo=true`（否则可能返回 0 字节），建议带 `referrer`；
  额度用尽返回 **HTTP 402**，插件按 `isRetryableStatus()` 退避重试（不是直接失败）。
- 响应解析不假设结构：Wanx / SD 的返回里用 `findFirstUrl()` 递归找第一个可下载地址再去下载。

### 5.2 图像后处理

- **纯 JS PNG 编码器**（`encodePng` / `gradientPng` / `solidPng`）：零依赖生成渐变叠加层、纯色占位纹理，
  可直接用 sharp 反解验证合法。
- **sharp 惰性导入**：缩放/转码/抠图时才 `await import('sharp')`，缺失时给出「请先 pnpm install」的可读错误，
  而不是让整个插件加载失败。Pollinations 输出 JPEG，而 Minecraft 纹理必须是 PNG，所以 `sharp` 是本插件的
  **运行时依赖**（`dependencies` 而非 devDependencies）。
- **背景抠除**：`removeSolidBackground()` 按基色距离阈值 + 羽化边缘生成带 alpha 的 PNG，
  用来把「纯色背景 + 主体」的 AI 出图变成可用的透明图标/按钮。

---

## 6. mrpak 格式（本插件定义，v1）

```
mrpak.json      清单：format/formatVersion、name/version/authors、minecraft{version,loader,loaderVersion}、
                files[{path,size,sha256}]、mods[{projectId,slug,versionId,fileName,path,sha1,url,required}]
manifest.json   CurseForge 兼容清单（有 CF 数字 id 时写 files，否则降级为实体 jar + 说明）
mods/*.jar      模组实体文件
overrides/      配置覆盖目录（CurseForge 格式导出时）
config/ …       实例内容（按导出格式决定放在根还是 overrides/ 下）
```

zip 读写是自研实现（`node:zlib` 的 raw deflate，store + deflate 均支持），
`collectFiles()` 默认跳过 `logs` / `saves` / `screenshots` / `crash-reports` / `backups` / `cache` / `.git` 等噪声目录。

---

## 7. 与 DSH 契约的对应

| 契约 | 实现 |
| --- | --- |
| 插件入口导出 `name` / `inject: ['tools']` / `apply(ctx)` | `src/index.ts` |
| `ctx.tools.register(defineTool({...}))` | 每个工具一次，共 22 次；外面包 `ctx.effect(...)` 保证卸载时逐一注销 |
| `defineTool` 字段 `name / description / parameters / output.schema / output.render / execute` | 22 个工具全部声明完整字段 |
| `execute` 只返回一个 canonical 值 | 所有 `execute` 返回纯 JSON 对象，且通过自己的 `output.schema`（`additionalProperties: false`） |
| 抛异常即 `isError` | 所有网络/磁盘故障直接 `throw`（`ModpackError` 带 code，消息面向模型可读） |
| 不省略 `parameters` 与 `output.schema` | 每个工具都声明；schema 由 `defineTool` 在定义期编译，写错会在加载时立刻报错 |

---

## 8. 测试与验证

```
pnpm run verify      # typecheck + 101 个测试 + build
```

| 测试文件 | 覆盖点 |
| --- | --- |
| `resolver.spec.ts` | BFS 依赖展开、可选依赖、环检测、深度上限 50、缺版本降级、冲突规则 |
| `packer.spec.ts` | zip 往返、二进制无损、目录收集过滤、mrpak / CF / 手动三种导出结构 |
| `quest-gen.spec.ts` | SNBT 转义与后缀、章节渲染、id 确定性、幂等重生成、告警、dryRun |
| `image-gen.spec.ts` | mock fetch 断言请求参数（尺寸/种子/模型/nologo/referrer）、402 退避重试、缺 Key 报错、Wanx 请求体与 URL 提取、PNG 编码（sharp 反解）、渐变、抠图 |
| `ui-pack.spec.ts` | pack_format 对照、路径校验拒绝用例、PackMenu/Polytone/Vistas JSON 结构、完整组装（含 packmenu 镜像）、zip 内容 |
| `i18n.spec.ts` | 中文检测、占位符保护、术语表、SNBT 文本抽取、缺失键扫描、翻译打包与 dryRun |
| `tools.spec.ts` | **真实 Cordis 上下文**加载（`inject: ['tools']` + 卸载注销）、22 工具注册与 schema 结构、端到端调用 15 个离线工具并用 `validateJsonSchemaValue` 校验返回值、错误路径 |

联网工具（`modpack_search_mods` / `modpack_add_mod` / `modpack_resolve_deps` / `modpack_add_optimization` /
`modpack_add_resources` / `modpack_gen_menu_bg` / `modpack_gen_ui_textures`）在测试里只验证参数与错误路径；
它们的真实网络行为由模块级测试（`image-gen.spec.ts` 的 mock fetch、`resolver.spec.ts` 的假数据源）覆盖。

---

## 9. 已知限制与注意事项

1. **Pollinations 匿名额度**很紧（约 1 请求/15 秒），6 面全景图至少要 ~2 分钟；并发调用会拿到 402。
   插件已内置串行限速与退避，但请不要把它当成批量生图后端。
2. **sharp 是运行时依赖**：不带 `node_modules` 分发插件时，必须在目标 profile 里安装依赖，
   否则缩放/转码/抠图会抛出 `SHARP_UNAVAILABLE`（提示里写清了修复方式）。
3. **CurseForge 数字 id**：Modrinth 不提供 CF 的项目/文件数字 id。没有映射时导出的 CF 包会保留实体 jar
   并在 `notes` 里明确说明，不会静默丢模组。
4. `packFormatFor` 的表只到 1.21.8；更新版本会回落并给说明，请以实机加载结果为准。
5. 任务书 id 由内容派生：**发布后不要随意改任务标题或坐标**，否则玩家进度会重置。
6. 工具不会自动启用资源包：整合包应在 `options.txt` 的 `resourcePacks` 列表里预置，或由启动器默认开启。

### 环境注意事项（与插件无关，但会影响验证）

本机 `~/.dsh/profiles/{acp,headless,default}/cordis.patch.yml` 存在**预先存在的 YAML 语法错误**：
文件开头是 `[]`（一个完整文档），后面却直接跟了 `- id: system-prompt` 而没有 `---` 分隔符，
导致 `dsh --profile acp|headless|default --dump-config` 直接抛
`YAMLException: end of the stream or a document separator is expected`。
这是 `dsh-infinite-gen-4` 安装时把条目追加进默认 `[]` 之后造成的。修复方式：删掉那行孤立的 `[]`，
或在其后补一行 `---`。桌面版 profile 由 Electron 管理，不受影响。

---

## 10. 体积与临时文件

- 源码 + 测试 + 文档约 **250 KB**；`lib/`（构建产物）约 **500 KB**；
  `node_modules/` 是可重建的依赖目录（含 sharp 预编译二进制，约 30 MB），不要长期备份。
- `tmp/` 只放自检脚本（`smoke.mjs`、`check-patch.mjs`），**可以随时删除**，不影响构建与测试（已在 `.gitignore` 中忽略，不随仓库发布）。
- 没有任何大文件中转；生成物（AI 图片、整合包 zip）都会落到用户指定的整合包目录，不在本仓库内。
- `.gitignore` **刻意不忽略 `lib/`**：构建产物随源码发布，别人直接
  `dsh plugin --profile desktop add "github:<owner>/dsh-tool-modpack"` 即可使用，无需本地构建。

---

## 11. 许可证

本插件以 **MIT License** 发布，见 [LICENSE](LICENSE)。

- 你可以自由地在自己的整合包/工具链里使用、修改、再分发本插件，只需保留版权与许可声明。
- 本插件**生成**的产物（资源包、任务书 SNBT、mrpak、发布元数据等）属于你自己的数据，不受本许可证约束。
- 插件内引用的第三方名称与规格（Modrinth API、PackMenu、Polytone、Vistas、Pollinations 等）版权归各自作者所有。
