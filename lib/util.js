/**
 * dsh-tool-modpack — 共享工具层。
 *
 * 这里只放"被两个以上模块复用"的东西：可注入 fetch、错误类型、CRC32、
 * 文件系统小工具、JSON 宽松取值、限速器、重试。所有网络与磁盘故障都直接 throw，
 * 由工具层的 execute 冒泡给 DSH 运行时（契约要求：execute 抛异常即 isError）。
 *
 * @module dsh-tool-modpack/util
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
/** 生产默认实现。 */
export const globalFetch = (input, init) => fetch(input, init);
// ── 错误 ─────────────────────────────────────────────────────────────────────
/** 本插件所有可读错误的基类，message 面向模型与用户。 */
export class ModpackError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ModpackError';
        this.code = code;
    }
}
// ── 基础杂项 ─────────────────────────────────────────────────────────────────
/** 等待 ms 毫秒。 */
export function sleep(ms) {
    return new Promise((done) => setTimeout(done, ms));
}
/** 把任意字符串规范为文件名安全的小写短横线 slug。 */
export function slugify(text, fallback = 'modpack') {
    const slug = String(text ?? '')
        .normalize('NFKD')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug === '' ? fallback : slug.slice(0, 64);
}
/** 约束整数到 [min, max]，非有限数回落默认值。 */
export function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
/** 去重且保序。 */
export function unique(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
        }
    }
    return out;
}
/** 规范化 #RRGGBB / RRGGBB / #RGB，失败返回 fallback。 */
export function normalizeHex(value, fallback = '#FFFFFF') {
    if (typeof value !== 'string')
        return fallback;
    const raw = value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(raw))
        return `#${raw.toUpperCase()}`;
    if (/^[0-9a-fA-F]{3}$/.test(raw)) {
        return `#${raw
            .split('')
            .map((c) => c + c)
            .join('')
            .toUpperCase()}`;
    }
    return fallback;
}
/** #RRGGBB → 打包为 0xRRGGBB 整数（Minecraft JSON 的 color 字段格式）。 */
export function hexToRgbInt(value, fallback = 0xffffff) {
    const hex = normalizeHex(value, '');
    if (hex === '')
        return fallback;
    return Number.parseInt(hex.slice(1), 16);
}
/** #RRGGBB → { r, g, b }（0-255）。 */
export function hexToRgb(value, fallback = '#FFFFFF') {
    const int = hexToRgbInt(value, Number.parseInt(normalizeHex(fallback).slice(1), 16));
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}
// ── 宽松 JSON 取值（绝不对 API 响应结构做硬假设） ────────────────────────────
/** 只接受普通对象。 */
export function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
/** 只接受数组。 */
export function asArray(value) {
    return Array.isArray(value) ? value : [];
}
/** 取字符串，空串视为缺失。 */
export function asString(value, fallback = '') {
    return typeof value === 'string' && value !== '' ? value : fallback;
}
/** 取有限数字。 */
export function asNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
/** 取布尔。 */
export function asBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}
/** 取字符串数组，逐项过滤非字符串。 */
export function asStringArray(value) {
    return asArray(value).filter((item) => typeof item === 'string');
}
/** 必填字符串校验，缺失即 throw。 */
export function requireString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ModpackError('INVALID_ARGUMENT', `参数 ${field} 必须是非空字符串`);
    }
    return value.trim();
}
// ── 文件系统 ─────────────────────────────────────────────────────────────────
/** 递归建目录。 */
export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
    return dir;
}
/** 判断路径存在。 */
export async function pathExists(target) {
    try {
        await stat(target);
        return true;
    }
    catch {
        return false;
    }
}
/** 写文件（自动建父目录），先写临时文件再 rename，避免半截文件。 */
export async function writeFileEnsured(file, data) {
    await ensureDir(dirname(file));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    return file;
}
/** 读 JSON，失败时返回 fallback（用于读取可选的已有配置）。 */
export async function readJsonSafe(file, fallback = null) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
/** 读文本，失败时返回 fallback。 */
export async function readTextSafe(file, fallback = null) {
    try {
        return await readFile(file, 'utf8');
    }
    catch {
        return fallback;
    }
}
/** 统一成正斜杠路径片段（资源包/zip 内部路径必须如此）。 */
export function toPosix(p) {
    return p.split(sep).join('/');
}
/**
 * 把相对资源路径解析到 packDir 之下，并拒绝越界与绝对路径。
 * 这是"UI 资源必须写进正确目录"的强制闸门。
 */
