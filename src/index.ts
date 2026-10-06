/**
 * dsh-tool-modpack — 插件入口。
 *
 * 导出 Cordis 契约所需的三件套：`name` / `inject` / `apply`。
 * apply 内通过 `ctx.tools.register(defineTool({...}))` 注册 **22 个** 工具，
 * 按整合包制作流程分 7 个阶段。插件卸载时由 Cordis 自动注销全部工具。
 *
 * 阶段划分：
 *   一 规划与初始化（3）：modpack_plan / modpack_create / modpack_setup_env
 *   二 模组管理（5）    ：modpack_search_mods / modpack_add_mod / modpack_resolve_deps
 *                         modpack_check_conflicts / modpack_add_optimization
 *   三 配置与内容（4）  ：modpack_gen_config / modpack_gen_quests / modpack_add_resources / modpack_gen_readme
 *   四 界面设计（4）    ：modpack_gen_ui_theme / modpack_gen_menu_bg / modpack_gen_ui_textures / modpack_assemble_ui_pack
 *   五 本地化（2）      ：modpack_scan_i18n / modpack_translate
 *   六 测试与验证（2）  ：modpack_validate / modpack_gen_test_plan
 *   七 打包与发布（2）  ：modpack_export / modpack_publish
 *
 * 约定：execute 只返回一个 canonical 值；任何网络/磁盘故障直接 throw（即 isError）。
 *
 * @module dsh-tool-modpack
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { applyConfigPlan, planConfigOverrides, writeConfigFiles, type ConfigFileSpec, type ConfigFormat } from './config-gen.js'
import {
  PANORAMA_FACE_SIZE,
  PANORAMA_FACES,
  PROVIDER_CATALOG,
  UI_ELEMENT_SPECS,
  buildBackgroundPrompt,
  buildPanoramaFacePrompt,
  buildUiElementPrompt,
  createImageProvider,
  defaultNegativePrompt,
  gradientPng,
  removeSolidBackground,
  resizeToPng,
  resolveProviderId,
  type ImageProviderId,
  type PromptContext,
  type UiElementType,
} from './image-gen.js'
import {
  GlossaryTranslator,
  renderUntranslatedNotice,
  scanI18n,
  translateAndPackage,
} from './i18n.js'
import {
  MODRINTH_API_BASE,
  ModrinthClient,
  type ModLoader,
  type ModrinthProject,
  type ModrinthSearchHit,
  type ModrinthVersion,
  type ProjectType,
  type SearchIndex,
  type VersionFilter,
} from './modrinth.js'
import {
  DEFAULT_PACK_INCLUDE,
  exportPack,
  type PackExportResult,
  type PackModEntry,
} from './packer.js'
import {
  buildPublishMetadata,
  listPublishableArtifacts,
  renderPublishSummary,
  type PublishPlatform,
} from './publisher.js'
import { generateQuestBook, type ChapterDraft, type QuestDraft, type QuestReward, type QuestTask } from './quest-gen.js'
import {
  checkConflicts,
  resolveDependencies,
  type ResolveRoot,
  type ResolutionIssue,
  type ResolvedNode,
  type VersionSource,
} from './resolver.js'
import { generateTestPlan, validatePack } from './tester.js'
import {
  assembleUiPack,
  deriveThemeColors,
  placeholderFramedTexture,
  renderPackMcmeta,
  shade,
  validateUiAssetPath,
  zipUiTextures,
  type PackMenuButton,
  type PackMenuConfig,
  type PolytoneGuiModifier,
  type UiTextureInput,
  type VistasPanoramaEntry,
} from './ui-pack.js'
import {
  ModpackError,
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  clampInt,
  ensureDir,
  nowIso,
  pathExists,
  readJsonSafe,
  requireString,
  resolveInside,
  sha1,
  slugify,
  writeFileEnsured,
} from './util.js'

// ── 插件元数据（Cordis 契约） ────────────────────────────────────────────────

/** 插件名。 */
export const name = 'dsh-tool-modpack'

/** 依赖的 Host 服务：只依赖 tools。 */
export const inject = ['tools'] as const

/**
 * 注册一个工具，并把「注册动作」绑定到当前 fiber 的 effect 上。
 * 这样插件（或 profile 层）卸载时，工具会被逐一注销，不需要手工管理 disposer。
 */
function registerTool(ctx: Context, definition: ToolDefinition): void {
  ctx.effect(() => ctx.tools.register(definition), `tool:${definition.name}`)
}

// ── 输入强制转换（模型给的是任意 JSON，必须显式收窄） ────────────────────────

function rec(value: unknown): Record<string, unknown> {
  return asRecord(value)
}

function arr(value: unknown): unknown[] {
  return asArray(value)
}

function str(value: unknown, fallback = ''): string {
  return asString(value, fallback)
}

function num(value: unknown, fallback = 0): number {
  return asNumber(value, fallback)
}

function bool(value: unknown, fallback = false): boolean {
  return asBoolean(value, fallback)
}

function loaderOf(value: unknown): ModLoader {
  const raw = str(value, 'fabric').toLowerCase()
  if (raw === 'fabric' || raw === 'forge' || raw === 'neoforge' || raw === 'quilt') return raw
  throw new ModpackError('INVALID_ARGUMENT', `不支持的加载器：${raw}（可用：fabric / forge / neoforge / quilt）`)
}

function formatOf(value: unknown): ConfigFormat {
  const raw = str(value, 'json').toLowerCase()
  if (raw === 'json' || raw === 'toml' || raw === 'properties' || raw === 'snbt') return raw
  throw new ModpackError('INVALID_ARGUMENT', `不支持的配置格式：${raw}（可用：json / toml / properties / snbt）`)
}

/** 由 MC 版本推导所需 Java 主版本。 */
export function javaVersionFor(minecraftVersion: string): { major: number; note: string } {
  const parts = minecraftVersion.split(/[.\-+]/).map((part) => Number.parseInt(part, 10))
  const minor = parts[0] ?? 1
  const patch = parts[1] ?? 0
  const revision = parts[2] ?? 0
  if (minor > 1) {
    // 2026 之后的新版本号体系（如 26.1）：默认 Java 21。
    return { major: 21, note: `未知版本号体系（${minecraftVersion}），按 Java 21 处理` }
  }
  if (patch < 17) return { major: 8, note: '1.16.5 及更早使用 Java 8' }
  if (patch === 17 || patch === 18 || patch === 19) return { major: 17, note: '1.17 - 1.19.x 使用 Java 17' }
  if (patch === 20 && revision <= 4) return { major: 17, note: '1.20 - 1.20.4 使用 Java 17' }
  if (patch === 20) return { major: 21, note: '1.20.5+ 需要 Java 21' }
  return { major: 21, note: '1.21+ 使用 Java 21' }
}

/** Aikar 风格 G1GC 参数（业界通用的大内存 Minecraft 服务端/客户端调优模板）。 */
export function jvmArgsFor(memoryGb: number, extra: string[] = []): string[] {
  const heap = clampInt(memoryGb, 2, 64, 6)
  const base = [
    `-Xms${heap}G`,
    `-Xmx${heap}G`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dfile.encoding=UTF-8',
  ]
  return [...base, ...extra.filter((item) => item.trim() !== '')]
}

/** 由模组数量给出建议内存。 */
export function suggestMemoryGb(modCount: number, modCount2?: number): number {
  void modCount2
  if (modCount <= 60) return 4
  if (modCount <= 150) return 6
  if (modCount <= 300) return 8
  return 10
}

// ── 共享：Modrinth 客户端与"下载式添加模组" ─────────────────────────────────

/** 构造 Modrinth 客户端（带取消信号）。 */
function modrinth(signal?: AbortSignal): ModrinthClient {
  return new ModrinthClient(signal !== undefined ? { signal } : {})
}

/** 安装一个模组版本到 mods/ 目录。 */
async function installVersion(
  client: ModrinthClient,
  packDir: string,
  version: ModrinthVersion,
  role: 'root' | 'required' | 'optional' | 'embedded',
  download: boolean,
): Promise<{ slug: string; title: string; versionId: string; fileName: string; path: string; size: number; sha1: string; role: string }> {
  const file = version.files.find((item) => item.primary) ?? version.files[0] ?? null
  if (file === null) {
    throw new ModpackError('NO_FILE', `版本 ${version.id} 没有任何文件，无法安装`)
  }
  const targetDir = resolveInside(packDir, 'mods')
  await ensureDir(targetDir)
  const target = resolveInside(packDir, 'mods', basename(file.filename))
  let size = file.size
  let digest = file.sha1
  if (download) {
    if (await pathExists(target)) {
      size = (await stat(target)).size
    } else {
      const result = await client.downloadFile(file, target)
      size = result.size
      digest = result.sha1
    }
  }
  let slug = version.projectId
  let title = version.name
  try {
    const project = await client.getProject(version.projectId)
    slug = project.slug
    title = project.title
  } catch {
    /* 项目详情失败不影响安装 */
  }
  return {
    slug,
    title,
    versionId: version.id,
    fileName: basename(file.filename),
    path: `mods/${basename(file.filename)}`,
    size,
    sha1: digest,
    role,
  }
}

/** 为一个项目挑选适配版本。 */
async function pickVersionFor(
  client: ModrinthClient,
  idOrSlug: string,
  versionId: string | null,
  minecraftVersion: string,
  loader: ModLoader,
): Promise<ModrinthVersion> {
  if (versionId !== null && versionId !== '') return client.getVersion(versionId)
  const versions = await client.getProjectVersions(idOrSlug, {
    loaders: [loader],
    gameVersions: [minecraftVersion],
  })
  const rank: Record<string, number> = { release: 0, beta: 1, alpha: 2 }
  const best = versions
    .slice()
    .sort((a, b) => {
      const byType = (rank[a.versionType] ?? 3) - (rank[b.versionType] ?? 3)
      if (byType !== 0) return byType
      return (b.datePublished ?? '').localeCompare(a.datePublished ?? '')
    })[0]
  if (best === undefined) {
    throw new ModpackError(
      'NO_MATCHING_VERSION',
      `项目 ${idOrSlug} 没有适配 Minecraft ${minecraftVersion} / ${loader} 的版本`,
    )
  }
  return best
}

/** 从 mods/ 目录读取已安装的模组文件名，反推 slug（用于冲突检查）。 */
async function readInstalledModSlugs(packDir: string): Promise<Array<{ slug: string; fileName: string }>> {
  const modsDir = join(packDir, 'mods')
  if (!(await pathExists(modsDir))) return []
  const entries = await readdir(modsDir)
  return entries
    .filter((entry) => entry.endsWith('.jar'))
    .map((entry) => ({
      slug: entry
        .replace(/\.jar$/, '')
        .replace(/[-_]?(?:fabric|forge|neoforge|quilt|mc)?[-_]?\d+(?:\.\d+)*.*$/, '')
        .replace(/[-_.]+/g, '-')
        .toLowerCase(),
      fileName: entry,
    }))
}

// ── 共享：纹理输入解析 ───────────────────────────────────────────────────────

async function resolveTextureInputs(
  packDir: string,
  raw: unknown,
): Promise<UiTextureInput[]> {
  const out: UiTextureInput[] = []
  for (const item of arr(raw)) {
    const record = rec(item)
    const path = str(record.path)
    if (path === '') continue
    const check = validateUiAssetPath(path)
    if (!check.ok) {
      throw new ModpackError('INVALID_ASSET_PATH', `纹理路径非法：${path} —— ${check.reason}`)
    }
    const base64 = str(record.base64)
    const sourceFile = str(record.sourceFile)
    if (base64 !== '') {
      out.push({ path: check.path, data: Buffer.from(base64, 'base64'), role: str(record.role, 'inline') })
      continue
    }
    if (sourceFile !== '') {
      const absolute = (await pathExists(sourceFile)) ? sourceFile : join(packDir, sourceFile)
      if (!(await pathExists(absolute))) {
        throw new ModpackError('NOT_FOUND', `找不到纹理源文件：${sourceFile}`)
      }
      const data = new Uint8Array(await readFile(absolute))
      const png = check.path.toLowerCase().endsWith('.png') ? data : data
      out.push({ path: check.path, data: png, role: str(record.role, basename(sourceFile)) })
      continue
    }
    throw new ModpackError('INVALID_ARGUMENT', `纹理 ${path} 既没有 base64 也没有 sourceFile`)
  }
  return out
}

/** 从 <packDir>/ui/ 目录自动收集已生成的纹理（路径按 assets/ 镜像存放）。 */
async function collectUiTexturesFromDir(packDir: string, uiDir = 'ui'): Promise<UiTextureInput[]> {
  const root = join(packDir, uiDir)
  if (!(await pathExists(root))) return []
  const out: UiTextureInput[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.png')) continue
      const rel = relative(root, absolute).replace(/\\/g, '/')
      const check = validateUiAssetPath(rel)
      if (!check.ok) continue
      out.push({ path: check.path, data: new Uint8Array(await readFile(absolute)), role: 'auto-collected' })
    }
  }
  await walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

// ── 主题 → 配色/风格 词表 ────────────────────────────────────────────────────

interface ThemeProfile {
  palette: { primary: string; secondary: string; accent: string }
  styleKeywords: string[]
}

const THEME_PROFILES: ReadonlyArray<{ match: RegExp; profile: ThemeProfile }> = [
  {
    match: /科技|tech|sci[- ]?fi|工业|industrial|机械/i,
    profile: {
      palette: { primary: '#1E3A8A', secondary: '#0F172A', accent: '#38BDF8' },
      styleKeywords: ['dark blue sci-fi', 'holographic panels', 'clean volumetric lighting', 'circuit motifs'],
    },
  },
  {
    match: /魔法|magic|奥秘|arcane/i,
    profile: {
      palette: { primary: '#4C1D95', secondary: '#1E1B4B', accent: '#C084FC' },
      styleKeywords: ['arcane purple', 'glowing runes', 'misty atmosphere', 'crystal shards'],
    },
  },
  {
    match: /自然|nature|田园|farm|生活/i,
    profile: {
      palette: { primary: '#166534', secondary: '#1C1917', accent: '#FACC15' },
      styleKeywords: ['lush greenery', 'warm sunlight', 'hand-painted', 'cozy cottagecore'],
    },
  },
  {
    match: /末日|apocalypse|废土|wasteland|僵尸/i,
    profile: {
      palette: { primary: '#7C2D12', secondary: '#1C1917', accent: '#F97316' },
      styleKeywords: ['post-apocalyptic', 'rusted metal', 'dusty haze', 'abandoned ruins'],
    },
  },
  {
    match: /天空|sky|浮岛|空岛|cloud/i,
    profile: {
      palette: { primary: '#0E7490', secondary: '#164E63', accent: '#FDE68A' },
      styleKeywords: ['floating islands', 'bright cyan sky', 'soft clouds', 'pastel lighting'],
    },
  },
  {
    match: /恐怖|horror|诡秘|阴暗|dark/i,
    profile: {
      palette: { primary: '#450A0A', secondary: '#0A0A0A', accent: '#DC2626' },
      styleKeywords: ['dark horror', 'foggy silhouette', 'desaturated palette', 'eerie glow'],
    },
  },
  {
    match: /东方|汉服|国风|oriental|ancient/i,
    profile: {
      palette: { primary: '#7F1D1D', secondary: '#1C1917', accent: '#FBBF24' },
      styleKeywords: ['oriental architecture', 'ink wash painting', 'gold accents', 'lantern light'],
    },
  },
]

function profileFor(theme: string): ThemeProfile {
  for (const entry of THEME_PROFILES) {
    if (entry.match.test(theme)) return entry.profile
  }
  return {
    palette: { primary: '#1E3A8A', secondary: '#0F172A', accent: '#38BDF8' },
    styleKeywords: ['clean stylized render', 'balanced contrast', 'subtle vignette'],
  }
}

function detects(theme: string, pattern: RegExp): boolean {
  return pattern.test(theme)
}

interface CategoryPlan {
  category: string
  purpose: string
  suggestedMods: string[]
}

function planCategories(input: {
  theme: string
  loader: ModLoader
  includeQuests: boolean
  includeCustomUi: boolean
  serverSide: boolean
}): CategoryPlan[] {
  const { theme, loader, includeQuests, includeCustomUi, serverSide } = input
  const forgeLike = loader === 'forge' || loader === 'neoforge'
  const categories: CategoryPlan[] = [
    {
      category: '核心依赖',
      purpose: '提供模组生态基础库，几乎所有模组都直接或间接依赖',
      suggestedMods: forgeLike
        ? ['architectury-api', 'cloth-config', 'kotlin-for-forge', 'geckolib']
        : ['fabric-api', 'architectury-api', 'cloth-config', 'geckolib'],
    },
    {
      category: '性能优化',
      purpose: '把帧率与内存占用拉回可玩水平，是整合包的地基',
      suggestedMods: forgeLike
        ? ['embeddium', 'ferritecore', 'modernfix', 'entityculling', 'starlight']
        : ['sodium', 'lithium', 'ferritecore', 'krypton', 'entityculling'],
    },
    {
      category: '体验增强',
      purpose: '信息展示、背包整理、地图等不影响玩法的易用性模组',
      suggestedMods: ['jei', 'jade', 'emi', 'journeymap', 'sophisticated-backpacks'],
    },
  ]
  if (detects(theme, /科技|tech|工业|industrial|机械|自动/i)) {
    categories.push({
      category: '科技与自动化',
      purpose: '科技树主线：资源加工 → 电力 → 自动化 → 高级物流',
      suggestedMods: ['create', 'mekanism', 'thermal-expansion', 'ae2', 'modern-industrialization'],
    })
  }
  if (detects(theme, /魔法|magic|奥秘|arcane/i)) {
    categories.push({
      category: '魔法体系',
      purpose: '与科技线并行的魔法主线，通常要求互不冲突的资源体系',
      suggestedMods: ['botania', 'ars-nouveau', 'occultism', 'blood-magic'],
    })
  }
  if (detects(theme, /探索|冒险|adventure|地牢|dungeon|世界/i)) {
    categories.push({
      category: '世界与探索',
      purpose: '地形生成、结构与地牢，决定探索内容密度',
      suggestedMods: ['terralith', 'tectonic', 'yungs-better-dungeons', 'when-dungeons-arise'],
    })
  }
  if (detects(theme, /农业|farm|烹饪|生活|food/i)) {
    categories.push({
      category: '农业与生活',
      purpose: '食物链、作物与生活质量内容',
      suggestedMods: ['farmers-delight', 'croptopia', 'cooking-for-blockheads'],
    })
  }
  if (includeQuests) {
    categories.push({
      category: '任务与进度',
      purpose: '用 FTB Quests 串起引导与奖励，降低新玩家上手门槛',
      suggestedMods: ['ftb-quests', 'ftb-teams', 'ftb-library'],
    })
  }
  if (includeCustomUi) {
    categories.push({
      category: '界面定制',
      purpose: '主菜单、按钮、HUD 视觉统一（配合 modpack_gen_ui_theme 系列工具）',
      suggestedMods: ['packmenu', 'polytone', 'vistas', 'fancymenu'],
    })
  }
  if (serverSide) {
    categories.push({
      category: '服务端必需',
      purpose: '服务端运行时依赖与性能优化（避免引入仅客户端模组）',
      suggestedMods: forgeLike ? ['servercore', 'ai-improvements'] : ['servercore', 'lithium', 'krypton'],
    })
  }
  return categories
}

