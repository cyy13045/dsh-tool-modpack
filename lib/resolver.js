/**
 * dsh-tool-modpack — 模组依赖解析器。
 *
 * 纯 BFS + 环检测，最大深度硬上限 50（不会无限递归）。所有网络读取都通过注入的
 * VersionSource 完成，因此测试里可以完全离线断言解析行为。
 *
 * @module dsh-tool-modpack/resolver
 */
import { ModpackError, clampInt, unique, } from './util.js';
/** 解析深度硬上限（需求规定 50）。 */
export const MAX_RESOLVE_DEPTH = 50;
function isSideCompatible(version, side) {
    const env = version.environment.toLowerCase();
    if (side === 'server' && env === 'client_only') {
        return { ok: false, note: '该版本标记为仅客户端（client_only），服务端整合包不应包含' };
    }
    if (side === 'client' && env === 'server_only') {
        return { ok: false, note: '该版本标记为仅服务端（server_only），客户端整合包不应包含' };
    }
    return { ok: true, note: null };
}
/**
 * 解析依赖链。
 *
 * @param roots 用户显式指定的模组
 * @param source 版本数据源
 * @param options 游戏版本、加载器等约束
 */
export async function resolveDependencies(roots, source, options) {
    const maxDepth = clampInt(options.maxDepth, 1, MAX_RESOLVE_DEPTH, MAX_RESOLVE_DEPTH);
    const side = options.side ?? 'both';
    const includeOptional = options.includeOptional === true;
    const nodes = [];
    const issues = [];
    /** projectId → 已解析节点索引，避免同一项目重复解析。 */
    const byProject = new Map();
    /** 记录每条依赖边的 子→父，用于环检测。 */
    const edges = [];
    const requestedByOf = new Map();
    const stats = {
        fetchedVersions: 0,
        fetchedProjects: 0,
        maxDepthReached: 0,
        cycles: 0,
        skippedOptional: 0,
    };
    const queue = roots.map((root) => ({
        id: root.id ?? root.versionId ?? '',
        versionId: root.versionId ?? null,
        depth: 0,
        role: 'root',
        requestedBy: [root.label ?? root.id ?? root.versionId ?? 'root'],
        parentKey: null,
    }));
    if (queue.some((item) => item.id === '' && item.versionId === null)) {
        throw new ModpackError('INVALID_ARGUMENT', 'resolveDependencies 收到既没有 id 也没有 versionId 的根节点');
    }
    async function loadVersion(item) {
        if (item.versionId !== null && item.versionId !== '') {
            try {
                const version = await source.getVersion(item.versionId);
                stats.fetchedVersions += 1;
                return version;
            }
            catch (error) {
                issues.push({
                    kind: 'missing',
                    subject: item.versionId,
                    message: `找不到版本 ${item.versionId}：${error instanceof Error ? error.message : String(error)}`,
                    requestedBy: item.requestedBy,
                });
                return null;
            }
        }
        try {
            const versions = await source.getProjectVersions(item.id, {
                loaders: [options.loader],
                gameVersions: [options.gameVersion],
            });
            stats.fetchedVersions += 1;
            const rank = { release: 0, beta: 1, alpha: 2 };
            const best = versions
                .slice()
                .sort((a, b) => {
                const byType = (rank[a.versionType] ?? 3) - (rank[b.versionType] ?? 3);
                if (byType !== 0)
                    return byType;
                return (b.datePublished ?? '').localeCompare(a.datePublished ?? '');
            })[0];
            if (best === undefined) {
                issues.push({
                    kind: 'no-version',
                    subject: item.id,
                    message: `项目 ${item.id} 没有适配 ${options.gameVersion} / ${options.loader} 的版本`,
                    requestedBy: item.requestedBy,
                });
                return null;
            }
            return best;
        }
        catch (error) {
            issues.push({
                kind: 'missing',
                subject: item.id,
                message: `读取项目 ${item.id} 的版本失败：${error instanceof Error ? error.message : String(error)}`,
                requestedBy: item.requestedBy,
            });
            return null;
        }
    }
    while (queue.length > 0) {
        const item = queue.shift();
        if (item.depth > maxDepth) {
            issues.push({
                kind: 'depth-limit',
                subject: item.id,
                message: `依赖深度超过上限 ${maxDepth}，已停止展开（该分支未完整解析）`,
                requestedBy: item.requestedBy,
            });
            stats.maxDepthReached = Math.max(stats.maxDepthReached, item.depth);
            continue;
        }
        const version = await loadVersion(item);
        if (version === null)
            continue;
        const projectId = version.projectId !== '' ? version.projectId : item.id;
        const existingIndex = byProject.get(projectId);
        if (existingIndex !== undefined) {
            // 同一项目被多个来源请求：合并 requestedBy，并检查版本是否冲突。
            const existing = nodes[existingIndex];
            existing.requestedBy = unique([...existing.requestedBy, ...item.requestedBy]);
            if (item.versionId !== null && existing.versionId !== item.versionId) {
                issues.push({
                    kind: 'version-conflict',
                    subject: projectId,
                    message: `项目 ${projectId} 被要求两个不同版本：${existing.versionId} 与 ${item.versionId}`,
                    requestedBy: item.requestedBy,
                });
            }
            if (item.parentKey !== null)
                edges.push({ from: projectId, to: item.parentKey });
            continue;
        }
        let title = version.name;
        let slug = projectId;
        try {
            const project = await source.getProject(projectId);
            stats.fetchedProjects += 1;
            title = project.title;
            slug = project.slug;
        }
        catch {
            // 项目详情读不到不影响版本解析，继续用版本里的信息。
        }
        const sideCheck = isSideCompatible(version, side);
        const notes = [];
        if (sideCheck.note !== null)
            notes.push(sideCheck.note);
        const primary = version.files.find((file) => file.primary) ?? version.files[0] ?? null;
        const node = {
            projectId,
            slug,
            title,
            versionId: version.id,
            versionNumber: version.versionNumber,
            versionType: version.versionType,
            fileName: primary?.filename ?? '',
            downloadUrl: primary?.url ?? '',
            sha1: primary?.sha1 ?? '',
            size: primary?.size ?? 0,
            role: item.role,
            depth: item.depth,
            requestedBy: unique(item.requestedBy),
            loaders: version.loaders,
            gameVersions: version.gameVersions,
            notes,
        };
        nodes.push(node);
        byProject.set(projectId, nodes.length - 1);
        stats.maxDepthReached = Math.max(stats.maxDepthReached, item.depth);
        if (item.parentKey !== null)
            edges.push({ from: projectId, to: item.parentKey });
        requestedByOf.set(projectId, node.requestedBy);
        if (item.depth >= maxDepth) {
            if (version.dependencies.some((dep) => dep.dependencyType === 'required')) {
                issues.push({
                    kind: 'depth-limit',
                    subject: projectId,
                    message: `已到深度上限 ${maxDepth}，${title} 的必需依赖未继续展开`,
                    requestedBy: node.requestedBy,
                });
            }
            continue;
        }
        for (const dependency of version.dependencies) {
            if (dependency.dependencyType === 'incompatible') {
                issues.push({
                    kind: 'incompatible-declared',
                    subject: dependency.projectId ?? dependency.versionId ?? 'unknown',
                    message: `${title} 声明与 ${dependency.projectId ?? dependency.versionId ?? '未知项目'} 不兼容`,
                    requestedBy: node.requestedBy,
                });
                continue;
            }
            if (dependency.dependencyType === 'embedded')
                continue;
            if (dependency.dependencyType === 'optional' && !includeOptional) {
                stats.skippedOptional += 1;
                continue;
            }
            const nextId = dependency.projectId ?? dependency.versionId ?? '';
            if (nextId === '')
                continue;
            // 环检测：依赖目标如果已经是当前节点的祖先，说明构成环。
            const targetKey = dependency.projectId ?? nextId;
            if (dependency.projectId !== null && dependency.projectId !== '' && isAncestor(edges, projectId, targetKey)) {
                issues.push({
                    kind: 'cycle',
                    subject: targetKey,
                    message: `检测到循环依赖：${title} → ${targetKey} → … → ${title}`,
                    requestedBy: node.requestedBy,
                });
                stats.cycles += 1;
            }
            const knownProject = dependency.projectId !== null ? byProject.get(dependency.projectId) : undefined;
            if (knownProject !== undefined) {
                const known = nodes[knownProject];
                known.requestedBy = unique([...known.requestedBy, slug]);
                edges.push({ from: known.projectId, to: projectId });
                continue;
            }
            queue.push({
                id: nextId,
                versionId: dependency.versionId,
                depth: item.depth + 1,
                role: dependency.dependencyType === 'optional' ? 'optional' : 'required',
                requestedBy: [slug],
                parentKey: projectId,
            });
        }
    }
    const installOrder = nodes
        .slice()
        .sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title))
        .map((node) => node.projectId);
    return { nodes, installOrder, issues, stats };
}
/**
 * 判断 ancestor 是否是 child 的祖先。
 * `edges` 存的是一条 子 → 父 的依赖边，因此从 child 沿父链上溯即可。
 */
