/**
 * ui-pack.ts 行为测试：pack_format 推导、资源包路径校验、PackMenu / Polytone / Vistas JSON 结构、
 * 完整资源包组装（目录结构 + packmenu 镜像 + zip）。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  UI_ASSET_PATHS,
  assembleUiPack,
  buildPackMenuButton,
  buildPackMenuConfig,
  buildPolytoneModifier,
  buildVistasPanoramas,
  packFormatFor,
  placeholderFramedTexture,
  renderPackMcmeta,
  validateUiAssetPath,
  zipUiTextures,
  type PackMenuButton,
} from '../src/ui-pack.js'

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('pack_format 推导', () => {
  it('覆盖 1.16 / 1.19.4 / 1.20.1 / 1.20.6 / 1.21.4 等关键版本', () => {
    expect(packFormatFor('1.16.5').pack_format).toBe(6)
    expect(packFormatFor('1.17.1').pack_format).toBe(7)
    expect(packFormatFor('1.19.4').pack_format).toBe(13)
    expect(packFormatFor('1.20.1').pack_format).toBe(15)
    expect(packFormatFor('1.20.2').pack_format).toBe(18)
    expect(packFormatFor('1.20.6').pack_format).toBe(32)
    expect(packFormatFor('1.21.1').pack_format).toBe(34)
    expect(packFormatFor('1.21.4').pack_format).toBe(46)
    expect(packFormatFor('1.21.8').pack_format).toBe(64)
  })

  it('1.20.2+ 会带上 supported_formats 区间', () => {
    const info = packFormatFor('1.20.2')
    expect(info.supported_formats).toEqual({ min_inclusive: 18, max_inclusive: 18 })
    // 1.20.2 之前的版本不认识 supported_formats，不应写进去
    const older = packFormatFor('1.16.5')
    expect(older.supported_formats).toBeUndefined()
    expect(packFormatFor('1.20.1').supported_formats).toBeUndefined()
  })

  it('未知/更新的版本号回落并给出说明', () => {
    const info = packFormatFor('26.1')
    expect(info.exact).toBe(false)
    expect(info.note).toContain('未覆盖')
    const mcmeta = renderPackMcmeta('26.1', 'test pack')
    const parsed = JSON.parse(mcmeta.text) as { pack: { pack_format: number; description: string } }
    expect(parsed.pack.pack_format).toBe(info.pack_format)
    expect(parsed.pack.description).toBe('test pack')
  })
})

describe('资源包路径校验', () => {
  it('接受规范路径', () => {
    expect(validateUiAssetPath('assets/mypack/textures/gui/title/background/panorama_0.png').ok).toBe(true)
    expect(validateUiAssetPath('assets/mypack/textures/gui/sprites/icon/gear.png').ok).toBe(true)
    expect(validateUiAssetPath('assets/mypack/buttons/play.json').ok).toBe(true)
    expect(validateUiAssetPath('assets/mypack/polytone/gui_modifiers/inventory.json').ok).toBe(true)
    expect(validateUiAssetPath('assets/mypack/lang/zh_cn.json').ok).toBe(true)
  })

  it('拒绝会让资源包静默失效的路径', () => {
    expect(validateUiAssetPath('resourcepacks/mypack/assets/mypack/textures/x.png').ok).toBe(false)
    expect(validateUiAssetPath('assets/mypack/../other/textures/x.png').ok).toBe(false)
    expect(validateUiAssetPath('assets/MyPack/textures/gui/x.png').reason).toContain('命名空间非法')
    expect(validateUiAssetPath('assets/mypack/textures/gui/x.webp').reason).toContain('必须是 PNG')
    expect(validateUiAssetPath('assets/mypack/models/x.json').reason).toContain('只允许')
    expect(validateUiAssetPath('').ok).toBe(false)
  })

  it('关键目录常量与原版资源包布局一致', () => {
    expect(UI_ASSET_PATHS.background).toBe('textures/gui/title/background')
    expect(UI_ASSET_PATHS.sprites).toBe('textures/gui/sprites')
    expect(UI_ASSET_PATHS.widgets).toBe('textures/gui/widgets.png')
    expect(UI_ASSET_PATHS.panoramaOverlay).toBe('textures/gui/title/background/panorama_overlay.png')
  })
})

describe('PackMenu 按钮 JSON', () => {
  it('字段名严格对齐 JsonButton.deserialize，并自动生成 langKey', () => {
    const button: PackMenuButton = {
      name: 'play',
      text: '开始游戏',
      action: 'OPEN_GUI',
      data: 'SINGLEPLAYER',
      x: 0,
      y: 16,
      width: 200,
      height: 20,
      texture: 'mypack:textures/gui/sprites/widget/primary.png',
      u: 0,
      v: 0,
      hoverU: 0,
      hoverV: 20,
      texWidth: 200,
      texHeight: 60,
      anchor: 'DEFAULT',
      fontColor: '#E8EDF7',
    }
    const built = buildPackMenuButton(button, 'mypack')
    expect(built.langKey).toBe('mypack.button.play')
    expect(built.json.action).toBe('OPEN_GUI')
    expect(built.json.data).toBe('SINGLEPLAYER')
    expect(built.json.anchor).toBe('DEFAULT')
    expect(built.json.widgets).toBe(false)
    expect(built.json.fontColor).toBe(0xe8edf7)
    expect(Object.keys(built.json).sort()).toEqual(
      ['action', 'anchor', 'data', 'fontColor', 'height', 'hoverU', 'hoverV', 'langKey', 'texHeight', 'texWidth', 'texture', 'u', 'v', 'widgets', 'width', 'x', 'y'].sort(),
    )
  })

  it('需要 data 的动作缺 data，或 OPEN_GUI 的界面名非法时报错', () => {
    expect(() => buildPackMenuButton({ name: 'join', action: 'CONNECT_TO_SERVER' }, 'mypack')).toThrow(/必须提供 data/)
    expect(() => buildPackMenuButton({ name: 'gui', action: 'OPEN_GUI', data: 'NOT_A_SCREEN' }, 'mypack')).toThrow(/ScreenType/)
    expect(() => buildPackMenuButton({ name: 'bad', action: 'NOPE' as never }, 'mypack')).toThrow(/未知的 PackMenu action/)
    const maybe = buildPackMenuButton({ name: 'quit', action: 'QUIT', data: 'ignored' }, 'mypack')
    expect(maybe.warning).toContain('不接受 data')
  })

  it('config/packmenu.json 结构包含 general / slideshow 分组', () => {
    const config = buildPackMenuConfig({
      folderPack: true,
      slideshowTextures: ['mypack:textures/gui/title/background/background.png'],
      panoramaVariations: 3,
    }) as { general: Record<string, unknown> }
    expect(config.general['Folder Pack']).toBe(true)
    expect(config.general['Panorama Variations']).toBe(3)
    const slideshow = config.general.slideshow as { Textures: string[] }
    expect(slideshow.Textures).toHaveLength(1)
  })
})

describe('Polytone / Vistas JSON', () => {
  it('gui_modifiers 字段对齐 GuiModifier.CODEC', () => {
    const json = buildPolytoneModifier({
      name: 'inventory-tweak',
      targetType: 'screen_class',
      target: 'net.minecraft.client.gui.screens.inventory.InventoryScreen',
      titleXOffset: -10,
      titleColor: '#1E3A8A',
      sprites: [{ texture: 'mypack:widget/frame', x: 0, y: 0, width: 176, height: 166, z: 2 }],
      texts: [{ text: '背包', x: 8, y: 6, centered: false }],
    })
    expect(json.target_type).toBe('screen_class')
    expect(json.title_x_offset).toBe(-10)
    expect(json.title_color).toBe(0x1e3a8a)
    expect((json.sprites as unknown[])[0]).toMatchObject({ texture: 'mypack:widget/frame', z: 2 })
    expect((json.texts as unknown[])[0]).toMatchObject({ text: '背包', centered: false })
  })

  it('Vistas panoramas.json 使用 cubemapId 与 rotationControl', () => {
    const json = buildVistasPanoramas([
      { cubemapId: 'mypack:textures/gui/title/background/panorama', musicSound: 'minecraft:music.menu' },
    ])
    const first = json.panorama_0 as { cubemaps: Array<{ cubemapId: string; rotationControl: { frozen: boolean } }> }
    expect(first.cubemaps[0]!.cubemapId).toBe('mypack:textures/gui/title/background/panorama')
    expect(first.cubemaps[0]!.rotationControl.frozen).toBe(false)
  })
})

describe('assembleUiPack', () => {
  it('组装出可用的资源包：pack.mcmeta + 纹理 + 按钮 + Polytone + lang + packmenu 镜像', async () => {
    const packDir = await makeTempDir('dsh-uipack-')
    const texture = placeholderFramedTexture(200, 20, { base: '#1E3A8A', accent: '#38BDF8' })

    const result = await assembleUiPack({
      packDir,
      packName: 'tech-ui',
      namespace: 'techui',
      minecraftVersion: '1.20.1',
      description: '科技风界面',
      textures: [
        { path: 'assets/techui/textures/gui/title/background/panorama_0.png', data: texture, role: 'panorama-0' },
        { path: 'assets/techui/textures/gui/sprites/widget/primary.png', data: texture, role: 'button' },
      ],
      buttons: [
        { name: 'play', text: '开始游戏', action: 'OPEN_GUI', data: 'SINGLEPLAYER', anchor: 'DEFAULT' },
        { name: 'quit', text: '退出', action: 'QUIT' },
      ],
      packMenu: { folderPack: true, slideshowTextures: [] },
      modifiers: [{ name: 'inventory-tweak', targetType: 'menu_id', target: 'minecraft:inventory', titleXOffset: -10 }],
      vistas: [{ cubemapId: 'techui:textures/gui/title/background/panorama' }],
      lang: { 'techui.button.custom': '自定义' },
    })

    expect(result.packFormat).toBe(15)
    expect(result.textureCount).toBe(2)
    expect(result.buttonCount).toBe(2)
    expect(result.modifierCount).toBe(1)
    // 自动补齐的两个按钮文案 + 手动给的一条
    expect(result.langKeys).toBe(3)

    const root = result.resourcePackDir
    expect(await exists(join(root, 'pack.mcmeta'))).toBe(true)
    expect(await exists(join(root, 'assets/techui/textures/gui/title/background/panorama_0.png'))).toBe(true)
    expect(await exists(join(root, 'assets/techui/textures/gui/sprites/widget/primary.png'))).toBe(true)
    expect(await exists(join(root, 'assets/techui/buttons/play.json'))).toBe(true)
    expect(await exists(join(root, 'assets/techui/polytone/gui_modifiers/inventory-tweak.json'))).toBe(true)
    expect(await exists(join(root, 'assets/techui/panoramas.json'))).toBe(true)
    expect(await exists(join(root, 'assets/techui/lang/en_us.json'))).toBe(true)
    expect(await exists(join(packDir, 'config/packmenu.json'))).toBe(true)
    // PackMenu 的 folder pack 目录也要有按钮
    expect(await exists(join(packDir, 'packmenu/resources/assets/techui/buttons/play.json'))).toBe(true)

    const lang = JSON.parse(await readFile(join(root, 'assets/techui/lang/en_us.json'), 'utf8')) as Record<string, string>
    expect(lang['techui.button.play']).toBe('开始游戏')
    expect(lang['techui.button.custom']).toBe('自定义')

    const button = JSON.parse(await readFile(join(root, 'assets/techui/buttons/play.json'), 'utf8')) as Record<string, unknown>
    expect(button.action).toBe('OPEN_GUI')
    expect(button.data).toBe('SINGLEPLAYER')

    const mcmeta = JSON.parse(await readFile(join(root, 'pack.mcmeta'), 'utf8')) as { pack: { pack_format: number } }
    expect(mcmeta.pack.pack_format).toBe(15)
  })

  it('非法纹理路径直接抛错，不写出资源包', async () => {
    const packDir = await makeTempDir('dsh-uipack2-')
    await expect(
      assembleUiPack({
        packDir,
        packName: 'bad-ui',
        minecraftVersion: '1.20.1',
        textures: [{ path: 'assets/bad/textures/gui/x.jpeg', data: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/路径非法/)
    expect(await exists(join(packDir, 'resourcepacks/bad-ui/assets'))).toBe(false)
  })

  it('zip 选项产出可解析的资源包压缩包', async () => {
    const packDir = await makeTempDir('dsh-uipack3-')
    const texture = placeholderFramedTexture(16, 16, { base: '#1E3A8A', accent: '#38BDF8' })
    const result = await assembleUiPack({
      packDir,
      packName: 'zip-ui',
      minecraftVersion: '1.20.1',
      textures: [{ path: 'assets/zipui/textures/gui/sprites/icon/gear.png', data: texture }],
      buttons: [{ name: 'play', text: 'Play', action: 'OPEN_GUI', data: 'SINGLEPLAYER' }],
      zip: true,
    })
    expect(result.zipPath).not.toBeNull()
    const { readZip } = await import('../src/packer.js')
    const zip = readZip(new Uint8Array(await readFile(result.zipPath!)))
    expect(zip.some((entry) => entry.path === 'pack.mcmeta')).toBe(true)
    expect(zip.some((entry) => entry.path === 'assets/zipui/textures/gui/sprites/icon/gear.png')).toBe(true)
    // 未显式给 namespace 时由 packName('zip-ui') 派生
    expect(zip.some((entry) => entry.path === 'assets/zip-ui/buttons/play.json')).toBe(true)
  })

  it('zipUiTextures 也会做路径校验并给出条目清单', async () => {
    const packDir = await makeTempDir('dsh-uipack4-')
    const file = join(packDir, 'ui.zip')
    const texture = placeholderFramedTexture(16, 16, { base: '#000000', accent: '#FFFFFF' })
    const result = await zipUiTextures(file, [{ path: 'assets/zipui/textures/gui/sprites/icon/a.png', data: texture }], '1.20.1', 'test')
    expect(result.packFormat).toBe(15)
    expect(result.entries).toEqual(['assets/zipui/textures/gui/sprites/icon/a.png', 'pack.mcmeta'])
    await expect(
      zipUiTextures(file, [{ path: 'wrong/path.png', data: texture }], '1.20.1', 'test'),
    ).rejects.toThrow(/路径非法/)
  })
})