function planMilestones(input: { modCountTarget: number; includeQuests: boolean; includeCustomUi: boolean }): string[] {
  return [
    'M1 骨架可启动：核心依赖 + 性能优化模组装齐，能进入世界且无崩溃',
    `M2 内容成体系：装到约 ${Math.round(input.modCountTarget * 0.6)} 个模组，主线玩法可玩通一条链`,
    'M3 平衡与调优：配置覆盖生效，任务奖励强度试跑一遍，帧率达标',
    input.includeQuests
      ? 'M4 任务书成稿：章节、依赖、奖励全部生成并用 modpack_gen_test_plan 过一遍'
      : 'M4 引导文档成稿：README + 游戏内书类引导',
    input.includeCustomUi ? 'M5 视觉统一：主界面、按钮、HUD 材质全部替换并实机截图确认' : 'M5 视觉基线：确认无 UI 错位与缺图',
    'M6 发布就绪：modpack_validate 零 error，导出三种格式，元数据齐备',
  ]
}

function planQuestOutline(theme: string, includeQuests: boolean): Array<{ chapter: string; purpose: string }> {
  if (!includeQuests) return []
  const outline = [
    { chapter: '第 0 章 · 开始之前', purpose: '操作提示、模组键位、基础资源获取，3-5 个引导任务' },
    { chapter: '第 1 章 · 立足', purpose: '木质到石质工具、第一台初级机器/第一份魔力，10-15 个任务' },
  ]
  if (detects(theme, /科技|tech|工业|机械/i)) {
    outline.push(
      { chapter: '第 2 章 · 电力时代', purpose: '发电 → 输电 → 基础自动化，引入能量单位与电缆' },
      { chapter: '第 3 章 · 自动化', purpose: '物流与批量生产，AE2/存储系统接入' },
    )
  }
  if (detects(theme, /魔法|magic|奥秘/i)) {
    outline.push({ chapter: '第 2 章 · 魔法之路', purpose: '魔力获取、祭坛、符文与自动施法' })
  }
  if (detects(theme, /探索|冒险|地牢/i)) {
    outline.push({ chapter: '支线 · 远行', purpose: '维度探索、地牢与 Boss 挑战，奖励稀有材料' })
  }
  outline.push({ chapter: '终章 · 毕业', purpose: '创造级目标、整合包通关判定与彩蛋' })
  return outline
}

// ── 阶段一：规划与初始化 ─────────────────────────────────────────────────────

function registerPlanningTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_plan',
    description:
      '生成 Minecraft 整合包的完整规划方案：包名、模组分类与候选模组、里程碑、任务书章节大纲、' +
      '界面主题配色与生图 prompt、风险清单，以及后续要调用的工具序列。' +
      '这是整合包制作流程的第一步，规划结果会落盘到 <packDir>/ui/../plan.json（packDir 省略时不落盘）。',
    parameters: {
      theme: { type: 'string', required: true, description: '整合包主题，例如「深蓝色科技风」「东方魔法冒险」。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本，例如 1.20.1。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '模组加载器。' },
      playstyle: { type: 'string', description: '玩法侧重，例如「自动化 + 建筑」。' },
      targetAudience: { type: 'string', description: '目标玩家，例如「新手友好」「硬核老玩家」。' },
      modCountTarget: { type: 'integer', description: '目标模组数量，默认 150。' },
      difficulty: { type: 'string', enum: ['casual', 'normal', 'hard', 'expert'], description: '难度定位。' },
      includeQuests: { type: 'boolean', description: '是否包含 FTB Quests 任务书，默认 true。' },
      includeCustomUi: { type: 'boolean', description: '是否做界面定制（含 AI 生图），默认 true。' },
      serverSide: { type: 'boolean', description: '是否需要服务端可用的整合包，默认 false。' },
      packDir: { type: 'string', description: '可选：整合包目录；给了就把规划写到 <packDir>/plan.json。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          packName: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          javaMajor: { type: 'integer', required: true },
          javaNote: { type: 'string', required: true },
          memoryGb: { type: 'integer', required: true },
          stages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                order: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                goal: { type: 'string', required: true },
                tools: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          modCategories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                category: { type: 'string', required: true },
                purpose: { type: 'string', required: true },
                suggestedMods: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          milestones: { type: 'array', required: true, items: { type: 'string' } },
          questOutline: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chapter: { type: 'string', required: true },
                purpose: { type: 'string', required: true },
              },
            },
          },
          uiTheme: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              primary: { type: 'string', required: true },
              secondary: { type: 'string', required: true },
              accent: { type: 'string', required: true },
              styleKeywords: { type: 'array', required: true, items: { type: 'string' } },
              menuBackgroundPrompt: { type: 'string', required: true },
            },
          },
          risks: { type: 'array', required: true, items: { type: 'string' } },
          nextTools: { type: 'array', required: true, items: { type: 'string' } },
          planFile: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `modpack_plan「${args.theme}」→ ${value.packName}（Java ${value.javaMajor}，建议 ${value.memoryGb}GB 内存）\n`
          + `模组分类 ${value.modCategories.length} 个 / 里程碑 ${value.milestones.length} 条 / 任务章节 ${value.questOutline.length} 章\n`
          + `下一步：${value.nextTools.slice(0, 3).join(' → ')}\n${value.summary}`,
      }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const theme = requireString(args.theme, 'theme')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const modCountTarget = clampInt(args.modCountTarget, 10, 1000, 150)
      const includeQuests = args.includeQuests !== false
      const includeCustomUi = args.includeCustomUi !== false
      const serverSide = args.serverSide === true
      const difficulty = args.difficulty ?? 'normal'
      const java = javaVersionFor(minecraftVersion)
      const profile = profileFor(theme)
      const colors = deriveThemeColors(profile.palette.primary, profile.palette.secondary, profile.palette.accent)
      const packName = `${slugify(theme, 'modpack')}-${minecraftVersion.replace(/[^\w]/g, '')}`

      const promptContext: PromptContext = {
        theme,
        style: profile.styleKeywords.join(', '),
        colors: [colors.primary, colors.secondary, colors.accent],
      }

      const stages = [
        { order: 1, name: '规划与初始化', goal: '定主题、建目录、配好启动环境', tools: ['modpack_plan', 'modpack_create', 'modpack_setup_env'] },
        { order: 2, name: '模组管理', goal: '按分类装模组、解析依赖、清冲突、上优化', tools: ['modpack_search_mods', 'modpack_add_mod', 'modpack_resolve_deps', 'modpack_check_conflicts', 'modpack_add_optimization'] },
        { order: 3, name: '配置与内容定制', goal: '配置覆盖、任务书、资源与光影、README', tools: ['modpack_gen_config', 'modpack_gen_quests', 'modpack_add_resources', 'modpack_gen_readme'] },
        { order: 4, name: '界面设计（含 AI 生图）', goal: '主题方案 → 生成背景与材质 → 组装资源包', tools: ['modpack_gen_ui_theme', 'modpack_gen_menu_bg', 'modpack_gen_ui_textures', 'modpack_assemble_ui_pack'] },
        { order: 5, name: '本地化', goal: '扫描待翻译文本并打包语言资源包', tools: ['modpack_scan_i18n', 'modpack_translate'] },
        { order: 6, name: '测试与验证', goal: '结构校验 + 测试清单', tools: ['modpack_validate', 'modpack_gen_test_plan'] },
        { order: 7, name: '打包与发布', goal: '导出 mrpak / CF zip / 手动包，产出发布元数据', tools: ['modpack_export', 'modpack_publish'] },
      ]

      const modCategories = planCategories({ theme, loader, includeQuests, includeCustomUi, serverSide })
      const milestones = planMilestones({ modCountTarget, includeQuests, includeCustomUi })
      const questOutline = planQuestOutline(theme, includeQuests)
      const risks = [
        '依赖链深处的模组可能没有适配目标游戏版本的版本，需在 modpack_resolve_deps 后核对 issues',
        'Sodium/Embeddium 与 OptiFine 系模组渲染管线互斥，混装会直接启动失败',
        'AI 生图默认走 Pollinations 匿名额度（约 1 请求/15 秒），6 面全景图需要预留约 2-3 分钟',
        'PackMenu 只在 Forge/NeoForge 侧存在；Fabric 侧请改用 Vistas / 纯资源包方案',
        '任务书 id 一旦发布就不能再乱改，否则玩家进度会重置',
      ]
      const nextTools = [
        'modpack_create',
        'modpack_setup_env',
        'modpack_search_mods',
        `modpack_add_optimization(profile=balanced)`,
        'modpack_gen_ui_theme',
      ]
      const summary =
        `${packName}：Minecraft ${minecraftVersion} / ${loader}，主题「${theme}」，`
        + `目标 ${modCountTarget} 个模组，难度 ${difficulty}，`
        + `${includeQuests ? '含 FTB Quests 任务书' : '不含任务书'}，`
        + `${includeCustomUi ? '含 AI 生成的自定义界面' : '不做界面定制'}。`

      let planFile = ''
      const packDir = str(args.packDir)
      if (packDir !== '') {
        const target = resolveInside(packDir, 'plan.json')
        await writeFileEnsured(target, `${JSON.stringify({
          packName,
          theme,
          minecraftVersion,
          loader,
          difficulty,
          modCountTarget,
          javaMajor: java.major,
          memoryGb: suggestMemoryGb(modCountTarget),
          colors,
          styleKeywords: profile.styleKeywords,
          stages,
          modCategories,
          milestones,
          questOutline,
          risks,
          generatedAt: nowIso(),
        }, null, 2)}\n`)
        planFile = target
      }

      return {
        ok: true,
        packName,
        summary,
        javaMajor: java.major,
        javaNote: java.note,
        memoryGb: suggestMemoryGb(modCountTarget),
        stages,
        modCategories,
        milestones,
        questOutline,
        uiTheme: {
          primary: colors.primary,
          secondary: colors.secondary,
          accent: colors.accent,
          styleKeywords: profile.styleKeywords,
          menuBackgroundPrompt: buildBackgroundPrompt(promptContext, { wide: true }),
        },
        risks,
        nextTools,
        planFile,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_create',
    description:
      '创建整合包实例目录结构（mods / config / resourcepacks / shaderpacks / ftbquests / packmenu / publish 等），' +
      '并写入实例元数据 modpack.instance.json 与 README 骨架。已存在的目录会跳过而不是报错。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录（绝对路径或相对当前工作目录）。' },
      name: { type: 'string', required: true, description: '整合包名称。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '模组加载器。' },
      loaderVersion: { type: 'string', description: '加载器版本，例如 0.15.11。' },
      description: { type: 'string', description: '整合包简介，写进 README。' },
      extraDirectories: { type: 'array', items: { type: 'string' }, description: '额外要创建的目录（相对 packDir）。' },
      quests: { type: 'boolean', description: '是否创建 FTB Quests 目录，默认 true。' },
      customUi: { type: 'boolean', description: '是否创建界面定制目录（packmenu / polytone / ui），默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          packDir: { type: 'string', required: true },
          created: { type: 'array', required: true, items: { type: 'string' } },
          existing: { type: 'array', required: true, items: { type: 'string' } },
          files: { type: 'array', required: true, items: { type: 'string' } },
          javaMajor: { type: 'integer', required: true },
          nextTools: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_create → ${value.packDir}\n新建 ${value.created.length} 个目录，已存在 ${value.existing.length} 个，写入 ${value.files.length} 个文件（Java ${value.javaMajor}）`,
      }],
    },
    timeoutMs: 30_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const name = requireString(args.name, 'name')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const java = javaVersionFor(minecraftVersion)

      const wanted = [
        'mods',
        'config',
        'defaultconfigs',
        'resourcepacks',
        'shaderpacks',
        'scripts',
        'kubejs',
        'publish',
      ]
      if (args.quests !== false) wanted.push('config/ftbquests/quests/chapters')
      if (args.customUi !== false) {
        wanted.push('packmenu/resources', 'polytone', 'ui')
      }
      for (const extra of asStringArray(args.extraDirectories)) {
        const cleaned = extra.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\./g, '')
        if (cleaned !== '') wanted.push(cleaned)
      }

      const created: string[] = []
      const existing: string[] = []
      for (const dir of wanted) {
        const target = resolveInside(packDir, ...dir.split('/'))
        if (await pathExists(target)) existing.push(dir)
        else {
          await ensureDir(target)
          created.push(dir)
        }
      }

      const instanceFile = resolveInside(packDir, 'modpack.instance.json')
      const instance = {
        name,
        slug: slugify(name, 'modpack'),
        minecraftVersion,
        loader,
        loaderVersion: str(args.loaderVersion) || null,
        description: str(args.description),
        javaMajor: java.major,
        generatedBy: 'dsh-tool-modpack',
        createdAt: nowIso(),
      }
      await writeFileEnsured(instanceFile, `${JSON.stringify(instance, null, 2)}\n`)

      const readme = resolveInside(packDir, 'README.md')
      const files = ['modpack.instance.json']
      if (!(await pathExists(readme))) {
        await writeFileEnsured(
          readme,
          `# ${name}\n\n`
            + `${str(args.description) || '（在这里写整合包简介）'}\n\n`
            + `## 环境要求\n\n- Minecraft ${minecraftVersion}\n- 加载器：${loader}${str(args.loaderVersion) !== '' ? ` ${str(args.loaderVersion)}` : ''}\n- Java：${java.major}（${java.note}）\n\n`
            + `## 目录说明\n\n`
            + `- \`mods/\` 模组 jar\n- \`config/\` 模组配置覆盖\n- \`resourcepacks/\` 资源包（含 AI 生成的界面材质包）\n`
            + `- \`shaderpacks/\` 光影包\n- \`packmenu/\` PackMenu 内置资源包（Forge 侧主菜单）\n`
            + `- \`ui/\` 界面设计中间产物\n- \`publish/\` 发布元数据\n`,
        )
        files.push('README.md')
      }

      return {
        ok: true,
        packDir,
        created,
        existing,
        files,
        javaMajor: java.major,
        nextTools: ['modpack_setup_env', 'modpack_search_mods', 'modpack_add_optimization'],
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_setup_env',
    description:
      '生成启动器实例配置与 JVM 参数：按 MC 版本推导 Java 主版本、按模组规模建议内存、' +
      '输出 Aikar 风格 G1GC 参数，并写入 MultiMC/Prism 的 instance.cfg、通用 launcher 配置、' +
      'Windows/Linux 启动脚本与 jvm-args.txt。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '模组加载器。' },
      loaderVersion: { type: 'string', description: '加载器版本。' },
      memoryGb: { type: 'integer', description: '分配内存（GB），缺省按 mods/ 里 jar 数量推荐。' },
      launcher: { type: 'string', enum: ['prism', 'multimc', 'generic'], description: '目标启动器，默认 prism（同时输出通用配置）。' },
      javaPath: { type: 'string', description: 'Java 可执行文件路径，写进启动脚本。' },
      resolution: { type: 'string', description: '窗口分辨率，例如 1920x1080。' },
      extraJvmArgs: { type: 'array', items: { type: 'string' }, description: '追加的 JVM 参数。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          javaMajor: { type: 'integer', required: true },
          javaNote: { type: 'string', required: true },
          memoryGb: { type: 'integer', required: true },
          jvmArgs: { type: 'array', required: true, items: { type: 'string' } },
          modCount: { type: 'integer', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_setup_env → Java ${value.javaMajor}，内存 ${value.memoryGb}GB，JVM 参数 ${value.jvmArgs.length} 条\n写入：${value.files.join('、')}`,
      }],
    },
    timeoutMs: 30_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const java = javaVersionFor(minecraftVersion)
      const installed = (await readInstalledModSlugs(packDir)).length
      const memoryGb = clampInt(args.memoryGb, 2, 64, suggestMemoryGb(installed))
      const jvmArgs = jvmArgsFor(memoryGb, asStringArray(args.extraJvmArgs))
      const launcher = str(args.launcher, 'prism')
      const javaPath = str(args.javaPath, java.major >= 21 ? 'java' : `java${java.major}`)
      const resolution = str(args.resolution, '1920x1080')
      const files: string[] = []
      const notes: string[] = []

      const jvmText = `${jvmArgs.join(' ')}\n`
      await writeFileEnsured(resolveInside(packDir, 'jvm-args.txt'), jvmText)
      files.push('jvm-args.txt')

      const instanceJson = asRecord(await readJsonSafe(resolveInside(packDir, 'modpack.instance.json'), {}))
      const launcherConfig = {
        launcher,
        minecraftVersion,
        loader,
        loaderVersion: str(args.loaderVersion) || null,
        javaMajor: java.major,
        javaPath,
        memoryGb,
        jvmArgs,
        resolution,
        instanceName: str(instanceJson.name, slugify(packDir.split(/[\\/]/).pop() ?? 'modpack')),
        createdAt: nowIso(),
      }
      await writeFileEnsured(resolveInside(packDir, 'launcher-profile.json'), `${JSON.stringify(launcherConfig, null, 2)}\n`)
      files.push('launcher-profile.json')

      const instanceCfg = [
        'InstanceType=OneSix',
        `name=${launcherConfig.instanceName}`,
        `JavaPath=${javaPath}`,
        `MaxMemAlloc=${memoryGb * 1024}`,
        `MinMemAlloc=${memoryGb * 1024}`,
        `JvmArgs=${jvmArgs.join(' ')}`,
        `MinecraftVersion=${minecraftVersion}`,
        `OverrideWindow=true`,
        `LaunchMaximized=false`,
        `MinecraftWinWidth=${resolution.split('x')[0] ?? '1920'}`,
        `MinecraftWinHeight=${resolution.split('x')[1] ?? '1080'}`,
        '',
      ].join('\n')
      await writeFileEnsured(resolveInside(packDir, 'instance.cfg'), instanceCfg)
      files.push('instance.cfg')

      const startBat = [
        '@echo off',
        'setlocal',
        `set JAVA="${javaPath}"`,
        `set MEM=${memoryGb}G`,
        `set JVM_ARGS=${jvmArgs.join(' ')}`,
        `echo 请把 %%JAVA%% %%JVM_ARGS%% -jar <整合包启动器.jar> 里的启动器路径替换为你的启动器实例配置`,
        `rem 若使用 HMCL / PCL，请把上面的 JVM 参数粘贴到"Java 参数"里`,
        'endlocal',
        '',
      ].join('\r\n')
      await writeFileEnsured(resolveInside(packDir, 'start.bat'), startBat)
      files.push('start.bat')

      const startSh = [
        '#!/usr/bin/env sh',
        `JAVA="${javaPath}"`,
        `JVM_ARGS="${jvmArgs.join(' ')}"`,
        '# 把 $JVM_ARGS 粘贴到启动器的 Java 参数设置中',
        '',
      ].join('\n')
      await writeFileEnsured(resolveInside(packDir, 'start.sh'), startSh)
      files.push('start.sh')

      if (installed === 0) {
        notes.push('mods/ 里还没有模组，内存是按默认规模估的；装完模组后建议重新调用本工具。')
      }
      notes.push(`Java 主版本判定依据：${java.note}`)
      notes.push('Aikar 风格 G1GC 参数对 4GB 以上堆最有效；若分配 <4GB 请改用 -XX:+UseSerialGC。')

      return {
        ok: true,
        files,
        javaMajor: java.major,
        javaNote: java.note,
        memoryGb,
        jvmArgs,
        modCount: installed,
        notes,
      }
    },
  }))
}

// ── 共享：带缓存的版本源 + "解析 + 下载" 核心流程 ────────────────────────────

interface CachedVersionSource extends VersionSource {
  versions: Map<string, ModrinthVersion>
}

/** 给 ModrinthClient 套一层缓存，避免依赖解析时对同一版本重复请求。 */
function cachingSource(client: ModrinthClient): CachedVersionSource {
  const versions = new Map<string, ModrinthVersion>()
  const projects = new Map<string, ModrinthProject>()
  return {
    versions,
    async getVersion(versionId: string) {
      const hit = versions.get(versionId)
      if (hit !== undefined) return hit
      const version = await client.getVersion(versionId)
      versions.set(version.id, version)
      return version
    },
    async getProjectVersions(idOrSlug: string, filter: VersionFilter) {
      const list = await client.getProjectVersions(idOrSlug, filter)
      for (const version of list) versions.set(version.id, version)
      return list
    },
    async getProject(idOrSlug: string) {
      const hit = projects.get(idOrSlug)
      if (hit !== undefined) return hit
      const project = await client.getProject(idOrSlug)
      projects.set(idOrSlug, project)
      projects.set(project.id, project)
      projects.set(project.slug, project)
      return project
    },
  }
}

interface AddedModEntry {
  slug: string
  title: string
  versionId: string
  fileName: string
  path: string
  size: number
  sha1: string
  role: string
}

interface AddModsOutcome {
  added: AddedModEntry[]
  skipped: string[]
  issues: ResolutionIssue[]
  conflicts: ReturnType<typeof checkConflicts>
  installOrder: string[]
  resolvedCount: number
  downloadedCount: number
  nodes: ResolvedNode[]
}

/**
 * 解析依赖 → 下载主文件 → 冲突检查。
 * 所有工具（modpack_add_mod / modpack_resolve_deps / modpack_add_optimization）
 * 都走这一条路径，保证行为一致。
 */
async function addModsCore(
  client: ModrinthClient,
  options: {
    packDir: string
    minecraftVersion: string
    loader: ModLoader
    roots: ResolveRoot[]
    includeOptional: boolean
    download: boolean
    side: 'both' | 'client' | 'server'
    maxDepth?: number
  },
): Promise<AddModsOutcome> {
  const source = cachingSource(client)
  const resolution = await resolveDependencies(options.roots, source, {
    gameVersion: options.minecraftVersion,
    loader: options.loader,
    includeOptional: options.includeOptional,
    side: options.side,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  })

  const added: AddedModEntry[] = []
  const skipped: string[] = []
  let downloadedCount = 0

  for (const node of resolution.nodes) {
    if (node.role === 'embedded') {
      skipped.push(`${node.slug}（已内嵌在其它模组里，不单独下载）`)
      continue
    }
    if (node.downloadUrl === '' || node.fileName === '') {
      skipped.push(`${node.slug}（版本 ${node.versionId} 没有可下载文件）`)
      continue
    }
    const target = resolveInside(options.packDir, 'mods', node.fileName)
    if (await pathExists(target)) {
      const size = (await stat(target)).size
      added.push({
        slug: node.slug,
        title: node.title,
        versionId: node.versionId,
        fileName: node.fileName,
        path: `mods/${node.fileName}`,
        size,
        sha1: node.sha1,
        role: node.role,
      })
      skipped.push(`${node.slug}（mods/ 里已存在同名文件，未重新下载）`)
      continue
    }
    if (!options.download) {
      skipped.push(`${node.slug}（download=false，仅解析未下载）`)
      continue
    }
    const version = source.versions.get(node.versionId) ?? (await client.getVersion(node.versionId))
    const entry = await installVersion(client, options.packDir, version, node.role === 'root' ? 'root' : node.role === 'optional' ? 'optional' : 'required', true)
    added.push(entry)
    downloadedCount += 1
  }

  const conflicts = checkConflicts(resolution.nodes, resolution.issues)
  return {
    added,
    skipped,
    issues: resolution.issues,
    conflicts,
    installOrder: resolution.installOrder,
    resolvedCount: resolution.nodes.length,
    downloadedCount,
    nodes: resolution.nodes,
  }
}

// ── 阶段二：模组管理 ─────────────────────────────────────────────────────────

function registerModTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_search_mods',
    description:
      '在 Modrinth 上按关键词 + 游戏版本 + 加载器 + 分类搜索模组（也支持 resourcepack / shader / datapack）。' +
      '返回 slug、标题、下载量、支持版本数、许可证与页面地址，供后续 modpack_add_mod 使用。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词，例如 "create automation"。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本，例如 1.20.1。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      projectType: { type: 'string', enum: ['mod', 'resourcepack', 'shader', 'datapack', 'modpack'], description: '项目类型，默认 mod。' },
      categories: { type: 'array', items: { type: 'string' }, description: '分类过滤，例如 ["technology","optimization"]。' },
      index: { type: 'string', enum: ['relevance', 'downloads', 'follows', 'newest', 'updated'], description: '排序方式，默认 relevance。' },
      limit: { type: 'integer', description: '返回条数（1-100），默认 10。' },
      offset: { type: 'integer', description: '分页偏移，默认 0。' },
      clientSideOnly: { type: 'boolean', description: '只返回客户端可用项目。' },
      serverSideOnly: { type: 'boolean', description: '只返回服务端可用项目。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          offset: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                projectId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                description: { type: 'string', required: true },
                author: { type: 'string', required: true },
                downloads: { type: 'integer', required: true },
                follows: { type: 'integer', required: true },
                categories: { type: 'array', required: true, items: { type: 'string' } },
                gameVersions: { type: 'array', required: true, items: { type: 'string' } },
                license: { type: 'string', required: true },
                clientSide: { type: 'string', required: true },
                serverSide: { type: 'string', required: true },
                iconUrl: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `modpack_search_mods「${args.query}」→ 命中 ${value.total} 条，返回 ${value.hits.length} 条\n`
          + value.hits.slice(0, 10).map((hit) => `- ${hit.title}（${hit.slug}）↓${hit.downloads}`).join('\n'),
      }],
    },
    timeoutMs: 45_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const client = modrinth(exec.signal)
      const result = await client.searchMods({
        query: requireString(args.query, 'query'),
        gameVersions: [requireString(args.minecraftVersion, 'minecraftVersion')],
        loaders: [loaderOf(args.loader)],
        projectType: (str(args.projectType, 'mod') as ProjectType),
        categories: asStringArray(args.categories),
        index: (str(args.index, 'relevance') as SearchIndex),
        limit: clampInt(args.limit, 1, 100, 10),
        offset: clampInt(args.offset, 0, 100_000, 0),
        ...(args.clientSideOnly === true ? { clientSideOnly: true } : {}),
        ...(args.serverSideOnly === true ? { serverSideOnly: true } : {}),
      })
      const hits = result.hits.map((hit: ModrinthSearchHit) => ({
        slug: hit.slug,
        projectId: hit.projectId,
        title: hit.title,
        description: hit.description,
        author: hit.author,
        downloads: hit.downloads,
        follows: hit.follows,
        categories: hit.categories,
        gameVersions: hit.versions,
        license: hit.license,
        clientSide: hit.clientSide,
        serverSide: hit.serverSide,
        iconUrl: hit.iconUrl ?? '',
        url: hit.url,
      }))
      return {
        ok: true,
        total: result.totalHits,
        offset: result.offset,
        limit: result.limit,
        hits,
        note: hits.length === 0
          ? `没有匹配结果。可放宽条件：确认 ${args.minecraftVersion} / ${args.loader} 组合存在，或换用 modpack_search_mods 的 index=downloads。`
          : `共 ${result.totalHits} 条，本次返回 ${hits.length} 条。把想装的 slug 交给 modpack_add_mod。`,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_add_mod',
    description:
      '把一批模组装进整合包：按游戏版本与加载器挑选版本、递归解析依赖链、下载 jar 到 mods/、' +
      '并对结果做冲突检查。依赖解析最大深度 50。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      targets: {
        type: 'array',
        required: true,
        description: '要添加的项目列表，每项 {id: slug 或 projectId, versionId?: 锁定版本}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            versionId: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
      resolveDeps: { type: 'boolean', description: '是否递归解析依赖，默认 true。' },
      includeOptional: { type: 'boolean', description: '是否纳入可选依赖，默认 false。' },
      download: { type: 'boolean', description: '是否真的下载文件，默认 true。' },
      side: { type: 'string', enum: ['both', 'client', 'server'], description: '目标侧，默认 both。' },
      maxDepth: { type: 'integer', description: '依赖解析最大深度（上限 50），默认 50。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          resolvedCount: { type: 'integer', required: true },
          downloadedCount: { type: 'integer', required: true },
          added: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                versionId: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                sha1: { type: 'string', required: true },
                role: { type: 'string', required: true },
              },
            },
          },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          conflicts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              verdict: { type: 'string', required: true },
              conflicts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    projectId: { type: 'string', required: true },
                    versions: { type: 'array', required: true, items: { type: 'string' } },
                    message: { type: 'string', required: true },
                  },
                },
              },
              knownPairs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    a: { type: 'string', required: true },
                    b: { type: 'string', required: true },
                    message: { type: 'string', required: true },
                    severity: { type: 'string', required: true },
                  },
                },
              },
              declared: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subject: { type: 'string', required: true },
                    message: { type: 'string', required: true },
                  },
                },
              },
              missing: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subject: { type: 'string', required: true },
                    message: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          installOrder: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `modpack_add_mod → 解析 ${value.resolvedCount} 个，下载 ${value.downloadedCount} 个，mods/ 现有 ${value.added.length} 个条目\n`
          + `冲突判定：${value.conflicts.verdict}\n`
          + (value.issues.length > 0 ? `问题 ${value.issues.length} 条：\n` + value.issues.slice(0, 8).map((issue) => `- [${issue.kind}] ${issue.message}`).join('\n') : '无解析问题')
          + `\n（请求：${asArray(args.targets).length} 个项目）`,
      }],
    },
    timeoutMs: 15 * 60_000,
    async execute(args, exec) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const targets = arr(args.targets).map((item) => rec(item))
      if (targets.length === 0) {
        throw new ModpackError('INVALID_ARGUMENT', 'targets 不能为空')
      }
      const roots: ResolveRoot[] = targets.map((target) => ({
        id: str(target.id),
        ...(str(target.versionId) !== '' ? { versionId: str(target.versionId) } : {}),
        label: str(target.label, str(target.id)),
      }))
      for (const root of roots) {
        if ((root.id ?? '') === '' && (root.versionId ?? '') === '') {
          throw new ModpackError('INVALID_ARGUMENT', 'targets 里每一项都必须有 id 或 versionId')
        }
      }
      const resolveDeps = args.resolveDeps !== false
      const outcome = await addModsCore(modrinth(exec.signal), {
        packDir,
        minecraftVersion,
        loader,
        roots,
        includeOptional: args.includeOptional === true,
        download: args.download !== false,
        side: (str(args.side, 'both') as 'both' | 'client' | 'server'),
        maxDepth: resolveDeps ? clampInt(args.maxDepth, 1, 50, 50) : 0,
      })
      return {
        ok: outcome.conflicts.verdict !== 'conflict',
        resolvedCount: outcome.resolvedCount,
        downloadedCount: outcome.downloadedCount,
        added: outcome.added,
        skipped: outcome.skipped,
        issues: outcome.issues.map((issue) => ({ kind: issue.kind, subject: issue.subject, message: issue.message })),
        conflicts: {
          verdict: outcome.conflicts.verdict,
          conflicts: outcome.conflicts.conflicts,
          knownPairs: outcome.conflicts.knownPairs,
          declared: outcome.conflicts.declared,
          missing: outcome.conflicts.missing,
        },
        installOrder: outcome.installOrder,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_resolve_deps',
    description:
      '只做依赖解析、不下载：从一批根项目出发递归展开 Modrinth 依赖链，' +
      '返回拓扑顺序、每个节点的角色（root/required/optional/embedded）、深度与请求者，' +
      '并报告缺版本、版本冲突、循环依赖、深度超限等问题。最大深度 50。',
    parameters: {
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      roots: {
        type: 'array',
        required: true,
        description: '根项目列表，每项 {id: slug 或 projectId, versionId?: 锁定版本}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            versionId: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
      maxDepth: { type: 'integer', description: '最大解析深度（上限 50），默认 50。' },
      includeOptional: { type: 'boolean', description: '是否纳入可选依赖，默认 false。' },
      side: { type: 'string', enum: ['both', 'client', 'server'], description: '目标侧。' },
      packDir: { type: 'string', description: '可选：给了就把解析报告写到 <packDir>/dependency-report.json。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                projectId: { type: 'string', required: true },
                versionId: { type: 'string', required: true },
                versionNumber: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                role: { type: 'string', required: true },
                depth: { type: 'integer', required: true },
                requestedBy: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          installOrder: { type: 'array', required: true, items: { type: 'string' } },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              fetchedVersions: { type: 'integer', required: true },
              fetchedProjects: { type: 'integer', required: true },
              maxDepthReached: { type: 'integer', required: true },
              cycles: { type: 'integer', required: true },
              skippedOptional: { type: 'integer', required: true },
              nodes: { type: 'integer', required: true },
            },
          },
          reportFile: { type: 'string', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_resolve_deps → ${value.stats.nodes} 个节点，最大深度 ${value.stats.maxDepthReached}，`
          + `循环 ${value.stats.cycles} 个，跳过可选 ${value.stats.skippedOptional} 个\n`
          + value.issues.slice(0, 10).map((issue) => `- [${issue.kind}] ${issue.message}`).join('\n'),
      }],
    },
    timeoutMs: 10 * 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const roots: ResolveRoot[] = arr(args.roots).map((item) => {
        const record = rec(item)
        return {
          id: str(record.id),
          ...(str(record.versionId) !== '' ? { versionId: str(record.versionId) } : {}),
          label: str(record.label, str(record.id)),
        }
      })
      if (roots.length === 0) throw new ModpackError('INVALID_ARGUMENT', 'roots 不能为空')
      const client = modrinth(exec.signal)
      const resolution = await resolveDependencies(roots, cachingSource(client), {
        gameVersion: minecraftVersion,
        loader,
        maxDepth: clampInt(args.maxDepth, 1, 50, 50),
        includeOptional: args.includeOptional === true,
        side: (str(args.side, 'both') as 'both' | 'client' | 'server'),
      })
      const notes: string[] = []
      if (resolution.stats.cycles > 0) notes.push('检测到循环依赖：Modrinth 上确实存在互相声明的模组，按"只装一次"处理，但请人工确认。')
      if (resolution.issues.some((issue) => issue.kind === 'no-version')) {
        notes.push('有模组没有适配版本：换游戏版本、换同类替代品，或锁定一个旧版本（targets.versionId）。')
      }
      let reportFile = ''
      const packDir = str(args.packDir)
      if (packDir !== '') {
        const target = resolveInside(packDir, 'dependency-report.json')
        await writeFileEnsured(target, `${JSON.stringify({
          minecraftVersion,
          loader,
          installOrder: resolution.installOrder,
          nodes: resolution.nodes,
          issues: resolution.issues,
          stats: resolution.stats,
          generatedAt: nowIso(),
        }, null, 2)}\n`)
        reportFile = target
      }
      return {
        ok: !resolution.issues.some((issue) => issue.kind === 'no-version' || issue.kind === 'missing'),
        nodes: resolution.nodes.map((node) => ({
          slug: node.slug,
          title: node.title,
          projectId: node.projectId,
          versionId: node.versionId,
          versionNumber: node.versionNumber,
          fileName: node.fileName,
          role: node.role,
          depth: node.depth,
          requestedBy: node.requestedBy,
        })),
        installOrder: resolution.installOrder,
        issues: resolution.issues.map((issue) => ({ kind: issue.kind, subject: issue.subject, message: issue.message })),
        stats: { ...resolution.stats, nodes: resolution.nodes.length },
        reportFile,
        notes,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_check_conflicts',
    description:
      '检查模组之间的已知冲突：同一项目多版本、Modrinth 声明的不兼容、以及内置的社区冲突规则表' +
      '（如 Sodium vs OptiFine、JEI/REI/EMI 三选一、Fabric API vs Forge）。可以只给 mods 列表，' +
      '也可以直接扫描 packDir/mods/ 下的 jar 文件名。',
    parameters: {
      packDir: { type: 'string', description: '整合包根目录；给了就扫描 mods/ 下的 jar。' },
      minecraftVersion: { type: 'string', description: '目标游戏版本（可选，仅用于报告）。' },
      loader: { type: 'string', enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器（用于加载器互斥判断）。' },
      mods: {
        type: 'array',
        description: '可选的模组列表，每项 {slug, projectId?, versionId?, title?}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slug: { type: 'string', required: true },
            projectId: { type: 'string' },
            versionId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          verdict: { type: 'string', required: true },
          installedMods: { type: 'integer', required: true },
          conflicts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                projectId: { type: 'string', required: true },
                versions: { type: 'array', required: true, items: { type: 'string' } },
                message: { type: 'string', required: true },
              },
            },
          },
          knownPairs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                message: { type: 'string', required: true },
                severity: { type: 'string', required: true },
              },
            },
          },
          declared: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subject: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          missing: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subject: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          recommendations: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_check_conflicts → ${value.verdict}（检查 ${value.installedMods} 个模组）\n`
          + (value.knownPairs.length > 0 ? value.knownPairs.map((pair) => `- [${pair.severity}] ${pair.a} × ${pair.b}：${pair.message}`).join('\n') : '未命中已知冲突规则')
          + (value.conflicts.length > 0 ? `\n多版本：${value.conflicts.map((item) => item.projectId).join('、')}` : ''),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const provided = arr(args.mods).map((item) => rec(item))
      const fromDisk: Array<{ slug: string; projectId: string; versionId: string; title: string }> = []
      const packDir = str(args.packDir)
      if (packDir !== '') {
        if (!(await pathExists(packDir))) throw new ModpackError('NOT_FOUND', `整合包目录不存在：${packDir}`)
        for (const entry of await readInstalledModSlugs(packDir)) {
          fromDisk.push({ slug: entry.slug, projectId: entry.slug, versionId: entry.fileName, title: entry.fileName })
        }
      }
      const source = provided.length > 0
        ? provided.map((item) => ({
            slug: str(item.slug),
            projectId: str(item.projectId, str(item.slug)),
            versionId: str(item.versionId, 'unknown'),
            title: str(item.title, str(item.slug)),
          }))
        : fromDisk
      if (source.length === 0) {
        throw new ModpackError('INVALID_ARGUMENT', '既没有提供 mods 列表，packDir/mods 下也没有 jar')
      }

      const nodes: ResolvedNode[] = source.map((item) => ({
        projectId: item.projectId,
        slug: item.slug,
        title: item.title,
        versionId: item.versionId,
        versionNumber: item.versionId,
        versionType: 'release',
        fileName: item.versionId,
        downloadUrl: '',
        sha1: '',
        size: 0,
        role: 'root',
        depth: 0,
        requestedBy: ['modpack_check_conflicts'],
        loaders: [],
        gameVersions: [],
        notes: [],
      }))

      const report = checkConflicts(nodes, [])
      const recommendations: string[] = []
      if (report.verdict === 'ok') {
        recommendations.push('未发现已知冲突。发布前仍建议用 modpack_validate 跑一次完整校验。')
      }
      for (const pair of report.knownPairs) {
        if (pair.severity === 'error') {
          recommendations.push(`必须二选一：${pair.a} 还是 ${pair.b}（${pair.message}）`)
        } else {
          recommendations.push(`建议确认：${pair.a} 与 ${pair.b} 功能重叠，若同时启用请验证无异常刷屏`)
        }
      }
      if (report.conflicts.length > 0) {
        recommendations.push('同一项目出现多个版本，删除旧版本后重新运行 modpack_add_mod。')
      }
      return {
        ok: report.verdict !== 'conflict',
        verdict: report.verdict,
        installedMods: source.length,
        conflicts: report.conflicts,
        knownPairs: report.knownPairs,
        declared: report.declared,
        missing: report.missing,
        recommendations,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_add_optimization',
    description:
      '按优化档位自动推荐并安装性能模组（Fabric / Forge / NeoForge 三套清单，'
      + 'client / server 分开），档位 light 只装最稳的、balanced 是通用推荐、aggressive 追求极限帧率。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      profile: { type: 'string', enum: ['light', 'balanced', 'aggressive'], description: '优化档位，默认 balanced。' },
      client: { type: 'boolean', description: '是否包含客户端优化，默认 true。' },
      server: { type: 'boolean', description: '是否包含服务端优化，默认 false。' },
      download: { type: 'boolean', description: '是否下载，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          profile: { type: 'string', required: true },
          recommended: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                category: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          added: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                versionId: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                sha1: { type: 'string', required: true },
                role: { type: 'string', required: true },
              },
            },
          },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `modpack_add_optimization(${value.profile}) → 推荐 ${value.recommended.length} 个，下载 ${value.added.length} 个\n`
          + value.added.slice(0, 12).map((item) => `- ${item.title}（${item.slug}）`).join('\n'),
      }],
    },
    timeoutMs: 15 * 60_000,
    async execute(args, exec) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const profile = str(args.profile, 'balanced')
      const withClient = args.client !== false
      const withServer = args.server === true
      const forgeLike = loader === 'forge' || loader === 'neoforge'

      const catalog: Array<{ slug: string; title: string; category: string; reason: string; level: 1 | 2; side: 'client' | 'server' | 'both' }> = forgeLike
        ? [
            { slug: 'embeddium', title: 'Embeddium', category: '渲染', reason: 'Forge 系渲染优化，替代 OptiFine 的性能部分', level: 1, side: 'client' },
            { slug: 'ferritecore', title: 'FerriteCore', category: '内存', reason: '压缩方块状态内存占用，模组越多收益越大', level: 1, side: 'both' },
            { slug: 'modernfix', title: 'ModernFix', category: '启动与内存', reason: '显著缩短启动时间并降低内存占用', level: 1, side: 'both' },
            { slug: 'entityculling', title: 'EntityCulling', category: '渲染', reason: '剔除不可见实体，野外帧率提升明显', level: 1, side: 'client' },
            { slug: 'clumps', title: 'Clumps', category: '性能', reason: '合并经验球，刷怪塔场景防止卡顿', level: 1, side: 'both' },
            { slug: 'canary', title: 'Canary', category: '服务端', reason: 'Forge 系区块与实体逻辑优化', level: 1, side: 'server' },
            { slug: 'starlight', title: 'Starlight', category: '光照', reason: '重写光照引擎，区块加载更快', level: 2, side: 'both' },
            { slug: 'oculus', title: 'Oculus', category: '光影', reason: '在 Forge 上提供 Iris 光影兼容层', level: 2, side: 'client' },
            { slug: 'radium', title: 'Radium', category: '服务端', reason: 'Lithium 的 Forge 移植，逻辑层优化', level: 2, side: 'both' },
          ]
        : [
            { slug: 'sodium', title: 'Sodium', category: '渲染', reason: 'Fabric 侧核心渲染优化，帧率翻倍级提升', level: 1, side: 'client' },
            { slug: 'lithium', title: 'Lithium', category: '服务端与逻辑', reason: '不改变原版行为的通用逻辑优化', level: 1, side: 'both' },
            { slug: 'ferritecore', title: 'FerriteCore', category: '内存', reason: '压缩方块状态内存占用', level: 1, side: 'both' },
            { slug: 'krypton', title: 'Krypton', category: '网络', reason: '优化网络栈，多人游戏延迟更低', level: 1, side: 'both' },
            { slug: 'entityculling', title: 'EntityCulling', category: '渲染', reason: '剔除不可见实体', level: 1, side: 'client' },
            { slug: 'iris', title: 'Iris', category: '光影', reason: '光影加载器，配合 Sodium 使用', level: 1, side: 'client' },
            { slug: 'indium', title: 'Indium', category: '兼容', reason: '让 Sodium 正常渲染 Fabric 自定义模型', level: 1, side: 'client' },
            { slug: 'lazy-dfu', title: 'LazyDFU', category: '启动', reason: '跳过数据修复器的预热，启动更快', level: 2, side: 'client' },
            { slug: 'c2me-fabric', title: 'C2ME', category: '区块', reason: '多线程区块生成，探索时掉帧更少', level: 2, side: 'both' },
            { slug: 'vmp-fabric', title: 'Very Many Players', category: '服务端', reason: '多线程实体处理，适合多人服', level: 2, side: 'server' },
          ]

      const maxLevel = profile === 'light' ? 1 : profile === 'balanced' ? 1 : 2
      const recommended = catalog
        .filter((entry) => entry.level <= (profile === 'balanced' ? 1 : maxLevel) || profile === 'aggressive')
        .filter((entry) => (entry.side === 'client' ? withClient : entry.side === 'server' ? withServer : withClient || withServer))
        .map((entry) => ({ slug: entry.slug, title: entry.title, category: entry.category, reason: entry.reason }))

      const notes: string[] = []
      if (forgeLike && withClient) {
        notes.push('Forge/NeoForge 侧若已安装 OptiFine，请先移除：Embeddium/Oculus 与 OptiFine 互斥。')
      }
      if (!forgeLike && withClient) {
        notes.push('Sodium 与 OptiFine 互斥；若需要光影请用 Iris，不要装 OptiFine。')
      }
      if (recommended.length === 0) {
        notes.push('当前档位与 client/server 组合没有可推荐的模组，请放宽条件。')
        return { ok: true, profile, recommended, added: [], skipped: [], notes }
      }

      const outcome = await addModsCore(modrinth(exec.signal), {
        packDir,
        minecraftVersion,
        loader,
        roots: recommended.map((entry) => ({ id: entry.slug, label: 'modpack_add_optimization' })),
        includeOptional: false,
        download: args.download !== false,
        side: withServer && !withClient ? 'server' : 'both',
        maxDepth: 20,
      })

      const skipped = [...outcome.skipped]
      for (const entry of recommended) {
        if (!outcome.added.some((item) => item.slug === entry.slug)) {
          skipped.push(`${entry.slug}（未能安装：可能是版本缺失，改用 modpack_search_mods 找替代品）`)
        }
      }
      if (outcome.conflicts.verdict === 'conflict') {
        notes.push('优化模组装载后出现冲突判定，请先运行 modpack_check_conflicts 处理。')
      }

      return {
        ok: outcome.conflicts.verdict !== 'conflict',
        profile,
        recommended,
        added: outcome.added,
        skipped,
        notes,
      }
    },
  }))
}

// ── 共享：任务书输入收窄 ─────────────────────────────────────────────────────

function toQuestTask(raw: unknown): QuestTask {
  const record = rec(raw)
  const type = str(record.type, 'item') as QuestTask['type']
  return {
    type,
    ...(str(record.item) !== '' ? { item: str(record.item) } : {}),
    ...(str(record.tag) !== '' ? { tag: str(record.tag) } : {}),
    ...(record.count !== undefined ? { count: num(record.count, 1) } : {}),
    ...(str(record.id) !== '' ? { id: str(record.id) } : {}),
    ...(str(record.dimension) !== '' ? { dimension: str(record.dimension) } : {}),
    ...(str(record.entity) !== '' ? { entity: str(record.entity) } : {}),
    ...(str(record.stat) !== '' ? { stat: str(record.stat) } : {}),
    ...(record.value !== undefined ? { value: num(record.value, 1) } : {}),
    ...(str(record.title) !== '' ? { title: str(record.title) } : {}),
    ...(str(record.observe) !== '' ? { observe: str(record.observe) } : {}),
    ...(record.range !== undefined ? { range: num(record.range, 4) } : {}),
    ...(str(record.stage) !== '' ? { stage: str(record.stage) } : {}),
    ...(str(record.onlyFrom) !== '' ? { onlyFrom: str(record.onlyFrom) as 'player' | 'server' } : {}),
  }
}

function toQuestReward(raw: unknown): QuestReward {
  const record = rec(raw)
  return {
    type: str(record.type, 'item') as QuestReward['type'],
    ...(str(record.item) !== '' ? { item: str(record.item) } : {}),
    ...(record.count !== undefined ? { count: num(record.count, 1) } : {}),
    ...(record.xp !== undefined ? { xp: num(record.xp, 10) } : {}),
    ...(record.levels !== undefined ? { levels: num(record.levels, 5) } : {}),
    ...(str(record.command) !== '' ? { command: str(record.command) } : {}),
    ...(str(record.tableId) !== '' ? { tableId: str(record.tableId) } : {}),
    ...(str(record.stage) !== '' ? { stage: str(record.stage) } : {}),
    ...(str(record.title) !== '' ? { title: str(record.title) } : {}),
    ...(str(record.subtitle) !== '' ? { subtitle: str(record.subtitle) } : {}),
    ...(record.silent !== undefined ? { silent: bool(record.silent) } : {}),
    ...(record.entries !== undefined ? { entries: arr(record.entries).map(toQuestReward) } : {}),
  }
}

function toQuestDraft(raw: unknown): QuestDraft {
  const record = rec(raw)
  return {
    ...(str(record.id) !== '' ? { id: str(record.id) } : {}),
    title: requireString(record.title, 'chapters[].quests[].title'),
    ...(str(record.subtitle) !== '' ? { subtitle: str(record.subtitle) } : {}),
    ...(record.description !== undefined ? { description: asStringArray(record.description) } : {}),
    ...(str(record.icon) !== '' ? { icon: str(record.icon) } : {}),
    x: num(record.x, 0),
    y: num(record.y, 0),
    ...(record.size !== undefined ? { size: num(record.size, 1) } : {}),
    ...(str(record.shape) !== '' ? { shape: str(record.shape) as QuestDraft['shape'] } : {}),
    tasks: arr(record.tasks).map(toQuestTask),
    ...(record.rewards !== undefined ? { rewards: arr(record.rewards).map(toQuestReward) } : {}),
    ...(record.dependencies !== undefined ? { dependencies: asStringArray(record.dependencies) } : {}),
    ...(record.optional !== undefined ? { optional: bool(record.optional) } : {}),
    ...(record.hidden !== undefined ? { hidden: bool(record.hidden) } : {}),
    ...(record.invisible !== undefined ? { invisible: bool(record.invisible) } : {}),
    ...(record.hideDependencyLines !== undefined ? { hideDependencyLines: bool(record.hideDependencyLines) } : {}),
    ...(record.tags !== undefined ? { tags: asStringArray(record.tags) } : {}),
  } as QuestDraft
}

function toChapterDraft(raw: unknown): ChapterDraft {
  const record = rec(raw)
  return {
    ...(str(record.id) !== '' ? { id: str(record.id) } : {}),
    ...(str(record.filename) !== '' ? { filename: str(record.filename) } : {}),
    title: requireString(record.title, 'chapters[].title'),
    ...(str(record.subtitle) !== '' ? { subtitle: str(record.subtitle) } : {}),
    ...(str(record.group) !== '' ? { group: str(record.group) } : {}),
    ...(record.orderIndex !== undefined ? { orderIndex: num(record.orderIndex, 0) } : {}),
    ...(str(record.icon) !== '' ? { icon: str(record.icon) } : {}),
    ...(str(record.defaultQuestShape) !== '' ? { defaultQuestShape: str(record.defaultQuestShape) } : {}),
    quests: arr(record.quests).map(toQuestDraft),
  }
}

// ── 阶段三：配置与内容定制 ───────────────────────────────────────────────────

function registerContentTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_gen_config',
    description:
      '生成/合并模组配置文件：支持 json / toml / properties / snbt 四种格式，对已有 JSON 做深合并并自动备份，' +
      '还能按原版键名生成 options.txt 与 server.properties，并给出常见模组的配置路径建议（不伪造未知键名）。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      theme: { type: 'string', description: '主题描述，仅用于记录。' },
      files: {
        type: 'array',
        description: '要写入的配置文件列表，每项 {path, format, content, merge?}。path 必须落在 config / defaultconfigs / local / options.txt / server.properties / packmenu / polytone 之下。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            format: { type: 'string', enum: ['json', 'toml', 'properties', 'snbt'], required: true },
            content: { type: 'json' },
            merge: { type: 'boolean' },
          },
        },
      },
      clientOptions: {
        type: 'object',
        additionalProperties: false,
        description: '原版客户端选项（生成 options.txt）：language / guiScale / renderDistance / maxFps / fov / particles 等。',
        properties: {
          language: { type: 'string' },
          guiScale: { type: 'integer' },
          renderDistance: { type: 'integer' },
          simulationDistance: { type: 'integer' },
          maxFps: { type: 'integer' },
          fov: { type: 'number' },
          gamma: { type: 'number' },
          enableVsync: { type: 'boolean' },
          pauseOnLostFocus: { type: 'boolean' },
          autoJump: { type: 'boolean' },
          particles: { type: 'string', enum: ['all', 'decreased', 'minimal'] },
          graphicsMode: { type: 'integer' },
        },
      },
      serverProperties: { type: 'json', description: '服务端设置（生成 server.properties）。' },
      modIds: { type: 'array', items: { type: 'string' }, description: '想预置配置的模组 id 列表；只会返回路径建议，不会伪造内容。' },
      dryRun: { type: 'boolean', description: '只规划不写盘。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          planNote: { type: 'string', required: true },
          written: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                format: { type: 'string', required: true },
                action: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                merged: { type: 'boolean', required: true },
                backup: { type: 'string', required: true },
              },
            },
          },
          suggestions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                modId: { type: 'string', required: true },
                path: { type: 'string', required: true },
                format: { type: 'string', required: true },
                note: { type: 'string', required: true },
              },
            },
          },
          unknownModIds: { type: 'array', required: true, items: { type: 'string' } },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_gen_config → ${value.written.length} 个文件${value.dryRun ? '（干跑，未写盘）' : ''}\n`
          + value.written.map((item) => `- ${item.path}（${item.format}/${item.action}${item.merged ? '/已合并' : ''}，${item.bytes}B）`).join('\n')
          + (value.unknownModIds.length > 0 ? `\n无路径记录的模组：${value.unknownModIds.join('、')}` : ''),
      }],
    },
    timeoutMs: 60_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)

      const fileSpecs: ConfigFileSpec[] = arr(args.files).map((item) => {
        const record = rec(item)
        const path = requireString(record.path, 'files[].path')
        const format = formatOf(record.format)
        const rawContent = record.content
        const content = typeof rawContent === 'string' ? rawContent : asRecord(rawContent)
        return {
          path,
          format,
          content,
          ...(record.merge !== undefined ? { merge: bool(record.merge) } : {}),
        }
      })

      const clientOptionsRaw = args.clientOptions
      const plan = planConfigOverrides({
        packDir,
        minecraftVersion,
        loader,
        ...(str(args.theme) !== '' ? { theme: str(args.theme) } : {}),
        files: fileSpecs,
        ...(clientOptionsRaw !== undefined ? { clientOptions: clientOptionsRaw } : {}),
        ...(Object.keys(asRecord(args.serverProperties)).length > 0 ? { serverProperties: asRecord(args.serverProperties) } : {}),
        ...(asStringArray(args.modIds).length > 0 ? { modIds: asStringArray(args.modIds) } : {}),
      })

      const dryRun = args.dryRun === true
      const results = dryRun ? [] : await applyConfigPlan(plan, packDir)

      const report = [
        `# 配置覆盖报告（${dryRun ? '干跑' : '已写盘'}）`,
        '',
        `- 整合包：${packDir}`,
        `- 目标：Minecraft ${minecraftVersion} / ${loader}`,
        `- 计划文件数：${plan.specs.length}`,
        plan.planNote,
        '',
        ...plan.specs.map((spec) => `- ${spec.path}（${spec.format}${spec.merge === false ? '，覆盖写入' : '，深合并'}）`),
        ...(plan.suggestions.length > 0
          ? ['', '## 模组配置路径建议', ...plan.suggestions.map((item) => `- ${item.modId} → ${item.path}（${item.note}）`)]
          : []),
      ].join('\n')

      return {
        ok: true,
        dryRun,
        planNote: plan.planNote,
        written: results.map((item) => ({
          path: item.path,
          format: item.format,
          action: item.action,
          bytes: item.bytes,
          merged: item.merged,
          backup: item.backup ?? '',
        })),
        suggestions: plan.suggestions,
        unknownModIds: plan.unknownModIds,
        report,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_gen_quests',
    description:
      '生成 FTB Quests 任务书：按章节生成 SNBT 文件（chapters/*.snbt + chapter_groups.snbt + data.snbt），' +
      '任务与奖励 id 由内容确定性派生（重复生成不会打断玩家进度），并自动检查 id 冲突与悬空依赖。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      title: { type: 'string', required: true, description: '任务书标题。' },
      chapters: {
        type: 'array',
        required: true,
        description: '章节数组，每章 {title, group?, icon?, orderIndex?, quests:[{title, x, y, tasks:[...], rewards?:[...], dependencies?:[id]}]}。',
        items: { type: 'object', additionalProperties: true, properties: { title: { type: 'string', required: true }, quests: { type: 'array', required: true, items: { type: 'json' } } } },
      },
      autoChain: { type: 'boolean', description: '是否自动按坐标顺序串联同章节任务，默认 false。' },
      overwrite: { type: 'boolean', description: '是否覆盖已存在的章节文件，默认 true。' },
      dryRun: { type: 'boolean', description: '只生成不写盘。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          chapters: { type: 'integer', required: true },
          quests: { type: 'integer', required: true },
          tasks: { type: 'integer', required: true },
          rewards: { type: 'integer', required: true },
          chapterGroups: { type: 'integer', required: true },
          questIndex: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                chapter: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_gen_quests → ${value.chapters} 章 / ${value.quests} 任务 / ${value.tasks} 目标 / ${value.rewards} 奖励${value.dryRun ? '（干跑）' : ''}\n`
          + value.files.map((file) => `- ${file}`).join('\n')
          + (value.warnings.length > 0 ? `\n警告 ${value.warnings.length} 条：\n` + value.warnings.slice(0, 8).map((item) => `- ${item}`).join('\n') : ''),
      }],
    },
    timeoutMs: 60_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const title = requireString(args.title, 'title')
      const chapters = arr(args.chapters).map(toChapterDraft)
      if (chapters.length === 0) throw new ModpackError('INVALID_ARGUMENT', 'chapters 不能为空')
      const dryRun = args.dryRun === true

      const result = await generateQuestBook({
        packDir,
        title,
        chapters,
        autoChain: args.autoChain === true,
        overwrite: args.overwrite !== false,
        dryRun,
      })
      return {
        ok: true,
        dryRun,
        files: result.files,
        chapters: result.chapters,
        quests: result.quests,
        tasks: result.tasks,
        rewards: result.rewards,
        chapterGroups: result.chapterGroups,
        questIndex: result.questIndex,
        warnings: result.warnings,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_add_resources',
    description:
      '添加资源包与光影包（也支持数据包）：从 Modrinth 按版本选包并下载到 resourcepacks/ 或 shaderpacks/，' +
      '也可以把本地已有的 zip 复制进去。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器（资源包项目也要带加载器过滤）。' },
      resourcePacks: {
        type: 'array',
        description: '资源包列表，每项 {id, versionId?}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string', required: true }, versionId: { type: 'string' } },
        },
      },
      shaders: {
        type: 'array',
        description: '光影包列表，每项 {id, versionId?}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string', required: true }, versionId: { type: 'string' } },
        },
      },
      localFiles: { type: 'array', items: { type: 'string' }, description: '本地已有文件路径，会被复制到 resourcepacks/。' },
      download: { type: 'boolean', description: '是否真的下载，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          added: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                sha1: { type: 'string', required: true },
              },
            },
          },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_add_resources → 新增 ${value.added.length} 个资源\n`
          + value.added.map((item) => `- [${item.kind}] ${item.title} → ${item.path}`).join('\n')
          + (value.skipped.length > 0 ? `\n跳过 ${value.skipped.length} 项` : ''),
      }],
    },
    timeoutMs: 10 * 60_000,
    async execute(args, exec) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const client = modrinth(exec.signal)
      const download = args.download !== false
      const added: Array<{ slug: string; title: string; kind: string; fileName: string; path: string; size: number; sha1: string }> = []
      const skipped: string[] = []
      const notes: string[] = []

      const jobs: Array<{ raw: unknown; kind: 'resourcepack' | 'shader'; targetDir: string }> = [
        ...arr(args.resourcePacks).map((raw) => ({ raw, kind: 'resourcepack' as const, targetDir: 'resourcepacks' })),
        ...arr(args.shaders).map((raw) => ({ raw, kind: 'shader' as const, targetDir: 'shaderpacks' })),
      ]

      for (const job of jobs) {
        const record = rec(job.raw)
        const id = requireString(record.id, 'resourcePacks[].id')
        const versionId = str(record.versionId)
        try {
          const version = await pickVersionFor(client, id, versionId === '' ? null : versionId, minecraftVersion, loader)
          const file = version.files.find((item) => item.primary) ?? version.files[0] ?? null
          if (file === null) {
            skipped.push(`${id}（版本 ${version.id} 没有文件）`)
            continue
          }
          const target = resolveInside(packDir, job.targetDir, basename(file.filename))
          let size = file.size
          let digest = file.sha1
          if (download && !(await pathExists(target))) {
            const result = await client.downloadFile(file, target)
            size = result.size
            digest = result.sha1
          } else if (!download) {
            skipped.push(`${id}（download=false）`)
            continue
          }
          let title = version.name
          let slug = version.projectId
          try {
            const project = await client.getProject(version.projectId)
            title = project.title
            slug = project.slug
          } catch {
            /* 忽略 */
          }
          added.push({
            slug,
            title,
            kind: job.kind,
            fileName: basename(file.filename),
            path: `${job.targetDir}/${basename(file.filename)}`,
            size,
            sha1: digest,
          })
        } catch (error) {
          skipped.push(`${id}（${error instanceof Error ? error.message : String(error)}）`)
        }
      }

      for (const local of asStringArray(args.localFiles)) {
        const absolute = (await pathExists(local)) ? local : join(packDir, local)
        if (!(await pathExists(absolute))) {
          skipped.push(`${local}（本地文件不存在）`)
          continue
        }
        const data = new Uint8Array(await readFile(absolute))
        const target = resolveInside(packDir, 'resourcepacks', basename(absolute))
        await writeFileEnsured(target, data)
        added.push({
          slug: slugify(basename(absolute, '.zip'), 'local-pack'),
          title: basename(absolute),
          kind: 'local',
          fileName: basename(absolute),
          path: `resourcepacks/${basename(absolute)}`,
          size: data.byteLength,
          sha1: sha1(data),
        })
      }

      if (added.some((item) => item.kind === 'shader')) {
        notes.push('光影包需要在游戏内「选项 → 视频设置 → 光影」里手动启用（或由启动器预置 shaderpacks 配置）。')
      }
      notes.push('资源包默认不会自动启用：整合包应在 options.txt 的 resourcePacks 列表里预置，或用启动器默认开启。')
      return { ok: true, added, skipped, notes }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_gen_readme',
    description:
      '生成整合包 README（安装说明、模组清单、任务章节大纲、配置说明、许可与致谢），' +
      '支持中英双语输出，直接写入 packDir/README.md 与 README.en.md。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      name: { type: 'string', required: true, description: '整合包名称。' },
      version: { type: 'string', required: true, description: '版本号。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      theme: { type: 'string', description: '主题描述。' },
      authors: { type: 'array', items: { type: 'string' }, description: '作者列表。' },
      memoryGb: { type: 'integer', description: '建议内存（GB）。' },
      modList: {
        type: 'array',
        description: '模组清单，每项 {slug, title, url?, author?, license?}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slug: { type: 'string', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string' },
            author: { type: 'string' },
            license: { type: 'string' },
          },
        },
      },
      chapters: { type: 'array', items: { type: 'string' }, description: '任务书章节标题列表。' },
      language: { type: 'string', enum: ['zh_cn', 'en_us', 'both'], description: '输出语言，默认 zh_cn。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          bytes: { type: 'integer', required: true },
          sections: { type: 'array', required: true, items: { type: 'string' } },
          javaMajor: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_gen_readme → ${value.files.join('、')}（${value.bytes} 字节）\n章节：${value.sections.join(' / ')}`,
      }],
    },
    timeoutMs: 30_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const name = requireString(args.name, 'name')
      const version = requireString(args.version, 'version')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const java = javaVersionFor(minecraftVersion)
      const language = str(args.language, 'zh_cn')
      const authors = asStringArray(args.authors)
      const theme = str(args.theme)
      const memoryGb = clampInt(args.memoryGb, 2, 64, 8)
      const modList = arr(args.modList).map((item) => rec(item))
      const chapters = asStringArray(args.chapters)
      const sections = ['简介', '环境要求', '安装步骤', '模组清单', '任务章节', '常见问题', '许可与致谢']

      const renderZh = (): string => {
        const lines: string[] = []
        lines.push(`# ${name} ${version}`)
        lines.push('')
        lines.push(theme !== '' ? `> ${theme}` : '> 一个 Minecraft 整合包')
        lines.push('')
        lines.push('## 简介')
        lines.push(`${name} 基于 Minecraft ${minecraftVersion}（${loader}）构建，共收录 ${modList.length} 个模组${chapters.length > 0 ? `，包含 ${chapters.length} 章任务书` : ''}。`)
        lines.push('')
        lines.push('## 环境要求')
        lines.push('')
        lines.push('| 项目 | 要求 |')
        lines.push('| --- | --- |')
        lines.push(`| Minecraft | ${minecraftVersion} |`)
        lines.push(`| 加载器 | ${loader} |`)
        lines.push(`| Java | ${java.major}（${java.note}） |`)
        lines.push(`| 内存 | 建议 ${memoryGb} GB（最低 ${Math.max(4, memoryGb - 2)} GB） |`)
        lines.push('')
        lines.push('## 安装步骤')
        lines.push('')
        lines.push(`1. 安装 Java ${java.major} 与启动器（PCL / HMCL / Prism / MultiMC 均可）；`)
        lines.push(`2. 新建 Minecraft ${minecraftVersion} 的 ${loader} 实例；`)
        lines.push('3. 把整合包内的 `mods/`、`config/`、`resourcepacks/`、`ftbquests/` 等目录复制到实例根目录；')
        lines.push(`4. 在启动器里把内存设置为 ${memoryGb} GB，并粘贴 jvm-args.txt 里的 JVM 参数；`)
        lines.push('5. 启动游戏，首次进入会生成配置文件，属正常现象。')
        lines.push('')
        if (modList.length > 0) {
          lines.push('## 模组清单')
          lines.push('')
          lines.push('| 模组 | 作者 | 许可 | 链接 |')
          lines.push('| --- | --- | --- | --- |')
          for (const mod of modList) {
            lines.push(`| ${str(mod.title, str(mod.slug))} | ${str(mod.author, '-')} | ${str(mod.license, '-')} | ${str(mod.url, '-')} |`)
          }
          lines.push('')
        }
        if (chapters.length > 0) {
          lines.push('## 任务章节')
          lines.push('')
          for (const chapter of chapters) lines.push(`- ${chapter}`)
          lines.push('')
        }
        lines.push('## 常见问题')
        lines.push('')
        lines.push('- **启动崩溃**：先看 `crash-reports/` 最新一份报告，多数是缺依赖或模组冲突，可用 `modpack_check_conflicts` 排查；')
        lines.push('- **帧率低**：确认已启用性能模组，内存不要超过物理内存的 60%；')
        lines.push('- **任务书不显示**：确认 FTB Quests 已安装并且 `config/ftbquests/` 目录完整。')
        lines.push('')
        lines.push('## 许可与致谢')
        lines.push('')
        lines.push(`- 整合包本身：${authors.length > 0 ? `由 ${authors.join('、')} 制作` : '作者未署名'}`)
        lines.push('- 各模组版权归原作者所有，请遵循各模组的许可协议，**不要二次分发禁止再分发的模组**。')
        lines.push('')
        return lines.join('\n')
      }

      const renderEn = (): string => {
        const lines: string[] = []
        lines.push(`# ${name} ${version}`)
        lines.push('')
        lines.push(theme !== '' ? `> ${theme}` : '> A Minecraft modpack')
        lines.push('')
        lines.push('## Requirements')
        lines.push('')
        lines.push(`- Minecraft ${minecraftVersion} (${loader})`)
        lines.push(`- Java ${java.major}`)
        lines.push(`- ${memoryGb} GB RAM recommended`)
        lines.push(`- ${modList.length} mods${chapters.length > 0 ? `, ${chapters.length} quest chapters` : ''}`)
        lines.push('')
        lines.push('## Installation')
        lines.push('')
        lines.push(`1. Install Java ${java.major} and a launcher.`)
        lines.push(`2. Create a Minecraft ${minecraftVersion} ${loader} instance.`)
        lines.push('3. Copy `mods/`, `config/`, `resourcepacks/` into the instance folder.')
        lines.push('4. Apply the JVM arguments from `jvm-args.txt`.')
        lines.push('')
        lines.push('## Credits')
        lines.push('')
        lines.push('All mods belong to their respective authors. Follow each mod license; do not redistribute mods that forbid it.')
        lines.push('')
        return lines.join('\n')
      }

      const files: string[] = []
      let bytes = 0
      if (language === 'zh_cn' || language === 'both') {
        const text = renderZh()
        await writeFileEnsured(resolveInside(packDir, 'README.md'), text)
        files.push('README.md')
        bytes += Buffer.byteLength(text, 'utf8')
      }
      if (language === 'en_us' || language === 'both') {
        const text = renderEn()
        await writeFileEnsured(resolveInside(packDir, 'README.en.md'), text)
        files.push('README.en.md')
        bytes += Buffer.byteLength(text, 'utf8')
      }
      return { ok: true, files, bytes, sections, javaMajor: java.major }
    },
  }))
}

