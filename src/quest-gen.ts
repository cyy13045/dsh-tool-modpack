/**
 * dsh-tool-modpack — FTB Quests 任务书（SNBT）生成器。
 *
 * 纯文本生成 + 自研 SNBT 序列化器，不依赖任何 Minecraft/FTB 代码。
 * 生成的文件布局（FTB Quests 1.20.x）：
 *   config/ftbquests/quests/chapter_groups.snbt
 *   config/ftbquests/quests/chapters/<filename>.snbt
 *   config/ftbquests/quests/data.snbt
 *
 * 任务/章节 id 由内容确定性派生（sha1 → 16 位大写十六进制），
 * 因此重复生成同一份任务书是幂等的，不会打断玩家的已完成进度。
 *
 * @module dsh-tool-modpack/quest-gen
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ModpackError, clampInt, ensureDir, nowIso, pathExists, requireString, slugify, writeFileEnsured } from './util.js'

// ── SNBT 序列化 ──────────────────────────────────────────────────────────────

/** 原样输出的 SNBT 片段（用于 1.0d / 8L 这类带类型后缀的数字）。 */
export class SnbtRaw {
  constructor(readonly text: string) {}
}

/** 构造原样片段。 */
export function raw(text: string): SnbtRaw {
  return new SnbtRaw(text)
}

/** 双精度浮点（FTBQ 里坐标一律带 d 后缀）。 */
export function asDouble(value: number): SnbtRaw {
  const normalized = Number.isFinite(value) ? value : 0
  return new SnbtRaw(`${Number.isInteger(normalized) ? normalized.toFixed(1) : String(normalized)}d`)
}

/** 长整数（物品数量带 L 后缀）。 */
export function asLong(value: number): SnbtRaw {
  return new SnbtRaw(`${Math.trunc(Number.isFinite(value) ? value : 0)}L`)
}

/** SNBT 字符串转义（FTBQ 使用标准 Java 风格转义）。 */
export function snbtString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/

function snbtKey(key: string): string {
  return BARE_KEY.test(key) ? key : snbtString(key)
}

/**
 * 把 JSON 风格的值序列化为 SNBT。
 * @param indent 当前缩进层级（每层一个制表符，与 FTBQ 一致）
 */
export function snbtLiteral(value: unknown, indent = 0): string {
  const pad = '\t'.repeat(indent)
  const innerPad = '\t'.repeat(indent + 1)

  if (value === null || value === undefined) return '""'
  if (value instanceof SnbtRaw) return value.text
  if (typeof value === 'string') return snbtString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0'
    return Number.isInteger(value) ? String(value) : String(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const simple = value.every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item instanceof SnbtRaw,
    )
    if (simple && value.length <= 4) {
      return `[${value.map((item) => snbtLiteral(item, indent)).join(', ')}]`
    }
    const body = value.map((item) => `${innerPad}${snbtLiteral(item, indent + 1)}`).join('\n')
    return `[\n${body}\n${pad}]`
  }
  const record = value as Record<string, unknown>
  const entries = Object.entries(record).filter(([, item]) => item !== undefined)
  if (entries.length === 0) return '{}'
  const body = entries
    .map(([key, item]) => `${innerPad}${snbtKey(key)}: ${snbtLiteral(item, indent + 1)}`)
    .join('\n')
  return `{\n${body}\n${pad}}`
}

// ── id 派生 ──────────────────────────────────────────────────────────────────

/** 由种子确定性派生 16 位大写十六进制 id（FTBQ 的 id 形态）。 */
export function questId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 16).toUpperCase()
}

// ── 数据模型 ─────────────────────────────────────────────────────────────────

/** 任务类型。 */
export type QuestTaskType =
  | 'item'
  | 'item_tag'
  | 'advancement'
  | 'dimension'
  | 'stat'
  | 'kill'
  | 'xp'
  | 'observation'
  | 'checkmark'
  | 'stage'
  | 'biome'
  | 'structure'

/** 一个任务目标。 */
export interface QuestTask {
  type: QuestTaskType
  /** item / item_tag 用。 */
  item?: string
  tag?: string
  count?: number
  /** advancement / stage / biome / structure 用。 */
  id?: string
  /** dimension 用，例如 minecraft:the_nether。 */
  dimension?: string
  /** kill 用，实体 id。 */
  entity?: string
  /** stat 用：stat id 与目标值。 */
  stat?: string
  value?: number
  /** 界面标题（缺省由生成器推导）。 */
  title?: string
  /** 观察型任务（observation）的观察目标与范围。 */
  observe?: string
  range?: number
  /** stage 类型任务的阶段名。 */
  stage?: string
  /** 是否仅服务端判定。 */
  onlyFrom?: 'player' | 'server'
}

