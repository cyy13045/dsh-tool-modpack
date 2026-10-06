/**
 * dsh-tool-modpack — 打包器（mrpak / CurseForge zip / 手动整包 zip）。
 *
 * 自包含实现：zip 读写只用 node:zlib 的 raw deflate，不引入任何压缩库。
 * 因此 packer.ts 也是"资源包 zip""UI 材质包 zip"共用的底层。
 *
 * mrpak 格式（本插件定义，v1）：
 *   mrpak.json      清单：文件名、体积、sha256、模组列表、加载器、覆盖目录
 *   mods/*.jar      版本文件（可由清单按 sha1 校验）
 *   manifest.json   CurseForge 兼容清单（可被 CF 启动器识别时生成）
 *   overrides/      配置覆盖目录
 *   其余目录        config/ resourcepacks/ shaderpacks/ kubejs/ ftbquests/ packmenu/ …
 *
 * @module dsh-tool-modpack/packer
 */
/** 一个待写入 zip 的条目。 */
export interface ZipEntry {
    /** zip 内部路径，正斜杠分隔。 */
    path: string;
    data: Uint8Array;
    /** 压缩方式：true = deflate（默认），false = store。 */
    compress?: boolean;
}
/** zip 写入选项。 */
export interface ZipWriteOptions {
    /** 文件时间（默认当前时间）。 */
    date?: Date;
    /** 统一压缩策略，默认 true。 */
    compress?: boolean;
}
/** 把一组条目打成 zip（返回完整字节）。 */
export declare function buildZip(entries: ZipEntry[], options?: ZipWriteOptions): Buffer;
/** 读取 zip 内的条目（解析中央目录，仅支持 store/deflate，覆盖 99% 的资源包与整合包）。 */
export declare function readZip(buffer: Uint8Array): ZipEntry[];
/** 写 zip 到磁盘。 */
export declare function writeZip(file: string, entries: ZipEntry[], options?: ZipWriteOptions): Promise<string>;
/** 收集到的磁盘文件。 */
export interface CollectedFile {
    /** 相对 root 的正斜杠路径。 */
    path: string;
    absolute: string;
    size: number;
}
/** 收集选项。 */
export interface CollectOptions {
    /** 只收集这些顶层目录/文件（默认全收）。 */
    include?: string[];
    /** 排除这些顶层路径/文件名。 */
    exclude?: string[];
    /** 排除任何路径片段命中此正则的文件。 */
    skipPattern?: RegExp;
    /** 最大文件字节数，超过则跳过（避免把超大存档打进包里）。 */
    maxFileBytes?: number;
}
/** 递归收集目录下的文件（自动跳过日志、存档、缓存等噪声）。 */
export declare function collectFiles(root: string, options?: CollectOptions): Promise<CollectedFile[]>;
/** 把收集到的文件读成 zip 条目。 */
export declare function filesToZipEntries(files: CollectedFile[], transformPath?: (path: string) => string): Promise<ZipEntry[]>;
/** 清单里的一个模组条目。 */
export interface PackModEntry {
    projectId: string;
    slug: string;
    title: string;
    versionId: string;
    fileName: string;
    /** 相对包根的路径，例如 mods/sodium-fabric-0.5.13.jar。 */
    path: string;
    sha1: string;
    sha256: string;
    size: number;
    url: string;
    required: boolean;
}
/** 导出参数（三种格式共用）。 */
export interface PackExportOptions {
    /** 整合包实例根目录。 */
    packDir: string;
    /** 输出文件绝对路径。 */
    outFile: string;
    name: string;
    version: string;
    authors?: string[];
    summary?: string;
    description?: string;
    minecraftVersion: string;
    loader: string;
    loaderVersion?: string | null;
    /** 模组清单；mrpak 会写进 mrpak.json，CurseForge 会用于 manifest.json。 */
    mods?: PackModEntry[];
    /** 需要打包的顶层目录，默认给一套完整的实例目录。 */
    include?: string[];
    exclude?: string[];
    /** projectId → CurseForge 数字 id（有则生成可被 CF 启动器识别的 files 列表）。 */
    curseforgeIds?: Record<string, {
        projectID: number;
        fileID: number;
    }>;
    /** CurseForge 包内配置目录名，默认 overrides。 */
    overridesFolder?: string;
    /** zip 输出时的日期戳。 */
    date?: Date;
}
/** 导出结果。 */
export interface PackExportResult {
    format: 'mrpak' | 'curseforge' | 'manual';
    path: string;
    size: number;
    sha256: string;
    entryCount: number;
    /** 包内全部条目路径（升序）。 */
    entries: string[];
    /** 给模型看的补充说明（例如 CF 数字 id 缺失时的降级说明）。 */
    notes: string[];
}
/** 默认打进整合包的目录。 */
export declare const DEFAULT_PACK_INCLUDE: string[];
/** 导出 mrpak（自包含：清单 + 模组 + 覆盖目录 + CurseForge 兼容清单）。 */
export declare function exportMrpak(options: PackExportOptions): Promise<PackExportResult>;
/**
 * 导出 CurseForge 风格 zip：manifest.json + overrides/。
 * 有 CF 数字 id 时走标准 CF 格式；没有时保留 mods/ 实体文件并降级说明。
 */
export declare function exportCurseForgeZip(options: PackExportOptions): Promise<PackExportResult>;
/** 导出手动整包 zip（目录原样打包，供 PCL/HMCL/Prism 直接解压使用）。 */
export declare function exportManualZip(options: PackExportOptions): Promise<PackExportResult>;
/** 按格式分发导出。 */
export declare function exportPack(format: PackExportResult['format'], options: PackExportOptions): Promise<PackExportResult>;
//# sourceMappingURL=packer.d.ts.map