/**
 * dsh-tool-modpack — 测试与验证模块。
 *
 * validatePack：对整合包目录做结构与内容校验（模组、依赖、配置语法、资源包、
 * 任务书、启动器配置、敏感文件泄漏）。
 * generateTestPlan：产出可执行的测试检查清单（供人类或 Agent 逐条过）。
 *
 * 所有校验都返回"结构化问题列表 + markdown 报告"，不抛异常（除了目录不存在）。
 *
 * @module dsh-tool-modpack/tester
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readZip } from './packer.js'
import { renderPackMcmeta } from './ui-pack.js'
import {
  ModpackError,
  asRecord,
  nowIso,
  pathExists,
  readJsonSafe,
  readTextSafe,
  toPosix,
} from './util.js'

/** 问题严重级别。 */
export type IssueSeverity = 'error' | 'warning' | 'info'

/** 一条校验问题。 */
export interface ValidationIssue {
  code: string
  severity: IssueSeverity
  message: string
  /** 相关文件（相对 packDir）。 */
  file: string | null
  /** 修复建议。 */
  hint: string | null
}

/** 单项检查结果。 */
export interface ValidationCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

/** 校验输入。 */
export interface ValidatePackInput {
  packDir: string
  minecraftVersion: string
  loader: string
  /** 期望存在的模组（projectId/slug），用于核对依赖清单。 */
  expectedMods?: Array<{ slug: string; projectId?: string; required?: boolean }>
  /** 期望存在的依赖（projectId → 被谁需要）。 */
  requiredDependencies?: Array<{ slug: string; requestedBy?: string[] }>
  /** 是否校验敏感信息泄漏（默认 true）。 */
  scanSecrets?: boolean
  /** 是否校验资源包与任务书（默认 true）。 */
  deep?: boolean
}

/** 校验结果。 */
export interface ValidatePackResult {
  ok: boolean
  verdict: 'ok' | 'warning' | 'broken'
  checks: ValidationCheck[]
  issues: ValidationIssue[]
  stats: {
    mods: number
    disabledMods: number
    configFiles: number
    resourcePacks: number
    questChapters: number
    quests: number
    totalBytes: number
  }
  report: string
  createdAt: string
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Bearer 头', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'AWS Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: '疑似凭据文件', re: /(?:apikey|api_key|token|password|secret)\s*[:=]\s*["'][^"']{8,}["']/i },
]

const SECRET_FILE_NAMES = ['.secrets.env', '.npmrc', 'credentials.json', '.github-auth.json', 'id_rsa', '.env']

async function walk(root: string, options: { maxDepth?: number } = {}): Promise<string[]> {
  const out: string[] = []
  const maxDepth = options.maxDepth ?? 12
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1)
      } else if (entry.isFile()) {
        out.push(toPosix(absolute.slice(root.length + 1)))
      }
    }
  }
  await visit(root, 0)
  return out.sort((a, b) => a.localeCompare(b))
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

/** 检查 JSON 文本是否可解析。 */
export function isValidJson(text: string): { ok: boolean; reason: string } {
  try {
    JSON.parse(text)
    return { ok: true, reason: 'ok' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 检查 SNBT 文本的括号是否配平（含引号转义处理）。 */
export function isBalancedSnbt(text: string): { ok: boolean; reason: string } {
  let depthBrace = 0
  let depthBracket = 0
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depthBrace += 1
    else if (char === '}') depthBrace -= 1
    else if (char === '[') depthBracket += 1
    else if (char === ']') depthBracket -= 1
    if (depthBrace < 0 || depthBracket < 0) return { ok: false, reason: '出现多余的闭合括号' }
  }
  if (inString) return { ok: false, reason: '字符串引号未闭合' }
  if (depthBrace !== 0) return { ok: false, reason: `花括号不配平（差 ${depthBrace}）` }
  if (depthBracket !== 0) return { ok: false, reason: `方括号不配平（差 ${depthBracket}）` }
  return { ok: true, reason: 'ok' }
}

/** 检查 TOML 是否能通过"键值行 + 表头"的粗校验。 */
export function isPlausibleToml(text: string): { ok: boolean; reason: string } {
  const balance = isBalancedSnbt(text.replace(/^\s*\[[^\]]+\]\s*$/gm, ''))
  if (!balance.ok) return balance
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) continue
    if (!line.includes('=')) return { ok: false, reason: `非法行（缺少 =）：${line.slice(0, 60)}` }
  }
  return { ok: true, reason: 'ok' }
}

