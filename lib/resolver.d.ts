/**
 * dsh-tool-modpack — 模组依赖解析器。
 *
 * 纯 BFS + 环检测，最大深度硬上限 50（不会无限递归）。所有网络读取都通过注入的
 * VersionSource 完成，因此测试里可以完全离线断言解析行为。
 *
 * @module dsh-tool-modpack/resolver
 */
import type { ModLoader, ModrinthProject, ModrinthVersion, VersionFilter } from './modrinth.js';
/** 解析深度硬上限（需求规定 50）。 */
export declare const MAX_RESOLVE_DEPTH = 50;
/** 解析所需的版本数据源（生产用 ModrinthClient 适配，测试用 mock）。 */
export interface VersionSource {
    getVersion(versionId: string): Promise<ModrinthVersion>;
    getProjectVersions(idOrSlug: string, filter: VersionFilter): Promise<ModrinthVersion[]>;
    getProject(idOrSlug: string): Promise<ModrinthProject>;
}
/** 一个解析根：可以指定项目 slug/id，也可以锁定某个 versionId。 */
export interface ResolveRoot {
    /** 项目 slug 或 project id。与 versionId 二选一，versionId 优先。 */
    id?: string;
    /** 直接锁定的版本 id。 */
    versionId?: string;
    /** 人类可读的来源标签，写入 requestedBy。 */
    label?: string;
}
/** 解析参数。 */
export interface ResolveOptions {
    gameVersion: string;
    loader: ModLoader;
    /** 最大遍历深度，默认 50，硬上限 50。 */
    maxDepth?: number;
    /** 是否纳入 optional 依赖（默认 false）。 */
    includeOptional?: boolean;
    /** 客户端/服务端过滤：'client' 时跳过 server-only，'server' 时跳过 client-only。 */
    side?: 'both' | 'client' | 'server';
}
/** 解析出的一个待安装模组。 */
export interface ResolvedNode {
    projectId: string;
    slug: string;
    title: string;
    versionId: string;
    versionNumber: string;
    versionType: string;
    fileName: string;
    downloadUrl: string;
    sha1: string;
    size: number;
    /** root = 用户显式指定；required/optional = 依赖引入；embedded = 已内嵌，不单独下载。 */
    role: 'root' | 'required' | 'optional' | 'embedded';
    /** 从根到此节点的层数，root 为 0。 */
    depth: number;
    /** 谁请求了它（项目 slug 列表）。 */
    requestedBy: string[];
    loaders: string[];
    gameVersions: string[];
    /** 解析时命中的兼容性提示（例如仅客户端可用）。 */
    notes: string[];
}
/** 解析过程中的问题记录。 */
export interface ResolutionIssue {
    kind: 'cycle' | 'depth-limit' | 'missing' | 'incompatible' | 'no-version' | 'version-conflict' | 'incompatible-declared';
    subject: string;
    message: string;
    requestedBy: string[];
}
/** 解析结果。 */
export interface ResolutionResult {
    nodes: ResolvedNode[];
    /** 安装顺序（依赖优先，深度升序）。 */
    installOrder: string[];
    issues: ResolutionIssue[];
    stats: {
        fetchedVersions: number;
        fetchedProjects: number;
        maxDepthReached: number;
        cycles: number;
        skippedOptional: number;
    };
}
/**
 * 解析依赖链。
 *
 * @param roots 用户显式指定的模组
 * @param source 版本数据源
 * @param options 游戏版本、加载器等约束
 */
export declare function resolveDependencies(roots: ResolveRoot[], source: VersionSource, options: ResolveOptions): Promise<ResolutionResult>;
/** 冲突检查结果。 */
export interface ConflictReport {
    /** 同一项目出现多个版本。 */
    conflicts: Array<{
        projectId: string;
        versions: string[];
        message: string;
    }>;
    /** 声明式不兼容。 */
    declared: Array<{
        subject: string;
        message: string;
    }>;
    /** 已知的"不能共存"组合（社区经验规则表）。 */
    knownPairs: Array<{
        a: string;
        b: string;
        message: string;
        severity: 'error' | 'warning';
    }>;
    /** 缺少的前置。 */
    missing: Array<{
        subject: string;
        message: string;
    }>;
    verdict: 'ok' | 'warning' | 'conflict';
}
type KnownRule = {
    a: readonly string[];
    b: readonly string[];
    message: string;
    severity: 'error' | 'warning';
};
/**
 * 社区已知冲突规则表（按 slug/id 片段匹配，命中即报）。
 * 只收录稳定的"功能重叠 / 结构性冲突"，避免误报。
 */
export declare const KNOWN_CONFLICT_RULES: readonly KnownRule[];
/** 对已解析结果做冲突检查（含社区规则表）。 */
export declare function checkConflicts(nodes: ResolvedNode[], issues?: ResolutionIssue[]): ConflictReport;
export {};
//# sourceMappingURL=resolver.d.ts.map