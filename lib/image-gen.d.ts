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
import { RateLimiter, type FetchLike } from './util.js';
/** 生图后端 id。 */
export type ImageProviderId = 'pollinations' | 'wanx' | 'sdapi';
/** 生图参数。 */
export interface ImageGenerateOptions {
    width?: number;
    height?: number;
    seed?: number;
    /** 模型名（各后端自解释）。 */
    model?: string;
    negativePrompt?: string;
    /** 期望透明背景（Pollinations 不支持 alpha，需要后处理抠图）。 */
    transparent?: boolean;
    /** 进度/取消信号。 */
    signal?: AbortSignal;
    /** 附加查询参数。 */
    extra?: Record<string, string>;
}
/** 生图结果。 */
export interface GeneratedImage {
    provider: ImageProviderId;
    prompt: string;
    model: string;
    width: number;
    height: number;
    seed: number;
    /** 图像字节（原始格式，未转码）。 */
    bytes: Buffer;
    /** 原始格式。 */
    format: 'jpeg' | 'png' | 'webp' | 'unknown';
    /** 后端返回的远程地址（若以 URL 形式返回）。 */
    remoteUrl: string | null;
    attempts: number;
}
/** 生图后端接口。 */
export interface ImageProvider {
    readonly id: ImageProviderId;
    readonly label: string;
    readonly requiresKey: boolean;
    /** 同一后端的请求最小间隔（毫秒）。 */
    readonly minIntervalMs: number;
    generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage>;
}
/** 构造参数。 */
export interface ImageProviderOptions {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    /** 最大尝试次数（含首次），默认 4。 */
    maxAttempts?: number;
    /** 退避基数，默认 6000ms（Pollinations 限速较凶）。 */
    retryBaseDelayMs?: number;
    /** 覆盖最小请求间隔。 */
    minIntervalMs?: number;
    /** API Key / 工作区等环境变量覆盖。 */
    apiKey?: string;
    workspaceId?: string;
    baseUrl?: string;
}
/** 后端能力说明（供工具层输出给模型）。 */
export interface ProviderDescriptor {
    id: ImageProviderId;
    label: string;
    requiresKey: boolean;
    envKeys: string[];
    defaultModel: string;
    minIntervalMs: number;
    note: string;
}
/** 内置后端清单。 */
export declare const PROVIDER_CATALOG: readonly ProviderDescriptor[];
type SharpFactory = typeof import('sharp')['default'];
/** 惰性加载 sharp；不可用时返回 null（调用方给出明确错误）。 */
export declare function loadSharp(): Promise<SharpFactory | null>;
/**
 * RGBA 像素编码为 PNG（无第三方依赖，用于渐变叠加层与占位纹理）。
 * @param rgba 长度必须是 width*height*4
 */
export declare function encodePng(width: number, height: number, rgba: Uint8Array): Buffer;
/** 生成纯色（可带 alpha）PNG。 */
export declare function solidPng(width: number, height: number, color: string, alpha?: number): Buffer;
/** 垂直渐变 PNG（用于主界面背景叠加层 / 菜单遮罩）。 */
export declare function gradientPng(options: {
    width: number;
    height: number;
    topColor: string;
    bottomColor: string;
    topAlpha?: number;
    bottomAlpha?: number;
    /** 弧度：在两端之间做平滑插值而不是线性。 */
    smooth?: boolean;
}): Buffer;
/** 识别图像格式（按魔数）。 */
export declare function detectImageFormat(bytes: Uint8Array): GeneratedImage['format'];
/** 转成 PNG（Minecraft 纹理必须是 PNG）。 */
export declare function toPng(input: Uint8Array): Promise<Buffer>;
/** 缩放并居中裁剪到精确尺寸，输出 PNG。 */
export declare function resizeToPng(input: Uint8Array, width: number, height: number): Promise<Buffer>;
/** 读取图像元数据（宽高与格式）。 */
export declare function imageMetadata(input: Uint8Array): Promise<{
    width: number;
    height: number;
    format: string;
}>;
/**
 * 抠掉近似纯色的背景，输出带 alpha 的 PNG。
 * Pollinations 不返回透明通道，因此图标/按钮类素材走这一步后处理。
 * @param keyColor 背景基色（默认白色）
 * @param tolerance 颜色距离阈值（0-255，越大抠得越狠）
 */
