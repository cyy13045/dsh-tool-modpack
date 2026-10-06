/**
 * image-gen.ts 行为测试：mock fetch 断言请求参数、限速重试、缺失 Key 报错、
 * 纯 JS PNG 编码（用 sharp 反解验证）、渐变叠加层、内存抠图。
 */
import { describe, expect, it } from 'vitest'
import {
  PANORAMA_FACES,
  PollinationsProvider,
  PROVIDER_CATALOG,
  SdApiProvider,
  WanxProvider,
  buildBackgroundPrompt,
  buildPanoramaFacePrompt,
  buildUiElementPrompt,
  createImageProvider,
  defaultNegativePrompt,
  detectImageFormat,
  encodePng,
  findFirstUrl,
  gradientPng,
  imageMetadata,
  loadSharp,
  removeSolidBackground,
  resolveProviderId,
  solidPng,
  toPng,
} from '../src/image-gen.js'
import type { FetchInit, FetchResponse } from '../src/util.js'

// ── mock fetch ───────────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string
  init: FetchInit | undefined
}

function fakeResponse(options: {
  status?: number
  body?: Uint8Array | string
  contentType?: string
  headers?: Record<string, string>
}): FetchResponse {
  const status = options.status ?? 200
  const bytes = typeof options.body === 'string'
    ? new TextEncoder().encode(options.body)
    : options.body ?? new Uint8Array()
  const headers = { 'content-type': options.contentType ?? 'application/json', ...(options.headers ?? {}) }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    async text() {
      return new TextDecoder().decode(bytes)
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    },
    async arrayBuffer() {
      // 返回独立副本，避免 Buffer.from(Uint8Array) 共享底层导致后续断言互相影响
      return bytes.slice().buffer
    },
  }
}

/** 一张最小的合法 JPEG（魔数 + 少量字节，够 detectImageFormat 判断格式）。 */
function fakeJpeg(size = 512): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[3] = 0xe0
  return bytes
}

function fakePng(size = 512): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

function recordingFetch(
  handler: (url: string, init: FetchInit | undefined, call: number) => FetchResponse,
): { fetchImpl: (url: string, init?: FetchInit) => Promise<FetchResponse>; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = []
  return {
    calls,
    async fetchImpl(url: string, init?: FetchInit) {
      calls.push({ url, init })
      return handler(url, init, calls.length)
    },
  }
}

// ── provider 解析 ────────────────────────────────────────────────────────────

describe('provider 选择', () => {
  it('默认使用免 Key 的 pollinations，并支持别名', () => {
    expect(resolveProviderId(undefined)).toBe('pollinations')
    expect(resolveProviderId('')).toBe('pollinations')
    expect(resolveProviderId('Pollinations.AI')).toBe('pollinations')
    expect(resolveProviderId('wanx')).toBe('wanx')
    expect(resolveProviderId('dashscope')).toBe('wanx')
    expect(resolveProviderId('sd')).toBe('sdapi')
    expect(createImageProvider(undefined).requiresKey).toBe(false)
    expect(() => resolveProviderId('midjourney')).toThrow(/未知生图 provider/)
  })

  it('目录里 pollinations 被标注为免 Key 且有 15 秒限速', () => {
    const descriptor = PROVIDER_CATALOG.find((item) => item.id === 'pollinations')!
    expect(descriptor.requiresKey).toBe(false)
    expect(descriptor.minIntervalMs).toBe(15_000)
    expect(descriptor.defaultModel).toBe('turbo')
  })

  it('缺少 API Key 时抛出明确错误而不是静默失败', () => {
    const saved = { dash: process.env.DASHSCOPE_API_KEY, wanx: process.env.WANX_API_KEY, sd: process.env.SD_API_KEY, ws: process.env.WANX_WORKSPACE_ID }
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.WANX_API_KEY
    delete process.env.SD_API_KEY
    delete process.env.WANX_WORKSPACE_ID
    try {
      expect(() => new WanxProvider({ fetchImpl: recordingFetch(() => fakeResponse({})).fetchImpl })).toThrow(/DASHSCOPE_API_KEY/)
      expect(() => new SdApiProvider({ fetchImpl: recordingFetch(() => fakeResponse({})).fetchImpl })).toThrow(/SD_API_KEY/)
    } finally {
      if (saved.dash !== undefined) process.env.DASHSCOPE_API_KEY = saved.dash
      if (saved.wanx !== undefined) process.env.WANX_API_KEY = saved.wanx
      if (saved.sd !== undefined) process.env.SD_API_KEY = saved.sd
      if (saved.ws !== undefined) process.env.WANX_WORKSPACE_ID = saved.ws
    }
  })
})

// ── Pollinations 请求参数 ────────────────────────────────────────────────────