// ── 共享：UI 输入收窄 ────────────────────────────────────────────────────────

function toPackMenuButton(raw: unknown): PackMenuButton {
  const record = rec(raw)
  return {
    name: requireString(record.name, 'buttons[].name'),
    action: str(record.action, 'NONE') as PackMenuButton['action'],
    ...(str(record.langKey) !== '' ? { langKey: str(record.langKey) } : {}),
    ...(str(record.hoverLangKey) !== '' ? { hoverLangKey: str(record.hoverLangKey) } : {}),
    ...(str(record.text) !== '' ? { text: str(record.text) } : {}),
    ...(str(record.data) !== '' ? { data: str(record.data) } : {}),
    ...(record.x !== undefined ? { x: num(record.x, 0) } : {}),
    ...(record.y !== undefined ? { y: num(record.y, 0) } : {}),
    ...(record.width !== undefined ? { width: num(record.width, 200) } : {}),
    ...(record.height !== undefined ? { height: num(record.height, 20) } : {}),
    ...(str(record.texture) !== '' ? { texture: str(record.texture) } : {}),
    ...(record.u !== undefined ? { u: num(record.u, 0) } : {}),
    ...(record.v !== undefined ? { v: num(record.v, 0) } : {}),
    ...(record.hoverU !== undefined ? { hoverU: num(record.hoverU, 0) } : {}),
    ...(record.hoverV !== undefined ? { hoverV: num(record.hoverV, 0) } : {}),
    ...(record.texWidth !== undefined ? { texWidth: num(record.texWidth, 256) } : {}),
    ...(record.texHeight !== undefined ? { texHeight: num(record.texHeight, 256) } : {}),
    ...(record.widgets !== undefined ? { widgets: bool(record.widgets) } : {}),
    ...(str(record.anchor) !== '' ? { anchor: str(record.anchor) as PackMenuButton['anchor'] } : {}),
    ...(record.fontColor !== undefined ? { fontColor: str(record.fontColor) !== '' ? str(record.fontColor) : num(record.fontColor, 16777215) } : {}),
    ...(record.hoverFontColor !== undefined ? { hoverFontColor: str(record.hoverFontColor) !== '' ? str(record.hoverFontColor) : num(record.hoverFontColor, 16777215) } : {}),
    ...(record.textXOffset !== undefined ? { textXOffset: num(record.textXOffset, 0) } : {}),
    ...(record.textYOffset !== undefined ? { textYOffset: num(record.textYOffset, -4) } : {}),
    ...(record.dropShadow !== undefined ? { dropShadow: bool(record.dropShadow, true) } : {}),
    ...(record.active !== undefined ? { active: bool(record.active, true) } : {}),
    ...(record.scaleX !== undefined ? { scaleX: num(record.scaleX, 1) } : {}),
    ...(record.scaleY !== undefined ? { scaleY: num(record.scaleY, 1) } : {}),
  }
}

