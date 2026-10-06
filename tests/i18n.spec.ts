/**
 * i18n.ts 行为测试：中文检测、占位符保护、术语表翻译、SNBT 文本抽取、
 * 扫描缺失键、批量翻译并打包语言资源包。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DictionaryTranslator,
  GLOSSARY_EN_ZH,
  GlossaryTranslator,
  containsCjk,
  extractSnbtStrings,
  maskPlaceholders,
  mergeLangFiles,
  readLangFile,
  renderUntranslatedNotice,
  scanI18n,
  translateAndPackage,
} from '../src/i18n.js'

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 造一个带源语言 lang 文件与任务书的整合包目录。 */
async function makePack(): Promise<string> {
  const packDir = await makeTempDir('dsh-i18n-')
  await mkdir(join(packDir, 'resourcepacks', 'sample', 'assets', 'mypack', 'lang'), { recursive: true })
  await mkdir(join(packDir, 'config', 'ftbquests', 'quests', 'chapters'), { recursive: true })
  await writeFile(
    join(packDir, 'resourcepacks', 'sample', 'assets', 'mypack', 'lang', 'en_us.json'),
    `${JSON.stringify({
      'mypack.button.play': 'Play',
      'mypack.button.options': 'Options',
      'mypack.quest.start': 'Getting Started',
    }, null, 2)}\n`,
  )
  await writeFile(
    join(packDir, 'config', 'ftbquests', 'quests', 'chapters', 'chapter_1.snbt'),
    '{\n\ttitle: "第 1 章 · 立足"\n\tquests: [\n\t\t{\n\t\t\tid: "AAAAAAAAAAAAAAAA"\n\t\t\ttitle: "第一块木头"\n\t\t\tdescription: ["砍树", "做工作台"]\n\t\t\tdependencies: ["BBBBBBBBBBBBBBBB"]\n\t\t}\n\t]\n}\n',
  )
  return packDir
}

describe('文本判定与占位符', () => {
  it('containsCjk 只对中日韩字符为真', () => {
    expect(containsCjk('开始游戏')).toBe(true)
    expect(containsCjk('こんにちは')).toBe(true)
    expect(containsCjk('Play')).toBe(false)
    expect(containsCjk('日本語 mixed 123')).toBe(true)
  })

  it('maskPlaceholders 把 %s / {0} / %1$s / ${x} 保护起来不被翻译', () => {
    const { masked, restore } = maskPlaceholders('Found %s items in {0} chests, %1$s, ${name}')
    expect(masked).not.toContain('%s')
    expect(restore(masked)).toBe('Found %s items in {0} chests, %1$s, ${name}')
  })

  it('mergeLangFiles 后者覆盖前者且不丢其它键', () => {
    const merged = mergeLangFiles({ a: '1', b: '2' }, { b: 'B', c: '3' })
    expect(merged).toEqual({ a: '1', b: 'B', c: '3' })
    expect(renderUntranslatedNotice('zh_cn', [])).toContain('全部键均已翻译')
    expect(renderUntranslatedNotice('zh_cn', ['k1', 'k2'])).toContain('k1')
  })
})

describe('术语表翻译', () => {
  it('整句命中优先，词级替换保留未命中的部分', async () => {
    const translator = new GlossaryTranslator()
    expect(await translator.translate([{ key: 'a', text: 'Options' }], 'zh_cn')).toEqual(new Map([['a', '选项']]))
    const partial = translator.translateOne('Quest Rewards')
    expect(partial).toContain('任务')
    expect(partial).toContain('奖励')
    expect(GLOSSARY_EN_ZH['singleplayer']).toBe('单人游戏')
  })

  it('没有原文时用 key 末段生成可读文案', () => {
    const translator = new GlossaryTranslator()
    expect(translator.translateOne('', 'mypack.button.play')).toBe('开始游戏')
    expect(translator.translateOne('', 'mypack.button.mods')).toBe('模组')
    expect(translator.translateOne('', 'mypack.button.unknown-term')).toBe('Unknown Term')
  })

  it('自定义词典优先于术语表且能按原文匹配', async () => {
    const dictionary = new DictionaryTranslator({ zh_cn: { 'mypack.button.play': '开玩', 'Options': '设置项' } })
    const result = await dictionary.translate(
      [{ key: 'mypack.button.play', text: 'Play' }, { key: 'other', text: 'Options' }],
      'zh_cn',
    )
    expect(result.get('mypack.button.play')).toBe('开玩')
    expect(result.get('other')).toBe('设置项')
  })

  it('extractSnbtStrings 抽取 title / subtitle / description 文本', () => {
    const text = '{\n title: "第一章"\n subtitle: "开始"\n description: ["a", "b"]\n other: "ignored"\n}'
    expect(extractSnbtStrings(text)).toEqual(['第一章', '开始', 'a', 'b'])
  })
})

