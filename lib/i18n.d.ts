/**
 * dsh-tool-modpack — 本地化模块。
 *
 * 两件事：
 *  1. scanI18n：扫描整合包内"待翻译字符串"——资源包 lang 文件缺键、FTB Quests 章节
 *     文本、PackMenu 按钮 key、README/配置里的硬编码中文。
 *  2. translateAndPackage：把译文批量落成语言文件并打包成一个语言资源包。
 *
 * 翻译来源三层（都可离线）：
 *   - Agent 直接给出的 translations（模型自己翻译，最准）
 *   - 内置术语表 GlossaryTranslator（Minecraft/整合包常用词，确定性、可测）
 *   - 自定义词典（用户提供）
 *
 * @module dsh-tool-modpack/i18n
 */
/** 待翻译条目的来源类型。 */
export type I18nEntryKind = 'lang' | 'quest' | 'packmenu' | 'markdown' | 'config';
/** 一条待翻译字符串。 */
export interface I18nEntry {
    /** 语言键（lang 文件用 key；其他来源用合成 key）。 */
    key: string;
    /** 原文。 */
    text: string;
    /** 相对 packDir 的源文件。 */
    file: string;
    kind: I18nEntryKind;
    /** 该键在目标语言里是否已有译文。 */
    translated: boolean;
}
/** 一个语言文件的扫描结果。 */
export interface I18nNamespaceReport {
    namespace: string;
    locale: string;
    file: string;
    keys: number;
    missingKeys: string[];
}
/** 扫描参数。 */
export interface I18nScanInput {
    packDir: string;
    /** 源语言（默认 en_us）。 */
    sourceLocale?: string;
    /** 目标语言列表（默认 ['zh_cn']）。 */
    targetLocales?: string[];
    /** 是否扫描 FTB Quests 章节文本。 */
    includeQuests?: boolean;
    /** 是否扫描 README / 配置里的硬编码中文。 */
    includeHardcoded?: boolean;
}
/** 扫描结果。 */
export interface I18nScanResult {
    sourceLocale: string;
    targetLocales: string[];
    namespaces: I18nNamespaceReport[];
    /** 需要翻译的条目（按 file 排序）。 */
    entries: I18nEntry[];
    stats: {
        scannedFiles: number;
        langKeys: number;
        missingKeys: number;
        questStrings: number;
        hardcodedStrings: number;
    };
    /** 人类可读的 markdown 报告。 */
    report: string;
    createdAt: string;
}
/** 判断是否含中文。 */
export declare function containsCjk(text: string): boolean;
/** 从 SNBT 文本里抽取 title / subtitle / description 字段的字符串。 */
export declare function extractSnbtStrings(text: string): string[];
/**
 * 扫描待翻译内容。
 */
export declare function scanI18n(input: I18nScanInput): Promise<I18nScanResult>;
/** 翻译提供者。 */
export interface TranslationProvider {
    readonly id: string;
    translate(items: Array<{
        key: string;
        text: string;
    }>, targetLocale: string): Promise<Map<string, string>>;
}
/** Minecraft / 整合包常用术语表（en → zh_cn）。 */
export declare const GLOSSARY_EN_ZH: Readonly<Record<string, string>>;
/** 术语翻译器：按"长词优先"替换，保护占位符。 */
export declare class GlossaryTranslator implements TranslationProvider {
    private readonly targetLocale;
    readonly id = "glossary";
    private readonly glossary;
    constructor(extra?: Record<string, string>, targetLocale?: string);
    translate(items: Array<{
        key: string;
        text: string;
    }>, targetLocale: string): Promise<Map<string, string>>;
    /** 单词条翻译：整句命中 → 用术语表；否则做词级替换。 */
    translateOne(text: string, key?: string): string;
}
/** 把 %s / {0} / %1$s / ${x} 这类占位符换成不可翻译的哨兵。 */
export declare function maskPlaceholders(text: string): {
    masked: string;
    restore: (value: string) => string;
};
/** 自定义词典提供者。 */
export declare class DictionaryTranslator implements TranslationProvider {
    private readonly dictionaries;
    readonly id = "dictionary";
    constructor(dictionaries: Record<string, Record<string, string>>);
    translate(items: Array<{
        key: string;
        text: string;
    }>, targetLocale: string): Promise<Map<string, string>>;
}
/** 翻译输入。 */
export interface TranslateInput {
    packDir: string;
    /** 资源包名（产出目录 resourcepacks/<packName>）。 */
    packName?: string;
    /** 命名空间（lang 文件路径）。 */
    namespace?: string;
    minecraftVersion: string;
    targetLocales: string[];
    /** Agent / 用户直接给出的译文：locale → (key → 译文)。 */
    translations?: Record<string, Record<string, string>>;
    /** 要翻译的条目；缺省时自动扫描。 */
    entries?: Array<{
        key: string;
        text: string;
    }>;
    /** 是否用内置术语表兜底翻译缺失项（默认 true）。 */
    useGlossary?: boolean;
    /** 追加的自定义词典：locale → (原文/键 → 译文)。 */
    dictionaries?: Record<string, Record<string, string>>;
    /** 语言文件覆盖的命名空间列表（缺省用 namespace）。 */
    alsoWriteNamespaces?: string[];
    /** 是否同时产出 zip。 */
    zip?: boolean;
    /** 是否只回传译文而不落盘（干跑）。 */
    dryRun?: boolean;
}
/** 翻译结果。 */
export interface TranslateResult {
    resourcePackDir: string;
    zipPath: string | null;
    files: string[];
    perLocale: Array<{
        locale: string;
        keys: number;
        fromInput: number;
        fromDictionary: number;
        fromGlossary: number;
        untranslated: string[];
    }>;
    packFormat: number;
    dryRun: boolean;
    createdAt: string;
}
/**
 * 批量翻译并打包为语言资源包。
 * 译文优先级：显式 translations > dictionaries > 内置术语表。
 */
export declare function translateAndPackage(input: TranslateInput): Promise<TranslateResult>;
/** 合并两份语言文件（后者覆盖前者），返回新对象。 */
export declare function mergeLangFiles(base: Record<string, string>, patch: Record<string, string>): Record<string, string>;
/** 读取某个资源包语言文件。 */
export declare function readLangFile(packDir: string, relPath: string): Promise<Record<string, string>>;
/** 生成"未翻译键"提示（写进 README 或交给模型）。 */
export declare function renderUntranslatedNotice(locale: string, keys: string[]): string;
/** 语言文件路径（供外部工具复用）。 */
export declare function langFilePath(namespace: string, locale: string): string;
/** 语言文件的父目录（打包用）。 */
export declare function langDirOf(namespace: string): string;
//# sourceMappingURL=i18n.d.ts.map