function toPolytoneModifier(raw: unknown): PolytoneGuiModifier {
  const record = rec(raw)
  return {
    name: requireString(record.name, 'modifiers[].name'),
    targetType: str(record.targetType, 'screen_class') as PolytoneGuiModifier['targetType'],
    target: requireString(record.target, 'modifiers[].target'),
    ...(record.titleXOffset !== undefined ? { titleXOffset: num(record.titleXOffset, 0) } : {}),
    ...(record.titleYOffset !== undefined ? { titleYOffset: num(record.titleYOffset, 0) } : {}),
    ...(record.labelXOffset !== undefined ? { labelXOffset: num(record.labelXOffset, 0) } : {}),
    ...(record.labelYOffset !== undefined ? { labelYOffset: num(record.labelYOffset, 0) } : {}),
    ...(record.xOffset !== undefined ? { xOffset: num(record.xOffset, 0) } : {}),
    ...(record.yOffset !== undefined ? { yOffset: num(record.yOffset, 0) } : {}),
    ...(record.widthOffset !== undefined ? { widthOffset: num(record.widthOffset, 0) } : {}),
    ...(record.heightOffset !== undefined ? { heightOffset: num(record.heightOffset, 0) } : {}),
    ...(record.titleColor !== undefined ? { titleColor: num(record.titleColor, 0x404040) } : {}),
    ...(record.labelColor !== undefined ? { labelColor: num(record.labelColor, 0x404040) } : {}),
    ...(record.sprites !== undefined
      ? {
          sprites: arr(record.sprites).map((sprite) => {
            const entry = rec(sprite)
            return {
              texture: str(entry.texture),
              x: num(entry.x, 0),
              y: num(entry.y, 0),
              width: num(entry.width, 16),
              height: num(entry.height, 16),
              ...(entry.z !== undefined ? { z: num(entry.z, 0) } : {}),
              ...(str(entry.tooltip) !== '' ? { tooltip: str(entry.tooltip) } : {}),
            }
          }),
        }
      : {}),
    ...(record.texts !== undefined
      ? {
          texts: arr(record.texts).map((text) => {
            const entry = rec(text)
            return {
              text: str(entry.text),
              x: num(entry.x, 0),
              y: num(entry.y, 0),
              ...(entry.z !== undefined ? { z: num(entry.z, 0) } : {}),
              ...(entry.color !== undefined ? { color: num(entry.color, -1) } : {}),
              ...(entry.centered !== undefined ? { centered: bool(entry.centered) } : {}),
            }
          }),
        }
      : {}),
  }
}

function toVistasEntry(raw: unknown): VistasPanoramaEntry {
  const record = rec(raw)
  return {
    cubemapId: requireString(record.cubemapId, 'vistas[].cubemapId'),
    ...(record.weight !== undefined ? { weight: num(record.weight, 1) } : {}),
    ...(record.frozen !== undefined ? { frozen: bool(record.frozen) } : {}),
    ...(record.speedMultiplier !== undefined ? { speedMultiplier: num(record.speedMultiplier, 1) } : {}),
    ...(record.fov !== undefined ? { fov: num(record.fov, 85) } : {}),
    ...(str(record.musicSound) !== '' ? { musicSound: str(record.musicSound) } : {}),
  }
}

// ── 阶段四：界面设计（含 AI 生图） ───────────────────────────────────────────

function registerUiTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_gen_ui_theme',
    description:
      '根据整合包主题生成完整 UI 设计方案：配色（主色/辅色/强调色/背景/文字）、风格关键词、'
      + '主界面背景与全景图 6 个面的英文生图 prompt、按钮/图标/HUD/容器 prompt、'
      + 'PackMenu 按钮布局骨架（锚点+偏移+动作）与所采用的 UI 方案（PackMenu / Polytone / Vistas）。'
      + '输出可被 modpack_gen_menu_bg、modpack_gen_ui_textures、modpack_assemble_ui_pack 直接消费。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录，方案会写入 <packDir>/ui/theme-plan.json。' },
      theme: { type: 'string', required: true, description: '主题描述，例如「深蓝色科技风」。' },
      style: { type: 'string', description: '追加的风格关键词，逗号分隔。' },
      colors: {
        type: 'object',
        additionalProperties: false,
        description: '指定配色（缺省按主题推导）。',
        properties: {
          primary: { type: 'string' },
          secondary: { type: 'string' },
          accent: { type: 'string' },
        },
      },
      minecraftVersion: { type: 'string', description: '目标游戏版本，默认 1.20.1。' },
      loader: { type: 'string', enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器（决定 PackMenu 是否可用）。' },
      menuStyle: { type: 'string', enum: ['panorama', 'single', 'slideshow'], description: '主界面背景形态，默认 panorama。' },
      resolution: { type: 'string', description: '目标分辨率，默认 1920x1080。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          planFile: { type: 'string', required: true },
          palette: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              primary: { type: 'string', required: true },
              secondary: { type: 'string', required: true },
              accent: { type: 'string', required: true },
              background: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          styleKeywords: { type: 'array', required: true, items: { type: 'string' } },
          backgroundPrompt: { type: 'string', required: true },
          panoramaPrompts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                direction: { type: 'string', required: true },
                file: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
              },
            },
          },
          buttonPrompt: { type: 'string', required: true },
          iconPrompt: { type: 'string', required: true },
          hudPrompt: { type: 'string', required: true },
          containerPrompt: { type: 'string', required: true },
          layout: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                text: { type: 'string', required: true },
                anchor: { type: 'string', required: true },
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                action: { type: 'string', required: true },
                data: { type: 'string', required: true },
              },
            },
          },
          uiStack: { type: 'array', required: true, items: { type: 'string' } },
          packMenuHints: { type: 'array', required: true, items: { type: 'string' } },
          modAdvice: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `modpack_gen_ui_theme「${args.theme}」→ 主色 ${value.palette.primary} / 强调 ${value.palette.accent}\n`
          + `风格：${value.styleKeywords.join(', ')}\n`
          + `布局骨架 ${value.layout.length} 个按钮；UI 方案：${value.uiStack.join(' + ')}\n`
          + `方案文件：${value.planFile}`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const theme = requireString(args.theme, 'theme')
      const minecraftVersion = str(args.minecraftVersion, '1.20.1')
      const loader = str(args.loader, 'fabric').toLowerCase()
      const style = str(args.style)
      const menuStyle = str(args.menuStyle, 'panorama')
      const resolution = str(args.resolution, '1920x1080')

      const profile = profileFor(theme)
      const colorOverride = rec(args.colors)
      const primary = str(colorOverride.primary, profile.palette.primary)
      const secondary = str(colorOverride.secondary, profile.palette.secondary)
      const accent = str(colorOverride.accent, profile.palette.accent)
      const palette = deriveThemeColors(primary, secondary, accent)
      const styleKeywords = [
        ...profile.styleKeywords,
        ...(style !== '' ? style.split(',').map((item) => item.trim()).filter((item) => item !== '') : []),
      ]
      const promptContext: PromptContext = {
        theme,
        style: styleKeywords.join(', '),
        colors: [palette.primary, palette.secondary, palette.accent],
      }

      const forgeLike = loader === 'forge' || loader === 'neoforge'
      const uiStack: string[] = ['resourcepack']
      if (forgeLike) uiStack.push('packmenu')
      uiStack.push('polytone')
      if (!forgeLike) uiStack.push('vistas')

      const layout = [
        { name: 'play', text: '开始游戏', anchor: 'DEFAULT', x: 0, y: -16, width: 200, height: 20, action: 'OPEN_GUI', data: 'SINGLEPLAYER' },
        { name: 'multiplayer', text: '多人游戏', anchor: 'DEFAULT', x: 0, y: 8, width: 200, height: 20, action: 'OPEN_GUI', data: 'MULTIPLAYER' },
        { name: 'mods', text: '模组管理', anchor: 'DEFAULT', x: 0, y: 32, width: 200, height: 20, action: 'OPEN_GUI', data: 'MODS' },
        { name: 'options', text: '选项', anchor: 'DEFAULT', x: 0, y: 56, width: 200, height: 20, action: 'OPEN_GUI', data: 'OPTIONS' },
        { name: 'quit', text: '退出游戏', anchor: 'DEFAULT', x: 0, y: 80, width: 200, height: 20, action: 'QUIT', data: '' },
      ]

      const packMenuHints = forgeLike
        ? [
            '按钮 JSON 路径：assets/<namespace>/buttons/<name>.json（同时同步到 packmenu/resources/）',
            '按钮字段：x/y/width/height/texture/u/v/hoverU/hoverV/texWidth/texHeight/langKey/action/anchor/fontColor',
            '主菜单配置在 config/packmenu.json，Folder Pack 需为 true 才会读 packmenu/resources/',
            '幻灯片背景：配置 general.slideshow.Textures 列表，任意数量贴图循环淡入',
          ]
        : [
            '当前加载器不支持 PackMenu（那是 Forge/NeoForge 的模组），请用纯资源包方案或 Vistas',
            'Fabric 侧主菜单定制建议：Vistas（assets/<ns>/panoramas.json）+ 资源包贴图替换',
          ]

      const modAdvice = [
        ...(forgeLike
          ? ['安装 PackMenu 以获得自定义按钮与幻灯片背景', '安装 Polytone 以获得 GUI 修饰符能力']
          : ['安装 Vistas 以获得纯资源包全景图与菜单音乐', '安装 Polytone 以获得 GUI 修饰符能力']),
        '确保资源包在游戏中处于启用状态，且 pack_format 与游戏版本一致',
      ]

      const notes = [
        `目标分辨率 ${resolution}；全景图每面必须是 1024x1024 的正方形 PNG`,
        'Pollinations 不返回透明通道：图标/按钮类素材需要在后处理里做背景抠除（modpack_gen_ui_textures 已内置）',
        '生图后务必实机核对：AI 生成的矩形按钮边距常常与 200x20 的 UV 布局不匹配',
      ]

      const plan = {
        theme,
        minecraftVersion,
        loader,
        menuStyle,
        resolution,
        palette,
        styleKeywords,
        uiStack,
        prompts: {
          background: buildBackgroundPrompt(promptContext, { wide: true }),
          panorama: PANORAMA_FACES.map((face) => ({
            index: face.index,
            direction: face.direction,
            file: face.file,
            prompt: buildPanoramaFacePrompt(promptContext, face.index),
          })),
          button: buildUiElementPrompt(promptContext, 'button'),
          icon: buildUiElementPrompt(promptContext, 'icon'),
          hud: buildUiElementPrompt(promptContext, 'hud'),
          container: buildUiElementPrompt(promptContext, 'container'),
        },
        layout,
        packMenuHints,
        modAdvice,
        negativePrompt: defaultNegativePrompt(),
        generatedAt: nowIso(),
      }
      const planFile = resolveInside(packDir, 'ui', 'theme-plan.json')
      await writeFileEnsured(planFile, `${JSON.stringify(plan, null, 2)}\n`)

      return {
        ok: true,
        planFile,
        palette: {
          primary: palette.primary,
          secondary: palette.secondary,
          accent: palette.accent,
          background: palette.background,
          text: palette.text,
        },
        styleKeywords,
        backgroundPrompt: plan.prompts.background,
        panoramaPrompts: plan.prompts.panorama,
        buttonPrompt: plan.prompts.button,
        iconPrompt: plan.prompts.icon,
        hudPrompt: plan.prompts.hud,
        containerPrompt: plan.prompts.container,
        layout,
        uiStack,
        packMenuHints,
        modAdvice,
        notes,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_gen_menu_bg',
    description:
      '用 AI 生成主界面背景：type="single" 生成一张背景图并写入 6 个 panorama 面（静态全景，原版即可显示）；'
      + 'type="panorama" 为 6 个面各生成一张（north/east/south/west/up/down），并统一缩放为 1024x1024。'
      + '可选生成 panorama_overlay.png 渐变叠加层。默认使用免 Key 的 Pollinations。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      prompt: { type: 'string', required: true, description: '生图提示词（英文效果最好）。可直接用 modpack_gen_ui_theme 输出的 backgroundPrompt。' },
      minecraftVersion: { type: 'string', description: '目标游戏版本，默认 1.20.1（用于资源包 pack_format）。' },
      type: { type: 'string', enum: ['single', 'panorama'], description: 'single 单张背景 / panorama 六面全景，默认 single。' },
      theme: { type: 'string', description: '主题描述（追加到提示词）。' },
      style: { type: 'string', description: '风格关键词（追加到提示词）。' },
      width: { type: 'integer', description: '单张背景宽度，默认 1920。全景模式忽略（固定 1024）。' },
      height: { type: 'integer', description: '单张背景高度，默认 1080。全景模式忽略（固定 1024）。' },
      provider: { type: 'string', enum: ['pollinations', 'wanx', 'sdapi'], description: '生图后端，默认 pollinations（免 Key）。' },
      model: { type: 'string', description: '模型名，Pollinations 默认 turbo。' },
      seed: { type: 'integer', description: '随机种子。' },
      namespace: { type: 'string', description: '资源包命名空间，默认 modpack-ui。' },
      packName: { type: 'string', description: '资源包目录名，默认 <namespace>-ui。' },
      overlay: { type: 'boolean', description: '是否生成 panorama_overlay.png 渐变叠加层，默认 true。' },
      backgroundColor: { type: 'string', description: '叠加层/底色，默认取主题主色的深色版本。' },
      writeToPack: { type: 'boolean', description: '是否直接写入 resourcepacks/<packName>/，默认 true。' },
      saveIntermediates: { type: 'boolean', description: '是否把中间产物存到 <packDir>/ui/，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          type: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          packDir: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                role: { type: 'string', required: true },
              },
            },
          },
          overlayFile: { type: 'string', required: true },
          prompts: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_gen_menu_bg(${value.type}/${value.provider}) → 生成 ${value.files.length} 张贴图，耗时 ${(value.elapsedMs / 1000).toFixed(1)}s\n`
          + value.files.map((file) => `- ${file.path}（${file.width}x${file.height}，${(file.bytes / 1024).toFixed(0)}KB）`).join('\n')
          + (value.overlayFile !== '' ? `\n叠加层：${value.overlayFile}` : '')
          + (value.notes.length > 0 ? `\n${value.notes.map((note) => `- ${note}`).join('\n')}` : ''),
      }],
    },
    timeoutMs: 25 * 60_000,
    async execute(args, exec) {
      const started = Date.now()
      const packDir = requireString(args.packDir, 'packDir')
      const basePrompt = requireString(args.prompt, 'prompt')
      const minecraftVersion = str(args.minecraftVersion, '1.20.1')
      const type = str(args.type, 'single')
      const namespace = slugify(str(args.namespace, 'modpack-ui'), 'modpack-ui')
      const packName = str(args.packName, `${namespace}-ui`)
      const providerId: ImageProviderId = resolveProviderId(str(args.provider))
      const provider = createImageProvider(providerId, {
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      const model = str(args.model, PROVIDER_CATALOG.find((item) => item.id === providerId)?.defaultModel ?? 'turbo')
      const overlayWanted = args.overlay !== false
      const writeToPack = args.writeToPack !== false
      const saveIntermediates = args.saveIntermediates !== false
      const notes: string[] = []
      const files: Array<{ path: string; width: number; height: number; bytes: number; role: string }> = []
      const prompts: string[] = []

      const theme = str(args.theme)
      const style = str(args.style)
      const profile = profileFor(theme === '' ? basePrompt : theme)
      const promptContext: PromptContext = {
        theme: theme === '' ? basePrompt : theme,
        style: [style, ...profile.styleKeywords].filter((item) => item !== '').join(', '),
      }
      const bgDirUnderPack = ['assets', namespace, 'textures', 'gui', 'title', 'background'].join('/')
      const packRoot = join(packDir, 'resourcepacks', packName)
      const uiRoot = join(packDir, 'ui')

      const emit = async (
        data: Uint8Array,
        relPath: string,
        width: number,
        height: number,
        role: string,
      ): Promise<void> => {
        if (writeToPack) {
          await writeFileEnsured(join(packRoot, relPath), data)
        }
        if (saveIntermediates) {
          await writeFileEnsured(join(uiRoot, relPath), data)
        }
        files.push({ path: relPath, width, height, bytes: data.byteLength, role })
      }

      if (type === 'panorama') {
        for (const face of PANORAMA_FACES) {
          const facePrompt = `${basePrompt}. ${buildPanoramaFacePrompt(promptContext, face.index)}`
          prompts.push(facePrompt)
          const generated = await provider.generateImage(facePrompt, {
            width: PANORAMA_FACE_SIZE,
            height: PANORAMA_FACE_SIZE,
            model,
            seed: clampInt(args.seed, 0, 2_147_483_647, 1000 + face.index),
            ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
          })
          const png = await resizeToPng(generated.bytes, PANORAMA_FACE_SIZE, PANORAMA_FACE_SIZE)
          await emit(png, `${bgDirUnderPack}/${face.file}`, PANORAMA_FACE_SIZE, PANORAMA_FACE_SIZE, `panorama-${face.direction}`)
        }
        notes.push('6 面全景图已生成。若旋转时出现接缝，请检查各面是否为同一场景的连续视角，或改用 type="single"。')
      } else {
        const width = clampInt(args.width, 256, 4096, 1920)
        const height = clampInt(args.height, 256, 4096, 2160)
        const prompt = `${basePrompt}. ${buildBackgroundPrompt(promptContext, { wide: true })}`
        prompts.push(prompt)
        const generated = await provider.generateImage(prompt, {
          width,
          height,
          model,
          seed: clampInt(args.seed, 0, 2_147_483_647, 20261006),
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        })
        const png = await resizeToPng(generated.bytes, width, height)
        await emit(png, `${bgDirUnderPack}/background.png`, width, height, 'single-background')
        for (const face of PANORAMA_FACES) {
          await emit(png, `${bgDirUnderPack}/${face.file}`, width, height, `static-panorama-${face.direction}`)
        }
        notes.push('同一张图已写入 6 个 panorama 面 → 原版主菜单会显示为静止全景；同时保留了 background.png 供读取单张贴图的模组使用。')
        notes.push('若希望菜单有旋转视角，请改用 type="panorama"。')
      }

      let overlayFile = ''
      if (overlayWanted) {
        const baseColor = str(args.backgroundColor, shade(profile.palette.primary, 0.6))
        const overlayWidth = type === 'panorama' ? PANORAMA_FACE_SIZE : clampInt(args.width, 256, 4096, 1920)
        const overlayHeight = type === 'panorama' ? PANORAMA_FACE_SIZE : clampInt(args.height, 256, 4096, 1080)
        const overlay = gradientPng({
          width: overlayWidth,
          height: overlayHeight,
          topColor: '#000000',
          bottomColor: baseColor,
          topAlpha: 20,
          bottomAlpha: 210,
          smooth: true,
        })
        await emit(overlay, `${bgDirUnderPack}/panorama_overlay.png`, overlayWidth, overlayHeight, 'overlay')
        overlayFile = `${bgDirUnderPack}/panorama_overlay.png`
        notes.push('panorama_overlay.png 仅 1.20.2+ 的原版主菜单会叠加；更早版本不会读取，可忽略。')
      }

      const packFormat = renderPackMcmeta(minecraftVersion, `${packName} menu background`)
      if (!packFormat.note.includes('→')) notes.push(packFormat.note)
      if (writeToPack) {
        const mcmetaPath = join(packRoot, 'pack.mcmeta')
        if (!(await pathExists(mcmetaPath))) {
          await writeFileEnsured(mcmetaPath, packFormat.text)
        }
      }

      notes.push(`生图后端 ${providerId}（最小间隔 ${provider.minIntervalMs}ms）${provider.requiresKey ? '，需要 API Key' : '，免 Key'}`)

      return {
        ok: true,
        type,
        provider: providerId,
        model,
        packDir: writeToPack ? packRoot : uiRoot,
        namespace,
        files,
        overlayFile,
        prompts,
        notes,
        elapsedMs: Date.now() - started,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_gen_ui_textures',
    description:
      '用 AI 生成 UI 元素材质（button / icon / hud / container / tooltip），按元素类型自动套用尺寸与提示词模板，'
      + '生成后转 PNG、可选抠除纯色背景得到透明图标，并写入 assets/<ns>/textures/gui/sprites/<类型>/。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      elementType: { type: 'string', required: true, enum: ['button', 'icon', 'hud', 'container', 'tooltip'], description: '元素类型。' },
      prompt: { type: 'string', required: true, description: '生图提示词（可用 modpack_gen_ui_theme 输出的对应 prompt）。' },
      subject: { type: 'string', description: '具体题材，例如 "gear icon"、"energy bar"。' },
      theme: { type: 'string', description: '主题描述。' },
      style: { type: 'string', description: '风格关键词。' },
      names: { type: 'array', items: { type: 'string' }, description: '每个素材的文件名（不含扩展名），数量决定生成张数。' },
      count: { type: 'integer', description: '未指定 names 时生成几张，默认 1（上限 6，避免触发匿名限速）。' },
      width: { type: 'integer', description: '覆盖默认宽度。' },
      height: { type: 'integer', description: '覆盖默认高度。' },
      provider: { type: 'string', enum: ['pollinations', 'wanx', 'sdapi'], description: '生图后端，默认 pollinations。' },
      model: { type: 'string', description: '模型名。' },
      seed: { type: 'integer', description: '随机种子。' },
      namespace: { type: 'string', description: '资源包命名空间，默认 modpack-ui。' },
      packName: { type: 'string', description: '资源包目录名，默认 <namespace>-ui。' },
      transparent: { type: 'boolean', description: '是否做背景抠除得到透明 PNG，默认 true。' },
      keyColor: { type: 'string', description: '抠除的底色，默认 #FFFFFF。' },
      tolerance: { type: 'integer', description: '抠图容差 0-255，默认 32。' },
      minecraftVersion: { type: 'string', description: '目标游戏版本，默认 1.20.1。' },
      writeToPack: { type: 'boolean', description: '是否写入 resourcepacks，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          elementType: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                removedBackground: { type: 'boolean', required: true },
              },
            },
          },
          prompts: { type: 'array', required: true, items: { type: 'string' } },
          guideline: { type: 'string', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_gen_ui_textures(${value.elementType}) → ${value.files.length} 张 ${value.width}x${value.height} 贴图，耗时 ${(value.elapsedMs / 1000).toFixed(1)}s\n`
          + value.files.map((file) => `- ${file.path}${file.removedBackground ? '（已抠图）' : ''}`).join('\n')
          + `\n规范：${value.guideline}`,
      }],
    },
    timeoutMs: 20 * 60_000,
    async execute(args, exec) {
      const started = Date.now()
      const packDir = requireString(args.packDir, 'packDir')
      const elementType = str(args.elementType, 'icon') as UiElementType
      const spec = UI_ELEMENT_SPECS[elementType]
      if (spec === undefined) {
        throw new ModpackError('INVALID_ARGUMENT', `不支持的 elementType：${elementType}（可用：${Object.keys(UI_ELEMENT_SPECS).join(' / ')}）`)
      }
      const basePrompt = requireString(args.prompt, 'prompt')
      const namespace = slugify(str(args.namespace, 'modpack-ui'), 'modpack-ui')
      const packName = str(args.packName, `${namespace}-ui`)
      const minecraftVersion = str(args.minecraftVersion, '1.20.1')
      const providerId: ImageProviderId = resolveProviderId(str(args.provider))
      const provider = createImageProvider(providerId, {
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      const model = str(args.model, PROVIDER_CATALOG.find((item) => item.id === providerId)?.defaultModel ?? 'turbo')
      const width = clampInt(args.width, 8, 2048, spec.width)
      const height = clampInt(args.height, 8, 2048, spec.height)
      const transparent = args.transparent !== false
      const keyColor = str(args.keyColor, '#FFFFFF')
      const tolerance = clampInt(args.tolerance, 0, 255, 32)

      const names = asStringArray(args.names)
      const count = names.length > 0 ? names.length : clampInt(args.count, 1, 6, 1)
      const finalNames = names.length > 0
        ? names.map((name) => slugify(name, 'element'))
        : Array.from({ length: count }, (_unused, index) => `${elementType}-${index + 1}`)

      const theme = str(args.theme)
      const promptContext: PromptContext = {
        theme: theme === '' ? basePrompt : theme,
        style: str(args.style),
      }
      const prompt = `${basePrompt}. ${buildUiElementPrompt(promptContext, elementType, str(args.subject))}`
      const subDir = `${elementType}s`
      const relDir = ['assets', namespace, 'textures', 'gui', 'sprites', subDir].join('/')
      const packRoot = join(packDir, 'resourcepacks', packName)
      const uiRoot = join(packDir, 'ui')
      const writeToPack = args.writeToPack !== false
      const files: Array<{ path: string; width: number; height: number; bytes: number; removedBackground: boolean }> = []
      const notes: string[] = []

      for (let index = 0; index < finalNames.length; index++) {
        const name = finalNames[index]!
        const generated = await provider.generateImage(prompt, {
          width: Math.max(64, width),
          height: Math.max(64, height),
          model,
          seed: clampInt(args.seed, 0, 2_147_483_647, 4242 + index * 7),
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        })
        let png = await resizeToPng(generated.bytes, width, height)
        let removedBackground = false
        if (transparent) {
          try {
            png = await removeSolidBackground(png, { keyColor, tolerance })
            removedBackground = true
          } catch (error) {
            notes.push(`第 ${index + 1} 张抠图失败（${error instanceof Error ? error.message : String(error)}），已保留原图`)
          }
        }
        const relPath = `${relDir}/${name}.png`
        if (writeToPack) await writeFileEnsured(join(packRoot, relPath), png)
        await writeFileEnsured(join(uiRoot, relPath), png)
        files.push({ path: relPath, width, height, bytes: png.byteLength, removedBackground })
      }

      if (elementType === 'icon') {
        notes.push('图标尺寸极小（16x16），AI 直接生成会糊；建议先生成 512x512 再缩放到 16x16。')
      }
      if (elementType === 'button') {
        notes.push('原版按钮的 UV 布局是 200 宽 × 每态 20 高、垂直堆叠三态；AI 生成的图需要人工核对切图坐标，否则请配合 PackMenu 的 u/v/hoverU/hoverV 使用。')
      }
      const mcmeta = renderPackMcmeta(minecraftVersion, `${packName} ui textures`)
      if (writeToPack) {
        const mcmetaPath = join(packRoot, 'pack.mcmeta')
        if (!(await pathExists(mcmetaPath))) {
          await writeFileEnsured(mcmetaPath, mcmeta.text)
        }
      }

      return {
        ok: true,
        elementType,
        provider: providerId,
        width,
        height,
        files,
        prompts: [prompt],
        guideline: spec.guideline,
        notes,
        elapsedMs: Date.now() - started,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_assemble_ui_pack',
    description:
      '把纹理、PackMenu 按钮、Polytone GUI 修饰符、Vistas 全景清单、语言文件组装成完整界面材质包：'
      + '生成 pack.mcmeta（pack_format 按 MC 版本推导）、按规范目录写纹理、同步到 packmenu/resources/、'
      + '可选产出可分发 zip。所有纹理路径都会做资源包路径校验，写错会直接报错。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      packName: { type: 'string', required: true, description: '资源包名（目录 clientresourcepacks/<packName>）。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      namespace: { type: 'string', description: '命名空间，默认由 packName 派生。' },
      description: { type: 'string', description: 'pack.mcmeta 的描述文本。' },
      textures: {
        type: 'array',
        description: '纹理列表，每项 {path, sourceFile?|base64?, role?}；path 是资源包内路径，必须以 assets/ 开头。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            sourceFile: { type: 'string' },
            base64: { type: 'string' },
            role: { type: 'string' },
          },
        },
      },
      autoCollect: { type: 'boolean', description: '是否自动收集 <packDir>/ui/ 下已生成的纹理，默认 true。' },
      buttons: { type: 'array', description: 'PackMenu 按钮列表（字段见 modpack_gen_ui_theme 的 layout）。', items: { type: 'json' } },
      packMenu: { type: 'json', description: 'PackMenu 主菜单配置（写 config/packmenu.json）。' },
      modifiers: { type: 'array', description: 'Polytone GUI 修饰符列表。', items: { type: 'json' } },
      vistas: { type: 'array', description: 'Vistas 全景条目列表 {cubemapId, musicSound?, speedMultiplier?}。', items: { type: 'json' } },
      lang: { type: 'json', description: '额外语言条目（按钮文案会自动补齐）。' },
      locale: { type: 'string', description: '语言文件区域，默认 en_us。' },
      installToResourcePacks: { type: 'boolean', description: '是否写到 resourcepacks/，默认 true。' },
      alsoWritePackMenuFolder: { type: 'boolean', description: '是否同步到 packmenu/resources/，默认 true。' },
      zip: { type: 'boolean', description: '是否产出 zip，默认 false。' },
      zipPath: { type: 'string', description: 'zip 输出路径。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          resourcePackDir: { type: 'string', required: true },
          packMenuDir: { type: 'string', required: true },
          zipPath: { type: 'string', required: true },
          packFormat: { type: 'integer', required: true },
          packFormatNote: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          textureCount: { type: 'integer', required: true },
          buttonCount: { type: 'integer', required: true },
          modifierCount: { type: 'integer', required: true },
          langKeys: { type: 'integer', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_assemble_ui_pack → ${value.resourcePackDir}\n`
          + `pack_format=${value.packFormat}（${value.packFormatNote}）\n`
          + `纹理 ${value.textureCount} / 按钮 ${value.buttonCount} / Polytone ${value.modifierCount} / 语言键 ${value.langKeys}\n`
          + (value.zipPath !== '' ? `分发包：${value.zipPath}\n` : '')
          + (value.warnings.length > 0 ? value.warnings.slice(0, 6).map((item) => `⚠️ ${item}`).join('\n') : ''),
      }],
    },
    timeoutMs: 5 * 60_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const packName = requireString(args.packName, 'packName')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const autoCollect = args.autoCollect !== false

      const textures: UiTextureInput[] = await resolveTextureInputs(packDir, args.textures)
      if (autoCollect) {
        const collected = await collectUiTexturesFromDir(packDir)
        const known = new Set(textures.map((item) => item.path))
        for (const item of collected) {
          if (!known.has(item.path)) textures.push(item)
        }
      }

      const buttons = arr(args.buttons).map(toPackMenuButton)
      const modifiers = arr(args.modifiers).map(toPolytoneModifier)
      const vistas = arr(args.vistas).map(toVistasEntry)
      const langRecord = asRecord(args.lang)
      const lang: Record<string, string> = {}
      for (const [key, value] of Object.entries(langRecord)) {
        if (typeof value === 'string') lang[key] = value
      }

      const packMenuRaw = asRecord(args.packMenu)
      const packMenu: PackMenuConfig | undefined = Object.keys(packMenuRaw).length > 0
        ? {
            ...(packMenuRaw.drawTitle !== undefined ? { drawTitle: bool(packMenuRaw.drawTitle, true) } : {}),
            ...(packMenuRaw.drawSplash !== undefined ? { drawSplash: bool(packMenuRaw.drawSplash, true) } : {}),
            ...(packMenuRaw.drawForgeInfo !== undefined ? { drawForgeInfo: bool(packMenuRaw.drawForgeInfo, true) } : {}),
            ...(packMenuRaw.drawPanorama !== undefined ? { drawPanorama: bool(packMenuRaw.drawPanorama) } : {}),
            ...(packMenuRaw.panoramaFade !== undefined ? { panoramaFade: bool(packMenuRaw.panoramaFade) } : {}),
            ...(packMenuRaw.panoramaSpeed !== undefined ? { panoramaSpeed: num(packMenuRaw.panoramaSpeed, 1) } : {}),
            ...(packMenuRaw.panoramaVariations !== undefined ? { panoramaVariations: num(packMenuRaw.panoramaVariations, 1) } : {}),
            ...(packMenuRaw.folderPack !== undefined ? { folderPack: bool(packMenuRaw.folderPack, true) } : {}),
            ...(packMenuRaw.slideshowTextures !== undefined ? { slideshowTextures: asStringArray(packMenuRaw.slideshowTextures) } : {}),
            ...(packMenuRaw.slideshowDuration !== undefined ? { slideshowDuration: num(packMenuRaw.slideshowDuration, 200) } : {}),
            ...(packMenuRaw.slideshowTransition !== undefined ? { slideshowTransition: num(packMenuRaw.slideshowTransition, 20) } : {}),
            ...(packMenuRaw.slideshowRepeat !== undefined ? { slideshowRepeat: bool(packMenuRaw.slideshowRepeat, true) } : {}),
          }
        : undefined

      const result = await assembleUiPack({
        packDir,
        packName,
        minecraftVersion,
        ...(str(args.namespace) !== '' ? { namespace: str(args.namespace) } : {}),
        ...(str(args.description) !== '' ? { description: str(args.description) } : {}),
        textures,
        buttons,
        ...(packMenu !== undefined ? { packMenu } : {}),
        modifiers,
        vistas,
        lang,
        ...(str(args.locale) !== '' ? { locale: str(args.locale) } : {}),
        installToResourcePacks: args.installToResourcePacks !== false,
        alsoWritePackMenuFolder: args.alsoWritePackMenuFolder !== false,
        zip: args.zip === true,
        ...(str(args.zipPath) !== '' ? { zipPath: str(args.zipPath) } : {}),
      })

      if (textures.length === 0 && buttons.length === 0 && modifiers.length === 0) {
        result.warnings.push('既没有纹理也没有按钮/修饰符：资源包里只有 pack.mcmeta，游戏里看不到任何变化。')
      }

      return {
        ok: true,
        resourcePackDir: result.resourcePackDir,
        packMenuDir: result.packMenuDir ?? '',
        zipPath: result.zipPath ?? '',
        packFormat: result.packFormat,
        packFormatNote: result.packFormatNote,
        namespace: result.namespace,
        files: result.files,
        textureCount: result.textureCount,
        buttonCount: result.buttonCount,
        modifierCount: result.modifierCount,
        langKeys: result.langKeys,
        warnings: result.warnings,
        summary: [
          `资源包目录：${result.resourcePackDir}`,
          `pack_format：${result.packFormat}`,
          `纹理 ${result.textureCount} 张 / 按钮 ${result.buttonCount} 个 / Polytone ${result.modifierCount} 个`,
          result.zipPath !== null ? `分发包：${result.zipPath}` : '未生成 zip',
        ].join('\n'),
      }
    },
  }))
}

// ── 阶段五：本地化 ───────────────────────────────────────────────────────────

function registerI18nTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_scan_i18n',
    description:
      '扫描整合包里的待翻译字符串：资源包 lang 文件缺失的键、FTB Quests 章节文本、PackMenu 按钮语言键，'
      + '以及配置/README 里的硬编码中文（可选）。返回结构化条目与 markdown 报告。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      sourceLocale: { type: 'string', description: '源语言区域，默认 en_us。' },
      targetLocales: { type: 'array', items: { type: 'string' }, description: '目标语言列表，默认 ["zh_cn"]。' },
      includeQuests: { type: 'boolean', description: '是否扫描 FTB Quests 文本，默认 true。' },
      includeHardcoded: { type: 'boolean', description: '是否扫描配置/README 里的硬编码中文，默认 false。' },
      writeReport: { type: 'boolean', description: '是否把报告写到 <packDir>/i18n-report.md，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sourceLocale: { type: 'string', required: true },
          targetLocales: { type: 'array', required: true, items: { type: 'string' } },
          stats: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              scannedFiles: { type: 'integer', required: true },
              langKeys: { type: 'integer', required: true },
              missingKeys: { type: 'integer', required: true },
              questStrings: { type: 'integer', required: true },
              hardcodedStrings: { type: 'integer', required: true },
              entries: { type: 'integer', required: true },
            },
          },
          namespaces: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                namespace: { type: 'string', required: true },
                locale: { type: 'string', required: true },
                file: { type: 'string', required: true },
                keys: { type: 'integer', required: true },
                missingKeys: { type: 'integer', required: true },
              },
            },
          },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                text: { type: 'string', required: true },
                file: { type: 'string', required: true },
                kind: { type: 'string', required: true },
              },
            },
          },
          reportPath: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_scan_i18n → ${value.entries.length} 条待翻译（缺键 ${value.stats.missingKeys} / 任务文本 ${value.stats.questStrings} / 硬编码 ${value.stats.hardcodedStrings}）\n`
          + value.entries.slice(0, 10).map((entry) => `- [${entry.kind}] ${entry.key}${entry.text !== '' ? `：${entry.text.slice(0, 40)}` : ''}`).join('\n')
          + (value.reportPath !== '' ? `\n报告：${value.reportPath}` : ''),
      }],
    },
    timeoutMs: 3 * 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const targetLocales = asStringArray(args.targetLocales)
      const result = await scanI18n({
        packDir,
        ...(str(args.sourceLocale) !== '' ? { sourceLocale: str(args.sourceLocale) } : {}),
        ...(targetLocales.length > 0 ? { targetLocales } : {}),
        includeQuests: args.includeQuests !== false,
        includeHardcoded: args.includeHardcoded === true,
      })
      let reportPath = ''
      if (args.writeReport !== false) {
        const target = resolveInside(packDir, 'i18n-report.md')
        await writeFileEnsured(target, result.report)
        reportPath = target
      }
      return {
        ok: true,
        sourceLocale: result.sourceLocale,
        targetLocales: result.targetLocales,
        stats: { ...result.stats, entries: result.entries.length },
        namespaces: result.namespaces.map((ns) => ({
          namespace: ns.namespace,
          locale: ns.locale,
          file: ns.file,
          keys: ns.keys,
          missingKeys: ns.missingKeys.length,
        })),
        entries: result.entries.map((entry) => ({
          key: entry.key,
          text: entry.text,
          file: entry.file,
          kind: entry.kind,
        })),
        reportPath,
        report: result.report,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_translate',
    description:
      '批量翻译并打包为语言资源包：译文优先级为「显式 translations > dictionaries > 内置术语表」，'
      + '按 assets/<ns>/lang/<locale>.json 落盘并生成 pack.mcmeta（可选产出 zip）。'
      + '推荐由 Agent 自己翻译后通过 translations 传入，内置术语表只做兜底。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本（决定 pack_format）。' },
      targetLocales: { type: 'array', required: true, items: { type: 'string' }, description: '目标语言，例如 ["zh_cn"]。' },
      packName: { type: 'string', description: '资源包名，默认 i18n-pack。' },
      namespace: { type: 'string', description: '命名空间，默认由 packName 派生。' },
      translations: { type: 'json', description: '显式译文：{ "zh_cn": { "key": "译文" } }。' },
      dictionaries: { type: 'json', description: '自定义词典：{ "zh_cn": { "原文或键": "译文" } }。' },
      entries: {
        type: 'array',
        description: '待翻译条目；不给则自动扫描整合包内的待翻译文本。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { key: { type: 'string', required: true }, text: { type: 'string' } },
        },
      },
      useGlossary: { type: 'boolean', description: '是否用内置术语表兜底，默认 true。' },
      zip: { type: 'boolean', description: '是否产出 zip，默认 false。' },
      dryRun: { type: 'boolean', description: '只翻译不落盘。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          resourcePackDir: { type: 'string', required: true },
          zipPath: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          packFormat: { type: 'integer', required: true },
          perLocale: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                locale: { type: 'string', required: true },
                keys: { type: 'integer', required: true },
                fromInput: { type: 'integer', required: true },
                fromDictionary: { type: 'integer', required: true },
                fromGlossary: { type: 'integer', required: true },
                untranslated: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          notice: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_translate → ${value.resourcePackDir}${value.dryRun ? '（干跑）' : ''}\n`
          + value.perLocale.map((item) => `- ${item.locale}：${item.keys} 键（显式 ${item.fromInput} / 词典 ${item.fromDictionary} / 术语表 ${item.fromGlossary}），未翻译 ${item.untranslated.length}`).join('\n')
          + (value.zipPath !== '' ? `\n分发包：${value.zipPath}` : ''),
      }],
    },
    timeoutMs: 5 * 60_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const targetLocales = asStringArray(args.targetLocales)
      if (targetLocales.length === 0) throw new ModpackError('INVALID_ARGUMENT', 'targetLocales 不能为空')

      const translations: Record<string, Record<string, string>> = {}
      for (const [locale, value] of Object.entries(asRecord(args.translations))) {
        const inner: Record<string, string> = {}
        for (const [key, text] of Object.entries(asRecord(value))) {
          if (typeof text === 'string') inner[key] = text
        }
        translations[locale] = inner
      }
      const dictionaries: Record<string, Record<string, string>> = {}
      for (const [locale, value] of Object.entries(asRecord(args.dictionaries))) {
        const inner: Record<string, string> = {}
        for (const [key, text] of Object.entries(asRecord(value))) {
          if (typeof text === 'string') inner[key] = text
        }
        dictionaries[locale] = inner
      }
      const entries = arr(args.entries).map((item) => {
        const record = rec(item)
        return { key: requireString(record.key, 'entries[].key'), text: str(record.text) }
      })

      const result = await translateAndPackage({
        packDir,
        minecraftVersion,
        targetLocales,
        ...(str(args.packName) !== '' ? { packName: str(args.packName) } : {}),
        ...(str(args.namespace) !== '' ? { namespace: str(args.namespace) } : {}),
        translations,
        dictionaries,
        ...(entries.length > 0 ? { entries } : {}),
        useGlossary: args.useGlossary !== false,
        zip: args.zip === true,
        dryRun: args.dryRun === true,
      })

      const untranslatedTotal = result.perLocale.reduce((sum, item) => sum + item.untranslated.length, 0)
      const notice = untranslatedTotal > 0
        ? `有 ${untranslatedTotal} 个键没有拿到译文（useGlossary=false 时会这样）。建议由 Agent 直接翻译后通过 translations 传入。`
        : '全部键都有译文。提醒：机器翻译的游戏术语请人工抽查，尤其是按钮文案。'

      return {
        ok: true,
        dryRun: result.dryRun,
        resourcePackDir: result.resourcePackDir,
        zipPath: result.zipPath ?? '',
        files: result.files,
        packFormat: result.packFormat,
        perLocale: result.perLocale,
        notice,
      }
    },
  }))
}

// ── 阶段六：测试与验证 ───────────────────────────────────────────────────────

function registerTestingTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_validate',
    description:
      '校验整合包结构完整性：目录结构、模组文件（空壳/重复）、依赖是否齐、配置语法（JSON/TOML/SNBT）、'
      + '资源包 pack.mcmeta 与 zip 完整性、FTB Quests 章节 id 与依赖，以及敏感信息泄漏（token/key/凭据文件）。'
      + '返回结构化问题清单与 markdown 报告。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      expectedMods: {
        type: 'array',
        description: '期望存在的模组，每项 {slug, required?}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { slug: { type: 'string', required: true }, required: { type: 'boolean' } },
        },
      },
      requiredDependencies: {
        type: 'array',
        description: '必须存在的依赖，每项 {slug, requestedBy?}（可把 modpack_resolve_deps 的结果传进来）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { slug: { type: 'string', required: true }, requestedBy: { type: 'array', items: { type: 'string' } } },
        },
      },
      scanSecrets: { type: 'boolean', description: '是否扫描敏感信息，默认 true。' },
      deep: { type: 'boolean', description: '是否做资源包与任务书深度校验，默认 true。' },
      writeReport: { type: 'boolean', description: '是否把报告写到 <packDir>/validation-report.md，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          verdict: { type: 'string', required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                message: { type: 'string', required: true },
                file: { type: 'string', required: true },
                hint: { type: 'string', required: true },
              },
            },
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              mods: { type: 'integer', required: true },
              disabledMods: { type: 'integer', required: true },
              configFiles: { type: 'integer', required: true },
              resourcePacks: { type: 'integer', required: true },
              questChapters: { type: 'integer', required: true },
              quests: { type: 'integer', required: true },
              totalBytes: { type: 'integer', required: true },
              errors: { type: 'integer', required: true },
              warnings: { type: 'integer', required: true },
            },
          },
          reportPath: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_validate → ${value.verdict}（error ${value.stats.errors} / warning ${value.stats.warnings}）\n`
          + value.checks.map((check) => `- ${check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : '❌'} ${check.name}：${check.detail}`).join('\n')
          + (value.issues.length > 0
            ? `\n问题：\n` + value.issues.slice(0, 10).map((issue) => `- [${issue.severity}] ${issue.code}：${issue.message}`).join('\n')
            : ''),
      }],
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const expectedMods = arr(args.expectedMods).map((item) => {
        const record = rec(item)
        return {
          slug: requireString(record.slug, 'expectedMods[].slug'),
          ...(record.required !== undefined ? { required: bool(record.required, true) } : {}),
        }
      })
      const requiredDependencies = arr(args.requiredDependencies).map((item) => {
        const record = rec(item)
        return {
          slug: requireString(record.slug, 'requiredDependencies[].slug'),
          ...(record.requestedBy !== undefined ? { requestedBy: asStringArray(record.requestedBy) } : {}),
        }
      })

      const result = await validatePack({
        packDir,
        minecraftVersion,
        loader,
        expectedMods,
        requiredDependencies,
        scanSecrets: args.scanSecrets !== false,
        deep: args.deep !== false,
      })

      let reportPath = ''
      if (args.writeReport !== false) {
        const target = resolveInside(packDir, 'validation-report.md')
        await writeFileEnsured(target, result.report)
        reportPath = target
      }

      return {
        ok: result.ok,
        verdict: result.verdict,
        checks: result.checks.map((check) => ({ name: check.name, status: check.status, detail: check.detail })),
        issues: result.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          file: issue.file ?? '',
          hint: issue.hint ?? '',
        })),
        stats: {
          ...result.stats,
          errors: result.issues.filter((issue) => issue.severity === 'error').length,
          warnings: result.issues.filter((issue) => issue.severity === 'warning').length,
        },
        reportPath,
        report: result.report,
      }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_gen_test_plan',
    description:
      '生成整合包测试检查清单（markdown 表格）：环境与启动、主界面与 UI、游戏内功能、光影、性能、'
      + '服务端多人、发布前七大类，每条带编号、操作、期望结果与 blocker/major/minor 级别。',
    parameters: {
      packName: { type: 'string', required: true, description: '整合包名称。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      theme: { type: 'string', description: '主题，用于生成针对性的玩法检查项。' },
      features: { type: 'array', items: { type: 'string' }, description: '功能模块，例如 ["科技","任务书","光影","自定义主界面"]。' },
      modCount: { type: 'integer', description: '模组数量，用于估算启动耗时与内存。' },
      targetFps: { type: 'integer', description: '目标帧率下限，默认 60。' },
      serverSide: { type: 'boolean', description: '是否需要服务端检查项。' },
      memoryGb: { type: 'integer', description: '分配内存（GB）。' },
      packDir: { type: 'string', description: '给了就把清单写到 <packDir>/TEST-PLAN.md。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          estimatedMinutes: { type: 'integer', required: true },
          itemCount: { type: 'integer', required: true },
          filePath: { type: 'string', required: true },
          checklist: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                section: { type: 'string', required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      text: { type: 'string', required: true },
                      expected: { type: 'string', required: true },
                      severity: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_gen_test_plan → ${value.itemCount} 条检查项，预计 ${value.estimatedMinutes} 分钟\n`
          + value.checklist.map((section) => `- ${section.section}（${section.items.length} 项）`).join('\n')
          + (value.filePath !== '' ? `\n清单文件：${value.filePath}` : ''),
      }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const packName = requireString(args.packName, 'packName')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const plan = generateTestPlan({
        packName,
        minecraftVersion,
        loader,
        ...(str(args.theme) !== '' ? { theme: str(args.theme) } : {}),
        ...(asStringArray(args.features).length > 0 ? { features: asStringArray(args.features) } : {}),
        ...(args.modCount !== undefined ? { modCount: num(args.modCount, 100) } : {}),
        ...(args.targetFps !== undefined ? { targetFps: num(args.targetFps, 60) } : {}),
        serverSide: args.serverSide === true,
        ...(args.memoryGb !== undefined ? { memoryGb: num(args.memoryGb, 6) } : {}),
      })
      let filePath = ''
      const packDir = str(args.packDir)
      if (packDir !== '') {
        const target = resolveInside(packDir, 'TEST-PLAN.md')
        await writeFileEnsured(target, plan.markdown)
        filePath = target
      }
      const itemCount = plan.checklist.reduce((sum, section) => sum + section.items.length, 0)
      return {
        ok: true,
        estimatedMinutes: plan.estimatedMinutes,
        itemCount,
        filePath,
        checklist: plan.checklist,
        markdown: plan.markdown,
      }
    },
  }))
}

// ── 阶段七：打包与发布 ───────────────────────────────────────────────────────

function registerPublishTools(ctx: Context): void {
  registerTool(ctx, defineTool({
    name: 'modpack_export',
    description:
      '导出整合包为三种格式：mrpak（自包含清单 + 模组 + 覆盖目录 + CurseForge 兼容 manifest.json）、'
      + 'curseforge（manifest.json + overrides/）、manual（整包 zip，解压即用）。'
      + '输出体积、sha256 与包内条目清单。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      loaderVersion: { type: 'string', description: '加载器版本。' },
      name: { type: 'string', required: true, description: '整合包名称。' },
      version: { type: 'string', required: true, description: '版本号。' },
      formats: { type: 'array', required: true, items: { type: 'string', enum: ['mrpak', 'curseforge', 'manual'] }, description: '要导出的格式。' },
      outputDir: { type: 'string', description: '输出目录，默认 <packDir>/dist。' },
      authors: { type: 'array', items: { type: 'string' }, description: '作者列表。' },
      summary: { type: 'string', description: '一句话简介。' },
      description: { type: 'string', description: '详细描述。' },
      mods: {
        type: 'array',
        description: '模组清单（写进 mrpak.json / manifest.json），每项 {slug, projectId?, title?, versionId?, fileName?, url?, sha1?, required?}。',
        items: { type: 'json' },
      },
      include: { type: 'array', items: { type: 'string' }, description: '要打包的顶层目录（默认一整套实例目录）。' },
      exclude: { type: 'array', items: { type: 'string' }, description: '排除的顶层路径。' },
      curseforgeIds: { type: 'json', description: 'CurseForge 数字 id 映射：{ "<projectId或slug>": {"projectID":1,"fileID":2} }。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          outDir: { type: 'string', required: true },
          totalSize: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                format: { type: 'string', required: true },
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                sha256: { type: 'string', required: true },
                entryCount: { type: 'integer', required: true },
                notes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_export → ${value.results.length} 个产物，合计 ${(value.totalSize / 1024 / 1024).toFixed(1)} MB\n`
          + value.results.map((item) => `- [${item.format}] ${item.path}（${item.entryCount} 个条目，${(item.size / 1024 / 1024).toFixed(1)}MB，sha256 ${item.sha256.slice(0, 12)}…）`).join('\n')
          + value.results.flatMap((item) => item.notes).slice(0, 5).map((note) => `\n⚠️ ${note}`).join(''),
      }],
    },
    timeoutMs: 20 * 60_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const name = requireString(args.name, 'name')
      const version = requireString(args.version, 'version')
      const formats = asStringArray(args.formats)
      if (formats.length === 0) throw new ModpackError('INVALID_ARGUMENT', 'formats 不能为空')
      const outDir = str(args.outputDir) !== '' ? str(args.outputDir) : join(packDir, 'dist')
      await ensureDir(outDir)

      const mods: PackModEntry[] = arr(args.mods).map((item) => {
        const record = rec(item)
        const slug = str(record.slug, str(record.projectId, 'unknown'))
        const fileName = str(record.fileName, `${slug}.jar`)
        return {
          projectId: str(record.projectId, slug),
          slug,
          title: str(record.title, slug),
          versionId: str(record.versionId, 'unknown'),
          fileName,
          path: str(record.path, `mods/${fileName}`),
          sha1: str(record.sha1),
          sha256: str(record.sha256),
          size: num(record.size, 0),
          url: str(record.url),
          required: record.required === undefined ? true : bool(record.required, true),
        }
      })

      const curseforgeIds: Record<string, { projectID: number; fileID: number }> = {}
      for (const [key, value] of Object.entries(asRecord(args.curseforgeIds))) {
        const record = rec(value)
        if (record.projectID !== undefined && record.fileID !== undefined) {
          curseforgeIds[key] = { projectID: num(record.projectID, 0), fileID: num(record.fileID, 0) }
        }
      }

      const results: Array<{ format: string; path: string; size: number; sha256: string; entryCount: number; notes: string[] }> = []
      let totalSize = 0
      for (const format of formats) {
        if (format !== 'mrpak' && format !== 'curseforge' && format !== 'manual') {
          throw new ModpackError('INVALID_ARGUMENT', `不支持的导出格式：${format}（可用：mrpak / curseforge / manual）`)
        }
        const extension = format === 'mrpak' ? 'mrpak' : 'zip'
        const outFile = join(outDir, `${slugify(name, 'modpack')}-${version}-${format}.${extension}`)
        const result: PackExportResult = await exportPack(format, {
          packDir,
          outFile,
          name,
          version,
          authors: asStringArray(args.authors),
          summary: str(args.summary),
          description: str(args.description),
          minecraftVersion,
          loader,
          loaderVersion: str(args.loaderVersion) !== '' ? str(args.loaderVersion) : null,
          mods,
          ...(asStringArray(args.include).length > 0 ? { include: asStringArray(args.include) } : {}),
          ...(asStringArray(args.exclude).length > 0 ? { exclude: asStringArray(args.exclude) } : {}),
          curseforgeIds,
        })
        results.push({
          format: result.format,
          path: result.path,
          size: result.size,
          sha256: result.sha256,
          entryCount: result.entryCount,
          notes: result.notes,
        })
        totalSize += result.size
      }

      if (mods.length === 0) {
        results.push({
          format: 'note',
          path: '',
          size: 0,
          sha256: '',
          entryCount: 0,
          notes: ['未提供 mods 清单：mrpak.json / manifest.json 的模组条目为空，只靠实体 jar 发货。建议把 modpack_resolve_deps 的结果传给 mods。'],
        })
      }
      void DEFAULT_PACK_INCLUDE
      return { ok: true, outDir, totalSize, results }
    },
  }))

  registerTool(ctx, defineTool({
    name: 'modpack_publish',
    description:
      '生成多平台发布元数据：Modrinth 版本创建请求体、CurseForge 项目元数据、GitHub Release 元数据、'
      + '中文社区发布帖骨架、变更日志与 sha256 校验清单，并做发布前合规检查（含敏感信息扫描）。'
      + '不直接调用平台 API——产出可直接复制粘贴的内容与逐步操作清单。',
    parameters: {
      packDir: { type: 'string', required: true, description: '整合包根目录。' },
      name: { type: 'string', required: true, description: '整合包名称。' },
      version: { type: 'string', required: true, description: '版本号（semver，如 1.0.0）。' },
      minecraftVersion: { type: 'string', required: true, description: '目标游戏版本。' },
      loader: { type: 'string', required: true, enum: ['fabric', 'forge', 'neoforge', 'quilt'], description: '加载器。' },
      loaderVersion: { type: 'string', description: '加载器版本。' },
      authors: { type: 'array', items: { type: 'string' }, description: '作者列表。' },
      summary: { type: 'string', description: '一句话简介。' },
      description: { type: 'string', description: '详细描述。' },
      changes: { type: 'array', items: { type: 'string' }, description: '本次变更点，用于生成 changelog。' },
      knownIssues: { type: 'array', items: { type: 'string' }, description: '已知问题。' },
      license: { type: 'string', description: '许可证，例如 MIT / CC-BY-NC-SA-4.0。' },
      homepage: { type: 'string', description: '项目主页。' },
      sourceUrl: { type: 'string', description: '源码地址。' },
      platforms: { type: 'array', items: { type: 'string', enum: ['modrinth', 'curseforge', 'mcbbs', 'github', 'generic'] }, description: '目标平台。' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '要发布的产物文件路径。' },
      autoDetectArtifacts: { type: 'boolean', description: '未显式给 artifacts 时是否自动扫描 packDir 下的 .mrpak/.zip，默认 true。' },
      modrinthProjectId: { type: 'string', description: 'Modrinth 项目 id 或 slug（已建项目时填）。' },
      releaseType: { type: 'string', enum: ['release', 'beta', 'alpha'], description: '版本类型，默认 release。' },
      tags: { type: 'array', items: { type: 'string' }, description: '平台标签。' },
      runComplianceCheck: { type: 'boolean', description: '是否做发布前校验，默认 true。' },
      outDir: { type: 'string', description: '元数据输出目录，默认 <packDir>/publish。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          outDir: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          platforms: { type: 'array', required: true, items: { type: 'string' } },
          steps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                actions: { type: 'array', required: true, items: { type: 'string' } },
                blockers: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          compliance: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              checked: { type: 'boolean', required: true },
              verdict: { type: 'string', required: true },
              errors: { type: 'integer', required: true },
              warnings: { type: 'integer', required: true },
              notes: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          artifacts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                sha256: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `modpack_publish → ${value.outDir}（${value.files.length} 个元数据文件）\n`
          + `合规：${value.compliance.verdict}（error ${value.compliance.errors} / warning ${value.compliance.warnings}）\n`
          + value.artifacts.map((item) => `- ${item.path.split(/[\\/]/).pop()}（${(item.size / 1024 / 1024).toFixed(1)}MB）`).join('\n')
          + `\n目标平台：${value.platforms.join('、')}`,
      }],
    },
    timeoutMs: 10 * 60_000,
    async execute(args) {
      const packDir = requireString(args.packDir, 'packDir')
      const name = requireString(args.name, 'name')
      const version = requireString(args.version, 'version')
      const minecraftVersion = requireString(args.minecraftVersion, 'minecraftVersion')
      const loader = loaderOf(args.loader)
      const explicitArtifacts = asStringArray(args.artifacts)
      const artifacts = explicitArtifacts.length > 0
        ? explicitArtifacts
        : args.autoDetectArtifacts !== false
          ? await listPublishableArtifacts(packDir)
          : []
      if (artifacts.length === 0) {
        throw new ModpackError(
          'NO_ARTIFACTS',
          '没有可发布的产物：请先运行 modpack_export，或通过 artifacts 显式指定文件路径。',
        )
      }
      const platforms = asStringArray(args.platforms).filter(
        (item): item is PublishPlatform =>
          item === 'modrinth' || item === 'curseforge' || item === 'mcbbs' || item === 'github' || item === 'generic',
      )
      const result = await buildPublishMetadata({
        packDir,
        name,
        version,
        minecraftVersion,
        loader,
        ...(str(args.loaderVersion) !== '' ? { loaderVersion: str(args.loaderVersion) } : {}),
        authors: asStringArray(args.authors),
        ...(str(args.summary) !== '' ? { summary: str(args.summary) } : {}),
        ...(str(args.description) !== '' ? { description: str(args.description) } : {}),
        ...(asStringArray(args.changes).length > 0 ? { changes: asStringArray(args.changes) } : {}),
        ...(asStringArray(args.knownIssues).length > 0 ? { knownIssues: asStringArray(args.knownIssues) } : {}),
        ...(str(args.license) !== '' ? { license: str(args.license) } : {}),
        ...(str(args.homepage) !== '' ? { homepage: str(args.homepage) } : {}),
        ...(str(args.sourceUrl) !== '' ? { sourceUrl: str(args.sourceUrl) } : {}),
        artifacts,
        ...(platforms.length > 0 ? { platforms } : {}),
        ...(str(args.modrinthProjectId) !== '' ? { modrinthProjectId: str(args.modrinthProjectId) } : {}),
        ...(str(args.releaseType) !== '' ? { releaseType: str(args.releaseType) as 'release' | 'beta' | 'alpha' } : {}),
        ...(asStringArray(args.tags).length > 0 ? { tags: asStringArray(args.tags) } : {}),
        runComplianceCheck: args.runComplianceCheck !== false,
        ...(str(args.outDir) !== '' ? { outDir: str(args.outDir) } : {}),
      })

      const summary = renderPublishSummary(result, {
        packDir,
        name,
        version,
        minecraftVersion,
        loader,
        ...(str(args.license) !== '' ? { license: str(args.license) } : {}),
      })
      await writeFileEnsured(join(result.outDir, 'PUBLISH-README.md'), summary)

      const ok = result.compliance.errors === 0
      if (!ok) {
        result.compliance.notes.push('存在阻塞发布的 error，请先修复再上传平台。')
      }
      return {
        ok,
        outDir: result.outDir,
        files: [...result.files, 'PUBLISH-README.md'],
        platforms: result.platforms,
        steps: result.steps,
        compliance: result.compliance,
        artifacts: result.artifacts,
        summary,
      }
    },
  }))
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