/** 奖励类型。 */
export type QuestRewardType = 'item' | 'xp' | 'xp_levels' | 'loot' | 'command' | 'choice' | 'random' | 'stage' | 'toast'

/** 一个奖励。 */
export interface QuestReward {
  type: QuestRewardType
  item?: string
  count?: number
  xp?: number
  levels?: number
  command?: string
  tableId?: string
  stage?: string
  title?: string
  /** toast 奖励的副标题。 */
  subtitle?: string
  /** command/random 的玩家执行权限。 */
  silent?: boolean
  /** choice 奖励里包裹的表项。 */
  entries?: QuestReward[]
}

/** 一个任务节点。 */
export interface QuestDraft {
  /** 不填则按 title + 坐标确定性派生。 */
  id?: string
  title: string
  subtitle?: string
  description?: string[]
  /** 图标，例如 minecraft:crafting_table。 */
  icon?: string
  x: number
  y: number
  size?: number
  shape?: 'circle' | 'square' | 'diamond' | 'hexagon' | 'pentagon' | 'rsquare' | 'gear'
  tasks: QuestTask[]
  rewards?: QuestReward[]
  /** 依赖的前置任务 id 列表。 */
  dependencies?: string[]
  optional?: boolean
  hidden?: boolean
  invisible?: boolean
  /** 是否隐藏任务连线上的依赖关系。 */
  hideDependencyLines?: boolean
  /** 是否禁止玩家手动领取奖励。 */
  disableRewardScreenBlur?: boolean
  tags?: string[]
}

/** 一个章节。 */
export interface ChapterDraft {
  id?: string
  /** 文件名（不含 .snbt），缺省由 title 派生。 */
  filename?: string
  title: string
  subtitle?: string
  /** 所属章节组标题；会在 chapter_groups.snbt 里自动建组。 */
  group?: string
  orderIndex?: number
  /** 章节图标。 */
  icon?: string
  /** 默认任务形状。 */
  defaultQuestShape?: string
  quests: QuestDraft[]
}

/** 任务书生成输入。 */
export interface QuestBookInput {
  packDir: string
  /** 任务书标题（写进 data.snbt 与章节组）。 */
  title: string
  chapters: ChapterDraft[]
  /** 是否自动串联同章节内相邻任务（按 x/y 推进顺序）。默认 false。 */
  autoChain?: boolean
  /** 自动串联时首个任务的额外依赖（通常留空）。 */
  chainFromQuestId?: string
  /** 是否覆盖已存在的章节文件（默认 true，配合确定性 id 安全）。 */
  overwrite?: boolean
  /** 只生成不落盘（干跑），用于预览文件清单与警告。 */
  dryRun?: boolean
}

