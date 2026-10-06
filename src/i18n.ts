/**
 * dsh-tool-modpack — 本地化模块。
 *
 * 两件事：
 *  1. scanI18n：扫描整合包内"待翻译字符串"——资源包 lang 文件缺键、FTB Quests 章节
 *     文本、PackMenu 按钮 key、README/配置里的硬编码中文。
 *  2. translateAndPackage：把译文批量落成语言文件并打包成一个语言资源包。
 *
 * 翻译来源三层（都可离线）：
 *   - Agent 直接给出的 translations（模型自己翻译，最准）
 *   - 内置术语表 GlossaryTranslator（Minecraft/整合包常用词，确定性、可测）
 *   - 自定义词典（用户提供）
 *
 * @module dsh-tool-modpack/i18n
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeZip, type ZipEntry } from './packer.js'
import { renderPackMcmeta } from './ui-pack.js'
import {
  ModpackError,
  asRecord,
  ensureDir,
  nowIso,
  pathExists,
  readJsonSafe,
  readTextSafe,
  slugify,
  toPosix,
  writeFileEnsured,
} from './util.js'

// ── 扫描 ─────────────────────────────────────────────────────────────────────

/** 待翻译条目的来源类型。 */
export type I18nEntryKind = 'lang' | 'quest' | 'packmenu' | 'markdown' | 'config'

/** 一条待翻译字符串。 */
export interface I18nEntry {
  /** 语言键（lang 文件用 key；其他来源用合成 key）。 */
  key: string
  /** 原文。 */
  text: string
  /** 相对 packDir 的源文件。 */
  file: string
  kind: I18nEntryKind
  /** 该键在目标语言里是否已有译文。 */
  translated: boolean
}

/** 一个语言文件的扫描结果。 */
export interface I18nNamespaceReport {
  namespace: string
  locale: string
  file: string
  keys: number
  missingKeys: string[]
}

/** 扫描参数。 */
export interface I18nScanInput {
  packDir: string
  /** 源语言（默认 en_us）。 */
  sourceLocale?: string
  /** 目标语言列表（默认 ['zh_cn']）。 */
  targetLocales?: string[]
  /** 是否扫描 FTB Quests 章节文本。 */
  includeQuests?: boolean
  /** 是否扫描 README / 配置里的硬编码中文。 */
  includeHardcoded?: boolean
}

/** 扫描结果。 */
export interface I18nScanResult {
  sourceLocale: string
  targetLocales: string[]
  namespaces: I18nNamespaceReport[]
  /** 需要翻译的条目（按 file 排序）。 */
  entries: I18nEntry[]
  stats: {
    scannedFiles: number
    langKeys: number
    missingKeys: number
    questStrings: number
    hardcodedStrings: number
  }
  /** 人类可读的 markdown 报告。 */
  report: string
  createdAt: string
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 判断是否含中文。 */
export function containsCjk(text: string): boolean {
  return CJK_RE.test(text)
}

async function listFilesRecursive(root: string, predicate: (rel: string, name: string) => boolean): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'logs', 'saves', 'screenshots'].includes(entry.name)) continue
        await walk(absolute)
        continue
      }
      const rel = toPosix(absolute.slice(root.length + 1))
      if (predicate(rel, entry.name)) out.push(rel)
    }
  }
  await walk(root)
  return out.sort((a, b) => a.localeCompare(b))
}

/** 从 SNBT 文本里抽取 title / subtitle / description 字段的字符串。 */
export function extractSnbtStrings(text: string): string[] {
  const out: string[] = []
  const fieldRe = /(?:title|subtitle|description)\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/g
  let match: RegExpExecArray | null
  while ((match = fieldRe.exec(text)) !== null) {
    const raw = match[1] ?? ''
    if (raw.startsWith('[')) {
      const itemRe = /"(?:[^"\\]|\\.)*"/g
      let item: RegExpExecArray | null
      while ((item = itemRe.exec(raw)) !== null) {
        const value = unescapeSnbt(item[0].slice(1, -1))
        if (value.trim() !== '') out.push(value)
      }
    } else {
      const value = unescapeSnbt(raw.slice(1, -1))
      if (value.trim() !== '') out.push(value)
    }
  }
  return out
}

