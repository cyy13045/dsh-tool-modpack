/**
 * packer.ts 行为测试：zip 读写往返、目录收集过滤、mrpak / CurseForge / 手动整包导出。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildZip,
  collectFiles,
  exportCurseForgeZip,
  exportManualZip,
  exportMrpak,
  readZip,
} from '../src/packer.js'

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const encoder = new TextEncoder()

describe('buildZip / readZip', () => {
  it('写入后能原样读回内容与路径', () => {
    const entries = [
      { path: 'pack.mcmeta', data: encoder.encode('{"pack":{"pack_format":15}}') },
      { path: 'assets/mypack/textures/gui/title/background/panorama_0.png', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { path: 'assets/mypack/buttons/play.json', data: encoder.encode('{"action":"OPEN_GUI"}') },
    ]
    const zip = buildZip(entries)
    expect(zip.byteLength).toBeGreaterThan(0)
    const read = readZip(zip)
    expect(read.map((entry) => entry.path)).toEqual([
      'pack.mcmeta',
      'assets/mypack/textures/gui/title/background/panorama_0.png',
      'assets/mypack/buttons/play.json',
    ])
    expect(new TextDecoder().decode(read[0]!.data)).toBe('{"pack":{"pack_format":15}}')
    expect([...read[1]!.data]).toEqual([1, 2, 3, 4, 5])
  })

  it('随机二进制内容经 deflate 往返后完全一致', () => {
    const payload = new Uint8Array(4096)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) % 256
    const zip = buildZip([{ path: 'mods/blob.bin', data: payload }])
    const read = readZip(zip)
    expect(read).toHaveLength(1)
    expect([...read[0]!.data]).toEqual([...payload])
  })

  it('非 zip 字节会抛出明确错误', () => {
    expect(() => readZip(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow(/EOCD/)
  })
})

describe('collectFiles', () => {
  it('跳过 logs / saves 等噪声目录，只收集白名单顶层目录', async () => {
    const root = await makeTempDir('dsh-collect-')
    await writeFile(join(root, 'keep.txt'), 'a')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'mods'), { recursive: true })
    await mkdir(join(root, 'logs'), { recursive: true })
    await mkdir(join(root, 'saves'), { recursive: true })
    await writeFile(join(root, 'mods', 'sodium.jar'), 'jar')
    await writeFile(join(root, 'logs', 'latest.log'), 'log')
    await writeFile(join(root, 'saves', 'world.dat'), 'world')

    const all = await collectFiles(root)
    expect(all.map((file) => file.path)).toEqual(['keep.txt', 'mods/sodium.jar'])

    const onlyMods = await collectFiles(root, { include: ['mods'] })
    expect(onlyMods.map((file) => file.path)).toEqual(['mods/sodium.jar'])
  })

  it('exclude 与 skipPattern 生效', async () => {
    const root = await makeTempDir('dsh-collect2-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config', 'a.json'), '{}')
    await writeFile(join(root, 'config', 'secret.json'), '{}')

    const excluded = await collectFiles(root, { exclude: ['secret.json'] })
    expect(excluded.map((file) => file.path)).toEqual(['config/a.json'])

    const pattern = await collectFiles(root, { skipPattern: /a\.json$/ })
    expect(pattern.map((file) => file.path)).toEqual(['config/secret.json'])
  })
})

describe('exportMrpak / exportCurseForgeZip / exportManualZip', () => {
  async function makePack(): Promise<string> {
    const root = await makeTempDir('dsh-pack-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'mods'), { recursive: true })
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'mods', 'sodium-1.0.0.jar'), 'fake jar bytes')
    await writeFile(join(root, 'config', 'sodium-options.json'), '{"quality":{}}')
    return root
  }

  const mods = [
    {
      projectId: 'AANobbMI',
      slug: 'sodium',
      title: 'Sodium',
      versionId: 'V1',
      fileName: 'sodium-1.0.0.jar',
      path: 'mods/sodium-1.0.0.jar',
      sha1: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
      size: 14,
      url: 'https://cdn.example.test/sodium.jar',
      required: true,
    },
  ]

  it('mrpak 包含 mrpak.json 清单与 CurseForge 兼容 manifest.json', async () => {
    const root = await makePack()
    const out = join(root, 'dist', 'my-pack-1.0.0.mrpak')
    const result = await exportMrpak({
      packDir: root,
      outFile: out,
      name: 'my-pack',
      version: '1.0.0',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      mods,
    })
    expect(result.format).toBe('mrpak')
    expect(result.entryCount).toBeGreaterThanOrEqual(4)
    expect(result.entries).toContain('mrpak.json')
    expect(result.entries).toContain('manifest.json')
    expect(result.entries).toContain('mods/sodium-1.0.0.jar')
    expect(result.sha256).toHaveLength(64)

    const zip = readZip(new Uint8Array(await readFile(out)))
    const manifestEntry = zip.find((entry) => entry.path === 'mrpak.json')!
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Record<string, unknown>
    expect(manifest.format).toBe('mrpak')
    expect(manifest.formatVersion).toBe(1)
    expect((manifest.minecraft as Record<string, unknown>).loader).toBe('fabric')
    expect((manifest.mods as unknown[]).length).toBe(1)
    expect((manifest.files as unknown[]).length).toBe(2)

    const cfEntry = zip.find((entry) => entry.path === 'manifest.json')!
    const cf = JSON.parse(new TextDecoder().decode(cfEntry.data)) as Record<string, unknown>
    expect(cf.manifestType).toBe('minecraftModpack')
    expect((cf.minecraft as Record<string, unknown>).version).toBe('1.20.1')
  })

  it('CurseForge zip 把 config 放进 overrides/ 并写入数字 id', async () => {
    const root = await makePack()
    const out = join(root, 'dist', 'cf.zip')
    const result = await exportCurseForgeZip({
      packDir: root,
      outFile: out,
      name: 'my-pack',
      version: '1.0.0',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      mods,
      curseforgeIds: { AANobbMI: { projectID: 394468, fileID: 4567890 } },
    })
    expect(result.format).toBe('curseforge')
    expect(result.entries).toContain('overrides/config/sodium-options.json')
    expect(result.notes).toEqual([])

    const zip = readZip(new Uint8Array(await readFile(out)))
    const cf = JSON.parse(new TextDecoder().decode(zip.find((entry) => entry.path === 'manifest.json')!.data)) as {
      files: Array<{ projectID: number; fileID: number }>
      overrides: string
    }
    expect(cf.overrides).toBe('overrides')
    expect(cf.files).toEqual([{ projectID: 394468, fileID: 4567890, required: true }])
  })

  it('缺少 CurseForge 数字 id 时降级并留下说明，不静默丢模组', async () => {
    const root = await makePack()
    const out = join(root, 'dist', 'cf-noid.zip')
    const result = await exportCurseForgeZip({
      packDir: root,
      outFile: out,
      name: 'my-pack',
      version: '1.0.0',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      mods,
    })
    expect(result.notes.some((note) => note.includes('CurseForge 数字 id'))).toBe(true)
    const zip = readZip(new Uint8Array(await readFile(out)))
    expect(zip.some((entry) => entry.path === 'overrides/mods/sodium-1.0.0.jar')).toBe(true)
  })

  it('手动整包保持原始目录结构', async () => {
    const root = await makePack()
    const out = join(root, 'dist', 'manual.zip')
    const result = await exportManualZip({
      packDir: root,
      outFile: out,
      name: 'my-pack',
      version: '1.0.0',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(result.format).toBe('manual')
    expect(result.entries).toContain('mods/sodium-1.0.0.jar')
    expect(result.entries).toContain('config/sodium-options.json')
    expect(result.entries.some((entry) => entry.startsWith('overrides/'))).toBe(false)
  })
})