describe('PollinationsProvider', () => {
  it('请求 URL 带上尺寸、种子、模型、nologo 与 referrer，并返回图像字节', async () => {
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse({ body: fakeJpeg(), contentType: 'image/jpeg' }))
    const provider = new PollinationsProvider({ fetchImpl, minIntervalMs: 0, maxAttempts: 1 })

    const image = await provider.generateImage('dark blue tech panorama', {
      width: 1920,
      height: 1080,
      seed: 12345,
      model: 'flux',
    })

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://image.pollinations.ai/prompt/dark%20blue%20tech%20panorama')
    expect(url.searchParams.get('width')).toBe('1920')
    expect(url.searchParams.get('height')).toBe('1080')
    expect(url.searchParams.get('seed')).toBe('12345')
    expect(url.searchParams.get('model')).toBe('flux')
    expect(url.searchParams.get('nologo')).toBe('true')
    expect(url.searchParams.get('private')).toBe('true')
    expect(url.searchParams.get('referrer')).toBe('dsh-tool-modpack')
    expect(calls[0]!.init?.headers?.Accept).toBe('image/*')

    expect(image.provider).toBe('pollinations')
    expect(image.format).toBe('jpeg')
    expect(image.width).toBe(1920)
    expect(image.height).toBe(1080)
    expect(image.seed).toBe(12345)
    expect(image.attempts).toBe(1)
    expect(image.bytes.byteLength).toBe(512)
  })

  it('HTTP 402（额度用尽）会退避重试，第二次成功后返回', async () => {
    const { fetchImpl, calls } = recordingFetch((_url, _init, call) =>
      call === 1
        ? fakeResponse({ status: 402, body: '{}' })
        : fakeResponse({ body: fakePng(), contentType: 'image/png' }),
    )
    const provider = new PollinationsProvider({ fetchImpl, minIntervalMs: 0, retryBaseDelayMs: 1, maxAttempts: 3 })
    const image = await provider.generateImage('retry me')
    expect(calls).toHaveLength(2)
    expect(image.format).toBe('png')
    expect(image.attempts).toBe(2)
  })

  it('额度一直用尽时抛出带 402 提示的错误', async () => {
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse({ status: 402, body: '{}' }))
    const provider = new PollinationsProvider({ fetchImpl, minIntervalMs: 0, retryBaseDelayMs: 1, maxAttempts: 2 })
    await expect(provider.generateImage('nope')).rejects.toThrow(/402/)
    expect(calls).toHaveLength(2)
  })

  it('返回非图像内容时明确报错而不是写出坏文件', async () => {
    const { fetchImpl } = recordingFetch(() => fakeResponse({ body: '{"error":"content filtered"}', contentType: 'application/json' }))
    const provider = new PollinationsProvider({ fetchImpl, minIntervalMs: 0, maxAttempts: 1 })
    await expect(provider.generateImage('blocked')).rejects.toThrow(/未返回图像/)
  })
})

// ── 付费 provider 的响应解析 ─────────────────────────────────────────────────

describe('付费 provider 响应解析', () => {
  it('通义万相：POST 到 workspace 域名，并从任意层级的响应里找到图片地址再下载', async () => {
    const { fetchImpl, calls } = recordingFetch((url, init) => {
      if (url.includes('/api/v1/services/aigc/')) {
        return fakeResponse({
          body: JSON.stringify({
            output: { choices: [{ message: { content: [{ image: 'https://cdn.example.test/wanx/out.png' }] } }] },
            usage: { image_count: 1 },
          }),
        })
      }
      return fakeResponse({ body: fakePng(), contentType: 'image/png' })
    })
    const provider = new WanxProvider({
      fetchImpl,
      minIntervalMs: 0,
      maxAttempts: 1,
      apiKey: 'sk-test',
      workspaceId: 'ws-test',
    })
    const image = await provider.generateImage('深蓝色科技风背景', { width: 1024, height: 1024 })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers?.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(calls[0]!.init?.body ?? '{}') as { model: string; input: { messages: Array<{ content: Array<{ text: string }> }> }; parameters: { size: string } }
    expect(body.model).toBe('wan2.6-t2i')
    expect(body.input.messages[0]!.content[0]!.text).toBe('深蓝色科技风背景')
    expect(body.parameters.size).toBe('1024*1024')
    expect(calls[1]!.url).toBe('https://cdn.example.test/wanx/out.png')
    expect(image.remoteUrl).toBe('https://cdn.example.test/wanx/out.png')
  })

  it('提示词超过 2100 字符时直接报错', async () => {
    const { fetchImpl } = recordingFetch(() => fakeResponse({ body: '{}' }))
    const provider = new WanxProvider({ fetchImpl, minIntervalMs: 0, maxAttempts: 1, apiKey: 'sk', workspaceId: 'ws' })
    await expect(provider.generateImage('x'.repeat(2101))).rejects.toThrow(/2100/)
  })

  it('findFirstUrl 能在嵌套结构里找到第一个 URL', () => {
    expect(findFirstUrl({ a: { b: [{ 'no-url': 1 }, { image: 'https://x.test/a.png' }] } })).toBe('https://x.test/a.png')
    expect(findFirstUrl({ a: 1, b: 'not a url' })).toBeNull()
  })
})

