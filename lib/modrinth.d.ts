/**
 * dsh-tool-modpack — Modrinth REST API v2 客户端。
 *
 * 零 SDK 依赖：只用可注入的 fetch。**不对响应结构做硬假设**——所有字段都经过
 * 宽松映射（map* 系列），缺失字段回落为 null / 空数组，未知字段直接丢弃。
 *
 * 端点（2026-10 实测可用）：
 *  - GET  /v2/search?query=&facets=&index=&limit=&offset=
 *  - GET  /v2/project/{id|slug}
 *  - GET  /v2/project/{id|slug}/version?loaders=["fabric"]&game_versions=["1.20.1"]
 *  - GET  /v2/version/{id}
 *  - GET  /v2/versions?ids=["...","..."]        ← 批量（注意：不是 POST）
 *  - 文件直链在 cdn.modrinth.com，不需要 Authorization
 *
 * @module dsh-tool-modpack/modrinth
 */
import { type FetchLike } from './util.js';
/** Modrinth API 根地址。 */
export declare const MODRINTH_API_BASE = "https://api.modrinth.com/v2";
/** Modrinth 要求带可识别的 User-Agent，否则会被限流。 */
export declare const MODRINTH_USER_AGENT = "dsh-tool-modpack/0.1.0 (DeepSeek Harness tool plugin; +https://github.com/deepseek-ai/deepseek-harness)";
/** 支持的模组加载器。 */
export type ModLoader = 'fabric' | 'forge' | 'neoforge' | 'quilt';
/** Modrinth 项目类型。 */
export type ProjectType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack' | 'plugin';
/** 依赖类型。 */
export type DependencyType = 'required' | 'optional' | 'incompatible' | 'embedded' | 'unknown';
/** 搜索排序方式（Modrinth index 参数）。 */
export type SearchIndex = 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated';
/** 搜索命中的项目摘要。 */
export interface ModrinthSearchHit {
    projectId: string;
    slug: string;
    title: string;
    description: string;
    author: string;
    projectType: string;
    categories: string[];
    versions: string[];
    downloads: number;
    follows: number;
    iconUrl: string | null;
    license: string;
    clientSide: string;
    serverSide: string;
    environment: string[];
    dateModified: string | null;
    latestVersion: string | null;
    url: string;
}
/** 项目详情。 */
export interface ModrinthProject {
    id: string;
    slug: string;
    title: string;
    description: string;
    body: string;
    projectType: string;
    categories: string[];
    loaders: string[];
    gameVersions: string[];
    downloads: number;
    followers: number;
    license: string;
    clientSide: string;
    serverSide: string;
    sourceUrl: string | null;
    issuesUrl: string | null;
    wikiUrl: string | null;
    discordUrl: string | null;
    iconUrl: string | null;
    published: string | null;
    updated: string | null;
    url: string;
}
/** 依赖声明。 */
export interface ModrinthDependency {
    versionId: string | null;
    projectId: string | null;
    fileName: string | null;
    dependencyType: DependencyType;
}
/** 版本文件。 */
export interface ModrinthFile {
    url: string;
    filename: string;
    primary: boolean;
    size: number;
    sha1: string;
    sha512: string;
}
/** 版本详情。 */
export interface ModrinthVersion {
    id: string;
    projectId: string;
    name: string;
    versionNumber: string;
    versionType: string;
    gameVersions: string[];
    loaders: string[];
    environment: string;
    downloads: number;
    datePublished: string | null;
    files: ModrinthFile[];
    dependencies: ModrinthDependency[];
}
/** 搜索参数。 */
export interface ModrinthSearchQuery {
    query?: string;
    projectType?: ProjectType;
    loaders?: ModLoader[];
    gameVersions?: string[];
    categories?: string[];
    clientSideOnly?: boolean;
    serverSideOnly?: boolean;
    index?: SearchIndex;
    limit?: number;
    offset?: number;
}
/** 搜索结果。 */
export interface ModrinthSearchResult {
    hits: ModrinthSearchHit[];
    totalHits: number;
    offset: number;
    limit: number;
}
/** 版本筛选参数。 */
export interface VersionFilter {
    loaders?: ModLoader[];
    gameVersions?: string[];
    releaseOnly?: boolean;
}
/** 客户端构造参数。 */
export interface ModrinthClientOptions {
    fetchImpl?: FetchLike;
    userAgent?: string;
    baseUrl?: string;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    signal?: AbortSignal;
}
/** 映射一条搜索命中。 */
export declare function mapSearchHit(raw: unknown): ModrinthSearchHit;
/** 映射项目详情。 */
export declare function mapProject(raw: unknown): ModrinthProject;
/** 映射一个版本文件。 */
export declare function mapFile(raw: unknown): ModrinthFile;
/** 映射版本详情。 */
export declare function mapVersion(raw: unknown): ModrinthVersion;
/** 取版本的主文件；没有 primary 标记时回落到第一个 .jar。 */
export declare function pickPrimaryFile(version: ModrinthVersion): ModrinthFile | null;
/** 构造 search 的 facets 参数（JSON 二维数组，已 URL 编码）。 */
export declare function buildSearchFacets(query: ModrinthSearchQuery): string | null;
/** 判断某版本是否同时满足游戏版本与加载器要求。 */
export declare function checkVersionCompatibility(version: ModrinthVersion, want: {
    gameVersion?: string;
    loader?: ModLoader | string;
}): {
    compatible: boolean;
    reasons: string[];
};
/**
 * 从版本列表中挑选最合适的一个：先按 release > beta > alpha，再按发布时间新到旧。
 * 返回 null 表示没有任何可用版本。
 */