/**
 * Cordis 插件入口。
 * `inject: ['tools']` 保证 tools 服务就绪后才 apply；注册的工具在插件卸载时由 Cordis 自动注销。
 */
export function apply(ctx: Context, _config?: unknown): void {
  registerPlanningTools(ctx)
  registerModTools(ctx)
  registerContentTools(ctx)
  registerUiTools(ctx)
  registerI18nTools(ctx)
  registerTestingTools(ctx)
  registerPublishTools(ctx)
}

/** 22 个工具名的权威清单（供自检与文档使用）。 */
export const TOOL_NAMES: readonly string[] = [
  'modpack_plan',
  'modpack_create',
  'modpack_setup_env',
  'modpack_search_mods',
  'modpack_add_mod',
  'modpack_resolve_deps',
  'modpack_check_conflicts',
  'modpack_add_optimization',
  'modpack_gen_config',
  'modpack_gen_quests',
  'modpack_add_resources',
  'modpack_gen_readme',
  'modpack_gen_ui_theme',
  'modpack_gen_menu_bg',
  'modpack_gen_ui_textures',
  'modpack_assemble_ui_pack',
  'modpack_scan_i18n',
  'modpack_translate',
  'modpack_validate',
  'modpack_gen_test_plan',
  'modpack_export',
  'modpack_publish',
]

/** Modrinth API 根地址（便于外部核对）。 */
export const MODRINTH_BASE_URL = MODRINTH_API_BASE

/** 供测试复用：术语表翻译器与未翻译提示。 */
export { GlossaryTranslator, renderUntranslatedNotice }