export declare function removeSolidBackground(input: Uint8Array, options?: {
    keyColor?: string;
    tolerance?: number;
    edgeFeather?: number;
}): Promise<Buffer>;
/** 在图像上叠加一层渐变遮罩（用于让主界面文字更可读）。 */
export declare function overlayGradient(input: Uint8Array, options: {
    topColor?: string;
    bottomColor?: string;
    topAlpha?: number;
    bottomAlpha?: number;
}): Promise<Buffer>;
/** Prompt 上下文。 */
export interface PromptContext {
    /** 整合包主题，例如「深蓝色科技风」。 */
    theme: string;
    /** 风格关键词，例如 'sci-fi, clean, volumetric lighting'。 */
    style?: string;
    /** 主色/辅色/强调色。 */
    colors?: string[];
    /** 额外关键词。 */
    keywords?: string[];
    /** 负向关键词。 */
    negative?: string;
}
/** 全景图 6 个面的官方顺序（依据 PacksIndex/Minecraft 全景规范）。 */
export declare const PANORAMA_FACES: ReadonlyArray<{
    index: number;
    direction: string;
    file: string;
    yawDeg: number;
    pitchDeg: number;
}>;
/** 全景图每面的固定尺寸（低于 1024 会被资源包加载器拒绝）。 */
export declare const PANORAMA_FACE_SIZE = 1024;
/** 主界面背景图 prompt。 */
export declare function buildBackgroundPrompt(context: PromptContext, options?: {
    wide?: boolean;
}): string;
/** 全景图某一面的 prompt（含方向与拼接约束）。 */
export declare function buildPanoramaFacePrompt(context: PromptContext, faceIndex: number): string;
/** UI 元素类型。 */
export type UiElementType = 'button' | 'icon' | 'hud' | 'container' | 'tooltip';
/** 每种 UI 元素的默认生图尺寸与目录。 */
export declare const UI_ELEMENT_SPECS: Readonly<Record<UiElementType, {
    width: number;
    height: number;
    directory: string;
    template: string;
    guideline: string;
}>>;
/** UI 元素题材 prompt。 */
export declare function buildUiElementPrompt(context: PromptContext, elementType: UiElementType, subject?: string): string;
/** 默认负向 prompt。 */
export declare function defaultNegativePrompt(extra?: string): string;
/** 在任意 JSON 结构里找第一个可下载 URL（不假设后端响应结构）。 */
export declare function findFirstUrl(value: unknown, depth?: number): string | null;
declare abstract class BaseProvider implements ImageProvider {
    abstract readonly id: ImageProviderId;
    abstract readonly label: string;
    abstract readonly requiresKey: boolean;
    abstract readonly defaultModel: string;
    readonly minIntervalMs: number;
    protected readonly fetchImpl: FetchLike;
    protected readonly limiter: RateLimiter;
    protected readonly maxAttempts: number;
    protected readonly retryBaseDelayMs: number;
    protected readonly signal: AbortSignal | undefined;
    constructor(options: ImageProviderOptions, defaultIntervalMs: number);
    abstract generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage>;
    /** 统一的重试执行：限速 → 请求 → 判定可重试。 */
    protected run<T>(label: string, attemptFn: (attempt: number) => Promise<T>, retryable: (error: unknown) => boolean): Promise<T>;
}
/** Pollinations.ai（默认后端，免 Key）。 */
export declare class PollinationsProvider extends BaseProvider {
    readonly id: ImageProviderId;
    readonly label = "Pollinations.ai";
    readonly requiresKey = false;
    readonly defaultModel = "turbo";
    private readonly baseUrl;
    private readonly referrer;
    constructor(options?: ImageProviderOptions, overrides?: {
        baseUrl?: string;
        referrer?: string;
        defaultIntervalMs?: number;
    });
    generateImage(prompt: string, options?: ImageGenerateOptions): Promise<GeneratedImage>;
}
/** 通义万相 V2（需 Key）。 */
export declare class WanxProvider extends BaseProvider {
    readonly id: ImageProviderId;
    readonly label = "\u901A\u4E49\u4E07\u76F8 V2";
    readonly requiresKey = true;
    readonly defaultModel = "wan2.6-t2i";
    private readonly apiKey;
    private readonly workspaceId;
    private readonly baseUrl;
    constructor(options?: ImageProviderOptions);
    generateImage(prompt: string, options?: ImageGenerateOptions): Promise<GeneratedImage>;
}
/** Stable Diffusion API（需 Key，支持 panorama）。 */
export declare class SdApiProvider extends BaseProvider {
    readonly id: ImageProviderId;
    readonly label = "Stable Diffusion API";
    readonly requiresKey = true;
    readonly defaultModel = "stable-diffusion-xl";
    private readonly apiKey;
    private readonly baseUrl;
    constructor(options?: ImageProviderOptions);
    generateImage(prompt: string, options?: ImageGenerateOptions): Promise<GeneratedImage>;
}
/** 归一化 provider 名称；未知名称抛错并列出可用值。 */
export declare function resolveProviderId(value?: string): ImageProviderId;
/** 构造一个生图后端。 */
export declare function createImageProvider(id: string | undefined, options?: ImageProviderOptions): ImageProvider;
/** 列出可用后端及所需环境变量。 */
export declare function listImageProviders(): ProviderDescriptor[];
export {};
//# sourceMappingURL=image-gen.d.ts.map