export function resolveInside(root, ...segments) {
    const base = resolve(root);
    const target = resolve(base, ...segments);
    const rel = relative(base, target);
    if (rel === '' || rel.startsWith('..') || resolve(base, rel) !== target) {
        throw new ModpackError('PATH_ESCAPE', `拒绝写出整合包目录之外的路径：${segments.join('/')}`);
    }
    return target;
}
/** 资源包内的标准资源路径构造器：assets/<namespace>/<rest...>。 */
export function assetPath(namespace, ...rest) {
    const ns = /^[a-z0-9_.-]+$/.test(namespace) ? namespace : 'minecraft';
    return join('assets', ns, ...rest).split(sep).join('/');
}
// ── 摘要 ─────────────────────────────────────────────────────────────────────
/** sha1 十六进制摘要（用于 Modrinth 文件校验）。 */
export function sha1(data) {
    return createHash('sha1').update(data).digest('hex');
}
/** sha256 十六进制摘要。 */
export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
// ── CRC32（zip 与 png 共用） ─────────────────────────────────────────────────
let crcTable = null;
function crc32Table() {
    if (crcTable !== null)
        return crcTable;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    crcTable = table;
    return table;
}
/** CRC32（zip / PNG IEND 校验用），返回无符号 32 位。 */
export function crc32(data) {
    const table = crc32Table();
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
// ── 限速与重试 ───────────────────────────────────────────────────────────────
/**
 * 串行限速器：保证同类请求之间至少间隔 minIntervalMs。
 * Pollinations 匿名额度是 1 req/15s，必须靠它避免 402。
 */
export class RateLimiter {
    minIntervalMs;
    nextAt = 0;
    constructor(minIntervalMs) {
        this.minIntervalMs = minIntervalMs;
    }
    /** 等到可以发起下一次请求。 */
    async acquire() {
        const now = Date.now();
        const wait = this.nextAt - now;
        if (wait > 0)
            await sleep(wait);
        this.nextAt = Date.now() + this.minIntervalMs;
    }
}
/** 重试判定：网络错误、429、5xx、以及 Pollinations 的 402 额度响应。 */
export function isRetryableStatus(status) {
    return status === 402 || status === 408 || status === 425 || status === 429 || status >= 500;
}
/**
 * 通用重试包装。attempts 为总尝试次数，退避为 baseDelayMs * 2^(n-1)。
 * @param label 出错信息里的人类可读前缀
 */
export async function withRetry(label, attempts, baseDelayMs, run, shouldRetry = () => true) {
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
        try {
            return await run(attempt);
        }
        catch (error) {
            lastError = error;
            if (attempt >= attempts || !shouldRetry(error))
                break;
            await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ModpackError('RETRY_EXHAUSTED', `${label}失败（已尝试 ${attempts} 次）：${detail}`);
}
/** 组合取消信号：parent 中止时通知 child。 */
export function linkSignal(parent) {
    const controller = new AbortController();
    if (parent === undefined)
        return { signal: controller.signal, dispose: () => { } };
    if (parent.aborted)
        controller.abort();
    const onAbort = () => controller.abort();
    parent.addEventListener('abort', onAbort, { once: true });
    return { signal: controller.signal, dispose: () => parent.removeEventListener('abort', onAbort) };
}
/** 当前时间 ISO 字符串。 */
export function nowIso() {
    return new Date().toISOString();
}
//# sourceMappingURL=util.js.map