/** 校验整合包。 */
export async function validatePack(input: ValidatePackInput): Promise<ValidatePackResult> {
  const packDir = input.packDir
  if (!(await pathExists(packDir))) {
    throw new ModpackError('NOT_FOUND', `整合包目录不存在：${packDir}`)
  }
  const issues: ValidationIssue[] = []
  const checks: ValidationCheck[] = []
  const deep = input.deep !== false
  const scanSecrets = input.scanSecrets !== false
  const files = await walk(packDir)

  // 1. 目录结构
  const hasMods = await pathExists(join(packDir, 'mods'))
  const hasConfig = await pathExists(join(packDir, 'config'))
  checks.push({
    name: '目录结构',
    status: hasMods ? 'pass' : 'fail',
    detail: hasMods ? `mods/ 存在${hasConfig ? '，config/ 存在' : '，但缺少 config/'}` : '缺少 mods/ 目录',
  })
  if (!hasMods) {
    issues.push({
      code: 'MISSING_MODS_DIR',
      severity: 'error',
      message: '整合包根目录没有 mods/',
      file: null,
      hint: '先调用 modpack_create 创建目录结构，或用 modpack_add_mod 添加模组。',
    })
  }

  // 2. 模组文件
  const modFiles = files.filter((file) => file.startsWith('mods/') && (file.endsWith('.jar') || file.endsWith('.jar.disabled')))
  const disabled = modFiles.filter((file) => file.endsWith('.disabled'))
  const enabled = modFiles.filter((file) => file.endsWith('.jar'))
  const emptyMods: string[] = []
  const modBaseNames = new Map<string, string[]>()
  for (const file of enabled) {
    if ((await sizeOf(join(packDir, file))) < 1024) emptyMods.push(file)
    const key = normalizedModName(basename(file, '.jar'))
    const list = modBaseNames.get(key) ?? []
    list.push(file)
    modBaseNames.set(key, list)
  }
  for (const [key, list] of modBaseNames) {
    if (list.length > 1) {
      issues.push({
        code: 'DUPLICATE_MOD',
        severity: 'error',
        message: `疑似重复模组（同名去版本后一致）：${list.join('、')}`,
        file: list[0] ?? null,
        hint: `只保留一个版本，删除其余后重新解析依赖（归一化名：${key}）。`,
      })
    }
  }
  for (const file of emptyMods) {
    issues.push({
      code: 'EMPTY_MOD_FILE',
      severity: 'error',
      message: `模组文件小于 1KB，多半是下载失败留下的空壳：${file}`,
      file,
      hint: '删除该文件并重新用 modpack_add_mod 下载。',
    })
  }
  checks.push({
    name: '模组文件',
    status: enabled.length === 0 ? 'fail' : emptyMods.length > 0 ? 'warn' : 'pass',
    detail: `启用 ${enabled.length} 个，禁用 ${disabled.length} 个${emptyMods.length > 0 ? `，异常 ${emptyMods.length} 个` : ''}`,
  })
  if (enabled.length === 0) {
    issues.push({
      code: 'NO_MODS',
      severity: 'warning',
      message: 'mods/ 下没有任何启用的 .jar 模组',
      file: null,
      hint: '这是一个空整合包，先执行 modpack_search_mods + modpack_add_mod。',
    })
  }

  // 3. 依赖核对
  if (input.requiredDependencies !== undefined && input.requiredDependencies.length > 0) {
    const present = new Set(enabled.map((file) => normalizedModName(basename(file, '.jar'))))
    for (const dependency of input.requiredDependencies) {
      const key = normalizedModName(dependency.slug)
      const hit = [...present].some((name) => name.includes(key) || key.includes(name))
      if (!hit) {
        issues.push({
          code: 'MISSING_DEPENDENCY',
          severity: 'error',
          message: `缺少必需的依赖模组：${dependency.slug}${dependency.requestedBy !== undefined ? `（被 ${dependency.requestedBy.join('、')} 需要）` : ''}`,
          file: null,
          hint: '执行 modpack_resolve_deps 补齐依赖链。',
        })
      }
    }
  }
  const expectedMods = input.expectedMods ?? []
  const presentNames = enabled.map((file) => normalizedModName(basename(file, '.jar')))
  const missingExpected = expectedMods.filter(
    (mod) => !presentNames.some((name) => name.includes(normalizedModName(mod.slug))),
  )
  for (const mod of missingExpected) {
    issues.push({
      code: 'EXPECTED_MOD_ABSENT',
      severity: mod.required === false ? 'warning' : 'error',
      message: `期望存在的模组未出现在 mods/ 中：${mod.slug}`,
      file: null,
      hint: '检查是否下载失败，或该模组尚未适配当前游戏版本。',
    })
  }
  checks.push({
    name: '依赖完整性',
    status: input.requiredDependencies === undefined ? 'warn' : issues.some((issue) => issue.code === 'MISSING_DEPENDENCY') ? 'fail' : 'pass',
    detail:
      input.requiredDependencies === undefined
        ? '未提供依赖清单，跳过依赖核对（建议把 modpack_resolve_deps 的结果传入）'
        : `核对了 ${input.requiredDependencies.length} 条依赖`,
  })

  // 4. 配置语法
  const configFiles = files.filter(
    (file) =>
      (file.startsWith('config/') || file.startsWith('defaultconfigs/') || file.startsWith('kubejs/')) &&
      (file.endsWith('.json') || file.endsWith('.toml') || file.endsWith('.snbt') || file.endsWith('.properties')),
  )
  let configErrors = 0
  for (const file of configFiles) {
    const text = await readTextSafe(join(packDir, file), '')
    if (text === null) continue
    let result: { ok: boolean; reason: string } = { ok: true, reason: 'ok' }
    if (file.endsWith('.json')) result = isValidJson(text)
    else if (file.endsWith('.toml')) result = isPlausibleToml(text)
    else if (file.endsWith('.snbt')) result = isBalancedSnbt(text)
    if (!result.ok) {
      configErrors += 1
      issues.push({
        code: 'CONFIG_SYNTAX',
        severity: 'error',
        message: `配置文件语法错误：${file} —— ${result.reason}`,
        file,
        hint: '该文件会导致对应模组在启动时回退默认配置甚至崩溃，请修正或删除。',
      })
    }
  }
  checks.push({
    name: '配置语法',
    status: configErrors === 0 ? 'pass' : 'fail',
    detail: `检查 ${configFiles.length} 个配置文件，${configErrors} 个有问题`,
  })

  // 5. 资源包
  let resourcePacks = 0
  if (deep) {
    const rpDir = join(packDir, 'resourcepacks')
    if (await pathExists(rpDir)) {
      const rpEntries = await readdir(rpDir, { withFileTypes: true })
      for (const entry of rpEntries) {
        resourcePacks += 1
        const absolute = join(rpDir, entry.name)
        if (entry.isDirectory()) {
          const mcmetaPath = join(absolute, 'pack.mcmeta')
          if (!(await pathExists(mcmetaPath))) {
            issues.push({
              code: 'RESOURCEPACK_NO_MCMETA',
              severity: 'error',
              message: `资源包 ${entry.name} 缺少 pack.mcmeta，游戏会直接忽略它`,
              file: `resourcepacks/${entry.name}`,
              hint: '调用 modpack_assemble_ui_pack 重新生成（会自动写入 pack.mcmeta）。',
            })
            continue
          }
          const text = (await readTextSafe(mcmetaPath, '')) ?? ''
          const parsed = asRecord(await readJsonSafe(mcmetaPath, {}))
          const pack = asRecord(parsed.pack)
          if (typeof pack.pack_format !== 'number') {
            issues.push({
              code: 'RESOURCEPACK_BAD_MCMETA',
              severity: 'error',
              message: `资源包 ${entry.name} 的 pack.mcmeta 缺少数字 pack_format`,
              file: `resourcepacks/${entry.name}/pack.mcmeta`,
              hint: `当前游戏版本 ${input.minecraftVersion} 对应的 pack_format 为 ${renderPackMcmeta(input.minecraftVersion, 'x').packFormat}。`,
            })
          }
          void text
        } else if (entry.name.endsWith('.zip')) {
          try {
            const buffer = new Uint8Array(await readFile(absolute))
            const entries = readZip(buffer)
            if (!entries.some((item) => item.path === 'pack.mcmeta')) {
              issues.push({
                code: 'RESOURCEPACK_ZIP_NO_MCMETA',
                severity: 'error',
                message: `资源包 zip ${entry.name} 里没有 pack.mcmeta`,
                file: `resourcepacks/${entry.name}`,
                hint: '重新用 modpack_assemble_ui_pack 的 zip 选项生成。',
              })
            }
          } catch (error) {
            issues.push({
              code: 'RESOURCEPACK_ZIP_CORRUPT',
              severity: 'error',
              message: `资源包 zip 无法解析：${entry.name} —— ${error instanceof Error ? error.message : String(error)}`,
              file: `resourcepacks/${entry.name}`,
              hint: '删除损坏的 zip 后重新生成。',
            })
          }
        }
      }
    }
    checks.push({
      name: '资源包',
      status: resourcePacks === 0 ? 'warn' : issues.some((issue) => issue.code.startsWith('RESOURCEPACK')) ? 'fail' : 'pass',
      detail: resourcePacks === 0 ? '未发现资源包（若整合包不做界面定制可忽略）' : `检查 ${resourcePacks} 个资源包`,
    })
  }

  // 6. 任务书
  let questChapters = 0
  let questCount = 0
  if (deep && (await pathExists(join(packDir, 'config', 'ftbquests', 'quests', 'chapters')))) {
    const chapterDir = join(packDir, 'config', 'ftbquests', 'quests', 'chapters')
    const chapterFiles = (await readdir(chapterDir)).filter((name) => name.endsWith('.snbt'))
    const questIds = new Set<string>()
    const dependencies: Array<{ file: string; id: string }> = []
    for (const name of chapterFiles) {
      questChapters += 1
      const text = (await readTextSafe(join(chapterDir, name), '')) ?? ''
      const balance = isBalancedSnbt(text)
      if (!balance.ok) {
        issues.push({
          code: 'QUEST_SNBT_INVALID',
          severity: 'error',
          message: `任务书章节 SNBT 不合法：${name} —— ${balance.reason}`,
          file: `config/ftbquests/quests/chapters/${name}`,
          hint: '用 modpack_gen_quests 重新生成该章节。',
        })
      }
      const idMatches = text.matchAll(/\bid\s*:\s*"([0-9A-Fa-f]{16})"/g)
      for (const match of idMatches) {
        const id = match[1]!.toUpperCase()
        if (questIds.has(id)) {
          issues.push({
            code: 'QUEST_ID_DUPLICATE',
            severity: 'error',
            message: `任务 id 重复：${id}（${name}）`,
            file: `config/ftbquests/quests/chapters/${name}`,
            hint: 'FTB Quests 用 id 记录进度，重复会导致进度错乱。请显式指定唯一 id。',
          })
        }
        questIds.add(id)
      }
      const depsMatches = text.matchAll(/dependencies\s*:\s*\[([^\]]*)\]/g)
      for (const match of depsMatches) {
        for (const item of (match[1] ?? '').matchAll(/"([0-9A-Fa-f]{16})"/g)) {
          dependencies.push({ file: name, id: item[1]!.toUpperCase() })
        }
      }
      questCount += (text.match(/\bid\s*:\s*"[0-9A-Fa-f]{16}"/g) ?? []).length
    }
    for (const dependency of dependencies) {
      if (!questIds.has(dependency.id)) {
        issues.push({
          code: 'QUEST_DEPENDENCY_MISSING',
          severity: 'warning',
          message: `任务依赖了不存在的 id：${dependency.id}（${dependency.file}）`,
          file: `config/ftbquests/quests/chapters/${dependency.file}`,
          hint: '补齐被依赖的任务，或删除该依赖。',
        })
      }
    }
    for (const name of chapterFiles) {
      const text = (await readTextSafe(join(chapterDir, name), '')) ?? ''
      void text
    }
    checks.push({
      name: '任务书',
      status: questChapters === 0 ? 'warn' : issues.some((issue) => issue.code.startsWith('QUEST_ID_DUPLICATE') || issue.code === 'QUEST_SNBT_INVALID') ? 'fail' : 'pass',
      detail: `${questChapters} 个章节，约 ${questCount} 个 id`,
    })
  } else if (deep) {
    checks.push({ name: '任务书', status: 'warn', detail: '未发现 config/ftbquests/quests/chapters/（若不用 FTB Quests 可忽略）' })
  }

  // 7. 敏感信息
  if (scanSecrets) {
    const suspects: string[] = []
    for (const file of files) {
      if (SECRET_FILE_NAMES.includes(basename(file))) suspects.push(file)
      const lower = file.toLowerCase()
      if (lower.endsWith('.jar') || lower.endsWith('.zip') || lower.endsWith('.png') || lower.endsWith('.ogg')) continue
      const text = await readTextSafe(join(packDir, file), null)
      if (text === null || text.length > 2_000_000) continue
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) {
          issues.push({
            code: 'SECRET_LEAK',
            severity: 'error',
            message: `${file} 中疑似存在${pattern.name}`,
            file,
            hint: '发布前必须清除：凭据只放在本机 .secrets.env，且留痕里一律写「已脱密」。',
          })
          break
        }
      }
    }
    for (const file of suspects) {
      issues.push({
        code: 'SECRET_FILE_PRESENT',
        severity: 'error',
        message: `整合包内出现凭据类文件：${file}`,
        file,
        hint: '删除该文件后再打包发布。',
      })
    }
    checks.push({
      name: '敏感信息',
      status: issues.some((issue) => issue.code.startsWith('SECRET')) ? 'fail' : 'pass',
      detail: issues.some((issue) => issue.code.startsWith('SECRET')) ? '发现疑似凭据，发布前必须清理' : '未发现疑似凭据',
    })
  }

  // 8. 打包产物
  const archives = files.filter((file) => file.endsWith('.mrpak') || file.endsWith('.zip'))
  checks.push({
    name: '打包产物',
    status: archives.length > 0 ? 'pass' : 'warn',
    detail: archives.length > 0 ? `发现 ${archives.length} 个压缩产物` : '尚无打包产物，发布前执行 modpack_export',
  })

  let totalBytes = 0
  for (const file of enabled) totalBytes += await sizeOf(join(packDir, file))

  const errors = issues.filter((issue) => issue.severity === 'error')
  const verdict: ValidatePackResult['verdict'] = errors.length > 0 ? 'broken' : issues.length > 0 ? 'warning' : 'ok'
  const stats = {
    mods: enabled.length,
    disabledMods: disabled.length,
    configFiles: configFiles.length,
    resourcePacks,
    questChapters,
    quests: questCount,
    totalBytes,
  }
  const report = renderValidationReport({ packDir, input, checks, issues, verdict, stats })

  return {
    ok: errors.length === 0,
    verdict,
    checks,
    issues,
    stats,
    report,
    createdAt: nowIso(),
  }
}

