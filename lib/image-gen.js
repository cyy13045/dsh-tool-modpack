/**
 * dsh-tool-modpack — AI 生图客户端与图像后处理。
 *
 * 统一抽象：
 *   interface ImageProvider { generateImage(prompt, options): Promise<GeneratedImage> }
 * 内置三个实现：
 *   - PollinationsProvider（默认，免 Key，匿名额度 1 req/15s，超限返回 402 需退避）
 *   - WanxProvider（通义万相 V2，需 DASHSCOPE_API_KEY + WANX_WORKSPACE_ID）
 *   - SdApiProvider（stablediffusionapi.com，需 SD_API_KEY）
 *
 * 图像后处理用 sharp；sharp 采用**惰性导入**，缺失时给出明确错误而不是让整个插件加载失败。
 * 纯 JS 的 PNG 编码器（encodePng）用于渐变叠加层、纯色占位纹理等不需要解码的场景。
 *
 * @module dsh-tool-modpack/image-gen
 */
import { deflateSync } from 'node:zlib';
import { ModpackError, RateLimiter, asArray, asRecord, asString, clampInt, crc32, globalFetch, hexToRgb, isRetryableStatus, sleep, } from './util.js';
/** 内置后端清单。 */
export const PROVIDER_CATALOG = [
    {
        id: 'pollinations',
        label: 'Pollinations.ai',
        requiresKey: false,
        envKeys: [],
        defaultModel: 'turbo',
        minIntervalMs: 15_000,
        note: '免 Key 免注册。匿名额度约 1 请求/15 秒，超限返回 HTTP 402（本插件自动退避重试）。输出 JPEG，用于 Minecraft 前必须转 PNG。',
    },
    {
        id: 'wanx',
        label: '通义万相 V2',
        requiresKey: true,
        envKeys: ['DASHSCOPE_API_KEY（或 WANX_API_KEY）', 'WANX_WORKSPACE_ID'],
        defaultModel: 'wan2.6-t2i',
        minIntervalMs: 2000,
        note: '中文提示词友好，最长 2100 字符，异步任务型，返回可下载图片 URL。',
    },
    {
        id: 'sdapi',
        label: 'Stable Diffusion API',
        requiresKey: true,
        envKeys: ['SD_API_KEY'],
        defaultModel: 'stable-diffusion-xl',
        minIntervalMs: 2000,
        note: '支持 panorama=yes 生成全景条图；需 Key。',
    },
];
let sharpCache;
/** 惰性加载 sharp；不可用时返回 null（调用方给出明确错误）。 */
export async function loadSharp() {
    if (sharpCache !== undefined)
        return sharpCache;
    try {
        const mod = (await import('sharp'));
        sharpCache = mod.default ?? null;
    }
    catch {
        sharpCache = null;
    }
    return sharpCache;
}
async function requireSharp(operation) {
    const sharp = await loadSharp();
    if (sharp === null) {
        throw new ModpackError('SHARP_UNAVAILABLE', `${operation} 需要 sharp（图像解码/转码）。请在本插件目录执行 pnpm install 安装依赖后重启 DSH。`);
    }
    return sharp;
}
// ── 纯 JS PNG 编码 ───────────────────────────────────────────────────────────
function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
}
/**
 * RGBA 像素编码为 PNG（无第三方依赖，用于渐变叠加层与占位纹理）。
 * @param rgba 长度必须是 width*height*4
 */