/** 生成结果。 */
export interface QuestBookResult {
  files: string[]
  chapters: number
  quests: number
  tasks: number
  rewards: number
  chapterGroups: number
  /** 任务 id 一览（模型后续可用它写 dependencies）。 */
  questIndex: Array<{ id: string; chapter: string; title: string }>
  warnings: string[]
  createdAt: string
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

function normalizeItemId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new ModpackError('INVALID_ARGUMENT', '物品 id 不能为空')
  const withCount = trimmed.match(/^(.+?)\s*[x*]\s*(\d+)$/)
  if (withCount !== null) return withCount[1]!.trim()
  return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`
}

function parseStackCount(value: string): number | null {
  const match = value.trim().match(/^(.+?)\s*[x*]\s*(\d+)$/)
  return match === null ? null : Number.parseInt(match[2]!, 10)
}

function taskToSnbt(task: QuestTask, seed: string, index: number): Record<string, unknown> {
  const id = questId(`${seed}:task:${index}`)
  const base: Record<string, unknown> = { id, type: task.type }
  switch (task.type) {
    case 'item': {
      base.item = { id: normalizeItemId(task.item ?? '') }
      base.count = asLong(task.count ?? parseStackCount(task.item ?? '') ?? 1)
      break
    }
    case 'item_tag': {
      base.item = { tag: task.tag ?? 'minecraft:logs' }
      base.count = asLong(task.count ?? 1)
      break
    }
    case 'advancement':
      base.advancement = task.id ?? 'minecraft:story/root'
      break
    case 'dimension':
      base.dimension = task.dimension ?? task.id ?? 'minecraft:overworld'
      break
    case 'kill':
      base.entity = task.entity ?? task.id ?? 'minecraft:zombie'
      base.value = asLong(task.value ?? 1)
      break
    case 'xp':
      base.value = asLong(task.value ?? 1)
      break
    case 'stat':
      base.stat = task.stat ?? 'minecraft:custom:minecraft:play_time'
      base.value = asLong(task.value ?? 1)
      break
    case 'observation':
      base.observe_type = task.observe ?? 'minecraft:block'
      base.to_observe = { id: normalizeItemId(task.id ?? 'minecraft:crafting_table') }
      base.range = asDouble(task.range ?? 4)
      break
    case 'checkmark':
      break
    case 'stage':
      base.stage = task.stage ?? task.id ?? 'stage_1'
      break
    case 'biome':
      base.biome = task.id ?? 'minecraft:plains'
      break
    case 'structure':
      base.structure = task.id ?? 'minecraft:village_plains'
      break
    default:
      throw new ModpackError('UNSUPPORTED_TASK', `不支持的任务类型：${String(task.type)}`)
  }
  if (task.title !== undefined) base.title = task.title
  else base.title = defaultTaskTitle(task)
  if (task.onlyFrom === 'server') base.only_from = 'server'
  return base
}

function defaultTaskTitle(task: QuestTask): string {
  const item = task.item !== undefined ? normalizeItemId(task.item) : ''
  switch (task.type) {
    case 'item':
      return `获取 ${task.count ?? 1} 个 ${item}`
    case 'item_tag':
      return `获取 ${task.count ?? 1} 个 ${task.tag ?? ''}`
    case 'advancement':
      return `完成进度 ${task.id ?? ''}`
    case 'dimension':
      return `进入维度 ${task.dimension ?? task.id ?? ''}`
    case 'kill':
      return `击杀 ${task.value ?? 1} 个 ${task.entity ?? ''}`
    case 'xp':
      return `获得 ${task.value ?? 1} 点经验`
    case 'stat':
      return `达成统计 ${task.stat ?? ''} = ${task.value ?? 1}`
    case 'observation':
      return `观察 ${task.id ?? ''}`
    case 'checkmark':
      return '手动确认'
    case 'stage':
      return `解锁阶段 ${task.stage ?? task.id ?? ''}`
    case 'biome':
      return `抵达生物群系 ${task.id ?? ''}`
    case 'structure':
      return `发现结构 ${task.id ?? ''}`
    default:
      return '任务目标'
  }
}

function rewardToSnbt(reward: QuestReward, seed: string, index: number): Record<string, unknown> {
  const id = questId(`${seed}:reward:${index}`)
  const base: Record<string, unknown> = { id, type: reward.type }
  switch (reward.type) {
    case 'item':
      base.item = { id: normalizeItemId(reward.item ?? '') }
      base.count = asLong(reward.count ?? 1)
      break
    case 'xp':
      base.xp = Math.max(1, Math.trunc(reward.xp ?? 10))
      break
    case 'xp_levels':
      base.xp_levels = Math.max(1, Math.trunc(reward.levels ?? reward.xp ?? 5))
      break
    case 'loot':
      base.table_id = reward.tableId ?? seed
      break
    case 'command':
      base.command = reward.command ?? 'say 恭喜完成任务'
      base.silent = reward.silent === true
      break
    case 'stage':
      base.stage = reward.stage ?? 'stage_1'
      break
    case 'toast':
      base.title = reward.title ?? '已完成'
      base.description = reward.subtitle ?? ''
      break
    case 'choice':
    case 'random':
      base.table_id = questId(`${seed}:table:${index}`)
      base.entries = (reward.entries ?? []).map((entry, entryIndex) => ({
        ...rewardToSnbt({ ...entry, type: entry.type === 'choice' ? 'item' : entry.type }, `${seed}:entry`, entryIndex),
        weight: 1,
      }))
      break
    default:
      throw new ModpackError('UNSUPPORTED_REWARD', `不支持的奖励类型：${String(reward.type)}`)
  }
  if (reward.title !== undefined) base.title = reward.title
  return base
}

function questToSnbt(quest: QuestDraft, chapterSeed: string, index: number): Record<string, unknown> {
  const id = quest.id !== undefined && quest.id !== '' ? quest.id : questId(`${chapterSeed}:quest:${quest.title}:${quest.x}:${quest.y}`)
  const description = quest.description ?? []
  const body: Record<string, unknown> = {
    id,
    x: asDouble(quest.x),
    y: asDouble(quest.y),
    title: quest.title,
  }
  if (quest.subtitle !== undefined) body.subtitle = quest.subtitle
  body.description = description.length === 0 ? [''] : description
  if (quest.icon !== undefined) body.icon = { id: normalizeItemId(quest.icon) }
  body.tasks = quest.tasks.map((task, taskIndex) => taskToSnbt(task, `${chapterSeed}:${id}`, taskIndex))
  body.rewards = (quest.rewards ?? []).map((reward, rewardIndex) => rewardToSnbt(reward, `${chapterSeed}:${id}`, rewardIndex))
  body.dependencies = quest.dependencies ?? []
  if (quest.size !== undefined) body.size = asDouble(quest.size)
  if (quest.shape !== undefined) body.shape = quest.shape
  if (quest.optional === true) body.optional = true
  if (quest.hidden === true) body.hidden = true
  if (quest.invisible === true) body.invisible = true
  if (quest.hideDependencyLines === true) body.hide_dependency_lines = true
  if (quest.disableRewardScreenBlur === true) body.disable_reward_screen_blur = true
  if (quest.tags !== undefined && quest.tags.length > 0) body.tags = quest.tags
  body.can_repeat = false
  body.lock_text = ''
  return body
}

/** 渲染一个章节的 SNBT 文本。 */
export function renderChapterSnbt(chapter: ChapterDraft, groupId: string): string {
  const chapterSeed = questId(`chapter:${chapter.title}`)
  const filename = chapter.filename ?? slugify(chapter.title, 'chapter')
  const quests = chapter.quests
  const body: Record<string, unknown> = {
    id: chapter.id ?? questId(`chapter-id:${chapter.title}`),
    group: groupId,
    order_index: chapter.orderIndex ?? 0,
    filename,
    title: chapter.title,
  }
  if (chapter.subtitle !== undefined) body.subtitle = chapter.subtitle
  body.icon = { id: normalizeItemId(chapter.icon ?? 'minecraft:book') }
  body.default_quest_shape = chapter.defaultQuestShape ?? ''
  body.default_reward_shape = ''
  body.quest_links = []
  body.quests = quests.map((quest, index) => questToSnbt(quest, chapterSeed, index))
  return `${snbtLiteral(body)}\n`
}

/** 渲染 chapter_groups.snbt。 */
export function renderChapterGroupsSnbt(groups: Array<{ id: string; title: string }>): string {
  return `${snbtLiteral({ chapter_groups: groups.map((group) => ({ id: group.id, title: group.title })) })}\n`
}

/** 渲染 data.snbt。 */
export function renderDataSnbt(title: string): string {
  return `${snbtLiteral({
    version: 1,
    title,
    description: '',
    'default_quest_shape': '',
    'default_reward_shape': '',
    'disable_gui': false,
    'drop_items_on_death': false,
    'show_lock_icons': true,
  })}\n`
}

// ── 生成 ─────────────────────────────────────────────────────────────────────

function autoChainQuests(quests: QuestDraft[]): QuestDraft[] {
  const ordered = [...quests].sort((a, b) => a.y - b.y || a.x - b.x)
  return ordered.map((quest, index) => {
    if (index === 0) return quest
    const previous = ordered[index - 1]!
    const previousId = previous.id ?? questId(`${previous.title}:${previous.x}:${previous.y}`)
    const dependencies = [...(quest.dependencies ?? [])]
    if (!dependencies.includes(previousId)) dependencies.push(previousId)
    return { ...quest, dependencies }
  })
}

/**
 * 生成完整 FTB Quests 任务书到 packDir。
 * 写入 config/ftbquests/quests/ 下的章节、章节组与 data.snbt。
 */
export async function generateQuestBook(input: QuestBookInput): Promise<QuestBookResult> {
  const packDir = requireString(input.packDir, 'packDir')
  const title = requireString(input.title, 'title')
  if (input.chapters.length === 0) {
    throw new ModpackError('INVALID_ARGUMENT', '任务书至少需要一个章节')
  }
  const questsRoot = join(packDir, 'config', 'ftbquests', 'quests')
  const chaptersDir = join(questsRoot, 'chapters')
  const dryRun = input.dryRun === true
  const overwrite = input.overwrite !== false
  if (!dryRun) await ensureDir(chaptersDir)

  const warnings: string[] = []
  const files: string[] = []
  const questIndex: QuestBookResult['questIndex'] = []
  const groupIds = new Map<string, string>()
  let questCount = 0
  let taskCount = 0
  let rewardCount = 0

  const chapters = input.chapters.map((chapter, index) => {
    const groupTitle = chapter.group ?? ''
    if (groupTitle !== '' && !groupIds.has(groupTitle)) {
      groupIds.set(groupTitle, questId(`group:${groupTitle}`))
    }
    const quests = input.autoChain === true ? autoChainQuests(chapter.quests) : chapter.quests
    for (const quest of quests) {
      const id = quest.id ?? questId(`${questId(`chapter:${chapter.title}`)}:quest:${quest.title}:${quest.x}:${quest.y}`)
      questIndex.push({ id, chapter: chapter.title, title: quest.title })
      if (quest.tasks.length === 0) warnings.push(`任务「${quest.title}」没有任何目标（tasks 为空），运行时不可完成`)
    }
    return { ...chapter, orderIndex: chapter.orderIndex ?? index, quests }
  })

  for (const chapter of chapters) {
    const groupTitle = chapter.group ?? ''
    const groupId = groupTitle === '' ? '' : groupIds.get(groupTitle)!
    const filename = chapter.filename ?? slugify(chapter.title, `chapter_${chapter.orderIndex ?? 0}`)
    const text = renderChapterSnbt({ ...chapter, filename }, groupId)
    const absolute = join(chaptersDir, `${filename}.snbt`)
    if (!dryRun && (overwrite || !(await pathExists(absolute)))) {
      await writeFileEnsured(absolute, text)
    }
    files.push(`config/ftbquests/quests/chapters/${filename}.snbt`)
    questCount += chapter.quests.length
    for (const quest of chapter.quests) {
      taskCount += quest.tasks.length
      rewardCount += quest.rewards?.length ?? 0
    }
  }

  const groups = [...groupIds].map(([groupTitle, id]) => ({ id, title: groupTitle }))
  if (!dryRun) {
    await writeFileEnsured(join(questsRoot, 'chapter_groups.snbt'), renderChapterGroupsSnbt(groups))
  }
  files.push('config/ftbquests/quests/chapter_groups.snbt')
  if (!dryRun) {
    await writeFileEnsured(join(questsRoot, 'data.snbt'), renderDataSnbt(title))
  }
  files.push('config/ftbquests/quests/data.snbt')

  const seenIds = new Set<string>()
  for (const entry of questIndex) {
    if (seenIds.has(entry.id)) warnings.push(`任务 id 冲突：${entry.id}（来自「${entry.title}」），请显式指定 id`)
    seenIds.add(entry.id)
  }

  const knownIds = new Set(questIndex.map((entry) => entry.id))
  for (const chapter of chapters) {
    for (const quest of chapter.quests) {
      for (const dependency of quest.dependencies ?? []) {
        if (!knownIds.has(dependency)) {
          warnings.push(`任务「${quest.title}」依赖了不存在的任务 id：${dependency}`)
        }
      }
    }
  }

  return {
    files,
    chapters: chapters.length,
    quests: questCount,
    tasks: taskCount,
    rewards: rewardCount,
    chapterGroups: groups.length,
    questIndex,
    warnings,
    createdAt: nowIso(),
  }
}

/** 任务书章节草稿的最小校验（供测试与工具参数自检）。 */
export function validateChapterDraft(chapter: ChapterDraft): string[] {
  const problems: string[] = []
  if (typeof chapter.title !== 'string' || chapter.title.trim() === '') problems.push('章节缺少 title')
  if (!Array.isArray(chapter.quests) || chapter.quests.length === 0) problems.push(`章节「${chapter.title}」没有任何任务`)
  for (const quest of chapter.quests ?? []) {
    if (typeof quest.title !== 'string' || quest.title.trim() === '') problems.push('存在没有 title 的任务')
    if (!Array.isArray(quest.tasks) || quest.tasks.length === 0) problems.push(`任务「${quest.title}」缺少 tasks`)
    if (!Number.isFinite(quest.x) || !Number.isFinite(quest.y)) problems.push(`任务「${quest.title}」的 x/y 不是有限数字`)
  }
  return problems
}

/** 归一化坐标，避免任务重叠（同一格重复时向右平移）。 */
export function dedupeQuestPositions(quests: QuestDraft[], step = 2): QuestDraft[] {
  const occupied = new Set<string>()
  return quests.map((quest) => {
    let x = Math.trunc(quest.x)
    const y = Math.trunc(quest.y)
    while (occupied.has(`${x}:${y}`)) x += step
    occupied.add(`${x}:${y}`)
    return { ...quest, x, y }
  })
}

/** 依据任务规模给出建议的章节大小（供 UI/排版使用）。 */
export function suggestQuestSize(quest: QuestDraft): number {
  const complexity = quest.tasks.length + (quest.rewards?.length ?? 0) + (quest.dependencies?.length ?? 0)
  return clampInt(1 + complexity * 0.25, 1, 3, 1)
}