function unescapeSnbt(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/**
 * 扫描待翻译内容。
 */
export async function scanI18n(input: I18nScanInput): Promise<I18nScanResult> {
  const packDir = input.packDir
  if (!(await pathExists(packDir))) {
    throw new ModpackError('NOT_FOUND', `整合包目录不存在：${packDir}`)
  }
  const sourceLocale = input.sourceLocale ?? 'en_us'
  const targetLocales = input.targetLocales ?? ['zh_cn']
  const entries: I18nEntry[] = []
  const namespaces: I18nNamespaceReport[] = []
  let scannedFiles = 0
  let langKeys = 0
  let missingKeys = 0
  let questStrings = 0
  let hardcodedStrings = 0

  // 1. 资源包 lang 文件
  const langFiles = await listFilesRecursive(packDir, (rel, name) =>
    name.endsWith('.json') && rel.includes('/lang/') && rel.startsWith('resourcepacks/'),
  )
  const byPath = new Map<string, Record<string, string>>()
  for (const rel of langFiles) {
    scannedFiles += 1
    const parsed = await readJsonSafe(join(packDir, rel), {})
    const record = asRecord(parsed)
    const flat: Record<string, string> = {}
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') flat[key] = value
    }
    byPath.set(rel, flat)
    const match = /\/([^/]+)\/lang\/([^/]+)\.json$/.exec(rel)
    const namespace = match?.[1] ?? 'unknown'
    const locale = match?.[2] ?? basename(rel, '.json')
    if (locale === sourceLocale) langKeys += Object.keys(flat).length
    namespaces.push({ namespace, locale, file: rel, keys: Object.keys(flat).length, missingKeys: [] })
  }

  // 源语言作为基准，检查目标语言缺哪些键
  const sourceFiles = [...byPath].filter(([rel]) => rel.includes(`/lang/${sourceLocale}.json`))
  for (const target of targetLocales) {
    for (const [rel, flat] of sourceFiles) {
      const targetRel = rel.replace(`/lang/${sourceLocale}.json`, `/lang/${target}.json`)
      const targetFlat = byPath.get(targetRel) ?? {}
      const missing = Object.keys(flat).filter((key) => targetFlat[key] === undefined)
      missingKeys += missing.length
      const report = namespaces.find((item) => item.file === targetRel)
      if (report !== undefined) report.missingKeys = missing
      for (const key of missing) {
        entries.push({
          key,
          text: flat[key] ?? '',
          file: rel,
          kind: 'lang',
          translated: false,
        })
      }
    }
  }

  // 2. FTB Quests 章节文本
  if (input.includeQuests !== false) {
    const questFiles = await listFilesRecursive(
      packDir,
      (rel, name) => name.endsWith('.snbt') && rel.startsWith('config/ftbquests/'),
    )
    for (const rel of questFiles) {
      scannedFiles += 1
      const text = await readTextSafe(join(packDir, rel), '')
      if (text === null) continue
      const strings = extractSnbtStrings(text)
      questStrings += strings.length
      if (strings.length > 0 && sourceLocale.startsWith('en')) {
        const chinese = strings.filter((value) => containsCjk(value))
        for (let index = 0; index < chinese.length; index++) {
          entries.push({
            key: `${rel}#${index}`,
            text: chinese[index]!,
            file: rel,
            kind: 'quest',
            translated: false,
          })
        }
      }
    }
  }

  // 3. PackMenu 按钮 key 对应的默认文案
  const buttonFiles = await listFilesRecursive(
    packDir,
    (rel, name) => name.endsWith('.json') && rel.includes('/buttons/'),
  )
  for (const rel of buttonFiles) {
    scannedFiles += 1
    const parsed = asRecord(await readJsonSafe(join(packDir, rel), {}))
    const langKey = typeof parsed.langKey === 'string' ? parsed.langKey : ''
    if (langKey !== '') {
      entries.push({ key: langKey, text: '', file: rel, kind: 'packmenu', translated: false })
    }
  }

  // 4. README / 配置里的硬编码中文
  if (input.includeHardcoded === true) {
    const textFiles = await listFilesRecursive(
      packDir,
      (rel, name) =>
        (name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.json') || name.endsWith('.properties')) &&
        !rel.includes('/lang/'),
    )
    for (const rel of textFiles.slice(0, 200)) {
      scannedFiles += 1
      const text = await readTextSafe(join(packDir, rel), '')
      if (text === null) continue
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length >= 4 && containsCjk(trimmed) && !trimmed.startsWith('//')) {
          hardcodedStrings += 1
          entries.push({
            key: `${rel}:${hardcodedStrings}`,
            text: trimmed.slice(0, 240),
            file: rel,
            kind: rel.endsWith('.md') ? 'markdown' : 'config',
            translated: false,
          })
        }
      }
    }
  }

  const report = renderScanReport({
    packDir,
    sourceLocale,
    targetLocales,
    namespaces,
    entries,
    stats: { scannedFiles, langKeys, missingKeys, questStrings, hardcodedStrings },
  })

  return {
    sourceLocale,
    targetLocales,
    namespaces,
    entries,
    stats: { scannedFiles, langKeys, missingKeys, questStrings, hardcodedStrings },
    report,
    createdAt: nowIso(),
  }
}

