/**
 * dsh-tool-modpack — 模组配置覆盖生成器。
 *
 * 支持四种目标格式：JSON / TOML / PROPERTIES / SNBT。
 * 对已存在的文件默认做"深合并"（对象逐层合并，数组整体替换），并先备份原文件，
 * 因此反复调用是幂等的，不会把用户的既有配置冲掉。
 *
 * @module dsh-tool-modpack/config-gen
 */
/** 支持的配置文件格式。 */
export type ConfigFormat = 'json' | 'toml' | 'properties' | 'snbt';
/** 一个待生成的配置文件。 */
export interface ConfigFileSpec {
    /** 相对 packDir 的路径，必须落在 config/、defaultconfigs/ 或根级白名单内。 */
    path: string;
    format: ConfigFormat;
    /** 内容：结构化对象，或（当 format 为 properties/snbt 时）原始文本。 */
    content: Record<string, unknown> | string;
    /** 与既有文件深合并（对象类型），默认 true。 */
    merge?: boolean;
}
/** 写入结果。 */
export interface ConfigWriteResult {
    path: string;
    absolutePath: string;
    format: ConfigFormat;
    action: 'created' | 'updated' | 'unchanged';
    bytes: number;
    /** 备份文件路径（更新时生成）。 */
    backup: string | null;
    merged: boolean;
}
/** 路径白名单：允许写配置的顶层目录。 */
export declare const CONFIG_PATH_WHITELIST: string[];
/** 渲染 TOML 文本（对象 → [table]，标量在前、子表在后，保证可解析）。 */
export declare function renderToml(value: Record<string, unknown>, path?: string[]): string;
/** 渲染 PROPERTIES 文本（嵌套对象用点号平铺）。 */
export declare function renderProperties(value: Record<string, unknown>, prefix?: string): string;
/** 解析简单的 a=b 文本（供合并用）。 */
export declare function parseProperties(text: string): Record<string, string>;
/** 渲染某种格式的配置文本。 */
export declare function renderConfig(format: ConfigFormat, content: Record<string, unknown> | string): string;
/** 深合并：对象递归合并，数组与非对象整体替换。 */
export declare function deepMergeObject(base: unknown, patch: unknown): Record<string, unknown>;
/** 写一个配置文件（可选深合并 + 备份）。 */
export declare function writeConfigFile(packDir: string, spec: ConfigFileSpec): Promise<ConfigWriteResult>;
/** 批量写入配置文件。 */
export declare function writeConfigFiles(packDir: string, specs: ConfigFileSpec[]): Promise<ConfigWriteResult[]>;
/** 原版 options.txt 的常用键（键名来自原版 ClientOptions，可直接生效）。 */
export interface ClientOptionsInput {
    language?: string;
    guiScale?: number;
    renderDistance?: number;
    simulationDistance?: number;
    maxFps?: number;
    fov?: number;
    gamma?: number;
    enableVsync?: boolean;
    pauseOnLostFocus?: boolean;
    autoJump?: boolean;
    particles?: 'all' | 'decreased' | 'minimal';
    graphicsMode?: number;
    soundCategoryMaster?: number;
    musicVolume?: number;
}
/** 生成 options.txt 文本。 */
export declare function renderClientOptions(input: ClientOptionsInput): string;
/** 生成 server.properties 文本（键名来自原版专用服务器）。 */
export declare function renderServerProperties(input: Record<string, unknown>): string;
/**
 * 已知模组的配置文件路径表（只给"路径建议"，不伪造内容）。
 * 模型应当按需要往这些路径写覆盖。
 */
export declare const KNOWN_CONFIG_PATHS: Readonly<Record<string, {
    path: string;
    format: ConfigFormat;
    note: string;
}>>;
/** 配置规划输入。 */
export interface ConfigPlanInput {
    packDir: string;
    /** 主题描述，用于生成建议（不直接改写未知模组的键）。 */
    theme?: string;
    minecraftVersion: string;
    loader: string;
    /** 显式指定要写入的配置文件。 */
    files?: ConfigFileSpec[];
    /** 客户端选项覆盖（生成 options.txt）。 */
    clientOptions?: ClientOptionsInput;
    /** 服务端设置覆盖（生成 server.properties）。 */
    serverProperties?: Record<string, unknown>;
    /** 想要预置配置的模组 id 列表（只产出路径建议 + 空模板，不伪造键）。 */
    modIds?: string[];
}
/** 配置规划结果。 */
export interface ConfigPlanResult {
    specs: ConfigFileSpec[];
    /** 路径建议（模组 id → 目标配置文件），供模型参考。 */
    suggestions: Array<{
        modId: string;
        path: string;
        format: ConfigFormat;
        note: string;
    }>;
    /** 未知的新增模组（没有官方路径记录）。 */
    unknownModIds: string[];
    planNote: string;
    createdAt: string;
}
/**
 * 根据输入规划要写哪些配置文件。
 * 只对"键名可确证"的 options.txt / server.properties 做内容生成，
 * 其余模组配置一律请模型显式给出 content，避免伪造不存在的键。
 */
export declare function planConfigOverrides(input: ConfigPlanInput): ConfigPlanResult;
/** 便捷函数：先生成计划再落盘。 */
export declare function applyConfigPlan(plan: ConfigPlanResult, packDir: string): Promise<ConfigWriteResult[]>;
/** 读回某个配置文件（用于验证）。 */
export declare function readConfigFile(packDir: string, relPath: string): Promise<string | null>;
/** 备份文件命名（对外的可读形式）。 */
export declare function backupNameFor(file: string): string;
//# sourceMappingURL=config-gen.d.ts.map