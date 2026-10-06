/**
 * dsh-tool-modpack — 多平台发布模块。
 *
 * 产出"发布元数据 + 各平台清单"，并把发布前的合规检查（凭据泄漏 / 许可 / 版本号）
 * 一起做掉。不直接调用任何平台的发布 API——发布动作由用户在平台上完成，
 * 本模块负责把需要填的内容准备成可直接复制的 JSON / Markdown。
 *
 * 覆盖平台：
 *   - Modrinth（version 创建请求体）
 *   - CurseForge（manifest.json + 项目元数据）
 *   - MCBBS / 中文社区（发布帖骨架）
 *   - GitHub Releases（release 元数据 + 资产清单）
 *   - 网盘分发（changelog + 校验值清单）
 *
 * @module dsh-tool-modpack/publisher
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePack } from './tester.js';
import { ModpackError, ensureDir, nowIso, pathExists, readTextSafe, sha256, slugify, writeFileEnsured, } from './util.js';
import { readFile } from 'node:fs/promises';
function defaultPlatforms(input) {
    const platforms = input.platforms ?? ['modrinth', 'curseforge', 'github', 'mcbbs'];
    return [...new Set(platforms)];
}
/** 生成 Modrinth 的 version 创建请求体（POST /v2/version）。 */
export function buildModrinthVersionBody(input, artifactNames) {
    return {
        name: `${input.name} ${input.version}`,
        version_number: input.version,
        changelog: renderChangelog(input),
        dependencies: [],
        game_versions: input.gameVersions ?? [input.minecraftVersion],
        loaders: [input.loader],
        version_type: input.releaseType ?? 'release',
        featured: false,
        status: 'listed',
        project_id: input.modrinthProjectId ?? '<填写 Modrinth 项目 id 或 slug>',
        file_parts: artifactNames,
        primary_file: artifactNames[0] ?? '',
    };
}
/** 生成 CurseForge 的项目/版本元数据。 */
export function buildCurseForgeMetadata(input) {
    return {
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name: input.name,
        version: input.version,
        author: (input.authors ?? ['unknown'])[0] ?? 'unknown',
        minecraft: {
            version: input.minecraftVersion,
            modLoaders: [{ id: `${input.loader}-${input.loaderVersion ?? 'latest'}`, primary: true }],
        },
        license: input.license ?? 'All Rights Reserved',
        summary: input.summary ?? '',
        category: 'Modpacks',
        gameVersion: input.minecraftVersion,
        releaseType: input.releaseType ?? 'release',
        overrides: 'overrides',
    };
}
/** 生成 GitHub Release 元数据。 */
export function buildGitHubRelease(input, artifacts) {
    return {
        tag_name: `v${input.version}`,
        name: `${input.name} ${input.version}`,
        body: renderChangelog(input),
        draft: true,
        prerelease: (input.releaseType ?? 'release') !== 'release',
        assets: artifacts.map((artifact) => ({ name: artifact.path.split(/[\\/]/).pop() ?? artifact.path, size: artifact.size, sha256: artifact.sha256 })),
    };
}
/** 生成中文社区（MCBBS 风格）发布帖骨架。 */
export function buildCommunityPost(input) {
    const lines = [];
    lines.push(`# 【整合包】${input.name} ${input.version}`);
    lines.push('');
    lines.push(`- 游戏版本：Minecraft ${input.minecraftVersion}（${input.loader}${input.loaderVersion !== undefined && input.loaderVersion !== null ? ` ${input.loaderVersion}` : ''}）`);
    lines.push(`- 作者：${(input.authors ?? ['未署名']).join('、')}`);
    lines.push(`- 许可：${input.license ?? '未声明'}`);
    if (input.homepage !== undefined)
        lines.push(`- 主页：${input.homepage}`);
    lines.push('');
    lines.push('## 简介');
    lines.push(input.summary ?? input.description ?? '（待补充）');
    lines.push('');
    lines.push('## 玩法特色');
    for (const change of input.changes ?? ['（待补充）'])
        lines.push(`- ${change}`);
    lines.push('');
    lines.push('## 安装说明');
    lines.push('1. 下载整合包压缩包与对应启动器；');
    lines.push(`2. 在启动器中创建 Minecraft ${input.minecraftVersion} / ${input.loader} 实例；`);
    lines.push('3. 把压缩包内的 mods/config 等目录解压到实例根目录；');
    lines.push('4. 分配建议内存并启动。');
    lines.push('');
    lines.push('## 已知问题');
    for (const issue of input.knownIssues ?? ['暂无'])
        lines.push(`- ${issue}`);
    lines.push('');
    lines.push('## 更新日志');
    lines.push('```');
    lines.push(renderChangelog(input).trim());
    lines.push('```');
    return `${lines.join('\n')}\n`;
}
/** 生成更新日志文本。 */
export function renderChangelog(input) {
    const lines = [];
    lines.push(`${input.name} ${input.version}`);
    lines.push('');
    if ((input.changes ?? []).length > 0) {
        lines.push('新增 / 变更：');
        for (const change of input.changes ?? [])
            lines.push(`- ${change}`);
    }
    else {
        lines.push('新增 / 变更：');
        lines.push('- 首次发布');
    }
    if ((input.knownIssues ?? []).length > 0) {
        lines.push('');
        lines.push('已知问题：');
        for (const issue of input.knownIssues ?? [])
            lines.push(`- ${issue}`);
    }
    lines.push('');
    lines.push(`适用版本：Minecraft ${input.minecraftVersion} / ${input.loader}`);
    return lines.join('\n');
}
/** 生成发布校验值清单。 */
export function renderChecksumList(artifacts) {
    const lines = ['# 校验值清单（sha256）', ''];
    for (const artifact of artifacts) {
        lines.push(`- ${artifact.path.split(/[\\/]/).pop() ?? artifact.path}`);
        lines.push(`  - 体积：${(artifact.size / 1024 / 1024).toFixed(2)} MB`);
        lines.push(`  - sha256：\`${artifact.sha256}\``);
    }
    return `${lines.join('\n')}\n`;
}
/** 采集产物信息（体积 + sha256）。 */
export async function collectArtifacts(paths) {
    const out = [];
    for (const file of paths) {
        if (!(await pathExists(file))) {
            throw new ModpackError('ARTIFACT_MISSING', `找不到发布产物：${file}`);
        }
        const buffer = await readFile(file);
        out.push({ path: file, size: buffer.byteLength, sha256: sha256(buffer) });
    }
    return out;
}
/** 平台发布步骤模板。 */
const PLATFORM_STEPS = {
    modrinth: [
        '登录 modrinth.com，在项目页左侧选择 Versions → Create version',
        '版本号填 publish/modrinth-version.json 的 version_number',
        '加载器与游戏版本按同文件填写；上传 file_parts 里的产物',
        '把 changelog 字段内容粘到更新日志框',
        '确认「环境」勾选正确（客户端/服务端），提交',
    ],
    curseforge: [
        '在 curseforge.com 项目页 Upload File',
        '上传 publish 目录里的整合包 zip（含 manifest.json 与 overrides/）',
        'Game Version 选 Minecraft ' + '${MC}' + '，Modloader 选对应加载器',
        'Release Type 与项目分类按 publish/curseforge-metadata.json 填写',
    ],
    github: [
        '在仓库 Releases → Draft a new release',
        '用 publish/github-release.json 的 tag_name / name / body',
        '上传 publish/checksums.txt 中列出的产物',
        '勾选 Set as pre-release（若 releaseType 不是 release）后发布',
    ],
    mcbbs: [
        '把 publish/community-post.md 内容贴到论坛发布帖编辑器',
        '补上预览图（主界面截图、玩法截图）与下载链接',
        '在帖子里附上 checksums.txt 的 sha256 便于玩家校验',
    ],
    generic: [
        '按 publish/metadata.json 填写平台要求的字段',
        '上传产物后把 sha256 一并公布',
    ],
};
/** 生成发布元数据包。 */
export async function buildPublishMetadata(input) {
    if (input.name.trim() === '')
        throw new ModpackError('INVALID_ARGUMENT', 'name 不能为空');
    if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(input.version.trim())) {
        throw new ModpackError('INVALID_ARGUMENT', `版本号格式不规范：${input.version}（建议 semver，如 1.0.0）`);
    }
    if (!(await pathExists(input.packDir))) {
        throw new ModpackError('NOT_FOUND', `整合包目录不存在：${input.packDir}`);
    }
    const outDir = input.outDir ?? join(input.packDir, 'publish');
    await ensureDir(outDir);
    const platforms = defaultPlatforms(input);
    const files = [];
    const artifacts = await collectArtifacts(input.artifacts ?? []);
    const artifactNames = artifacts.map((artifact) => artifact.path.split(/[\\/]/).pop() ?? artifact.path);
    // 合规检查
    const compliance = {
        checked: input.runComplianceCheck !== false,
        verdict: 'skipped',
        errors: 0,
        warnings: 0,
        notes: [],
    };
    if (compliance.checked) {
        const validation = await validatePack({
            packDir: input.packDir,
            minecraftVersion: input.minecraftVersion,
            loader: input.loader,
        });
        compliance.verdict = validation.verdict;
        compliance.errors = validation.issues.filter((issue) => issue.severity === 'error').length;
        compliance.warnings = validation.issues.filter((issue) => issue.severity === 'warning').length;
        compliance.notes.push(...validation.issues.filter((issue) => issue.code.startsWith('SECRET')).map((issue) => issue.message));
        if (compliance.errors > 0) {
            compliance.notes.push(`校验存在 ${compliance.errors} 个 error，发布前必须清零（发布元数据仍已生成）`);
        }
    }
    const write = async (name, data) => {
        const text = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
        await writeFileEnsured(join(outDir, name), text);
        files.push(name);
    };
    await write('metadata.json', {
        name: input.name,
        slug: slugify(input.name, 'modpack'),
        version: input.version,
        minecraft: { version: input.minecraftVersion, loader: input.loader, loaderVersion: input.loaderVersion ?? null },
        authors: input.authors ?? [],
        summary: input.summary ?? '',
        description: input.description ?? '',
        license: input.license ?? 'All Rights Reserved',
        homepage: input.homepage ?? null,
        sourceUrl: input.sourceUrl ?? null,
        tags: input.tags ?? [],
        releaseType: input.releaseType ?? 'release',
        generatedBy: 'dsh-tool-modpack',
        generatedAt: nowIso(),
        artifacts: artifacts.map((artifact) => ({ ...artifact, name: artifact.path.split(/[\\/]/).pop() ?? artifact.path })),
    });
    await write('changelog.md', renderChangelog(input));
    await write('community-post.md', buildCommunityPost(input));
    await write('checksums.txt', renderChecksumList(artifacts));
    if (platforms.includes('modrinth')) {
        await write('modrinth-version.json', buildModrinthVersionBody(input, artifactNames));
    }
    if (platforms.includes('curseforge')) {
        await write('curseforge-metadata.json', buildCurseForgeMetadata(input));
    }
    if (platforms.includes('github')) {
        await write('github-release.json', buildGitHubRelease(input, artifacts));
    }
    const steps = platforms.map((platform) => ({
        platform,
        actions: PLATFORM_STEPS[platform].map((action) => action.replace('${MC}', input.minecraftVersion)),
        blockers: compliance.errors > 0 ? ['先运行 modpack_validate 并修复全部 error 再发布'] : [],
    }));
    return {
        outDir,
        files,
        platforms,
        steps,
        compliance,
        artifacts,
        createdAt: nowIso(),
    };
}
/** 生成"发布就绪度"总结（markdown）。 */
export function renderPublishSummary(result, input) {
    const lines = [];
    lines.push(`# ${input.name} ${input.version} 发布就绪度`);
    lines.push('');
    lines.push(`- 目标版本：Minecraft ${input.minecraftVersion} / ${input.loader}`);
    lines.push(`- 元数据目录：${result.outDir}`);
    lines.push(`- 目标平台：${result.platforms.join('、')}`);
    lines.push(`- 产物：${result.artifacts.length} 个`);
    for (const artifact of result.artifacts) {
        lines.push(`  - ${artifact.path.split(/[\\/]/).pop()}（${(artifact.size / 1024 / 1024).toFixed(2)} MB，sha256 ${artifact.sha256.slice(0, 16)}…）`);
    }
    lines.push('');
    lines.push('## 合规检查');
    if (!result.compliance.checked) {
        lines.push('- 已跳过（runComplianceCheck=false）');
    }
    else {
        lines.push(`- 结论：${result.compliance.verdict}，error ${result.compliance.errors} 个，warning ${result.compliance.warnings} 个`);
        for (const note of result.compliance.notes)
            lines.push(`- ${note}`);
    }
    lines.push('');
    lines.push('## 各平台下一步');
    for (const step of result.steps) {
        lines.push(`### ${step.platform}`);
        for (const action of step.actions)
            lines.push(`- [ ] ${action}`);
        for (const blocker of step.blockers)
            lines.push(`- ⛔ ${blocker}`);
        lines.push('');
    }
    lines.push('## 生成的元数据文件');
    for (const file of result.files)
        lines.push(`- ${file}`);
    return lines.join('\n');
}
/** 读取发布目录里已有的 changelog（方便"追加式"更新）。 */
export async function readExistingChangelog(packDir) {
    const candidates = [join(packDir, 'publish', 'changelog.md'), join(packDir, 'CHANGELOG.md'), join(packDir, 'README.md')];
    for (const candidate of candidates) {
        const text = await readTextSafe(candidate, null);
        if (text !== null)
            return text;
    }
    return null;
}
/** 列出 packDir 下所有可发布的压缩产物。 */
export async function listPublishableArtifacts(packDir) {
    const out = [];
    let entries;
    try {
        entries = await readdir(packDir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith('.mrpak') || entry.name.endsWith('.zip'))) {
            out.push(join(packDir, entry.name));
        }
    }
    return out.sort((a, b) => a.localeCompare(b));
}
//# sourceMappingURL=publisher.js.map