function isAncestor(edges, child, ancestor) {
    if (child === ancestor)
        return true;
    const parents = new Map();
    for (const edge of edges) {
        const list = parents.get(edge.from);
        if (list === undefined)
            parents.set(edge.from, [edge.to]);
        else
            list.push(edge.to);
    }
    const seen = new Set([child]);
    const stack = [child];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const parent of parents.get(current) ?? []) {
            if (parent === ancestor)
                return true;
            if (!seen.has(parent) && seen.size <= MAX_RESOLVE_DEPTH * MAX_RESOLVE_DEPTH) {
                seen.add(parent);
                stack.push(parent);
            }
        }
    }
    return false;
}
/**
 * 社区已知冲突规则表（按 slug/id 片段匹配，命中即报）。
 * 只收录稳定的"功能重叠 / 结构性冲突"，避免误报。
 */
export const KNOWN_CONFLICT_RULES = [
    {
        a: ['sodium', 'embeddium'],
        b: ['optifine', 'optifabric'],
        message: 'Sodium/Embeddium 与 OptiFine 的渲染管线互斥，二者只能保留一个',
        severity: 'error',
    },
    {
        a: ['sodium'],
        b: ['rubidium', 'magnesium'],
        message: 'Sodium（Fabric）与 Rubidium/Magnesium（Forge 系）属于不同加载器的同类模组',
        severity: 'error',
    },
    {
        a: ['iris', 'oculus'],
        b: ['optifine', 'shadersmod'],
        message: 'Iris/Oculus 与 OptiFine 内置光影互斥，请统一走 Iris 光影体系',
        severity: 'error',
    },
    {
        a: ['lithium', 'radium'],
        b: ['performant', 'ferritecore-legacy'],
        message: 'Lithium/Radium 与老牌优化模组存在功能重叠，可能双份修改同一逻辑',
        severity: 'warning',
    },
    {
        a: ['fabric-api', 'fabric'],
        b: ['forge', 'neoforge'],
        message: 'Fabric 系依赖与 Forge/NeoForge 系依赖不能同时存在于同一实例',
        severity: 'error',
    },
    {
        a: ['jei', 'rei', 'emi'],
        b: ['jei', 'rei', 'emi'],
        message: 'JEI / REI / EMI 是三种物品查看器，同时安装会重复渲染配方界面',
        severity: 'warning',
    },
    {
        a: ['optifine'],
        b: ['dynamiclights', 'entityculling'],
        message: 'OptiFine 与新版本动态光源/实体剔除模组存在重复功能',
        severity: 'warning',
    },
    {
        a: ['create'],
        b: ['create-fabric', 'create-original'],
        message: 'Create 的两个不同移植分支不能同时安装',
        severity: 'error',
    },
];
function matchesRule(list, token) {
    return list.some((entry) => token === entry || token.includes(entry));
}
/** 对已解析结果做冲突检查（含社区规则表）。 */
export function checkConflicts(nodes, issues = []) {
    const conflicts = [];
    const seen = new Map();
    for (const node of nodes) {
        const key = node.projectId;
        const set = seen.get(key) ?? new Set();
        set.add(node.versionId);
        seen.set(key, set);
    }
    for (const [projectId, versions] of seen) {
        if (versions.size > 1) {
            conflicts.push({
                projectId,
                versions: [...versions],
                message: `项目 ${projectId} 同时出现 ${versions.size} 个版本，整合包只能保留一个`,
            });
        }
    }
    const declared = issues
        .filter((issue) => issue.kind === 'incompatible-declared')
        .map((issue) => ({ subject: issue.subject, message: issue.message }));
    const knownPairs = [];
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const left = nodes[i];
            const right = nodes[j];
            const leftTokens = [left.slug, left.projectId, left.title.toLowerCase()].map((v) => v.toLowerCase());
            const rightTokens = [right.slug, right.projectId, right.title.toLowerCase()].map((v) => v.toLowerCase());
            for (const rule of KNOWN_CONFLICT_RULES) {
                const aHitsLeft = leftTokens.some((token) => matchesRule(rule.a, token));
                const bHitsRight = rightTokens.some((token) => matchesRule(rule.b, token));
                const aHitsRight = rightTokens.some((token) => matchesRule(rule.a, token));
                const bHitsLeft = leftTokens.some((token) => matchesRule(rule.b, token));
                if ((aHitsLeft && bHitsRight) || (aHitsRight && bHitsLeft)) {
                    knownPairs.push({
                        a: left.title,
                        b: right.title,
                        message: rule.message,
                        severity: rule.severity,
                    });
                }
            }
        }
    }
    const missing = issues
        .filter((issue) => issue.kind === 'missing' || issue.kind === 'no-version')
        .map((issue) => ({ subject: issue.subject, message: issue.message }));
    const hasError = conflicts.length > 0 ||
        declared.length > 0 ||
        knownPairs.some((pair) => pair.severity === 'error') ||
        issues.some((issue) => issue.kind === 'cycle');
    const hasWarning = knownPairs.length > 0 || missing.length > 0 || issues.some((issue) => issue.kind === 'depth-limit');
    return {
        conflicts,
        declared,
        knownPairs,
        missing,
        verdict: hasError ? 'conflict' : hasWarning ? 'warning' : 'ok',
    };
}
//# sourceMappingURL=resolver.js.map