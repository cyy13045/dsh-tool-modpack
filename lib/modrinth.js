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
import { ModpackError, asArray, asBoolean, asNumber, asRecord, asString, asStringArray, globalFetch, isRetryableStatus, sha1, sleep, writeFileEnsured, } from './util.js';
/** Modrinth API 根地址。 */
export const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
/** Modrinth 要求带可识别的 User-Agent，否则会被限流。 */
export const MODRINTH_USER_AGENT = 'dsh-tool-modpack/0.1.0 (DeepSeek Harness tool plugin; +https://github.com/deepseek-ai/deepseek-harness)';
// ── 宽松映射 ─────────────────────────────────────────────────────────────────
const KNOWN_DEPENDENCY_TYPES = ['required', 'optional', 'incompatible', 'embedded'];
function mapDependencyType(raw) {
    const value = asString(raw, 'unknown');
    return KNOWN_DEPENDENCY_TYPES.includes(value) ? value : 'unknown';
}
/** 映射一条搜索命中。 */
export function mapSearchHit(raw) {
    const hit = asRecord(raw);
    const slug = asString(hit.slug, asString(hit.project_id));
    return {
        projectId: asString(hit.project_id),
        slug,
        title: asString(hit.title, slug),
        description: asString(hit.description),
        author: asString(hit.author),
        projectType: asString(hit.project_type, 'mod'),
        categories: asStringArray(hit.display_categories ?? hit.categories),
        versions: asStringArray(hit.versions),
        downloads: asNumber(hit.downloads),
        follows: asNumber(hit.follows),
        iconUrl: typeof hit.icon_url === 'string' && hit.icon_url !== '' ? hit.icon_url : null,
        license: asString(hit.license, 'unknown'),
        clientSide: asString(hit.client_side, 'unknown'),
        serverSide: asString(hit.server_side, 'unknown'),
        environment: asStringArray(hit.environment),
        dateModified: asString(hit.date_modified, '') || null,
        latestVersion: asString(hit.latest_version, '') || null,
        url: slug === '' ? '' : `https://modrinth.com/${asString(hit.project_type, 'mod')}/${slug}`,
    };
}
/** 映射项目详情。 */
export function mapProject(raw) {
    const project = asRecord(raw);
    const slug = asString(project.slug, asString(project.id));
    return {
        id: asString(project.id),
        slug,
        title: asString(project.title, slug),
        description: asString(project.description),
        body: asString(project.body),
        projectType: asString(project.project_type, 'mod'),
        categories: asStringArray(project.categories),
        loaders: asStringArray(project.loaders),
        gameVersions: asStringArray(project.game_versions),
        downloads: asNumber(project.downloads),
        followers: asNumber(project.followers),
        license: mapLicense(project.license),
        clientSide: asString(project.client_side, 'unknown'),
        serverSide: asString(project.server_side, 'unknown'),
        sourceUrl: asString(project.source_url, '') || null,
        issuesUrl: asString(project.issues_url, '') || null,
        wikiUrl: asString(project.wiki_url, '') || null,
        discordUrl: asString(project.discord_url, '') || null,
        iconUrl: asString(project.icon_url, '') || null,
        published: asString(project.published, '') || null,
        updated: asString(project.updated, '') || null,
        url: slug === '' ? '' : `https://modrinth.com/${asString(project.project_type, 'mod')}/${slug}`,
    };
}
function mapLicense(raw) {
    if (typeof raw === 'string')
        return raw;
    return asString(asRecord(raw).id, 'unknown');
}
/** 映射一个版本文件。 */
export function mapFile(raw) {
    const file = asRecord(raw);
    const hashes = asRecord(file.hashes);
    return {
        url: asString(file.url),
        filename: asString(file.filename, 'unknown.jar'),
        primary: asBoolean(file.primary),
        size: asNumber(file.size),
        sha1: asString(hashes.sha1),
        sha512: asString(hashes.sha512),
    };
}
/** 映射版本详情。 */
export function mapVersion(raw) {
    const version = asRecord(raw);
    return {
        id: asString(version.id),
        projectId: asString(version.project_id),
        name: asString(version.name, asString(version.version_number)),
        versionNumber: asString(version.version_number),
        versionType: asString(version.version_type, 'release'),
        gameVersions: asStringArray(version.game_versions),
        loaders: asStringArray(version.loaders),
        environment: asString(version.environment, 'unknown'),
        downloads: asNumber(version.downloads),
        datePublished: asString(version.date_published, '') || null,
        files: asArray(version.files).map(mapFile),
        dependencies: asArray(version.dependencies).map((entry) => {
            const dep = asRecord(entry);
            return {
                versionId: asString(dep.version_id, '') || null,
                projectId: asString(dep.project_id, '') || null,
                fileName: asString(dep.file_name, '') || null,
                dependencyType: mapDependencyType(dep.dependency_type),
            };
        }),
    };
}
/** 取版本的主文件；没有 primary 标记时回落到第一个 .jar。 */
export function pickPrimaryFile(version) {
    const primary = version.files.find((file) => file.primary);
    if (primary !== undefined)
        return primary;
    const jar = version.files.find((file) => file.filename.endsWith('.jar'));
    return jar ?? version.files[0] ?? null;
}
/** 构造 search 的 facets 参数（JSON 二维数组，已 URL 编码）。 */
export function buildSearchFacets(query) {
    const groups = [];
    if (query.projectType !== undefined)
        groups.push([`project_type:${query.projectType}`]);
    if (query.categories !== undefined && query.categories.length > 0) {
        groups.push(query.categories.map((category) => `categories:${category}`));
    }
    if (query.loaders !== undefined && query.loaders.length > 0) {
        groups.push(query.loaders.map((loader) => `categories:${loader}`));
    }
    if (query.gameVersions !== undefined && query.gameVersions.length > 0) {
        groups.push(query.gameVersions.map((version) => `versions:${version}`));
    }
    if (query.clientSideOnly === true)
        groups.push(['client_side:required', 'client_side:optional']);
    if (query.serverSideOnly === true)
        groups.push(['server_side:required', 'server_side:optional']);
    if (groups.length === 0)
        return null;
    return JSON.stringify(groups);
}
/** 判断某版本是否同时满足游戏版本与加载器要求。 */
export function checkVersionCompatibility(version, want) {
    const reasons = [];
    if (want.gameVersion !== undefined && !version.gameVersions.includes(want.gameVersion)) {
        reasons.push(`不支持游戏版本 ${want.gameVersion}（该版本支持：${version.gameVersions.join(', ') || '未知'}）`);
    }
    if (want.loader !== undefined && version.loaders.length > 0 && !version.loaders.includes(want.loader)) {
        reasons.push(`不支持加载器 ${want.loader}（该版本支持：${version.loaders.join(', ')}）`);
    }
    return { compatible: reasons.length === 0, reasons };
}
/**
 * 从版本列表中挑选最合适的一个：先按 release > beta > alpha，再按发布时间新到旧。
 * 返回 null 表示没有任何可用版本。
 */