function renderScanReport(input: {
  packDir: string
  sourceLocale: string
  targetLocales: string[]
  namespaces: I18nNamespaceReport[]
  entries: I18nEntry[]
  stats: I18nScanResult['stats']
}): string {
  const lines: string[] = []
  lines.push(`# 本地化扫描报告`)
  lines.push('')
  lines.push(`- 整合包目录：${input.packDir}`)
  lines.push(`- 源语言：${input.sourceLocale}`)
  lines.push(`- 目标语言：${input.targetLocales.join(', ')}`)
  lines.push(`- 扫描文件数：${input.stats.scannedFiles}`)
  lines.push(`- lang 键总数（源语言）：${input.stats.langKeys}`)
  lines.push(`- 缺失译文键数：${input.stats.missingKeys}`)
  lines.push(`- FTB Quests 文本条数：${input.stats.questStrings}`)
  lines.push(`- 硬编码中文行数：${input.stats.hardcodedStrings}`)
  lines.push('')
  if (input.namespaces.length > 0) {
    lines.push('## 命名空间')
    for (const ns of input.namespaces) {
      lines.push(`- ${ns.namespace} / ${ns.locale}：${ns.keys} 键，缺 ${ns.missingKeys.length} 条（${ns.file}）`)
    }
    lines.push('')
  }
  const byKind = new Map<I18nEntryKind, number>()
  for (const entry of input.entries) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1)
  if (byKind.size > 0) {
    lines.push('## 待翻译条目分布')
    for (const [kind, count] of byKind) lines.push(`- ${kind}：${count}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ── 术语表翻译 ───────────────────────────────────────────────────────────────

/** 翻译提供者。 */
export interface TranslationProvider {
  readonly id: string
  translate(items: Array<{ key: string; text: string }>, targetLocale: string): Promise<Map<string, string>>
}

/** Minecraft / 整合包常用术语表（en → zh_cn）。 */
export const GLOSSARY_EN_ZH: Readonly<Record<string, string>> = {
  'singleplayer': '单人游戏',
  'multiplayer': '多人游戏',
  'options': '选项',
  'quit game': '退出游戏',
  'quit': '退出',
  'mods': '模组',
  'resource packs': '资源包',
  'shader packs': '光影包',
  'language': '语言',
  'accessibility': '辅助功能',
  'reload': '重载',
  'continue': '继续',
  'back': '返回',
  'play': '开始游戏',
  'start': '开始',
  'settings': '设置',
  'world': '世界',
  'worlds': '世界',
  'inventory': '物品栏',
  'crafting': '合成',
  'smelting': '熔炼',
  'quest': '任务',
  'quests': '任务',
  'chapter': '章节',
  'chapters': '章节',
  'reward': '奖励',
  'rewards': '奖励',
  'task': '目标',
  'tasks': '目标',
  'item': '物品',
  'items': '物品',
  'block': '方块',
  'blocks': '方块',
  'machine': '机器',
  'machines': '机器',
  'energy': '能量',
  'power': '电力',
  'storage': '存储',
  'automation': '自动化',
  'technology': '科技',
  'magic': '魔法',
  'exploration': '探索',
  'dimension': '维度',
  'nether': '下界',
  'the end': '末地',
  'overworld': '主世界',
  'biome': '生物群系',
  'mob': '生物',
  'boss': 'Boss',
  'progress': '进度',
  'tutorial': '教程',
  'getting started': '开始游戏',
  'guide': '指南',
  'performance': '性能',
  'optimization': '优化',
  'keybind': '按键绑定',
  'controls': '操作',
  'difficulty': '难度',
  'generating': '生成中',
  'loading': '加载中',
  'save and quit': '保存并退出',
}

/** 术语翻译器：按"长词优先"替换，保护占位符。 */
export class GlossaryTranslator implements TranslationProvider {
  readonly id = 'glossary'
  private readonly glossary: Record<string, string>

  constructor(extra?: Record<string, string>, private readonly targetLocale = 'zh_cn') {
    this.glossary = { ...GLOSSARY_EN_ZH, ...(extra ?? {}) }
  }

  async translate(items: Array<{ key: string; text: string }>, targetLocale: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const item of items) {
      out.set(item.key, this.translateOne(item.text, item.key))
    }
    void targetLocale
    return out
  }

  /** 单词条翻译：整句命中 → 用术语表；否则做词级替换。 */
  translateOne(text: string, key?: string): string {
    if (text === '') {
      // 没有原文时用 key 的末段做可读占位
      const tail = (key ?? '').split('.').pop() ?? ''
      const pretty = tail.split(/[_-]/).join(' ')
      const hit = this.glossary[pretty.toLowerCase()]
      return hit ?? titleCase(pretty)
    }
    const exact = this.glossary[text.trim().toLowerCase()]
    if (exact !== undefined) return exact

    const { masked, restore } = maskPlaceholders(text)
    const keys = Object.keys(this.glossary).sort((a, b) => b.length - a.length)
    let result = masked
    for (const key2 of keys) {
      const re = new RegExp(`\\b${escapeRegExp(key2)}\\b`, 'gi')
      result = result.replace(re, this.glossary[key2]!)
    }
    return restore(result)
  }
}

function titleCase(text: string): string {
  return text
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把 %s / {0} / %1$s / ${x} 这类占位符换成不可翻译的哨兵。 */
export function maskPlaceholders(text: string): { masked: string; restore: (value: string) => string } {
  const holders: string[] = []
  const masked = text.replace(/%\d+\$[sd]|%[sd]|\{\d+\}|\$\{[^}]+\}/g, (match) => {
    holders.push(match)
    return `\u0000${holders.length - 1}\u0000`
  })
  return {
    masked,
    restore: (value: string) => value.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => holders[Number(index)] ?? ''),
  }
}

/** 自定义词典提供者。 */
export class DictionaryTranslator implements TranslationProvider {
  readonly id = 'dictionary'

  constructor(private readonly dictionaries: Record<string, Record<string, string>>) {}

  async translate(items: Array<{ key: string; text: string }>, targetLocale: string): Promise<Map<string, string>> {
    const dict = this.dictionaries[targetLocale] ?? {}
    const out = new Map<string, string>()
    for (const item of items) {
      const hit = dict[item.key] ?? dict[item.text]
      if (hit !== undefined) out.set(item.key, hit)
    }
    return out
  }
}

// ── 译文应用与打包 ───────────────────────────────────────────────────────────

/** 翻译输入。 */
export interface TranslateInput {
  packDir: string
  /** 资源包名（产出目录 resourcepacks/<packName>）。 */
  packName?: string
  /** 命名空间（lang 文件路径）。 */
  namespace?: string
  minecraftVersion: string
  targetLocales: string[]
  /** Agent / 用户直接给出的译文：locale → (key → 译文)。 */
  translations?: Record<string, Record<string, string>>
  /** 要翻译的条目；缺省时自动扫描。 */
  entries?: Array<{ key: string; text: string }>
  /** 是否用内置术语表兜底翻译缺失项（默认 true）。 */
  useGlossary?: boolean
  /** 追加的自定义词典：locale → (原文/键 → 译文)。 */
  dictionaries?: Record<string, Record<string, string>>
  /** 语言文件覆盖的命名空间列表（缺省用 namespace）。 */
  alsoWriteNamespaces?: string[]
  /** 是否同时产出 zip。 */
  zip?: boolean
  /** 是否只回传译文而不落盘（干跑）。 */
  dryRun?: boolean
}

/** 翻译结果。 */
export interface TranslateResult {
  resourcePackDir: string
  zipPath: string | null
  files: string[]
  perLocale: Array<{ locale: string; keys: number; fromInput: number; fromDictionary: number; fromGlossary: number; untranslated: string[] }>
  packFormat: number
  dryRun: boolean
  createdAt: string
}

/**
 * 批量翻译并打包为语言资源包。
 * 译文优先级：显式 translations > dictionaries > 内置术语表。
 */
export async function translateAndPackage(input: TranslateInput): Promise<TranslateResult> {
  if (input.targetLocales.length === 0) {
    throw new ModpackError('INVALID_ARGUMENT', 'targetLocales 不能为空')
  }
  const sourceEntries =
    input.entries ??
    (await scanI18n({ packDir: input.packDir, targetLocales: input.targetLocales })).entries.map((entry) => ({
      key: entry.key,
      text: entry.text,
    }))
  if (sourceEntries.length === 0) {
    throw new ModpackError(
      'NOTHING_TO_TRANSLATE',
      '没有扫描到待翻译条目：请先在资源包里放置源语言 lang 文件，或直接通过 entries 提供待翻译文本。',
    )
  }

  const packName = input.packName ?? 'i18n-pack'
  const namespace = input.namespace ?? slugify(packName, 'i18n-pack')
  const resourcePackDir = join(input.packDir, 'resourcepacks', packName)
  const dryRun = input.dryRun === true
  const files: string[] = []
  const perLocale: TranslateResult['perLocale'] = []
  const glossary = new GlossaryTranslator(undefined, input.targetLocales[0] ?? 'zh_cn')
  const dictionary = new DictionaryTranslator(input.dictionaries ?? {})

  if (!dryRun) {
    await ensureDir(resourcePackDir)
    const mcmeta = renderPackMcmeta(input.minecraftVersion, `${packName} — 本地化资源包`)
    await writeFileEnsured(join(resourcePackDir, 'pack.mcmeta'), mcmeta.text)
    files.push('pack.mcmeta')
  }

  let lastPackFormat = 0
  for (const locale of input.targetLocales) {
    const explicit = input.translations?.[locale] ?? {}
    const dictResult = await dictionary.translate(sourceEntries, locale)
    const langEntries: Record<string, string> = {}
    const untranslated: string[] = []
    let fromInput = 0
    let fromDictionary = 0
    let fromGlossary = 0

    for (const entry of sourceEntries) {
      if (explicit[entry.key] !== undefined) {
        langEntries[entry.key] = explicit[entry.key]!
        fromInput += 1
        continue
      }
      const dictHit = dictResult.get(entry.key)
      if (dictHit !== undefined) {
        langEntries[entry.key] = dictHit
        fromDictionary += 1
        continue
      }
      if (input.useGlossary !== false) {
        langEntries[entry.key] = glossary.translateOne(entry.text, entry.key)
        fromGlossary += 1
        continue
      }
      untranslated.push(entry.key)
    }

    const namespaces = [namespace, ...(input.alsoWriteNamespaces ?? [])]
    for (const ns of namespaces) {
      const rel = `assets/${ns}/lang/${locale}.json`
      if (!dryRun) {
        await writeFileEnsured(join(resourcePackDir, rel), `${JSON.stringify(langEntries, null, 2)}\n`)
        files.push(rel)
      }
    }
    perLocale.push({
      locale,
      keys: Object.keys(langEntries).length,
      fromInput,
      fromDictionary,
      fromGlossary,
      untranslated,
    })
  }

  const mcmeta = renderPackMcmeta(input.minecraftVersion, `${packName} — 本地化资源包`)
  lastPackFormat = mcmeta.packFormat

  let zipPath: string | null = null
  if (input.zip === true && !dryRun) {
    const entries: ZipEntry[] = []
    for (const file of files) {
      const absolute = join(resourcePackDir, file)
      if (await pathExists(absolute)) {
        entries.push({ path: file, data: new Uint8Array(await readFile(absolute)) })
      }
    }
    zipPath = join(input.packDir, 'resourcepacks', `${packName}.zip`)
    await writeZip(zipPath, entries)
  }

  return {
    resourcePackDir,
    zipPath,
    files,
    perLocale,
    packFormat: lastPackFormat,
    dryRun,
    createdAt: nowIso(),
  }
}

/** 合并两份语言文件（后者覆盖前者），返回新对象。 */
export function mergeLangFiles(base: Record<string, string>, patch: Record<string, string>): Record<string, string> {
  return { ...base, ...patch }
}

/** 读取某个资源包语言文件。 */
export async function readLangFile(packDir: string, relPath: string): Promise<Record<string, string>> {
  const parsed = asRecord(await readJsonSafe(join(packDir, relPath), {}))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** 生成"未翻译键"提示（写进 README 或交给模型）。 */
export function renderUntranslatedNotice(locale: string, keys: string[]): string {
  if (keys.length === 0) return `[${locale}] 全部键均已翻译。\n`
  const lines = [`[${locale}] 以下 ${keys.length} 个键缺少译文，请补齐：`, ...keys.slice(0, 200).map((key) => `- ${key}`)]
  if (keys.length > 200) lines.push(`- …还有 ${keys.length - 200} 条`)
  return `${lines.join('\n')}\n`
}

/** 语言文件路径（供外部工具复用）。 */
export function langFilePath(namespace: string, locale: string): string {
  return `assets/${namespace}/lang/${locale}.json`
}

/** 语言文件的父目录（打包用）。 */
export function langDirOf(namespace: string): string {
  return dirname(`assets/${namespace}/lang/x.json`)
}