export function encodePng(width, height, rgba) {
    if (width <= 0 || height <= 0)
        throw new ModpackError('INVALID_IMAGE', `PNG 尺寸非法：${width}x${height}`);
    if (rgba.byteLength !== width * height * 4) {
        throw new ModpackError('INVALID_IMAGE', `PNG 像素长度不符：期望 ${width * height * 4}，实际 ${rgba.byteLength}`);
    }
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter type 0 (None)
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}
/** 生成纯色（可带 alpha）PNG。 */
export function solidPng(width, height, color, alpha = 255) {
    const { r, g, b } = hexToRgb(color);
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = alpha;
    }
    return encodePng(width, height, rgba);
}
/** 垂直渐变 PNG（用于主界面背景叠加层 / 菜单遮罩）。 */
export function gradientPng(options) {
    const width = Math.max(1, Math.trunc(options.width));
    const height = Math.max(1, Math.trunc(options.height));
    const top = hexToRgb(options.topColor);
    const bottom = hexToRgb(options.bottomColor);
    const topAlpha = clampInt(options.topAlpha, 0, 255, 120);
    const bottomAlpha = clampInt(options.bottomAlpha, 0, 255, 220);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        let t = height === 1 ? 0 : y / (height - 1);
        if (options.smooth === true)
            t = t * t * (3 - 2 * t);
        const r = Math.round(top.r + (bottom.r - top.r) * t);
        const g = Math.round(top.g + (bottom.g - top.g) * t);
        const b = Math.round(top.b + (bottom.b - top.b) * t);
        const a = Math.round(topAlpha + (bottomAlpha - topAlpha) * t);
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            rgba[index] = r;
            rgba[index + 1] = g;
            rgba[index + 2] = b;
            rgba[index + 3] = a;
        }
    }
    return encodePng(width, height, rgba);
}
/** 识别图像格式（按魔数）。 */
export function detectImageFormat(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'jpeg';
    if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
        return 'webp';
    return 'unknown';
}
// ── 图像后处理（sharp） ──────────────────────────────────────────────────────
/** 转成 PNG（Minecraft 纹理必须是 PNG）。 */
export async function toPng(input) {
    const factory = await requireSharp('图像转码为 PNG');
    return factory(Buffer.from(input)).png({ compressionLevel: 9 }).toBuffer();
}
/** 缩放并居中裁剪到精确尺寸，输出 PNG。 */
export async function resizeToPng(input, width, height) {
    const factory = await requireSharp('图像缩放');
    return factory(Buffer.from(input))
        .resize(width, height, { fit: 'cover', position: 'centre' })
        .png({ compressionLevel: 9 })
        .toBuffer();
}
/** 读取图像元数据（宽高与格式）。 */
export async function imageMetadata(input) {
    const factory = await requireSharp('读取图像元数据');
    const meta = await factory(Buffer.from(input)).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? 'unknown' };
}
/** 把十六进制色解析成 sharp 可用的 rgba 对象。 */
function rgba(color, alpha) {
    const rgb = hexToRgb(color);
    return { r: rgb.r, g: rgb.g, b: rgb.b, alpha: Math.min(1, Math.max(0, alpha / 255)) };
}
/**
 * 抠掉近似纯色的背景，输出带 alpha 的 PNG。
 * Pollinations 不返回透明通道，因此图标/按钮类素材走这一步后处理。
 * @param keyColor 背景基色（默认白色）
 * @param tolerance 颜色距离阈值（0-255，越大抠得越狠）
 */
