/**
 * dsh-tool-modpack — 模组配置覆盖生成器。
 *
 * 支持四种目标格式：JSON / TOML / PROPERTIES / SNBT。
 * 对已存在的文件默认做"深合并"（对象逐层合并，数组整体替换），并先备份原文件，
 * 因此反复调用是幂等的，不会把用户的既有配置冲掉。
 *
 * @module dsh-tool-modpack/config-gen
 */

import { basename, dirname, join } from 'node:path'
import { snbtLiteral } from './quest-gen.js'
import {
  ModpackError,
  asRecord,
  ensureDir,
  nowIso,
  pathExists,
  readJsonSafe,
  readTextSafe,
  writeFileEnsured,
} from './util.js'

/** 支持的配置文件格式。 */
export type ConfigFormat = 'json' | 'toml' | 'properties' | 'snbt'

/** 一个待生成的配置文件。 */
export interface ConfigFileSpec {
  /** 相对 packDir 的路径，必须落在 config/、defaultconfigs/ 或根级白名单内。 */
  path: string
  format: ConfigFormat
  /** 内容：结构化对象，或（当 format 为 properties/snbt 时）原始文本。 */
  content: Record<string, unknown> | string
  /** 与既有文件深合并（对象类型），默认 true。 */
  merge?: boolean
}

/** 写入结果。 */
export interface ConfigWriteResult {
  path: string
  absolutePath: string
  format: ConfigFormat
  action: 'created' | 'updated' | 'unchanged'
  bytes: number
  /** 备份文件路径（更新时生成）。 */
  backup: string | null
  merged: boolean
}

/** 路径白名单：允许写配置的顶层目录。 */
export const CONFIG_PATH_WHITELIST = [
  'config',
  'defaultconfigs',
  'local',
  'options.txt',
  'server.properties',
  'packmenu',
  'polytone',
]

function assertConfigPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized === '' || normalized.includes('..') || normalized.startsWith('/')) {
    throw new ModpackError('INVALID_PATH', `非法配置路径：${relPath}`)
  }
  const top = normalized.includes('/') ? normalized.slice(0, normalized.indexOf('/')) : normalized
  if (!CONFIG_PATH_WHITELIST.includes(top)) {
    throw new ModpackError(
      'INVALID_PATH',
      `配置只能写到 ${CONFIG_PATH_WHITELIST.join(' / ')} 之下，收到：${relPath}`,
    )
  }
  return normalized
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (value === null || value === undefined) return '""'
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  return JSON.stringify(value)
}

/** 渲染 TOML 文本（对象 → [table]，标量在前、子表在后，保证可解析）。 */
export function renderToml(value: Record<string, unknown>, path: string[] = []): string {
  const lines: string[] = []
  const scalars: Array<[string, unknown]> = []
  const tables: Array<[string, Record<string, unknown>]> = []
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      tables.push([key, item as Record<string, unknown>])
    } else {
      scalars.push([key, item])
    }
  }
  if (path.length > 0) lines.push(`[${path.map(tomlKey).join('.')}]`)
  for (const [key, item] of scalars) lines.push(`${tomlKey(key)} = ${tomlValue(item)}`)
  for (const [key, item] of tables) {
    const body = renderToml(item, [...path, key])
    if (body.trim() !== '') {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      lines.push(body.replace(/\n+$/, ''))
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** 渲染 PROPERTIES 文本（嵌套对象用点号平铺）。 */
export function renderProperties(value: Record<string, unknown>, prefix = ''): string {
  const lines: string[] = []
  for (const [key, item] of Object.entries(value)) {
    const full = prefix === '' ? key : `${prefix}.${key}`
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      lines.push(renderProperties(item as Record<string, unknown>, full).replace(/\n$/, ''))
    } else if (Array.isArray(item)) {
      lines.push(`${full}=${item.join(',')}`)
    } else {
      lines.push(`${full}=${item === null || item === undefined ? '' : String(item)}`)
    }
  }
  return `${lines.filter((line) => line !== '').join('\n')}\n`
}

/** 解析简单的 a=b 文本（供合并用）。 */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return out
}

