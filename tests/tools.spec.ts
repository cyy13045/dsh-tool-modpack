/**
 * 端到端工具测试：用假的 ctx 注册 22 个工具，对**不依赖网络**的工具真实调用 execute()，
 * 并用 DSH 自己的 validateJsonSchemaValue 校验返回的 canonical 值是否满足声明的 output.schema。
 *
 * 这一步验证的是"注册契约 + 输出契约 + 落盘行为"三件事：
 *  - 22 个工具全部注册、无重名；
 *  - execute 只返回一个通过 output.schema 校验的值；
 *  - 该写的文件确实写到正确路径。
 *
 * 需要联网的工具（search_mods / add_mod / resolve_deps / add_optimization / add_resources /
 * gen_menu_bg / gen_ui_textures）在这里只做参数与错误路径校验，真实网络行为由模块级测试覆盖。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as modpackPlugin from '../src/index.js'
import { TOOL_NAMES, apply } from '../src/index.js'

interface RegisteredTool {
  name: string
  description: string
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] }
  output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

const registered: RegisteredTool[] = []
const tempDirs: string[] = []
let packDir = ''

const fakeExec = { signal: undefined as AbortSignal | undefined }

beforeAll(async () => {
  const ctx = {
    tools: {
      register(definition: RegisteredTool) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(callback: () => () => void) {
      return callback()
    },
  }
  apply(ctx as never)

  packDir = await mkdtemp(join(tmpdir(), 'dsh-tools-'))
  tempDirs.push(packDir)
})

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function tool(name: string): RegisteredTool {
  const found = registered.find((item) => item.name === name)
  if (found === undefined) throw new Error(`工具未注册：${name}`)
  return found
}

/** 调用工具并断言返回值满足 output.schema。 */
async function run(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const definition = tool(name)
  const value = await definition.execute(args, fakeExec)
  const violations = validateJsonSchemaValue(definition.output.schema as never, value)
  expect(violations, `${name} 的输出违反了自己的 output.schema`).toEqual([])
  const blocks = definition.output.render(args, value)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks[0]!.type).toBe('text')
  return value as Record<string, any>
}