export async function removeSolidBackground(input, options = {}) {
    const factory = await requireSharp('背景抠除');
    const key = hexToRgb(options.keyColor ?? '#FFFFFF');
    const tolerance = clampInt(options.tolerance, 0, 255, 32);
    const feather = clampInt(options.edgeFeather, 0, 128, 24);
    const image = factory(Buffer.from(input)).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    for (let i = 0; i < info.width * info.height; i++) {
        const offset = i * channels;
        const r = data[offset] ?? 0;
        const g = data[offset + 1] ?? 0;
        const b = data[offset + 2] ?? 0;
        const distance = Math.max(Math.abs(r - key.r), Math.abs(g - key.g), Math.abs(b - key.b));
        if (distance <= tolerance) {
            data[offset + 3] = 0;
        }
        else if (distance <= tolerance + feather) {
            const ratio = (distance - tolerance) / Math.max(1, feather);
            data[offset + 3] = Math.round(255 * ratio);
        }
    }
    return factory(data, { raw: { width: info.width, height: info.height, channels } }).png({ compressionLevel: 9 }).toBuffer();
}
/** 在图像上叠加一层渐变遮罩（用于让主界面文字更可读）。 */
export async function overlayGradient(input, options) {
    const factory = await requireSharp('叠加渐变遮罩');
    const meta = await factory(Buffer.from(input)).metadata();
    const width = meta.width ?? 1920;
    const height = meta.height ?? 1080;
    const topAlpha = clampInt(options.topAlpha, 0, 255, 40);
    const bottomAlpha = clampInt(options.bottomAlpha, 0, 255, 200);
    const top = rgba(options.topColor ?? '#000000', topAlpha);
    const bottom = rgba(options.bottomColor ?? '#000000', bottomAlpha);
    // 用 SVG 线性渐变生成遮罩层，再由 sharp 合成。
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="rgb(${top.r},${top.g},${top.b})" stop-opacity="${top.alpha}"/>
    <stop offset="100%" stop-color="rgb(${bottom.r},${bottom.g},${bottom.b})" stop-opacity="${bottom.alpha}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`;
    return factory(Buffer.from(input))
        .composite([{ input: Buffer.from(svg), blend: 'over' }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}
/** 全景图 6 个面的官方顺序（依据 PacksIndex/Minecraft 全景规范）。 */
export const PANORAMA_FACES = [
    { index: 0, direction: 'north', file: 'panorama_0.png', yawDeg: 180, pitchDeg: 0 },
    { index: 1, direction: 'east', file: 'panorama_1.png', yawDeg: 270, pitchDeg: 0 },
    { index: 2, direction: 'south', file: 'panorama_2.png', yawDeg: 0, pitchDeg: 0 },
    { index: 3, direction: 'west', file: 'panorama_3.png', yawDeg: 90, pitchDeg: 0 },
    { index: 4, direction: 'up', file: 'panorama_4.png', yawDeg: 180, pitchDeg: -90 },
    { index: 5, direction: 'down', file: 'panorama_5.png', yawDeg: 180, pitchDeg: 90 },
];
/** 全景图每面的固定尺寸（低于 1024 会被资源包加载器拒绝）。 */
export const PANORAMA_FACE_SIZE = 1024;
function contextTokens(context) {
    const tokens = [context.theme, context.style ?? '', (context.keywords ?? []).join(', '), (context.colors ?? []).join(', ')];
    return tokens.filter((token) => token.trim() !== '').join(', ');
}
const NEGATIVE_BASE = 'text, watermark, signature, logo, ui elements, hud, letters, words, blurry, low resolution, distorted geometry, people, hands';
/** 主界面背景图 prompt。 */
export function buildBackgroundPrompt(context, options = {}) {
    return [
        'Minecraft-style stylized landscape background for a modpack main menu',
        contextTokens(context),
        options.wide === true ? 'ultra-wide seamless vista, 16:9 composition with clear center space' : 'centered composition with empty middle area for menu text',
        'no user interface, no text, no buttons, clean render, game concept art',
    ]
        .filter((part) => part.trim() !== '')
        .join(', ');
}
/** 全景图某一面的 prompt（含方向与拼接约束）。 */
export function buildPanoramaFacePrompt(context, faceIndex) {
    const face = PANORAMA_FACES.find((item) => item.index === faceIndex) ?? PANORAMA_FACES[0];
    return [
        'Minecraft-style cubic panorama face',
        `looking ${face.direction}`,
        `camera yaw ${face.yawDeg} degrees, pitch ${face.pitchDeg} degrees, field of view 90 degrees`,
        'equirectangular cube face, seamless edges, horizon at 45% height, fisheye-free, sharp geometric horizon',
        contextTokens(context),
        'no text, no watermark, no user interface',
    ]
        .filter((part) => part.trim() !== '')
        .join(', ');
}
/** 每种 UI 元素的默认生图尺寸与目录。 */
export const UI_ELEMENT_SPECS = {
    button: {
        width: 200,
        height: 20,
        directory: 'gui/sprites/widget',
        template: 'flat 2D Minecraft GUI button texture, rectangular, three vertical states stacked (normal top, hovered middle, disabled bottom)',
        guideline: '原版 widgets.png 单态为 200x20；若走原版按钮切图，请务必保持 200 宽、每态 20 高、垂直堆叠',
    },
    icon: {
        width: 16,
        height: 16,
        directory: 'gui/sprites/icon',
        template: 'pixel art icon, 16x16 grid, crisp 1px outline, transparent background, centered subject',
        guideline: '图标必须是 16x16 的整数倍放大图；AI 生图后建议先放大再缩小以压掉噪点',
    },
    hud: {
        width: 182,
        height: 22,
        directory: 'gui/sprites/hud',
        template: 'Minecraft HUD bar texture, flat 2D, subtle bevel, no text',
        guideline: 'HUD 贴图尺寸需与目标模组（如 FTB Quests 侧边栏）的 UV 布局一致',
    },
    container: {
        width: 176,
        height: 166,
        directory: 'gui/sprites/container',
        template: 'Minecraft inventory container GUI panel texture, 9x3 slot grid, wooden/metal frame, flat 2D',
        guideline: '容器面板槽位间距 18px，边距 7/8px；面板尺寸必须等于 槽位矩形 + 边距',
    },
    tooltip: {
        width: 64,
        height: 64,
        directory: 'gui/sprites/tooltip',
        template: 'Minecraft tooltip background corner ornament, flat 2D, tileable edges',
        guideline: '提示框底纹 64x64 可平铺',
    },
};
/** UI 元素题材 prompt。 */
export function buildUiElementPrompt(context, elementType, subject) {
    const spec = UI_ELEMENT_SPECS[elementType];
    return [
        spec.template,
        subject !== undefined && subject.trim() !== '' ? `subject: ${subject}` : '',
        contextTokens(context),
        'solid flat background color for easy background removal, no gradient background, no text, no letters',
    ]
        .filter((part) => part.trim() !== '')
        .join(', ');
}
/** 默认负向 prompt。 */
export function defaultNegativePrompt(extra) {
    return extra !== undefined && extra.trim() !== '' ? `${NEGATIVE_BASE}, ${extra}` : NEGATIVE_BASE;
}
// ── 后端实现 ─────────────────────────────────────────────────────────────────
function imageFormatIsImage(format) {
    return format === 'png' || format === 'jpeg' || format === 'webp';
}
/** 在任意 JSON 结构里找第一个可下载 URL（不假设后端响应结构）。 */
export function findFirstUrl(value, depth = 0) {
    if (depth > 8)
        return null;
    if (typeof value === 'string') {
        return /^https?:\/\/\S+\.(?:png|jpe?g|webp|bmp)(?:\?\S*)?$/i.test(value) || /^https?:\/\/\S+$/i.test(value)
            ? value
            : null;
    }
    if (Array.isArray(value)) {
        for (const item of asArray(value)) {
            const found = findFirstUrl(item, depth + 1);
            if (found !== null)
                return found;
        }
        return null;
    }
    if (typeof value === 'object' && value !== null) {
        const record = asRecord(value);
        const byUrlKey = ['url', 'image', 'image_url', 'imageUrl', 'output', 'b64_json', 'uri'];
        for (const key of byUrlKey) {
            const found = findFirstUrl(record[key], depth + 1);
            if (found !== null)
                return found;
        }
        for (const item of Object.values(record)) {
            const found = findFirstUrl(item, depth + 1);
            if (found !== null)
                return found;
        }
    }
    return null;
}
/** 下载远程图片字节。 */
async function fetchImageBytes(fetchImpl, url, signal) {
    const response = await fetchImpl(url, { method: 'GET', ...(signal !== undefined ? { signal } : {}) });
    if (!response.ok) {
        throw new ModpackError('IMAGE_DOWNLOAD', `下载生成结果失败：HTTP ${response.status}（${url.slice(0, 120)}）`);
    }
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    return { bytes: buffer, format: detectImageFormat(buffer) };
}
class BaseProvider {
    minIntervalMs;
    fetchImpl;
    limiter;
    maxAttempts;
    retryBaseDelayMs;
    signal;
    constructor(options, defaultIntervalMs) {
        this.fetchImpl = options.fetchImpl ?? globalFetch;
        this.minIntervalMs = Math.max(0, options.minIntervalMs ?? defaultIntervalMs);
        this.limiter = new RateLimiter(this.minIntervalMs);
        this.maxAttempts = clampInt(options.maxAttempts, 1, 10, 4);
        this.retryBaseDelayMs = clampInt(options.retryBaseDelayMs, 100, 120_000, this.minIntervalMs > 0 ? this.minIntervalMs : 2000);
        this.signal = options.signal;
    }
    /** 统一的重试执行：限速 → 请求 → 判定可重试。 */
    async run(label, attemptFn, retryable) {
        let last = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            await this.limiter.acquire();
            try {
                return await attemptFn(attempt);
            }
            catch (error) {
                last = error;
                if (attempt >= this.maxAttempts || !retryable(error))
                    break;
                await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
            }
        }
        if (last instanceof ModpackError)
            throw last;
        throw new ModpackError('IMAGE_FAILED', `${label} 失败：${last instanceof Error ? last.message : String(last)}`);
    }
}
/** Pollinations.ai（默认后端，免 Key）。 */
export class PollinationsProvider extends BaseProvider {
    id = 'pollinations';
    label = 'Pollinations.ai';
    requiresKey = false;
    defaultModel = 'turbo';
    baseUrl;
    referrer;
    constructor(options = {}, overrides = {}) {
        super(overrides.defaultIntervalMs !== undefined
            ? { ...options, minIntervalMs: options.minIntervalMs ?? overrides.defaultIntervalMs }
            : options, 15_000);
        this.baseUrl = overrides.baseUrl ?? options.baseUrl ?? 'https://image.pollinations.ai';
        this.referrer = overrides.referrer ?? 'dsh-tool-modpack';
    }
    async generateImage(prompt, options = {}) {
        const width = clampInt(options.width, 64, 2048, 1024);
        const height = clampInt(options.height, 64, 2048, 1024);
        const model = options.model ?? this.defaultModel;
        const seed = clampInt(options.seed, 0, 2_147_483_647, Math.floor(Math.random() * 1_000_000));
        const params = new URLSearchParams();
        params.set('width', String(width));
        params.set('height', String(height));
        params.set('seed', String(seed));
        params.set('model', model);
        params.set('nologo', 'true');
        params.set('private', 'true');
        params.set('referrer', this.referrer);
        if (options.transparent === true)
            params.set('transparent', 'true');
        for (const [key, value] of Object.entries(options.extra ?? {}))
            params.set(key, value);
        const url = `${this.baseUrl}/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
        return this.run(`Pollinations 生图（${model}）`, async (attempt) => {
            let response;
            const effectiveSignal = options.signal ?? this.signal;
            try {
                response = await this.fetchImpl(url, {
                    method: 'GET',
                    headers: { Accept: 'image/*' },
                    ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
                });
            }
            catch (error) {
                throw new ModpackError('POLLINATIONS_NETWORK', `无法连接 Pollinations：${error instanceof Error ? error.message : String(error)}`);
            }
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                const hint = response.status === 402 ? '（匿名额度用尽：约 1 请求/15 秒，请降低并发或稍后重试）' : '';
                throw new ModpackError('POLLINATIONS_HTTP', `Pollinations 返回 HTTP ${response.status}${hint}：${body.slice(0, 160)}`);
            }
            const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
            const format = detectImageFormat(buffer);
            if (!imageFormatIsImage(format) || buffer.byteLength < 256) {
                throw new ModpackError('POLLINATIONS_NOT_IMAGE', `Pollinations 未返回图像（收到 ${buffer.byteLength} 字节，魔数 ${format}）。常见原因：提示词被安全过滤，或匿名额度用尽。`);
            }
            return {
                provider: this.id,
                prompt,
                model,
                width,
                height,
                seed,
                bytes: buffer,
                format,
                remoteUrl: url,
                attempts: attempt,
            };
        }, (error) => {
            if (error instanceof ModpackError && error.code === 'POLLINATIONS_HTTP') {
                const status = Number(/(\d{3})/.exec(error.message)?.[1] ?? '0');
                return isRetryableStatus(status);
            }
            return error instanceof ModpackError && error.code === 'POLLINATIONS_NETWORK';
        });
    }
}
/** 通义万相 V2（需 Key）。 */
export class WanxProvider extends BaseProvider {
    id = 'wanx';
    label = '通义万相 V2';
    requiresKey = true;
    defaultModel = 'wan2.6-t2i';
    apiKey;
    workspaceId;
    baseUrl;
    constructor(options = {}) {
        super(options, 2000);
        const key = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? process.env.WANX_API_KEY ?? '';
        if (key.trim() === '') {
            throw new ModpackError('MISSING_API_KEY', '通义万相 provider 需要 API Key：请设置环境变量 DASHSCOPE_API_KEY（或 WANX_API_KEY）后重启 DSH。免 Key 可用 provider="pollinations"。');
        }
        const workspace = options.workspaceId ?? process.env.WANX_WORKSPACE_ID ?? '';
        if (workspace.trim() === '') {
            throw new ModpackError('MISSING_WORKSPACE', '通义万相需要 WANX_WORKSPACE_ID（阿里云百炼工作区 id），请在环境变量中配置。');
        }
        this.apiKey = key.trim();
        this.workspaceId = workspace.trim();
        this.baseUrl = options.baseUrl ?? `https://${this.workspaceId}.cn-beijing.maas.aliyuncs.com`;
    }
    async generateImage(prompt, options = {}) {
        if (prompt.length > 2100) {
            throw new ModpackError('PROMPT_TOO_LONG', `通义万相提示词上限 2100 字符，当前 ${prompt.length} 字符`);
        }
        const width = clampInt(options.width, 256, 2048, 1024);
        const height = clampInt(options.height, 256, 2048, 1024);
        const model = options.model ?? this.defaultModel;
        const body = JSON.stringify({
            model,
            input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
            parameters: { size: `${width}*${height}`, n: 1 },
        });
        const endpoint = `${this.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
        return this.run('通义万相生图', async (attempt) => {
            const effectiveSignal = options.signal ?? this.signal;
            const response = await this.fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body,
                ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
            });
            const text = await response.text();
            if (!response.ok) {
                throw new ModpackError('WANX_HTTP', `通义万相返回 HTTP ${response.status}：${text.slice(0, 300)}`);
            }
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                throw new ModpackError('WANX_BAD_JSON', `通义万相返回非 JSON：${text.slice(0, 200)}`);
            }
            const remoteUrl = findFirstUrl(parsed);
            if (remoteUrl === null) {
                throw new ModpackError('WANX_NO_IMAGE', `通义万相响应里找不到图片地址：${text.slice(0, 300)}`);
            }
            const { bytes, format } = await fetchImageBytes(this.fetchImpl, remoteUrl, options.signal ?? this.signal);
            return {
                provider: this.id,
                prompt,
                model,
                width,
                height,
                seed: clampInt(options.seed, 0, 2_147_483_647, 0),
                bytes,
                format,
                remoteUrl,
                attempts: attempt,
            };
        }, (error) => {
            if (error instanceof ModpackError && error.code === 'WANX_HTTP') {
                const status = Number(/(\d{3})/.exec(error.message)?.[1] ?? '0');
                return isRetryableStatus(status);
            }
            return false;
        });
    }
}
/** Stable Diffusion API（需 Key，支持 panorama）。 */
export class SdApiProvider extends BaseProvider {
    id = 'sdapi';
    label = 'Stable Diffusion API';
    requiresKey = true;
    defaultModel = 'stable-diffusion-xl';
    apiKey;
    baseUrl;
    constructor(options = {}) {
        super(options, 2000);
        const key = options.apiKey ?? process.env.SD_API_KEY ?? '';
        if (key.trim() === '') {
            throw new ModpackError('MISSING_API_KEY', 'Stable Diffusion API provider 需要环境变量 SD_API_KEY。免 Key 可用 provider="pollinations"。');
        }
        this.apiKey = key.trim();
        this.baseUrl = options.baseUrl ?? 'https://stablediffusionapi.com';
    }
    async generateImage(prompt, options = {}) {
        const width = clampInt(options.width, 256, 2048, 1024);
        const height = clampInt(options.height, 256, 2048, 1024);
        const model = options.model ?? this.defaultModel;
        const seed = clampInt(options.seed, 0, 2_147_483_647, Math.floor(Math.random() * 1_000_000));
        const body = JSON.stringify({
            key: this.apiKey,
            model,
            prompt,
            negative_prompt: options.negativePrompt ?? defaultNegativePrompt(),
            width: String(width),
            height: String(height),
            samples: '1',
            num_inference_steps: '30',
            guidance_scale: 7.5,
            safety_checker: 'no',
            enhance_prompt: 'yes',
            seed,
            panorama: options.extra?.panorama ?? 'no',
        });
        return this.run('Stable Diffusion API 生图', async (attempt) => {
            const effectiveSignal = options.signal ?? this.signal;
            const response = await this.fetchImpl(`${this.baseUrl}/api/v3/text2img`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body,
                ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
            });
            const text = await response.text();
            if (!response.ok) {
                throw new ModpackError('SD_HTTP', `Stable Diffusion API 返回 HTTP ${response.status}：${text.slice(0, 300)}`);
            }
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                throw new ModpackError('SD_BAD_JSON', `Stable Diffusion API 返回非 JSON：${text.slice(0, 200)}`);
            }
            const record = asRecord(parsed);
            if (asString(record.status).toLowerCase() === 'error') {
                throw new ModpackError('SD_API_ERROR', `Stable Diffusion API 报错：${asString(record.message, text.slice(0, 200))}`);
            }
            const remoteUrl = findFirstUrl(parsed);
            if (remoteUrl === null) {
                throw new ModpackError('SD_NO_IMAGE', `Stable Diffusion API 响应里找不到图片地址：${text.slice(0, 300)}`);
            }
            const { bytes, format } = await fetchImageBytes(this.fetchImpl, remoteUrl, options.signal ?? this.signal);
            return {
                provider: this.id,
                prompt,
                model,
                width,
                height,
                seed,
                bytes,
                format,
                remoteUrl,
                attempts: attempt,
            };
        }, (error) => {
            if (error instanceof ModpackError && error.code === 'SD_HTTP') {
                const status = Number(/(\d{3})/.exec(error.message)?.[1] ?? '0');
                return isRetryableStatus(status);
            }
            return false;
        });
    }
}
/** 归一化 provider 名称；未知名称抛错并列出可用值。 */
export function resolveProviderId(value) {
    if (value === undefined || value.trim() === '')
        return 'pollinations';
    const key = value.trim().toLowerCase();
    const aliases = {
        pollinations: 'pollinations',
        pollinationsai: 'pollinations',
        free: 'pollinations',
        default: 'pollinations',
        wanx: 'wanx',
        wan: 'wanx',
        tongyi: 'wanx',
        dashscope: 'wanx',
        sdapi: 'sdapi',
        sd: 'sdapi',
        stablediffusion: 'sdapi',
        stability: 'sdapi',
    };
    const resolved = aliases[key.replace(/[\s_.-]/g, '')];
    if (resolved === undefined) {
        throw new ModpackError('UNKNOWN_PROVIDER', `未知生图 provider：${value}。可用值：${PROVIDER_CATALOG.map((item) => item.id).join(' / ')}`);
    }
    return resolved;
}
/** 构造一个生图后端。 */
export function createImageProvider(id, options = {}) {
    const resolved = resolveProviderId(id);
    if (resolved === 'pollinations')
        return new PollinationsProvider(options);
    if (resolved === 'wanx')
        return new WanxProvider(options);
    return new SdApiProvider(options);
}
/** 列出可用后端及所需环境变量。 */
export function listImageProviders() {
    return PROVIDER_CATALOG.map((item) => ({ ...item }));
}
//# sourceMappingURL=image-gen.js.map