/** 渲染某种格式的配置文本。 */
export function renderConfig(format: ConfigFormat, content: Record<string, unknown> | string): string {
  if (typeof content === 'string') return content.endsWith('\n') ? content : `${content}\n`
  switch (format) {
    case 'json':
      return `${JSON.stringify(content, null, 2)}\n`
    case 'toml':
      return renderToml(content)
    case 'properties':
      return renderProperties(content)
    case 'snbt':
      return `${snbtLiteral(content)}\n`
    default:
      throw new ModpackError('UNSUPPORTED_FORMAT', `不支持的配置格式：${String(format)}`)
  }
}

/** 深合并：对象递归合并，数组与非对象整体替换。 */
export function deepMergeObject(base: unknown, patch: unknown): Record<string, unknown> {
  const left = asRecord(base)
  const right = asRecord(patch)
  const out: Record<string, unknown> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const existing = left[key]
    if (
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMergeObject(existing, value)
    } else {
      out[key] = value
    }
  }
  return out
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

/** 写一个配置文件（可选深合并 + 备份）。 */
export async function writeConfigFile(packDir: string, spec: ConfigFileSpec): Promise<ConfigWriteResult> {
  const relPath = assertConfigPath(spec.path)
  const absolutePath = join(packDir, relPath)
  const merge = spec.merge !== false
  const exists = await pathExists(absolutePath)

  let finalContent = spec.content
  let merged = false

  if (exists && merge && spec.format === 'json' && typeof spec.content !== 'string') {
    const existing = await readJsonSafe(absolutePath, {})
    if (asRecord(existing) !== undefined && typeof existing === 'object' && existing !== null) {
      finalContent = deepMergeObject(existing, spec.content)
      merged = true
    }
  } else if (exists && merge && spec.format === 'properties') {
    const existingText = await readTextSafe(absolutePath, '')
    if (existingText !== null && existingText.trim() !== '') {
      const flatExisting = parseProperties(existingText)
      const flatPatch = typeof spec.content === 'string' ? parseProperties(spec.content) : flatten(spec.content)
      const mergedFlat = { ...flatExisting, ...flatPatch }
      finalContent = Object.entries(mergedFlat)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
      merged = true
    }
  } else if (exists && merge && typeof spec.content === 'string') {
    const existingText = await readTextSafe(absolutePath, '')
    if (existingText !== null && existingText.includes(spec.content.trim())) {
      return {
        path: relPath,
        absolutePath,
        format: spec.format,
        action: 'unchanged',
        bytes: Buffer.byteLength(existingText, 'utf8'),
        backup: null,
        merged: false,
      }
    }
  }

  const text = renderConfig(spec.format, finalContent)
  await ensureDir(dirname(absolutePath))

  let backup: string | null = null
  if (exists) {
    const previous = await readTextSafe(absolutePath, '')
    if (previous !== null) {
      backup = `${absolutePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      await writeFileEnsured(backup, previous)
    }
  }

  const current = await readTextSafe(absolutePath, null)
  if (current === text) {
    return {
      path: relPath,
      absolutePath,
      format: spec.format,
      action: 'unchanged',
      bytes: Buffer.byteLength(text, 'utf8'),
      backup: null,
      merged,
    }
  }

  await writeFileEnsured(absolutePath, text)
  return {
    path: relPath,
    absolutePath,
    format: spec.format,
    action: exists ? 'updated' : 'created',
    bytes: Buffer.byteLength(text, 'utf8'),
    backup,
    merged,
  }
}

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    const full = prefix === '' ? key : `${prefix}.${key}`
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      Object.assign(out, flatten(item as Record<string, unknown>, full))
    } else {
      out[full] = Array.isArray(item) ? item.join(',') : String(item)
    }
  }
  return out
}

/** 批量写入配置文件。 */
export async function writeConfigFiles(packDir: string, specs: ConfigFileSpec[]): Promise<ConfigWriteResult[]> {
  const results: ConfigWriteResult[] = []
  for (const spec of specs) results.push(await writeConfigFile(packDir, spec))
  return results
}

// ── 模板 ─────────────────────────────────────────────────────────────────────

/** 原版 options.txt 的常用键（键名来自原版 ClientOptions，可直接生效）。 */
export interface ClientOptionsInput {
  language?: string
  guiScale?: number
  renderDistance?: number
  simulationDistance?: number
  maxFps?: number
  fov?: number
  gamma?: number
  enableVsync?: boolean
  pauseOnLostFocus?: boolean
  autoJump?: boolean
  particles?: 'all' | 'decreased' | 'minimal'
  graphicsMode?: number
  soundCategoryMaster?: number
  musicVolume?: number
}

const PARTICLES_CODE: Record<string, string> = { all: '0', decreased: '1', minimal: '2' }

/** 生成 options.txt 文本。 */
export function renderClientOptions(input: ClientOptionsInput): string {
  const lines: string[] = []
  const push = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined) return
    lines.push(`${key}:${typeof value === 'boolean' ? String(value) : value}`)
  }
  push('version', 3955)
  push('lang', input.language ?? 'zh_cn')
  push('guiScale', input.guiScale ?? 3)
  push('renderDistance', input.renderDistance ?? 10)
  push('simulationDistance', input.simulationDistance ?? 8)
  push('maxFps', input.maxFps ?? 144)
  push('fov', input.fov ?? 0.0)
  push('gamma', input.gamma ?? 0.5)
  push('enableVsync', input.enableVsync ?? false)
  push('pauseOnLostFocus', input.pauseOnLostFocus ?? false)
  push('autoJump', input.autoJump ?? false)
  push('particles', PARTICLES_CODE[input.particles ?? 'decreased'] ?? '1')
  push('graphicsMode', input.graphicsMode ?? 1)
  push('soundCategory_master', input.soundCategoryMaster ?? 1.0)
  push('soundCategory_music', input.musicVolume ?? 0.6)
  return `${lines.join('\n')}\n`
}

/** 生成 server.properties 文本（键名来自原版专用服务器）。 */
export function renderServerProperties(input: Record<string, unknown>): string {
  const defaults: Record<string, unknown> = {
    'level-name': 'world',
    'gamemode': 'survival',
    difficulty: 'normal',
    'allow-cheats': false,
    'max-players': 20,
    'online-mode': true,
    'view-distance': 10,
    'simulation-distance': 8,
    'motd': 'A Minecraft Server',
    'enable-command-block': false,
    'spawn-protection': 16,
    'sync-chunk-writes': false,
  }
  const merged = { ...defaults, ...input }
  return `${Object.entries(merged)
    .map(([key, value]) => `${key}=${value === null || value === undefined ? '' : String(value)}`)
    .join('\n')}\n`
}

/**
 * 已知模组的配置文件路径表（只给"路径建议"，不伪造内容）。
 * 模型应当按需要往这些路径写覆盖。
 */
export const KNOWN_CONFIG_PATHS: Readonly<Record<string, { path: string; format: ConfigFormat; note: string }>> = {
  sodium: { path: 'config/sodium-options.json', format: 'json', note: 'Sodium 渲染设置（Fabric/NeoForge 通用）' },
  embeddium: { path: 'config/embeddium-options.json', format: 'json', note: 'Embeddium（Forge 系 Sodium 分支）' },
  iris: { path: 'config/iris.properties', format: 'properties', note: 'Iris 光影加载器' },
  oculus: { path: 'config/oculus.properties', format: 'properties', note: 'Oculus（Forge 系 Iris 分支）' },
  jei: { path: 'config/jei/jei-client.ini', format: 'properties', note: 'JEI 客户端设置（ini 语法，按 properties 近似处理）' },
  rei: { path: 'config/roughlyenoughitems/config.json5', format: 'json', note: 'REI 设置（json5，写 JSON 亦可被读取）' },
  emi: { path: 'config/emi.css', format: 'properties', note: 'EMI 主题（实际为 CSS 片段，谨慎覆盖）' },
  jade: { path: 'config/jade/jade.json', format: 'json', note: 'Jade 信息提示' },
  kubejs: { path: 'kubejs/config/common.properties', format: 'properties', note: 'KubeJS 通用配置' },
  'ftb-quests': { path: 'config/ftbquests/quests/chapters/chapter_1.snbt', format: 'snbt', note: 'FTB Quests 章节（建议用 modpack_gen_quests 生成）' },
  'fancy-menu': { path: 'config/fancymenu/customization/*.txt', format: 'properties', note: 'FancyMenu 自定义文件，路径带通配，需按需指定' },
  packmenu: { path: 'config/packmenu.json', format: 'json', note: 'PackMenu 主菜单配置（Forge，占位符见 ui-pack 说明）' },
  'server-properties': { path: 'server.properties', format: 'properties', note: '服务端核心设置' },
  'options-txt': { path: 'options.txt', format: 'properties', note: '客户端选项（冒号分隔，用 renderClientOptions 生成更稳）' },
}

/** 配置规划输入。 */
export interface ConfigPlanInput {
  packDir: string
  /** 主题描述，用于生成建议（不直接改写未知模组的键）。 */
  theme?: string
  minecraftVersion: string
  loader: string
  /** 显式指定要写入的配置文件。 */
  files?: ConfigFileSpec[]
  /** 客户端选项覆盖（生成 options.txt）。 */
  clientOptions?: ClientOptionsInput
  /** 服务端设置覆盖（生成 server.properties）。 */
  serverProperties?: Record<string, unknown>
  /** 想要预置配置的模组 id 列表（只产出路径建议 + 空模板，不伪造键）。 */
  modIds?: string[]
}

/** 配置规划结果。 */
export interface ConfigPlanResult {
  specs: ConfigFileSpec[]
  /** 路径建议（模组 id → 目标配置文件），供模型参考。 */
  suggestions: Array<{ modId: string; path: string; format: ConfigFormat; note: string }>
  /** 未知的新增模组（没有官方路径记录）。 */
  unknownModIds: string[]
  planNote: string
  createdAt: string
}

/**
 * 根据输入规划要写哪些配置文件。
 * 只对"键名可确证"的 options.txt / server.properties 做内容生成，
 * 其余模组配置一律请模型显式给出 content，避免伪造不存在的键。
 */
export function planConfigOverrides(input: ConfigPlanInput): ConfigPlanResult {
  const specs: ConfigFileSpec[] = []
  const suggestions: ConfigPlanResult['suggestions'] = []
  const unknownModIds: string[] = []
  const createdAt = nowIso()

  if (input.clientOptions !== undefined) {
    specs.push({ path: 'options.txt', format: 'properties', content: renderClientOptions(input.clientOptions), merge: false })
  }
  if (input.serverProperties !== undefined) {
    specs.push({ path: 'server.properties', format: 'properties', content: renderServerProperties(input.serverProperties), merge: true })
  }
  for (const modId of input.modIds ?? []) {
    const key = modId.trim().toLowerCase()
    const known = KNOWN_CONFIG_PATHS[key]
    if (known === undefined) {
      unknownModIds.push(modId)
      continue
    }
    suggestions.push({ modId, path: known.path, format: known.format, note: known.note })
  }
  for (const file of input.files ?? []) specs.push(file)

  const planNote =
    specs.length === 0
      ? '没有需要写入的配置文件：请通过 files 显式给出内容，或打开 clientOptions / serverProperties。'
      : `计划写入 ${specs.length} 个配置文件；未知模组 ${unknownModIds.length} 个，已给出建议路径但未生成内容。`

  return { specs, suggestions, unknownModIds, planNote, createdAt }
}

/** 便捷函数：先生成计划再落盘。 */
export async function applyConfigPlan(
  plan: ConfigPlanResult,
  packDir: string,
): Promise<ConfigWriteResult[]> {
  return writeConfigFiles(packDir, plan.specs)
}

/** 读回某个配置文件（用于验证）。 */
export async function readConfigFile(packDir: string, relPath: string): Promise<string | null> {
  return readTextSafe(join(packDir, assertConfigPath(relPath)), null)
}

/** 备份文件命名（对外的可读形式）。 */
export function backupNameFor(file: string): string {
  return `${basename(file)}.bak`
}