export declare function selectBestVersion(versions: ModrinthVersion[], want?: {
    gameVersion?: string;
    loader?: ModLoader | string;
    releaseOnly?: boolean;
}): ModrinthVersion | null;
/** Modrinth v2 客户端。所有故障按契约直接 throw（ModpackError）。 */
export declare class ModrinthClient {
    private readonly fetchImpl;
    private readonly userAgent;
    private readonly baseUrl;
    private readonly maxAttempts;
    private readonly retryBaseDelayMs;
    private readonly signal;
    constructor(options?: ModrinthClientOptions);
    /** 带重试与错误归一化的底层请求，返回解析后的 JSON。 */
    private request;
    /** 搜索项目。 */
    searchMods(query?: ModrinthSearchQuery): Promise<ModrinthSearchResult>;
    /** 读取项目详情。 */
    getProject(idOrSlug: string): Promise<ModrinthProject>;
    /** 读取项目的版本列表（可按加载器/游戏版本过滤）。 */
    getProjectVersions(idOrSlug: string, filter?: VersionFilter): Promise<ModrinthVersion[]>;
    /** 读取单个版本。 */
    getVersion(versionId: string): Promise<ModrinthVersion>;
    /** 批量读取版本（GET /v2/versions?ids=[...]，单次上限 1000 条）。 */
    getVersionsByIds(ids: string[]): Promise<ModrinthVersion[]>;
    /** 解析项目标识（slug 或 id）→ 项目详情；不存在时 throw。 */
    resolveProject(identifier: string): Promise<ModrinthProject>;
    /**
     * 下载版本文件到本地路径，校验 sha1 后落盘。
     * 返回落盘信息；校验失败时 throw（不留下半个文件）。
     */
    downloadFile(file: ModrinthFile, destPath: string): Promise<{
        path: string;
        size: number;
        sha1: string;
        verified: boolean;
    }>;
}
/** 生产用共享客户端（工具层默认使用）。 */
export declare function createModrinthClient(options?: ModrinthClientOptions): ModrinthClient;
//# sourceMappingURL=modrinth.d.ts.map