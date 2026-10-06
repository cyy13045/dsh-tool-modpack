/**
 * quest-gen.ts 行为测试：SNBT 序列化与转义、章节渲染、id 确定性、任务书落盘与告警。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  asDouble,
  asLong,
  generateQuestBook,
  questId,
  renderChapterGroupsSnbt,
  renderChapterSnbt,
  snbtLiteral,
  snbtString,
  validateChapterDraft,
} from '../src/quest-gen.js'

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('SNBT 序列化', () => {
  it('字符串按 Java 风格转义引号、反斜杠与换行', () => {
    expect(snbtString('简单文本')).toBe('"简单文本"')
    expect(snbtString('say "hi"')).toBe('"say \\"hi\\""')
    expect(snbtString('a\\b')).toBe('"a\\\\b"')
    expect(snbtString('line1\nline2')).toBe('"line1\\nline2"')
    expect(snbtString('tab\there')).toBe('"tab\\there"')
  })

  it('数字后缀与复合结构按 FTBQ 习惯输出', () => {
    expect(asDouble(3).text).toBe('3.0d')
    expect(asDouble(2.5).text).toBe('2.5d')
    expect(asLong(8).text).toBe('8L')

    const text = snbtLiteral({
      id: 'ABCDEF0123456789',
      x: asDouble(1),
      count: asLong(64),
      nested: { flag: true, empty: [] },
      list: ['a', 'b'],
    })
    expect(text).toContain('id: "ABCDEF0123456789"')
    expect(text).toContain('x: 1.0d')
    expect(text).toContain('count: 64L')
    expect(text).toContain('flag: true')
    expect(text).toContain('empty: []')
    expect(text).toContain('["a", "b"]')
  })

  it('id 由内容确定性派生，长度与形态符合 FTBQ 要求', () => {
    const a = questId('chapter:第 1 章')
    const b = questId('chapter:第 1 章')
    const c = questId('chapter:第 2 章')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9A-F]{16}$/)
  })
})

describe('renderChapterSnbt', () => {
  it('章节头字段、任务目标与依赖都正确落进 SNBT', () => {
    const text = renderChapterSnbt(
      {
        title: '第 1 章 · 立足',
        icon: 'minecraft:crafting_table',
        group: '主线',
        quests: [
          {
            title: '第一根木棍',
            description: ['砍树', '做工作台'],
            x: 0,
            y: 0,
            tasks: [{ type: 'item', item: 'minecraft:oak_log', count: 4 }],
            rewards: [{ type: 'xp', xp: 20 }],
          },
          {
            title: '工作台',
            x: 2,
            y: 0,
            tasks: [{ type: 'item', item: 'minecraft:crafting_table' }],
            dependencies: ['DEPENDS_ON_FIRST'],
          },
        ],
      },
      'GROUPID0123456789',
    )

    expect(text).toContain('title: "第 1 章 · 立足"')
    expect(text).toContain('group: "GROUPID0123456789"')
    expect(text).toContain('icon: {')
    expect(text).toContain('id: "minecraft:crafting_table"')
    expect(text).toContain('count: 4L')
    expect(text).toContain('type: "xp"')
    expect(text).toContain('xp: 20')
    expect(text).toContain('dependencies:')
    expect(text).toContain('"DEPENDS_ON_FIRST"')
    expect(text.trim().startsWith('{')).toBe(true)
    expect(text.trim().endsWith('}')).toBe(true)
  })

  it('chapter_groups 输出可直接写入 SNBT 数组', () => {
    const text = renderChapterGroupsSnbt([{ id: 'G1', title: '主线' }])
    expect(text).toContain('chapter_groups:')
    expect(text).toContain('title: "主线"')
  })

  it('章节草稿校验能指出缺任务与坐标问题', () => {
    expect(validateChapterDraft({ title: '空章节', quests: [] })).toContain('章节「空章节」没有任何任务')
    const problems = validateChapterDraft({
      title: 'X',
      quests: [{ title: '无目标', x: Number.NaN, y: 0, tasks: [] }],
    })
    expect(problems.some((item) => item.includes('数值')) || problems.some((item) => item.includes('tasks'))).toBe(true)
  })
})

describe('generateQuestBook', () => {
  it('写出章节 / 章节组 / data.snbt，并产出可用的 questIndex', async () => {
    const packDir = await makeTempDir('dsh-quest-')
    const result = await generateQuestBook({
      packDir,
      title: '测试任务书',
      chapters: [
        {
          title: '第 0 章',
          filename: 'chapter_1',
          group: '主线',
          quests: [
            { title: '欢迎', x: 0, y: 0, tasks: [{ type: 'checkmark' }] },
            { title: '第一块木头', x: 2, y: 0, tasks: [{ type: 'item', item: 'oak_log', count: 2 }], rewards: [{ type: 'item', item: 'minecraft:stone_axe' }] },
          ],
        },
      ],
    })

    expect(result.chapters).toBe(1)
    expect(result.quests).toBe(2)
    expect(result.tasks).toBe(2)
    expect(result.rewards).toBe(1)
    expect(result.chapterGroups).toBe(1)
    expect(result.files[0]).toBe('config/ftbquests/quests/chapters/chapter_1.snbt')
    expect(result.files).toContain('config/ftbquests/quests/chapter_groups.snbt')
    expect(result.files).toContain('config/ftbquests/quests/data.snbt')
    expect(result.questIndex).toHaveLength(2)
    expect(result.questIndex[0]!.id).toMatch(/^[0-9A-F]{16}$/)

    const chapter = await readFile(join(packDir, 'config', 'ftbquests', 'quests', 'chapters', 'chapter_1.snbt'), 'utf8')
    expect(chapter).toContain('title: "第 0 章"')
    expect(chapter).toContain('count: 2L')
    expect(chapter).toContain('minecraft:oak_log')
    const groups = await readFile(join(packDir, 'config', 'ftbquests', 'quests', 'chapter_groups.snbt'), 'utf8')
    expect(groups).toContain('"主线"')
  })

  it('重复生成同一份任务书是幂等的（id 不漂移）', async () => {
    const packDir = await makeTempDir('dsh-quest2-')
    const input = {
      packDir,
      title: '幂等测试',
      chapters: [{ title: '第 1 章', quests: [{ title: '重复任务', x: 0, y: 0, tasks: [{ type: 'checkmark' as const }] }] }],
    }
    const first = await generateQuestBook(input)
    const second = await generateQuestBook(input)
    expect(second.questIndex.map((item) => item.id)).toEqual(first.questIndex.map((item) => item.id))
  })

  it('悬空依赖与空任务会产生可读警告', async () => {
    const packDir = await makeTempDir('dsh-quest3-')
    const result = await generateQuestBook({
      packDir,
      title: '告警测试',
      chapters: [
        {
          title: '第 1 章',
          quests: [
            { title: '没有目标的任务', x: 0, y: 0, tasks: [] },
            { title: '依赖悬空', x: 2, y: 0, tasks: [{ type: 'checkmark' }], dependencies: ['FFFFFFFFFFFFFFFF'] },
          ],
        },
      ],
    })
    expect(result.warnings.some((warning) => warning.includes('没有任何目标'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('不存在的任务 id'))).toBe(true)
  })

  it('dryRun 不写盘但仍返回文件清单', async () => {
    const packDir = await makeTempDir('dsh-quest4-')
    const result = await generateQuestBook({
      packDir,
      title: '干跑',
      chapters: [{ title: '第 1 章', quests: [{ title: '任务', x: 0, y: 0, tasks: [{ type: 'checkmark' }] }] }],
      dryRun: true,
    })
    expect(result.files.length).toBeGreaterThan(0)
    await expect(readFile(join(packDir, 'config', 'ftbquests', 'quests', 'data.snbt'), 'utf8')).rejects.toThrow()
  })
})

describe('任务书输入边界', () => {
  it('空章节列表直接报错而不是写出空文件', async () => {
    const packDir = await makeTempDir('dsh-quest5-')
    await writeFile(join(packDir, 'keep.txt'), 'x')
    await expect(generateQuestBook({ packDir, title: '空', chapters: [] })).rejects.toThrow(/至少需要一个章节/)
  })
})
