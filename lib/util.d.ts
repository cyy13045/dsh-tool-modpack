/**
 * dsh-tool-modpack — 共享工具层。
 *
 * 这里只放"被两个以上模块复用"的东西：可注入 fetch、错误类型、CRC32、
 * 文件系统小工具、JSON 宽松取值、限速器、重试。所有网络与磁盘故障都直接 throw，
 * 由工具层的 execute 冒泡给 DSH 运行时（契约要求：execute 抛异常即 isError）。
 *
 * @module dsh-tool-modpack/util
 */
/** 只声明本插件真正读取的 Response 表面，测试可安全替换。 */
export interface FetchResponse {
    ok: boolean;
    status: number;
    headers: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}
/** 只声明本插件真正使用的请求字段。 */
export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}
/** 可注入的 fetch 实现：生产用全局 fetch，测试用 mock。 */
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>;
/** 生产默认实现。 */
export declare const globalFetch: FetchLike;
/** 本插件所有可读错误的基类，message 面向模型与用户。 */
export declare class ModpackError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 等待 ms 毫秒。 */
export declare function sleep(ms: number): Promise<void>;
/** 把任意字符串规范为文件名安全的小写短横线 slug。 */
export declare function slugify(text: string, fallback?: string): string;
/** 约束整数到 [min, max]，非有限数回落默认值。 */
export declare function clampInt(value: unknown, min: number, max: number, fallback: number): number;
/** 去重且保序。 */
export declare function unique<T>(items: readonly T[]): T[];
/** 规范化 #RRGGBB / RRGGBB / #RGB，失败返回 fallback。 */
export declare function normalizeHex(value: unknown, fallback?: string): string;
/** #RRGGBB → 打包为 0xRRGGBB 整数（Minecraft JSON 的 color 字段格式）。 */
export declare function hexToRgbInt(value: unknown, fallback?: number): number;
/** #RRGGBB → { r, g, b }（0-255）。 */
export declare function hexToRgb(value: unknown, fallback?: string): {
    r: number;
    g: number;
    b: number;
};
/** 只接受普通对象。 */
export declare function asRecord(value: unknown): Record<string, unknown>;
/** 只接受数组。 */
export declare function asArray(value: unknown): unknown[];
/** 取字符串，空串视为缺失。 */
export declare function asString(value: unknown, fallback?: string): string;
/** 取有限数字。 */
export declare function asNumber(value: unknown, fallback?: number): number;
/** 取布尔。 */
export declare function asBoolean(value: unknown, fallback?: boolean): boolean;
/** 取字符串数组，逐项过滤非字符串。 */
export declare function asStringArray(value: unknown): string[];
/** 必填字符串校验，缺失即 throw。 */
export declare function requireString(value: unknown, field: string): string;
/** 递归建目录。 */
export declare function ensureDir(dir: string): Promise<string>;
/** 判断路径存在。 */
export declare function pathExists(target: string): Promise<boolean>;
/** 写文件（自动建父目录），先写临时文件再 rename，避免半截文件。 */
export declare function writeFileEnsured(file: string, data: string | Uint8Array): Promise<string>;
/** 读 JSON，失败时返回 fallback（用于读取可选的已有配置）。 */
export declare function readJsonSafe(file: string, fallback?: unknown): Promise<unknown>;
/** 读文本，失败时返回 fallback。 */
export declare function readTextSafe(file: string, fallback?: string | null): Promise<string | null>;
/** 统一成正斜杠路径片段（资源包/zip 内部路径必须如此）。 */
export declare function toPosix(p: string): string;
/**
 * 把相对资源路径解析到 packDir 之下，并拒绝越界与绝对路径。
 * 这是"UI 资源必须写进正确目录"的强制闸门。
 */
export declare function resolveInside(root: string, ...segments: string[]): string;
/** 资源包内的标准资源路径构造器：assets/<namespace>/<rest...>。 */
export declare function assetPath(namespace: string, ...rest: string[]): string;
/** sha1 十六进制摘要（用于 Modrinth 文件校验）。 */
export declare function sha1(data: Uint8Array | string): string;
/** sha256 十六进制摘要。 */
export declare function sha256(data: Uint8Array | string): string;
/** CRC32（zip / PNG IEND 校验用），返回无符号 32 位。 */
export declare function crc32(data: Uint8Array): number;
/**
 * 串行限速器：保证同类请求之间至少间隔 minIntervalMs。
 * Pollinations 匿名额度是 1 req/15s，必须靠它避免 402。
 */
export declare class RateLimiter {
    private readonly minIntervalMs;
    private nextAt;
    constructor(minIntervalMs: number);
    /** 等到可以发起下一次请求。 */
    acquire(): Promise<void>;
}
/** 重试判定：网络错误、429、5xx、以及 Pollinations 的 402 额度响应。 */
export declare function isRetryableStatus(status: number): boolean;
/**
 * 通用重试包装。attempts 为总尝试次数，退避为 baseDelayMs * 2^(n-1)。
 * @param label 出错信息里的人类可读前缀
 */
export declare function withRetry<T>(label: string, attempts: number, baseDelayMs: number, run: (attempt: number) => Promise<T>, shouldRetry?: (error: unknown) => boolean): Promise<T>;
/** 组合取消信号：parent 中止时通知 child。 */
export declare function linkSignal(parent?: AbortSignal): {
    signal: AbortSignal;
    dispose: () => void;
};
/** 当前时间 ISO 字符串。 */
export declare function nowIso(): string;
//# sourceMappingURL=util.d.ts.map