export function selectBestVersion(versions, want = {}) {
    const typeRank = { release: 0, beta: 1, alpha: 2 };
    const candidates = versions
        .filter((version) => {
        if (want.releaseOnly === true && version.versionType !== 'release')
            return false;
        return checkVersionCompatibility(version, want).compatible;
    })
        .sort((a, b) => {
        const rank = (typeRank[a.versionType] ?? 3) - (typeRank[b.versionType] ?? 3);
        if (rank !== 0)
            return rank;
        return (b.datePublished ?? '').localeCompare(a.datePublished ?? '');
    });
    return candidates[0] ?? null;
}
// ── 客户端 ───────────────────────────────────────────────────────────────────
/** Modrinth v2 客户端。所有故障按契约直接 throw（ModpackError）。 */
export class ModrinthClient {
    fetchImpl;
    userAgent;
    baseUrl;
    maxAttempts;
    retryBaseDelayMs;
    signal;
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl ?? globalFetch;
        this.userAgent = options.userAgent ?? MODRINTH_USER_AGENT;
        this.baseUrl = options.baseUrl ?? MODRINTH_API_BASE;
        this.maxAttempts = options.maxAttempts ?? 4;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 700;
        this.signal = options.signal;
    }
    /** 带重试与错误归一化的底层请求，返回解析后的 JSON。 */
    async request(pathAndQuery, init) {
        const url = `${this.baseUrl}${pathAndQuery}`;
        let lastMessage = '';
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            let response;
            try {
                response = await this.fetchImpl(url, {
                    method: init?.method ?? 'GET',
                    headers: {
                        'User-Agent': this.userAgent,
                        Accept: 'application/json',
                        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    },
                    ...(init?.body !== undefined ? { body: init.body } : {}),
                    ...(this.signal !== undefined ? { signal: this.signal } : {}),
                });
            }
            catch (error) {
                lastMessage = error instanceof Error ? error.message : String(error);
                if (attempt < this.maxAttempts) {
                    await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
                    continue;
                }
                throw new ModpackError('MODRINTH_NETWORK', `无法连接 Modrinth API（${url}）：${lastMessage}`);
            }
            const text = await response.text();
            if (response.ok) {
                try {
                    return JSON.parse(text);
                }
                catch {
                    throw new ModpackError('MODRINTH_BAD_JSON', `Modrinth 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`);
                }
            }
            lastMessage = `HTTP ${response.status} ${text.slice(0, 200)}`;
            if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
                const retryAfter = Number(response.headers.get('retry-after') ?? '0');
                const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : this.retryBaseDelayMs * 2 ** (attempt - 1);
                await sleep(waitMs);
                continue;
            }
            if (response.status === 404) {
                throw new ModpackError('MODRINTH_NOT_FOUND', `Modrinth 上没有这个资源（404）：${pathAndQuery}`);
            }
            throw new ModpackError('MODRINTH_HTTP', `Modrinth API 返回 HTTP ${response.status}：${text.slice(0, 300)}`);
        }
        throw new ModpackError('MODRINTH_HTTP', `Modrinth API 重试耗尽：${lastMessage}`);
    }
    /** 搜索项目。 */
    async searchMods(query = {}) {
        const params = new URLSearchParams();
        params.set('query', query.query ?? '');
        params.set('index', query.index ?? 'relevance');
        params.set('limit', String(Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)))));
        params.set('offset', String(Math.max(0, Math.trunc(query.offset ?? 0))));
        const facets = buildSearchFacets(query);
        if (facets !== null)
            params.set('facets', facets);
        const raw = asRecord(await this.request(`/search?${params.toString()}`));
        return {
            hits: asArray(raw.hits).map(mapSearchHit),
            totalHits: asNumber(raw.total_hits),
            offset: asNumber(raw.offset),
            limit: asNumber(raw.limit, 20),
        };
    }
    /** 读取项目详情。 */
    async getProject(idOrSlug) {
        return mapProject(await this.request(`/project/${encodeURIComponent(idOrSlug)}`));
    }
    /** 读取项目的版本列表（可按加载器/游戏版本过滤）。 */
    async getProjectVersions(idOrSlug, filter = {}) {
        const params = new URLSearchParams();
        if (filter.loaders !== undefined && filter.loaders.length > 0) {
            params.set('loaders', JSON.stringify(filter.loaders));
        }
        if (filter.gameVersions !== undefined && filter.gameVersions.length > 0) {
            params.set('game_versions', JSON.stringify(filter.gameVersions));
        }
        const suffix = params.size > 0 ? `?${params.toString()}` : '';
        const raw = await this.request(`/project/${encodeURIComponent(idOrSlug)}/version${suffix}`);
        const versions = asArray(raw).map(mapVersion);
        return filter.releaseOnly === true ? versions.filter((version) => version.versionType === 'release') : versions;
    }
    /** 读取单个版本。 */
    async getVersion(versionId) {
        return mapVersion(await this.request(`/version/${encodeURIComponent(versionId)}`));
    }
    /** 批量读取版本（GET /v2/versions?ids=[...]，单次上限 1000 条）。 */
    async getVersionsByIds(ids) {
        const clean = ids.filter((id) => typeof id === 'string' && id !== '');
        if (clean.length === 0)
            return [];
        const out = [];
        for (let i = 0; i < clean.length; i += 500) {
            const chunk = clean.slice(i, i + 500);
            const raw = await this.request(`/versions?ids=${encodeURIComponent(JSON.stringify(chunk))}`);
            out.push(...asArray(raw).map(mapVersion));
        }
        return out;
    }
    /** 解析项目标识（slug 或 id）→ 项目详情；不存在时 throw。 */
    async resolveProject(identifier) {
        const value = identifier.trim();
        if (value === '')
            throw new ModpackError('INVALID_ARGUMENT', '项目标识不能为空');
        return this.getProject(value);
    }
    /**
     * 下载版本文件到本地路径，校验 sha1 后落盘。
     * 返回落盘信息；校验失败时 throw（不留下半个文件）。
     */
    async downloadFile(file, destPath) {
        if (file.url === '')
            throw new ModpackError('MODRINTH_NO_URL', `版本文件 ${file.filename} 缺少下载地址`);
        let response;
        try {
            response = await this.fetchImpl(file.url, {
                method: 'GET',
                headers: { 'User-Agent': this.userAgent },
                ...(this.signal !== undefined ? { signal: this.signal } : {}),
            });
        }
        catch (error) {
            throw new ModpackError('MODRINTH_DOWNLOAD', `下载 ${file.filename} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) {
            throw new ModpackError('MODRINTH_DOWNLOAD', `下载 ${file.filename} 失败：HTTP ${response.status}`);
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        const digest = sha1(buffer);
        const expected = file.sha1.trim().toLowerCase();
        const verified = expected !== '' && digest === expected;
        if (expected !== '' && !verified) {
            throw new ModpackError('MODRINTH_HASH_MISMATCH', `下载 ${file.filename} 校验失败：期望 sha1 ${expected}，实际 ${digest}`);
        }
        await writeFileEnsured(destPath, buffer);
        return { path: destPath, size: buffer.byteLength, sha1: digest, verified };
    }
}
/** 生产用共享客户端（工具层默认使用）。 */
export function createModrinthClient(options = {}) {
    return new ModrinthClient(options);
}
//# sourceMappingURL=modrinth.js.map