function normalizedModName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]?(?:fabric|forge|neoforge|quilt|mc)?[-_]?\d+(?:\.\d+)*.*$/, '')
    .replace(/[-_.]+/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function renderValidationReport(input: {
  packDir: string
  input: ValidatePackInput
  checks: ValidationCheck[]
  issues: ValidationIssue[]
  verdict: ValidatePackResult['verdict']
  stats: ValidatePackResult['stats']
}): string {
  const lines: string[] = []
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' }
  const verdictText = { ok: '通过', warning: '有警告', broken: '存在必须修复的问题' }
  lines.push('# 整合包校验报告')
  lines.push('')
  lines.push(`- 目录：${input.packDir}`)
  lines.push(`- 目标：Minecraft ${input.input.minecraftVersion} / ${input.input.loader}`)
  lines.push(`- 结论：${verdictText[input.verdict]}`)
  lines.push(`- 模组：${input.stats.mods} 启用 / ${input.stats.disabledMods} 禁用，合计 ${(input.stats.totalBytes / 1024 / 1024).toFixed(1)} MB`)
  lines.push(`- 配置：${input.stats.configFiles} 个文件；资源包：${input.stats.resourcePacks} 个；任务章节：${input.stats.questChapters} 个 / ${input.stats.quests} 个 id`)
  lines.push('')
  lines.push('## 检查项')
  for (const check of input.checks) {
    lines.push(`- ${icon[check.status] ?? '•'} **${check.name}**：${check.detail}`)
  }
  if (input.issues.length > 0) {
    lines.push('')
    lines.push('## 问题清单')
    for (const issue of input.issues) {
      lines.push(`- [${issue.severity}] ${issue.code}：${issue.message}${issue.file !== null ? `（${issue.file}）` : ''}`)
      if (issue.hint !== null) lines.push(`  - 建议：${issue.hint}`)
    }
  } else {
    lines.push('')
    lines.push('未发现问题。')
  }
  return lines.join('\n')
}

// ── 测试计划 ─────────────────────────────────────────────────────────────────

/** 测试计划输入。 */
export interface TestPlanInput {
  packName: string
  minecraftVersion: string
  loader: string
  /** 主题，用于生成针对性检查。 */
  theme?: string
  /** 功能模块（如 ['科技','任务书','自定义主界面','光影']）。 */
  features?: string[]
  /** 模组数量，用于估算启动耗时阈值。 */
  modCount?: number
  /** 目标最低帧率。 */
  targetFps?: number
  /** 是否有服务端。 */
  serverSide?: boolean
  /** 分配内存（GB）。 */
  memoryGb?: number
}

/** 测试计划结果。 */
export interface TestPlanResult {
  checklist: Array<{ section: string; items: Array<{ id: string; text: string; expected: string; severity: 'blocker' | 'major' | 'minor' }> }>
  markdown: string
  estimatedMinutes: number
  createdAt: string
}

/** 生成测试检查清单。 */
export function generateTestPlan(input: TestPlanInput): TestPlanResult {
  const modCount = input.modCount ?? 100
  const features = new Set((input.features ?? []).map((item) => item.toLowerCase()))
  const memory = input.memoryGb ?? 6
  const checklist: TestPlanResult['checklist'] = []

  checklist.push({
    section: '1. 环境与启动',
    items: [
      { id: 'ENV-1', text: `用 Java 17 启动 Minecraft ${input.minecraftVersion}（${input.loader}）`, expected: '启动器选择正确的 Java 版本，无 "Unsupported class file major version" 报错', severity: 'blocker' },
      { id: 'ENV-2', text: `分配 ${memory} GB 内存（-Xmx${memory}G），并设置 G1GC 参数`, expected: '启动过程无 OutOfMemoryError，进度条正常推进', severity: 'blocker' },
      { id: 'ENV-3', text: `统计模组加载数量（${modCount} 个左右）`, expected: '所有模组均显示在模组列表，无 "Missing or unsupported" 条目', severity: 'blocker' },
      { id: 'ENV-4', text: '检查日志中是否出现 Missing dependency', expected: '日志无缺依赖条目；若有，记录缺失模组名', severity: 'blocker' },
      { id: 'ENV-5', text: '检查日志中的 mixin 冲突与崩溃报告', expected: '无 Mixin apply failed / crash-report 生成', severity: 'blocker' },
    ],
  })

  checklist.push({
    section: '2. 主界面与 UI',
    items: [
      { id: 'UI-1', text: '进入主界面，确认背景图/全景图正确显示', expected: '背景无拉伸变形；全景图旋转无接缝（若用 panorama）', severity: 'major' },
      { id: 'UI-2', text: '逐个点击自定义按钮的悬停态', expected: '悬停纹理切换正常，文字不溢出、无方块字符', severity: 'major' },
      { id: 'UI-3', text: '在 1280x720 / 1920x1080 / 2560x1440 三种分辨率下检查布局', expected: '按钮与标题锚点无重叠、无越界', severity: 'major' },
      { id: 'UI-4', text: '切换 GUI 缩放（自动/2/3/4）', expected: '界面元素不错位', severity: 'minor' },
      { id: 'UI-5', text: '切到中文界面确认 UI 按钮文案', expected: '无英文占位文案，无 key 名直接显示', severity: 'major' },
    ],
  })

  checklist.push({
    section: '3. 游戏内功能',
    items: [
      { id: 'GAME-1', text: '创建新世界并进入', expected: '区块生成正常，无长时间卡死（< 60 秒进入可操作）', severity: 'blocker' },
      { id: 'GAME-2', text: `走一遍${input.theme ?? '核心玩法'}的首个进度链`, expected: '可完成第一项任务并领取奖励', severity: 'major' },
      { id: 'GAME-3', text: '打开任务书（默认键位）', expected: '章节全部可打开，任务图标与连线正常', severity: 'major' },
      { id: 'GAME-4', text: '完成并领取 3 个不同类型奖励', expected: '奖励正常发放，无报错刷屏', severity: 'major' },
      { id: 'GAME-5', text: '打开 JEI/REI/EMI 查询一个模组物品', expected: '配方与用途信息完整', severity: 'minor' },
      { id: 'GAME-6', text: '保存并退出，再进入同一世界', expected: '任务进度保留，配置未被重置', severity: 'blocker' },
    ],
  })

  if (features.has('光影') || features.has('shader') || features.has('shaders')) {
    checklist.push({
      section: '4. 光影与画质',
      items: [
        { id: 'GFX-1', text: '启用光影包并切换 3 个预设', expected: '无黑屏/闪烁，切包不崩溃', severity: 'major' },
        { id: 'GFX-2', text: '在雨天/夜晚场景下观察', expected: '光线与水面渲染正常', severity: 'minor' },
        { id: 'GFX-3', text: '关闭光影后回到原版渲染', expected: '帧率恢复，无残留着色器错误', severity: 'major' },
      ],
    })
  }

  checklist.push({
    section: '5. 性能',
    items: [
      { id: 'PERF-1', text: '在主世界空旷处站立 60 秒，记录平均帧率', expected: `≥ ${input.targetFps ?? 60} FPS（1080p，默认画质）`, severity: 'major' },
      { id: 'PERF-2', text: '打开任务书 + 背包 + 创造模式物品栏', expected: '界面帧率下降不超过 30%', severity: 'minor' },
      { id: 'PERF-3', text: '观察内存占用峰值', expected: `低于 ${Math.round(memory * 0.85)} GB，不触发频繁 GC`, severity: 'major' },
      { id: 'PERF-4', text: '在大型机器/自动化区域停留 60 秒', expected: '无 TPS 断崖，服务器 tick 稳定', severity: 'major' },
    ],
  })

  if (input.serverSide === true) {
    checklist.push({
      section: '6. 服务端与多人',
      items: [
        { id: 'SRV-1', text: '把整合包部署到服务端并启动', expected: '服务端正常启动，无客户端专属模组报错', severity: 'blocker' },
        { id: 'SRV-2', text: '两名玩家同时连接并完成任务', expected: '任务进度各自独立，奖励不串号', severity: 'major' },
        { id: 'SRV-3', text: '断开重连后检查进度同步', expected: '进度与服务端一致', severity: 'major' },
        { id: 'SRV-4', text: '检查 server.properties 的 online-mode / 视距', expected: '与整合包说明一致', severity: 'minor' },
      ],
    })
  }

  checklist.push({
    section: `${input.serverSide === true ? '7' : '6'}. 发布前`,
    items: [
      { id: 'REL-1', text: '运行 modpack_validate 并清零所有 error', expected: 'verdict = ok 或仅剩 warning', severity: 'blocker' },
      { id: 'REL-2', text: '运行 modpack_export 产出 mrpak / CF zip / 手动 zip', expected: '产物可被解压，mods 数量与实例一致', severity: 'blocker' },
      { id: 'REL-3', text: '确认包内无 .secrets.env、无 token/key 明文', expected: '敏感信息检查全绿', severity: 'blocker' },
      { id: 'REL-4', text: '给新玩家做一次"零基础引导"测试', expected: '不看攻略能完成首个任务', severity: 'major' },
      { id: 'REL-5', text: '记录版本号、变更日志与已知问题', expected: 'modpack_publish 产出的 changelog 与实测一致', severity: 'minor' },
    ],
  })

  const itemCount = checklist.reduce((sum, section) => sum + section.items.length, 0)
  const markdown = renderTestPlanMarkdown(input, checklist, itemCount)
  return {
    checklist,
    markdown,
    estimatedMinutes: Math.round(itemCount * 3.5),
    createdAt: nowIso(),
  }
}

function renderTestPlanMarkdown(
  input: TestPlanInput,
  checklist: TestPlanResult['checklist'],
  itemCount: number,
): string {
  const lines: string[] = []
  lines.push(`# ${input.packName} 测试检查清单`)
  lines.push('')
  lines.push(`- 目标版本：Minecraft ${input.minecraftVersion} / ${input.loader}`)
  if (input.theme !== undefined) lines.push(`- 主题：${input.theme}`)
  lines.push(`- 检查项：${itemCount} 条，预计耗时约 ${Math.round(itemCount * 3.5)} 分钟`)
  lines.push('')
  lines.push('> 标记说明：blocker = 不通过就不能发布；major = 影响体验需修复；minor = 可记录为已知问题。')
  lines.push('')
  for (const section of checklist) {
    lines.push(`## ${section.section}`)
    lines.push('')
    lines.push('| 编号 | 操作 | 期望结果 | 级别 | 结果 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const item of section.items) {
      lines.push(`| ${item.id} | ${item.text} | ${item.expected} | ${item.severity} | ☐ |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
