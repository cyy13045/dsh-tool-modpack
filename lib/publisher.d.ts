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
import { type ValidatePackResult } from './tester.js';
/** 发布目标平台。 */
export type PublishPlatform = 'modrinth' | 'curseforge' | 'mcbbs' | 'github' | 'generic';
/** 发布输入。 */
export interface PublishMetadataInput {
    packDir: string;
    /** 整合包名称。 */
    name: string;
    /** 版本号，例如 1.0.0。 */
    version: string;
    minecraftVersion: string;
    loader: string;
    loaderVersion?: string | null;
    /** 作者/团队。 */
    authors?: string[];
    summary?: string;
    description?: string;
    /** 本次更新的变更点（自动生成 changelog）。 */
    changes?: string[];
    /** 已知问题。 */
    knownIssues?: string[];
    /** 许可证，例如 MIT / CC-BY-NC-SA-4.0。 */
    license?: string;
    /** 项目主页 / 源码地址。 */
    homepage?: string;
    sourceUrl?: string;
    /** 要发布的产物文件（相对或绝对路径）。 */
    artifacts?: string[];
    /** 目标平台。 */
    platforms?: PublishPlatform[];
    /** Modrinth 项目 id（已存在项目时填）。 */
    modrinthProjectId?: string;
    /** 版本类型。 */
    releaseType?: 'release' | 'beta' | 'alpha';
    /** 游戏版本列表（缺省只有 minecraftVersion）。 */
    gameVersions?: string[];
    /** 标签，例如 ['technology','quests']。 */
    tags?: string[];
    /** 是否做发布前合规检查（默认 true）。 */
    runComplianceCheck?: boolean;
    /** 输出目录（缺省 <packDir>/publish）。 */
    outDir?: string;
}
/** 发布元数据结果。 */
export interface PublishMetadataResult {
    outDir: string;
    files: string[];
    platforms: PublishPlatform[];
    /** 每个平台的"下一步要做什么"。 */
    steps: Array<{
        platform: PublishPlatform;
        actions: string[];
        blockers: string[];
    }>;
    compliance: {
        checked: boolean;
        verdict: ValidatePackResult['verdict'] | 'skipped';
        errors: number;
        warnings: number;
        notes: string[];
    };
    artifacts: Array<{
        path: string;
        size: number;
        sha256: string;
    }>;
    createdAt: string;
}
/** 生成 Modrinth 的 version 创建请求体（POST /v2/version）。 */
export declare function buildModrinthVersionBody(input: PublishMetadataInput, artifactNames: string[]): Record<string, unknown>;
/** 生成 CurseForge 的项目/版本元数据。 */
export declare function buildCurseForgeMetadata(input: PublishMetadataInput): Record<string, unknown>;
/** 生成 GitHub Release 元数据。 */
export declare function buildGitHubRelease(input: PublishMetadataInput, artifacts: Array<{
    path: string;
    size: number;
    sha256: string;
}>): Record<string, unknown>;
/** 生成中文社区（MCBBS 风格）发布帖骨架。 */
export declare function buildCommunityPost(input: PublishMetadataInput): string;
/** 生成更新日志文本。 */
export declare function renderChangelog(input: PublishMetadataInput): string;
/** 生成发布校验值清单。 */
export declare function renderChecksumList(artifacts: Array<{
    path: string;
    size: number;
    sha256: string;
}>): string;
/** 采集产物信息（体积 + sha256）。 */
export declare function collectArtifacts(paths: string[]): Promise<Array<{
    path: string;
    size: number;
    sha256: string;
}>>;
/** 生成发布元数据包。 */
export declare function buildPublishMetadata(input: PublishMetadataInput): Promise<PublishMetadataResult>;
/** 生成"发布就绪度"总结（markdown）。 */
export declare function renderPublishSummary(result: PublishMetadataResult, input: PublishMetadataInput): string;
/** 读取发布目录里已有的 changelog（方便"追加式"更新）。 */
export declare function readExistingChangelog(packDir: string): Promise<string | null>;
/** 列出 packDir 下所有可发布的压缩产物。 */
export declare function listPublishableArtifacts(packDir: string): Promise<string[]>;
//# sourceMappingURL=publisher.d.ts.map