describe('插件注册契约', () => {
  it('在真实 Cordis 上下文中按 inject 契约加载，卸载时注销全部工具', async () => {
    const ctx = new Context()
    const tools: RegisteredTool[] = []
    const disposed: string[] = []
    ctx.provide('tools', {
      register(definition: RegisteredTool) {
        tools.push(definition)
        return () => {
          disposed.push(definition.name)
        }
      },
    })

    const fiber = ctx.plugin(modpackPlugin as never)
    await fiber
    expect(tools).toHaveLength(22)
    expect(tools.map((item) => item.name).sort()).toEqual([...TOOL_NAMES].sort())

    await fiber.dispose()
    expect(disposed).toHaveLength(22)
  })

  it('注册 22 个工具，名称与权威清单一致且无重名', () => {
    expect(registered).toHaveLength(22)
    expect(registered.map((item) => item.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(new Set(registered.map((item) => item.name)).size).toBe(22)
  })

  it('每个工具都有完整 description、parameters 与 output.schema', () => {
    let withRequired = 0
    for (const item of registered) {
      expect(item.description.length, item.name).toBeGreaterThan(30)
      expect(item.parameters.type, item.name).toBe('object')
      expect(Object.keys(item.parameters.properties ?? {}).length, item.name).toBeGreaterThan(0)
      // required 一定是编译后的字符串数组；全部可选的工具（如 modpack_check_conflicts）不输出该字段
      expect(item.parameters.required === undefined || Array.isArray(item.parameters.required), item.name).toBe(true)
      if (Array.isArray(item.parameters.required) && item.parameters.required.length > 0) withRequired += 1
      const schema = item.output.schema as { type?: string; additionalProperties?: boolean }
      expect(schema.type, item.name).toBe('object')
      expect(schema.additionalProperties, item.name).toBe(false)
    }
    expect(withRequired).toBeGreaterThanOrEqual(21)
  })

  it('参数非法时按契约抛错（execute 抛异常即 isError）', async () => {
    // packDir 缺失 → 由 DSH 的参数校验拦截
    await expect(tool('modpack_create').execute({}, fakeExec)).rejects.toThrow(/packDir/)
    // loader 不在枚举内 → 同样在进入 execute 主体前被拦截
    await expect(
      tool('modpack_export').execute(
        { packDir, minecraftVersion: '1.20.1', loader: 'bogus', name: 'x', version: '1.0.0', formats: ['manual'] },
        fakeExec,
      ),
    ).rejects.toThrow(/loader/)
    // 进入主体后的业务错误也照常冒泡
    await expect(
      tool('modpack_gen_quests').execute({ packDir, title: 'x', chapters: [] }, fakeExec),
    ).rejects.toThrow(/chapters 不能为空/)
  })

  it('未知生图 provider 在联网前就报错', async () => {
    await expect(
      tool('modpack_gen_menu_bg').execute(
        { packDir, prompt: 'test', provider: 'midjourney' },
        fakeExec,
      ),
    ).rejects.toThrow(/provider/)
  })
})

describe('阶段一：规划与初始化', () => {
  it('modpack_plan 产出配色、模组分类、里程碑与生图 prompt，并落盘 plan.json', async () => {
    const value = await run('modpack_plan', {
      theme: '深蓝色科技风',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      packDir,
      includeQuests: true,
      includeCustomUi: true,
    })
    expect(value.ok).toBe(true)
    expect(value.javaMajor).toBe(17)
    expect(value.uiTheme.primary).toBe('#1E3A8A')
    expect(value.modCategories.length).toBeGreaterThanOrEqual(5)
    expect(value.uiTheme.menuBackgroundPrompt).toContain('科技')
    const plan = JSON.parse(await readFile(join(packDir, 'plan.json'), 'utf8')) as { packName: string; stages: unknown[] }
    expect(plan.stages).toHaveLength(7)
  })

  it('modpack_create 建目录并写实例元数据，重复调用不报错', async () => {
    const first = await run('modpack_create', {
      packDir,
      name: '科技整合包',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      quests: true,
      customUi: true,
    })
    expect(first.created).toContain('mods')
    expect(first.created).toContain('config/ftbquests/quests/chapters')
    const second = await run('modpack_create', {
      packDir,
      name: '科技整合包',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(second.created).toEqual([])
    expect(second.existing).toContain('mods')
    const instance = JSON.parse(await readFile(join(packDir, 'modpack.instance.json'), 'utf8')) as { loader: string; javaMajor: number }
    expect(instance.loader).toBe('fabric')
    expect(instance.javaMajor).toBe(17)
  })

  it('modpack_setup_env 生成 Java 版本、JVM 参数与启动脚本', async () => {
    const value = await run('modpack_setup_env', {
      packDir,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      memoryGb: 8,
      launcher: 'prism',
    })
    expect(value.javaMajor).toBe(17)
    expect(value.memoryGb).toBe(8)
    expect(value.jvmArgs).toContain('-Xmx8G')
    expect(value.jvmArgs).toContain('-XX:+UseG1GC')
    expect(value.files).toEqual(expect.arrayContaining(['jvm-args.txt', 'instance.cfg', 'start.bat', 'start.sh', 'launcher-profile.json']))
    const cfg = await readFile(join(packDir, 'instance.cfg'), 'utf8')
    expect(cfg).toContain('MaxMemAlloc=8192')
  })

  it('Java 版本映射覆盖 1.16.5 / 1.20.4 / 1.20.5', async () => {
    const old = await run('modpack_setup_env', { packDir, minecraftVersion: '1.16.5', loader: 'forge' })
    expect(old.javaMajor).toBe(8)
    const mid = await run('modpack_setup_env', { packDir, minecraftVersion: '1.20.4', loader: 'forge' })
    expect(mid.javaMajor).toBe(17)
    const modern = await run('modpack_setup_env', { packDir, minecraftVersion: '1.20.5', loader: 'neoforge' })
    expect(modern.javaMajor).toBe(21)
  })
})

describe('阶段三：配置与内容定制', () => {
  it('modpack_gen_config 写 options.txt / server.properties / 模组配置，并给出路径建议', async () => {
    const value = await run('modpack_gen_config', {
      packDir,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      files: [
        { path: 'config/sodium-options.json', format: 'json', content: { quality: { weather_quality: 'FAST' } } },
        { path: 'config/iris.properties', format: 'properties', content: { enableShaders: true } },
      ],
      clientOptions: { renderDistance: 12, guiScale: 3, language: 'zh_cn' },
      serverProperties: { 'view-distance': 8, difficulty: 'hard' },
      modIds: ['sodium', 'some-unknown-mod'],
    })
    expect(value.written).toHaveLength(4)
    expect(value.written.map((item: Record<string, string>) => item.path)).toEqual(
      expect.arrayContaining(['config/sodium-options.json', 'config/iris.properties']),
    )
    expect(value.unknownModIds).toEqual(['some-unknown-mod'])
    const sodium = JSON.parse(await readFile(join(packDir, 'config', 'sodium-options.json'), 'utf8')) as { quality: { weather_quality: string } }
    expect(sodium.quality.weather_quality).toBe('FAST')
    const options = await readFile(join(packDir, 'options.txt'), 'utf8')
    expect(options).toContain('renderDistance:12')
    const server = await readFile(join(packDir, 'server.properties'), 'utf8')
    expect(server).toContain('difficulty=hard')
  })

  it('modpack_gen_config 深合并已有 JSON 而不是覆盖', async () => {
    await writeFile(join(packDir, 'config', 'deep.json'), JSON.stringify({ a: 1, nested: { x: 1, y: 2 } }))
    const value = await run('modpack_gen_config', {
      packDir,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      files: [{ path: 'config/deep.json', format: 'json', content: { nested: { y: 9, z: 3 } } }],
    })
    const written = value.written.find((item: Record<string, unknown>) => item.path === 'config/deep.json')!
    expect(written.merged).toBe(true)
    const merged = JSON.parse(await readFile(join(packDir, 'config', 'deep.json'), 'utf8')) as { a: number; nested: { x: number; y: number; z: number } }
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 9, z: 3 } })
    expect(written.backup).toBeTruthy()
  })

  it('modpack_gen_quests 生成 SNBT 并返回可复用的 questIndex', async () => {
    const value = await run('modpack_gen_quests', {
      packDir,
      title: '科技线',
      chapters: [
        {
          title: '第 1 章 · 起步',
          filename: 'chapter_1',
          group: '主线',
          icon: 'minecraft:crafting_table',
          quests: [
            { title: '砍树', x: 0, y: 0, tasks: [{ type: 'item', item: 'oak_log', count: 8 }], rewards: [{ type: 'xp', xp: 30 }] },
            { title: '工作台', x: 2, y: 0, tasks: [{ type: 'item', item: 'crafting_table' }], rewards: [{ type: 'item', item: 'minecraft:stone_pickaxe' }] },
          ],
        },
      ],
    })
    expect(value.chapters).toBe(1)
    expect(value.quests).toBe(2)
    expect(value.questIndex[0].id).toMatch(/^[0-9A-F]{16}$/)
    const chapter = await readFile(join(packDir, 'config', 'ftbquests', 'quests', 'chapters', 'chapter_1.snbt'), 'utf8')
    expect(chapter).toContain('minecraft:oak_log')
    expect(chapter).toContain('count: 8L')
  })

  it('modpack_gen_readme 生成中文与英文两版 README', async () => {
    const value = await run('modpack_gen_readme', {
      packDir,
      name: '科技整合包',
      version: '1.0.0',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      theme: '深蓝色科技风',
      authors: ['tester'],
      memoryGb: 8,
      modList: [{ slug: 'sodium', title: 'Sodium', author: 'CaffeineMC', license: 'LGPL-3.0', url: 'https://modrinth.com/mod/sodium' }],
      chapters: ['第 1 章 · 起步'],
      language: 'both',
    })
    expect(value.files).toEqual(['README.md', 'README.en.md'])
    const zh = await readFile(join(packDir, 'README.md'), 'utf8')
    expect(zh).toContain('科技整合包 1.0.0')
    expect(zh).toContain('Java 17')
    expect(zh).toContain('Sodium')
  })
})

describe('阶段四：界面设计（离线部分）', () => {
  it('modpack_gen_ui_theme 产出配色、6 面全景 prompt 与 PackMenu 布局骨架', async () => {
    const value = await run('modpack_gen_ui_theme', {
      packDir,
      theme: '深蓝色科技风',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      menuStyle: 'panorama',
    })
    expect(value.palette.primary).toBe('#1E3A8A')
    expect(value.panoramaPrompts).toHaveLength(6)
    expect(value.panoramaPrompts.map((item: Record<string, string>) => item.direction)).toEqual(['north', 'east', 'south', 'west', 'up', 'down'])
    expect(value.layout).toHaveLength(5)
    expect(value.uiStack).toContain('packmenu') // Forge 侧才有 PackMenu
    expect(value.packMenuHints.some((hint: string) => hint.includes('buttons/'))).toBe(true)
    const plan = JSON.parse(await readFile(join(packDir, 'ui', 'theme-plan.json'), 'utf8')) as { prompts: { panorama: unknown[] } }
    expect(plan.prompts.panorama).toHaveLength(6)
  })

  it('Fabric 侧不推荐 PackMenu，而是给出 Vistas 方案', async () => {
    const value = await run('modpack_gen_ui_theme', {
      packDir,
      theme: '东方魔法冒险',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(value.uiStack).toContain('vistas')
    expect(value.uiStack).not.toContain('packmenu')
    expect(value.palette.accent).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('modpack_assemble_ui_pack 组装资源包、按钮 JSON、Polytone 与 packmenu 镜像', async () => {
    const value = await run('modpack_assemble_ui_pack', {
      packDir,
      packName: 'tech-ui',
      namespace: 'techui',
      minecraftVersion: '1.20.1',
      buttons: [
        { name: 'play', text: '开始游戏', action: 'OPEN_GUI', data: 'SINGLEPLAYER', anchor: 'DEFAULT' },
        { name: 'quit', text: '退出游戏', action: 'QUIT' },
      ],
      modifiers: [{ name: 'inventory-tweak', targetType: 'menu_id', target: 'minecraft:inventory', titleXOffset: -10 }],
      vistas: [{ cubemapId: 'techui:textures/gui/title/background/panorama' }],
      packMenu: { folderPack: true, slideshowTextures: [] },
      lang: { 'techui.button.custom': '自定义按钮' },
    })
    expect(value.packFormat).toBe(15)
    expect(value.buttonCount).toBe(2)
    expect(value.modifierCount).toBe(1)
    expect(value.files).toContain('pack.mcmeta')
    const button = JSON.parse(await readFile(join(packDir, 'resourcepacks', 'tech-ui', 'assets', 'techui', 'buttons', 'play.json'), 'utf8')) as Record<string, unknown>
    expect(button.action).toBe('OPEN_GUI')
    expect(button.data).toBe('SINGLEPLAYER')
    const modifier = JSON.parse(
      await readFile(join(packDir, 'resourcepacks', 'tech-ui', 'assets', 'techui', 'polytone', 'gui_modifiers', 'inventory-tweak.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(modifier.target_type).toBe('menu_id')
    expect(modifier.title_x_offset).toBe(-10)
    // 按钮同时同步到 PackMenu 的 folder pack
    const mirror = await readFile(join(packDir, 'packmenu', 'resources', 'assets', 'techui', 'buttons', 'play.json'), 'utf8')
    expect(mirror).toContain('OPEN_GUI')
  })

  it('modpack_assemble_ui_pack 会拒绝非法纹理路径', async () => {
    await expect(
      tool('modpack_assemble_ui_pack').execute(
        {
          packDir,
          packName: 'bad-ui',
          minecraftVersion: '1.20.1',
          textures: [{ path: 'assets/bad/textures/gui/x.webp', base64: Buffer.from('x').toString('base64') }],
        },
        fakeExec,
      ),
    ).rejects.toThrow(/路径非法/)
  })
})

describe('阶段五：本地化', () => {
  it('modpack_scan_i18n 扫出缺失键并写报告', async () => {
    const dir = await makeTempDir('dsh-tool-i18n-')
    await mkdir(join(dir, 'resourcepacks', 'p', 'assets', 'mypack', 'lang'), { recursive: true })
    await writeFile(
      join(dir, 'resourcepacks', 'p', 'assets', 'mypack', 'lang', 'en_us.json'),
      JSON.stringify({ 'mypack.a': 'Play', 'mypack.b': 'Options' }),
    )
    const value = await run('modpack_scan_i18n', { packDir: dir, targetLocales: ['zh_cn'] })
    expect(value.stats.missingKeys).toBe(2)
    expect(value.reportPath).toBeTruthy()
    const report = await readFile(value.reportPath, 'utf8')
    expect(report).toContain('本地化扫描报告')
  })

  it('modpack_translate 写语言文件，术语表兜底生效', async () => {
    const dir = await makeTempDir('dsh-tool-i18n2-')
    const value = await run('modpack_translate', {
      packDir: dir,
      minecraftVersion: '1.20.1',
      targetLocales: ['zh_cn'],
      entries: [
        { key: 'mypack.a', text: 'Play' },
        { key: 'mypack.b', text: 'Options' },
        { key: 'mypack.c', text: 'Something Not In Glossary' },
      ],
      translations: { zh_cn: { 'mypack.a': '开始游戏' } },
    })
    expect(value.packFormat).toBe(15)
    expect(value.perLocale[0].fromInput).toBe(1)
    expect(value.perLocale[0].fromGlossary).toBe(2)
    const lang = JSON.parse(await readFile(join(dir, 'resourcepacks', 'i18n-pack', 'assets', 'i18n-pack', 'lang', 'zh_cn.json'), 'utf8')) as Record<string, string>
    expect(lang['mypack.a']).toBe('开始游戏')
    expect(lang['mypack.b']).toBe('选项')
  })
})

describe('阶段六：测试与验证', () => {
  it('modpack_validate 校验结构并报告统计', async () => {
    const dir = await makeTempDir('dsh-tool-validate-')
    await mkdir(join(dir, 'mods'), { recursive: true })
    await mkdir(join(dir, 'config'), { recursive: true })
    await writeFile(join(dir, 'mods', 'sodium-fabric-0.5.13.jar'), Buffer.alloc(4096, 1))
    await writeFile(join(dir, 'config', 'bad.json'), '{ not json }')
    await writeFile(join(dir, 'config', 'ok.json'), '{"a":1}')

    const value = await run('modpack_validate', {
      packDir: dir,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(value.ok).toBe(false)
    expect(value.verdict).toBe('broken')
    expect(value.issues.some((issue: Record<string, string>) => issue.code === 'CONFIG_SYNTAX')).toBe(true)
    expect(value.stats.mods).toBe(1)
    expect(value.reportPath).toBeTruthy()
  })

  it('modpack_validate 能发现凭据类文件（发布前硬性检查）', async () => {
    const dir = await makeTempDir('dsh-tool-validate2-')
    await mkdir(join(dir, 'mods'), { recursive: true })
    await mkdir(join(dir, 'config'), { recursive: true })
    await writeFile(join(dir, 'mods', 'lithium-fabric-1.0.jar'), Buffer.alloc(2048, 1))
    // 运行时拼接，避免仓库里出现形似真实密钥的字面量（也避免被 GitHub push protection 误拦）
    const fakeKey = ['sk', '-', 'F'.repeat(24)].join('')
    await writeFile(join(dir, 'config', 'leaky.json'), `{"api_key":"${fakeKey}"}`)
    const value = await run('modpack_validate', { packDir: dir, minecraftVersion: '1.20.1', loader: 'fabric' })
    expect(value.issues.some((issue: Record<string, string>) => issue.code === 'SECRET_LEAK')).toBe(true)
  })

  it('modpack_gen_test_plan 产出分类检查清单并可落盘', async () => {
    const value = await run('modpack_gen_test_plan', {
      packName: '科技整合包',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      theme: '科技',
      features: ['科技', '任务书', '光影', '自定义主界面'],
      modCount: 180,
      targetFps: 90,
      serverSide: true,
      memoryGb: 8,
      packDir,
    })
    expect(value.itemCount).toBeGreaterThan(20)
    expect(value.checklist.length).toBeGreaterThanOrEqual(6)
    expect(value.checklist.some((section: Record<string, string>) => section.section.includes('光影'))).toBe(true)
    expect(value.markdown).toContain('| 编号 | 操作 | 期望结果 | 级别 | 结果 |')
    const file = await readFile(join(packDir, 'TEST-PLAN.md'), 'utf8')
    expect(file).toContain('90 FPS')
  })
})

describe('阶段七：打包与发布', () => {
  it('modpack_check_conflicts 能从 mods/ 目录读出冲突', async () => {
    const dir = await makeTempDir('dsh-tool-conflict-')
    await mkdir(join(dir, 'mods'), { recursive: true })
    await writeFile(join(dir, 'mods', 'sodium-fabric-0.5.13.jar'), Buffer.alloc(2048, 1))
    await writeFile(join(dir, 'mods', 'optifine-1.20.1.jar'), Buffer.alloc(2048, 1))
    const value = await run('modpack_check_conflicts', { packDir: dir, minecraftVersion: '1.20.1', loader: 'fabric' })
    expect(value.verdict).toBe('conflict')
    expect(value.knownPairs.length).toBeGreaterThan(0)
  })

  it('modpack_export 产出 mrpak / curseforge / manual 三种格式', async () => {
    const dir = await makeTempDir('dsh-tool-export-')
    await mkdir(join(dir, 'mods'), { recursive: true })
    await mkdir(join(dir, 'config'), { recursive: true })
    await writeFile(join(dir, 'mods', 'sodium-fabric-0.5.13.jar'), Buffer.alloc(4096, 7))
    await writeFile(join(dir, 'config', 'sodium-options.json'), '{"quality":{"weather_quality":"FAST"}}')

    const value = await run('modpack_export', {
      packDir: dir,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      name: '科技整合包',
      version: '1.0.0',
      formats: ['mrpak', 'curseforge', 'manual'],
      mods: [{ slug: 'sodium', projectId: 'AANobbMI', title: 'Sodium', versionId: 'V1', fileName: 'sodium-fabric-0.5.13.jar', required: true }],
      curseforgeIds: { AANobbMI: { projectID: 394468, fileID: 4567890 } },
    })
    expect(value.results).toHaveLength(3)
    expect(value.totalSize).toBeGreaterThan(0)
    const formats = value.results.map((item: Record<string, string>) => item.format).sort()
    expect(formats).toEqual(['curseforge', 'manual', 'mrpak'])
    const { readZip } = await import('../src/packer.js')
    const mrpak = value.results.find((item: Record<string, string>) => item.format === 'mrpak')!
    const entries = readZip(new Uint8Array(await readFile(mrpak.path)))
    expect(entries.some((entry) => entry.path === 'mrpak.json')).toBe(true)
    expect(entries.some((entry) => entry.path === 'manifest.json')).toBe(true)
  })

  it('modpack_publish 产出多平台元数据并做合规检查', async () => {
    const dir = await makeTempDir('dsh-tool-publish-')
    await mkdir(join(dir, 'mods'), { recursive: true })
    await mkdir(join(dir, 'config'), { recursive: true })
    await writeFile(join(dir, 'mods', 'sodium-fabric-0.5.13.jar'), Buffer.alloc(4096, 7))
    await writeFile(join(dir, 'pack.zip'), Buffer.alloc(2048, 3))

    const value = await run('modpack_publish', {
      packDir: dir,
      name: '科技整合包',
      version: '1.0.0',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      authors: ['tester'],
      summary: '一个深蓝色科技风整合包',
      changes: ['新增任务书', '替换主界面'],
      license: 'MIT',
      platforms: ['modrinth', 'curseforge', 'github', 'mcbbs'],
      autoDetectArtifacts: true,
    })
    expect(value.ok).toBe(true)
    expect(value.files).toContain('modrinth-version.json')
    expect(value.files).toContain('curseforge-metadata.json')
    expect(value.files).toContain('github-release.json')
    expect(value.files).toContain('PUBLISH-README.md')
    expect(value.compliance.verdict).toBe('ok')
    expect(value.steps).toHaveLength(4)
    const modrinth = JSON.parse(await readFile(join(value.outDir, 'modrinth-version.json'), 'utf8')) as { version_number: string; loaders: string[]; game_versions: string[] }
    expect(modrinth.version_number).toBe('1.0.0')
    expect(modrinth.loaders).toEqual(['fabric'])
    expect(modrinth.game_versions).toEqual(['1.20.1'])
    const checksums = await readFile(join(value.outDir, 'checksums.txt'), 'utf8')
    expect(checksums).toContain('sha256')
  })

  it('没有产物时明确报错而不是产出空发布包', async () => {
    const dir = await makeTempDir('dsh-tool-publish2-')
    await expect(
      tool('modpack_publish').execute(
        { packDir: dir, name: 'x', version: '1.0.0', minecraftVersion: '1.20.1', loader: 'fabric' },
        fakeExec,
      ),
    ).rejects.toThrow(/没有可发布的产物/)
  })

  it('版本号不合法时拒绝生成发布元数据', async () => {
    const dir = await makeTempDir('dsh-tool-publish3-')
    await writeFile(join(dir, 'pack.zip'), Buffer.alloc(1024, 1))
    await expect(
      tool('modpack_publish').execute(
        { packDir: dir, name: 'x', version: 'v1', minecraftVersion: '1.20.1', loader: 'fabric' },
        fakeExec,
      ),
    ).rejects.toThrow(/版本号格式不规范/)
  })
})