describe('scanI18n', () => {
  it('找出目标语言缺失的键并给出报告', async () => {
    const packDir = await makePack()
    const result = await scanI18n({ packDir, targetLocales: ['zh_cn'] })

    expect(result.sourceLocale).toBe('en_us')
    expect(result.namespaces).toHaveLength(1)
    expect(result.namespaces[0]!.namespace).toBe('mypack')
    expect(result.namespaces[0]!.keys).toBe(3)
    expect(result.stats.missingKeys).toBe(3)
    expect(result.stats.langKeys).toBe(3)

    const keys = result.entries.filter((entry) => entry.kind === 'lang').map((entry) => entry.key)
    expect(keys.sort()).toEqual(['mypack.button.options', 'mypack.button.play', 'mypack.quest.start'])

    // 源语言是 en_us 时，任务书里的中文会被识别为"尚未本地化"的文本
    expect(result.stats.questStrings).toBe(4)
    expect(result.entries.filter((entry) => entry.kind === 'quest')).toHaveLength(4)
    expect(result.report).toContain('本地化扫描报告')
    expect(result.report).toContain('缺失译文键数：3')
  })

  it('目标语言已存在时不报缺失键', async () => {
    const packDir = await makePack()
    await writeFile(
      join(packDir, 'resourcepacks', 'sample', 'assets', 'mypack', 'lang', 'zh_cn.json'),
      `${JSON.stringify({ 'mypack.button.play': '开始游戏', 'mypack.button.options': '选项', 'mypack.quest.start': '开始游戏' }, null, 2)}\n`,
    )
    const result = await scanI18n({ packDir, targetLocales: ['zh_cn'] })
    expect(result.stats.missingKeys).toBe(0)
    expect(result.entries.filter((entry) => entry.kind === 'lang')).toHaveLength(0)
  })

  it('includeHardcoded 会扫出配置/README 里的中文行', async () => {
    const packDir = await makePack()
    await writeFile(join(packDir, 'README.md'), '# 我的整合包\n\n这是一个科技整合包\n')
    const result = await scanI18n({ packDir, targetLocales: ['zh_cn'], includeHardcoded: true })
    expect(result.stats.hardcodedStrings).toBeGreaterThan(0)
    expect(result.entries.some((entry) => entry.kind === 'markdown')).toBe(true)
  })

  it('目录不存在时抛出明确错误', async () => {
    await expect(scanI18n({ packDir: join(tmpdir(), 'dsh-i18n-not-exist-xyz') })).rejects.toThrow(/不存在/)
  })
})

describe('translateAndPackage', () => {
  it('显式译文优先，并写出 lang 文件与 pack.mcmeta', async () => {
    const packDir = await makePack()
    const result = await translateAndPackage({
      packDir,
      minecraftVersion: '1.20.1',
      targetLocales: ['zh_cn'],
      translations: {
        zh_cn: {
          'mypack.button.play': '开始游戏',
          'mypack.button.options': '选项',
        },
      },
      entries: [
        { key: 'mypack.button.play', text: 'Play' },
        { key: 'mypack.button.options', text: 'Options' },
        { key: 'mypack.quest.start', text: 'Getting Started' },
      ],
    })

    expect(result.packFormat).toBe(15)
    expect(result.files).toContain('pack.mcmeta')
    expect(result.files).toContain('assets/i18n-pack/lang/zh_cn.json')
    const stats = result.perLocale[0]!
    expect(stats.locale).toBe('zh_cn')
    expect(stats.fromInput).toBe(2)
    expect(stats.fromGlossary).toBe(1)
    expect(stats.untranslated).toEqual([])

    const lang = await readLangFile(packDir, 'resourcepacks/i18n-pack/assets/i18n-pack/lang/zh_cn.json')
    expect(lang['mypack.button.play']).toBe('开始游戏')
    expect(lang['mypack.quest.start']).toBeTruthy()
    const mcmeta = JSON.parse(await readFile(join(packDir, 'resourcepacks', 'i18n-pack', 'pack.mcmeta'), 'utf8')) as { pack: { pack_format: number } }
    expect(mcmeta.pack.pack_format).toBe(15)
  })

  it('useGlossary=false 时未提供的键会进入 untranslated', async () => {
    const packDir = await makePack()
    const result = await translateAndPackage({
      packDir,
      minecraftVersion: '1.20.1',
      targetLocales: ['zh_cn'],
      entries: [{ key: 'k1', text: 'Play' }, { key: 'k2', text: 'Options' }],
      translations: { zh_cn: { k1: '开始' } },
      useGlossary: false,
    })
    expect(result.perLocale[0]!.fromInput).toBe(1)
    expect(result.perLocale[0]!.fromGlossary).toBe(0)
    expect(result.perLocale[0]!.untranslated).toEqual(['k2'])
  })

  it('dryRun 不写盘，zip 选项产出压缩包', async () => {
    const packDir = await makePack()
    const dry = await translateAndPackage({
      packDir,
      minecraftVersion: '1.20.1',
      targetLocales: ['zh_cn'],
      entries: [{ key: 'k1', text: 'Play' }],
      dryRun: true,
    })
    expect(dry.dryRun).toBe(true)
    expect(dry.files).toEqual([])
    await expect(readFile(join(packDir, 'resourcepacks', 'i18n-pack', 'pack.mcmeta'), 'utf8')).rejects.toThrow()

    const zipped = await translateAndPackage({
      packDir,
      minecraftVersion: '1.20.1',
      targetLocales: ['zh_cn'],
      entries: [{ key: 'k1', text: 'Play' }],
      zip: true,
    })
    expect(zipped.zipPath).not.toBeNull()
    const { readZip } = await import('../src/packer.js')
    const zip = readZip(new Uint8Array(await readFile(zipped.zipPath!)))
    expect(zip.some((entry) => entry.path === 'assets/i18n-pack/lang/zh_cn.json')).toBe(true)
  })

  it('没有任何条目时报错而不是产出空包', async () => {
    const packDir = await makeTempDir('dsh-i18n-empty-')
    await expect(
      translateAndPackage({ packDir, minecraftVersion: '1.20.1', targetLocales: ['zh_cn'] }),
    ).rejects.toThrow(/没有扫描到待翻译条目/)
  })
})