// ── Prompt 构造 ─────────────────────────────────────────────────────────────

describe('prompt 构造', () => {
  it('背景 / 全景 / UI 元素 prompt 都带主题与风格关键词', () => {
    const context = { theme: '深蓝色科技风', style: 'sci-fi, volumetric', colors: ['#1E3A8A', '#38BDF8'] }
    const background = buildBackgroundPrompt(context, { wide: true })
    expect(background).toContain('深蓝色科技风')
    expect(background).toContain('sci-fi, volumetric')
    expect(background).toContain('16:9')

    const north = buildPanoramaFacePrompt(context, 0)
    expect(north).toContain('looking north')
    expect(north).toContain('field of view 90 degrees')
    expect(north).toContain('seamless edges')

    const icon = buildUiElementPrompt(context, 'icon', 'gear icon')
    expect(icon).toContain('16x16')
    expect(icon).toContain('gear icon')

    expect(defaultNegativePrompt('extra')).toContain('watermark')
    expect(defaultNegativePrompt('extra')).toContain('extra')
  })

  it('全景 6 面顺序符合原版约定（0 北 1 东 2 南 3 西 4 上 5 下）', () => {
    expect(PANORAMA_FACES.map((face) => face.direction)).toEqual(['north', 'east', 'south', 'west', 'up', 'down'])
    expect(PANORAMA_FACES.map((face) => face.file)).toEqual([
      'panorama_0.png',
      'panorama_1.png',
      'panorama_2.png',
      'panorama_3.png',
      'panorama_4.png',
      'panorama_5.png',
    ])
  })
})

// ── 图像编码与后处理 ─────────────────────────────────────────────────────────

describe('图像编码与后处理', () => {
  it('encodePng 产出合法 PNG（用 sharp 反解验证宽高与格式）', async () => {
    const rgba = new Uint8Array(16 * 16 * 4)
    for (let i = 0; i < 16 * 16; i++) {
      rgba[i * 4] = 30
      rgba[i * 4 + 1] = 58
      rgba[i * 4 + 2] = 138
      rgba[i * 4 + 3] = 255
    }
    const png = encodePng(16, 16, rgba)
    expect(detectImageFormat(png)).toBe('png')

    const sharp = await loadSharp()
    if (sharp === null) {
      // 没装 sharp 时至少验证 PNG 签名与 IHDR 长度
      expect(png.byteLength).toBeGreaterThan(50)
      return
    }
    const meta = await imageMetadata(png)
    expect(meta.width).toBe(16)
    expect(meta.height).toBe(16)
    expect(meta.format).toBe('png')
  })

  it('encodePng 对错误像素长度报错', () => {
    expect(() => encodePng(4, 4, new Uint8Array(10))).toThrow(/像素长度不符/)
  })

  it('gradientPng 生成带 alpha 的垂直渐变', async () => {
    const overlay = gradientPng({ width: 8, height: 64, topColor: '#000000', bottomColor: '#1E3A8A', topAlpha: 0, bottomAlpha: 255 })
    expect(detectImageFormat(overlay)).toBe('png')
    const sharp = await loadSharp()
    if (sharp === null) return
    const meta = await imageMetadata(overlay)
    expect(meta.width).toBe(8)
    expect(meta.height).toBe(64)
  })

  it('solidPng 与 removeSolidBackground 组合能把白底抠成透明', async () => {
    const sharp = await loadSharp()
    const white = solidPng(8, 8, '#FFFFFF')
    expect(detectImageFormat(white)).toBe('png')
    if (sharp === null) return

    const transparent = await removeSolidBackground(white, { keyColor: '#FFFFFF', tolerance: 10 })
    expect(detectImageFormat(transparent)).toBe('png')
    const { data, info } = await sharp(Buffer.from(transparent)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    // 纯白底应被完全抠掉
    expect(data[3]).toBe(0)
  })

  it('toPng 能把 JPEG 魔数以外的内容转成 PNG（依赖 sharp）', async () => {
    const sharp = await loadSharp()
    if (sharp === null) {
      await expect(toPng(fakeJpeg(64))).rejects.toThrow(/sharp/)
      return
    }
    const source = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer()
    const png = await toPng(source)
    expect(detectImageFormat(png)).toBe('png')
    const meta = await imageMetadata(png)
    expect(meta.format).toBe('png')
  })
})
